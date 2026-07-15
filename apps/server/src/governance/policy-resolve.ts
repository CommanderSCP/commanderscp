import { sql } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { isUuid } from "../graph/objects-repo.js";
import type { MatchedPolicy, PolicyEffect, PolicyEnforcement } from "./policy-model.js";

/**
 * The impure "gather" half of policy resolution (DESIGN.md §10.1) — everything here touches the
 * database; `policy-model.ts`'s `resolvePolicies` is the pure merge that consumes this file's
 * output. Kept deliberately separate per BUILD_AND_TEST.md §4.1's "anything testable as a pure
 * function must be written as a pure function."
 *
 * Resolution walks the target's containment chain (org → domain → service → component — DESIGN
 * §10.1) and, at every ancestor, checks every `policy`-typed graph object in the org for a scope
 * match (explicit `objectRef`, label `selector`, or `group` membership of the acting subject —
 * DESIGN §7's `member_of` expansion, reused). Org policy counts are expected to be small (dozens,
 * not thousands) — a full scan per gate check is the honest, simple MVP choice; a materialized
 * `governed_by`-indexed lookup is a natural later optimization behind this exact same function
 * signature if profiling ever shows it's needed (DESIGN §5's own "escape hatch" precedent for
 * named queries).
 */

interface ChainEntry {
  id: string;
  depth: number;
  labels: Record<string, unknown>;
}

/**
 * Target -> ... -> org root, with depth 0 = org root, increasing toward the target. Mirrors
 * authz/resolve.ts's `scopeExpandCte` (same containment routes, same depth bound) — the two MUST agree
 * on what contains what, or a policy would govern an object its RBAC scope doesn't, and vice versa.
 *
 * Walks TWO routes up (see `scopeExpandCte` for the full rationale): `objects.domain_id`, and the
 * `contains` edge from a component to its SERVICE (migration 0021). Until 0021 this walked domain_id
 * only, so a service-scoped policy governed nothing — even though this file's own header, and
 * DESIGN §10, have always described the chain as `org -> domain -> service -> component`.
 *
 * DEPTH MATTERS HERE in a way it does not for authz: policy-model.ts sorts by `matchedAt.depth`
 * descending, so the DEEPEST match wins (most specific beats least). With two routes the chain is a
 * DAG rather than a line — a component's domain is reachable BOTH directly (`component.domain_id`)
 * and via its service (`service.domain_id`), at different walk depths. Taking the wrong one would let
 * a domain-scoped policy outrank a service-scoped one. So we keep the MAXIMUM walk depth per id
 * (`DISTINCT ON (id) ... ORDER BY id, depth DESC`) = the longest path from the target = the LEAST
 * specific reading, which after the `maxDepth - depth` inversion below yields exactly
 * org(0) < domain(1) < service(2) < component(3).
 */
async function containmentChain(tx: TenantTx, orgId: string, objectId: string): Promise<ChainEntry[]> {
  const result = await tx.execute<{ id: string; depth: number; labels: Record<string, unknown> }>(sql`
    WITH RECURSIVE chain AS (
      SELECT o.id, o.labels, 0 AS depth
      FROM objects o
      WHERE o.id = ${objectId}::uuid AND o.org_id = ${orgId}
      UNION
      -- One recursive term (PostgreSQL allows the self-reference exactly once); the two routes are a
      -- LATERAL union of parents.
      SELECT parent.id, parent.labels, c.depth + 1
      FROM chain c
      CROSS JOIN LATERAL (
        -- 1. containing domain, via the child's domain_id
        SELECT parent_o.id, parent_o.labels
        FROM objects child_o
        JOIN objects parent_o ON parent_o.id = child_o.domain_id
        WHERE child_o.id = c.id AND child_o.org_id = ${orgId} AND parent_o.org_id = ${orgId}
        UNION ALL
        -- 2. containing service, via the contains edge walked BACKWARDS (to_id = c.id, from_id = svc)
        SELECT svc.id, svc.labels
        FROM relationships r
        JOIN objects svc ON svc.id = r.from_id AND svc.org_id = ${orgId}
        WHERE r.to_id = c.id
          AND r.org_id = ${orgId}
          AND r.type_id = 'contains'
          AND r.deleted_at IS NULL
      ) parent
      WHERE c.depth < 10
    )
    -- Max walk depth per id (see the doc comment): preserves service-beats-domain precedence.
    SELECT DISTINCT ON (id) id, depth, labels FROM chain ORDER BY id, depth DESC
  `);
  // Reverse so index 0 = org root (max depth in the recursive walk) — matches policy-model.ts's
  // "0 = org root, increasing toward the target" depth convention.
  const rows = result.rows;
  const maxDepth = Math.max(0, ...rows.map((r) => r.depth));
  return rows
    .map((r) => ({ id: r.id, depth: maxDepth - r.depth, labels: r.labels ?? {} }))
    .sort((a, b) => a.depth - b.depth);
}

interface PolicyCandidate {
  id: string;
  version: number;
  name: string;
  properties: {
    scope?: { selector?: { labels?: Record<string, string> }; objectRef?: string; group?: string };
    enforcement: PolicyEnforcement;
    condition?: string;
    effects?: PolicyEffect[];
    emergencyPolicy?: boolean;
    autoRollbackOnFailure?: boolean;
  };
}

