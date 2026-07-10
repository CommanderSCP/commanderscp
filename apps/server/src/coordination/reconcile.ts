import type PgBoss from "pg-boss";
import type { TriggerIntent } from "@scp/plugin-api";
import type { Db } from "../db/client.js";
import { orgs } from "../db/schema.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { listChangeRowsInStates, targetObjectIdsOf, type ChangeRow } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "./plan-service.js";
import {
  findLatestSucceededExecution,
  findOriginalWaveTarget,
  markWaveRunning,
  markWaveTerminal,
  tryMarkWaveTargetTriggered,
  updateWaveTargetObserved
} from "./wave-targets-repo.js";
import { evaluateWaveGate } from "./gates.js";
import { insertDecision } from "./decisions-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID } from "./executor-config.js";
import { processChangeSourceEvents } from "./webhook-processor.js";

/**
 * The resumable reconciliation loop (DESIGN.md §9.3/§9.4, BUILD_AND_TEST.md §8 M3): "pg-boss
 * workers claim due changes, run observe → compare → decide → coordinate, persist, repeat. All
 * engine state lives in Postgres; any worker resumes after a crash."
 *
 * Deliberately NOT one pg-boss job per micro-action (trigger this target / poll that target /
 * advance this change) — instead, one lightweight, idempotent, self-re-scheduling "tick" job
 * (`RECONCILE_QUEUE`) that, on every firing, re-reads ALL non-terminal changes across every org
 * straight from Postgres and does exactly the next unit of work each one is ready for. There is
 * no in-memory queue of "changes I'm working on" anywhere: every fact this loop acts on (which
 * wave is active, which targets have been triggered, what their last observed status was) is a
 * column in `changes`/`change_waves`/`change_wave_targets`. That is precisely what makes the M3
 * DoD's "kill the worker mid-wave, verify resume from Postgres state" true without any special
 * handoff/checkpoint logic: a freshly started worker's very first tick sees the exact same rows
 * the crashed worker left behind and continues from there. `tryMarkWaveTargetTriggered`'s
 * conditional UPDATE additionally makes two overlapping ticks (two replicas, or a slow tick
 * racing its own successor) safe: only one of them ever flips a given target from `pending`.
 */
export const RECONCILE_QUEUE = "coordination-reconcile-tick";
export const RECONCILE_TICK_INTERVAL_SECONDS = 1;
/** Per-state, per-tick batch cap — bounds one tick's work so a single org's huge backlog can't
 *  starve every other org's turn in the same sweep. */
const BATCH_LIMIT = 25;

type ExecutorRef = { externalId: string; url?: string };

// -------------------------------------------------------------------------------------------
// proposed -> evaluated -> coordinated -> executing: no real evaluation/coordination logic
// exists in M3 (gates.ts's seam always allows; M4 adds real policy/control evaluation here
// without changing this loop's shape) — these three edges just walk forward automatically.
// The interesting state machinery is entirely inside `advanceExecutingChanges` below.
// -------------------------------------------------------------------------------------------

async function advanceProposedChanges(tx: TenantTx, orgId: string): Promise<void> {
  const rows = await listChangeRowsInStates(tx, orgId, ["proposed"], BATCH_LIMIT);
  for (const { change } of rows) {
    await transitionChange(tx, {
      orgId,
      changeObjectId: change.objectId,
      toState: "evaluated",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: "auto: no policy/control evaluation exists before M4 — nothing blocks this edge yet"
    });
  }
}

async function advanceEvaluatedChanges(tx: TenantTx, orgId: string): Promise<void> {
  const rows = await listChangeRowsInStates(tx, orgId, ["evaluated"], BATCH_LIMIT);
  for (const { change, object } of rows) {
    const targetObjectIds = targetObjectIdsOf(object.properties as Record<string, unknown>);
    try {
      await compileAndPersistPlan(tx, {
        orgId,
        changeObjectId: change.objectId,
        targetObjectIds,
        topologyObjectId: change.topologyObjectId,
        topologyVersion: change.topologyVersion
      });
      await transitionChange(tx, {
        orgId,
        changeObjectId: change.objectId,
        toState: "coordinated",
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "reconcile",
        reason: "auto: plan compiled (waves derived from depends_on / release topology)"
      });
    } catch (err) {
      // A cycle, an unknown target, or a topology/dependency conflict (plan-compiler.ts) — M3 has
      // no "blocked" state to sit in (that's a governance/M4 concept), so an unsalvageable plan
      // auto-cancels the change with the compiler's own reason attached, rather than leaving it
      // stuck in `evaluated` forever with no path forward.
      const message = err instanceof Error ? err.message : String(err);
      await transitionChange(tx, {
        orgId,
        changeObjectId: change.objectId,
        toState: "cancelled",
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "reconcile",
        reason: `auto-cancelled: plan compilation failed — ${message}`
      });
    }
  }
}

async function advanceCoordinatedChanges(tx: TenantTx, orgId: string): Promise<void> {
  const rows = await listChangeRowsInStates(tx, orgId, ["coordinated"], BATCH_LIMIT);
  for (const { change } of rows) {
    await transitionChange(tx, {
      orgId,
      changeObjectId: change.objectId,
      toState: "executing",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: "auto: beginning wave execution"
    });
  }
}

