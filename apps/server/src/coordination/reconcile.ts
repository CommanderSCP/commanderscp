import type PgBoss from "pg-boss";
import type { ExecutorCapabilities, TriggerIntent } from "@scp/plugin-api";
import { boundDetail } from "@scp/runner-launcher";
import type { ExecutorType, TrustDomainId } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { and, eq } from "drizzle-orm";
import { changes, orgs } from "../db/schema.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { CelSandbox } from "../governance/cel-sandbox.js";
import type { GateDeps } from "./gates.js";
import {
  getChangeRow,
  listChangeRowsInStates,
  markChangeReconcileBlocked,
  targetObjectIdsOf,
  requiresOf,
  stageDependenciesOf,
  type ChangeRow
} from "./changes-repo.js";
import {
  describeStageDependencyHold,
  evaluateStageDependencies,
  type StageDependencyVerdict
} from "./stage-dependency-hold.js";
import {
  describeFreezeHold,
  describeHeldTargets,
  evaluateFreezeHolds,
  type FreezeHoldVerdict
} from "./freeze-hold.js";
import {
  describeContinuousHeldTargets,
  describeContinuousHold,
  evaluateContinuousHolds,
  type ContinuousHoldTargetVerdict
} from "./continuous-hold.js";
import { rollbackExemptible } from "../governance/freeze-scope.js";
import { transitionChange } from "./transition.js";
import { triggerRollback } from "./rollback.js";
import {
  compileAndPersistPlan,
  getLatestPlanForChange,
  loadDependsOnEdges
} from "./plan-service.js";
import type { DependsOnEdge } from "./plan-compiler.js";
import {
  requirementStatuses,
  unsatisfiedRequirements,
  describeRequirements,
  ambiguousProvidersFor
} from "./coupling.js";
import {
  claimWaveTargetForTriggering,
  findLatestSucceededExecution,
  isRefusedWaveTargetStatus,
  type RefusedWaveTargetStatus,
  findOriginalWaveTarget,
  getWaveStatus,
  markWaveRunning,
  terminalizeRefusedWaveTarget,
  markWaveTargetTriggered,
  markWaveTargetTriggerFailed,
  markWaveTerminal,
  observedStateFrom,
  originalChangeDispatchedTarget,
  updateWaveTargetObserved
} from "./wave-targets-repo.js";
import {
  DEAD_TARGET_REMEDIATION,
  deadTargetInputContext,
  describeDeadTarget,
  readTargetLiveness,
  WAVE_TARGET_TOMBSTONED_AUDIT_ACTION,
  WAVE_TARGET_TOMBSTONED_STATUS
} from "./target-liveness.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { tryAcquireTriggerClaimLock } from "./trigger-claim-lock.js";
import {
  WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_AUDIT_ACTION,
  WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS,
  WAVE_TARGET_RECIPE_UNREADABLE_AUDIT_ACTION,
  WAVE_TARGET_RECIPE_UNREADABLE_STATUS,
  WAVE_TARGET_RECIPE_UNSUPPORTED_AUDIT_ACTION,
  WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS,
  executorSupportsTriggerKind,
  isRecipeForbiddenExecutorModule,
  recipeTriggerParameters,
  resolveChangeRecipe,
  type RecipeResolution
} from "./campaign-recipe.js";
import { tryAcquireChangeCoordinationLock } from "./change-coordination-lock.js";
import { evaluateWaveGate } from "./gates.js";
import type { HookTriggerRequest } from "./pipeline-hook-gate.js";
import {
  insertDecision,
  insertDecisionIfChanged,
  latestDecisionForSubjectKind
} from "./decisions-repo.js";
import { describeError } from "../errors.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID, DEFAULT_EXECUTOR_MODULE } from "./executor-config.js";
import type { PluginModule } from "../plugin-host/contract.js";
import { resolveExecutorPluginInstance, DEFAULT_BINDING_TYPE } from "./executor-bindings-repo.js";
import {
  listVisibleBindingsForTarget,
  resolutionProvenance,
  resolveBindingForTarget
} from "./binding-resolution.js";
import { evaluateRegionalDeployGate } from "./regional-executors.js";
import { REGIONAL_EXECUTOR_EXPECTED_MODULE } from "@scp/schemas";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { reconcileExecutorBindingsForOrg } from "../binding-policy/reconcile-bindings.js";
import { drainConfigSourceSyncQueue } from "../config-source/drain-sync-queue.js";
import { matchPoliciesForTargets } from "../governance/policy-resolve.js";
import { resolvePolicies } from "../governance/policy-model.js";
import { prewarmGovernanceForChange } from "../governance/gate-orchestrator.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { runPreDeployArtifactGate } from "./pre-deploy-gate.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { ensureHookRunTriggered, pollNonTerminalHookRuns } from "./pipeline-hook-runs.js";
import { ensureContinuousProbesScheduled } from "./continuous-probe-driver.js";

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

/**
 * TRIGGER RETRY BACKOFF (measured production storm, homelab 2026-08-01: 19 `argocd trigger: sync
 * returned HTTP 400` against 12 successful syncs in 15 minutes, every 400 on the SAME target).
 *
 * Argo CD refuses a sync while an operation is already running on that Application, and a real
 * backlog fans many changes onto a handful of Argo apps — so contention is the NORMAL case here,
 * not an error. With a 1-second tick and no backoff, every contending target re-fired every second
 * and lost, producing a retry storm that consumed executor capacity and buried genuine failures in
 * the log.
 *
 * Exponential on the target's OWN `attempt` count, so a target that keeps losing the race steps
 * aside for progressively longer while an uncontended one is unaffected. Deliberately capped, not
 * unbounded: contention clears on its own, so a target must keep checking back rather than
 * effectively giving up.
 */
const TRIGGER_RETRY_BASE_MS = 2_000;
const TRIGGER_RETRY_CAP_MS = 5 * 60_000;

/**
 * How long a target that has already been REFUSED by its executor must wait before re-firing.
 *
 * `attempt === 0` returns 0 — no delay — and that is load-bearing, not an optimisation. A tick that
 * crashes between claiming a target and recording the outcome leaves the row `triggering` with
 * `attempt` still 0, and `wave-targets-repo.ts`'s crash-recovery contract (plus the M3 suites that
 * exercise it) requires that row to be retried on the VERY NEXT tick with no time budget. Only a
 * trigger that actually reached the executor and was refused increments `attempt`, so only a real
 * refusal is ever backed off.
 */
function triggerBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(TRIGGER_RETRY_BASE_MS * 2 ** (attempt - 1), TRIGGER_RETRY_CAP_MS);
}

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
async function advanceProposedChanges(
  db: Db,
  orgId: string,
  gateDeps: GateDeps,
  selfDomainId: TrustDomainId
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["proposed"], BATCH_LIMIT, selfDomainId)
  );
  for (const { change, object } of rows) {
    // S10 single-writer guard: a read-only replica of a peer's change is never ours to drive —
    // SKIP silently (no lock, no Decision, no park) rather than attempt a transition the guard
    // inside `transitionChange` would refuse anyway. See tracked-security-followups.
    //
    // NOW UNREACHABLE, AND KEPT DELIBERATELY. `listChangeRowsInStates` filters foreign-origin rows
    // out of the candidate set above (see its doc comment), so this `continue` can no longer fire.
    // It stays because it states the loop body's S10 INVARIANT — "this loop only ever writes rows
    // this domain is authoritative for" — which is a property of the BODY, not of one query. A
    // future candidate fetch that forgot the filter would find this still standing. The filter
    // makes the guard unreachable; it does not replace what the guard means.
    //
    // WHAT THIS MUST NEVER BECOME is a round-robin cursor bump on the skip path. Un-filtered,
    // this `continue` re-served a row without ever writing it — the batch-starvation property
    // (`candidate-loop-registry.test.ts`) that cost 13 days of production coordination — but the
    // bump used on every other instance of that property is ILLEGAL here: it would write a
    // read-only replica's row. Filtering the candidate set is the only remedy that is both
    // starvation-free and single-writer-clean, and it keeps "SKIP, NOT PARK" intact (the row
    // rejoins the batch by itself the moment authority returns). Pinned by
    // `foreign-origin-batch-starvation.integration.test.ts`.
    if (object.originDomainId !== selfDomainId) continue;
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
async function advanceEvaluatedChanges(
  db: Db,
  orgId: string,
  gateDeps: GateDeps,
  selfDomainId: TrustDomainId
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["evaluated"], BATCH_LIMIT, selfDomainId)
  );
  for (const { change, object } of rows) {
    // S10 single-writer guard — see advanceProposedChanges for why this is kept even though the
    // candidate query above now makes it unreachable, and why a round-robin bump here is wrong.
    if (object.originDomainId !== selfDomainId) continue;
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
          //
          // `describeError`, not `err.message`: `compileAndPersistPlan` throws `notFound`/
          // `badRequest` (`plan-service.ts`) and `transitionChange` throws `notFound`
          // (`transition.ts`), all `ProblemError`s whose `message` is only the HTTP TITLE. The
          // reason below is the change's PERMANENT epitaph — it is written into the cancelling
          // transition's Decision and audit event, and it is the only explanation an operator ever
          // gets for a change that auto-cancelled. "auto-cancelled: plan compilation failed — Not
          // Found" names neither the missing topology nor the cycle. See `errors.ts`.
          //
          // PINNED BY `decision-write-amplification.integration.test.ts`'s T5 (both halves of the
          // epitaph — the Decision and the audit event), mutation-proven.
          const message = describeError(err);
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
async function advanceCoordinatedChanges(
  db: Db,
  orgId: string,
  gateDeps: GateDeps,
  selfDomainId: TrustDomainId
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["coordinated"], BATCH_LIMIT, selfDomainId)
  );
  for (const { change, object } of rows) {
    // S10 single-writer guard — see advanceProposedChanges for why this is kept even though the
    // candidate query above now makes it unreachable, and why a round-robin bump here is wrong.
    if (object.originDomainId !== selfDomainId) continue;
    const lock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!lock) continue;
    try {
      // M17.4(b) PRE-DEPLOY GATE: `coordinated -> executing` is the last point before
      // `reconcileExecutingChange` triggers this change's deploy executor(s). For a change carrying
      // a VERIFIED CROSS-BOUNDARY promotion manifest (an imported promotion — ADR-0013 exempts
      // domain-local changes, which this no-ops for), re-read the reachable registry and verify every
      // authorized artifact's bytes are present + authentic against the exporter's cosign key. Any
      // failure BLOCKS: it persists a block Decision + audit and PARKS the change, and we skip the
      // transition so the deploy never fires. Runs cosign subprocesses OUTSIDE a tx (opens its own).
      // Fail-closed. Coordinate-not-execute: verify-only, no byte transport (M15.5), no re-scan.
      const gate = await runPreDeployArtifactGate(db, orgId, change);
      if (gate.blocked) continue;

      // Coupled pipelines (M12 P4B): a change with unsatisfied cross-change prerequisites
      // (`properties.requires`) parks in `waiting` instead of entering execution; one with none —
      // OR one whose prerequisites are ALREADY satisfied — proceeds straight to `executing` exactly
      // as before, so the common no-coupling case is unchanged. The satisfaction check and the
      // transition share ONE transaction so the routing decision can't tear against a prerequisite
      // landing mid-tick. The `waiting` Decision (written by transitionChange, once) names the
      // outstanding prerequisites; while parked, `advanceWaitingChanges` re-checks WITHOUT writing a
      // Decision per tick — see its note on the flood.
      //
      // ROLLBACK EXEMPTION (coupled-pipelines.md §3.4 defence-in-depth): a rollback change NEVER
      // parks. Today a rollback carries no `requires` anyway — but only because `rollback.ts`
      // happens not to spread the original's properties, which is an accident a tidy-up refactor
      // could undo, silently deadlocking every rollback of a coupled change. This guard states the
      // invariant explicitly; a pinning test holds it.
      //
      // FAIL-CLOSED on malformed `requires` (coupled-pipelines.md §6#14): a stored entry that does
      // not parse as `{key, at}` (federation peer skew, corrupted legacy row — impossible via the
      // API, whose typed validation is unchanged) is UNSATISFIABLE, so the change PARKS in
      // `waiting`, where the 24h SLA flags it and wait-status names the bad entry. Proceeding would
      // be fail-open: executing a release whose author explicitly declared a prerequisite.
      const { requirements, malformed } = change.rollbackOfObjectId
        ? { requirements: [], malformed: [] }
        : requiresOf(object.properties as Record<string, unknown>);
      await withTenantTx(db, orgId, async (tx) => {
        const unmet =
          requirements.length === 0
            ? []
            : await unsatisfiedRequirements(tx, orgId, change.objectId, requirements);
        const parks = unmet.length > 0 || malformed.length > 0;
        const toState = parks ? "waiting" : "executing";
        const reason = parks
          ? malformed.length > 0
            ? `waiting: \`requires\` carries ${malformed.length} malformed (unsatisfiable) entr${malformed.length === 1 ? "y" : "ies"} — fail-closed; fix the change's stored requires` +
              (unmet.length > 0 ? `; also unsatisfied: ${describeRequirements(unmet)}` : "")
            : `waiting on ${unmet.length} unsatisfied prerequisite(s): ${describeRequirements(unmet)}`
          : "auto: beginning wave execution";
        await transitionChange(
          tx,
          {
            orgId,
            changeObjectId: change.objectId,
            toState,
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "reconcile",
            reason,
            ...(malformed.length > 0 ? { extraInputContext: { malformedRequires: malformed } } : {})
          },
          gateDeps
        );
      });
    } catch (err) {
      logChangeError(orgId, change, "coordinated->executing", err);
    } finally {
      await lock.release();
    }
  }
}

/**
 * M12 P4B: a change parked in `waiting` re-checks its cross-change prerequisites every tick and, the
 * moment ALL are satisfied, is released to `executing`. While a prerequisite is still outstanding
 * this writes NO state change, NO Decision, and NO `state_entered_at` bump. That silence is
 * deliberate: a Decision-per-tick here would be the "blocked-gate flood" (~30k rows/day per waiter),
 * and leaving `state_entered_at` frozen is what lets the watchdog's 24h `waiting` SLA measure the
 * wait from when it actually began. The one Decision recording that the wait ended is written by the
 * `waiting -> executing` transition itself — its inputs pin, PER requirement, the id of the change
 * that satisfied it (coupled-pipelines.md §3.6 — explainability, charter principle 6).
 *
 * The ONE write a still-waiting change gets is a `reconcile_cursor_at` bump (STARVATION fix,
 * coupled-pipelines.md §3.5 hazard): `listChangeRowsInStates` serves oldest-cursor-first with a
 * BATCH_LIMIT cap, so >BATCH_LIMIT stuck waiters whose cursor never moved would permanently occupy
 * every batch slot and starve a releasable waiter sitting behind them. Bumping an evaluated,
 * still-stuck waiter to the back of the queue round-robins the batch across ALL waiters, so every
 * one is re-evaluated within a few ticks no matter how many are stuck.
 *
 * FAIL-CLOSED + SKIP-NOT-CRASH (coupled-pipelines.md §6#14): a waiter whose stored `requires`
 * carries a malformed entry is UNSATISFIABLE — it stays parked (and is bumped like any other stuck
 * waiter) rather than being released or thrown on. One bad row must never brick this sweep for the
 * healthy waiters behind it; wait-status (routes/changes.ts) and the watchdog name the bad entry.
 *
 * ROLLBACK EXEMPTION (coupled-pipelines.md §3.4): a rollback change must never sit in `waiting` —
 * the routing guard never sends one here, but if one ever lands here anyway (state imported, or a
 * future refactor), it is released immediately rather than held behind a coupling it cannot answer.
 */
