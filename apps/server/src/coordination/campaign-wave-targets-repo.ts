import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { campaignWaveTargets, campaignWaves } from "../db/schema.js";

/** The campaign wave access the reconciler needs. See docs/coordination.md §231. */

export async function markCampaignWaveBlocked(
  tx: TenantTx,
  orgId: string,
  waveId: string
): Promise<void> {
  await tx
    .update(campaignWaves)
    .set({ status: "blocked" })
    .where(and(eq(campaignWaves.orgId, orgId), eq(campaignWaves.id, waveId)));
}

export async function markCampaignWaveRunning(
  tx: TenantTx,
  orgId: string,
  waveId: string
): Promise<void> {
  await tx
    .update(campaignWaves)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(campaignWaves.orgId, orgId), eq(campaignWaves.id, waveId)));
}

export async function markCampaignWaveTerminal(
  tx: TenantTx,
  orgId: string,
  waveId: string,
  status: "succeeded" | "failed"
): Promise<void> {
  await tx
    .update(campaignWaves)
    .set({ status, completedAt: new Date() })
    .where(and(eq(campaignWaves.orgId, orgId), eq(campaignWaves.id, waveId)));
}

export async function markCampaignWaveTargetProposed(
  tx: TenantTx,
  orgId: string,
  targetId: string,
  memberChangeObjectId: string
): Promise<void> {
  await tx
    .update(campaignWaveTargets)
    .set({ status: "change_proposed", memberChangeObjectId, updatedAt: new Date() })
    .where(and(eq(campaignWaveTargets.orgId, orgId), eq(campaignWaveTargets.id, targetId)));
}

export async function markCampaignWaveTargetTerminal(
  tx: TenantTx,
  orgId: string,
  targetId: string,
  status: "succeeded" | "failed"
): Promise<void> {
  await tx
    .update(campaignWaveTargets)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(campaignWaveTargets.orgId, orgId), eq(campaignWaveTargets.id, targetId)));
}

/** Terminalize a target the reconciler refused to fan out. See docs/coordination.md §232. */
export async function terminalizeRefusedCampaignWaveTarget(
  tx: TenantTx,
  orgId: string,
  targetId: string
): Promise<boolean> {
  const result = await tx
    .update(campaignWaveTargets)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(campaignWaveTargets.orgId, orgId),
        eq(campaignWaveTargets.id, targetId),
        eq(campaignWaveTargets.status, "pending")
      )
    )
    .returning({ id: campaignWaveTargets.id });
  return result.length > 0;
}

/** Terminalize succeeded: the component was already migrated. See docs/coordination.md §233. */
export async function terminalizeAdoptedCampaignWaveTarget(
  tx: TenantTx,
  orgId: string,
  targetId: string
): Promise<boolean> {
  const result = await tx
    .update(campaignWaveTargets)
    .set({ status: "succeeded", updatedAt: new Date() })
    .where(
      and(
        eq(campaignWaveTargets.orgId, orgId),
        eq(campaignWaveTargets.id, targetId),
        eq(campaignWaveTargets.status, "pending")
      )
    )
    .returning({ id: campaignWaveTargets.id });
  return result.length > 0;
}
