import type PgBoss from "pg-boss";
import type { TriggerIntent } from "@scp/plugin-api";
import type { Db } from "../db/client.js";
import { orgs } from "../db/schema.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import type { GateDeps } from "./gates.js";
import {
  getChangeRow,
  listChangeRowsInStates,
  markChangeReconcileBlocked,
  targetObjectIdsOf,
  type ChangeRow
} from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { triggerRollback } from "./rollback.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "./plan-service.js";
import {
  claimWaveTargetForTriggering,
  findLatestSucceededExecution,
  findOriginalWaveTarget,
  getWaveStatus,
  markWaveRunning,
  markWaveTargetTriggered,
  markWaveTerminal,
  updateWaveTargetObserved
} from "./wave-targets-repo.js";
import { tryAcquireTriggerClaimLock } from "./trigger-claim-lock.js";
import { tryAcquireChangeCoordinationLock } from "./change-coordination-lock.js";
import { evaluateWaveGate } from "./gates.js";
import { insertDecision } from "./decisions-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID, DEFAULT_EXECUTOR_MODULE } from "./executor-config.js";
import {
  getExecutorBinding,
  resolveExecutorPluginInstance,
  DEFAULT_BINDING_PURPOSE
} from "./executor-bindings-repo.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { matchPoliciesForTargets } from "../governance/policy-resolve.js";
import { resolvePolicies } from "../governance/policy-model.js";
import { prewarmGovernanceForChange } from "../governance/gate-orchestrator.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";

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
  console.error(
    `[reconcile] org ${orgId} change ${change.objectId} ${step} failed (will retry next tick):`,
    err
  );
}

// -------------------------------------------------------------------------------------------
// proposed -> evaluated -> coordinated -> executing: no real evaluation/coordination logic
// exists in M3 (gates.ts's seam always allows; M4 adds real policy/control evaluation here
// without changing this loop's shape) — these three edges just walk forward automatically. Each
// change gets its own transaction and its own try/catch (CRITICAL #2 item 2) so one change's
// failure can never roll back a sibling's already-committed work in the same tick. The interesting
// state machinery is entirely inside `advanceExecutingChanges` below.
// -------------------------------------------------------------------------------------------

/**
 * MULTI-REPLICA consistency (M8 hardening audit): `transitionChange`'s own row-level `FOR UPDATE`
 * already makes a concurrent race here SAFE (the loser's transition throws a plain fromState-
 * mismatch error, caught below and just logged — no compile-then-cancel-style harmful fallback
 * exists on this edge). The lock is added anyway for the same reason `advanceEvaluatedChanges`
 * needs one and `advanceCoordinatedChanges` gets one too: without it, two racing replicas both do
 * the full transition attempt and one throws every time two ticks overlap on the same change —
 * wasted work and confusing "failed" log lines for something that isn't actually a failure. One
 * coherent multi-replica story: every change is single-flight per tick, everywhere in this file.
 */
async function advanceProposedChanges(db: Db, orgId: string, gateDeps: GateDeps): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["proposed"], BATCH_LIMIT)
  );
  for (const { change } of rows) {
    const lock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!lock) continue;
    try {
      await withTenantTx(db, orgId, (tx) =>
        transitionChange(
          tx,
          {
            orgId,
            changeObjectId: change.objectId,
            toState: "evaluated",
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "reconcile",
            reason:
              "auto: proposed->evaluated is not governance-gated (M4 — coordination/gates.ts's module doc)"
          },
          gateDeps
        )
      );
    } catch (err) {
      logChangeError(orgId, change, "proposed->evaluated", err);
    } finally {
      await lock.release();
    }
  }
}

