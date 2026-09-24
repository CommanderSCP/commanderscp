import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql
} from "drizzle-orm";
import type { ExecutionStatus } from "@scp/plugin-api";
import {
  PERSISTED_JSON_MAX_CHARS,
  PERSISTED_JSON_TRUNCATION_MAX_CHARS,
  boundPersistedJson,
  type PersistedJsonTruncation
} from "@scp/runner-launcher";
import type { ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changes, changeWaveTargets, changeWaves, objects } from "../db/schema.js";
import { appendWaveTargetObservedEntry } from "../federation/wave-target-observed-journal.js";
import { canonicalJson } from "../util/canonical-json.js";
import { WAVE_TARGET_TOMBSTONED_STATUS } from "./target-liveness.js";
import {
  WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS,
  WAVE_TARGET_RECIPE_UNREADABLE_STATUS,
  WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS
} from "./campaign-recipe.js";
import {
  WAVE_TARGET_DEPLOYMENT_REFUSED_STATUS,
  WAVE_TARGET_DESTINATION_REFUSED_STATUS,
  WAVE_TARGET_OPS_DECLARATION_REFUSED_STATUS,
  WAVE_TARGET_RECIPE_RESERVED_PARAMETER_STATUS
} from "./trigger-parameter-refusal.js";

/** The wave-target access the reconcile loop needs. See docs/coordination.md §1051. */

export type WaveRow = typeof changeWaves.$inferSelect;
export type WaveTargetRow = typeof changeWaveTargets.$inferSelect;

/** Which domain OWNS (executes) a wave target's `targetObjectId` — the same two shapes
 *  `component-pipeline.ts`'s placement resolution distinguishes:
 *  - **Stage mode**: `targetObjectId` names a `placement` object (`plan-compiler.ts`'s
 *    `compileStages`), whose OWN `originDomainId` is who imported the PLACEMENT record, not who
 *    runs it. The real answer is one hop further, at `properties.deploymentTargetId`'s own object
 *    (`component-pipeline.ts`'s `outpostOf` makes the identical hop) — a placement's origin is never
 *    read directly for this.
 *  - **Legacy/no-topology mode**: `targetObjectId` IS the component (`plan-compiler.ts`'s toposort
 *    path never creates a placement). There is no deployment-target to hop to, so the component's
 *    own `originDomainId` is the only signal this shape has.
 *
 *  THE ONE DEFINITION of "driven elsewhere" (memory: reuse, never invent a second copy) — both
 *  `plan-service.ts`'s `resolveWaveTargetFreshness` (`observedFreshness`'s `not_reported`) and
 *  `wave-target-checks.ts`'s `resolveWaveTargetChecks` (`evidenceOrigin`) call this SAME function
 *  rather than each re-deriving the domain check. */
export async function resolveWaveTargetOriginDomains(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[]
): Promise<Map<string, string | undefined>> {
  const result = new Map<string, string | undefined>();
  if (targetObjectIds.length === 0) return result;

  const rows = await tx
    .select({
      id: objects.id,
      typeId: objects.typeId,
      properties: objects.properties,
      originDomainId: objects.originDomainId
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, targetObjectIds)));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const deploymentTargetIds = new Set<string>();
  for (const row of rows) {
    if (row.typeId !== "placement") continue;
    const deploymentTargetId = (row.properties as { deploymentTargetId?: unknown })
      .deploymentTargetId;
    if (typeof deploymentTargetId === "string") deploymentTargetIds.add(deploymentTargetId);
  }
  const deploymentTargetRows =
    deploymentTargetIds.size === 0
      ? []
      : await tx
          .select({ id: objects.id, originDomainId: objects.originDomainId })
          .from(objects)
          .where(and(eq(objects.orgId, orgId), inArray(objects.id, [...deploymentTargetIds])));
  const originByDeploymentTargetId = new Map(
    deploymentTargetRows.map((r) => [r.id, r.originDomainId as string])
  );

  for (const targetObjectId of targetObjectIds) {
    const row = rowById.get(targetObjectId);
    if (!row) {
      result.set(targetObjectId, undefined); // dangling/deleted — unresolved, never "ours"
      continue;
    }
    if (row.typeId === "placement") {
      const deploymentTargetId = (row.properties as { deploymentTargetId?: unknown })
        .deploymentTargetId;
      const resolved =
        typeof deploymentTargetId === "string"
          ? originByDeploymentTargetId.get(deploymentTargetId)
          : undefined;
      // A placement with no resolvable deployment-target object degrades to the placement's own
      // origin rather than "unresolved" — an honest best-effort, not a crash.
      result.set(targetObjectId, resolved ?? (row.originDomainId as string));
      continue;
    }
    result.set(targetObjectId, row.originDomainId as string);
  }
  return result;
}

