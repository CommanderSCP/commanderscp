import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineHooks } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { resolveExecutorPluginInstance } from "./executor-bindings-repo.js";
import { listPlacementsForComponents } from "../graph/placements-repo.js";
import { HOOK_RUN_EXECUTOR_LANE, HOOK_RUN_EXECUTOR_TYPE } from "./pipeline-hook-runs.js";

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
 */

/** The schedule id a hook owns in the executor. Derived, never stored: the same inputs must
 *  produce the same id on every tick and in every replica, or a re-declaration would create a
 *  second schedule beside the first instead of updating it. */
export function probeScheduleId(componentObjectId: string, hookId: string): string {
  // Executor resource names are DNS-ish; the component uuid plus a sanitized hook id keeps this
  // unique per (component, hook) without depending on the hook id being safe on its own.
  const safeHook = hookId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40);
  return `scp-probe-${componentObjectId.slice(0, 8)}-${safeHook}`;
}

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
 * Declares every `continuous` hook's schedule to the executor that will run it.
 *
 * INERT WHEN NOTHING IS DECLARED: one indexed read returns no rows and this does nothing, so an
 * org with no probes — nearly every org — pays a single query per tick.
 */
export async function ensureContinuousProbesScheduled(
  db: Db,
  ctx: ProbeDriverContext
): Promise<number> {
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