async function advanceWaitingChanges(
  db: Db,
  orgId: string,
  gateDeps: GateDeps,
  selfDomainId: TrustDomainId
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["waiting"], BATCH_LIMIT, selfDomainId)
  );
  for (const { change, object } of rows) {
    // S10 single-writer guard — see advanceProposedChanges for why this is kept even though the
    // candidate query above now makes it unreachable, and why a round-robin bump here is wrong.
    if (object.originDomainId !== selfDomainId) continue;
    const lock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!lock) continue;
    try {
      // M17.4(b) defense-in-depth: `waiting -> executing` is a SECOND edge into execution. Today no
      // manifest-carrying change can reach it (applyPromotionImport STRIPS `requires` on promotion,
      // so an imported cross-boundary change never parks in `waiting`), but the invariant "no change
      // carrying a verified cross-boundary manifest enters `executing` without per-artifact byte
      // verification" must hold independently of that stripping. No-op for everything else.
      const gate = await runPreDeployArtifactGate(db, orgId, change);
      if (gate.blocked) continue;

      const { requirements, malformed } = change.rollbackOfObjectId
        ? { requirements: [], malformed: [] }
        : requiresOf(object.properties as Record<string, unknown>);
      await withTenantTx(db, orgId, async (tx) => {
        const statuses = await requirementStatuses(tx, orgId, change.objectId, requirements);
        const unmet = statuses.filter((s) => !s.satisfied);
        if (unmet.length > 0 || malformed.length > 0) {
          // Still waiting (or unsatisfiable — malformed is never releasable). Round-robin bump so
          // stuck waiters can't starve a releasable one out of the batch — see the doc comment.
          // BUMP 1 OF 5. `reconcile_cursor_at` ONLY: nothing about this change's content changed
          // (it is still waiting on the same unmet keys), so `updated_at` must not move — that is
          // the whole point of migration 0058's split.
          await tx
            .update(changes)
            .set({ reconcileCursorAt: new Date() })
            .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)));
          return;
        }
        // Key-reuse warn (M12 P4B Phase 4, coupled-pipelines.md §6#8): re-probes each NOW-satisfied
        // requirement for a second (or third...) qualifying provider. Never blocks the release — a
        // hotfix reusing a release key is legitimate — but the ambiguity is worth a permanent record
        // beside `satisfiedRequirements`, since the chosen provider id above is otherwise silently
        // arbitrary (no `ORDER BY` guarantee) whenever more than one change qualifies.
        const ambiguous = await ambiguousProvidersFor(tx, orgId, change.objectId, statuses);
        await transitionChange(
          tx,
          {
            orgId,
            changeObjectId: change.objectId,
            toState: "executing",
            actorObjectId: SYSTEM_ACTOR_ID,
            requestId: "reconcile",
            reason: change.rollbackOfObjectId
              ? "auto: rollback change is exempt from cross-change prerequisites — beginning wave execution"
              : "auto: all cross-change prerequisites satisfied — beginning wave execution",
            // Explainability (coupled-pipelines.md §3.6, charter principle 6): pin, per requirement
            // key, WHICH change satisfied it at release time — the historical record `scp change
            // explain` shows even after live wait-status has moved on.
            ...(statuses.length > 0
              ? {
                  extraInputContext: {
                    satisfiedRequirements: statuses.map((s) => ({
                      key: s.key,
                      at: s.at,
                      satisfiedByChangeObjectId: s.satisfiedByChangeObjectId
                    })),
                    ...(ambiguous.length > 0 ? { ambiguousProviders: ambiguous } : {})
                  }
                }
              : {})
          },
          gateDeps
        );
      });
    } catch (err) {
      logChangeError(orgId, change, "waiting->executing", err);
    } finally {
      await lock.release();
    }
  }
}

// -------------------------------------------------------------------------------------------
// validating: no state transition happens here automatically (that edge is human-only —
// coordination/gates.ts's module doc) — but a required control referenced by a policy bound to
// the `validating->accepted` edge needs to actually RUN somewhere, and the accept route itself
// is host-less (DESIGN §16's api/worker split). This is that "somewhere": every tick, ensure
// every fired policy's required controls have a fresh outcome and every requireApprovals effect
// has a materialized approval_requests row, so a human's `scp change accept` — and `GET
// /approvals` — see up-to-date state without ever needing this process to hold a live PluginHost.
// -------------------------------------------------------------------------------------------

async function advanceValidatingChanges(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox,
  selfDomainId: TrustDomainId
): Promise<void> {
  // THE SIXTH CALL SITE, and it never had the S10 skip the other five carry — so the `continue` was
  // never the thing to fix; the QUERY was. Before the filter this loop would have run governance
  // prewarm on a peer's read-only replica and then WRITTEN that replica's `changes` row (the bump
  // below), which is the single-writer violation itself and not merely a scheduling one. It is
  // listed as a candidate fetch in `candidate-loop-registry.test.ts` and would have been missed by a
  // census that only followed the five `originDomainId !== selfDomainId` guards.
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["validating"], BATCH_LIMIT, selfDomainId)
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
      // ROUND-ROBIN BUMP (2 of 5) — same starvation class as the `waiting` and `executing` paths,
      // caught by sweeping for the property rather than the symptom. This loop NEVER advances the
      // change: `prewarmGovernanceForChange` materializes approval requests and control runs, and
      // nothing here transitions it (validating -> accepted is driven by the lifecycle gate, not by
      // this sweep). So a validating change's cursor is frozen from the moment it arrives, and
      // >BATCH_LIMIT of them would permanently own this batch and starve the rest out of governance
      // prewarm — meaning the newest changes would never get an approval request materialized, and
      // so could never be approved.
      //
      // `reconcile_cursor_at` ONLY (migration 0058). Prewarm writes approval requests and control
      // runs, which are rows of their OWN; the change row's content is untouched, so `updated_at`
      // stays where it was.
      //
      // NOT YET BITING, and pinned here so it cannot start silently: the homelab instance holds 7
      // validating changes against a BATCH_LIMIT of 25. The `executing` instance of this same bug
      // ran undetected for 13 days; this is the identical hazard two states over.
      await withTenantTx(db, orgId, (tx) =>
        tx
          .update(changes)
          .set({ reconcileCursorAt: new Date() })
          .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)))
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
  masterKey: Buffer,
  selfDomainId: TrustDomainId
): Promise<void> {
  const rows = await withTenantTx(db, orgId, (tx) =>
    listChangeRowsInStates(tx, orgId, ["executing"], BATCH_LIMIT, selfDomainId)
  );
  for (const { change, object } of rows) {
    // S10 single-writer guard — see advanceProposedChanges for why this is kept even though the
    // candidate query above now makes it unreachable, and why a round-robin bump here is wrong.
    // Filtering here also covers every write `reconcileExecutingChange` might make below it (wave
    // triggers, completeExecution's transitionChange calls, and the auto-rollback triggerRollback
    // call) without needing a separate check inside each of those.
    if (object.originDomainId !== selfDomainId) continue;
    try {
      // `object.properties` is threaded in because the stage-dependency hold (ADR-0028) reads its
      // declarations from there, and `changes` rows carry no properties of their own — the same
      // reason `advanceCoordinatedChanges` above reads `requires` off the object.
      await reconcileExecutingChange(
        db,
        orgId,
        change,
        object.properties as Record<string, unknown> | null,
        host,
        sandbox,
        masterKey
      );
    } catch (err) {
      logChangeError(orgId, change, "executing-advance", err);
    }
  }
}