/** The current `status` column of one wave, fresh — used by `reconcile.ts`'s pending-wave-gate
 *  branch (M8 hardening MINOR #5) to re-check, INSIDE the per-change advisory lock, whether a
 *  racing tick already evaluated this wave's gate before this one acquired the lock. */
export async function getWaveStatus(
  tx: TenantTx,
  orgId: string,
  waveId: string
): Promise<WaveRow["status"] | undefined> {
  const [row] = await tx
    .select({ status: changeWaves.status })
    .from(changeWaves)
    .where(and(eq(changeWaves.orgId, orgId), eq(changeWaves.id, waveId)));
  return row?.status;
}

export async function markWaveRunning(tx: TenantTx, orgId: string, waveId: string): Promise<void> {
  await tx
    .update(changeWaves)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(changeWaves.orgId, orgId),
        eq(changeWaves.id, waveId),
        eq(changeWaves.status, "pending")
      )
    );
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

/** The claim and record split behind the crash-safe trigger. See docs/coordination.md §1052. */
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

/** Every plugin-supplied value becoming a row passes here. See docs/coordination.md §1053. */
function boundPluginJson<T>(
  value: T,
  maxChars?: number
): { value: T; truncation?: PersistedJsonTruncation } {
  // The cast is the honest one: `boundPersistedJson` may shorten a string, drop an array's tail or
  // replace an over-deep branch with a marker, so the result is the same SHAPE with smaller values,
  // which the type system cannot express for an arbitrary `T`. Every consumer of these columns
  // already treats them as untrusted plugin output.
  const bounded =
    maxChars === undefined ? boundPersistedJson(value) : boundPersistedJson(value, maxChars);
  return { value: bounded.value as T, truncation: bounded.truncation };
}

/** What the column spends on saying what it cut. See docs/coordination.md §1054. */
const OBSERVED_STATE_TRUNCATION_RESERVE = PERSISTED_JSON_TRUNCATION_MAX_CHARS + 32;
const OBSERVED_STATE_VALUE_MAX_CHARS = PERSISTED_JSON_MAX_CHARS - OBSERVED_STATE_TRUNCATION_RESERVE;

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
      // Repository-chosen (the resolved binding's registry id), not plugin-chosen — the one value
      // in this `set` that does not need the bound.
      executorPluginId: update.executorPluginId,
      // Both plugin-supplied, both jsonb, both once verbatim. See docs/coordination.md §1055.
      executorRef: boundPluginJson(update.executorRef).value,
      priorStateRef: boundPluginJson(update.priorStateRef ?? null).value,
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

