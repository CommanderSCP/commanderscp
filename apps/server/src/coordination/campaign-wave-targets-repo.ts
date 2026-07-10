import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { campaignWaveTargets, campaignWaves } from "../db/schema.js";

/**
 * DB access `coordination/campaign-reconcile.ts` needs around `campaign_waves`/
 * `campaign_wave_targets` beyond what `campaign-plan-service.ts` already provides (which only
 * writes the initial compiled plan) — the campaign-scoped sibling of `wave-targets-repo.ts`.
 */

export async function markCampaignWaveBlocked(tx: TenantTx, orgId: string, waveId: string): Promise<void> {
  await tx
    .update(campaignWaves)
    .set({ status: "blocked" })
    .where(and(eq(campaignWaves.orgId, orgId), eq(campaignWaves.id, waveId)));
}

export async function markCampaignWaveRunning(tx: TenantTx, orgId: string, waveId: string): Promise<void> {
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
