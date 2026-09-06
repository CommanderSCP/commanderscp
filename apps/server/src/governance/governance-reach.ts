import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { containmentChildrenSql } from "../graph/containment.js";
import { matchPoliciesForTargets } from "./policy-resolve.js";

/**
 * WHEN AN OBJECT MOVES, THE POLICIES THAT GOVERN IT CHANGE — AND NOTHING RECORDED IT.
 *
 * ## The property
 *
 * > **The permission that changes what governance REACHES is weaker than, and differently held
 * > from, the permission that AUTHORS governance.**
 *
 * `governance/policy-resolve.ts` matches every scope kind — `objectRef`, `selector`, `group`,
 * `ownerGroup`, unscoped — over the target's CONTAINMENT CHAIN (`graph/containment.ts`), and
 * `authz/resolve.ts`'s `scopeExpandCte` expands authority upward over the same edges. Containment is
 * therefore the reach of all governance. It is also ordinary tenant-writable graph data, by THREE
 * routes:
 *
 *   1. `objects.domain_id` — written by every typed `PUT`/`PATCH` under `object:write` (or
 *      `policy:write` for the governance-owned types);
 *   2. the `contains` edge — created and deleted through the generic `/relationships` endpoints and
 *      through IaC apply under `relationship:write`; and
 *   3. TOMBSTONING A CONTAINER, which writes no containment field at all and yet detaches everything
 *      beneath it, because every route above skips a DELETED ancestor. See
 *      `countContainmentDependents` for why this one is neither of the other two and could not be
 *      left to the edge cascade it appears to share.
 *
 * `policy:write` is held by `Administrator` and `Owner` alone (`drizzle/0010_governance.sql:174`).
 * `relationship:write` and `object:write` are held by `Operator` and up
 * (`drizzle/0002_rls_rbac_seed.sql:210`). So the actor who can move a component out from under a
 * `required` gate is a strictly weaker, and routinely granted, principal than the one who authored
 * that gate — and the move produced an `object.update` or a relationship create/delete
 * indistinguishable from any other.
 *
 * This is `docs/proposals/governance-label-namespace.md` §7a/§8.8, which measured the escape and
 * filed it as the next task rather than fixing it. See
 * `docs/proposals/governance-reach-on-containment-move.md` for the options weighed and why this one
 * was taken.
 *
 * ## What this module is, and what it deliberately is NOT
 *
 * It is DETECTION, not prevention. The move still succeeds. What changes is that a move which alters
 * the set of policies matching the moved object now writes a `Decision` naming every policy gained
 * and lost, plus a hash-chained audit event pointing at it (charter principle 6 — "every engine
 * verdict persists a Decision record with its inputs").
 *
 * Prevention — requiring `policy:write`, or a new governance-move permission, when a move drops a
 * policy — is a behaviour change to tenant write ergonomics and is proposed for owner decision in
 * §4 of the proposal, NOT taken here. The refusal would be the cheap part; the expensive part is
 * that its trigger is *computed*, so an operator cannot predict which reorganisations will be
 * refused, and the estate's ordinary reorganisation work would start requiring an administrator.
 * That is the same objection that sank option (b) of the label proposal, and it deserves an owner's
 * answer rather than an implementer's.
 *
 * ## Why the cost objection that killed detection for LABELS does not apply here
 *
 * The label proposal rejected an audit-event remedy partly because "it costs a full policy scan plus
 * a containment walk on the hottest write path in the system" — `createObject`, which the M1
 * definition of done budgets at 5,000 sequential creates.
 *
 * This path is COLD, and the difference is structural rather than a matter of degree:
 *
 *   - a CREATE is never a move. `createObject` resolves a default containment parent and is not
 *     instrumented here at all — a brand-new object has no "before" reach to have changed.
 *   - an UPDATE pays nothing unless `domain_id` actually changes value. A `PATCH` renaming an object,
 *     or a `PUT` restating the parent it already has, short-circuits before any query.
 *   - a relationship write pays nothing unless its type is `contains`. Every other edge type — the
 *     overwhelming majority of relationship writes — short-circuits on a string comparison.
 *   - an org with no `policy` rows pays ONE indexed `SELECT` per instrumented write, because
 *     `matchPoliciesForTargets` returns early on an empty candidate list before walking anything.
 *
 * What remains is two `matchPoliciesForTargets` calls on a genuine reorganisation, which is a
 * human-initiated, low-frequency act.
 *
 * ## Why the repo choke point rather than the routes
 *
 * The same split `federation/domain-local.ts` and `graph/containment-parent-authz.ts` argue for, but
 * landing on the OTHER side of it — and the reason is that this is a RECORDING, not an
 * authorization.
 *
 * Authorization belongs at the door because it needs a real requesting subject, and running it at the
 * repo would abort the federation importer and IaC apply, whose actors hold no bindings. A recording
 * has the opposite requirement: it must happen on EVERY write regardless of who is acting, precisely
 * so that a reach change arriving through an import or an apply is as visible as one arriving through
 * `DELETE /relationships/{id}`.
 *
 * FIVE sites, and the count is the point — `updateObject`, `upsertObjectByUrn`'s hand-fill
 * reconciliation branch (which deliberately does NOT delegate to `updateObject`), `createRelationship`,
 * `deleteRelationship`, and `deleteObject`. Between them they cover every door — the typed routes, the
 * generic routes, IaC apply, `POST /discovery/accept`, federation import, hand-fill and overlays —
 * without enumerating any of them, which is the census failure this repo keeps paying for
 * (`docs/BUILD_AND_TEST.md` §4.4). Each was proved installed by deleting it alone and watching one
 * named case fail; the log is in `governance-reach.integration.test.ts` and the PR body.
 *
 * ## Scope of the recorded delta: the moved object, and why that is the honest boundary
 *
 * The reach delta is computed for the object whose parent changed, NOT for its descendants. Moving a
 * service moves everything under it, and walking the subtree would be unbounded work on a write path.
 *
 * It is not a gap in what the record MEANS, because every scope kind here is anchored on the
 * containment chain: a policy that stops reaching the moved node stops reaching everything beneath
 * it by the same edge, so the delta recorded at the moved node is exactly the delta its descendants
 * inherit. The Decision says so in `inputContext.appliesToDescendants`, rather than leaving a reader
 * to assume the record is complete for one object.
 */

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