/**
 * MULTI-REPLICA SINGLE-FLIGHT (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6): every unit of
 * work below is wrapped in `change-coordination-lock.ts`'s advisory lock, keyed by
 * `changeObjectId`, acquired BEFORE compiling a plan or transitioning anything. This closes a
 * genuine race found while proving the (separately fixed) wave-target trigger claim's
 * single-flight guarantee under real multi-replica concurrency: two worker replicas' overlapping
 * ticks could both observe the SAME change as `evaluated` (via the batch read above, taken
 * outside any lock) and both call `compileAndPersistPlan` before either committed its
 * `evaluated -> coordinated` transition. The loser's transition used to throw (fromState
 * mismatch), get caught, and fall back to `transitionChange(..., "cancelled")` IN THE SAME
 * transaction as its own already-inserted plan rows — since `coordinated -> cancelled` is a
 * legal edge, that fallback SUCCEEDED, committing a fully-persisted DUPLICATE
 * `change_waves`/`change_wave_targets` plan set and wrongfully cancelling a change the winner had
 * already legitimately coordinated (confirmed against a real Postgres via a deliberate
 * 2-concurrent-tick race while investigating this).
 *
 * The lock makes this structurally impossible rather than detecting it after the fact: only ONE
 * process anywhere can be inside the locked section for a given change at any instant, so by the
 * time ANY holder re-reads the change's state fresh (immediately below, still under the lock),
 * "another attempt is genuinely racing me right now" is already ruled out. If that fresh read
 * shows the change is no longer `evaluated` (a DIFFERENT tick got there first, in the window
 * between the batch read and this lock's acquisition, and has SINCE finished — released the lock
 * — successfully or not), that is a clean "lost the race, someone else already handled it" no-op
 * — never treated as a compilation failure, so never wrongfully cancelled.
 */
async function advanceEvaluatedChanges(db: Db, orgId: string, gateDeps: GateDeps): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["evaluated"], BATCH_LIMIT)
  );
  for (const { change, object } of rows) {
    const lock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!lock) continue; // another tick/replica is genuinely working on this change right now.
    try {
      await withTenantTx(db, orgId, async (tx) => {
        // Fresh re-check, still under the lock — see the doc comment above for why this is the
        // "lost the race" no-op path, not a failure.
        const current = await getChangeRow(tx, orgId, change.objectId);
        if (current.state !== "evaluated") return;

        const targetObjectIds = targetObjectIdsOf(object.properties as Record<string, unknown>);
        try {
          await compileAndPersistPlan(tx, {
            orgId,
            changeObjectId: change.objectId,
            targetObjectIds,
            topologyObjectId: change.topologyObjectId,
            topologyVersion: change.topologyVersion
          });
          await transitionChange(
            tx,
            {
              orgId,
              changeObjectId: change.objectId,
              toState: "coordinated",
              actorObjectId: SYSTEM_ACTOR_ID,
              requestId: "reconcile",
              reason: "auto: plan compiled (waves derived from depends_on / release topology)"
            },
            gateDeps
          );
        } catch (err) {
          // A cycle, an unknown target, or a topology/dependency conflict (plan-compiler.ts)
          // auto-cancels the change with the compiler's own reason attached, rather than leaving
          // it stuck in `evaluated` forever with no path forward. Same transaction as the failed
          // compile attempt, so either both roll back together or the cancel commits clean. Safe
          // to treat any error here as a genuine compilation failure — the lock above already
          // ruled out "lost a concurrent race" as the cause.
          const message = err instanceof Error ? err.message : String(err);
          await transitionChange(
            tx,
            {
              orgId,
              changeObjectId: change.objectId,
              toState: "cancelled",
              actorObjectId: SYSTEM_ACTOR_ID,
              requestId: "reconcile",
              reason: `auto-cancelled: plan compilation failed — ${message}`
            },
            gateDeps
          );
        }
      });
    } catch (err) {
      logChangeError(orgId, change, "evaluated->coordinated", err);
    } finally {
      await lock.release();
    }
  }
}

/** Same consistency lock as `advanceProposedChanges` — see its doc comment. */
async function advanceCoordinatedChanges(db: Db, orgId: string, gateDeps: GateDeps): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["coordinated"], BATCH_LIMIT)
  );
  for (const { change } of rows) {
    const lock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!lock) continue;
    try {
      await withTenantTx(db, orgId, (tx) =>
        transitionChange(
          tx,
          {
            orgId,
            changeObjectId: change.objectId,
            toState: "executing",
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "reconcile",
            reason: "auto: beginning wave execution"
          },
          gateDeps
        )
      );
    } catch (err) {
      logChangeError(orgId, change, "coordinated->executing", err);
    } finally {
      await lock.release();
    }
  }
}

