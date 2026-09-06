import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineHooks } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { resolveExecutorPluginInstance } from "./executor-bindings-repo.js";
import { listPlacementsForComponents } from "../graph/placements-repo.js";
import { HOOK_RUN_EXECUTOR_LANE, HOOK_RUN_EXECUTOR_TYPE } from "./pipeline-hook-runs.js";
import {
  completeProbeRetraction,
  listPendingProbeRetractions,
  probeScheduleId,
  recordProbeRetractionFailure
} from "./continuous-probe-retractions-repo.js";

/** OUTPOST-RUN CONTINUOUS PROBES. See docs/coordination/continuous-probe-driver.md §1. */

/** Correlation stamped on every run the schedule spawns, so `observe()` can map a result back to
 *  the hook that asked for it. Read by the evidence path; never inferred from a workflow name. */
export function probeLabels(
  componentObjectId: string,
  targetObjectId: string,
  hookId: string
): Record<string, string> {
  return {
    "commanderscp.io/hook-id": hookId,
    "commanderscp.io/component": componentObjectId,
    "commanderscp.io/target": targetObjectId
  };
}

export interface ProbeDriverContext {
  orgId: string;
  host: PluginHost;
  masterKey: Buffer;
}

/** THE RETRACTION SWEEP. See docs/coordination/continuous-probe-driver.md §2. */
async function retractDeletedProbeSchedules(db: Db, ctx: ProbeDriverContext): Promise<number> {
  const pending = await withTenantTx(db, ctx.orgId, (tx) =>
    listPendingProbeRetractions(tx, ctx.orgId)
  );
  if (pending.length === 0) return 0;

  let retracted = 0;
  for (const entry of pending) {
    try {
      const placements = await withTenantTx(db, ctx.orgId, (tx) =>
        listPlacementsForComponents(tx, ctx.orgId, [entry.componentObjectId])
      );
      for (const placement of placements) {
        const resolved = await withTenantTx(db, ctx.orgId, (tx) =>
          resolveExecutorPluginInstance(tx, {
            orgId: ctx.orgId,
            targetObjectId: placement.placementId,
            masterKey: ctx.masterKey,
            type: HOOK_RUN_EXECUTOR_TYPE,
            lane: HOOK_RUN_EXECUTOR_LANE
          })
        );
        if (!resolved) continue;
        await ctx.host.start([resolved.instanceConfig]);
        const executor = ctx.host.executor(resolved.instanceConfig.id);
        // Capability-gated exactly like the declaration: an executor that never held a schedule has
        // nothing to retract, and calling an absent verb would throw instead of being a no-op.
        if (!executor.removeSchedule) continue;
        await executor.removeSchedule(entry.scheduleId);
        retracted += 1;
      }
      await withTenantTx(db, ctx.orgId, (tx) => completeProbeRetraction(tx, ctx.orgId, entry.id));
    } catch (err) {
      // PER ENTRY, matching the declaration loop: one unreachable executor must not stop the other
      // retractions in this org.
      console.error(
        `[probe-driver] org ${ctx.orgId} hook ${entry.hookId}: removeSchedule failed:`,
        err
      );
      await withTenantTx(db, ctx.orgId, (tx) =>
        recordProbeRetractionFailure(tx, ctx.orgId, entry.id, String(err))
      );
    }
  }
  return retracted;
}

/**
 * Declares every `continuous` hook's schedule to the executor that will run it, having first
 * retracted the schedules of the hooks that have been deleted since the last tick.
 *
 * RETRACTIONS FIRST, and the order is load-bearing: a hook deleted and re-declared between two
 * ticks must end up DECLARED, so the retraction has to be the one that gets overwritten.
 *
 * INERT WHEN NOTHING IS DECLARED: two indexed reads return no rows and this does nothing, so an
 * org with no probes — nearly every org — pays two queries per tick.
 *
 * The return value stays the DECLARED count. Retractions are logged, not counted, because the only
 * caller (`reconcile.ts`) reads neither and a two-number return would invite one of them to be
 * silently ignored.
 */
export async function ensureContinuousProbesScheduled(
  db: Db,
  ctx: ProbeDriverContext
): Promise<number> {
  // BEFORE the live-hook read and OUTSIDE its early return: an org whose ONLY continuous hook was
  // just deleted has zero live rows and is exactly the org with a retraction owed.
  await retractDeletedProbeSchedules(db, ctx);

  const hooks = await withTenantTx(db, ctx.orgId, (tx) =>
    tx
      .select()
      .from(pipelineHooks)
      .where(and(eq(pipelineHooks.orgId, ctx.orgId), eq(pipelineHooks.kind, "continuous")))
  );
  if (hooks.length === 0) return 0;

  let declared = 0;
  for (const hook of hooks) {
    // A probe with no cadence is not a schedule — the column is nullable because four kinds share
    // one table, and Zod closes the per-kind shape at the write door. Skipped rather than defaulted
    // to a number nobody declared.
    if (hook.everySeconds === null) continue;
    const workflow = hook.workflow as { templateName?: string; path?: string } | null;
    const targetRef = workflow?.templateName ?? workflow?.path;
    if (!targetRef) continue;

    // WHICH TARGETS this hook covers. See docs/coordination/continuous-probe-driver.md §3.
    const placements = await withTenantTx(db, ctx.orgId, (tx) =>
      listPlacementsForComponents(tx, ctx.orgId, [hook.componentObjectId])
    );
    for (const placement of placements) {
      const subject = {
        componentObjectId: placement.componentObjectId,
        targetObjectId: placement.placementId
      };
      try {
        const resolved = await withTenantTx(db, ctx.orgId, (tx) =>
          resolveExecutorPluginInstance(tx, {
            orgId: ctx.orgId,
            targetObjectId: subject.targetObjectId,
            masterKey: ctx.masterKey,
            type: HOOK_RUN_EXECUTOR_TYPE,
            // Same lane a hook RUN dispatches on, so a probe and the tests it gates land on the
            // same executor. Resolving them differently would be a split nobody could see.
            lane: HOOK_RUN_EXECUTOR_LANE
          })
        );
        if (!resolved) continue;
        await ctx.host.start([resolved.instanceConfig]);
        const executor = ctx.host.executor(resolved.instanceConfig.id);
        // CAPABILITY-GATED. `ensureSchedule` is optional on the contract, so an executor that has
        // no notion of a recurring declaration is skipped rather than called and thrown at. Absent
        // means "declares no schedule capability", never "capable by default".
        if (!executor.ensureSchedule) continue;
        await executor.ensureSchedule({
          scheduleId: probeScheduleId(hook.componentObjectId, hook.hookId),
          targetRef,
          cadenceSeconds: hook.everySeconds,
          labels: probeLabels(hook.componentObjectId, subject.targetObjectId, hook.hookId)
        });
        declared += 1;
      } catch (err) {
        // PER SUBJECT, matching the poll and the trigger sweep: one unreachable executor must not
        // stop the other probes in this org from being declared, and a failure here is retried next
        // tick, which is the convergence every other part of this loop relies on.
        console.error(
          `[probe-driver] org ${ctx.orgId} hook ${hook.hookId} target ${subject.targetObjectId}: ensureSchedule failed:`,
          err
        );
      }
    }
  }
  return declared;
}