/**
 * Every policy currently reaching `objectId`, keyed by policy object id.
 *
 * Keyed by POLICY, not by (policy, matched object): a move that keeps a policy but changes where it
 * attaches — an org-root-scoped policy re-anchoring under a new parent, a selector matching a
 * different ancestor — has not changed what governs the object, and recording it would bury the
 * cases that did under ones that did not.
 */
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

/**
 * How many LIVE objects have `objectId` on their containment chain as a PARENT — i.e. how many
 * would lose it if it were tombstoned.
 *
 * ## Why this exists: the third door, which writes no containment field at all
 *
 * Routes 1 and 2 are both a write to a containment value. This one is neither. Every containment
 * route in `graph/containment.ts` joins `parent.deleted_at IS NULL` — deliberately, so "a deleted
 * service must not go on governing live components" — which means **soft-deleting a container
 * silently detaches everything beneath it**, under `object:write` at the container, while every
 * child's own `domain_id` still reads as correct.
 *
 * It is the widest of the three: one delete moves an unbounded number of objects out of reach of
 * every policy anchored at-or-above the container, and unlike a re-parent it is not visible as a
 * move — nothing about the children changes.
 *
 * ## Why the cascade does not already cover it
 *
 * `deleteObject` tombstones the row and THEN cascades `deleteRelationship` over its edges. By the
 * time a cascaded `contains` delete runs, the container is already tombstoned, so route 2's
 * before-reach has already lost it and the diff is empty. The per-child recorder is INERT on this
 * path — measured, and the reason this route is instrumented separately rather than assumed covered
 * by the edge cascade it appears to share.
 *
 * ## The routes it counts: `containmentChildrenSql`, COMPOSED — not restated
 *
 * `graph/containment.ts`'s exported downward fragment, one level, counted. It is the same three arms
 * the depth doors and the read filter descend, so "what contains this row" and "what does this row
 * contain" cannot disagree here.
 *
 * ⚠️ IT USED TO BE A HAND-TYPED COPY, AND IT HAD ALREADY DRIFTED IN TWO PLACES. Because it is ONE
 * LEVEL rather than recursive, a census for the downward WALK did not see it: `containment.ts`'s
 * header asserted "exactly one definition" while this was the third. Both drifts changed what counts
 * as a dependent, and both are now fixed by composing:
 *
 *   - ARM 2 counted `contains` EDGES and never joined the child object, so a live edge to a
 *     TOMBSTONED child counted as a dependent — contradicting this function's own first sentence
 *     ("how many LIVE objects"). Reachable: `deleteObject`'s cascade refuses REPLICA edges, and
 *     legacy rows predate it. The record it produced said "detached 1 contained object(s)" about a
 *     row that was already gone.
 *   - ARM 3 compared `properties ->> 'componentId'` as RAW TEXT with no `UUID_TEXT_PATTERN` guard
 *     and no cast, while the fragment casts to `uuid`. Measured on PostgreSQL 16, `uuid` equality is
 *     case-insensitive and `text` equality is not, so an UPPER-CASE-HEX `componentId` was a parent
 *     going UP and not a dependent counted DOWN. The cast form is the correct side — see
 *     `placementNamesObjectSql`'s note, which weighs it against migration 0051's text index and
 *     decides the mirror is worth more.
 *
 * ## The self-exclusion, and why it is HERE and not in the fragment
 *
 * `c.child_id <> objectId` answers this function's QUESTION — "how many OTHER rows would lose this
 * parent if it were tombstoned?" — for which a row that is its own containment parent (only
 * reachable as legacy or federation-imported data; every write door refuses to create one) loses
 * nothing, because it IS the tombstone.
 *
 * It must not move into `containmentChildrenSql`. That fragment is defined as the EXACT INVERSE of
 * the four routes `containmentChain` walks up, and `containmentChain` does not exclude self either —
 * a self-parented row is walked, blows the depth bound and refuses loudly (ADR-0037). An exclusion
 * added there would break the inverse property the fragment exists to guarantee, and would silently
 * change a WRITE DOOR (`containmentSubtreeExceeds`) as well as this read.
 *
 * Applying it across all three arms rather than to arm 1 alone (where the old copy had it) is a
 * deliberate, unreachable-by-any-door widening of the exclusion: a self `contains` edge is refused
 * by `relationships-repo.ts`'s cycle check, and a placement's `componentId` is the resolved
 * component's id, never its own. It only makes the pathological-data answer consistent across arms.
 *
 * Counted rather than enumerated: the record needs to say how wide the blast radius was, and walking
 * every descendant's before/after reach on a delete is unbounded work on a write path. `count(*)`
 * over the fragment's `UNION ALL` is the sum of the three arms, which is exactly what the three
 * added sub-counts computed.
 */
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

