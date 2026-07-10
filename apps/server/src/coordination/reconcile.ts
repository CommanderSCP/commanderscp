import type PgBoss from "pg-boss";
import type { TriggerIntent } from "@scp/plugin-api";
import type { Db } from "../db/client.js";
import { orgs } from "../db/schema.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { listChangeRowsInStates, markChangeReconcileBlocked, targetObjectIdsOf, type ChangeRow } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "./plan-service.js";
import {
  claimWaveTargetForTriggering,
  findLatestSucceededExecution,
  findOriginalWaveTarget,
  markWaveRunning,
  markWaveTargetTriggered,
  markWaveTerminal,
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
 * the crashed worker left behind and continues from there.
 *
 * Transaction scoping (PR #7 review, CRITICAL #2 — narrowed from the original "one tx per org per
 * tick" design): every unit of work below — one change's proposed->evaluated edge, one wave
 * target's trigger claim, one wave target's poll result — commits in its OWN short transaction,
 * opened fresh via `withTenantTx(db, ...)`. Nothing here holds one giant transaction open across
 * an entire org's batch, or across an external `plugin.trigger()`/`status()` call. That is what
 * makes a single change's (or a single plugin call's) failure isolate to that change instead of
 * rolling back every other change's already-committed progress in the same tick — see
 * `triggerWaveTarget`'s doc comment for the specific crash-safety this buys around `trigger()`.
 */
export const RECONCILE_QUEUE = "coordination-reconcile-tick";
export const RECONCILE_TICK_INTERVAL_SECONDS = 1;
/** Per-state, per-tick batch cap — bounds one tick's work so a single org's huge backlog can't
 *  starve every other org's turn in the same sweep. */
const BATCH_LIMIT = 25;

type ExecutorRef = { externalId: string; url?: string };

function logChangeError(orgId: string, change: ChangeRow, step: string, err: unknown): void {
  console.error(`[reconcile] org ${orgId} change ${change.objectId} ${step} failed (will retry next tick):`, err);
}

// -------------------------------------------------------------------------------------------
// proposed -> evaluated -> coordinated -> executing: no real evaluation/coordination logic
// exists in M3 (gates.ts's seam always allows; M4 adds real policy/control evaluation here
// without changing this loop's shape) — these three edges just walk forward automatically. Each
// change gets its own transaction and its own try/catch (CRITICAL #2 item 2) so one change's
// failure can never roll back a sibling's already-committed work in the same tick. The interesting
// state machinery is entirely inside `advanceExecutingChanges` below.
// -------------------------------------------------------------------------------------------

async function advanceProposedChanges(db: Db, orgId: string): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) => listChangeRowsInStates(tx, orgId, ["proposed"], BATCH_LIMIT));
  for (const { change } of rows) {
    try {
      await withTenantTx(db, orgId, (tx) =>
        transitionChange(tx, {
          orgId,
          changeObjectId: change.objectId,
          toState: "evaluated",
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "reconcile",
          reason: "auto: no policy/control evaluation exists before M4 — nothing blocks this edge yet"
        })
      );
    } catch (err) {
      logChangeError(orgId, change, "proposed->evaluated", err);
    }
  }
}

async function advanceEvaluatedChanges(db: Db, orgId: string): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) => listChangeRowsInStates(tx, orgId, ["evaluated"], BATCH_LIMIT));
  for (const { change, object } of rows) {
    try {
      await withTenantTx(db, orgId, async (tx) => {
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
          // A cycle, an unknown target, or a topology/dependency conflict (plan-compiler.ts) — M3
          // has no "blocked" state to sit in (that's a governance/M4 concept), so an unsalvageable
          // plan auto-cancels the change with the compiler's own reason attached, rather than
          // leaving it stuck in `evaluated` forever with no path forward. Same transaction as the
          // failed compile attempt, so either both roll back together or the cancel commits clean.
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
      });
    } catch (err) {
      logChangeError(orgId, change, "evaluated->coordinated", err);
    }
  }
}

async function advanceCoordinatedChanges(db: Db, orgId: string): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) => listChangeRowsInStates(tx, orgId, ["coordinated"], BATCH_LIMIT));
  for (const { change } of rows) {
    try {
      await withTenantTx(db, orgId, (tx) =>
        transitionChange(tx, {
          orgId,
          changeObjectId: change.objectId,
          toState: "executing",
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "reconcile",
          reason: "auto: beginning wave execution"
        })
      );
    } catch (err) {
      logChangeError(orgId, change, "coordinated->executing", err);
    }
  }
}