async function reconcileExecutingChange(
  db: Db,
  orgId: string,
  change: ChangeRow,
  changeProperties: Record<string, unknown> | null,
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<void> {
  const gateDeps: GateDeps = { sandbox, host };
  // `withFreezeHolds: false` (M25.UI review finding 4) — this function reads `plan.waves[].status`
  // and `.targets[].status`/`targetObjectId` only; it never touches `.hold`/`heldTargetCount` (the
  // trigger branch below evaluates freezes itself, lazily, via `loadFreezeHolds`). Without this,
  // EVERY executing change paid for a full freeze-hold evaluation here, on EVERY 1 s tick, whose
  // result was discarded — then `loadFreezeHolds` redid the identical work moments later for the
  // decision that actually acts on it.
  const plan = await withTenantTx(db, orgId, (tx) =>
    getLatestPlanForChange(tx, orgId, change.objectId, { withFreezeHolds: false })
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
    // check documents for the validating->accepted edge applies here too, just for a different
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

  /**
   * IS THIS CHANGE A ROLLBACK? — read ONCE, above the wave gate, because BOTH freeze seams need it
   * (owner decision D7) and two readings of one fact is how they drift.
   *
   * `evaluateLifecycleGate` has always exempted rollbacks at `validating->accepted` (DESIGN §9.4 —
   * "no human-review step to wait for"). The WAVE boundary never learned the same fact, so a
   * rollback of a broken release into a frozen scope was refused by the very mechanism meant to
   * protect the scope — pinning the broken release in place for the whole window. D7 closes that at
   * both places: the gate (below, via `EvaluateWaveGateContext.isRollback`) and the per-target hold
   * (the actuator's `!isRollback`, further down). Both are needed and neither is sufficient: the
   * gate covers the ALL-frozen wave, the actuator covers every partially-frozen one.
   */
  const isRollback = change.rollbackOfObjectId !== null;

  /**
   * INCREMENT 8 — THE WAVE THIS ADMISSION IS THE EXIT OF (team-pipeline-iac D21).
   *
   * "Gating promotion OUT of wave N" IS "gating entry INTO wave N+1", so a `postDeploy` /
   * `bakeAlarms` gate on `activeWave` is evaluated against the components and targets of the wave
   * BEFORE it. Resolved here, from the plan `reconcileExecutingChange` already loaded, so the gate
   * adapter costs no extra query to learn which wave that is.
   *
   * THE NEAREST PRECEDING WAVE **WITH TARGETS**, not simply `waveIndex - 1`. A stage wave whose
   * place holds none of this change's components is born `skipped` with zero targets
   * (`plan-service.ts`), and treating one as "the previous wave" would silently produce an empty
   * gate — a declared hook that renders in `scp iac render` and enforces nothing, which is the
   * failure mode this whole increment exists to close. `undefined` means this is the first wave
   * that has anything in it, which has no exit to gate: that case gates on `postMerge` instead
   * (`ManifestPostMergeHookSchema` — the first thing SCP genuinely controls is the change entering
   * its first wave).
   */
  const previousWaveWithTargets = [...plan.waves]
    .filter((w) => w.waveIndex < activeWave.waveIndex && w.targets.length > 0)
    .sort((a, b) => b.waveIndex - a.waveIndex)[0];

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
    let gateOutcome:
      // `firstBlock` is `insertDecisionIfChanged`'s `created` flag: true only on the tick that
      // actually PERSISTED this block, false on every tick that merely restated it. It is what makes
      // the log line below fire ONCE per distinct block instead of once per ~2 s tick — the same
      // persist-on-change discipline applied to the log stream, which would otherwise reproduce the
      // very flood this PR fixes, in a different sink.
      | {
          kind: "blocked";
          decisionId: string;
          firstBlock: boolean;
          /** Hook tuples the gate found `awaiting`, carried OUT of the transaction to be dispatched
           *  after it commits — an executor call inside an open transaction is precisely what the
           *  trigger path's three-step ordering exists to avoid. */
          pendingHookTriggers?: HookTriggerRequest[] | undefined;
        }
      | { kind: "running" }
      | { kind: "already-progressed" };
    try {
      gateOutcome = await withTenantTx(db, orgId, async (tx) => {
        // Fresh re-check, still under the lock — a racing tick may have already evaluated this
        // wave's gate and advanced it (running, or further) in the window between the batch read
        // in advanceExecutingChanges and this lock's acquisition. Re-running the gate here would
        // insert a SECOND Decision for the same wave — this is the "lost the race" no-op, not a
        // re-evaluation, exactly like advanceEvaluatedChanges's fresh re-check above.
        const freshStatus = await getWaveStatus(tx, orgId, activeWave.id);
        if (freshStatus !== "pending") return { kind: "already-progressed" } as const;

        const gate = await evaluateWaveGate(
          tx,
          {
            orgId,
            changeObjectId: change.objectId,
            actorObjectId: SYSTEM_ACTOR_ID,
            emergency: change.emergency,
            topologyObjectId: plan.topologyObjectId,
            waveIndex: activeWave.waveIndex,
            targetObjectIds: activeWave.targets.map((t) => t.targetObjectId),
            isRollback,
            pipelineHooks: {
              changeObjectId: change.objectId,
              previousWave: previousWaveWithTargets
                ? {
                    waveIndex: previousWaveWithTargets.waveIndex,
                    // `change_waves.name` IS the stage name — `plan-compiler.ts` copies the topology
                    // wave's name onto every step it produces, and D6 makes the vocabulary operator
                    // data SCP never enforces.
                    stage: previousWaveWithTargets.name,
                    targets: previousWaveWithTargets.targets
                      // ONLY TARGETS THAT ACTUALLY DEPLOYED. A `postDeploy` result or a bake window
                      // for a target that never ran is evidence that can never arrive, and
                      // requiring it would hold the next wave open forever. A previous wave with a
                      // failed target has already parked the change on the `failed` branch above,
                      // so this filter is about skipped/never-triggered rows, not about hiding
                      // failures.
                      .filter((t) => t.status === "succeeded")
                      .map((t) => ({
                        targetObjectId: t.targetObjectId,
                        // THE DEPLOY INSTANT, AS DATA. `lastObservedAt` is when reconcile observed
                        // this target succeed; `updatedAt` is the fallback for a row whose success
                        // was recorded without an observation. Both are STABLE for a terminal
                        // target — nothing writes them again — which is required, because this
                        // value becomes the bake window's start inside a Decision record.
                        deployedAt: t.lastObservedAt ?? t.updatedAt
                      }))
                  }
                : null,
              admittedTargets: activeWave.targets.map((t) => ({
                targetObjectId: t.targetObjectId
              }))
            }
          },
          gateDeps
        );
        // PERSIST-ON-CHANGE, not write-every-tick (THE production disk-growth bug — see
        // `decisions-repo.ts`'s `insertDecisionIfChanged` for the measurement). The evaluation
        // above still runs on EVERY tick, deliberately and unchanged: a wave parked on a
        // `requireApprovals` effect is unblocked by a human approving somewhere else entirely, and
        // re-evaluating here is the ONLY thing that notices. But this branch returns "blocked"
        // without advancing the wave, so the wave stays `pending`, the change stays `executing`
        // (never parked — parking it would stop it being re-served and nothing would resume it),
        // and `listChangeRowsInStates` hands it straight back on the next tick. Before this guard
        // every one of those ticks appended a byte-identical restatement of an unchanged verdict:
        // ~43,200 rows/day/change, measured at 1.44 GB/day across 25 parked changes in the homelab
        // deployment. The verdict, its inputs, and its reason tree are all still recorded the
        // FIRST time, and again the moment ANY of them differ (gate newly allowed, a different
        // policy firing, a changed target/approval set) — which is exactly when there is something
        // new to explain.
        const recorded = await insertDecisionIfChanged(tx, {
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
        // The blocked outcome carries the STANDING Decision's id — the first block's row when this
        // tick merely restated it — so a suppressed duplicate never degrades explainability to a
        // null `decision_id` (charter principle 6).
        if (gate.verdict === "block") {
          return {
            kind: "blocked",
            decisionId: recorded.decision.id,
            firstBlock: recorded.created,
            ...(gate.pendingHookTriggers ? { pendingHookTriggers: gate.pendingHookTriggers } : {})
          } as const;
        }
        await markWaveRunning(tx, orgId, activeWave.id);
        return { kind: "running" } as const;
      });
    } finally {
      await gateLock.release();
    }
    // "blocked": the wave stays `pending` and this change is re-served (and re-evaluated) next tick.
    // `decisionId` is the standing block Decision an operator resolves with `scp decision get` /
    // `scp change explain`, and it is SURFACED HERE — logged exactly once, on the tick that actually
    // persisted the block. Before this it was carried in the outcome and read by nobody: the only
    // consumer was the `!== "running"` test below, so a comment promising the operator an id was
    // describing a channel that carried nothing (the id they actually see comes from the service
    // board's own latest-block read). Gated on `firstBlock` for the same reason the Decision itself
    // is: a change parked for a week is one line, not 302,400.
    // "already-progressed": a racing tick already handled this wave's gate; next tick sees its result.
    // INCREMENT 8 — DISPATCH THE HOOK RUNS THIS GATE IS WAITING ON.
    //
    // WHAT THIS CLOSES: `ensureHookRunTriggered` was fully built, tested and had NO PRODUCTION
    // CALLER. Nothing wrote `pipeline_hook_runs`, so `pollNonTerminalHookRuns` polled an
    // always-empty table and a declared `postDeploy`/`postMerge` hook blocked its wave forever with
    // a correct-looking `awaiting` — the "built, tested, installed nowhere" shape, at the top of the
    // increment-8 stack rather than inside it.
    //
    // AFTER THE TRANSACTION AND AFTER THE LOCK, deliberately. The trigger does external executor
    // I/O, and its own three-step ordering (claim in tx A, dispatch outside, record in tx B) is
    // built on not being inside someone else's open transaction. Holding the gate lock across an
    // executor call would also make one unreachable executor stall every other change's gate.
    //
    // ONLY ON `blocked`, because that is the only outcome that can carry an awaiting hook: a wave
    // that ran had nothing to wait for. Re-dispatching on every blocked tick is safe and intended —
    // `claimHookRun` is `onConflictDoNothing` on the run's identity and `ensureHookRunTriggered`
    // early-returns when it does not win the claim, so a run already in flight costs one no-op
    // claim per tick rather than a second dispatch.
    //
    // try/catch PER TRIGGER, matching the poll below: one unreachable executor must not take down
    // the rest of the org's tick, and must not stop the OTHER hooks of the same wave from being
    // dispatched. A failure here leaves the wave blocked and is retried next tick, which is the
    // same convergence every other part of this loop relies on.
    if (gateOutcome.kind === "blocked" && gateOutcome.pendingHookTriggers) {
      for (const request of gateOutcome.pendingHookTriggers) {
        try {
          await ensureHookRunTriggered(db, { orgId, host, masterKey }, request);
        } catch (err) {
          console.error(
            `[reconcile] org ${orgId} change ${change.objectId} hook ${request.hook.hookId}: trigger failed:`,
            err
          );
        }
      }
    }
    if (gateOutcome.kind === "blocked" && gateOutcome.firstBlock) {
      console.info(
        `[reconcile] org ${orgId} change ${change.objectId} wave ${activeWave.waveIndex} blocked by governance — decision ${gateOutcome.decisionId} (scp decision get ${gateOutcome.decisionId}); re-evaluated every tick until it clears`
      );
    }
    if (gateOutcome.kind !== "running") {
      // ROUND-ROBIN BUMP (3 of 5) — THE SAME STARVATION FIX `advanceWaitingChanges` ALREADY
      // APPLIES, and the reason it must be here too. A gate-blocked wave stays `pending` and its
      // change stays `executing` (deliberately never parked — see the persist-on-change comment
      // above), so WITHOUT this write the change's cursor never moves again.
      // `listChangeRowsInStates` serves oldest-`reconcile_cursor_at`-first capped at BATCH_LIMIT,
      // so >BATCH_LIMIT permanently-blocked changes occupy every slot of every tick, forever, and
      // every change queued behind them is NEVER EVALUATED EVEN ONCE.
      //
      // MEASURED IN PRODUCTION (homelab, 2026-08-01), which is why this is a bug report and not a
      // hypothetical: 25 changes blocked on one un-approved prod policy held the batch from
      // 2026-07-19 11:04 onward. Of the 231 changes proposed after that instant, ZERO had a single
      // gate Decision — not one had ever been looked at. The last wave target to dispatch anywhere
      // on the instance did so at 11:01 that morning. Coordination had been fully stopped for 13
      // days behind green health checks, because the engine only ever saw the same 25 rows.
      //
      // Bumping an examined-but-still-blocked change to the back of the queue round-robins the
      // batch across ALL of them, so every change is served within a few ticks no matter how many
      // are stuck. The gate is still re-evaluated on the change's turn — which is what lets an
      // approval granted elsewhere unblock it — just not to the exclusion of everything else.
      //
      // `state_entered_at` is deliberately NOT touched (same as the waiting path): the watchdog's
      // stall SLA must keep measuring from when the change actually entered `executing`.
      //
      // NEITHER IS `updated_at`, since migration 0058. This bump is a queue position and nothing
      // else — the change is blocked on the same policy it was blocked on last tick, and for the
      // three days a rollout can sit here an operator reading `Change.updatedAt` must see the last
      // time the change actually CHANGED, not the last time the scheduler looked at it. That
      // conflation is precisely what made this incident invisible in every operator surface while
      // it was happening.
      await withTenantTx(db, orgId, (tx) =>
        tx
          .update(changes)
          .set({ reconcileCursorAt: new Date() })
          .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)))
      );
      return;
    }
  }

  // Unified target reconciliation: every non-terminal target gets either a trigger attempt
  // (pending, or `triggering` — a target a PRIOR tick's crash left mid-claim, see
  // `triggerWaveTarget`) or a status poll (triggered/observing), each in its own transaction and
  // its own try/catch. No longer strictly "trigger every pending target OR poll every in-flight
  // target, never both in the same tick" — now that each target's progress is its own
  // independently-committed transaction rather than one giant per-wave transaction, triggering
  // target A and polling target B in the same tick can't half-commit anything: each target's
  // durable state is exactly as fresh as its own last transaction, no more and no less.
  /**
   * Targets still in flight when this loop ends — HELD ONES INCLUDED. A count rather than the
   * `allTerminal` boolean it replaces, because the terminalization at the bottom has to tell
   * "something is genuinely still running" apart from "nothing is left except targets the
   * stage-dependency hold withheld", and a boolean cannot say which. Exactly one increment per
   * target: every branch that reaches one `continue`s or ends the iteration.
   */
  let nonTerminalTargets = 0;
  let anyFailed = false;

  // THE STAGE-DEPENDENCY HOLD (ADR-0028) — parsed ONCE per change per tick, in memory, before the
  // loop. The overwhelming majority of changes declare nothing, and `evaluateStageDependencies`
  // returns on an empty declaration set before issuing a single query, so an undeclared change pays
  // one property read it was already doing and nothing else. That inertness is a property this
  // feature has to keep, not a nicety: the per-target loop runs on every tick of every executing
  // change on the instance.
  //
  // A ROLLBACK CARRIES NO DECLARATIONS TODAY (`rollback.ts` does not spread the original's
  // properties, and a test pins that), so this is empty for one by construction rather than by a
  // guard. Named because the guarantee matters: holding a rollback behind a dependency would keep a
  // broken release in place while waiting for the very component it is trying to get away from.
  const declared = stageDependenciesOf(changeProperties);

  /**
   * M25.4 — THE CAMPAIGN RECIPE (owner decision D3), resolved ONCE per change per tick, in memory,
   * beside the stage-dependency declarations and for the same reasons: this loop runs on every tick
   * of every executing change on the instance, and a change without a recipe must pay a single
   * key-absence check and nothing else (`resolveChangeRecipe` returns before parsing anything).
   *
   * It is read off the CHANGE, not off the campaign that fanned it out. `campaign-reconcile.ts`
   * copies the recipe by value onto each member change's `properties` at fan-out (see that call
   * site), which is what makes this path campaign-agnostic: a promoted change carrying a recipe
   * through a federation bundle, or a directly authored one, drives exactly the same code.
   */
  const recipe = resolveChangeRecipe(changeProperties);

  /**
   * THE OTHER HALF OF THE HOLD'S DEPENDENCY SET (ADR-0028 decision 6) — plain `depends_on` edges
   * with BOTH endpoints among this change's own targets. That is the exact set `compileStages` used
   * to refuse a same-wave pair over, and it is `loadDependsOnEdges`, the SAME function the compiler
   * is fed from, so the two can never drift into meaning different things.
   *
   * LAZY AND MEMOISED, once per change per tick, and both properties are load-bearing:
   *
   *   * A SINGLE-TARGET CHANGE NEVER QUERIES. Both endpoints must be in the target set, so one
   *     target can only ever produce a self-edge, which orders nothing. 277 of 281 measured changes
   *     target exactly one component (ADR-0026), so the ordinary release pays nothing for this.
   *   * A CHANGE WITH NOTHING PENDING NEVER QUERIES either — the call sits inside the trigger
   *     branch, so a wave that is purely polling in-flight targets does not touch the graph.
   *
   * Unlike the declarations, this cannot be read off the change's properties: an edge is graph
   * state, and the whole point is that it may have been written by something other than this change.
   */
  const changeTargets = targetObjectIdsOf(changeProperties);
  let inTargetSetEdges: DependsOnEdge[] | undefined;
  const loadInTargetSetEdges = async (): Promise<DependsOnEdge[]> =>
    (inTargetSetEdges ??=
      changeTargets.length < 2
        ? []
        : await withTenantTx(db, orgId, (tx) => loadDependsOnEdges(tx, orgId, changeTargets)));

  /**
   * THE FREEZE HOLD (M25.2) — resolved ONCE per change per tick, for the WHOLE wave, and memoised
   * exactly like the edge set beside it.
   *
   * ONE CALL FOR THE WAVE, NOT ONE PER TARGET, and that is what keeps the cost honest: the whole
   * point of `freezesByTarget` is that it asks "does this org have ANY active freeze right now?"
   * once, on an indexed window read, and returns every target unfrozen without walking a single
   * containment chain when the answer is no. Calling it per target would issue that read per target
   * instead. See `governance/freeze-scope.ts`'s inertness property, which has its own counting test.
   *
   * LAZY, for the same reason `loadInTargetSetEdges` is: the call sits inside the trigger branch, so
   * a wave that is purely POLLING in-flight targets does not consult freezes at all. A freeze cannot
   * withdraw a trigger already made (`ExecutorPlugin` has no pause verb — ADR-0008), so there is
   * nothing for it to say about a target already in flight.
   *
   * RESOLVED EVERY TICK, never once at the wave boundary. That is the second half of what M25.2
   * fixes: `evaluateWaveGate` fires exactly once on `pending -> running`, so a freeze DECLARED
   * MID-WAVE was previously never seen at all. Memoisation is per tick, so the next tick asks again
   * — which is also how a freeze CLEARS, in one second, with no scheduler and no status flip.
   */
  let freezeHolds: Map<string, FreezeHoldVerdict> | undefined;
  const loadFreezeHolds = async (): Promise<Map<string, FreezeHoldVerdict>> =>
    (freezeHolds ??= await withTenantTx(db, orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId,
        targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
      })
    ));

  /**
   * THE CONTINUOUS-TEST HOLD (increment 8) — resolved ONCE per change per tick, for the WHOLE wave,
   * and memoised exactly like the freeze holds above it, for the same three reasons.
   *
   * ONE CALL FOR THE WAVE, NOT ONE PER TARGET. `evaluateContinuousHolds` opens with a single
   * indexed existence read ("does this org declare any `continuous` hook at all?") and returns an
   * empty map before resolving a single placement when the answer is no. Calling it per target
   * would issue that read per target instead.
   *
   * LAZY: the call sits inside the trigger branch, so a wave that is purely POLLING in-flight
   * targets does not consult hooks at all. A probe going stale cannot withdraw a trigger already
   * made — `ExecutorPlugin` has no pause verb (ADR-0008) — so there is nothing for it to say about
   * a target already in flight. What it withholds is the NEXT trigger.
   *
   * RESOLVED EVERY TICK, never once at the wave boundary. `evaluateWaveGate` fires exactly once on
   * `pending -> running`, so a probe that goes stale MID-WAVE would never be seen there — and
   * freshness is a read-time comparison redone every tick by construction (ADR-0033), which is the
   * whole point of `maxAgeSeconds`. Memoisation is per tick, so the next tick asks again, which is
   * also how a hold CLEARS the second fresh green evidence lands.
   */
  let continuousHolds: Map<string, ContinuousHoldTargetVerdict> | undefined;
  const loadContinuousHolds = async (): Promise<Map<string, ContinuousHoldTargetVerdict>> =>
    (continuousHolds ??= await withTenantTx(db, orgId, (tx) =>
      evaluateContinuousHolds(tx, {
        orgId,
        targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
      })
    ));

  /**
   * THE ONE QUALIFIER ON D7'S ROLLBACK EXEMPTION — see `originalChangeDispatchedTarget`.
   *
   * `false` for every non-rollback change WITHOUT touching the database, so the ordinary path pays
   * nothing; and for a rollback it is asked ONLY about a target a freeze is actually holding, which
   * is the rarest shape on this loop. Memoised per target per tick alongside the hold map itself,
   * because a rollback whose whole wave is frozen would otherwise re-ask once per target per tick
   * for the length of the window.
   */
  const rollbackUndoable = new Map<string, boolean>();
  const rollbackHasSomethingToUndoAt = async (targetObjectId: string): Promise<boolean> => {
    if (!isRollback || !change.rollbackOfObjectId) return false;
    const memo = rollbackUndoable.get(targetObjectId);
    if (memo !== undefined) return memo;
    const dispatched = await withTenantTx(db, orgId, (tx) =>
      originalChangeDispatchedTarget(tx, orgId, change.rollbackOfObjectId!, targetObjectId)
    );
    rollbackUndoable.set(targetObjectId, dispatched);
    return dispatched;
  };

  /** Did any target of this wave reach `triggerWaveTarget` on this tick? The release condition for
   *  the freeze hold's Decision — see `clearFreezeAdmissionHold`. Set BEFORE the call rather than
   *  after it, because a trigger that THREW still handed the target to its executor (the attempt is
   *  durable and the executor may well have started something), and a hold that stayed on record
   *  after that would be the same stale row this release exists to end. */
  let anyTargetTriggered = false;

  /** Every target held this tick, with the verdict that held it — collected across the whole loop so
   *  ONE Decision covers the change rather than one per target. That is not tidiness: `decisions`
   *  are deduped per `(subject_id, kind)` on the LATEST row, so per-target rows for a multi-target
   *  change would alternate, each differing from the one before it, and every tick would write again
   *  — the ADR-0024 flood rebuilt from parts. */
  const heldTargets: {
    targetObjectId: string;
    stage: { componentObjectId: string; deploymentTargetObjectId: string } | null;
    verdicts: StageDependencyVerdict[];
  }[] = [];

  /** Every target this tick that declared a coupling and got NONE — the `unscopeable` branch, where
   *  the wave target names a component rather than a placement so there is no place for a
   *  stage-scoped hold to be scoped by (a legacy-shaped topology, or no resolvable topology at all,
   *  which puts the plan on the toposort path).
   *
   *  COLLECTED SEPARATELY FROM `heldTargets` BECAUSE IT IS NOT A HOLD. This target triggers on this
   *  very tick; ADR-0028 decision 4's fail-open-with-warning branch is what it exercises. But
   *  "proceeded" is not the same as "nothing to say": a change whose author declared a dependency
   *  and received no enforcement at all was, before this, invisible everywhere — `held` was false,
   *  no Decision was written, and the one `console.warn` in the seam fires only for
   *  `weightUnreadable`. Made visible so the fail-open is something an operator can find rather than
   *  something they have to deduce. */
  const unscopeableTargets: { targetObjectId: string; verdicts: StageDependencyVerdict[] }[] = [];

  /** Every target this tick that an active freeze covered (M25.2). Collected separately from
   *  `heldTargets` because the two carry different explanations and write different Decisions —
   *  but they are counted TOGETHER in the terminalization below, and the two sets are DISJOINT BY
   *  CONSTRUCTION because the freeze `continue` fires before the stage-dependency check can run.
   *  If that ordering ever changes, the arithmetic at the bottom of this loop goes negative and a
   *  wave with live targets terminalizes. */
  const frozenTargets: FreezeHoldVerdict[] = [];

  /** Every target this tick whose declared `continuous` probe is holding it (increment 8, D21).
   *  Collected separately from `heldTargets` and `frozenTargets` because all three carry different
   *  explanations and write different Decisions — but ALL THREE are counted together in the
   *  terminalization below, and the three sets are DISJOINT BY CONSTRUCTION because only one
   *  `continue` can fire per target and this one is placed LAST of the three. If that ordering ever
   *  changes, the arithmetic at the bottom of this loop goes wrong in one of the two ways stated
   *  there. */
  const continuousHeldTargets: ContinuousHoldTargetVerdict[] = [];

  for (const target of activeWave.targets) {
    if (target.status === "succeeded") continue;
    if (target.status === "failed" || target.status === "aborted") {
      anyFailed = true;
      continue;
    }
    if (isRefusedWaveTargetStatus(target.status)) {
      // Terminal + a wave failure — reconcile REFUSED to drive this target and already blocked,
      // audited and parked the change when it terminalized the row: a masking executor-binding gap
      // (docs/adr/0006), a tombstoned target object (`target-liveness.ts`), or M25.4's two recipe
      // refusals (`campaign-recipe.ts`). Counts toward `anyFailed` but is NEVER re-triggered (that
      // would duplicate the block Decision + audit event).
      //
      // THE SET IS IMPORTED, NOT RESTATED, and that is the M25.4 change to this branch. It used to
      // name its two statuses as literals, and it is exactly half of a two-place invariant:
      // `wave-targets-repo.ts`'s TERMINAL_WAVE_TARGET_STATUSES is the same list read the other way
      // round. A terminal status added to only one of them falls through to the poll arm below,
      // increments `nonTerminalTargets` forever, and keeps a settled wave alive for the lifetime of
      // the database while its change holds a BATCH_LIMIT slot. Now both derive from
      // `REFUSED_WAVE_TARGET_STATUSES`, so they cannot disagree.
      anyFailed = true;
      continue;
    }

    if (target.status === "pending" || target.status === "triggering") {
      nonTerminalTargets++;
      // BACKOFF GATE — skip a target whose executor refused it recently (see `triggerBackoffMs`).
      // The target is counted as in flight FIRST, deliberately: a backed-off target is still in
      // flight, so the wave must not be treated as complete while one waits. Skipping here (rather
      // than inside `triggerWaveTarget`) also avoids taking the advisory trigger-claim lock and
      // re-reading the binding for a target we already know we are not going to fire this tick.
      //
      // GATED ON `triggering`, NOT ON `attempt` ALONE, and that is a correctness requirement rather
      // than an optimisation: `attempt` is NOT a pure failure counter — `markWaveTargetTriggered`
      // also sets it to 1 on SUCCESS. A target deliberately put back to `pending` to force a fresh
      // re-trigger therefore still carries `attempt: 1` from its successful run, and keying only on
      // the count would silently delay a re-trigger that nothing had refused. Only `triggering`
      // means "claimed, handed to the executor, and not recorded as succeeded" — which is exactly
      // the state a refusal leaves behind.
      const backoffMs = target.status === "triggering" ? triggerBackoffMs(target.attempt) : 0;
      if (backoffMs > 0 && Date.now() - Date.parse(target.updatedAt) < backoffMs) continue;

      // ==========================================================================================
      // THE FREEZE HOLD — M25.2's ACTUATOR (docs/proposals/campaigns-rework.md §1.2)
      // ==========================================================================================
      // THIS `continue` IS THE REFUSAL. Delete it and the target triggers into an active freeze,
      // and every test in `freeze-admission.integration.test.ts` that asserts an executor was never
      // called goes red. Nothing else in this file withholds a trigger for a freeze: the wave gate
      // above now only blocks the ALL-frozen wave.
      //
      // FIVE INVARIANTS, each with a named prior incident. Every one is load-bearing:
      //
      //   1. COUNTED FIRST. `nonTerminalTargets++` happened at the top of this branch, BEFORE this
      //      `continue`. A frozen target is still in flight. Copied verbatim from the backoff gate
      //      and from ADR-0028's hold below, and for the same reason: without it a wave whose only
      //      remaining target is frozen marks itself `succeeded` and the change completes green
      //      with a target that never ran — silent-success masking, the class ADR-0006 exists to
      //      prevent.
      //   2. BEFORE `triggerWaveTarget`. No advisory trigger-claim lock is taken and no executor
      //      binding is re-read for a call we are not going to make. `attempt` therefore stays 0 on
      //      a target held from its first tick, which is what the actuator test measures.
      //   3. THE ROLLBACK EXEMPTION (owner decision D7), AND ITS ONE QUALIFIER.
      //      `evaluateLifecycleGate` already exempts rollbacks (`gates.ts` — DESIGN §9.4, "no
      //      human-review step to wait for"), but `EvaluateWaveGateContext` carried no `isRollback`
      //      at all, so a rollback's wave targets were freeze-blocked. Holding a rollback pins a
      //      BROKEN RELEASE in place for the whole window — the one change a freeze most wants to
      //      let through. This is a change that newly permits, which is why it is an owner decision
      //      and gets a test in both directions.
      //
      //      The qualifier is `rollbackHasSomethingToUndoAt` below: D7's reasoning is about a
      //      target the broken release ACTUALLY REACHED, and per-target admission makes the other
      //      case reachable for the first time (freeze holds `amer`, a sibling ships and fails,
      //      `autoRollbackOnFailure` mints a rollback over ALL FOUR original targets). Exempting
      //      `amer` there would dispatch an unattended executor call into a declared freeze to undo
      //      a release that never happened. See that function for the full chain.
      //   4. BEFORE THE STAGE-DEPENDENCY HOLD. Only one `continue` can fire, so the two hold sets
      //      are DISJOINT BY CONSTRUCTION — which is exactly what the terminalization arithmetic at
      //      the bottom of this loop depends on. Stated consequence: a target that is both frozen
      //      and dependency-held records only the freeze this tick, and resumes producing
      //      `stage_dependency` verdicts the tick the freeze lifts. A frozen target should also not
      //      spend a graph read per tick on a coupling it cannot act on either way.
      //   5. AFTER THE BACKOFF GATE. A `triggering` target has ALREADY been handed to its executor.
      //      `ExecutorPlugin` is observe/trigger/status/abort and nothing else (ADR-0008 forbids
      //      adding a pause verb), so a freeze cannot un-ring that bell. What it withholds here is
      //      the RETRY, not the original call. That is the honest boundary of what a freeze buys,
      //      and for a `pending` target — every first trigger, the case this is about — `backoffMs`
      //      is 0 and the two orders are identical anyway.
      //
      //      AND ITS SECOND QUALIFIER, `rollbackExemptible` (M25.3 review finding 1). D7 is an
      //      ORG-TIER decision: a PLATFORM freeze is never stood aside for a rollback. Shipped
      //      tier-blind, this line was the CHEAPEST of the two routes past a freeze that `checkFreeze`
      //      tells the caller "no tenant role can override, however privileged" — `POST
      //      /v1/changes/{id}/rollback` requires `object:write` at the org and nothing else, so it
      //      needed neither `freeze:override`, nor a reason, nor the operator token. It is the same
      //      one predicate `gate-orchestrator.ts`'s `freezeExemptRollback` consults, deliberately: two
      //      seams enforcing one rule must not be two copies of it. Reading `frozen.freezes` (which
      //      already carries every freeze HOLDING this target, including one that only reaches it
      //      because a SIBLING is covered by an `atomic` freeze) is what makes the atomic case fall
      //      out with no extra branch.
      const frozen = (await loadFreezeHolds()).get(target.targetObjectId);
      if (
        frozen &&
        !(
          rollbackExemptible(frozen.freezes) &&
          (await rollbackHasSomethingToUndoAt(target.targetObjectId))
        )
      ) {
        frozenTargets.push(frozen);
        continue;
      }

      // STAGE-DEPENDENCY HOLD (ADR-0028 decision 2) — withhold this target's trigger while a
      // dependency of its component is not yet satisfied AT THIS PLACE: one its own CI declared, or
      // a plain `depends_on` edge to another target of this same change (decision 6 — the set the
      // removed compile-time refusal covered). The two invariants of the
      // backoff gate above are copied verbatim and are load-bearing for the same reasons:
      //
      //   1. The target was already counted in `nonTerminalTargets` at the top of this branch,
      //      BEFORE this `continue`. A held target is still in flight; without that the wave would
      //      be marked terminal and the change would complete while one of its targets had never
      //      run. What that count must NOT do is keep an already-FAILED wave alive forever — see
      //      the terminalization at the bottom of this loop, which is why the count is a number.
      //   2. The skip happens BEFORE `triggerWaveTarget`, so a held target takes no advisory
      //      trigger-claim lock and re-reads no executor binding for a call it is not going to make.
      //
      // WHY HERE AND NOWHERE ELSE. Not the wave gate: `evaluateWaveGate` issues ONE verdict for the
      // whole wave with no target dimension, and in stage mode a dependent pair at the same place is
      // in that same wave — so blocking the gate to hold A would also hold B, the dependency could
      // never clear, and both would park forever. It also fires exactly once, on pending -> running,
      // so it could not re-evaluate a hold even if it were per-target. Not the `waiting`/`requires`
      // engine either: that parks the WHOLE change on `coordinated -> executing`, so A would be held
      // out of dev because B is behind in gamma.
      //
      // AND WHY AFTER THE BACKOFF GATE, not before: a backed-off target is `triggering`, which means
      // it has ALREADY been handed to its executor. Re-deciding its coupling cannot un-ring that
      // bell, and evaluating it would spend a graph read per tick on a target that is not going to
      // fire this tick anyway. For a `pending` target — every first trigger, which is the case the
      // coupling is about — `backoffMs` is 0 and the two orders are identical.
      const edgeDependencies = await loadInTargetSetEdges();
      if (
        declared.stageDependencies.length > 0 ||
        declared.malformed.length > 0 ||
        edgeDependencies.length > 0
      ) {
        const evaluation = await withTenantTx(db, orgId, (tx) =>
          evaluateStageDependencies(tx, {
            orgId,
            waveTargetObjectId: target.targetObjectId,
            stageDependencies: declared.stageDependencies,
            malformed: declared.malformed,
            edgeDependencies
          })
        );
        // DECLARED A COUPLING AND GOT NONE (ADR-0028 decision 4's fail-open-with-warning branch).
        // Collected BEFORE the hold check, not after: a malformed entry holds even on a legacy-
        // shaped target, so `held` and `unscopeable` are not mutually exclusive and an `else` here
        // would lose exactly the case where both are true.
        const unscopeable = evaluation.verdicts.filter((v) => v.branch === "unscopeable");
        if (unscopeable.length > 0) {
          unscopeableTargets.push({
            targetObjectId: target.targetObjectId,
            verdicts: unscopeable
          });
        }
        if (evaluation.held) {
          heldTargets.push({
            targetObjectId: target.targetObjectId,
            stage: evaluation.stage,
            verdicts: evaluation.verdicts
          });
          continue;
        }
        // PROCEEDING, but a weight qualifier the author wrote was never consulted (not ArgoCD,
        // blue/green, the extra call failed, or the reading has gone stale). Logged rather than
        // recorded, because there is no hold and therefore no Decision to carry it — and it is at
        // most one line per target, since this target triggers on this very tick.
        for (const verdict of evaluation.verdicts) {
          if (verdict.weightUnreadable === undefined) continue;
          console.warn(
            `[reconcile] org ${orgId} change ${change.objectId} target ${target.targetObjectId}: declared minWeight ${verdict.minWeight} on '${verdict.dependsOn}' could not be evaluated (${verdict.weightUnreadable}) — fell back to requiring its deploy here to have succeeded`
          );
        }
      }

      // ==========================================================================================
      // THE CONTINUOUS-TEST HOLD (increment 8, D21) — THIS `continue` IS THE REFUSAL
      // ==========================================================================================
      // Delete it and a target whose canary probe has gone stale, has never reported, or last
      // reported FAILED triggers anyway, and every test in
      // `pipeline-hook-admission.integration.test.ts` that asserts a held target's status stays
      // `pending` goes red. Nothing else in this file withholds a trigger for probe freshness: the
      // wave gate deliberately never sees `continuous` at all (`pipeline-hook-gate.ts` asserts it).
      //
      // WHY A HOLD AND NOT A GATE, in one sentence, because it is the entire design:
      // `pipeline-behaviors.ts`'s mechanism table — "a stale canary probe on target A says nothing
      // about target B, so blocking B would be a lie about what is known". SIBLINGS MUST PROCEED,
      // and that has its own integration test rather than being left as an emergent property.
      //
      // THREE INVARIANTS, each copied verbatim from the two holds above and each load-bearing:
      //
      //   1. COUNTED FIRST. `nonTerminalTargets++` happened at the top of this branch, BEFORE this
      //      `continue`. A held target is still in flight; without that, a wave whose only remaining
      //      target is held marks itself `succeeded` and the change completes green with a target
      //      that never ran — silent-success masking, the class ADR-0006 exists to prevent.
      //   2. BEFORE `triggerWaveTarget`. No advisory trigger-claim lock is taken and no executor
      //      binding is re-read for a call we are not going to make, so `attempt` stays 0 on a
      //      target held from its first tick.
      //   3. LAST OF THE THREE HOLDS — after the freeze `continue` and after the stage-dependency
      //      one. Only one `continue` can fire per target, so the three hold sets stay DISJOINT BY
      //      CONSTRUCTION, which is exactly what the terminalization arithmetic at the bottom of
      //      this loop depends on. Stated consequence, the same one the freeze hold states: a
      //      target that is both frozen and probe-held records only the freeze this tick, and
      //      starts producing `continuous_test` verdicts the tick the freeze lifts. Ordering it
      //      before the freeze would also spend a hook read per tick on a target no evidence could
      //      release, and would make a frozen target's Decision name the wrong reason.
      //
      // AND AFTER THE BACKOFF GATE, for the reason both holds above state: a `triggering` target
      // has already been handed to its executor and no hold can un-ring that bell. For a `pending`
      // target — every first trigger, the case this is about — `backoffMs` is 0 and the orders are
      // identical anyway.
      const probeHeld = (await loadContinuousHolds()).get(target.targetObjectId);
      if (probeHeld) {
        continuousHeldTargets.push(probeHeld);
        continue;
      }

      try {
        // `anyTargetTriggered` is what gates the freeze hold's RELEASE row below (§1.5): a hold
        // clears on the tick a previously-held target actually reaches its executor, which is the
        // one tick on which "the window closed" is an observation rather than a guess.
        anyTargetTriggered = true;
        await triggerWaveTarget(
          db,
          orgId,
          change,
          activeWave.id,
          target.id,
          target.targetObjectId,
          // WHICH pipeline this target rolls (M12 P4A / ADR-0007) — the routing Type, snapshotted
          // onto the wave target at plan time from the change's source mapping. This is what makes a
          // non-default binding triggerable.
          (target.type as ExecutorType | null) ?? DEFAULT_BINDING_TYPE,
          isRollback,
          recipe,
          host,
          masterKey
        );
      } catch (err) {
        // "next tick" was true until the backoff landed and is not any more — a refused trigger now
        // waits `triggerBackoffMs(attempt)`. The retry delay is stated because it is the operator's
        // main cue that a repeatedly-refused target is stepping aside rather than stuck: a log line
        // that reappeared every second was itself part of the storm this fixes.
        const nextDelayMs = triggerBackoffMs(target.attempt + 1);
        console.error(
          `[reconcile] org ${orgId} change ${change.objectId} target ${target.targetObjectId} trigger failed (retry in ~${Math.round(nextDelayMs / 1000)}s):`,
          err
        );
      }
      continue;
    }

    // triggered or observing: poll.
    if (!target.executorRef) {
      // Shouldn't happen (triggered/observing always carry the ref markWaveTargetTriggered set) —
      // defensive no-op; next tick will see the same state and try again.
      nonTerminalTargets++;
      continue;
    }
    try {
      // `module` is deliberately not destructured — the poll path must not read it (see the helper's
      // fall-back branch, where a persisted id's module is unknowable).
      const { instanceId } = await ensureExecutorInstanceStarted(
        db,
        orgId,
        host,
        target.targetObjectId,
        // The status poll must address the SAME instance the trigger used, so it resolves the same
        // Type — otherwise it would poll the wrong pipeline for this run's ref.
        (target.type as ExecutorType | null) ?? DEFAULT_BINDING_TYPE,
        target.executorPluginId ?? null,
        masterKey
      );
      const client = host.executor(instanceId);
      const status = await client.status(target.executorRef as ExecutorRef);
      // Persist BOTH the synced revision (ADR-0008 decision 1 — the stateRef reconcile previously
      // discarded) AND the deployed image refs (decision 2 — status().observed.images) this poll
      // observed. `undefined` when status() reports neither, so a never-synced app never nulls a
      // previously-captured value.
      const observedState = observedStateFrom(status);
      if (status.phase === "succeeded") {
        await withTenantTx(db, orgId, (tx) =>
          updateWaveTargetObserved(tx, orgId, target.id, "succeeded", observedState)
        );
      } else if (status.phase === "failed" || status.phase === "aborted") {
        anyFailed = true;
        const phase = status.phase;
        await withTenantTx(db, orgId, async (tx) => {
          await updateWaveTargetObserved(tx, orgId, target.id, phase, observedState);
          await insertDecision(tx, {
            orgId,
            kind: "wave_target",
            subjectId: change.objectId,
            verdict: "block",
            inputContext: {
              waveId: activeWave.id,
              targetObjectId: target.targetObjectId,
              phase,
              // BOUNDED BEFORE IT BECOMES A ROW. `ExecutionStatus.detail` is free-form `string`
              // supplied by ANY executor plugin — including third-party ones this repository does
              // not compose the string for — and this `inputContext` is a `Decision`, i.e. permanent
              // governed state. An unbounded `detail` here is an unbounded DATABASE row per poll,
              // the same family as the 1.44 GB/day Decision growth incident. The managed plugins
              // already bound their own (`@scp/runner-launcher`'s `boundDetail`, enforced by their
              // stores' types), so for them this is the IDENTITY — that is the property that makes
              // a second application safe rather than a fourth different slice: one bound, applied
              // at each trust boundary, keeping both ends.
              detail: status.detail === undefined ? null : boundDetail(status.detail)
            },
            reasonTree: { summary: `wave target ${target.targetObjectId} reported '${phase}'` }
          });
        });
      } else {
        nonTerminalTargets++;
        await withTenantTx(db, orgId, (tx) =>
          updateWaveTargetObserved(tx, orgId, target.id, "observing", observedState)
        );
      }
    } catch (err) {
      nonTerminalTargets++; // still in flight as far as we know — polled again next tick
      console.error(
        `[reconcile] org ${orgId} change ${change.objectId} target ${target.targetObjectId} poll failed (will retry next tick):`,
        err
      );
    }
  }

  if (unscopeableTargets.length > 0) {
    await recordStageDependencyUnscoped(db, orgId, change, activeWave, unscopeableTargets);
  }

  if (heldTargets.length > 0) {
    await recordStageDependencyHold(db, orgId, change, activeWave, heldTargets);
  }

  if (frozenTargets.length > 0) {
    await recordFreezeAdmissionHold(db, orgId, change, activeWave, frozenTargets);
  } else if (anyTargetTriggered) {
    await clearFreezeAdmissionHold(db, orgId, change, activeWave);
  }

  if (continuousHeldTargets.length > 0) {
    await recordContinuousHold(db, orgId, change, activeWave, continuousHeldTargets);
  } else if (anyTargetTriggered) {
    await clearContinuousHold(db, orgId, change, activeWave);
  }

  // TERMINALIZATION, IN TWO RULES RATHER THAN ONE — because a held target is in flight (invariant 1
  // above) and a single `if (!allTerminal) return` therefore kept an already-FAILED wave alive
  // forever. A wave with one failed target and one held one never reached `markWaveTerminal`, so the
  // `failed` branch at the top of this function never ran: no `autoRollbackOnFailure`, no park, no
  // epitaph, no failure recorded on the change, while the hold's cursor bump re-served the
  // change every tick and occupied a `BATCH_LIMIT` slot permanently. That was a REGRESSION on the
  // loud 400 the compile-time same-wave refusal used to give this exact shape (ADR-0028 decision 6).
  //
  // Holding a dependant on a doomed wave buys nothing — its dependency is not going to arrive in
  // THIS wave, and the wave's verdict is already decided — so the hold stops keeping it open. The
  // test is `anyFailed`, NOT the `failed` literal, so `aborted` and `no_executor` (both of which
  // mark a wave failed, and neither of which ever ran) are covered by the same line.
  //
  // The held target is still NEVER TRIGGERED on the way there, which is the whole point of the hold:
  // it is left `pending` on a terminal wave — the truthful record, since no executor was ever handed
  // it — and from the next tick on the `failed` branch returns before this loop is reached at all.
  // Its hold Decision was written just above, so what kept it from running stays on record beside
  // the failure that ended the wave.
  //
  // M25.2 ADDS A SECOND HOLD SET TO BOTH LINES, and getting either one wrong is the sharpest
  // regression risk in that increment:
  //
  //   * Miss it in the FIRST guard and `nonTerminalTargets - heldCount` goes NEGATIVE (a frozen
  //     target is counted in `nonTerminalTargets` but not in the subtrahend, or the reverse), the
  //     guard passes, and a wave with genuinely live targets terminalizes.
  //   * Miss it in the SECOND and a wave whose only remaining targets are frozen falls through to
  //     `markWaveTerminal(..., "succeeded")` — the wave completes GREEN with a target that was
  //     never deployed. Silent-success masking, the class ADR-0006 exists to prevent.
  //
  // The two sets are DISJOINT BY CONSTRUCTION: the freeze `continue` in the loop above fires
  // before the stage-dependency evaluation can run, so no target can appear in both. That is a
  // property of the ordering, not of the data, which is why it is stated at both places.
  // INCREMENT 8 ADDS A THIRD HOLD SET TO BOTH LINES, and the two failure modes M25.2 named for the
  // second one apply unchanged to it: miss it here and `nonTerminalTargets - heldCount` goes wrong,
  // the guard passes, and a wave with genuinely live targets terminalizes; miss it in the SECOND
  // guard below and a wave whose only remaining targets are probe-held falls through to
  // `markWaveTerminal(..., "succeeded")` — the wave completes GREEN with a target that was never
  // deployed. All three sets are DISJOINT BY CONSTRUCTION (one `continue` per target, in a fixed
  // order), which is a property of the ordering rather than of the data — which is why it is stated
  // at all four places.
  const heldCount = heldTargets.length + frozenTargets.length + continuousHeldTargets.length;
  if (nonTerminalTargets - heldCount > 0) {
    // ROUND-ROBIN BUMP (4 of 5) — THE FIFTH INSTANCE OF THE STARVATION CLASS, and the one the
    // gate-blocked bump ~300 lines up does NOT cover. That bump fires only while the wave is still
    // `pending`. The moment the gate ALLOWS, `markWaveRunning` moves the wave to `running` and
    // every subsequent tick of that change skips the gate branch entirely and arrives HERE instead
    // — and every write on the way here lands on `change_wave_targets` (`markWaveTargetTriggered`,
    // `updateWaveTargetObserved`) or on `change_waves`, never on `changes`. There are exactly four
    // other `UPDATE changes` in this file (waiting, validating, gate-blocked, and the hold) and not
    // one of them is on this path.
    //
    // So a change whose wave targets are merely being POLLED — an Argo CD Application stuck
    // `Progressing`, a workflow awaiting a manual step, any executor whose `status()` never
    // terminalizes — freezes its cursor at the instant it entered `executing` and never moves it
    // again. `listChangeRowsInStates` serves oldest-`reconcile_cursor_at`-first capped at
    // BATCH_LIMIT, so more than BATCH_LIMIT such changes own every slot of every tick forever and
    // EVERY CHANGE QUEUED BEHIND THEM IS NEVER EVALUATED EVEN ONCE. That is the same 13-day
    // production outage (homelab, 2026-08-01) the gate-blocked comment above records, one branch
    // over: the fix went to the branch that was measured, not to the property.
    //
    // WIDER THAN POLLING, deliberately. Every `continue` above that leaves a target non-terminal
    // reaches this line without writing `changes`: the backoff-skipped `triggering` target, a
    // target whose poll THREW, a freshly-triggered target, and the defensive missing-`executorRef`
    // case. The condition here is "this change took its turn and is still in flight", which is
    // exactly the condition the round-robin needs.
    //
    // UNCONDITIONAL, even though `recordStageDependencyHold` may already have bumped this same row
    // a few lines above (a wave with one held target and one in-flight target reaches both). One
    // redundant narrow UPDATE on that uncommon shape is a better trade than making this guarantee
    // depend on a call several lines up staying where it is.
    //
    // NOT THE ADR-0024 FLOOD, and the difference is worth stating rather than leaving a reader to
    // wonder. ADR-0024's measured 1.44 GB/day was a byte-identical Decision INSERT per tick per
    // parked change: a NEW row each time, carrying the gate's whole `inputContext` + `reasonTree`,
    // retained indefinitely. This is one in-place `UPDATE changes SET reconcile_cursor_at` on a row
    // that already exists — no append, no growth, nothing to retain or prune, and still a HOT
    // update, which is why 0058 deliberately left the new column un-indexed. It is not even a new
    // write in the tick: reaching this line means the loop above already wrote at least one
    // `change_wave_targets` row for this change (a poll restamps `last_observed_at`; a trigger
    // writes the claim and the ref), so the per-tick write count goes N -> N+1, not 0 -> 1. And
    // there is deliberately NO Decision on this path: nothing here is a verdict about the change,
    // only a queue position, and inventing a Decision for it is precisely how ADR-0024 happened.
    //
    // NOTHING BUT THE CURSOR IS TOUCHED — identical to the waiting, validating, gate-blocked and
    // hold bumps, and this path is the clearest illustration of why migration 0058 split the
    // column. `state_entered_at` stays put because the watchdog's stall SLA must keep measuring
    // from when the change actually entered `executing`, or a change that polls forever would look
    // permanently fresh and never be reported as stalled. `updated_at` stays put for the operator's
    // version of the same argument: a canary parked at 10% for three days, polled once a second, is
    // a change that has not changed in three days, and saying "updated 1s ago" 259,200 times in a
    // row is the scheduler talking over the only field an operator can read.
    await withTenantTx(db, orgId, (tx) =>
      tx
        .update(changes)
        .set({ reconcileCursorAt: new Date() })
        .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)))
    );
    return; // something is genuinely still running
  }
  if (heldCount > 0 && !anyFailed) return; // the PURE hold: unchanged, still in flight
  await withTenantTx(db, orgId, (tx) =>
    markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded")
  );
}

