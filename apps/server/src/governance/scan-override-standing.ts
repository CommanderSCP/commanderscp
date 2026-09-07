import type { ScanRequirementTier } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { containmentChain } from "../graph/containment.js";
import { readInstanceScanFloors, tierForObjectType, tierRank } from "./scan-requirements.js";

/** The authoring-time half of the approver standing rule. See docs/governance.md §355. */

/** THE CHAIN CHECK. See docs/governance.md §356. */
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

/** THE INSTANCE-FLOOR CHECK. See docs/governance.md §357. */
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