/** Step 3', the FAILURE arm of the claim/record split. See docs/coordination.md §1056. */
export async function markWaveTargetTriggerFailed(
  tx: TenantTx,
  orgId: string,
  targetId: string
): Promise<boolean> {
  const result = await tx
    .update(changeWaveTargets)
    .set({
      attempt: sql`${changeWaveTargets.attempt} + 1`,
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

/** The observed-state payload persisted on `observed_state`. See docs/coordination.md §1057. */
export interface WaveTargetObservedState {
  revision?: string;
  images?: string[];
  rollout?: {
    phase?: string;
    step?: number;
    weight?: number;
    message?: string;
    /** `spec.strategy.canary.steps.length` off the SAME manifest fetch. See
     *  docs/proposals/pipeline-mockup-data.md §5.1 and `@scp/plugin-api`'s `ExecutionStatus`. */
    stepCount?: number;
  };
  /** managed-iac's plan tally (pipeline-mockup-data.md §6), carried through AS the executor
   *  reported it — never recomputed here. The commander never contacts an execution system
   *  (charter principle 1); this stays inside the Managed Execution Exception because it is an
   *  OBSERVATION of a run the plugin itself already executed, not a new call to anything. */
  plan?: {
    ref?: string;
    add?: number;
    change?: number;
    destroy?: number;
  };
  /** WHAT THE STORE REMOVED FROM THE THREE FIELDS ABOVE. See docs/coordination.md §1058. */
  truncation?: PersistedJsonTruncation;
  /** When THIS payload was written. See docs/coordination.md §1059. */
  observedAt?: string;
}

/** THE EXACT VALUE THAT BECOMES THE `observed_state` COLUMN. See docs/coordination.md §1060. */
export function observedStateForRow(
  observedState: WaveTargetObservedState | null,
  now: Date
): WaveTargetObservedState | null {
  if (observedState === null) return null;
  const bounded = boundPluginJson(observedState, OBSERVED_STATE_VALUE_MAX_CHARS);
  return {
    ...bounded.value,
    ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
    observedAt: now.toISOString()
  };
}

export async function updateWaveTargetObserved(
  tx: TenantTx,
  orgId: string,
  targetId: string,
  status: "observing" | "succeeded" | "failed" | "aborted",
  // Additive (P4B increment 2): the last status() stateRef reconcile observed. Written ONLY when
  // defined — a status() with no stateRef (e.g. an Argo CD app that never synced) must not null out
  // a previously-captured revision. `null` is a caller-explicit clear; `undefined` leaves it as-is.
  observedState?: WaveTargetObservedState | null
): Promise<void> {
  const now = new Date();
  // ONE BOUND, ONE REPORT, ONE ROW. See docs/coordination.md §1061.
  const forRow = observedState === undefined ? undefined : observedStateForRow(observedState, now);
  // THE PRE-IMAGE, read before the update in the same transaction. D4 emits a journal entry only
  // when the observation CHANGED, and "changed" is not answerable from the post-image: this is the
  // one read that separates a real transition from the 1-per-second re-poll of an unchanged
  // `observing` target. Also carries the target's identity in its change (wave index, Type), which
  // the payload needs and this row does not hold.
  const before = await readWaveTargetObservationPreImage(tx, orgId, targetId);
  await tx
    .update(changeWaveTargets)
    .set({
      status,
      lastObservedAt: now,
      updatedAt: now,
      // The reading is dated where it is written, not beside it. See docs/coordination.md §1062.
      ...(forRow !== undefined ? { observedState: forRow } : {})
    })
    .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)));

  if (!before) return; // no such target (or it lost its plan) — nothing observed, nothing to report
  // `undefined` means "leave the stored reading as it is", so the payload must state the STORED
  // rollout in that case, not drop it.
  const rollout = forRow === undefined ? before.observedState?.rollout : forRow?.rollout;
  await journalWaveTargetObservationIfChanged(tx, orgId, {
    before,
    status,
    rollout,
    observedAt: now
  });
}

/** The pre-image `updateWaveTargetObserved` compares against, plus the identity of the target inside
 *  its change. One indexed read by target id, joined up through wave -> plan. */
interface WaveTargetObservationPreImage {
  changeObjectId: string;
  targetObjectId: string;
  type: string;
  waveIndex: number;
  attempt: number;
  status: string;
  observedState: WaveTargetObservedState | null;
}