/**
 * The explainability half of the stage-dependency hold (charter principle 6): a held target carries a
 * Decision naming the dependency, the place, and WHICH of ADR-0028 decision 4's branches applied. The
 * backoff gate beside it writes nothing at all today, so this is a strict improvement in the same
 * loop — but it is also the exact seam that produced this project's worst production incident, so
 * three properties are non-negotiable.
 *
 * ONE DECISION PER CHANGE, NOT PER TARGET. `insertDecisionIfChanged` compares against the LATEST row
 * of the same `(subject_id, kind)`. Two held targets writing their own rows would alternate — each
 * row differing from the one before it — and suppression would never fire once. Aggregating makes
 * the statement "these targets are held, for these reasons", which is stable exactly while the
 * situation is.
 *
 * CONTENT-STABLE INPUTS. No wall clock, and no observed weight (see `StageDependencyVerdict`). What
 * DOES vary is `dependencyStatus`, and deliberately: a dependency walking pending -> triggered ->
 * observing is a genuinely different explanation each time, and that is a handful of rows over a
 * hold's whole life, not one per 1 s tick. Targets are sorted so a reordered `activeWave.targets`
 * can never make an unchanged situation look new.
 *
 * PERSIST ON CHANGE. Measured: a byte-identical Decision rewritten every tick reached 1.44 GB/day
 * across 25 parked changes on the live homelab (ADR-0024). The evaluation still runs every tick —
 * that is the only thing that notices the dependency finishing — only the redundant WRITE is
 * suppressed.
 *
 * THE `reconcile_cursor_at` BUMP IS NOT OPTIONAL, and it is the same starvation fix the
 * gate-blocked branch above documents. A change whose targets are all held stays `executing` with
 * its wave `running`, so nothing else moves its cursor; `listChangeRowsInStates` serves
 * oldest-`reconcile_cursor_at`-first capped at `BATCH_LIMIT`, so more than `BATCH_LIMIT` held
 * changes would occupy every slot of every tick forever and every change queued behind them would
 * never be evaluated even once. That is not a hypothetical: the identical property stopped all
 * coordination on the homelab for 13 days behind green health checks. `state_entered_at` is
 * deliberately untouched, so the watchdog's stall SLA keeps measuring from when the change actually
 * entered `executing` — and since migration 0058 `updated_at` is untouched too, so a held change
 * does not advertise itself to an operator as freshly updated every tick it spends held.
 *
 * THE VERDICT IS `hold`, NOT `block`, and that is a deliberate correctness choice rather than a
 * naming preference. `latestBlockDecisionForSubject` (`decisions-repo.ts`) selects the newest row
 * with `verdict = 'block'` for a subject, filtered on the verdict ALONE — no kind, no recency, no
 * change-state gate — and `service-board.ts`'s `isBlocked = hasFailedWave || blockDecision !==
 * undefined` feeds it straight into a component row's `attention.blocked` and the board's `blocked`
 * tally. Nothing ever writes a clearing row. So a `block` here would mark the component blocked
 * PERMANENTLY: after the hold released, after the change reached `accepted`, forever.
 *
 * That is tolerable for the other nineteen `verdict: "block"` writers, because each fires when
 * something is genuinely stuck and wants an operator. This one fires on EVERY coupled release, by
 * design — a brief, expected, self-clearing wait is the feature working. Reusing `block` would make
 * the board's attention signal permanently wrong for exactly the components that adopted the
 * feature, which is worse than useless: it trains operators to ignore the field.
 *
 * A held change still reads honestly on the board without it — it is in `executing`, so it counts as
 * `releasing`, which is what it is doing. And a hold that is genuinely stuck is not silent: the
 * watchdog's `executing` SLA still fires, and `scp change explain` still shows this Decision with the
 * unsatisfied dependency named. The fix belongs here rather than in the shared query because
 * `latestBlockDecisionQuery`'s `eq(decisions.verdict, "block")` must stay a compile-time constant
 * matching `drizzle/0046`'s partial-index predicate verbatim (its own comment says so at length).
 */
