import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { containmentChildrenSql } from "../graph/containment.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";

/** WHEN AN OBJECT MOVES, THE POLICIES THAT GOVERN IT CHANGE. See docs/governance.md §195. */

/** `decisions.kind` — one constant, because the read side filters on an exact match. */
export const GOVERNANCE_REACH_DECISION_KIND = "governance.reach.changed";

/** `audit_events.action`. Distinct from the `object.update` / `relationship.contains.*` event the
 *  same transaction also writes: those record that a field changed, this records what it COST. */
export const GOVERNANCE_REACH_AUDIT_ACTION = "governance.reach.changed";

/** One policy that matched the subject, reduced to what a reader of the record needs. */
export interface ReachedPolicy {
  policyObjectId: string;
  name: string;
  enforcement: string;
  /** Which object on the containment chain the policy attached at, and by which scope kind — the
   *  half that tells an operator WHY it stopped matching. */
  matchedAtObjectId: string;
  via: string;
}

/** Every policy currently reaching this object, keyed by id. See docs/governance.md §196. */
export async function policyReachFor(
  tx: TenantTx,
  orgId: string,
  objectId: string,
  actorObjectId: string
): Promise<Map<string, ReachedPolicy>> {
  const matched = await matchPoliciesForTargets(tx, {
    orgId,
    targetObjectIds: [objectId],
    actorObjectId
  });
  const reach = new Map<string, ReachedPolicy>();
  for (const m of matched) {
    // First writer wins, mirroring `matchPoliciesForTargets`' own dedup: a policy carrying two scope
    // keys can match twice, and the entry is identical either way apart from the provenance label.
    if (reach.has(m.policyObjectId)) continue;
    reach.set(m.policyObjectId, {
      policyObjectId: m.policyObjectId,
      name: m.name,
      enforcement: m.enforcement,
      matchedAtObjectId: m.matchedAt.objectId,
      via: m.matchedAt.via
    });
  }
  return reach;
}

/** Which containment route the write travelled — the three doors of the proposal's §2. */
export type ContainmentRoute = "domain_id" | "contains" | "container_deleted";

/** How many live objects have this one as a parent. See docs/governance.md §197. */
export async function countContainmentDependents(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<number> {
  const result = await tx.execute<{ n: string | number }>(sql`
    SELECT count(*) AS n
    FROM (${containmentChildrenSql(orgId, sql`${objectId}::uuid`)}) c
    WHERE c.child_id <> ${objectId}::uuid
  `);
  return Number(result.rows[0]?.n ?? 0);
}

export interface RecordReachChangeInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  subjectObjectId: string;
  route: ContainmentRoute;
  /** Route-specific detail for the Decision's `inputContext` — the old/new parent, or the edge. */
  detail: Record<string, unknown>;
  before: Map<string, ReachedPolicy>;
  /** From the ROW, never the request — an audit segment naming a domain-local subject must not
   *  federate (ADR-0031 §2). */
  subjectDomainLocal: boolean;
}

