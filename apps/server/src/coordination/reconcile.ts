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

/** The resumable reconciliation loop. See docs/coordination.md §740. */
export const RECONCILE_QUEUE = "coordination-reconcile-tick";
export const RECONCILE_TICK_INTERVAL_SECONDS = 1;
/** Per-state, per-tick batch cap — bounds one tick's work so a single org's huge backlog can't
 *  starve every other org's turn in the same sweep. */
const BATCH_LIMIT = 25;

/** TRIGGER RETRY BACKOFF. See docs/coordination.md §741. */
const TRIGGER_RETRY_BASE_MS = 2_000;
const TRIGGER_RETRY_CAP_MS = 5 * 60_000;

/** How long a refused target waits before re-firing. See docs/coordination.md §742. */
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

// proposed -> evaluated -> coordinated -> executing. See docs/coordination.md §743.

/** MULTI-REPLICA consistency (M8 hardening audit). See docs/coordination.md §744. */
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
    // S10 single-writer guard. See docs/coordination.md §745.
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

/** Multi-replica single-flight over every unit of work. See docs/coordination.md §746. */
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
          // A compile fault auto-cancels the change. See docs/coordination.md §747.
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
      // M17.4(b) PRE-DEPLOY GATE. See docs/coordination.md §748.
      const gate = await runPreDeployArtifactGate(db, orgId, change);
      if (gate.blocked) continue;

      // Coupled pipelines (M12 P4B). See docs/coordination.md §749.
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

/** A parked change re-checks its prerequisites each tick. See docs/coordination.md §750. */
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
      // Defence in depth: a second edge into execution. See docs/coordination.md §751.
      const gate = await runPreDeployArtifactGate(db, orgId, change);
      if (gate.blocked) continue;

      const { requirements, malformed } = change.rollbackOfObjectId
        ? { requirements: [], malformed: [] }
        : requiresOf(object.properties as Record<string, unknown>);
      await withTenantTx(db, orgId, async (tx) => {
        const statuses = await requirementStatuses(tx, orgId, change.objectId, requirements);
        const unmet = statuses.filter((s) => !s.satisfied);
        if (unmet.length > 0 || malformed.length > 0) {
          // Still waiting, with a round-robin bump. See docs/coordination.md §752.
          await tx
            .update(changes)
            .set({ reconcileCursorAt: new Date() })
            .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)));
          return;
        }
        // Key-reuse warning re-probes each satisfied one. See docs/coordination.md §753.
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

// validating: no state transition happens here automatically. See docs/coordination.md §754.