// -------------------------------------------------------------------------------------------
// validating: no state transition happens here automatically (that edge is human-only —
// coordination/gates.ts's module doc) — but a required control referenced by a policy bound to
// the `validating->promoted` edge needs to actually RUN somewhere, and the promote route itself
// is host-less (DESIGN §16's api/worker split). This is that "somewhere": every tick, ensure
// every fired policy's required controls have a fresh outcome and every requireApprovals effect
// has a materialized approval_requests row, so a human's `scp change promote` — and `GET
// /approvals` — see up-to-date state without ever needing this process to hold a live PluginHost.
// -------------------------------------------------------------------------------------------

async function advanceValidatingChanges(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["validating"], BATCH_LIMIT)
  );
  for (const { change, object } of rows) {
    try {
      const targetObjectIds = targetObjectIdsOf(object.properties as Record<string, unknown>);
      if (targetObjectIds.length === 0) continue;
      await withTenantTx(db, orgId, (tx) =>
        prewarmGovernanceForChange(tx, sandbox, host, {
          orgId,
          changeObjectId: change.objectId,
          targetObjectIds,
          actorObjectId: SYSTEM_ACTOR_ID
        })
      );
    } catch (err) {
      logChangeError(orgId, change, "validating-governance-prewarm", err);
    }
  }
}

// -------------------------------------------------------------------------------------------
// executing: the core wave-progression state machine. One wave is "active" at a time — the
// first (lowest waveIndex) wave not yet `succeeded`/`skipped`.
// -------------------------------------------------------------------------------------------

async function advanceExecutingChanges(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["executing"], BATCH_LIMIT)
  );
  for (const { change } of rows) {
    try {
      await reconcileExecutingChange(db, orgId, change, host, sandbox, masterKey);
    } catch (err) {
      logChangeError(orgId, change, "executing-advance", err);
    }
  }
}

