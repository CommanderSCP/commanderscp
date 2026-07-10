import type { TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Object types whose authority is bound to a DECLARED, checkable field on `properties` rather
 * than the generic `object:write`-at-domain check every ordinary typed resource gets — the same
 * class of risk `governance/policy-scope-authz.ts` closes for `policy.properties.scope`, applied
 * here to `campaign.properties.targets` (M5 adversarial-review surface: "a campaign can't
 * coordinate a change the actor lacks authority over"). `initiative` is deliberately NOT included
 * here: an initiative's only privilege-relevant action is linking a member campaign, which is
 * already a `coordinates` RELATIONSHIP write — independently authorized both-endpoint wherever it
 * happens (`routes/relationships.ts`'s generic path, and `coordination/initiative-repo.ts`'s own
 * equivalent check) — creating a bare, unlinked `initiative` object poses no privilege escalation.
 */
export const COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["campaign"]);

export function isCoordinationTargetScopedObjectType(typeId: string): boolean {
  return COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS.has(typeId);
}

/**
 * Binds a campaign's DECLARED `properties.targets` to the actor's own authority — every write
 * path that can create/update a `campaign` graph object must call this (mirroring
 * `assertPolicyScopeWithinAuthority`'s two call sites exactly): `coordination/campaign-repo.ts`'s
 * `proposeCampaign` already does the equivalent per-target loop inline (it needs the resolved ids
 * back for the plan compiler, not just a boolean pass/fail); this standalone entry point is for
 * the write paths that DON'T go through `proposeCampaign` at all — `routes/objects-generic.ts`
 * blocks `campaign` outright (see that file), so the one remaining path is `iac/plans-repo.ts`'s
 * `POST /plans/{id}/apply`, exactly the same shape as the policy-scope fix.
 *
 * Fails closed: an unresolvable target (bad id/urn) throws via `getObjectByIdOrUrnAnyType` (404),
 * and a target the actor lacks `object:write` over throws via `authorize` (403) — never a silent
 * skip.
 */
export async function assertCampaignTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
): Promise<void> {
  const targets = input.properties?.targets;
  if (!Array.isArray(targets)) return;
  for (const idOrUrn of targets) {
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
