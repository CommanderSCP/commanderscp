import { and, desc, eq } from "drizzle-orm";
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

/** Claims a `pending` target for triggering — `FOR UPDATE SKIP LOCKED`-style single-row claim via
 *  the `status = 'pending'` guard in the WHERE clause, so two concurrent reconcile ticks (two
 *  workers, or an overlapping self-scheduled tick) can never both trigger the same target: only
 *  the first UPDATE's WHERE actually matches, the second affects zero rows and its caller no-ops. */
export async function tryMarkWaveTargetTriggered(
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
        eq(changeWaveTargets.status, "pending")
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