async function readWaveTargetObservationPreImage(
  tx: TenantTx,
  orgId: string,
  targetId: string
): Promise<WaveTargetObservationPreImage | undefined> {
  const rows = await tx
    .select({
      changeObjectId: changePlans.changeObjectId,
      targetObjectId: changeWaveTargets.targetObjectId,
      type: changeWaveTargets.type,
      waveIndex: changeWaves.waveIndex,
      attempt: changeWaveTargets.attempt,
      status: changeWaveTargets.status,
      observedState: changeWaveTargets.observedState
    })
    .from(changeWaveTargets)
    .innerJoin(
      changeWaves,
      and(
        eq(changeWaves.id, changeWaveTargets.waveId),
        eq(changeWaves.orgId, changeWaveTargets.orgId)
      )
    )
    .innerJoin(
      changePlans,
      and(eq(changePlans.id, changeWaves.planId), eq(changePlans.orgId, changeWaves.orgId))
    )
    .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    changeObjectId: row.changeObjectId,
    targetObjectId: row.targetObjectId,
    type: row.type,
    waveIndex: row.waveIndex,
    attempt: row.attempt,
    status: row.status,
    observedState: (row.observedState as WaveTargetObservedState | null) ?? null
  };
}

/**
 * D4's ON-CHANGE-ONLY RULE, in one place.
 *
 * An entry is appended only when this reading differs from the one already stored — status, or the
 * rollout snapshot the read surfaces actually render. A re-poll that re-reads the same `observing`
 * status and the same canary weight appends NOTHING, and neither does a `lastObservedAt` refresh.
 * That is what keeps the journal proportional to real transitions instead of to poll ticks or
 * elapsed time; the 1.44 GB/day Decision-growth incident is the measured cost of getting this wrong
 * on a per-tick writer (memory `scp-unbounded-decision-growth`, proposal §9).
 *
 * The comparison is over the PAYLOAD's own fields, deliberately: `revision` and `images` can change
 * without moving anything the pips or the status word show, and shipping an entry for them would
 * make the volume bound depend on how chatty an executor's `stateRef` is.
 */
async function journalWaveTargetObservationIfChanged(
  tx: TenantTx,
  orgId: string,
  input: {
    before: WaveTargetObservationPreImage;
    status: string;
    rollout: WaveTargetObservedState["rollout"];
    observedAt: Date;
  }
): Promise<void> {
  const { before, status, rollout, observedAt } = input;
  // `canonicalJson`, NOT `JSON.stringify`. The stored rollout came back out of a jsonb column, and
  // Postgres does not preserve object key order — it stores jsonb keys sorted by length then
  // alphabetically, so `{phase, step, weight}` in and `{step, phase, weight}` out compare unequal
  // under a plain stringify and EVERY poll looks like a change. Measured, not reasoned: the
  // on-change-only test appended 4 entries for 4 identical polls until this line used the same
  // canonicaliser `objects-repo.ts` uses for its own persist-on-change comparison.
  const unchanged =
    before.status === status &&
    canonicalJson(before.observedState?.rollout ?? null) === canonicalJson(rollout ?? null);
  if (unchanged) return;
  await appendWaveTargetObservedEntry(tx, orgId, {
    subject: "target",
    changeObjectId: before.changeObjectId,
    targetObjectId: before.targetObjectId,
    type: before.type,
    waveIndex: before.waveIndex,
    status,
    attempt: before.attempt,
    ...(rollout === undefined ? {} : { rollout }),
    observedAt: observedAt.toISOString()
  });
}