/**
 * Computes the reach AFTER the write (the caller is inside the same transaction, so this sees the
 * uncommitted change), diffs it against `before`, and persists a Decision + audit event when — and
 * ONLY when — the set of matching policies differs.
 *
 * Persist-on-change is not an optimisation here, it is the whole contract. A recorder that wrote a
 * row per containment write would reproduce the defect this repo has already paid for once: a gate
 * re-writing a byte-identical Decision every tick, 1.44 GB/day in production, 99.94% duplicates.
 * "Reach changed" is a genuine edge, so the row count is bounded by real reorganisations.
 */
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

/**
 * ROUTE 3's recorder — a CONTAINER being tombstoned, which detaches its descendants without writing
 * any containment field.
 *
 * ## Why it cannot reuse `recordGovernanceReachChange`
 *
 * That function diffs the SUBJECT's own before/after reach, and for a deleted container the diff is
 * empty by construction: `containmentChain` filters `deleted_at IS NULL` on ANCESTORS but
 * deliberately not on the TARGET itself ("governance may legitimately be evaluated over a deleted
 * object"), so the container's own chain — and therefore its own reach — is identical either side of
 * the tombstone. Reusing it here would compile, run, record nothing, and look installed. This is the
 * shape that has to be written separately rather than adapted.
 *
 * ## What is recorded instead, and why it is the honest statement
 *
 * The policies reaching the CONTAINER are exactly the ones its descendants inherit THROUGH it, so
 * that set — plus how many objects were hanging off it — is the blast radius, computed in bounded
 * work rather than by walking an unbounded subtree.
 *
 * It is stated as `mayNoLongerReach` rather than `lost`, and the distinction is real: a descendant
 * reachable by a SECOND route (a component whose `domain_id` and whose service both lead to the same
 * policy) keeps it. Over-reporting here is the right direction — the alternative is per-descendant
 * before/after on a delete — but calling it a loss when it may not be would make the record wrong
 * rather than conservative.
 */
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