async function reconcileExecutingChange(
  db: Db,
  orgId: string,
  change: ChangeRow,
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<void> {
  const gateDeps: GateDeps = { sandbox, host };
  const plan = await withTenantTx(db, orgId, (tx) =>
    getLatestPlanForChange(tx, orgId, change.objectId)
  );
  if (!plan || plan.waves.length === 0) {
    // Shouldn't happen — `coordinated` never advances to `executing` without a compiled plan of
    // at least one wave (proposeChange rejects zero targets). Defensive no-op rather than a
    // throw that would abort processing of every other change in this batch.
    return;
  }

  const activeWave = plan.waves.find((w) => w.status !== "succeeded" && w.status !== "skipped");

  if (!activeWave) {
    await withTenantTx(db, orgId, (tx) => completeExecution(tx, orgId, change, gateDeps));
    return;
  }

  if (activeWave.status === "failed") {
    // MAJOR #6 (PR #7 review) / M4 (BUILD_AND_TEST.md §8 "automatic rollback triggers on gate/
    // control failure now become real"): whether a failed wave auto-rolls-back or parks for a
    // manual `scp change rollback` is now a POLICY CONFIGURATION (DESIGN §9.4's own framing —
    // "Human-assisted / fully-automated / emergency-override are all just policy configs"), not a
    // fixed engine behavior. A failed wave's targets are re-resolved against the policy engine
    // for an `autoRollbackOnFailure: true` effective policy (policy-model.ts); if one fires, this
    // triggers the SAME `triggerRollback` a human's `POST /changes/{id}/rollback` call does — one
    // rollback per original change, guarded against re-triggering by checking for an existing
    // non-terminal rollback of this change first (an idempotent-in-effect check, not a DB unique
    // constraint, since a change can legitimately be rolled back more than once across its
    // lifetime — just never twice for the SAME failure without the first attempt having already
    // resolved). No qualifying policy -> unchanged M3 behavior: park for a human.
    //
    // A ROLLBACK change's OWN wave failing is deliberately EXEMPT from this — the same "no
    // automatic caller could ever satisfy it" reasoning coordination/gates.ts's `isRollback`
    // check documents for the validating->promoted edge applies here too, just for a different
    // failure mode: an `autoRollbackOnFailure` policy scoped to a target whose rollback ALSO
    // fails (a target broken enough that even restoring prior state doesn't work) would otherwise
    // recurse — trigger a rollback-of-the-rollback, whose own wave targets the SAME broken
    // target, fails the SAME way, and triggers a rollback-of-that, forever. A rollback change's
    // failed wave always just parks for a human, exactly like "no qualifying policy" below.
    const failedWaveTargetIds = activeWave.targets.map((t) => t.targetObjectId);
    const autoRollback =
      change.rollbackOfObjectId === null &&
      (await withTenantTx(db, orgId, (tx) =>
        shouldAutoRollback(tx, orgId, failedWaveTargetIds, change.objectId)
      ));
    if (autoRollback) {
      try {
        await withTenantTx(db, orgId, (tx) =>
          triggerRollback(tx, {
            orgId,
            originalChangeObjectId: change.objectId,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "reconcile",
            reason: `automatic: wave ${activeWave.waveIndex} failed and an autoRollbackOnFailure policy applies`,
            trigger: "automatic"
          })
        );
      } catch (err) {
        logChangeError(orgId, change, "auto-rollback-trigger", err);
      }
    }
    await withTenantTx(db, orgId, (tx) => markChangeReconcileBlocked(tx, orgId, change.objectId));
    return;
  }

  if (activeWave.status === "pending") {
    // MULTI-REPLICA SINGLE-FLIGHT (M8 hardening follow-up, adversarial review MINOR #5): the SAME
    // per-change advisory lock advanceProposedChanges/advanceEvaluatedChanges/
    // advanceCoordinatedChanges/triggerWaveTarget already use — see change-coordination-lock.ts's
    // doc comment for the underlying mechanism. Without it, two concurrent replica ticks that both
    // read this wave as "pending" (the batch read in advanceExecutingChanges, taken outside any
    // lock, one call up the stack) both call evaluateWaveGate + insertDecision here, producing a
    // duplicate audit Decision row for the same gate evaluation — the 4th multi-replica race found
    // during this coordination-races audit (bounded: markWaveRunning's own `WHERE status =
    // 'pending'` guard means no double-execution results, and triggering itself is already
    // single-flight via the trigger-claim lock — this closes the remaining "duplicate Decision"
    // race for one coherent single-flight story across all four).
    const gateLock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!gateLock) return; // another tick/replica is genuinely evaluating this wave's gate right now — retry next tick.
    let gateOutcome: "blocked" | "running" | "already-progressed";
    try {
      gateOutcome = await withTenantTx(db, orgId, async (tx) => {
        // Fresh re-check, still under the lock — a racing tick may have already evaluated this
        // wave's gate and advanced it (running, or further) in the window between the batch read
        // in advanceExecutingChanges and this lock's acquisition. Re-running the gate here would
        // insert a SECOND Decision for the same wave — this is the "lost the race" no-op, not a
        // re-evaluation, exactly like advanceEvaluatedChanges's fresh re-check above.
        const freshStatus = await getWaveStatus(tx, orgId, activeWave.id);
        if (freshStatus !== "pending") return "already-progressed" as const;

        const gate = await evaluateWaveGate(
          tx,
          {
            orgId,
            changeObjectId: change.objectId,
            actorObjectId: SYSTEM_ACTOR_ID,
            emergency: change.emergency,
            topologyObjectId: plan.topologyObjectId,
            waveIndex: activeWave.waveIndex,
            targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
          },
          gateDeps
        );
        await insertDecision(tx, {
          orgId,
          kind: "gate",
          subjectId: change.objectId,
          verdict: gate.verdict,
          inputContext: {
            ...gate.inputContext,
            waveId: activeWave.id,
            waveIndex: activeWave.waveIndex
          },
          reasonTree: gate.reasonTree
        });
        if (gate.verdict === "block") return "blocked" as const;
        await markWaveRunning(tx, orgId, activeWave.id);
        return "running" as const;
      });
    } finally {
      await gateLock.release();
    }
    // "blocked": M3's seam always allows — kept honest for M4. "already-progressed": a racing
    // tick already handled this wave's gate; next tick sees its result and proceeds normally.
    if (gateOutcome !== "running") return;
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
        await triggerWaveTarget(
          db,
          orgId,
          change,
          target.id,
          target.targetObjectId,
          // WHICH pipeline this target rolls (M12 P4A) — snapshotted onto the wave target at plan
          // time from the change's source mapping. This is what finally makes an `infra` binding
          // triggerable; before P4A reconcile hardcoded 'software'.
          (target.purpose as "infra" | "software" | null) ?? DEFAULT_BINDING_PURPOSE,
          isRollback,
          host,
          masterKey
        );
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
      const instanceId = await ensureExecutorInstanceStarted(
        db,
        orgId,
        host,
        target.targetObjectId,
        // The status poll must address the SAME instance the trigger used, so it resolves the same
        // purpose — otherwise it would poll the software pipeline for an infra run's ref.
        (target.purpose as "infra" | "software" | null) ?? DEFAULT_BINDING_PURPOSE,
        target.executorPluginId ?? null,
        masterKey
      );
      const client = host.executor(instanceId);
      const status = await client.status(target.executorRef as ExecutorRef);
      if (status.phase === "succeeded") {
        await withTenantTx(db, orgId, (tx) =>
          updateWaveTargetObserved(tx, orgId, target.id, "succeeded")
        );
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
        await withTenantTx(db, orgId, (tx) =>
          updateWaveTargetObserved(tx, orgId, target.id, "observing")
        );
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
  await withTenantTx(db, orgId, (tx) =>
    markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded")
  );
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
 *
 * MULTI-REPLICA SINGLE-FLIGHT (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6): the three steps
 * above are wrapped, start to finish, in `trigger-claim-lock.ts`'s Postgres advisory lock — see
 * that module's doc comment for the full "why" (short version: a Helm-scaled `worker` replica has
 * no shared view of another replica's in-flight work, so the claim/status column alone cannot
 * distinguish "abandoned by a crash" from "another replica is genuinely working on this right
 * now"; the advisory lock is a real, non-blocking, provably-exclusive mutex for exactly that
 * question). If the lock can't be acquired, another attempt (this process's own overlapping tick,
 * or a different replica's) already owns this target — back off exactly like the pre-existing "no
 * longer pending/triggering" case below, and let a later tick try again.
 */
async function triggerWaveTarget(
  db: Db,
  orgId: string,
  change: ChangeRow,
  waveTargetId: string,
  targetObjectId: string,
  purpose: "infra" | "software",
  isRollback: boolean,
  host: PluginHost,
  masterKey: Buffer
): Promise<void> {
  const lock = await tryAcquireTriggerClaimLock(db, waveTargetId);
  if (!lock) return; // another attempt (this or another worker replica) is genuinely in flight.

  try {
    // M7: resolve targetObjectId's configured executor binding (executor-bindings-repo.ts) — a
    // Component/DeploymentTarget with no binding configured falls back to the shared default
    // fake-executor instance, exactly as every M0-M6 test/demo relies on (executor-config.ts).
    const instanceId = await ensureExecutorInstanceStarted(
      db,
      orgId,
      host,
      targetObjectId,
      purpose,
      null,
      masterKey
    );
    const client = host.executor(instanceId);
    // Deterministic across every retry of this exact wave target — no separate storage needed, the
    // row's own id already satisfies "IDENTICAL across retries of the same target."
    const idempotencyKey = waveTargetId;

    const claim = await withTenantTx(db, orgId, async (tx) => {
      let kind: TriggerIntent["kind"];
      let priorStateRef: unknown = null;

      // The executor-specific target id (e.g. an Argo CD Application name) this object maps to.
      // Falls back to the object id for legacy bindings — so a binding whose object id already IS
      // the external name (pre-M12) is unaffected. This is what lets Mode A / imported objects
      // trigger the right external resource when their SCP id differs from their external name.
      // P3: a target may hold BOTH an infra and a software binding, so "the" binding no longer
      // exists — reconcile must NAME the pipeline it drives. P4A supplies that name: `purpose` rides
      // in on the wave target, snapshotted at plan time from the change (and thence from the source
      // mapping that matched the release), which is what finally makes an infra binding TRIGGERABLE
      // rather than merely registerable and readable. Anything unrecognised resolves to 'software' —
      // the value P3 migrated every existing binding to, and the only one reconcile ever asked for
      // before P4A — so pre-P4A wave targets trigger exactly what they always did.
      const binding = await getExecutorBinding(tx, orgId, targetObjectId, purpose);
      const externalRef = binding?.externalRef ?? null;

      if (isRollback && change.rollbackOfObjectId) {
        // Restore exactly what the ORIGINAL change's trigger of this same target would have
        // reverted (DESIGN §9.4: "referencing the prior known-good executor state").
        kind = "rollback";
        const originalTarget = await findOriginalWaveTarget(
          tx,
          orgId,
          change.rollbackOfObjectId,
          targetObjectId
        );
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
      return claimed ? { kind, priorStateRef, externalRef } : null;
    });

    if (!claim) return; // no longer pending/triggering — another tick already handled it.

    // Step 2 — OUTSIDE any open transaction, on purpose (see doc comment above).
    const ref = await client.trigger({
      kind: claim.kind,
      targetRef: claim.externalRef ?? targetObjectId,
      priorStateRef: claim.priorStateRef,
      idempotencyKey
    });

    await withTenantTx(db, orgId, (tx) =>
      markWaveTargetTriggered(tx, orgId, waveTargetId, {
        executorPluginId: instanceId,
        executorRef: ref,
        priorStateRef: claim.priorStateRef
      })
    );
  } finally {
    await lock.release();
  }
}

/**
 * Ensures the executor plugin instance a wave target should use is provisioned on `host`
 * (`PluginHost.start()` is idempotent per instance id — plugin-host/host.ts — so calling this on
 * every trigger/poll is cheap once the instance is already running in THIS process) and returns
 * the instance id to call. Resolution order:
 *
 *   1. If `persistedExecutorPluginId` is set (a poll on an already-`triggered` target) and a
 *      CURRENT binding for `targetObjectId` still resolves to that exact instance id, provision
 *      it from the current binding config and return it — the common case, and what keeps a
 *      freshly-started worker process (which has never called `host.start()` for this instance
 *      before — DESIGN §9.3's "any worker resumes from Postgres alone") able to poll a target
 *      another worker triggered before it, or before this process itself restarted.
 *   2. Otherwise (no persisted id yet — a fresh trigger — or the binding no longer matches),
 *      resolve `targetObjectId`'s CURRENT binding fresh and provision/return ITS instance id.
 *   3. No binding configured at all — fall back to the shared default fake-executor instance
 *      (`executor-config.ts`), preserving M0-M6 behavior unchanged for orgs/targets that haven't
 *      configured a real executor.
 */
async function ensureExecutorInstanceStarted(
  db: Db,
  orgId: string,
  host: PluginHost,
  targetObjectId: string,
  purpose: "infra" | "software",
  persistedExecutorPluginId: string | null,
  masterKey: Buffer
): Promise<string> {
  // MUST resolve the SAME purpose the trigger will use (M12 P4A). Resolving without it would start
  // the target's SOFTWARE plugin instance and then trigger against the INFRA binding — a mismatch
  // that would silently drive the wrong pipeline.
  const resolved = await withTenantTx(db, orgId, (tx) =>
    resolveExecutorPluginInstance(tx, { orgId, targetObjectId, masterKey, purpose })
  );

  if (
    resolved &&
    (!persistedExecutorPluginId || persistedExecutorPluginId === resolved.instanceConfig.id)
  ) {
    await host.start([resolved.instanceConfig]);
    return resolved.instanceConfig.id;
  }

  // Either no binding is configured, or a persisted id from an earlier trigger no longer matches
  // the (possibly since-changed) current binding — fall back to whichever id was already
  // persisted so polling keeps addressing the SAME instance the original trigger used, ensuring
  // at least the shared default is alive so the call doesn't fail outright on a fresh process.
  await host.start([
    {
      id: DEFAULT_EXECUTOR_INSTANCE_ID,
      module: DEFAULT_EXECUTOR_MODULE,
      orgId,
      domainId: "default",
      config: {}
    }
  ]);
  return persistedExecutorPluginId ?? DEFAULT_EXECUTOR_INSTANCE_ID;
}

/** All waves of `change`'s plan have succeeded — advance past `executing`. Forward changes stop
 *  at `validating` for a human `scp change promote` (DESIGN's chain is a deliberate human gate
 *  before promotion); a ROLLBACK change (its own `rollbackOfObjectId` is set) has no equivalent
 *  human-review step to wait for — restoring known-good state doesn't need approval the way
 *  rolling new state out does — so it auto-promotes itself and then, per DESIGN §9.4 / this
 *  module's rollback.ts sibling, transitions the ORIGINAL change to `rolled_back` in the same
 *  transaction. */
async function completeExecution(
  tx: TenantTx,
  orgId: string,
  change: ChangeRow,
  gateDeps: GateDeps
): Promise<void> {
  const validated = await transitionChange(
    tx,
    {
      orgId,
      changeObjectId: change.objectId,
      toState: "validating",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: "auto: every wave succeeded"
    },
    gateDeps
  );
  if (validated.verdict !== "allow") return;

  if (!change.rollbackOfObjectId) return; // forward change — waits for a human `scp change promote`.

  const promoted = await transitionChange(
    tx,
    {
      orgId,
      changeObjectId: change.objectId,
      toState: "promoted",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: "auto: rollback changes need no human promotion gate"
    },
    gateDeps
  );
  if (promoted.verdict !== "allow") return;

  await transitionChange(
    tx,
    {
      orgId,
      changeObjectId: change.rollbackOfObjectId,
      toState: "rolled_back",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: `rollback change ${change.objectId} promoted`,
      extraInputContext: { rollbackChangeObjectId: change.objectId }
    },
    gateDeps
  );
}

/**
 * Whether a failed wave's targets are covered by an effective `autoRollbackOnFailure` policy
 * (module doc comment on the "failed" branch above), AND no non-terminal rollback of this change
 * already exists (avoids re-triggering a second rollback every tick while the first one is still
 * in flight — `listChangeRowsInStates`'s `reconcile_blocked_at` guard already stops this SAME
 * change from being re-visited, but that column is set AFTER this check in the same tick, so this
 * extra guard covers the one-tick window and remains correct if that ordering ever changes).
 */
async function shouldAutoRollback(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[],
  originalChangeObjectId: string
): Promise<boolean> {
  const existingRollback = await tx.query.changes.findFirst({
    where: (t, { eq: eqOp, and: andOp, notInArray }) =>
      andOp(
        eqOp(t.orgId, orgId),
        eqOp(t.rollbackOfObjectId, originalChangeObjectId),
        notInArray(t.state, ["cancelled", "rolled_back"])
      )
  });
  if (existingRollback) return false;

  const matches = await matchPoliciesForTargets(tx, {
    orgId,
    targetObjectIds,
    actorObjectId: SYSTEM_ACTOR_ID
  });
  const effective = resolvePolicies(matches);
  return effective.some((p) => p.autoRollbackOnFailure);
}

// -------------------------------------------------------------------------------------------
// pg-boss wiring
// -------------------------------------------------------------------------------------------

/** One full sweep: every org, one `reconcileOrgTick` each. Errors in one org's tick are caught
 *  and logged so they never take down the sweep (or the pg-boss job) for every other org. */
export async function runReconcileSweep(
  db: Db,
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await reconcileOrgTick(db, org.id, host, sandbox, masterKey);
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
export async function reconcileOrgTick(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<void> {
  const gateDeps: GateDeps = { sandbox, host };
  try {
    await withTenantTx(db, orgId, (tx) => processChangeSourceEvents(tx, orgId));
  } catch (err) {
    console.error(`[reconcile] org ${orgId} change-source-event processing failed:`, err);
  }
  await advanceProposedChanges(db, orgId, gateDeps);
  await advanceEvaluatedChanges(db, orgId, gateDeps);
  await advanceCoordinatedChanges(db, orgId, gateDeps);
  await advanceExecutingChanges(db, orgId, host, sandbox, masterKey);
  await advanceValidatingChanges(db, orgId, host, sandbox);
  // M5 (DESIGN §9.5): campaigns fan out into real M3 Changes above already progress through the
  // exact same steps this tick just ran — this only sequences WHICH wave's member changes get
  // proposed next (coordination/campaign-reconcile.ts's module doc).
  try {
    await reconcileCampaignsOrgTick(db, orgId, host, sandbox);
  } catch (err) {
    console.error(`[reconcile] org ${orgId} campaign reconciliation failed:`, err);
  }
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
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<ReconcileLoopHandle> {
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(RECONCILE_QUEUE);
  await boss.work(RECONCILE_QUEUE, async () => {
    if (stopped) return;
    const tick = runReconcileSweep(db, host, sandbox, masterKey);
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