// -------------------------------------------------------------------------------------------
// executing: the core wave-progression state machine. One wave is "active" at a time — the
// first (lowest waveIndex) wave not yet `succeeded`/`skipped`.
// -------------------------------------------------------------------------------------------

async function advanceExecutingChanges(db: Db, orgId: string, host: PluginHost): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) => listChangeRowsInStates(tx, orgId, ["executing"], BATCH_LIMIT));
  for (const { change } of rows) {
    try {
      await reconcileExecutingChange(db, orgId, change, host);
    } catch (err) {
      logChangeError(orgId, change, "executing-advance", err);
    }
  }
}

async function reconcileExecutingChange(
  db: Db,
  orgId: string,
  change: ChangeRow,
  host: PluginHost
): Promise<void> {
  const plan = await withTenantTx(db, orgId, (tx) => getLatestPlanForChange(tx, orgId, change.objectId));
  if (!plan || plan.waves.length === 0) {
    // Shouldn't happen — `coordinated` never advances to `executing` without a compiled plan of
    // at least one wave (proposeChange rejects zero targets). Defensive no-op rather than a
    // throw that would abort processing of every other change in this batch.
    return;
  }

  const activeWave = plan.waves.find((w) => w.status !== "succeeded" && w.status !== "skipped");

  if (!activeWave) {
    await withTenantTx(db, orgId, (tx) => completeExecution(tx, orgId, change));
    return;
  }

  if (activeWave.status === "failed") {
    // MAJOR #6 (PR #7 review): M3 has no automatic rollback/cancel-on-failure trigger (DESIGN
    // §9.4 lists that as a policy trigger — explicitly M4 scope), so the change sits here
    // indefinitely awaiting an operator's manual cancel/rollback (the watchdog's per-state SLA
    // eventually flags it too). Recording that explicitly — instead of silently no-op'ing forever
    // the way this branch used to — is what lets `listChangeRowsInStates` exclude it from future
    // batches: a parked change never touches `changes.updated_at` again on its own, so under
    // oldest-updated-first batching it would otherwise sort ahead of every genuinely progressing
    // `executing` change forever once enough parked changes pile up. An operator's cancel/rollback
    // goes through `transitionChange` directly from the route handlers, never through this batch
    // listing, so parking here never blocks them from unsticking it.
    await withTenantTx(db, orgId, (tx) => markChangeReconcileBlocked(tx, orgId, change.objectId));
    return;
  }

  if (activeWave.status === "pending") {
    const gateOutcome = await withTenantTx(db, orgId, async (tx) => {
      const gate = await evaluateWaveGate(tx, orgId, plan.topologyObjectId, activeWave.waveIndex);
      await insertDecision(tx, {
        orgId,
        kind: "gate",
        subjectId: change.objectId,
        verdict: gate.verdict,
        inputContext: { ...gate.inputContext, waveId: activeWave.id, waveIndex: activeWave.waveIndex },
        reasonTree: gate.reasonTree
      });
      if (gate.verdict === "block") return "blocked" as const;
      await markWaveRunning(tx, orgId, activeWave.id);
      return "running" as const;
    });
    if (gateOutcome === "blocked") return; // M3's seam always allows — kept honest for M4.
  }

  // Unified target reconciliation: every non-terminal target gets either a trigger attempt
  // (pending, or `triggering` — a target a PRIOR tick's crash left mid-claim, see
  // `triggerWaveTarget`) or a status poll (triggered/observing), each in its own transaction and
  // its own try/catch. No longer strictly "trigger every pending target OR poll every in-flight
  // target, never both in the same tick" — now that each target's progress is its own
  // independently-committed transaction rather than one giant per-wave transaction, triggering
  // target A and polling target B in the same tick can't half-commit anything: each target's
  // durable state is exactly as fresh as its own last transaction, no more and no less.
  const isRollback = change.rollbackOfObjectId !== null;
  let allTerminal = true;
  let anyFailed = false;

  for (const target of activeWave.targets) {
    if (target.status === "succeeded") continue;
    if (target.status === "failed" || target.status === "aborted") {
      anyFailed = true;
      continue;
    }

    if (target.status === "pending" || target.status === "triggering") {
      allTerminal = false;
      try {
        await triggerWaveTarget(db, orgId, change, target.id, target.targetObjectId, isRollback, host);
      } catch (err) {
        console.error(
          `[reconcile] org ${orgId} change ${change.objectId} target ${target.targetObjectId} trigger failed (will retry next tick):`,
          err
        );
      }
      continue;
    }

    // triggered or observing: poll.
    if (!target.executorRef) {
      // Shouldn't happen (triggered/observing always carry the ref markWaveTargetTriggered set) —
      // defensive no-op; next tick will see the same state and try again.
      allTerminal = false;
      continue;
    }
    try {
      const client = host.executor(target.executorPluginId ?? DEFAULT_EXECUTOR_INSTANCE_ID);
      const status = await client.status(target.executorRef as ExecutorRef);
      if (status.phase === "succeeded") {
        await withTenantTx(db, orgId, (tx) => updateWaveTargetObserved(tx, orgId, target.id, "succeeded"));
      } else if (status.phase === "failed" || status.phase === "aborted") {
        anyFailed = true;
        const phase = status.phase;
        await withTenantTx(db, orgId, async (tx) => {
          await updateWaveTargetObserved(tx, orgId, target.id, phase);
          await insertDecision(tx, {
            orgId,
            kind: "wave_target",
            subjectId: change.objectId,
            verdict: "block",
            inputContext: {
              waveId: activeWave.id,
              targetObjectId: target.targetObjectId,
              phase,
              detail: status.detail ?? null
            },
            reasonTree: { summary: `wave target ${target.targetObjectId} reported '${phase}'` }
          });
        });
      } else {
        allTerminal = false;
        await withTenantTx(db, orgId, (tx) => updateWaveTargetObserved(tx, orgId, target.id, "observing"));
      }
    } catch (err) {
      allTerminal = false; // still in flight as far as we know — polled again next tick
      console.error(
        `[reconcile] org ${orgId} change ${change.objectId} target ${target.targetObjectId} poll failed (will retry next tick):`,
        err
      );
    }
  }

  if (!allTerminal) return; // still in flight — next tick polls/resumes again
  await withTenantTx(db, orgId, (tx) => markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded"));
}

/**
 * Triggers one wave target — the crash-safe three-step design that fixes PR #7 review CRITICAL
 * #2 ("duplicate/lost external `trigger()` calls"). The bug: the old code called
 * `plugin.trigger()` (an irreversible external side effect) and then wrote its result INTO the
 * same still-open, whole-org transaction as everything else in the tick — so any later failure in
 * that same tick rolled back the DB record of an already-fired trigger, and the next tick re-fired
 * it, with no way for the executor to tell the two calls apart.
 *
 * The fix, matching DESIGN.md §9.3's "resumable reconciliation loop" property (all engine state
 * lives in Postgres) instead of fighting it:
 *
 *   1. tx A (its own commit): claim the target — `pending`/`triggering` -> `triggering`.
 *   2. OUTSIDE any transaction: call `plugin.trigger(intent)`, carrying an `idempotencyKey`
 *      derived deterministically from the wave-target row's own id — IDENTICAL on every retry of
 *      this same target, by construction (it's just the row's id, never a freshly minted value).
 *   3. tx B (its own commit): record the returned `ExternalRunRef` — `triggering` -> `triggered`.
 *
 * If the process crashes (or this function's caller catches a thrown error) anywhere between step
 * 1's commit and step 3's commit, the target is left durably `triggering` with nothing else
 * changed. The NEXT tick that reaches this same target (via `reconcileExecutingChange`'s unified
 * loop, which treats `triggering` exactly like `pending`) re-runs this same function, re-derives
 * the SAME idempotencyKey from the SAME row id, and calls `trigger()` again. A conformant executor
 * plugin dedups on that key — returns the SAME `ExternalRunRef` without firing the automation
 * again — so this is safe to retry indefinitely, even if the FIRST call's side effect genuinely
 * did fire before the crash. `@scp/plugin-fake-executor` implements this dedup contract; M3's
 * `@scp/plugin-testkit` conformance suite is the natural home for asserting every future real
 * executor plugin honors it too (tracked as M7 scope, when the first real executor plugin ships).
 */
async function triggerWaveTarget(
  db: Db,
  orgId: string,
  change: ChangeRow,
  waveTargetId: string,
  targetObjectId: string,
  isRollback: boolean,
  host: PluginHost
): Promise<void> {
  const client = host.executor(DEFAULT_EXECUTOR_INSTANCE_ID);
  // Deterministic across every retry of this exact wave target — no separate storage needed, the
  // row's own id already satisfies "IDENTICAL across retries of the same target."
  const idempotencyKey = waveTargetId;

  const claim = await withTenantTx(db, orgId, async (tx) => {
    let kind: TriggerIntent["kind"];
    let priorStateRef: unknown = null;

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
      // Recomputed fresh on every retry (including a post-crash resume) rather than persisted:
      // since this target is still `triggering`/`pending` (not `succeeded`), it can never be its
      // OWN "latest succeeded execution", so recomputation is stable/idempotent across retries.
      const latestSucceeded = await findLatestSucceededExecution(tx, orgId, targetObjectId);
      if (latestSucceeded?.executorRef) {
        const priorStatus = await client.status(latestSucceeded.executorRef as ExecutorRef);
        priorStateRef = priorStatus.stateRef ?? null;
      }
    }

    const claimed = await claimWaveTargetForTriggering(tx, orgId, waveTargetId);
    return claimed ? { kind, priorStateRef } : null;
  });

  if (!claim) return; // no longer pending/triggering — another tick/worker already handled it.

  // Step 2 — OUTSIDE any open transaction, on purpose (see doc comment above).
  const ref = await client.trigger({
    kind: claim.kind,
    targetRef: targetObjectId,
    priorStateRef: claim.priorStateRef,
    idempotencyKey
  });

  await withTenantTx(db, orgId, (tx) =>
    markWaveTargetTriggered(tx, orgId, waveTargetId, {
      executorPluginId: DEFAULT_EXECUTOR_INSTANCE_ID,
      executorRef: ref,
      priorStateRef: claim.priorStateRef
    })
  );
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
      await reconcileOrgTick(db, org.id, host);
    } catch (err) {
      console.error(`[reconcile] org ${org.id} tick failed:`, err);
    }
  }
}

