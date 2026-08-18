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

/**
 * The impure "gather" half of policy resolution (DESIGN.md §10.1) — everything here touches the
 * database; `policy-model.ts`'s `resolvePolicies` is the pure merge that consumes this file's
 * output. Kept deliberately separate per BUILD_AND_TEST.md §4.1's "anything testable as a pure
 * function must be written as a pure function."
 *
 * Resolution walks the target's containment chain (org → domain → service → [assembly] → component
 * — the assembly rung is OPTIONAL and arrives via the same generic `contains` walk — DESIGN
 * §10.1; `graph/containment.ts`'s `containmentChain`, shared with the gate orchestrator so a policy
 * and a freeze can never disagree about what contains what) and, at every ancestor, checks every
 * `policy`-typed graph object in the org for a scope match (explicit `objectRef`, label `selector`,
 * or `group` — DESIGN §7's `member_of` expansion, reused). Org
 * policy counts are expected to be small (dozens, not thousands) — a full scan per gate check is the
 * honest, simple MVP choice; a materialized `governed_by`-indexed lookup is a natural later
 * optimization behind this exact same function signature if profiling ever shows it's needed
 * (DESIGN §5's own "escape hatch" precedent for named queries).
 *
 * ============================================================================================
 * GROUP SCOPE HAS TWO HALVES — AND SHIPPING ONLY ONE OF THEM WAS A FAIL-OPEN
 * ============================================================================================
 * DESIGN §10.1 has always said a group-scoped policy "applies when the change's **acting or owning
 * subject** is a `member_of` that group". Until 2026-08-15 this file implemented only the ACTING
 * half (`isMemberOf(actor, group)`), so `scope.group` meant, exactly and only, *"the human whose
 * credential is on the request that triggered this evaluation is transitively in this group"*.
 *
 * That reading is fine for a policy that GRANTS or ROUTES. It is a FAIL-OPEN for a policy that
 * CONSTRAINS, because **a constraint that fails to match is a constraint that does not apply**.
 * Every enforcing consumer of this function is a constraint:
 *   - `gate-orchestrator.ts` `evaluateGovernanceGate` — fewer `requireControls`/`requireApprovals`,
 *     and a group-scoped `emergencyPolicy` that misses leaves an emergency change UNGATED;
 *   - `scan-requirements.ts` `resolveEffectiveScanThreshold` — the shipped ADR-0016/M17.5 gate,
 *     whose per-severity MIN silently loses a group-scoped scan CEILING, leaving the effective
 *     threshold LOOSER than the operator authored. No error, no log; the gate just permits more.
 * So a non-member could evade a group's own gate simply by being the one to push the button.
 *
 * Worse, the acting half is STRUCTURALLY INERT wherever the actor is `SYSTEM_ACTOR_ID` (the nil
 * UUID, which is `member_of` nothing): `coordination/reconcile.ts`'s wave-boundary gate,
 * `campaign-reconcile.ts`, `shouldAutoRollback`, and `prewarmGovernanceForChange` all pass it. The
 * same document therefore governed the `validating → accepted` edge and NOT the wave boundaries of
 * the very same change.
 *
 * The OWNING half (below, `via: "ownerGroup"`) closes both. It is deliberately ADDITIVE — it only
 * ever adds matches, never removes one — so for every consumer the change is monotonically
 * TIGHTENING and no gate that fired before can stop firing. See ADR-0016 §2a for the decision, the
 * before/after, and the migration note.
 */

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
  // ADR-0035 asymmetry: a match found within the bound is valid regardless of what else the
  // frontier was doing — membership is a reachability fact. Only NON-membership can be fabricated
  // by a cut walk, and a fabricated "not a member" here makes a group-scoped REQUIRED policy
  // silently not apply: fail-open, the worst direction this repo knows (ADR-0026). So: match wins;
  // no-match with a still-expanding frontier refuses; clean no-match stays false.
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

