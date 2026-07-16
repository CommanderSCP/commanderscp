import type { TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Object types whose authority is bound to a DECLARED, checkable field on `properties` rather
 * than the generic `object:write`-at-domain check every ordinary typed resource gets — the same
 * class of risk `governance/policy-scope-authz.ts` closes for `policy.properties.scope`, applied
 * here to `campaign.properties.targets` and `change.properties.targets` (M5 adversarial-review
 * surface: "a campaign can't coordinate a change the actor lacks authority over"; extended to
 * `change` in M12 P4B Phase 2, since a change carrying `requires`/`provides` against an object the
 * actor doesn't control is the same escalation, and its `targets` were already an unchecked surface
 * pre-P4B). Both are refused outright on the generic object route (`routes/objects-generic.ts`) so
 * they can be created and mutated ONLY through their typed, target-authority-checked paths.
 * `initiative` is deliberately NOT included here: an initiative's only privilege-relevant action is
 * linking a member campaign, which is already a `coordinates` RELATIONSHIP write — independently
 * authorized both-endpoint wherever it happens (`routes/relationships.ts`'s generic path, and
 * `coordination/initiative-repo.ts`'s own equivalent check) — creating a bare, unlinked `initiative`
 * object poses no privilege escalation.
 */
export const COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  "campaign",
  "change"
]);

export function isCoordinationTargetScopedObjectType(typeId: string): boolean {
  return COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS.has(typeId);
}

/**
 * Binds a coordination object's DECLARED targets to the actor's own authority: the actor must hold
 * `object:write` over EVERY target, not merely `object:write` at its own domain. This is THE one
 * implementation of the check; `campaign` and `change` both use it (via the wrappers below), so
 * the two can never drift.
 *
 * Fails closed: an unresolvable target (bad id/urn) throws via `getObjectByIdOrUrnAnyType` (404),
 * and a target the actor lacks `object:write` over throws via `authorize` (403) — never a silent
 * skip. A non-array / non-string `targets` is a no-op (there is nothing to authorize).
 */
export async function assertCoordinationTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; targets: unknown }
): Promise<void> {
  if (!Array.isArray(input.targets)) return;
  for (const idOrUrn of input.targets) {
    if (typeof idOrUrn !== "string") continue;
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "object:write",
      scopeObjectId: target.id
    });
  }
}

/**
 * Campaign wrapper reading `properties.targets` — every write path that can create/update a
 * `campaign` graph object must call this (mirroring `assertPolicyScopeWithinAuthority`'s call
 * sites): `coordination/campaign-repo.ts`'s `proposeCampaign` does the equivalent per-target loop
 * inline (it needs the resolved ids back for the plan compiler); this entry point is for the paths
 * that DON'T go through `proposeCampaign` — `routes/objects-generic.ts` blocks `campaign` outright,
 * so the one remaining path is `iac/plans-repo.ts`'s `POST /plans/{id}/apply`.
 */
export async function assertCampaignTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
): Promise<void> {
  return assertCoordinationTargetsWithinAuthority(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    targets: input.properties?.targets
  });
}
