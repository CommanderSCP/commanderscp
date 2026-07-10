import { and, desc, eq, inArray } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaveTargets, changeWaves } from "../db/schema.js";

/**
 * DB access `coordination/reconcile.ts` needs around `change_wave_targets`/`change_waves` beyond
 * what `plan-service.ts` already provides (which only writes the initial compiled plan) — status
 * transitions as the reconciliation loop drives each target through its executor, and the
 * "what would a rollback of this target restore" lookup DESIGN §9.4 calls for.
 */

export type WaveRow = typeof changeWaves.$inferSelect;
export type WaveTargetRow = typeof changeWaveTargets.$inferSelect;

/** The waves of a change's active plan, in index order, each with its targets — the shape
 *  `reconcileChangeOnce` walks one wave at a time. */
export async function loadWavesWithTargets(
  tx: TenantTx,
  orgId: string,
  planId: string
): Promise<{ wave: WaveRow; targets: WaveTargetRow[] }[]> {
  const waves = await tx
    .select()
    .from(changeWaves)
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.planId, planId)))
    .orderBy(changeWaves.waveIndex);

  const out: { wave: WaveRow; targets: WaveTargetRow[] }[] = [];
  for (const wave of waves) {
    const targets = await tx
      .select()
      .from(changeWaveTargets)
      .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.waveId, wave.id)))
      .orderBy(changeWaveTargets.createdAt);
    out.push({ wave, targets });
  }
  return out;
}

export async function markWaveRunning(tx: TenantTx, orgId: string, waveId: string): Promise<void> {
  await tx
    .update(changeWaves)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.id, waveId), eq(changeWaves.status, "pending")));
}

export async function markWaveTerminal(
  tx: TenantTx,
  orgId: string,
  waveId: string,
  status: "succeeded" | "failed"
): Promise<void> {
  await tx
    .update(changeWaves)
    .set({ status, completedAt: new Date() })
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.id, waveId)));
}

export interface WaveTargetTriggerUpdate {
  executorPluginId: string;
  executorRef: { externalId: string; url?: string };
  priorStateRef: unknown;
}

/**
 * The claim/record split behind CRITICAL #2's crash-safe trigger flow (PR #7 review;
 * coordination/reconcile.ts's `triggerWaveTarget` doc comment has the full three-step design):
 *
 *  1. `claimWaveTargetForTriggering` (tx A, its own commit) — flips `pending` -> `triggering`.
 *     Matches `pending` OR `triggering` in its WHERE guard so a target already `triggering` from
 *     a PRIOR attempt that crashed before reaching step 3 can be re-claimed by the same or a
 *     different tick and retried with the identical idempotencyKey, rather than getting stuck
 *     forever because it's no longer literally `pending`. Two concurrent claims (two workers, or
 *     an overlapping self-scheduled tick) still can't both "win" a `pending` target — the WHERE
 *     narrows to exactly one row and a `pending`-only claim only ever succeeds once — but this
 *     intentionally does NOT protect against calling `trigger()` twice concurrently for a target
 *     already `triggering` (there's nothing more locking to do there: that's exactly the
 *     resume-after-crash case, and it's ONLY safe because the external call this enables carries a
 *     stable idempotencyKey the executor is contractually required to dedup on).
 *  2. The caller calls `plugin.trigger(intent)` OUTSIDE any transaction.
 *  3. `markWaveTargetTriggered` (tx B, its own commit) — flips `triggering` -> `triggered` and
 *     records the executor's returned ref. Guarded on `triggering` (not `pending`) since step 1
 *     already consumed the `pending` state.
 */
export async function claimWaveTargetForTriggering(
  tx: TenantTx,
  orgId: string,
  targetId: string
): Promise<boolean> {
  const result = await tx
    .update(changeWaveTargets)
    .set({ status: "triggering", updatedAt: new Date() })
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changeWaveTargets.id, targetId),
        inArray(changeWaveTargets.status, ["pending", "triggering"])
      )
    )
    .returning({ id: changeWaveTargets.id });
  return result.length > 0;
}

/** Step 3 of the claim/record split above — records the executor's result and closes out the
 *  claim. Guarded on `status = 'triggering'` so this only ever applies to a target this same
 *  claim/trigger/record cycle actually owns. */
export async function markWaveTargetTriggered(
  tx: TenantTx,
  orgId: string,
  targetId: string,
  update: WaveTargetTriggerUpdate
): Promise<boolean> {
  const result = await tx
    .update(changeWaveTargets)
    .set({
      status: "triggered",
      executorPluginId: update.executorPluginId,
      executorRef: update.executorRef,
      priorStateRef: update.priorStateRef ?? null,
      attempt: 1,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changeWaveTargets.id, targetId),
        eq(changeWaveTargets.status, "triggering")
      )
    )
    .returning({ id: changeWaveTargets.id });
  return result.length > 0;
}

export async function updateWaveTargetObserved(
  tx: TenantTx,
  orgId: string,
  targetId: string,
  status: "observing" | "succeeded" | "failed" | "aborted"
): Promise<void> {
  await tx
    .update(changeWaveTargets)
    .set({ status, lastObservedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)));
}

/**
 * The "prior known-good state" lookup (DESIGN §9.4): the most recently SUCCEEDED wave-target
 * execution of `targetObjectId`, across ANY change (not just the one currently being planned) —
 * its `executorRef` is what a fresh forward trigger captures a `priorStateRef` snapshot from
 * (via `status()`, by the caller), and its OWN `priorStateRef` is what a rollback of THIS
 * specific change's trigger would restore.
 */
export async function findLatestSucceededExecution(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<WaveTargetRow | undefined> {
  const rows = await tx
    .select({ target: changeWaveTargets })
    .from(changeWaveTargets)
    .innerJoin(changeWaves, eq(changeWaveTargets.waveId, changeWaves.id))
    .innerJoin(changePlans, eq(changeWaves.planId, changePlans.id))
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changeWaveTargets.targetObjectId, targetObjectId),
        eq(changeWaveTargets.status, "succeeded")
      )
    )
    .orderBy(desc(changeWaveTargets.updatedAt))
    .limit(1);
  return rows[0]?.target;
}

/** The corresponding wave target for `targetObjectId` on the change that `rollbackOfObjectId`
 *  refers to's MOST RECENT plan — used by a rollback change to find what `priorStateRef` its
 *  own trigger should carry (the original's captured "before this change touched it" snapshot). */
export async function findOriginalWaveTarget(
  tx: TenantTx,
  orgId: string,
  originalChangeObjectId: string,
  targetObjectId: string
): Promise<WaveTargetRow | undefined> {
  const rows = await tx
    .select({ target: changeWaveTargets })
    .from(changeWaveTargets)
    .innerJoin(changeWaves, eq(changeWaveTargets.waveId, changeWaves.id))
    .innerJoin(changePlans, eq(changeWaves.planId, changePlans.id))
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changePlans.changeObjectId, originalChangeObjectId),
        eq(changeWaveTargets.targetObjectId, targetObjectId)
      )
    )
    .orderBy(desc(changePlans.createdAt))
    .limit(1);
  return rows[0]?.target;
}
