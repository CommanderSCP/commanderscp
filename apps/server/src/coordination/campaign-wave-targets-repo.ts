import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { campaignWaveTargets, campaignWaves } from "../db/schema.js";

/**
 * DB access `coordination/campaign-reconcile.ts` needs around `campaign_waves`/
 * `campaign_wave_targets` beyond what `campaign-plan-service.ts` already provides (which only
 * writes the initial compiled plan) — the campaign-scoped sibling of `wave-targets-repo.ts`.
 */

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

/**
 * Terminalize a campaign wave target the reconciler REFUSED to fan out — today, one whose target
 * object has been tombstoned (`target-liveness.ts`). The campaign-side sibling of
 * `wave-targets-repo.ts`'s `terminalizeRefusedWaveTarget`, and guarded the same way and for the same
 * reason: `status = 'pending'` in the WHERE plus RETURNING, so the caller emits the block Decision +
 * hash-chained audit event EXACTLY ONCE no matter how many 1 s ticks arrive.
 *
 * `failed` rather than a bespoke status, unlike the change side. A campaign wave target's statuses
 * are `pending | change_proposed | succeeded | failed` and they describe the FAN-OUT, not an
 * execution — there is no executor here and nothing for a distinct terminal to disambiguate against.
 * WHY it failed is carried by the block Decision the caller writes, which is where a campaign already
 * records its compile faults (`campaign-reconcile.ts`'s `plan_diff` verdict).
 */
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