/**
 * One org's tick. Each step below opens its own transaction(s) — see the module doc comment for
 * why this no longer wraps the whole tick in one `withTenantTx` the way it used to (PR #7 review,
 * CRITICAL #2). `processChangeSourceEvents` is pure DB work (correlation matching + proposing
 * Changes — no external plugin calls), so it keeps its single-transaction-per-tick shape; it's
 * still wrapped in try/catch here so one bad webhook row can never take down the rest of the tick.
 */
export async function reconcileOrgTick(db: Db, orgId: string, host: PluginHost): Promise<void> {
  try {
    await withTenantTx(db, orgId, (tx) => processChangeSourceEvents(tx, orgId));
  } catch (err) {
    console.error(`[reconcile] org ${orgId} change-source-event processing failed:`, err);
  }
  await advanceProposedChanges(db, orgId);
  await advanceEvaluatedChanges(db, orgId);
  await advanceCoordinatedChanges(db, orgId);
  await advanceExecutingChanges(db, orgId, host);
}

export interface ReconcileLoopHandle {
  stop(): Promise<void>;
}

/**
 * Wires the self-re-scheduling tick job onto `boss` (DESIGN §9.3's "pg-boss workers claim due
 * changes... repeat"). `boss.send(..., { singletonKey, singletonSeconds })` on the re-schedule
 * step means even if two ticks somehow overlap (a slow tick + its own timer-fired successor, or
 * two worker replicas both running this loop), only one next-tick job survives the window —
 * belt-and-braces on top of the per-target claim safety in `claimWaveTargetForTriggering`.
 *
 * `stop()` tracks whichever tick is currently in flight and awaits it before resolving — setting
 * `stopped` alone only prevents a NEW tick from starting; without also draining an
 * ALREADY-RUNNING one, a caller that closes `db`'s pool right after `stop()` resolves (main.ts's
 * onClose hook; test-support/harness.ts's `close()`) can race an in-flight tick's own queries
 * against a torn-down pool. This also matters for test isolation: a straggling tick from one
 * `listenTestServer` instance that outlives its own test can otherwise still be executing when the
 * NEXT test's server starts — and since `runReconcileSweep` sweeps every org unconditionally, that
 * straggler can reach into a completely different test's org and race its own claims.
 */
export async function startReconcileLoop(
  boss: PgBoss,
  db: Db,
  host: PluginHost
): Promise<ReconcileLoopHandle> {
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(RECONCILE_QUEUE);
  await boss.work(RECONCILE_QUEUE, async () => {
    if (stopped) return;
    const tick = runReconcileSweep(db, host);
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
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
      await inFlightTick;
    }
  };
}