// -------------------------------------------------------------------------------------------
// executing: the core wave-progression state machine. One wave is "active" at a time — the
// first (lowest waveIndex) wave not yet `succeeded`/`skipped`. Each tick does exactly ONE of:
// trigger a not-yet-started wave's pending targets, or poll an in-flight wave's triggered
// targets — never both in the same tick, so a slow/failing executor call can't cascade into a
// half-triggered next wave.
// -------------------------------------------------------------------------------------------

async function advanceExecutingChanges(tx: TenantTx, orgId: string, host: PluginHost): Promise<void> {
  const rows = await listChangeRowsInStates(tx, orgId, ["executing"], BATCH_LIMIT);
  for (const { change } of rows) {
    await reconcileExecutingChange(tx, orgId, change, host);
  }
}

async function reconcileExecutingChange(
  tx: TenantTx,
  orgId: string,
  change: ChangeRow,
  host: PluginHost
): Promise<void> {
  const plan = await getLatestPlanForChange(tx, orgId, change.objectId);
  if (!plan || plan.waves.length === 0) {
    // Shouldn't happen — `coordinated` never advances to `executing` without a compiled plan of
    // at least one wave (proposeChange rejects zero targets). Defensive no-op rather than a
    // throw that would abort the whole tick's transaction for every other change in this batch.
    return;
  }

  const activeWave = plan.waves.find((w) => w.status !== "succeeded" && w.status !== "skipped");

  if (!activeWave) {
    await completeExecution(tx, orgId, change);
    return;
  }

  if (activeWave.status === "failed") {
    // M3 has no automatic rollback/cancel-on-failure trigger (DESIGN §9.4 lists that as a policy
    // trigger — explicitly M4 scope). The change sits in `executing`; the watchdog's per-state
    // SLA (coordination/watchdog.ts) eventually flags it, and an operator cancels or rolls back
    // manually via the same guarded transition function everything else uses.
    return;
  }

  if (activeWave.status === "pending") {
    const gate = await evaluateWaveGate(tx, orgId, plan.topologyObjectId, activeWave.waveIndex);
    await insertDecision(tx, {
      orgId,
      kind: "gate",
      subjectId: change.objectId,
      verdict: gate.verdict,
      inputContext: { ...gate.inputContext, waveId: activeWave.id, waveIndex: activeWave.waveIndex },
      reasonTree: gate.reasonTree
    });
    if (gate.verdict === "block") return; // M3's seam always allows — kept honest for M4.

    await markWaveRunning(tx, orgId, activeWave.id);
    const isRollback = change.rollbackOfObjectId !== null;
    for (const target of activeWave.targets) {
      if (target.status !== "pending") continue;
      await triggerWaveTarget(tx, orgId, change, target.id, target.targetObjectId, isRollback, host);
    }
    return;
  }

  // activeWave.status === "running": poll every non-terminal target.
  let allTerminal = true;
  let anyFailed = false;
  for (const target of activeWave.targets) {
    if (target.status === "succeeded") continue;
    if (target.status === "failed" || target.status === "aborted") {
      anyFailed = true;
      continue;
    }
    if (!target.executorRef) {
      allTerminal = false;
      continue;
    }
    const client = host.executor(target.executorPluginId ?? DEFAULT_EXECUTOR_INSTANCE_ID);
    const status = await client.status(target.executorRef as ExecutorRef);
    if (status.phase === "succeeded") {
      await updateWaveTargetObserved(tx, orgId, target.id, "succeeded");
    } else if (status.phase === "failed" || status.phase === "aborted") {
      await updateWaveTargetObserved(tx, orgId, target.id, status.phase);
      anyFailed = true;
      await insertDecision(tx, {
        orgId,
        kind: "wave_target",
        subjectId: change.objectId,
        verdict: "block",
        inputContext: {
          waveId: activeWave.id,
          targetObjectId: target.targetObjectId,
          phase: status.phase,
          detail: status.detail ?? null
        },
        reasonTree: { summary: `wave target ${target.targetObjectId} reported '${status.phase}'` }
      });
    } else {
      await updateWaveTargetObserved(tx, orgId, target.id, "observing");
      allTerminal = false;
    }
  }

  if (!allTerminal) return; // still in flight — next tick polls again

  await markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded");
}

