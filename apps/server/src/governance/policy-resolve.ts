import { sql } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import {
  WALK_TRUNCATION_PROBE_DEPTH,
  containmentChain,
  walkDepthExceeded,
  type ChainEntry
} from "../graph/containment.js";
import { isUuid } from "../graph/objects-repo.js";
import { sqlIn } from "../graph/sql-helpers.js";
import type { MatchedPolicy, PolicyEffect, PolicyEnforcement } from "./policy-model.js";

/** The impure "gather" half of policy resolution. See docs/governance.md §273. */

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
  const result = await tx.execute<{ id: string; depth: number }>(sql`
    WITH RECURSIVE subject_expand AS (
      SELECT ${subjectObjectId}::uuid AS subject_id, 0 AS depth
      UNION
      SELECT r.to_id, se.depth + 1
      FROM relationships r
      JOIN subject_expand se ON r.from_id = se.subject_id
      WHERE r.org_id = ${orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
        AND se.depth < ${WALK_TRUNCATION_PROBE_DEPTH}
    )
    SELECT subject_id AS id, depth FROM subject_expand
    WHERE subject_id = ${groupObjectId}::uuid OR depth >= ${WALK_TRUNCATION_PROBE_DEPTH}
  `);
  // A match found within the bound is valid regardless. See docs/governance.md §274.
  if (result.rows.some((r) => r.id === groupObjectId && r.depth < WALK_TRUNCATION_PROBE_DEPTH)) {
    return true;
  }
  if (result.rows.some((r) => r.depth >= WALK_TRUNCATION_PROBE_DEPTH)) {
    throw walkDepthExceeded(
      `the member_of chain above subject '${subjectObjectId}'`,
      `Group-scope policy matching cannot assert non-membership past the bound; flatten the ` +
        `group nesting.`
    );
  }
  return false;
}

