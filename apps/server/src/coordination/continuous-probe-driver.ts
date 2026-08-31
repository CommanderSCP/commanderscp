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

/**
 * OUTPOST-RUN CONTINUOUS PROBES — the domain holds the schedule until told otherwise.
 *
 * ============================================================================================
 * WHY THIS RUNS AT THE OUTPOST AND NOT THE COMMANDER
 * ============================================================================================
 * The commander cannot run a probe: it does not reach into a domain, and the digest-pinned test
 * bundle D23 requires lives in the DOMAIN's own Gitea. So the commander declares WHAT to probe
 * (`pipeline_hook_upsert`, journalled down), the domain holds the schedule in its own Argo
 * Workflows, and results journal back up as `peer_reported` evidence. Owner decision, 2026-08-28.
 *
 * ============================================================================================
 * SCP DOES NOT TICK THE SCHEDULE, AND THAT IS NOT A DETAIL
 * ============================================================================================
 * `everySeconds` is DESCRIPTIVE in three places — `ManifestContinuousHookSchema`,
 * `pipelineHooks.everySeconds`, migration 0096 — all saying Argo runs the cron and SCP does not
 * schedule it. This driver honours that: it DECLARES a cadence to the executor once per tick and
 * the executor's own scheduler runs it. It never fires a probe itself, which is the difference
 * between coordinating a schedule and being one.
 *
 * ============================================================================================
 * RE-DECLARED EVERY TICK, DELIBERATELY
 * ============================================================================================
 * `ensureSchedule` is idempotent by `scheduleId`, so re-declaring costs one call and changes
 * nothing. That is the point: a schedule an operator deleted out-of-band, or one lost when the
 * executor was rebuilt, is RESTORED on the next tick. "Until they hear otherwise" is only worth
 * anything if the declaration is actively maintained rather than fired once and assumed.
 *
 * A hook the commander RETRACTS stops being declared because the row is gone (the tombstone
 * deleted it), and the schedule is removed by the retraction sweep below rather than expiring.
 *
 * THAT SWEEP DID NOT EXIST until migration 0111, and the sentence above was the only thing that
 * said it did. `removeSchedule` was implemented on the contract, routed by the plugin-host RPC, and
 * implemented by both the Argo Workflows plugin and the test fake — with no application caller
 * anywhere, so every retracted probe left its cron running on the executor indefinitely. It runs
 * FIRST, ahead of the declarations, so a hook deleted and re-created between two ticks is retracted
 * and then immediately re-declared rather than the other way round.
 */

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

/**
 * THE RETRACTION SWEEP. Removes the schedule of every `continuous` hook that has been deleted since
 * the last tick, from the executor of every placement the hook's component still has.
 *
 * IT CANNOT BE DERIVED FROM THE LIVE ROWS, which is why migration 0111's queue exists rather than a
 * diff: the hook row is gone, `probeScheduleId` needs the hook's identity to name what to retract,
 * and the contract has no `listSchedules` to ask the executor what it is holding. So the delete
 * records the debt and this pays it.
 *
 * FAILURE LEAVES THE ROW PENDING, deliberately, unlike `config_source_sync_queue`'s drain which
 * marks a failed item processed. An undrained sync makes the graph stale; an undrained retraction
 * leaves a cron running against a domain, so retrying every tick is the cheaper wrong answer.
 *
 * THE ONE CASE IT CANNOT REACH, stated rather than hidden: a component whose placements are ALL
 * gone has no binding to resolve an executor from, so there is no executor left to address and the
 * debt is dropped. Deleting the component that owned a probe therefore relies on the same apply
 * having pruned the hook first, which is the order `plans-repo.ts` prunes in.
 */
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

    // WHICH TARGETS this hook covers. A continuous hook holds per TARGET (that is what the hold is
    // keyed on), so one declaration per placement rather than one per component.
    //
    // THE PLACEMENT IS THE TARGET, and this is worth stating because the first version got it
    // backwards: it passed the COMPONENT id to `resolveHookSubjects`, which takes TARGET ids and
    // returned nothing, so the driver declared no schedules at all and failed silently — every
    // hook skipped, no error anywhere. `listPlacementsForComponents` is the direction that exists.
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