async function advanceValidatingChanges(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox,
  selfDomainId: TrustDomainId
): Promise<void> {
  // The sixth call site, which never had the skip the others do. See docs/coordination.md §755.
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
      // ROUND-ROBIN BUMP (2 of 5). See docs/coordination.md §756.
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
    // S10 single-writer guard. See docs/coordination.md §757.
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
  // `withFreezeHolds: false` (M25.UI review finding 4). See docs/coordination.md §758.
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
    // Automatic rollback on a gate or control failure. See docs/coordination.md §759.
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

  /** IS THIS CHANGE A ROLLBACK? See docs/coordination.md §760. */
  const isRollback = change.rollbackOfObjectId !== null;

  /** The wave this admission is the exit of. See docs/coordination.md §761. */
  const previousWaveWithTargets = [...plan.waves]
    .filter((w) => w.waveIndex < activeWave.waveIndex && w.targets.length > 0)
    .sort((a, b) => b.waveIndex - a.waveIndex)[0];

  if (activeWave.status === "pending") {
    // The same per-change single-flight, one layer down. See docs/coordination.md §762.
    const gateLock = await tryAcquireChangeCoordinationLock(db, change.objectId);
    if (!gateLock) return; // another tick/replica is genuinely evaluating this wave's gate right now — retry next tick.
    let gateOutcome:
      // `firstBlock` is true only on the tick that persisted. See docs/coordination.md §763.
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
        // Fresh re-check, still under the lock. See docs/coordination.md §764.
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
                        // THE DEPLOY INSTANT, AS DATA. See docs/coordination.md §765.
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
        // PERSIST-ON-CHANGE, not write-every-tick. See docs/coordination.md §766.
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
    // Blocked: the wave stays pending and is re-served. See docs/coordination.md §767.
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
      // ROUND-ROBIN BUMP (3 of 5). See docs/coordination.md §768.
      await withTenantTx(db, orgId, (tx) =>
        tx
          .update(changes)
          .set({ reconcileCursorAt: new Date() })
          .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)))
      );
      return;
    }
  }

  // Unified target reconciliation. See docs/coordination.md §769.
  /** Targets still in flight when this loop ends. See docs/coordination.md §770. */
  let nonTerminalTargets = 0;
  let anyFailed = false;

  // THE STAGE-DEPENDENCY HOLD. See docs/coordination.md §771.
  const declared = stageDependenciesOf(changeProperties);

  /** M25.4 — THE CAMPAIGN RECIPE. See docs/coordination.md §772. */
  const recipe = resolveChangeRecipe(changeProperties);

  /** THE OTHER HALF OF THE HOLD'S DEPENDENCY SET. See docs/coordination.md §773. */
  const changeTargets = targetObjectIdsOf(changeProperties);
  let inTargetSetEdges: DependsOnEdge[] | undefined;
  const loadInTargetSetEdges = async (): Promise<DependsOnEdge[]> =>
    (inTargetSetEdges ??=
      changeTargets.length < 2
        ? []
        : await withTenantTx(db, orgId, (tx) => loadDependsOnEdges(tx, orgId, changeTargets)));

  /** THE FREEZE HOLD. See docs/coordination.md §774. */
  let freezeHolds: Map<string, FreezeHoldVerdict> | undefined;
  const loadFreezeHolds = async (): Promise<Map<string, FreezeHoldVerdict>> =>
    (freezeHolds ??= await withTenantTx(db, orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId,
        targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
      })
    ));

  /** THE CONTINUOUS-TEST HOLD. See docs/coordination.md §775. */
  let continuousHolds: Map<string, ContinuousHoldTargetVerdict> | undefined;
  const loadContinuousHolds = async (): Promise<Map<string, ContinuousHoldTargetVerdict>> =>
    (continuousHolds ??= await withTenantTx(db, orgId, (tx) =>
      evaluateContinuousHolds(tx, {
        orgId,
        targetObjectIds: activeWave.targets.map((t) => t.targetObjectId)
      })
    ));

  /** THE ONE QUALIFIER ON D7'S ROLLBACK EXEMPTION. See docs/coordination.md §776. */
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

  /** Did any target of this wave reach the trigger this tick. See docs/coordination.md §777. */
  let anyTargetTriggered = false;

  /** Every target held this tick, and what held it. See docs/coordination.md §778. */
  const heldTargets: {
    targetObjectId: string;
    stage: { componentObjectId: string; deploymentTargetObjectId: string } | null;
    verdicts: StageDependencyVerdict[];
  }[] = [];

  /** Every target that declared a coupling and got none. See docs/coordination.md §779. */
  const unscopeableTargets: { targetObjectId: string; verdicts: StageDependencyVerdict[] }[] = [];

  /** Every target this tick that an active freeze covered. See docs/coordination.md §780. */
  const frozenTargets: FreezeHoldVerdict[] = [];

  /** Every target whose continuous probe is holding it. See docs/coordination.md §781. */
  const continuousHeldTargets: ContinuousHoldTargetVerdict[] = [];

  for (const target of activeWave.targets) {
    if (target.status === "succeeded") continue;
    if (target.status === "failed" || target.status === "aborted") {
      anyFailed = true;
      continue;
    }
    if (isRefusedWaveTargetStatus(target.status)) {
      // Terminal + a wave failure. See docs/coordination.md §782.
      anyFailed = true;
      continue;
    }

    if (target.status === "pending" || target.status === "triggering") {
      nonTerminalTargets++;
      // Backoff gate: skip a target its executor refused recently. See docs/coordination.md §783.
      const backoffMs = target.status === "triggering" ? triggerBackoffMs(target.attempt) : 0;
      if (backoffMs > 0 && Date.now() - Date.parse(target.updatedAt) < backoffMs) continue;

      // THE FREEZE HOLD. See docs/coordination.md §784.
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

      // STAGE-DEPENDENCY HOLD (ADR-0028 decision 2). See docs/coordination.md §785.
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

      // THE CONTINUOUS-TEST HOLD. See docs/coordination.md §786.
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
              // BOUNDED BEFORE IT BECOMES A ROW. See docs/coordination.md §787.
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

  // TERMINALIZATION, IN TWO RULES RATHER THAN ONE. See docs/coordination.md §788.
  const heldCount = heldTargets.length + frozenTargets.length + continuousHeldTargets.length;
  if (nonTerminalTargets - heldCount > 0) {
    // ROUND-ROBIN BUMP (4 of 5). See docs/coordination.md §789.
    await withTenantTx(db, orgId, (tx) =>
      tx
        .update(changes)
        .set({ reconcileCursorAt: new Date() })
        .where(and(eq(changes.orgId, orgId), eq(changes.objectId, change.objectId)))
    );
    return; // something is genuinely still running
  }
  if (heldCount > 0 && !anyFailed) return;
  await withTenantTx(db, orgId, (tx) =>
    markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded")
  );
}

/** The explainability half of the stage-dependency hold. See docs/coordination.md §790. */
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

/** THE EXPLAINABILITY HALF OF THE FREEZE HOLD. See docs/coordination.md §791. */
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

/** HOLD -> RELEASE (proposal §1.5). See docs/coordination.md §792. */
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

/** THE EXPLAINABILITY HALF OF THE CONTINUOUS-TEST HOLD. See docs/coordination.md §793. */
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

/** HOLD -> RELEASE for the continuous hold. See docs/coordination.md §794. */
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

/** THE FAIL-OPEN, MADE VISIBLE. See docs/coordination.md §795. */
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

/** The shared fail-closed effects for a target we refuse. See docs/coordination.md §796. */
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

/** Can this target's executor honour the change's recipe. See docs/coordination.md §797. */
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
  // A recipe may not drive one of our own actuators. See docs/coordination.md §798.
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

/** Triggers one wave target. See docs/coordination.md §799. */
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
    // FAIL-CLOSED on a masking executor-binding gap. See docs/coordination.md §800.
    const blocked = await withTenantTx(db, orgId, async (tx) => {
      // (0) IS THE TARGET OBJECT STILL THERE? See docs/coordination.md §801.
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

      // Resolution falls back through the target's placements. See docs/coordination.md §802.
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
        // (d) AMBIGUOUS PLACEMENT. See docs/coordination.md §803.
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

      // (a)/(b) discrimination reads the VISIBLE set. See docs/coordination.md §804.
      const all = await listVisibleBindingsForTarget(tx, orgId, targetObjectId);
      if (all.length === 0) return false;

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

    // The recipe, and the two refusals that come with it. See docs/coordination.md §805.
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
      /** M25.4 — what rides on `TriggerIntent.parameters`. See docs/coordination.md §806. */
      const parameters =
        !isRollback && recipe.outcome === "recipe"
          ? recipeTriggerParameters(recipe.recipe)
          : undefined;

      // The executor-specific target id. See docs/coordination.md §807.
      const resolution = await resolveBindingForTarget(tx, orgId, targetObjectId, type);
      const binding = resolution.binding;
      const externalRef = binding?.externalRef ?? null;

      // An indirect resolution is recorded, not left implicit. See docs/coordination.md §808.
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
        // Snapshot the target's CURRENT executor-side state. See docs/coordination.md §809.
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
        // M25.4 — THE CHANNEL THAT WAS NEVER WIRED. See docs/coordination.md §810.
        ...(claim.parameters !== undefined ? { parameters: claim.parameters } : {})
      });
    } catch (err) {
      // Step 3' — the executor REACHED and REFUSED this trigger. See docs/coordination.md §811.
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

/** Ensures the target's executor instance is provisioned. See docs/coordination.md §812. */
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
  // MUST resolve the SAME routing Type the trigger will use. See docs/coordination.md §813.
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
  // `module` describes what was actually started HERE. See docs/coordination.md §814.
  return {
    instanceId: persistedExecutorPluginId ?? DEFAULT_EXECUTOR_INSTANCE_ID,
    module: DEFAULT_EXECUTOR_MODULE
  };
}

