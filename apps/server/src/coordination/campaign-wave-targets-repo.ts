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

/**
 * M25.5 — terminalize a campaign wave target `succeeded` because the component was ALREADY MIGRATED
 * when the campaign reached it (`campaign-adoption.ts`), with no member Change proposed for it.
 *
 * `succeeded` rather than a new status, deliberately. The wave-target statuses describe the FAN-OUT
 * (`pending | change_proposed | succeeded | failed`), and the fan-out's goal for this target — the
 * component being on the far side of the migration — is met. Inventing an `adopted` status would
 * fall through `campaign-reconcile.ts`'s per-target `else` branch, which casts
 * `memberChangeObjectId as string` on what is legitimately NULL here: the proposal's own data-model
 * table records that a new `campaign_wave_targets.status` value is "a live bug, not a free
 * extension". WHY it succeeded without a change is carried by the `campaign_adoption` Decision and
 * its paired audit event, which is where a campaign already records this class of fact.
 *
 * GUARDED ON `pending` + RETURNING, exactly like {@link terminalizeRefusedCampaignWaveTarget} above,
 * and the guard is what makes the caller's Decision and hash-chained audit event fire EXACTLY ONCE
 * no matter how many 1 s ticks arrive at an adopted component. It is also the multi-replica
 * interlock: two overlapping ticks race here and only the row-level winner writes the record.
 */
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