async function recordStageDependencyHold(
  db: Db,
  orgId: string,
  change: ChangeRow,
  activeWave: { id: string; waveIndex: number },
  heldTargets: {
    targetObjectId: string;
    stage: { componentObjectId: string; deploymentTargetObjectId: string } | null;
    verdicts: StageDependencyVerdict[];
  }[]
): Promise<void> {
  const held = [...heldTargets]
    .sort((a, b) => a.targetObjectId.localeCompare(b.targetObjectId))
    .map((entry) => ({
      targetObjectId: entry.targetObjectId,
      componentObjectId: entry.stage?.componentObjectId ?? null,
      deploymentTargetObjectId: entry.stage?.deploymentTargetObjectId ?? null,
      dependencies: entry.verdicts
    }));

  const firstHold = await withTenantTx(db, orgId, async (tx) => {
    const recorded = await insertDecisionIfChanged(tx, {
      orgId,
      kind: "stage_dependency",
      subjectId: change.objectId,
      verdict: "hold",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held },
      reasonTree: {
        summary: `${held.length} wave target(s) held: a stage dependency is not yet satisfied at that deployment-target`,
        blocked: held.flatMap((entry) =>
          entry.dependencies
            .filter((verdict) => !verdict.satisfied)
            .map(
              (verdict) => `target ${entry.targetObjectId}: ${describeStageDependencyHold(verdict)}`
            )
        )
      }
    });
    // The round-robin bump (5 of 5), in the SAME transaction as the Decision so a hold can never be
    // recorded without its change also being moved to the back of the queue. `reconcile_cursor_at`
    // ONLY: a held change is one whose targets were deliberately NOT triggered, so there is nothing
    // about it that `updated_at` should claim has changed.
    await tx
      .update(changes)
      .set({ reconcileCursorAt: new Date() })
      .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)));
    return recorded;
  });

  // Logged exactly once per distinct hold, on the tick that actually persisted it — `created` is the
  // same signal the gate-blocked log line uses, and for the same reason: a target held for a week is
  // one line, not 604,800.
  if (firstHold.created) {
    console.info(
      `[reconcile] org ${orgId} change ${change.objectId} wave ${activeWave.waveIndex}: ${held.length} target(s) held by a stage dependency — decision ${firstHold.decision.id} (scp decision get ${firstHold.decision.id}); re-evaluated every tick until it clears`
    );
  }
}

/**
 * THE EXPLAINABILITY HALF OF THE FREEZE HOLD (M25.2, charter principle 6) — and the
 * anti-write-amplification contract that makes it safe to write from a 1 s loop.
 *
 * Four properties, each defending a named prior incident. All four are copied from
 * `recordStageDependencyHold` above, which is the point: this is the same seam one mechanism over,
 * and it is the seam that produced this project's worst production incident.
 *
 * `kind: "freeze_admission"`, DISTINCT FROM `"gate"`. `insertDecisionIfChanged` compares against
 * the LATEST row of the same `(subject_id, kind)`. Sharing `gate` would make these rows and the
 * wave gate's own rows for the same change ALTERNATE — each differing from the one before it — and
 * suppression would never fire once. That is ADR-0024's measured 1.44 GB/day rebuilt from parts.
 *
 * `verdict: "hold"`, NEVER `"block"`. `latestBlockDecisionForSubject` selects the newest row with
 * `verdict = 'block'` for a subject, filtered on the VERDICT ALONE — no kind, no recency, no
 * change-state gate — and `service-board.ts` feeds it straight into a component row's
 * `attention.blocked`. Nothing ever writes a clearing row. A `block` here would mark the component
 * blocked permanently: after the freeze lifted, after the change was accepted, forever. And unlike
 * the nineteen other `block` writers, this one fires on EVERY release into a frozen window BY
 * DESIGN, so it would make the attention signal permanently wrong for exactly the orgs that use
 * freezes.
 *
 * ONE ROW PER CHANGE, NOT PER TARGET. Per-target rows for a four-region wave would alternate under
 * the same `(subject_id, kind)` comparison and suppression would never fire. `subjectId` is the
 * CHANGE, and the held set is an array inside one `inputContext`.
 *
 * `endsAt`, NEVER `now`. The freeze's own window boundary is in the context and the clock is not —
 * `gate-orchestrator.ts`'s trick, copied exactly. Every field written here is a uuid, a small
 * integer, a type-id string, a freeze name, or an ISO instant read straight off `freezes.ends_at`;
 * none is derived from `Date.now()`, `attempt`, or an observed weight. BOTH SORTS (targets by
 * `targetObjectId` here, freezes by id in `freeze-hold.ts`) are load-bearing for the same reason: a
 * reordered `activeWave.targets` must not make an unchanged situation look new. So tick N+1 produces
 * a byte-identical candidate, `restatesDecision` is true, and nothing is written. A three-week
 * freeze over a held change is ONE row, not 1.8 million.
 *
 * THE `reconcile_cursor_at` BUMP IS NOT OPTIONAL, and it goes in the SAME transaction as the
 * Decision so a hold can never be recorded without its change also moving to the back of the queue.
 * A change whose targets are all frozen stays `executing` with its wave `running`, so nothing else
 * writes its row; `listChangeRowsInStates` serves oldest-`reconcile_cursor_at`-first capped at
 * `BATCH_LIMIT`, so more than `BATCH_LIMIT` frozen changes would own every slot of every tick and
 * every change queued behind them would never be evaluated even once. That is not hypothetical: the
 * identical property stopped all coordination on the homelab for 13 days behind green health
 * checks. This is bump 6 of 6, and `candidate-loop-registry.test.ts` is the CI gate that notices if
 * it goes missing — its `advanceExecutingChanges` entry names this function and counts this bump.
 * `state_entered_at` and `updated_at` are deliberately untouched (migration 0058's split): the
 * watchdog's stall SLA must keep measuring from when the change entered `executing`, and a frozen
 * change must not advertise itself to an operator as freshly updated every second it waits.
 */
async function recordFreezeAdmissionHold(
  db: Db,
  orgId: string,
  change: ChangeRow,
  activeWave: { id: string; waveIndex: number },
  frozenTargets: FreezeHoldVerdict[]
): Promise<void> {
  const held = describeHeldTargets(frozenTargets);

  const firstHold = await withTenantTx(db, orgId, async (tx) => {
    const recorded = await insertDecisionIfChanged(tx, {
      orgId,
      kind: "freeze_admission",
      subjectId: change.objectId,
      verdict: "hold",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held },
      reasonTree: {
        summary: `${held.length} wave target(s) held: an active freeze covers that scope — siblings proceed`,
        held: frozenTargets
          .map((verdict) => describeFreezeHold(verdict))
          .sort((a, b) => a.localeCompare(b))
      }
    });
    await tx
      .update(changes)
      .set({ reconcileCursorAt: new Date() })
      .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)));
    return recorded;
  });

  // Logged exactly once per distinct hold, on the tick that actually persisted it — the same
  // `created` signal the gate-blocked and stage-dependency log lines use, and for the same reason:
  // a target frozen for a fortnight is one line, not 1,209,600.
  if (firstHold.created) {
    console.info(
      `[reconcile] org ${orgId} change ${change.objectId} wave ${activeWave.waveIndex}: ${held.length} target(s) held by an active freeze — decision ${firstHold.decision.id} (scp decision get ${firstHold.decision.id}); re-evaluated every tick until the window closes`
    );
  }
}

/**
 * HOLD -> RELEASE (proposal §1.5) — the clearing counterpart ADR-0028's stage-dependency hold does
 * NOT have, and the omission `routes/changes.ts` had to work around.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, stated verbatim by the file that already hit it
 * (`routes/changes.ts`, on the `stage_dependency` Decision): *"that row is a historical record with
 * no clearing counterpart, so it still says `hold` long after the hold released"*. A freeze holds
 * `amer` for two hours, the window closes, `amer` ships, the change completes — and the newest
 * `freeze_admission` row for that change still reads `hold`, naming a freeze whose `endsAt` is in
 * the past, with nothing in `scp change explain` contradicting it. ADR-0028 paid for that lesson by
 * adding a re-evaluated `resolveStageDependencyStatus` beside the raw Decision list; M25.2 copied
 * the hold's shape from that seam, so it copies the fix too — in the cheaper of the two available
 * forms, because a freeze hold (unlike a dependency) has an unambiguous release EVENT to hang a row
 * on: the tick a target actually reached its executor with nothing held.
 *
 * THREE GUARDS, so this cannot become a writer:
 *
 *   1. It is called ONLY on a tick where `frozenTargets` is empty AND some target triggered. A
 *      change that was never held never reaches this function at all.
 *   2. It READS the latest `(subject_id, kind)` row first and returns unless that row is a `hold`.
 *      So the release is written at most once per hold, not once per subsequent trigger.
 *   3. `insertDecisionIfChanged` is used anyway, so even if both guards were somehow defeated the
 *      second identical release would be suppressed. Belt, braces, and the ADR-0024 lesson.
 *
 * NO CURSOR BUMP, deliberately, and it is the one function in this file's Decision-writing family
 * without one: reaching here means a target was triggered on this very tick, so
 * `markWaveTargetTriggered` has already written `change_wave_targets` and the terminalization
 * arithmetic below bumps `reconcile_cursor_at` for a wave still in flight. There is no
 * not-advanced path here to starve. `candidate-loop-registry.test.ts` counts the bumps that DO
 * exist; this function is deliberately absent from its `bumpIn` list.
 *
 * `held: []` AND THE SAME `kind`, so `scp change explain` shows the pair — hold, then release —
 * under one filter rather than making an operator correlate two vocabularies. `verdict: "allow"`
 * (never `"block"`, for the reason `recordFreezeAdmissionHold` states at length).
 */
