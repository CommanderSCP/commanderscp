/**
 * Relationship types the ENGINE owns end to end — the generic `POST`/`DELETE /relationships`
 * endpoint AND the IaC plan/apply path must both refuse to create or delete them directly, so the
 * ONLY way one of these edges comes into existence is a dedicated, authority-checked internal path
 * that calls `graph/relationships-repo.ts`'s `createRelationship` directly (never the guarded HTTP
 * endpoint). Single source of truth for both call sites (`routes/relationships.ts`,
 * `iac/plans-repo.ts`) — mirrors `governance/governance-managed-types.ts`'s pattern for
 * governance-owned OBJECT types.
 *
 *  - `approves` (DESIGN §10.2 approval EVIDENCE): a fabricated one is a graph-visible fake
 *    "X approved this". Created ONLY by the approval-vote path (`governance/approvals-repo.ts`'s
 *    `castApprovalVote`); removed only by a rollback of the underlying vote.
 *  - `annotates` (DESIGN §13 federation OVERLAYS, M6): a non-owning domain's only legal way to
 *    contribute to an object it doesn't own. Per-type overlay rules bound what may be layered
 *    (policy overlays may only ADD strictness, never weaken/remove a base requirement) — a rule
 *    only `federation/overlay-repo.ts`'s dedicated `createOverlay` enforces before calling
 *    `createRelationship` directly. If any actor holding plain `relationship:write` could create
 *    an `annotates` edge via the generic endpoint, they could layer a WEAKENING "overlay" that
 *    policy-merge-at-read-time code would need to separately distrust — closing the creation
 *    vector here means readers can trust every `annotates` edge they see was strictness-checked.
 *  - `coordinates` (DESIGN §9.5 campaign/initiative MEMBERSHIP): CRITICAL (M5 adversarial review) —
 *    campaign rollback and initiative roll-up read campaign/initiative membership, and a member
 *    Change swept into a rollback is a real, side-effectful revert. If any actor holding org-scoped
 *    `relationship:write` could inject a `coordinates` edge from a victim's campaign to an arbitrary
 *    Change via the generic endpoint (or an IaC manifest), the victim's next legitimate rollback
 *    would revert the injected Change too — bypassing `proposeCampaign`'s per-target authority
 *    check, the headline campaign coordinates-authz invariant. So `coordinates` is created ONLY by
 *    the authority-checked dedicated paths: `campaign-repo.ts`'s `proposeCampaign` (campaign ->
 *    change, via the reconciler `campaign-reconcile.ts`) and `initiative-repo.ts`'s
 *    `proposeInitiative`/`addCampaignToInitiative` (initiative -> campaign), each of which
 *    `authorize()`-checks the acting actor's authority before creating the edge. Rollback itself no
 *    longer trusts these raw edges at all — it sources membership from the plan-compiled
 *    `campaign_wave_targets` (`campaign-rollback.ts`) — this block is defense-in-depth on the
 *    creation side, closing the injection VECTOR outright.
 */
export const SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS: ReadonlySet<string> = new Set([
  "approves",
  "coordinates",
  "annotates"
]);

export function isSystemManagedRelationshipType(typeId: string): boolean {
  return SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS.has(typeId);
}