/** Computes the reach AFTER the write. See docs/governance.md §198. */
export async function recordGovernanceReachChange(
  tx: TenantTx,
  input: RecordReachChangeInput
): Promise<void> {
  const after = await policyReachFor(tx, input.orgId, input.subjectObjectId, input.actorObjectId);

  const lost = [...input.before.values()].filter((p) => !after.has(p.policyObjectId));
  const gained = [...after.values()].filter((p) => !input.before.has(p.policyObjectId));
  if (lost.length === 0 && gained.length === 0) return;

  // A move that only ADDS policies is tightening and cannot be an evasion; one that drops any is the
  // direction the proposal is about. Recorded as the verdict so a reader can filter on it without
  // re-deriving it from the arrays.
  const verdict = lost.length > 0 ? "reach_reduced" : "reach_extended";

  const decision = await insertDecision(tx, {
    orgId: input.orgId,
    kind: GOVERNANCE_REACH_DECISION_KIND,
    subjectId: input.subjectObjectId,
    verdict,
    inputContext: {
      // Route-specific detail FIRST, so the fixed keys below always win. The other order let a
      // `detail` key named `route` silently overwrite the route the record is filtered on.
      ...input.detail,
      route: input.route,
      actorObjectId: input.actorObjectId,
      // See the module doc: the delta at the moved node is the delta its descendants inherit, and
      // saying so is what keeps a reader from mistaking a one-object record for the whole blast
      // radius.
      appliesToDescendants: true
    },
    reasonTree: {
      lost: lost.map(summarize),
      gained: gained.map(summarize),
      beforeCount: input.before.size,
      afterCount: after.size
    }
  });

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: GOVERNANCE_REACH_AUDIT_ACTION,
    subjectId: input.subjectObjectId,
    // No content hashes: the subject of this event is the POLICY SET reaching an object, which is
    // derived from the graph and has no stored row of its own to hash. The Decision holds the
    // before/after, and `decisionId` is the link to it.
    beforeHash: null,
    afterHash: null,
    reason: describe(verdict, lost, gained),
    decisionId: decision.id,
    requestId: input.requestId,
    subjectDomainLocal: input.subjectDomainLocal
  });
}

/** ROUTE 3's recorder. See docs/governance.md §199. */
export async function recordContainerDeletionReachChange(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    containerObjectId: string;
    containerTypeId: string;
    dependentCount: number;
    reach: Map<string, ReachedPolicy>;
    subjectDomainLocal: boolean;
  }
): Promise<void> {
  // Nothing hung off it, or nothing governed it — either way no governance reach changed. Both
  // guards matter: the first is the common case (deleting a leaf), the second keeps ungoverned orgs
  // off this path entirely.
  if (input.dependentCount === 0 || input.reach.size === 0) return;

  const affected = [...input.reach.values()];
  const decision = await insertDecision(tx, {
    orgId: input.orgId,
    kind: GOVERNANCE_REACH_DECISION_KIND,
    subjectId: input.containerObjectId,
    verdict: "reach_reduced",
    inputContext: {
      route: "container_deleted" satisfies ContainmentRoute,
      containerTypeId: input.containerTypeId,
      dependentCount: input.dependentCount,
      actorObjectId: input.actorObjectId,
      appliesToDescendants: true
    },
    reasonTree: { mayNoLongerReach: affected.map(summarize), dependentCount: input.dependentCount }
  });

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: GOVERNANCE_REACH_AUDIT_ACTION,
    subjectId: input.containerObjectId,
    beforeHash: null,
    afterHash: null,
    reason:
      `deleting this ${input.containerTypeId} detached ${input.dependentCount} contained object(s) ` +
      `from ${affected.map((p) => `'${p.name}' (${p.enforcement})`).join(", ")} — a deleted ` +
      `container is skipped by every containment walk, so policies anchored at or above it stop ` +
      `reaching what it contained`,
    decisionId: decision.id,
    requestId: input.requestId,
    subjectDomainLocal: input.subjectDomainLocal
  });
}

function summarize(p: ReachedPolicy): Record<string, unknown> {
  return {
    policyObjectId: p.policyObjectId,
    name: p.name,
    enforcement: p.enforcement,
    matchedAtObjectId: p.matchedAtObjectId,
    via: p.via
  };
}

/** Names the policies in the audit `reason`, so the hash-chained log is readable without joining to
 *  `decisions` — an operator reading the audit stream must be able to see WHICH gate stopped
 *  applying, not merely that something did. */
function describe(verdict: string, lost: ReachedPolicy[], gained: ReachedPolicy[]): string {
  const parts: string[] = [];
  if (lost.length > 0) {
    parts.push(
      `no longer governed by ${lost.map((p) => `'${p.name}' (${p.enforcement})`).join(", ")}`
    );
  }
  if (gained.length > 0) {
    parts.push(
      `newly governed by ${gained.map((p) => `'${p.name}' (${p.enforcement})`).join(", ")}`
    );
  }
  return `containment change altered policy reach (${verdict}): ${parts.join("; ")}`;
}