async function clearFreezeAdmissionHold(
  db: Db,
  orgId: string,
  change: ChangeRow,
  activeWave: { id: string; waveIndex: number }
): Promise<void> {
  await withTenantTx(db, orgId, async (tx) => {
    const latest = await latestDecisionForSubjectKind(
      tx,
      orgId,
      change.objectId,
      "freeze_admission"
    );
    if (!latest || latest.verdict !== "hold") return;
    await insertDecisionIfChanged(tx, {
      orgId,
      kind: "freeze_admission",
      subjectId: change.objectId,
      verdict: "allow",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held: [] },
      reasonTree: {
        summary:
          "no wave target is held by a freeze any more — the window closed (or the freeze was " +
          "lifted) and the previously-held target has been handed to its executor",
        releases: latest.id
      }
    });
  }).catch((err) => {
    // Best effort, exactly like the hold's own logging: failing to record that a hold RELEASED must
    // never fail the tick that released it. The next trigger on this change retries.
    logChangeError(orgId, change, "freeze-admission-release", err);
  });
}

/**
 * THE EXPLAINABILITY HALF OF THE CONTINUOUS-TEST HOLD (increment 8, charter principle 6).
 *
 * Every property `recordFreezeAdmissionHold` states applies here verbatim, so the reasoning is not
 * repeated — only what is DIFFERENT, and the one thing that is specific to this hold.
 *
 * ITS OWN `kind`, `continuous_test`, never shared with `gate` or `freeze_admission`.
 * `insertDecisionIfChanged` compares against the LATEST row of the same `(subject_id, kind)`, so
 * two mechanisms sharing a kind would make their rows ALTERNATE — each differing from the one
 * before it — and suppression would never fire once. That is ADR-0024's measured 1.44 GB/day
 * rebuilt from parts.
 *
 * `verdict: "hold"`, NEVER `"block"`, for the reason `recordStageDependencyHold` states at length:
 * `latestBlockDecisionForSubject` filters on the VERDICT ALONE and nothing ever writes a clearing
 * `block`, so a `block` here would mark the component permanently blocked on the service board —
 * and this hold fires on every release of a component that declares a probe, by design.
 *
 * ============================================================================================
 * `inputContext` CARRIES `buildHookFreshnessContext`'s OUTPUT AND NEVER A CLOCK
 * ============================================================================================
 * This is the property to read twice. The record carries `completedAt` (off the evidence row), the
 * declared `maxAgeSeconds`, and `staleAfter` (their sum) — all DATA, all byte-identical for as long
 * as the evidence is unchanged. The COMPARISON against the clock is `evaluateContinuousHold`'s job
 * and is redone every tick (ADR-0033), so a probe that goes stale, comes back, and goes stale again
 * produces three rows rather than one per second. `gate-orchestrator.ts` does exactly this for
 * freezes ("NOTHING HERE IS DERIVED FROM A CLOCK") and this follows it.
 *
 * Putting `now` in here instead is the shape that produced the measured 1.44 GB/day incident, and
 * it has a dedicated test: two consecutive evaluations against unchanged evidence must produce a
 * BYTE-IDENTICAL `inputContext`.
 *
 * ONE ROW PER CHANGE, NOT PER TARGET, and both sorts (targets by `targetObjectId` in
 * `describeContinuousHeldTargets`, hooks by `hookId` inside each entry) are load-bearing for the
 * same reason the freeze hold's two are.
 *
 * THE `reconcile_cursor_at` BUMP IS NOT OPTIONAL — bump 7 of 7, in the same transaction as the
 * Decision, and `candidate-loop-registry.test.ts` is the CI gate that notices if it goes missing. A
 * change whose targets are all probe-held stays `executing` with its wave `running`, so nothing
 * else moves its cursor, and a dead prober is a condition that lasts days. That is the property
 * that stopped all coordination on the homelab for 13 days behind green health checks.
 */
async function recordContinuousHold(
  db: Db,
  orgId: string,
  change: ChangeRow,
  activeWave: { id: string; waveIndex: number },
  probeHeldTargets: ContinuousHoldTargetVerdict[]
): Promise<void> {
  const held = describeContinuousHeldTargets(probeHeldTargets);

  const firstHold = await withTenantTx(db, orgId, async (tx) => {
    const recorded = await insertDecisionIfChanged(tx, {
      orgId,
      kind: "continuous_test",
      subjectId: change.objectId,
      verdict: "hold",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held },
      reasonTree: {
        summary: `${held.length} wave target(s) held: a declared continuous probe has not reported a fresh pass — siblings proceed`,
        held: probeHeldTargets
          .map((verdict) => describeContinuousHold(verdict))
          .sort((a, b) => a.localeCompare(b))
      }
    });
    await tx
      .update(changes)
      .set({ reconcileCursorAt: new Date() })
      .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)));
    return recorded;
  });

  if (firstHold.created) {
    console.info(
      `[reconcile] org ${orgId} change ${change.objectId} wave ${activeWave.waveIndex}: ${held.length} target(s) held by a continuous test hook — decision ${firstHold.decision.id} (scp decision get ${firstHold.decision.id}); re-evaluated every tick until fresh evidence lands`
    );
  }
}

/**
 * HOLD -> RELEASE for the continuous hold — the same clearing counterpart, and for the same defect
 * `clearFreezeAdmissionHold` documents: a hold Decision is a historical record with no clearing
 * row, so it still reads `hold` long after fresh green evidence arrived and the target shipped.
 *
 * The three guards are identical: called only on a tick where nothing is probe-held AND some target
 * triggered; it reads the latest `(subject_id, kind)` row first and returns unless that row is a
 * `hold`; and `insertDecisionIfChanged` suppresses a duplicate anyway. NO CURSOR BUMP, deliberately
 * and for the same reason — reaching here means a target was triggered on this very tick, so there
 * is no not-advanced path to starve, and `candidate-loop-registry.test.ts` deliberately does not
 * name this function.
 */
async function clearContinuousHold(
  db: Db,
  orgId: string,
  change: ChangeRow,
  activeWave: { id: string; waveIndex: number }
): Promise<void> {
  await withTenantTx(db, orgId, async (tx) => {
    const latest = await latestDecisionForSubjectKind(
      tx,
      orgId,
      change.objectId,
      "continuous_test"
    );
    if (!latest || latest.verdict !== "hold") return;
    await insertDecisionIfChanged(tx, {
      orgId,
      kind: "continuous_test",
      subjectId: change.objectId,
      verdict: "allow",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, held: [] },
      reasonTree: {
        summary:
          "no wave target is held by a continuous test hook any more — fresh passing evidence " +
          "landed inside its declared freshness window and the previously-held target has been " +
          "handed to its executor",
        releases: latest.id
      }
    });
  }).catch((err) => {
    // Best effort, exactly like the freeze release: failing to record that a hold RELEASED must
    // never fail the tick that released it. The next trigger on this change retries.
    logChangeError(orgId, change, "continuous-test-release", err);
  });
}

/**
 * THE FAIL-OPEN, MADE VISIBLE (ADR-0028 decision 4, unreadable/unscopeable branch). A wave target
 * that is not a live `placement` — a legacy-shaped topology whose waves name the change's own
 * targets, or NO resolvable topology at all, which puts the plan on `compilePlan`'s toposort path —
 * has no place for a stage-scoped hold to be scoped by. The declaration is not enforced, and the
 * release proceeds, which is the right call: failing closed on a shape the coupling cannot express
 * would strand every legacy plan behind a dependency it can never evaluate.
 *
 * WHAT WAS WRONG WAS THE SILENCE, NOT THE VERDICT. The branch returned `satisfied: true`, so `held`
 * was false, `recordStageDependencyHold` never ran, and the seam's only `console.warn` fires
 * exclusively on `weightUnreadable` — a change whose CI declared a coupling and got NONE was
 * invisible in every surface an operator has. This records it, at `warn` (not `block`: nothing is
 * being withheld), so `scp decision list` answers "was my coupling enforced here?" with a row.
 *
 * The guarantee is not lost so much as never this mechanism's to keep — `plan-compiler.ts`'s LEGACY
 * path still refuses to schedule two components joined by a `depends_on` edge into one wave, and
 * only the STAGE path's copy of that check was replaced by the hold (ADR-0028 decision 6). What it
 * does not cover is the QUALIFIED declaration: a `minWeight` or a cross-change dependency on a
 * component this change does not target orders nothing here.
 *
 * SAME THREE PROPERTIES AS THE HOLD, for the same ADR-0024 reason. One Decision per CHANGE, not per
 * target (`insertDecisionIfChanged` compares against the latest row of the same `(subject_id,
 * kind)`, so per-target rows would alternate and suppression would never fire). Content-stable
 * inputs — ids and branch names only, no clock. Persist on change. It also converges on its own:
 * this branch only evaluates a `pending`/`triggering` target, and a target this records is
 * triggering on this very tick, so the ordinary single-target case writes exactly one row ever.
 *
 * NO CURSOR BUMP, unlike the hold, and the asymmetry is deliberate: nothing is being withheld
 * here, so the change keeps moving through the loop on its own and has no way to freeze in the
 * round-robin.
 */
async function recordStageDependencyUnscoped(
  db: Db,
  orgId: string,
  change: ChangeRow,
  activeWave: { id: string; waveIndex: number },
  unscopeableTargets: { targetObjectId: string; verdicts: StageDependencyVerdict[] }[]
): Promise<void> {
  const unenforced = [...unscopeableTargets]
    .sort((a, b) => a.targetObjectId.localeCompare(b.targetObjectId))
    .map((entry) => ({
      targetObjectId: entry.targetObjectId,
      dependencies: entry.verdicts
    }));

  const recorded = await withTenantTx(db, orgId, (tx) =>
    insertDecisionIfChanged(tx, {
      orgId,
      kind: "stage_dependency_unscoped",
      subjectId: change.objectId,
      verdict: "warn",
      inputContext: { waveId: activeWave.id, waveIndex: activeWave.waveIndex, unenforced },
      reasonTree: {
        summary: `${unenforced.length} wave target(s) declared a stage dependency that was NOT enforced: the target is not a placement, so there is no deployment-target to scope the coupling by — the release proceeded`,
        unenforced: unenforced.flatMap((entry) =>
          entry.dependencies.map(
            (verdict) =>
              `target ${entry.targetObjectId}: '${verdict.dependsOn}' was declared but not enforced here — this plan's wave targets name components, not placements (a legacy-shaped release topology, or none resolved at all), so a stage-scoped hold has no place to be scoped by`
          )
        )
      }
    })
  );

  // One line per distinct fail-open, on the tick that persisted it — the same `created` signal the
  // hold's log line uses, so a change sitting in this state does not reprint every second.
  if (recorded.created) {
    console.warn(
      `[reconcile] org ${orgId} change ${change.objectId} wave ${activeWave.waveIndex}: ${unenforced.length} target(s) declared a stage dependency that was NOT enforced (the wave target is not a placement) — decision ${recorded.decision.id} (scp decision get ${recorded.decision.id})`
    );
  }
}

/**
 * The shared FAIL-CLOSED effects for a wave target reconcile REFUSES to drive — the masking-gap block
 * (M12/ADR-0006), the silent-region-deploy block (M15.6) and the tombstoned-target block
 * (`target-liveness.ts`) all use it so they emit an IDENTICAL, consistent set of records: terminalize
 * the target on a dedicated per-cause status, a `block` Decision (with decision_id), a hash-chained
 * audit event referencing it, fail the wave, and park the change (reconcile-blocked). Idempotent:
 * `terminalizeRefusedWaveTarget`'s status guard returns false when a prior tick already
 * blocked+audited this target, in which case this appends nothing and just reports "still blocked"
 * (true). Must run INSIDE the caller's tenant tx.
 *
 * PARKING, NOT THROWING, is the deliberate failure mode and it is the whole reason this helper is
 * shared. A refusal raised as an exception would surface as one `console.error` per tick and nothing
 * an operator could query — the change would be stranded with no `decision_id` to resolve it and no
 * terminal row to read. Parking gives up forward progress in exchange for an explanation (charter
 * principle 6): the operator's recourse is `scp change cancel` / `scp change rollback`, both of which
 * remain available on a parked change.
 */
async function blockWaveTarget(
  tx: TenantTx,
  args: {
    orgId: string;
    change: ChangeRow;
    waveId: string;
    waveTargetId: string;
    targetObjectId: string;
    /** The terminal status this refusal earns. Explicit at every call site — see
     *  `terminalizeRefusedWaveTarget` for why it is not a literal in one place. */
    status: RefusedWaveTargetStatus;
    action: string;
    summary: string;
    remediation: string;
    reason: string;
    inputContext: Record<string, unknown>;
  }
): Promise<boolean> {
  const terminalized = await terminalizeRefusedWaveTarget(
    tx,
    args.orgId,
    args.waveTargetId,
    args.status
  );
  if (!terminalized) return true; // a prior tick already blocked+audited this — append nothing.

  const decision = await insertDecision(tx, {
    orgId: args.orgId,
    kind: "wave_target",
    subjectId: args.change.objectId,
    verdict: "block",
    inputContext: args.inputContext,
    reasonTree: { summary: args.summary, remediation: args.remediation }
  });
  await appendAuditEvent(tx, {
    orgId: args.orgId,
    actorId: SYSTEM_ACTOR_ID,
    action: args.action,
    subjectId: args.change.objectId,
    reason: args.reason,
    decisionId: decision.id,
    requestId: "reconcile"
  });
  // Fail the wave and park the change — the same terminal+park the failed-wave path produces, but
  // reached directly so no auto-rollback of an un-runnable pipeline is attempted (it would only hit
  // the same gap). Awaits an operator.
  await markWaveTerminal(tx, args.orgId, args.waveId, "failed");
  await markChangeReconcileBlocked(tx, args.orgId, args.change.objectId);
  return true;
}

/**
 * M25.4 — is this target's resolved executor able to honour the change's recipe? Returns the
 * refusal's whole shape, or `undefined` when there is nothing to refuse.
 *
 * TWO CAUSES, TWO STATUSES, ONE REMEDY EACH — `terminalizeRefusedWaveTarget`'s rule (the status is a
 * parameter "precisely so a second cause could not be smuggled in under the first one's name"):
 *
 *   * `recipe_unreadable` — the document does not parse. Fix the document.
 *   * `recipe_unsupported` — the document is fine; THIS executor has no such verb. Fix the binding,
 *     or narrow the campaign's targets.
 *
 * NEITHER EVER FALLS BACK TO A DEFAULT, and that is the point of the whole function. `github` and
 * `gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId`, so a silently-dropped
 * recipe does not error — it dispatches the target's ORDINARY workflow, that run succeeds, the wave
 * target goes `succeeded`, and the campaign reports a migration that never happened. A refusal with
 * a `decision_id` is the only outcome that leaves nobody with a false belief (charter principle 6).
 *
 * `describeCapabilities()` is an RPC across the plugin-host seam. It is called ONLY when the change
 * actually carries a recipe, so a recipe-less instance pays nothing for this. A THROWN call is not a
 * refusal: it propagates to the caller's per-target catch and the target is retried next tick with
 * nothing terminalized — the same fail direction `readTargetLiveness` documents, and for the same
 * reason (a plugin-host blip must never be mistaken for "this executor cannot do that").
 */
async function resolveRecipeRefusal(
  client: { describeCapabilities: () => Promise<ExecutorCapabilities> },
  recipe: RecipeResolution,
  /** The plugin module this target's binding resolved to — for the OQ-5 managed-actuator refusal.
   *  Comes from `ensureExecutorInstanceStarted`'s return so it is the same answer the trigger will
   *  act on, never a second query. */
  executorModule: PluginModule
): Promise<
  | {
      status: RefusedWaveTargetStatus;
      action: string;
      summary: string;
      remediation: string;
      inputContext: Record<string, unknown>;
    }
  | undefined