/** Normalizes a status into the observed-state payload. See docs/coordination.md §1063. */
export function observedStateFrom(
  status: Pick<ExecutionStatus, "stateRef" | "observed">
): WaveTargetObservedState | undefined {
  const result: WaveTargetObservedState = {};

  const stateRef = status.stateRef;
  if (typeof stateRef === "string") {
    result.revision = stateRef;
  } else if (
    typeof stateRef === "object" &&
    stateRef !== null &&
    typeof (stateRef as { revision?: unknown }).revision === "string"
  ) {
    // M28.4 (ADR-0055 D-c): an SCP-authored Application's stateRef is `{ revision, scpAuthoredApplication }`
    // — the revision is still the synced revision; the manifest is for rollback, not for display.
    result.revision = (stateRef as { revision: string }).revision;
  } else if (stateRef !== undefined && stateRef !== null) {
    // Non-string stateRef (later increments emit a typed digest/rollout object). Stringify defensively
    // so today's opaque value is still captured rather than dropped.
    result.revision = String(stateRef);
  }

  const images = status.observed?.images?.filter(
    (img): img is string => typeof img === "string" && img.length > 0
  );
  if (images && images.length > 0) result.images = images;

  // OBSERVE-ONLY rollout snapshot (P4D increment 4) — carried through as the executor reported it,
  // only when present so a status() without it never nulls a previously-captured rollout.
  const rollout = status.observed?.rollout;
  if (rollout && Object.keys(rollout).length > 0) result.rollout = rollout;

  // managed-iac's plan tally (pipeline-mockup-data.md §6) — same "only when present" rule: a
  // status() with no plan (a rollback, a parse miss) must not null out a previously-captured one.
  const plan = status.observed?.plan;
  if (plan && Object.keys(plan).length > 0) result.plan = plan;

  return result.revision !== undefined ||
    result.images !== undefined ||
    result.rollout !== undefined ||
    result.plan !== undefined
    ? result
    : undefined;
}

/** Every terminal status meaning we refused to drive it. See docs/coordination.md §1064. */
export const REFUSED_WAVE_TARGET_STATUSES = [
  "no_executor",
  WAVE_TARGET_TOMBSTONED_STATUS,
  WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS,
  WAVE_TARGET_RECIPE_UNREADABLE_STATUS,
  // M25.4 / OQ-5 — a recipe aimed at one of CommanderSCP's OWN actuators. The mechanism above did
  // its job on the very next status added: this line is the ONLY edit that was needed, and
  // `blockWaveTarget`, `terminalizeRefusedWaveTarget`, the per-target terminal skip and
  // `service-board.ts` all picked it up from the type.
  WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS,
  // M28.4 (ADR-0055) — SCP was asked to author this target's Argo CD Application and the
  // declaration could not be authored (`deploy-lane-trigger-parameters.ts`).
  WAVE_TARGET_DEPLOYMENT_REFUSED_STATUS,
  // M28.4 fix round (ADR-0055 D9) — a recipe named a server-reserved trigger parameter.
  WAVE_TARGET_RECIPE_RESERVED_PARAMETER_STATUS,
  // M28.1 (ADR-0053) — a trigger-parameter derivation that refused. Before this they threw inside
  // the claim transaction and were retried every tick with no Decision at all.
  WAVE_TARGET_DESTINATION_REFUSED_STATUS,
  WAVE_TARGET_OPS_DECLARATION_REFUSED_STATUS
] as const;
export type RefusedWaveTargetStatus = (typeof REFUSED_WAVE_TARGET_STATUSES)[number];

/** Is this status one reconcile refused to drive? Used by the per-target loop's terminal skip, so
 *  that branch and the terminalizer can never disagree about the set. */
export function isRefusedWaveTargetStatus(status: string): status is RefusedWaveTargetStatus {
  return (REFUSED_WAVE_TARGET_STATUSES as readonly string[]).includes(status);
}