async function listPolicyCandidates(tx: TenantTx, orgId: string): Promise<PolicyCandidate[]> {
  const rows = await tx
    .select({
      id: objects.id,
      version: objects.version,
      name: objects.name,
      properties: objects.properties
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.typeId, "policy"), isNull(objects.deletedAt)));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    properties: r.properties as PolicyCandidate["properties"]
  }));
}

/** Resolves a policy's `scope.objectRef`/`scope.group` (an id OR a URN) to an object id. */
async function resolveRef(tx: TenantTx, orgId: string, ref: string): Promise<string | null> {
  if (isUuid(ref)) return ref;
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.urn, ref))
  });
  return row?.id ?? null;
}

function labelsMatch(selector: Record<string, string>, labels: Record<string, unknown>): boolean {
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/** DESIGN §7's group-scope resolution, reused verbatim: does `subjectObjectId` transitively
 *  belong to `groupObjectId` via `member_of`? */
async function isMemberOf(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string,
  groupObjectId: string
): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE subject_expand AS (
      SELECT ${subjectObjectId}::uuid AS subject_id, 0 AS depth
      UNION
      SELECT r.to_id, se.depth + 1
      FROM relationships r
      JOIN subject_expand se ON r.from_id = se.subject_id
      WHERE r.org_id = ${orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL AND se.depth < 10
    )
    SELECT subject_id AS id FROM subject_expand WHERE subject_id = ${groupObjectId}::uuid
  `);
  return result.rows.length > 0;
}

export interface MatchPoliciesInput {
  orgId: string;
  /** The objects governance is being evaluated for — usually a change's wave targets, or (for a
   *  lifecycle-edge gate with no single wave) the change's own recorded target object ids. */
  targetObjectIds: string[];
  /** The acting subject — used for group-scope matching (DESIGN §10.1's `scope.group`). */
  actorObjectId: string;
}

/**
 * Gathers every policy that matches ANY of `targetObjectIds`' containment chains (or the actor's
 * group membership), each annotated with WHERE/HOW it matched — ready to hand to
 * `policy-model.ts`'s `resolvePolicies` for the stricter-wins merge. Deduplicates a policy that
 * matches the same target-chain-object more than once (can't happen with today's three match
 * kinds, but the Map keeps this function safe if a future scope kind could double-match).
 */
export async function matchPoliciesForTargets(tx: TenantTx, input: MatchPoliciesInput): Promise<MatchedPolicy[]> {
  const candidates = await listPolicyCandidates(tx, input.orgId);
  if (candidates.length === 0) return [];

  const chains = new Map<string, ChainEntry[]>();
  for (const targetId of input.targetObjectIds) {
    if (!chains.has(targetId)) {
      chains.set(targetId, await containmentChain(tx, input.orgId, targetId));
    }
  }

  const matches = new Map<string, MatchedPolicy>();

  for (const candidate of candidates) {
    const scope = candidate.properties.scope;
    const enforcement = candidate.properties.enforcement;
    const effects = candidate.properties.effects ?? [];
    const condition = candidate.properties.condition;
    const emergencyPolicy = candidate.properties.emergencyPolicy ?? false;
    const autoRollbackOnFailure = candidate.properties.autoRollbackOnFailure ?? false;

    const record = (objectId: string, depth: number, via: MatchedPolicy["matchedAt"]["via"]): void => {
      const key = `${candidate.id}::${objectId}`;
      if (matches.has(key)) return;
      matches.set(key, {
        policyObjectId: candidate.id,
        policyVersion: candidate.version,
        name: candidate.name,
        enforcement,
        condition,
        effects,
        matchedAt: { objectId, depth, via },
        emergencyPolicy,
        autoRollbackOnFailure
      });
    };

    if (!scope || (!scope.objectRef && !scope.selector && !scope.group)) {
      // Unscoped = applies org-wide (module doc comment) — match once at every target's org root
      // (depth 0) rather than once globally, so multi-target callers still see one entry per
      // relevant chain for reason-tree purposes; the Map above dedups by (policy, matched object).
      for (const chain of chains.values()) {
        const root = chain[0];
        if (root) record(root.id, 0, "unscoped");
      }
      continue;
    }

    if (scope.objectRef) {
      const refId = await resolveRef(tx, input.orgId, scope.objectRef);
      if (refId) {
        for (const chain of chains.values()) {
          const hit = chain.find((c) => c.id === refId);
          if (hit) record(hit.id, hit.depth, "objectRef");
        }
      }
    }

    if (scope.selector?.labels) {
      const selector = scope.selector.labels;
      for (const chain of chains.values()) {
        for (const ancestor of chain) {
          if (labelsMatch(selector, ancestor.labels)) {
            record(ancestor.id, ancestor.depth, "selector");
          }
        }
      }
    }

    if (scope.group) {
      const groupId = await resolveRef(tx, input.orgId, scope.group);
      if (groupId && (await isMemberOf(tx, input.orgId, input.actorObjectId, groupId))) {
        // Group-scoped policies have no containment-chain anchor of their own — attach at every
        // target's org root (depth 0), same placement convention as "unscoped".
        for (const chain of chains.values()) {
          const root = chain[0];
          if (root) record(root.id, 0, "group");
        }
      }
    }
  }

  return [...matches.values()];
}