> {
  if (recipe.outcome === "none") return undefined;
  if (recipe.outcome === "malformed") {
    return {
      status: WAVE_TARGET_RECIPE_UNREADABLE_STATUS,
      action: WAVE_TARGET_RECIPE_UNREADABLE_AUDIT_ACTION,
      summary:
        `this change carries a 'properties.recipe' that does not parse (${recipe.detail}), so the ` +
        `trigger it names cannot be performed`,
      remediation:
        `fix the recipe on the campaign that fanned this change out (or on the change itself), then ` +
        `cancel/rollback/re-propose the change. Driving it anyway would trigger the target's ` +
        `DEFAULT pipeline with no recipe parameters and record a coordination that did not happen`,
      inputContext: { recipe: { readable: false, detail: recipe.detail } }
    };
  }
  const kind = recipe.recipe.trigger.kind;
  // =============================================================================================
  // OQ-5 (UNRULED) — A RECIPE MAY NOT DRIVE ONE OF COMMANDERSCP'S OWN ACTUATORS.
  // =============================================================================================
  // CHECKED BEFORE `describeCapabilities()`, and the order is the point: all three managed modules
  // ANSWER YES to `"custom"` (measured — `managed-dep` and `managed-scan` declare exactly
  // `["custom"]`, `managed-iac` declares `["sync","rollback","custom"]`), so asking the capability
  // question first would return `undefined` and the recipe's author-controlled `parameters` would
  // reach the bump actuator as `{action:"bump", ...}`. The capability check is about what an
  // executor CAN do; this is about what CommanderSCP MAY ask it to, and only the second one is a
  // charter question.
  //
  // This is a fail-closed default on an unruled question, not a ruling. If OQ-5 later says a
  // campaign MAY drive a managed actuator, this branch is the single seam that changes.
  if (isRecipeForbiddenExecutorModule(executorModule)) {
    return {
      status: WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS,
      action: WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_AUDIT_ACTION,
      summary:
        `this target is bound to '${executorModule}', one of CommanderSCP's own managed actuators, ` +
        `and a campaign recipe may not drive those — a recipe coordinates a TENANT's pipeline`,
      remediation:
        `remove this target from the campaign, or bind it to the pipeline that actually performs ` +
        `this migration. CommanderSCP's managed executors act under a narrow charter grant and are ` +
        `driven by the server (dependency-bump dispatch, promotion scanning), never by an authored ` +
        `document — letting a recipe supply their parameters would let a campaign author choose ` +
        `what CommanderSCP writes into a repository`,
      inputContext: { recipe: { readable: true, kind }, executorModule, managedActuator: true }
    };
  }
  const capabilities = await client.describeCapabilities();
  if (executorSupportsTriggerKind(capabilities, kind)) return undefined;
  const supported = Array.isArray(capabilities?.triggerKinds)
    ? [...capabilities.triggerKinds].sort()
    : [];
  return {
    status: WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS,
    action: WAVE_TARGET_RECIPE_UNSUPPORTED_AUDIT_ACTION,
    summary:
      `the executor bound to this target cannot perform a '${kind}' trigger (it declares ` +
      `${supported.length > 0 ? supported.map((k) => `'${k}'`).join(", ") : "none"}), so this ` +
      `change's recipe cannot be honoured here`,
    remediation:
      `bind an executor that supports '${kind}' for this target, or remove this target from the ` +
      `campaign — CommanderSCP will not substitute a different trigger, because the target's ` +
      `default pipeline would succeed and report a coordination that did not happen`,
    /** CONTENT-STABLE — the recipe's kind and the executor's own declared set, both sorted, and no
     *  clock-shaped value anywhere. This Decision is written once (the status guard), but the rule
     *  is the instance-wide one from the measured 1.44 GB/day incident and it costs nothing to keep. */
    inputContext: { recipe: { readable: true, kind }, supportedTriggerKinds: supported }
  };
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
  waveId: string,
  waveTargetId: string,
  targetObjectId: string,
  type: ExecutorType,
  isRollback: boolean,
  /** M25.4 — what the change's `properties.recipe` says, already parsed. See the capability refusal
   *  below and `campaign-recipe.ts`. */
  recipe: RecipeResolution,
  host: PluginHost,
  masterKey: Buffer
): Promise<void> {
  const lock = await tryAcquireTriggerClaimLock(db, waveTargetId);
  if (!lock) return; // another attempt (this or another worker replica) is genuinely in flight.

  try {
    // FAIL-CLOSED on a masking executor-binding gap (M12 — docs/adr/0006). Keyed on the RESOLVED
    // routing `type` reconcile actually triggers (ADR-0007), and TARGET-LOCAL only — no
    // component->service/deployment-target walk-up (that is future M12 work). Three populations,
    // disambiguated by binding presence + whether the target declares multi-region membership:
    //
    //   (a) INTENDED-FAKE — a PLAIN target (not a declared region) with ZERO executor bindings: the
    //       shared fake executor IS its configured executor for rehearsal/demo/test. KEEP
    //       fake-succeeding (fall through, below). Non-region behaviour is UNCHANGED.
    //   (b) MASKING-GAP — the target has >=1 real binding but NONE for `type`: fake-succeeding
    //       would GREEN a misconfiguration (e.g. it has a `configuration` binding but receives an
    //       `image` release). Block loudly.
    //   (c) SILENT-REGION-DEPLOY (M15.6 — regional-executors.ts) — a DECLARED region target (carries
    //       properties.environment + properties.region) with NO resolvable binding of `type`: case
    //       (a)'s intended-fake fallthrough would deploy a real prod region against the shared
    //       default executor — a SILENT region deploy the config surface promises never happens. It
    //       is NOT intended-fake, so block it too. SCOPED to declared region targets only (the gate
    //       returns null for a plain target, so (a) stands for everything non-region).
    //
    // Each block emits a `block` Decision (with decision_id) naming the gap, writes the hash-chained
    // audit event, terminalizes the target on the dedicated `no_executor` status, fails the wave, and
    // PARKS the change (reconcile-blocked) for manual remediation. The Decision NAMES the gap only —
    // it never auto-offers the managed-iac executor (charter: managed execution is never a default).
    // All emitted ONCE: `terminalizeRefusedWaveTarget`'s status guard makes a later tick that finds it
    // already `no_executor` a no-op.
    const blocked = await withTenantTx(db, orgId, async (tx) => {
      // ===========================================================================================
      // (0) IS THE TARGET OBJECT STILL THERE? — checked FIRST, before any binding is resolved, and
      // this ordering is the fix rather than an accident of layout. See `target-liveness.ts` for the
      // property; three things downstream of this line go wrong when a tombstoned target reaches
      // them, and every one of them fails OPEN:
      //
      //   * `listVisibleBindingsForTarget` (case (a)/(b) below) IS live-filtered, so a tombstoned
      //     target with real bindings returns ZERO of them and reads as case (a) INTENDED-FAKE. The
      //     target is then handed to the shared default fake executor and the change goes GREEN with
      //     nothing deployed — the exact masking failure ADR-0006 exists to prevent, arriving
      //     through the tombstone door instead of the binding door.
      //   * `evaluateRegionalDeployGate` (case (c)) resolves a placement's deployment-target with a
      //     `deleted_at IS NULL` filter, so a tombstoned region target reads as "not a region" and
      //     the M15.6 silent-region-deploy gate simply STOPS FIRING — case (c) collapsing into case
      //     (a), which its own comment says must never happen.
      //   * the stage-dependency hold (ADR-0028) resolves the placement pair the same way, gets
      //     `null`, and records every declared dependency as `unscopeable` -> satisfied. The
      //     coupling silently evaporates and the target triggers on that very tick.
      //
      // In other words: every guard between here and the executor already asks "is this object
      // live?", gets "no", and interprets it as "nothing to enforce". Absence read as permission,
      // three times over. Asking the question FIRST — and answering it with a refusal — is what
      // turns all three fail-opens into one explainable stop.
      //
      // WHY HERE AND NOT IN THE PER-TARGET LOOP: this is inside `triggerWaveTarget`'s advisory
      // trigger-claim lock and shares `blockWaveTarget`'s exactly-once status guard, so the Decision
      // and the audit event are emitted once no matter how many ticks or replicas arrive. A check in
      // the loop would need its own transaction and its own idempotency, and would be the second
      // place that decides whether a target may be driven.
      //
      // A THROWN read is NOT a deletion: `readTargetLiveness` has no catch, so a database blip
      // propagates out of this tx, through the caller's per-target try/catch, and the target is
      // retried next tick with nothing terminalized. See that module's "fail direction" note.
      const liveness = await readTargetLiveness(tx, orgId, targetObjectId);
      if (!liveness.live) {
        return blockWaveTarget(tx, {
          orgId,
          change,
          waveId,
          waveTargetId,
          targetObjectId,
          status: WAVE_TARGET_TOMBSTONED_STATUS,
          action: WAVE_TARGET_TOMBSTONED_AUDIT_ACTION,
          summary: describeDeadTarget(targetObjectId, liveness),
          remediation: DEAD_TARGET_REMEDIATION,
          reason: describeDeadTarget(targetObjectId, liveness),
          inputContext: {
            waveId,
            requestedType: type,
            ...deadTargetInputContext(targetObjectId, liveness)
          }
        });
      }

      // ADR-0026 amendment: resolution now falls back through the target's PLACEMENTS when the
      // target itself carries no binding of this type. Direct is still checked first, so nothing
      // that resolves today changes answer. See `binding-resolution.ts` for why the fallback exists
      // (it is what makes each estate-migration step independently safe) and why it must refuse
      // rather than choose when a component has two placed bindings.
      const resolution = await resolveBindingForTarget(tx, orgId, targetObjectId, type);
      if (
        resolution.outcome === "direct" ||
        resolution.outcome === "via_placement" ||
        // ADR-0027 rung 3 — infrastructure declared once on the owning service. Without this the
        // gap analysis would block a target the resolver just resolved, which is the same class of
        // masking bug ADR-0006 exists to prevent, inverted.
        resolution.outcome === "via_service"
      )
        return false;

      if (resolution.outcome === "ambiguous") {
        // (d) AMBIGUOUS PLACEMENT — a NEW population, distinct from (b)'s meaning. (b) is "bound,
        // but not for this pipeline"; this is "bound for this pipeline in more than one PLACE, and
        // the wave target does not say which". Picking one would be the cross-product bug ADR-0026
        // exists to kill, silently. The remediation is not "add a binding" — it is to make the wave
        // target a placement, i.e. attach a stage-shaped topology.
        const named = resolution.candidates.map((c) => c.placementObjectId).join(", ");
        return blockWaveTarget(tx, {
          orgId,
          change,
          waveId,
          waveTargetId,
          targetObjectId,
          status: "no_executor",
          action: "change.wave_target.ambiguous_placement_binding",
          summary:
            `wave target ${targetObjectId} is a component whose '${type}' binding lives on ` +
            `${resolution.candidates.length} placements (${named}) — refusing to guess which place ` +
            `this release is for`,
          remediation:
            `attach a stage-shaped release topology so waves name deployment-targets and each wave ` +
            `target is a placement, or remove the surplus placement binding`,
          reason:
            `ambiguous '${type}' binding for component ${targetObjectId}: ${resolution.candidates.length} ` +
            `placements carry one (${named})`,
          inputContext: {
            waveId,
            targetObjectId,
            requestedType: type,
            gate: "ambiguous_placement_binding",
            candidates: resolution.candidates
          }
        });
      }

      // (c) declared region target with no resolvable binding — must not fall through to (a).
      const regionGate = await evaluateRegionalDeployGate(tx, orgId, targetObjectId, type);
      if (regionGate && !regionGate.deployAllowed) {
        return blockWaveTarget(tx, {
          orgId,
          change,
          waveId,
          waveTargetId,
          targetObjectId,
          status: "no_executor",
          action: "change.wave_target.no_executor",
          summary:
            `wave target ${targetObjectId} is region '${regionGate.region}' of multi-region ` +
            `environment '${regionGate.environment}' but has no '${type}' executor binding — ` +
            `refusing to deploy it silently against the default executor`,
          remediation:
            `bind an Argo CD (${REGIONAL_EXECUTOR_EXPECTED_MODULE}) execution-system for the '${type}' ` +
            `pipeline of this region target, then cancel/rollback/re-propose the change`,
          reason:
            `region '${regionGate.region}' of environment '${regionGate.environment}' has no '${type}' ` +
            `executor binding (declared multi-region target ${targetObjectId})`,
          inputContext: {
            waveId,
            targetObjectId,
            requestedType: type,
            environment: regionGate.environment,
            region: regionGate.region,
            gate: "regional_argocd_silent_deploy"
          }
        });
      }

      // (a)/(b) discrimination reads the VISIBLE set — the target's own bindings PLUS its
      // placements'. Case (a) has always meant "intended-fake: nothing anywhere", and once a binding
      // can live on a placement, "anywhere" has to include placements. Reading only the target's own
      // bindings here would let a component whose `configuration` binding had moved to its placement,
      // receiving an `image` release, look like zero-bindings and FAKE-SUCCEED — case (b) wearing
      // case (a)'s clothes, which is the masking gap #66 closed.
      const all = await listVisibleBindingsForTarget(tx, orgId, targetObjectId);
      if (all.length === 0) return false; // case (a): intended-fake, behaviour unchanged.

      // case (b): masking gap.
      const boundTypes = all.map((b) => b.binding.type).sort();
      return blockWaveTarget(tx, {
        orgId,
        change,
        waveId,
        waveTargetId,
        targetObjectId,
        status: "no_executor",
        action: "change.wave_target.no_executor",
        summary:
          `wave target ${targetObjectId} has no '${type}' executor binding ` +
          `(bound: ${boundTypes.join(", ")}) — refusing to fake-succeed a masking gap`,
        remediation: `bind the '${type}' pipeline for this target, then cancel/rollback/re-propose the change`,
        reason: `no '${type}' executor binding for target ${targetObjectId} (bound: ${boundTypes.join(", ")})`,
        inputContext: {
          waveId,
          targetObjectId,
          requestedType: type,
          boundTypes
        }
      });
    });
    if (blocked) return;

    // M7: resolve targetObjectId's configured executor binding (executor-bindings-repo.ts) — a
    // Component/DeploymentTarget with no binding configured falls back to the shared default
    // fake-executor instance, exactly as every M0-M6 test/demo relies on (executor-config.ts).
    const { instanceId, module: executorModule } = await ensureExecutorInstanceStarted(
      db,
      orgId,
      host,
      targetObjectId,
      type,
      null,
      masterKey
    );
    const client = host.executor(instanceId);
    // Deterministic across every retry of this exact wave target — no separate storage needed, the
    // row's own id already satisfies "IDENTICAL across retries of the same target."
    const idempotencyKey = waveTargetId;

    // =============================================================================================
    // M25.4 — THE RECIPE, AND THE TWO REFUSALS THAT COME WITH IT (owner decision D3, ADR-0041)
    // =============================================================================================
    // A recipe is one authored trigger intent fanned across N targets. Here is where it becomes a
    // real call to a real executor — and here is where it must STOP if this particular target cannot
    // honour it, because everything downstream of this point is a side effect in someone's estate.
    //
    // A ROLLBACK IGNORES THE RECIPE ENTIRELY — kind AND parameters. `kind` is decided from the
    // CHANGE below (`isRollback` -> "rollback"), and passing the recipe's migration parameters to a
    // restore would re-run the migration under the name of undoing it: `github` would resolve the
    // recipe's `workflowId` and dispatch the python3 workflow again while the operator believed they
    // were reverting. The recipe schema already refuses `kind: "rollback"` at the door; this is the
    // other direction of the same rule, and it is the reason the whole block sits behind
    // `!isRollback` rather than only the kind assignment.
    //
    // PLACED AFTER `ensureExecutorInstanceStarted`, NOT BEFORE: the question is not "can any executor
    // serve this kind" but "can the executor THIS TARGET resolved to serve it", and that instance is
    // not known until the binding has been resolved. It is a genuinely per-target question — the
    // measured `triggerKinds` sets of `argocd` (sync, rollback) and `github` (workflow_dispatch,
    // custom) are DISJOINT, so a single campaign across a mixed estate is answered differently at
    // each target and could not have been settled once at authoring time.
    //
    // AND BEFORE `claimWaveTargetForTriggering`: `blockWaveTarget` terminalizes the row itself, and
    // claiming it first would move it to `triggering` — outside the `('pending','triggering')` guard
    // is not the risk (it covers both), but the claim is a statement that this target is being
    // handed to an executor, which is exactly what is NOT about to happen.
    const recipeRefusal = !isRollback
      ? await resolveRecipeRefusal(client, recipe, executorModule)
      : undefined;
    if (recipeRefusal) {
      const refused = await withTenantTx(db, orgId, (tx) =>
        blockWaveTarget(tx, {
          orgId,
          change,
          waveId,
          waveTargetId,
          targetObjectId,
          status: recipeRefusal.status,
          action: recipeRefusal.action,
          summary: recipeRefusal.summary,
          remediation: recipeRefusal.remediation,
          reason: recipeRefusal.summary,
          inputContext: {
            waveId,
            targetObjectId,
            requestedType: type,
            executorPluginId: instanceId,
            ...recipeRefusal.inputContext
          }
        })
      );
      // `refused` is true whether this tick wrote the records or a prior one already had. Either way
      // this target is terminal and `trigger()` is NEVER called — the assertion the DoD names.
      if (refused) return;
    }

    const claim = await withTenantTx(db, orgId, async (tx) => {
      let kind: TriggerIntent["kind"];
      let priorStateRef: unknown = null;
      /**
       * M25.4 — what rides on `TriggerIntent.parameters`. VERBATIM from the recipe; SCP performs no
       * cross-provider translation (`recipeTriggerParameters`).
       *
       * `undefined` for a rollback and for every recipe-less change, which keeps the intent
       * BYTE-IDENTICAL to a pre-M25.4 one: `parameters` stays absent rather than becoming `{}`.
       * `pipeline-generic` passes this bag straight through to a tenant's own HTTP endpoint, so a
       * new empty object appearing on every trigger on the instance is a wire change, not a no-op.
       */
      const parameters =
        !isRollback && recipe.outcome === "recipe"
          ? recipeTriggerParameters(recipe.recipe)
          : undefined;

      // The executor-specific target id (e.g. an Argo CD Application name) this object maps to.
      // Falls back to the object id for legacy bindings — so a binding whose object id already IS
      // the external name (pre-M12) is unaffected. This is what lets Mode A / imported objects
      // trigger the right external resource when their SCP id differs from their external name.
      // P3: a target may hold several Types of binding, so "the" binding no longer exists — reconcile
      // must NAME the pipeline it drives. P4A supplies that name: the routing `type` (ADR-0007) rides
      // in on the wave target, snapshotted at plan time from the change (and thence from the source
      // mapping that matched the release), which is what makes a non-default binding TRIGGERABLE
      // rather than merely registerable and readable.
      // MUST use the same resolver as the gap analysis above. If this stayed a literal lookup while
      // that one fell back, a component whose binding had moved to its placement would pass the gate
      // and then trigger with a NULL externalRef — deploying against the wrong external resource, or
      // none, with nothing blocked and nothing logged. Two resolution paths for one decision is how
      // that class of bug happens; there is one path.
      const resolution = await resolveBindingForTarget(tx, orgId, targetObjectId, type);
      const binding = resolution.binding;
      const externalRef = binding?.externalRef ?? null;

      // Principle 6: an INDIRECT resolution is recorded, because an operator debugging a deploy must
      // not have to infer that the binding came from somewhere other than the wave target. Written
      // ONLY for the indirect path — the direct path is the overwhelmingly common one and a Decision
      // per trigger for it would double Decision volume for no information, which is a live
      // production concern on this instance. Bounded either way: this runs once per wave target
      // behind the claim lock, not once per tick.
      // `resolutionProvenance` is null for a direct or failed resolution, which is exactly the set
      // that writes no Decision — so this one call is both the guard and the label, and the label
      // cannot drift from the outcome it describes.
      const provenance = resolutionProvenance(resolution);
      if (provenance) {
        const { via, viaObjectId } = provenance;
        await insertDecision(tx, {
          orgId,
          kind: "wave_target",
          subjectId: change.objectId,
          verdict: "allow",
          inputContext: {
            waveId,
            targetObjectId,
            requestedType: type,
            resolvedVia: via,
            // ALWAYS present and unambiguous, whatever the level turns out to be.
            viaObjectId,
            // The two historical keys stay exactly where they were TRUE, so existing Decisions and any
            // query over them keep reading the same field — and `serviceObjectId` is now written only
            // when the id really is a service's, rather than for every non-placement rung.
            ...(via === "placement" ? { placementObjectId: viaObjectId } : {}),
            ...(via === "service" ? { serviceObjectId: viaObjectId } : {}),
            ...(provenance.hops === null ? {} : { hops: provenance.hops }),
            bindingId: binding?.id ?? null
          },
          reasonTree: {
            summary:
              `'${type}' binding for wave target ${targetObjectId} resolved INDIRECTLY via its ` +
              `${via} ${viaObjectId} — the target carries none of its own`
          }
        });
      }

      if (isRollback && change.rollbackOfObjectId) {
        // Restore exactly what the ORIGINAL change's trigger of this same target would have
        // reverted (DESIGN §9.4: "referencing the prior known-good executor state").
        kind = "rollback";
        const originalTarget = await findOriginalWaveTarget(
          tx,
          orgId,
          change.rollbackOfObjectId,
          targetObjectId,
          instanceId
        );
        priorStateRef = originalTarget?.priorStateRef ?? null;
      } else {
        // M25.4 — the recipe's kind, when it has one and the capability check above passed. `"sync"`
        // stays the default for every change that carries no recipe, so this line is byte-identical
        // to pre-M25.4 behaviour in the overwhelming majority of cases.
        kind = recipe.outcome === "recipe" ? recipe.recipe.trigger.kind : "sync";
        // Snapshot the target's CURRENT executor-side state (via a fresh status() call against its
        // last successful run, not just whatever a previous poll happened to observe) before this
        // trigger supersedes it — this is the "prior known-good state" a later rollback restores.
        // Recomputed fresh on every retry (including a post-crash resume) rather than persisted:
        // since this target is still `triggering`/`pending` (not `succeeded`), it can never be its
        // OWN "latest succeeded execution", so recomputation is stable/idempotent across retries.
        // Scoped to `instanceId` — the executor plugin instance THIS trigger resolved — so we only
        // ever snapshot from a prior run of the SAME executor. A prior succeeded run under a
        // DIFFERENT executor carries an executorRef this `client` can't interpret; calling its
        // status() with a foreign ref throws (e.g. argocd 403) and wedges the wave forever.
        const latestSucceeded = await findLatestSucceededExecution(
          tx,
          orgId,
          targetObjectId,
          instanceId
        );
        if (latestSucceeded?.executorRef) {
          const priorStatus = await client.status(latestSucceeded.executorRef as ExecutorRef);
          priorStateRef = priorStatus.stateRef ?? null;
        }
      }

      const claimed = await claimWaveTargetForTriggering(tx, orgId, waveTargetId);
      return claimed ? { kind, priorStateRef, externalRef, parameters } : null;
    });

    if (!claim) return; // no longer pending/triggering — another tick already handled it.

    // Step 2 — OUTSIDE any open transaction, on purpose (see doc comment above).
    let ref;
    try {
      ref = await client.trigger({
        kind: claim.kind,
        targetRef: claim.externalRef ?? targetObjectId,
        priorStateRef: claim.priorStateRef,
        idempotencyKey,
        // M25.4 — THE CHANNEL THAT WAS NEVER WIRED. `TriggerIntent.parameters` has been on the
        // plugin interface since M3 and every adapter reads it, but until now the only server call
        // sites that populated it were `bump-dispatch.ts`, `bump-gate.ts` and
        // `promotion-scan-step.ts` — the generic release path constructed
        // `{kind, targetRef, priorStateRef, idempotencyKey}` and nothing else. Spread conditionally
        // so a change with no recipe produces the exact same object it did before.
        ...(claim.parameters !== undefined ? { parameters: claim.parameters } : {})
      });
    } catch (err) {
      // Step 3' — the executor REACHED and REFUSED this trigger. Record it so the retry backs off
      // (`triggerBackoffMs`) instead of re-firing on the next 1s tick. Its own transaction, like
      // step 3, so the attempt count is durable even though the trigger itself failed.
      //
      // Best-effort: if recording the failure ALSO fails, the original executor error is what the
      // caller must see — swallowing it to report a bookkeeping error would hide the real cause,
      // and the worst case is simply the un-backed-off retry we had before this change.
      await withTenantTx(db, orgId, (tx) =>
        markWaveTargetTriggerFailed(tx, orgId, waveTargetId)
      ).catch(() => undefined);
      throw err;
    }

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
  type: ExecutorType,
  persistedExecutorPluginId: string | null,
  masterKey: Buffer
  /**
   * M25.4 — returns the resolved MODULE alongside the instance id.
   *
   * The recipe's managed-executor refusal (`RECIPE_FORBIDDEN_EXECUTOR_MODULES`) has to know which
   * plugin module this target actually resolved to, and it must be the SAME answer this function
   * acted on. Re-querying the binding at the refusal site would make two readers of one fact that
   * can disagree — a binding edited between the two reads, or the `persistedExecutorPluginId`
   * fall-back branch below (which returns a persisted id whose module is deliberately NOT the
   * currently-configured one) — and the refusal would then be reasoning about a module that is not
   * the one about to be triggered.
   */
): Promise<{ instanceId: string; module: PluginModule }> {
  // MUST resolve the SAME routing Type the trigger will use (M12 P4A / ADR-0007). Resolving without
  // it would start one Type's plugin instance and then trigger against a different Type's binding — a
  // mismatch that would silently drive the wrong pipeline.
  //
  // Both callers pass a WAVE TARGET, which under legacy compilation is a component and under
  // stage-shaped compilation is a placement — so the placement fallback is applied HERE, once, and
  // the object that actually CARRIES the binding is what `resolveExecutorPluginInstance` is asked
  // about. That keeps the fallback at the one point where a wave target is interpreted, instead of
  // pushing it down into the repo (which `binding-resolution.ts` depends on, so the dependency would
  // have become a cycle).
  //
  // `ambiguous` yields no binding-carrying object, so this falls through to the shared default
  // instance exactly as "no binding" always has — and that is safe only because the gap analysis has
  // ALREADY refused this target with a Decision before any trigger reaches here. The status-poll
  // caller can reach it for a target blocked mid-flight, where falling back to the default instance
  // and finding no matching run is the same benign no-op an unbound target has always produced.
  const resolved = await withTenantTx(db, orgId, async (tx) => {
    const resolution = await resolveBindingForTarget(tx, orgId, targetObjectId, type);
    const bindingCarrier = resolution.binding?.targetObjectId ?? targetObjectId;
    return resolveExecutorPluginInstance(tx, {
      orgId,
      targetObjectId: bindingCarrier,
      masterKey,
      type
    });
  });

  if (
    resolved &&
    (!persistedExecutorPluginId || persistedExecutorPluginId === resolved.instanceConfig.id)
  ) {
    await host.start([resolved.instanceConfig]);
    return { instanceId: resolved.instanceConfig.id, module: resolved.instanceConfig.module };
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
      scopeKey: "default",
      config: {}
    }
  ]);
  // `module` describes what was actually started HERE: the default instance. That is exactly right
  // for the TRIGGER caller, which is the only one that reads `module` and which always passes
  // `persistedExecutorPluginId: null` — so it reaches this branch only when the target has no
  // binding at all, and the default module is genuinely what it is about to trigger.
  //
  // The STATUS-POLL caller can reach this branch with a persisted id whose module is unknowable
  // here (that is the whole point of the branch: the binding has since changed). It ignores
  // `module`, and must keep ignoring it — a future reader wanting the module on the poll path has
  // to resolve it from the persisted id, not trust this value.
  return {
    instanceId: persistedExecutorPluginId ?? DEFAULT_EXECUTOR_INSTANCE_ID,
    module: DEFAULT_EXECUTOR_MODULE
  };
}