/**
 * DESIGN §10.1's **OWNING**-subject half of group scope: which of `chainObjectIds` are OWNED by
 * `groupObjectId` — either directly (the group itself holds the `owns` edge) or through any
 * transitive `member_of` member of it (a team, a user, a service account).
 *
 * DIRECTION. `isMemberOf` above expands a subject UPWARD to the groups it belongs to; this expands
 * a group DOWNWARD to its members. Same `member_of` closure, walked the other way, because here the
 * group is the known end and the owners are not.
 *
 * WHY IT ANCHORS ON THE CONTAINMENT CHAIN, NOT ON THE TARGET ALONE. Ownership scope inherits
 * downward exactly as `objectRef` and `selector` scope do: if a group owns a SERVICE, its policy
 * governs that service's components. Restricting the match to a direct `owns` edge on the target
 * itself would make ownership scope the only scope kind that does not inherit — and would fail open
 * on every component whose ownership is recorded at the service, which is the normal shape
 * (`routes/ownership.ts`). Note `owns`'s registered `to_types` (`0002_rls_rbac_seed.sql:173-176`)
 * are service/component/domain/deployment-target/contract and deliberately EXCLUDE `organization`,
 * so this can never match at the org root — an ownership match is always strictly more specific
 * than the unscoped/acting-subject anchor.
 *
 * NO ARBITRARY DEPTH BOUND, DELIBERATELY. `UNION` (not `UNION ALL`) over a bare `member_id` makes
 * this cycle-safe by construction: a row already produced is never re-produced, so a `member_of`
 * cycle terminates the recursion instead of spinning. `isMemberOf` above caps at `depth < 10`
 * because it carries a `depth` column, which defeats `UNION`'s own dedup and forces a cap; that
 * silent-truncation property is a KNOWN, SEPARATELY-TRACKED defect at six sites and is not touched
 * here. This function does not add a seventh.
 */
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

/**
 * Gathers every policy that matches ANY of `targetObjectIds`' containment chains (or the actor's
 * group membership), each annotated with WHERE/HOW it matched — ready to hand to
 * `policy-model.ts`'s `resolvePolicies` for the stricter-wins merge. Deduplicates a policy that
 * matches the same target-chain-object more than once.
 *
 * THAT DEDUP IS NOT THEORETICAL, and this comment used to say it was ("can't happen with today's
 * three match kinds"). The scope keys are independent `if`s, not `else if`s, so a document carrying
 * two of them matches on OR and CAN record the same (policy, object) twice — e.g.
 * `{objectRef: <a service>, group: <the group that owns it>}`. `record` is first-writer-wins and
 * the branch order is objectRef → selector → group → ownerGroup, so in that case the surviving
 * `via` names the FIRST branch that matched, not the only one. The MATCH is right either way (the
 * entry, its anchor and its depth are identical whichever branch produced it); only the provenance
 * LABEL is lossy, and it is lossy in a documented, deterministic direction. Widening `via` to a set
 * would change the shape of every persisted reason tree and is deliberately left out of this change.
 */
export async function matchPoliciesForTargets(
  tx: TenantTx,
  input: MatchPoliciesInput
): Promise<MatchedPolicy[]> {
  const candidates = await listPolicyCandidates(tx, input.orgId);
  if (candidates.length === 0) return [];

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

  const matches = new Map<string, MatchedPolicy>();

  for (const candidate of candidates) {
    const scope = candidate.properties.scope;
    const enforcement = candidate.properties.enforcement;
    const effects = candidate.properties.effects ?? [];
    const condition = candidate.properties.condition;
    const emergencyPolicy = candidate.properties.emergencyPolicy ?? false;
    const autoRollbackOnFailure = candidate.properties.autoRollbackOnFailure ?? false;

    const record = (
      objectId: string,
      depth: number,
      via: MatchedPolicy["matchedAt"]["via"]
    ): void => {
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
      if (groupId) {
        // (a) THE ACTING-SUBJECT HALF — unchanged behaviour, preserved verbatim. "This rule governs
        // work done BY this group." It has no containment-chain anchor of its own, so it attaches
        // at every target's org root (depth 0), the same placement convention as "unscoped".
        if (await isMemberOf(tx, input.orgId, input.actorObjectId, groupId)) {
          for (const chain of chains.values()) {
            const root = chain[0];
            if (root) record(root.id, 0, "group");
          }
        }

        // (b) THE OWNING-SUBJECT HALF (ADR-0016 §2a, 2026-08-15) — "this rule governs work ON what
        // this group owns." Independent of who is acting, which is exactly why it closes the
        // fail-open (module doc). It DOES have a real anchor — the owned object on the chain — so it
        // records at that object's true depth rather than at the org root. That is not cosmetic:
        // `scan-requirements.ts` derives the six-tier explainability label from
        // `matchedAt.objectId`'s type, so anchoring a service-ownership match at the org root would
        // report an org-tier ceiling for a service-tier requirement (ADR-0016 §5's promise that a
        // blocked promotion can show WHICH tier set the binding floor).
        const owned = await ownedForGroup(groupId);
        if (owned.size > 0) {
          for (const chain of chains.values()) {
            for (const entry of chain) {
              if (owned.has(entry.id)) record(entry.id, entry.depth, "ownerGroup");
            }
          }
        }
      }
    }
  }

  return [...matches.values()];
}