/** Terminalize a refused target on a per-cause status. See docs/coordination.md §1065. */
export async function terminalizeRefusedWaveTarget(
  tx: TenantTx,
  orgId: string,
  targetId: string,
  status: RefusedWaveTargetStatus
): Promise<boolean> {
  const result = await tx
    .update(changeWaveTargets)
    .set({ status, lastObservedAt: new Date(), updatedAt: new Date() })
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

/** Wave-target statuses that RECORD AN OUTCOME. See docs/coordination.md §1066. */
const TERMINAL_WAVE_TARGET_STATUSES: string[] = [
  "succeeded",
  "failed",
  "aborted",
  ...REFUSED_WAVE_TARGET_STATUSES
];

/** Has this target's status recorded an outcome? Exported so the federation replica's monotone rule
 *  (`peer-observations-repo.ts`) reads THIS set rather than restating it — the set has grown twice
 *  already, and a copy of it in a second module is how one of the two starts disagreeing. */
export function isTerminalWaveTargetStatus(status: string): boolean {
  return TERMINAL_WAVE_TARGET_STATUSES.includes(status);
}

/** Does a change in this state still stand behind them. See docs/coordination.md §1067. */
const CHANGE_STANDS_BEHIND_ITS_TARGETS: Record<ChangeState, boolean> = {
  proposed: false,
  evaluated: false,
  coordinated: true,
  waiting: false,
  executing: true,
  validating: false,
  accepted: false,
  cancelled: false,
  rolled_back: false
};

const DRIVING_CHANGE_STATES = (
  Object.keys(CHANGE_STANDS_BEHIND_ITS_TARGETS) as ChangeState[]
).filter((state) => CHANGE_STANDS_BEHIND_ITS_TARGETS[state]);

/** The most recent target some change still stands behind. See docs/coordination.md §1068. */
export async function findLatestWaveTargetForObject(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<WaveTargetRow | undefined> {
  const rows = await tx
    .select(getTableColumns(changeWaveTargets))
    .from(changeWaveTargets)
    .innerJoin(
      changeWaves,
      and(
        eq(changeWaves.id, changeWaveTargets.waveId),
        eq(changeWaves.orgId, changeWaveTargets.orgId)
      )
    )
    .innerJoin(
      changePlans,
      and(eq(changePlans.id, changeWaves.planId), eq(changePlans.orgId, changeWaves.orgId))
    )
    .innerJoin(
      changes,
      and(eq(changes.objectId, changePlans.changeObjectId), eq(changes.orgId, changePlans.orgId))
    )
    .innerJoin(objects, and(eq(objects.id, changes.objectId), eq(objects.orgId, changes.orgId)))
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changeWaveTargets.targetObjectId, targetObjectId),
        isNull(objects.deletedAt),
        or(
          inArray(changeWaveTargets.status, TERMINAL_WAVE_TARGET_STATUSES),
          and(inArray(changes.state, DRIVING_CHANGE_STATES), isNull(changes.reconcileBlockedAt))
        )
      )
    )
    .orderBy(desc(changeWaveTargets.createdAt), desc(changeWaveTargets.id))
    .limit(1);
  return rows[0];
}

/** The "prior known-good state" lookup (DESIGN §9.4). See docs/coordination.md §1069. */
export async function findLatestSucceededExecution(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  executorPluginId: string
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
        eq(changeWaveTargets.executorPluginId, executorPluginId),
        eq(changeWaveTargets.status, "succeeded")
      )
    )
    .orderBy(desc(changeWaveTargets.updatedAt))
    .limit(1);
  return rows[0]?.target;
}

/** The matching wave target on the change being rolled back. See docs/coordination.md §1070. */
/** Did the original ever hand this target to an executor. See docs/coordination.md §1071. */
export async function originalChangeDispatchedTarget(
  tx: TenantTx,
  orgId: string,
  originalChangeObjectId: string,
  targetObjectId: string
): Promise<boolean> {
  const rows = await tx
    .select({ id: changeWaveTargets.id })
    .from(changeWaveTargets)
    .innerJoin(changeWaves, eq(changeWaveTargets.waveId, changeWaves.id))
    .innerJoin(changePlans, eq(changeWaves.planId, changePlans.id))
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changePlans.changeObjectId, originalChangeObjectId),
        eq(changeWaveTargets.targetObjectId, targetObjectId),
        or(gt(changeWaveTargets.attempt, 0), isNotNull(changeWaveTargets.executorRef))
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function findOriginalWaveTarget(
  tx: TenantTx,
  orgId: string,
  originalChangeObjectId: string,
  targetObjectId: string,
  executorPluginId: string
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
        eq(changeWaveTargets.targetObjectId, targetObjectId),
        eq(changeWaveTargets.executorPluginId, executorPluginId)
      )
    )
    .orderBy(desc(changePlans.createdAt))
    .limit(1);
  return rows[0]?.target;
}