/** All waves of `change`'s plan have succeeded — advance past `executing`. Forward changes stop
 *  at `validating` for a human `scp change accept` (DESIGN's chain is a deliberate human gate
 *  before acceptance); a ROLLBACK change (its own `rollbackOfObjectId` is set) has no equivalent
 *  human-review step to wait for — restoring known-good state doesn't need approval the way
 *  rolling new state out does — so it auto-accepts itself and then, per DESIGN §9.4 / this
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

  if (!change.rollbackOfObjectId) return; // forward change — waits for a human `scp change accept`.

  const accepted = await transitionChange(
    tx,
    {
      orgId,
      changeObjectId: change.objectId,
      toState: "accepted",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: "auto: rollback changes need no human acceptance gate"
    },
    gateDeps
  );
  if (accepted.verdict !== "allow") return;

  await transitionChange(
    tx,
    {
      orgId,
      changeObjectId: change.rollbackOfObjectId,
      toState: "rolled_back",
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: "reconcile",
      reason: `rollback change ${change.objectId} accepted`,
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
  // S10 single-writer guard: resolved ONCE per tick (a cheap lazy-create-or-read against
  // `federation_self`) and threaded into every advance* step below — and, since this commit, on
  // through into `listChangeRowsInStates` itself, so a read-only replica of a peer's change is
  // filtered OUT OF THE SQL rather than skipped in the loop body. That distinction is the whole
  // point: a loop-body skip left the row in the batch with a frozen cursor, holding a slot under
  // `ORDER BY reconcile_cursor_at ASC LIMIT 25` forever. See tracked-security-followups's "engine SKIP
  // rather than park", `changes-repo.ts`'s doc comment, and
  // `foreign-origin-batch-starvation.integration.test.ts`.
  const selfDomainId = (await withTenantTx(db, orgId, (tx) => ensureFederationSelf(tx, orgId)))
    .domainId;
  try {
    await withTenantTx(db, orgId, (tx) => processChangeSourceEvents(tx, orgId));
  } catch (err) {
    console.error(`[reconcile] org ${orgId} change-source-event processing failed:`, err);
  }
  // ADR-0046 §4 — THE DOMAIN-LOCAL BINDING RECONCILER. Joins the federated WHAT (placements a team
  // declared, which arrive over the journal) against this domain's own HOW (`executorBinding` policy
  // effects) and materialises `executor_bindings` rows, so teams never file per-outpost binding
  // tickets and credentials never leave the domain that owns them.
  //
  // ON THIS TICK rather than a loop of its own, for the reason the hook-run observation below it
  // gives: a second `boss.work()` would be a COMPETING CONSUMER on the reconcile queue. It runs
  // BEFORE the advance* steps so a change reaching a wave this tick dispatches against bindings that
  // already reflect the current policy, rather than one tick behind it.
  //
  // ITS FAILURE IS CAUGHT AND LOGGED, never allowed to abort the tick: a malformed binding policy
  // must not stop changes advancing. The gaps it reports are the loud half of §14 res 2 and are
  // surfaced through the config-source/pipeline status surfaces, not through this loop's return.
  try {
    await withTenantTx(db, orgId, (tx) =>
      reconcileExecutorBindingsForOrg(tx, orgId, `reconcile-bindings-${orgId}`)
    );
  } catch (err) {
    console.error(`[reconcile] org ${orgId} executor-binding reconciliation failed:`, err);
  }
  // ADR-0046 §2 — DRAIN THE CONFIG-SOURCE SYNC QUEUE. The webhook pass recorded that a registered
  // repo moved; this is where the manifest is read and applied, and it is what finally gives
  // `syncConfigSourceCommit` a production caller.
  //
  // ON THIS TICK, but with its own transactions inside: the drain reads manifests over the plugin
  // RPC with NO transaction open, then opens one per entry to apply. That is why it takes `db`
  // rather than a `tx` — see `config-source/drain-sync-queue.ts` for the three-phase shape and why
  // one transaction would be wrong twice over.
  //
  // Caught and logged, like the change-source processing above it: a config repo whose manifest
  // cannot be applied must not stop changes advancing.
  if (host) {
    try {
      await drainConfigSourceSyncQueue(db, orgId, host, masterKey, `config-sync-${orgId}`);
    } catch (err) {
      console.error(`[reconcile] org ${orgId} config-source sync drain failed:`, err);
    }
  }
  await advanceProposedChanges(db, orgId, gateDeps, selfDomainId);
  await advanceEvaluatedChanges(db, orgId, gateDeps, selfDomainId);
  await advanceCoordinatedChanges(db, orgId, gateDeps, selfDomainId);
  await advanceWaitingChanges(db, orgId, gateDeps, selfDomainId);
  await advanceExecutingChanges(db, orgId, host, sandbox, masterKey, selfDomainId);
  await advanceValidatingChanges(db, orgId, host, sandbox, selfDomainId);
  // Increment 8: observe every in-flight pipeline hook run and, on the terminal edge, write the
  // `pipeline_evidence` row the gate verdicts read (`coordination/pipeline-hook-runs.ts`).
  //
  // ON THIS TICK, DELIBERATELY, RATHER THAN ON A LOOP OF ITS OWN. A second `boss.work()` would be a
  // COMPETING CONSUMER on the reconcile queue — taking ticks away from the engine rather than
  // running beside it — and a second queue would be a second liveness surface with its own startup
  // kick to get wrong. The work is also naturally sequenced here: a run's evidence must land before
  // the next tick's wave-gate evaluation reads it, and "the next tick" is this loop.
  //
  // try/catch for the same reason `processChangeSourceEvents` and `reconcileCampaignsOrgTick` have
  // one: an unreachable executor must not take down the rest of the org's tick.
  try {
    await pollNonTerminalHookRuns(db, { orgId, host, masterKey });
  } catch (err) {
    console.error(`[reconcile] org ${orgId} pipeline hook run poll failed:`, err);
  }
  // OUTPOST-RUN CONTINUOUS PROBES — declare every `continuous` hook's schedule to the executor
  // that will run it, and re-declare on every tick so a schedule deleted out-of-band is restored.
  // SCP never fires the probe: it hands the executor a cadence and the executor's own scheduler
  // runs it (`everySeconds` is descriptive in three places, all unchanged by this).
  //
  // Beside the poll rather than on a loop of its own, for the reason stated above it: a second
  // `boss.work()` would be a competing consumer on the reconcile queue.
  try {
    await ensureContinuousProbesScheduled(db, { orgId, host, masterKey });
  } catch (err) {
    console.error(`[reconcile] org ${orgId} continuous probe scheduling failed:`, err);
  }
  // M5 (DESIGN §9.5): campaigns fan out into real M3 Changes above already progress through the
  // exact same steps this tick just ran — this only sequences WHICH wave's member changes get
  // proposed next (coordination/campaign-reconcile.ts's module doc).
  //
  // `selfDomainId` is threaded in for the SAME reason the six `advance*` steps take it, and the
  // campaign side needed it more: unlike a synced change (which never gets a local `changes` row),
  // a synced CAMPAIGN object does land locally with a foreign origin, so this loop would otherwise
  // compile a plan for a peer's campaign and propose member changes from it. See
  // `campaign-repo.ts`'s `listActiveCampaignObjectIds` doc comment.
  try {
    await reconcileCampaignsOrgTick(db, orgId, host, sandbox, selfDomainId);
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
  // UNKEYED, deliberately — this kick must ALWAYS insert or the loop can come back dead. See
  // events/pgboss.ts's LOOP_STARTUP_SEND_IS_UNKEYED for the two ways a key killed it.
  await boss.send(RECONCILE_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