/** All waves of `change`'s plan have succeeded. See docs/coordination.md §815. */
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

/** Whether a failed wave has an auto-rollback policy. See docs/coordination.md §816. */
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

/** One org's tick. See docs/coordination.md §817. */
export async function reconcileOrgTick(
  db: Db,
  orgId: string,
  host: PluginHost,
  sandbox: CelSandbox,
  masterKey: Buffer
): Promise<void> {
  const gateDeps: GateDeps = { sandbox, host };
  // S10 single-writer guard. See docs/coordination.md §818.
  const selfDomainId = (await withTenantTx(db, orgId, (tx) => ensureFederationSelf(tx, orgId)))
    .domainId;
  try {
    await withTenantTx(db, orgId, (tx) => processChangeSourceEvents(tx, orgId));
  } catch (err) {
    console.error(`[reconcile] org ${orgId} change-source-event processing failed:`, err);
  }
  // ADR-0046 §4 — THE DOMAIN-LOCAL BINDING RECONCILER. See docs/coordination.md §819.
  try {
    await withTenantTx(db, orgId, (tx) =>
      reconcileExecutorBindingsForOrg(tx, orgId, `reconcile-bindings-${orgId}`)
    );
  } catch (err) {
    console.error(`[reconcile] org ${orgId} executor-binding reconciliation failed:`, err);
  }
  // ADR-0046 §2 — DRAIN THE CONFIG-SOURCE SYNC QUEUE. See docs/coordination.md §820.
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
  // Observe every in-flight hook run, writing on the edge. See docs/coordination.md §821.
  try {
    await pollNonTerminalHookRuns(db, { orgId, host, masterKey });
  } catch (err) {
    console.error(`[reconcile] org ${orgId} pipeline hook run poll failed:`, err);
  }
  // OUTPOST-RUN CONTINUOUS PROBES. See docs/coordination.md §822.
  try {
    await ensureContinuousProbesScheduled(db, { orgId, host, masterKey });
  } catch (err) {
    console.error(`[reconcile] org ${orgId} continuous probe scheduling failed:`, err);
  }
  // Campaigns fan out into real changes, which progress above. See docs/coordination.md §823.
  try {
    await reconcileCampaignsOrgTick(db, orgId, host, sandbox, selfDomainId);
  } catch (err) {
    console.error(`[reconcile] org ${orgId} campaign reconciliation failed:`, err);
  }
}

export interface ReconcileLoopHandle {
  stop(): Promise<void>;
}

/** Wires the self-re-scheduling tick job onto `boss`. See docs/coordination.md §824. */
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