async function triggerWaveTarget(
  tx: TenantTx,
  orgId: string,
  change: ChangeRow,
  waveTargetId: string,
  targetObjectId: string,
  isRollback: boolean,
  host: PluginHost
): Promise<void> {
  const client = host.executor(DEFAULT_EXECUTOR_INSTANCE_ID);
  let priorStateRef: unknown = null;
  let kind: TriggerIntent["kind"];

  if (isRollback && change.rollbackOfObjectId) {
    // Restore exactly what the ORIGINAL change's trigger of this same target would have
    // reverted (DESIGN §9.4: "referencing the prior known-good executor state").
    kind = "rollback";
    const originalTarget = await findOriginalWaveTarget(tx, orgId, change.rollbackOfObjectId, targetObjectId);
    priorStateRef = originalTarget?.priorStateRef ?? null;
  } else {
    kind = "sync";
    // Snapshot the target's CURRENT executor-side state (via a fresh status() call against its
    // last successful run, not just whatever a previous poll happened to observe) before this
    // trigger supersedes it — this is the "prior known-good state" a later rollback restores.
    const latestSucceeded = await findLatestSucceededExecution(tx, orgId, targetObjectId);
    if (latestSucceeded?.executorRef) {
      const priorStatus = await client.status(latestSucceeded.executorRef as ExecutorRef);
      priorStateRef = priorStatus.stateRef ?? null;
    }
  }

  const ref = await client.trigger({ kind, targetRef: targetObjectId, priorStateRef });
  await tryMarkWaveTargetTriggered(tx, orgId, waveTargetId, {
    executorPluginId: DEFAULT_EXECUTOR_INSTANCE_ID,
    executorRef: ref,
    priorStateRef
  });
}

/** All waves of `change`'s plan have succeeded — advance past `executing`. Forward changes stop
 *  at `validating` for a human `scp change promote` (DESIGN's chain is a deliberate human gate
 *  before promotion); a ROLLBACK change (its own `rollbackOfObjectId` is set) has no equivalent
 *  human-review step to wait for — restoring known-good state doesn't need approval the way
 *  rolling new state out does — so it auto-promotes itself and then, per DESIGN §9.4 / this
 *  module's rollback.ts sibling, transitions the ORIGINAL change to `rolled_back` in the same
 *  transaction. */
async function completeExecution(tx: TenantTx, orgId: string, change: ChangeRow): Promise<void> {
  const validated = await transitionChange(tx, {
    orgId,
    changeObjectId: change.objectId,
    toState: "validating",
    actorObjectId: SYSTEM_ACTOR_ID,
    requestId: "reconcile",
    reason: "auto: every wave succeeded"
  });
  if (validated.verdict !== "allow") return;

  if (!change.rollbackOfObjectId) return; // forward change — waits for a human `scp change promote`.

  const promoted = await transitionChange(tx, {
    orgId,
    changeObjectId: change.objectId,
    toState: "promoted",
    actorObjectId: SYSTEM_ACTOR_ID,
    requestId: "reconcile",
    reason: "auto: rollback changes need no human promotion gate"
  });
  if (promoted.verdict !== "allow") return;

  await transitionChange(tx, {
    orgId,
    changeObjectId: change.rollbackOfObjectId,
    toState: "rolled_back",
    actorObjectId: SYSTEM_ACTOR_ID,
    requestId: "reconcile",
    reason: `rollback change ${change.objectId} promoted`,
    extraInputContext: { rollbackChangeObjectId: change.objectId }
  });
}

// -------------------------------------------------------------------------------------------
// pg-boss wiring
// -------------------------------------------------------------------------------------------

/** One full sweep: every org, one `reconcileOrgTick` each. Errors in one org's tick are caught
 *  and logged so they never take down the sweep (or the pg-boss job) for every other org. */
export async function runReconcileSweep(db: Db, host: PluginHost): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await withTenantTx(db, org.id, (tx) => reconcileOrgTick(tx, org.id, host));
    } catch (err) {
      console.error(`[reconcile] org ${org.id} tick failed:`, err);
    }
  }
}

export async function reconcileOrgTick(tx: TenantTx, orgId: string, host: PluginHost): Promise<void> {
  await processChangeSourceEvents(tx, orgId);
  await advanceProposedChanges(tx, orgId);
  await advanceEvaluatedChanges(tx, orgId);
  await advanceCoordinatedChanges(tx, orgId);
  await advanceExecutingChanges(tx, orgId, host);
}

export interface ReconcileLoopHandle {
  stop(): Promise<void>;
}

/**
 * Wires the self-re-scheduling tick job onto `boss` (DESIGN §9.3's "pg-boss workers claim due
 * changes... repeat"). `boss.send(..., { singletonKey, singletonSeconds })` on the re-schedule
 * step means even if two ticks somehow overlap (a slow tick + its own timer-fired successor, or
 * two worker replicas both running this loop), only one next-tick job survives the window —
 * belt-and-braces on top of `advanceExecutingChanges`'s own per-target claim safety.
 */
export async function startReconcileLoop(
  boss: PgBoss,
  db: Db,
  host: PluginHost
): Promise<ReconcileLoopHandle> {
  let stopped = false;
  await boss.createQueue(RECONCILE_QUEUE);
  await boss.work(RECONCILE_QUEUE, async () => {
    if (stopped) return;
    await runReconcileSweep(db, host);
    if (stopped) return;
    await boss.send(
      RECONCILE_QUEUE,
      {},
      {
        startAfter: RECONCILE_TICK_INTERVAL_SECONDS,
        singletonKey: "tick",
        singletonSeconds: RECONCILE_TICK_INTERVAL_SECONDS
      }
    );
  });
  await boss.send(RECONCILE_QUEUE, {});
  return {
    async stop() {
      stopped = true;
    }
  };
}