/** DESIGN §10.1's **OWNING**-subject half of group scope. See docs/governance.md §275. */
async function ownedByGroupOrItsMembers(
  tx: TenantTx,
  orgId: string,
  groupObjectId: string,
  chainObjectIds: string[]
): Promise<Set<string>> {
  if (chainObjectIds.length === 0) return new Set();
  const result = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE group_expand AS (
      SELECT ${groupObjectId}::uuid AS member_id
      UNION
      SELECT r.from_id
      FROM relationships r
      JOIN group_expand ge ON r.to_id = ge.member_id
      WHERE r.org_id = ${orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
    )
    SELECT DISTINCT o.to_id AS id
    FROM relationships o
    JOIN group_expand ge ON ge.member_id = o.from_id
    WHERE o.org_id = ${orgId} AND o.type_id = 'owns' AND o.deleted_at IS NULL
      AND ${sqlIn("o.to_id", chainObjectIds)}
  `);
  return new Set(result.rows.map((r) => r.id));
}

export interface MatchPoliciesInput {
  orgId: string;
  /** The objects governance is being evaluated for — usually a change's wave targets, or (for a
   *  lifecycle-edge gate with no single wave) the change's own recorded target object ids. */
  targetObjectIds: string[];
  /** The ACTING subject — one of the two halves of group-scope matching (DESIGN §10.1's
   *  `scope.group`); the other half is ownership of the targets, which does not depend on this and
   *  is what keeps a group-scoped CONSTRAINT applying when a non-member (or `SYSTEM_ACTOR_ID`)
   *  acts. See the module doc. */
  actorObjectId: string;
}

/** The shared walk both matchers run. See docs/governance.md §276. */
async function walkPolicyMatches(
  tx: TenantTx,
  input: MatchPoliciesInput,
  onMatch: (
    targetId: string,
    candidate: PolicyCandidate,
    objectId: string,
    depth: number,
    via: MatchedPolicy["matchedAt"]["via"]
  ) => void
): Promise<void> {
  const candidates = await listPolicyCandidates(tx, input.orgId);
  if (candidates.length === 0) return;

  const chains = new Map<string, ChainEntry[]>();
  for (const targetId of input.targetObjectIds) {
    if (!chains.has(targetId)) {
      chains.set(targetId, await containmentChain(tx, input.orgId, targetId));
    }
  }

  // Every object on every target's chain, once — the search space for the ownership half below.
  const allChainObjectIds = [...new Set([...chains.values()].flatMap((c) => c.map((e) => e.id)))];
  // Two policies may name the SAME group; the ownership expansion for a group is independent of the
  // policy that referenced it, so it is resolved at most once per call.
  const ownedByGroupCache = new Map<string, Set<string>>();
  const ownedForGroup = async (groupId: string): Promise<Set<string>> => {
    const cached = ownedByGroupCache.get(groupId);
    if (cached) return cached;
    const owned = await ownedByGroupOrItsMembers(tx, input.orgId, groupId, allChainObjectIds);
    ownedByGroupCache.set(groupId, owned);
    return owned;
  };

  for (const candidate of candidates) {
    const scope = candidate.properties.scope;

    if (!scope || (!scope.objectRef && !scope.selector && !scope.group)) {
      // Unscoped = applies org-wide (module doc comment) — match once at every target's org root
      // (depth 0) rather than once globally, so multi-target callers still see one entry per
      // relevant chain for reason-tree purposes.
      for (const [targetId, chain] of chains) {
        const root = chain[0];
        if (root) onMatch(targetId, candidate, root.id, 0, "unscoped");
      }
      continue;
    }

    if (scope.objectRef) {
      const refId = await resolveRef(tx, input.orgId, scope.objectRef);
      if (refId) {
        for (const [targetId, chain] of chains) {
          const hit = chain.find((c) => c.id === refId);
          if (hit) onMatch(targetId, candidate, hit.id, hit.depth, "objectRef");
        }
      }
    }

    if (scope.selector?.labels) {
      const selector = scope.selector.labels;
      for (const [targetId, chain] of chains) {
        for (const ancestor of chain) {
          if (labelsMatch(selector, ancestor.labels)) {
            onMatch(targetId, candidate, ancestor.id, ancestor.depth, "selector");
          }
        }
      }
    }

    if (scope.group) {
      const groupId = await resolveRef(tx, input.orgId, scope.group);
      if (groupId) {
        // (a) THE ACTING-SUBJECT HALF — unchanged behaviour, preserved verbatim. "This rule governs
        // work done BY this group." It has no containment-chain anchor of its own, so it attaches
        // at every target's org root (depth 0), the same placement convention as "unscoped".
        if (await isMemberOf(tx, input.orgId, input.actorObjectId, groupId)) {
          for (const [targetId, chain] of chains) {
            const root = chain[0];
            if (root) onMatch(targetId, candidate, root.id, 0, "group");
          }
        }

        // (b) THE OWNING-SUBJECT HALF (ADR-0016 §2a, 2026-08-15). See docs/governance.md §277.
        const owned = await ownedForGroup(groupId);
        if (owned.size > 0) {
          for (const [targetId, chain] of chains) {
            for (const entry of chain) {
              if (owned.has(entry.id))
                onMatch(targetId, candidate, entry.id, entry.depth, "ownerGroup");
            }
          }
        }
      }
    }
  }
}

function matchedPolicyOf(
  candidate: PolicyCandidate,
  objectId: string,
  depth: number,
  via: MatchedPolicy["matchedAt"]["via"]
): MatchedPolicy {
  return {
    policyObjectId: candidate.id,
    policyVersion: candidate.version,
    name: candidate.name,
    enforcement: candidate.properties.enforcement,
    condition: candidate.properties.condition,
    effects: candidate.properties.effects ?? [],
    matchedAt: { objectId, depth, via },
    emergencyPolicy: candidate.properties.emergencyPolicy ?? false,
    autoRollbackOnFailure: candidate.properties.autoRollbackOnFailure ?? false
  };
}

/** Gathers every policy matching any target's chain. See docs/governance.md §278. */
export async function matchPoliciesForTargets(
  tx: TenantTx,
  input: MatchPoliciesInput
): Promise<MatchedPolicy[]> {
  const matches = new Map<string, MatchedPolicy>();
  await walkPolicyMatches(tx, input, (_targetId, candidate, objectId, depth, via) => {
    const key = `${candidate.id}::${objectId}`;
    if (matches.has(key)) return;
    matches.set(key, matchedPolicyOf(candidate, objectId, depth, via));
  });
  return [...matches.values()];
}

/** The per-target-attributed sibling of that matcher. See docs/governance.md §279. */
export async function matchPoliciesForTargetsByTarget(
  tx: TenantTx,
  input: MatchPoliciesInput
): Promise<Map<string, MatchedPolicy[]>> {
  const byTarget = new Map<string, MatchedPolicy[]>();
  const seenByTarget = new Map<string, Set<string>>();
  for (const targetId of input.targetObjectIds) {
    if (!byTarget.has(targetId)) {
      byTarget.set(targetId, []);
      seenByTarget.set(targetId, new Set());
    }
  }
  await walkPolicyMatches(tx, input, (targetId, candidate, objectId, depth, via) => {
    const key = `${candidate.id}::${objectId}`;
    const seen = seenByTarget.get(targetId)!;
    if (seen.has(key)) return;
    seen.add(key);
    byTarget.get(targetId)!.push(matchedPolicyOf(candidate, objectId, depth, via));
  });
  return byTarget;
}
