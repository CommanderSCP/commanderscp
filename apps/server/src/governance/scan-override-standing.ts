import type { ScanRequirementTier } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { containmentChain } from "../graph/containment.js";
import { readInstanceScanFloors, tierForObjectType, tierRank } from "./scan-requirements.js";

/**
 * M22.6 (ADR-0033 §6a, owner decision D3) — THE AUTHORING-TIME HALF of "the approver tier is DERIVED,
 * never declared".
 *
 * ==================================================================================================
 * WHY THIS FILE EXISTS RATHER THAN LIVING IN `scan-override-grants.ts`
 * ==================================================================================================
 * Purely structural: `scan-requirements.ts` already imports the grant resolver, so the grant module
 * cannot import back without a cycle. This module sits above both and is imported only by the routes.
 *
 * ==================================================================================================
 * THIS IS THE WEAKER OF THE TWO CHECKS, AND THAT IS DELIBERATE
 * ==================================================================================================
 * The DECISIVE check is `applyOverrideAuthorityBar`, applied at the gate where the effective ceiling
 * and its contributing tiers actually exist. Everything here is an authoring-time refusal that exists
 * so an approver is not left believing they granted something a gate will silently ignore — the same
 * reason the approve route already refuses a past `expiresAt` that the resolver would ignore anyway.
 *
 * A refusal at the door can never be the whole enforcement for this feature, because the rule a grant
 * waives is resolved PER CHANGE from the policies matching that change's targets: a ceiling can be
 * authored, retargeted or conditioned after the grant is approved. So the door refuses what it can
 * prove now, and the gate re-derives everything from scratch.
 */

/**
 * THE CHAIN CHECK — `tierObjectId` must be an object on the COMPONENT'S OWN containment chain.
 *
 * `getObjectByIdOrUrnAnyType` resolving the id proves only that the row exists. Naming any object in
 * the graph was the original defect: because `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD, a
 * requester naming an object they already hold `policy:write` at hands themselves approver standing.
 * Requiring the object to be an ancestor (or the component itself) makes the named authority one that
 * genuinely reaches this component through the same routes the RBAC walk uses, and gives the gate a
 * tier to derive rather than a label to trust.
 *
 * Returns the DERIVED tier so the caller never re-derives it from a different source.
 */
export async function assertOverrideTierStanding(
  tx: TenantTx,
  input: { orgId: string; componentObjectId: string; tierObjectId: string }
): Promise<ScanRequirementTier> {
  const chain = await containmentChain(tx, input.orgId, input.componentObjectId);
  const entry = chain.find((e) => e.id === input.tierObjectId);
  if (!entry) {
    throw badRequest(
      `tierObjectId '${input.tierObjectId}' is not on component '${input.componentObjectId}'s ` +
        `containment chain, so it names no authority over it. A grant's approver standing is the ` +
        `tier that SET the rule being waived (ADR-0033 D3); naming an unrelated object would let a ` +
        `requester select the authority that approves their own waiver.`
    );
  }
  return tierForObjectType(entry.typeId);
}

/**
 * THE INSTANCE-FLOOR CHECK — refuse to APPROVE a grant that could never apply.
 *
 * `scan_requirement_floors` rows are authored ONLY with the deployment operator token
 * (`routes/instance-scan-floors.ts`: "no tenant role can grant it"), and they contribute at
 * `platform` / `trust_domain`. `tierForObjectType` maps NO graph object to either rung, so while any
 * such floor is set there is no `tierObjectId` a tenant could name that clears the bar — the gate
 * would refuse every grant for authority.
 *
 * D3 read literally: "a platform-set floor is waivable only at platform." That is exactly what this
 * says out loud at the door, instead of letting an approver sign an accepted-risk record that has no
 * effect. A floor added AFTER an approval is still handled — by the gate, which re-derives the bar on
 * every evaluation.
 *
 * NOTE THE ASYMMETRY WITH `deny`/`revoke`: only APPROVE is refused. Taking a waiver back must never be
 * harder than making one, and neither verb can loosen anything.
 */
export async function assertNoInstanceFloorOutranksTier(
  tx: TenantTx,
  tier: ScanRequirementTier
): Promise<void> {
  const floors = await readInstanceScanFloors(tx);
  const outranking = floors.filter((f) => tierRank(f.tier) < tierRank(tier));
  if (outranking.length === 0) return;
  throw badRequest(
    `this grant cannot be approved at tier '${tier}': an instance-scoped scan floor is set at ` +
      `${[...new Set(outranking.map((f) => f.tier))].sort().join(", ")} ` +
      `(${outranking
        .map((f) => f.source)
        .sort()
        .join(", ")}), and a floor set above a tier is not ` +
      `waivable at that tier (ADR-0033 D3). Instance floors are authored with the deployment ` +
      `operator token, which no tenant role can grant — so the gate would refuse this grant for ` +
      `authority and it would tolerate nothing.`
  );
}
