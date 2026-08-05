import { and, desc, eq, getTableColumns, inArray, isNull, or, sql } from "drizzle-orm";
import type { ExecutionStatus } from "@scp/plugin-api";
import type { ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changes, changeWaveTargets, changeWaves, objects } from "../db/schema.js";

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

/**
 * The claim/record split behind CRITICAL #2's crash-safe trigger flow (PR #7 review;
 * coordination/reconcile.ts's `triggerWaveTarget` doc comment has the full three-step design):
 *
 *  1. `claimWaveTargetForTriggering` (tx A, its own commit) — flips `pending` -> `triggering`.
 *     Matches `pending` OR `triggering` in its WHERE guard so a target already `triggering` from
 *     a PRIOR attempt that crashed before reaching step 3 can be re-claimed by the same or a
 *     different tick and retried with the identical idempotencyKey, rather than getting stuck
 *     forever because it's no longer literally `pending`.
 *  2. The caller calls `plugin.trigger(intent)` OUTSIDE any transaction.
 *  3. `markWaveTargetTriggered` (tx B, its own commit) — flips `triggering` -> `triggered` and
 *     records the executor's returned ref. Guarded on `triggering` (not `pending`) since step 1
 *     already consumed the `pending` state.
 *
 * MULTI-REPLICA SINGLE-FLIGHT (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6): this function's
 * WHERE guard, on its own, does NOT distinguish "a `triggering` row abandoned by a crashed prior
 * attempt" from "a `triggering` row another worker REPLICA's overlapping tick is, right now,
 * genuinely still in the middle of processing" — under Postgres READ COMMITTED semantics, a
 * second concurrent caller whose `UPDATE` blocked on this row's lock re-evaluates the SAME `WHERE`
 * against the just-committed `triggering` row once unblocked, and that broad `IN (...)` still
 * matches. Fixing that HERE (e.g. with a time-based staleness window) was tried and reverted: it
 * directly conflicts with this function's own crash-recovery contract, which several M3 tests
 * exercise by retrying an abandoned `triggering` row on the VERY NEXT tick (no time budget to
 * spare). The actual fix lives one layer up: `coordination/trigger-claim-lock.ts`'s Postgres
 * advisory lock, held by `reconcile.ts`'s `triggerWaveTarget` for the full claim -> `trigger()` ->
 * record sequence. That lock is the true mutual-exclusion boundary — only its holder ever calls
 * this function for a given `targetId` — so by the time this UPDATE runs, "another attempt is
 * genuinely, concurrently here too" is already structurally impossible, and this WHERE guard is
 * free to stay exactly as simple (and exactly as fast to retry) as it always was.
 */
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
        eq(changeWaveTargets.status, "triggering")
      )
    )
    .returning({ id: changeWaveTargets.id });
  return result.length > 0;
}

/**
 * Step 3', the FAILURE arm of the claim/record split — records that `plugin.trigger()` was called
 * and REJECTED, so the retry can be backed off instead of hammered.
 *
 * THE MEASURED PRODUCTION STORM (homelab, 2026-08-01): 19 `argocd trigger: sync returned HTTP 400`
 * against 12 successful syncs in 15 minutes, every 400 on the SAME target. Argo CD rejects a sync
 * request while an operation is already running on that Application, and the homelab's backlog has
 * many changes fanning out onto a handful of Argo apps. Before this, a rejected trigger left the
 * row `triggering` with `attempt` still 0 (only `markWaveTargetTriggered` ever wrote `attempt`, and
 * only on success), so the next tick — one second later — re-claimed and re-fired it, forever.
 *
 * `attempt` is deliberately the ONLY signal the backoff reads, and it is written HERE and nowhere
 * else on the failure path. That is what preserves this file's crash-recovery contract: a tick that
 * dies between `claimWaveTargetForTriggering` and here leaves `attempt` at 0, so the abandoned
 * `triggering` row is still retried on the VERY NEXT tick with no delay — exactly as the M3 suites
 * require, and exactly as the doc comment above promises. Only a trigger that genuinely reached the
 * executor and was refused earns a backoff.
 *
 * Status stays `triggering` so the existing `pending`-or-`triggering` re-claim path is unchanged.
 */
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

/**
 * The observed-state payload persisted on `observed_state` (ADR-0008 decisions 1-2): the last-observed
 * snapshot a status() poll reported. `revision` is the synced revision (`ExecutionStatus.stateRef`, a
 * string revision today); `images` is the deployed image refs (`ExecutionStatus.observed.images`, e.g.
 * `ghcr.io/x/y:1.2.3` or `...@sha256:...`). Surfaced as the per-wave version. `rollout` (P4D
 * increment 4) is the OBSERVE-ONLY progressive-delivery snapshot (`ExecutionStatus.observed.rollout`
 * — an Argo Rollout's phase/step/weight/message as the executor reports it); it is display-only and
 * carries NO drive verb (ADR-0008: rollout state is OBSERVED, NOT DRIVEN).
 */
export interface WaveTargetObservedState {
  revision?: string;
  images?: string[];
  rollout?: { phase?: string; step?: number; weight?: number; message?: string };
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
  await tx
    .update(changeWaveTargets)
    .set({
      status,
      lastObservedAt: new Date(),
      updatedAt: new Date(),
      ...(observedState !== undefined ? { observedState } : {})
    })
    .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)));
}

/**
 * Normalize an `ExecutionStatus` into the observed-state payload. Reads BOTH the synced revision
 * (`stateRef`, opaque `unknown` — P4B increment 2) and the deployed image refs (`observed.images` —
 * P4C increment 3). A string stateRef is stored under `revision`; non-empty images under `images`.
 * Returns `undefined` when the status carries NEITHER, so `updateWaveTargetObserved` leaves a
 * previously-captured value intact rather than nulling it (a never-synced app must not erase what an
 * earlier poll observed).
 */
export function observedStateFrom(
  status: Pick<ExecutionStatus, "stateRef" | "observed">
): WaveTargetObservedState | undefined {
  const result: WaveTargetObservedState = {};

  const stateRef = status.stateRef;
  if (typeof stateRef === "string") {
    result.revision = stateRef;
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

  return result.revision !== undefined ||
    result.images !== undefined ||
    result.rollout !== undefined
    ? result
    : undefined;
}

/**
 * Terminalize a wave target on the dedicated `no_executor` status (M12 — fail-closed on a masking
 * executor-binding gap; docs/adr/0006): the target holds at least one real executor binding but NONE
 * for the purpose this wave rolls, so fake-succeeding it would hide a misconfiguration. A DISTINCT
 * terminal value (not `failed`) so `scp change explain`/the UI can name the actual cause, mirroring
 * `campaign_waves`' purpose-built `blocked`.
 *
 * Guarded on `status IN ('pending','triggering')` and RETURNING so the caller emits the block
 * Decision + hash-chained audit event EXACTLY ONCE: a later reconcile tick that finds the target
 * already `no_executor` gets `false` back and appends nothing to the audit chain (idempotency). The
 * trigger-claim advisory lock (`triggerWaveTarget`) already serializes callers; this guard is the
 * durable backstop that keeps the once-only property true regardless.
 */
export async function markWaveTargetNoExecutor(
  tx: TenantTx,
  orgId: string,
  targetId: string
): Promise<boolean> {
  const result = await tx
    .update(changeWaveTargets)
    .set({ status: "no_executor", lastObservedAt: new Date(), updatedAt: new Date() })
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

/**
 * Wave-target statuses that RECORD AN OUTCOME — something was actually attempted at that place and
 * this row says how it went. The set is `reconcile.ts`'s per-target loop read the other way round:
 * every branch that `continue`s WITHOUT incrementing `nonTerminalTargets` (`succeeded`, `failed`,
 * `aborted`, `no_executor`) is here, and every branch that increments it (`pending`, `triggering`,
 * `triggered`, `observing`) is not.
 *
 * A terminal row is believable no matter what became of the change that produced it: cancelling a
 * change after its deploy succeeded does not un-deploy it, and a `failed` row is an accurate account
 * of a real attempt whether or not anyone is still tending the change.
 */
const TERMINAL_WAVE_TARGET_STATUSES: string[] = ["succeeded", "failed", "aborted", "no_executor"];

/**
 * Does a change in this state still STAND BEHIND its NON-terminal wave targets — is something
 * actually going to drive that `pending`/`triggering`/`triggered`/`observing` row to an outcome?
 *
 * EXHAUSTIVE BY CONSTRUCTION, and that is the point of the shape. This started life as a
 * hand-written two-element array (`["cancelled", "rolled_back"]`) that enumerated the states somebody
 * had thought of, and it was wrong the day it was written: plans are compiled at
 * `evaluated -> coordinated`, BEFORE a change executes, so a change that never starts still owns
 * `pending` rows — and being newest they outrank the dependency's genuinely successful earlier deploy
 * at the same place. `Record<ChangeState, boolean>` makes the compiler refuse a new state until
 * somebody rules on it here, the same forcing function `watchdog.ts`'s `WATCHDOG_SLA_MS` uses.
 *
 * THE RULING, state by state:
 *
 *  * `proposed`, `evaluated` — NO PLAN EXISTS YET (`compileAndPersistPlan` runs on the
 *    `evaluated -> coordinated` edge), so there are no rows to stand behind; and there is no edge
 *    back into either state, so a change cannot return here carrying old ones.
 *  * `coordinated` — a plan exists and every target is `pending`, but NOTHING HAS BEEN TRIGGERED and
 *    the change is not guaranteed to move: a freeze or any other gate on `coordinated -> executing`
 *    throws inside `advanceCoordinatedChanges`, which logs and retries, so a change can sit here for
 *    as long as the freeze lasts. Counting those `pending` rows would hold every dependant of that
 *    component behind a release that has not started. What this gives up is one tick of "B is about
 *    to deploy" — a guarantee the coupling never made anyway, since B could equally not be proposed.
 *  * `waiting` — parked on its own unsatisfied `requires`, and the owner's rule for that state is
 *    "wait forever, warn at 24h". Its `pending` rows may never become anything.
 *  * `executing` — YES. This is the in-flight case the coupling exists for: B is rolling out v2 at
 *    this place right now and A must wait for v2 rather than being let through by v1's old success.
 *  * `validating`, `accepted` — execution is over. Every target that ran carries a terminal status
 *    and is picked up by {@link TERMINAL_WAVE_TARGET_STATUSES} on its own; a non-terminal row left
 *    behind on a terminalized wave (ADR-0028: a held target is left `pending` on a failed wave) is
 *    one nothing will ever come back for.
 *  * `cancelled`, `rolled_back` — abandoned. Nothing on either path touches `change_wave_targets`,
 *    so a cancel mid-flight freezes every target exactly where it stood, for the lifetime of the
 *    database.
 */
const CHANGE_STANDS_BEHIND_ITS_TARGETS: Record<ChangeState, boolean> = {
  proposed: false,
  evaluated: false,
  coordinated: false,
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

/**
 * The MOST RECENT wave target for one object that some change still stands behind — the read the
 * stage-dependency hold (ADR-0028) asks about a dependency's placement: *"what is B's latest deploy
 * at this place, and how far has it got?"*
 *
 * Deliberately NOT filtered by status, executor, or which change: the hold's universal test is
 * "the latest one reached `succeeded`", and a filter would answer a different question. Filtering to
 * `succeeded` in particular would say yes for a dependency that succeeded last week and is RIGHT NOW
 * mid-redeploy at the same place — which is exactly the situation the coupling exists to order.
 *
 * WHAT *IS* FILTERED, AND WHY IT HAS TO BE — ONE PROPERTY, not a list of symptoms:
 *
 *   **A wave target that no change is actively standing behind must not be read as the dependency's
 *   current state at this place.**
 *
 * A row qualifies as an account of a deploy in exactly two ways, and the `WHERE` below says only
 * that: it either RECORDS AN OUTCOME ({@link TERMINAL_WAVE_TARGET_STATUSES} — something really
 * happened here and this is how it went), or it is still non-terminal and a change that is
 * {@link CHANGE_STANDS_BEHIND_ITS_TARGETS} is driving it toward one. Anything else is an INTENTION
 * nobody is acting on — a plan compiled for a change that parked, was abandoned, or has not started
 * — and being NEWEST it would outrank, and permanently mask, the dependency's genuinely successful
 * earlier deploy at the same place. Skipping it makes this read fall back to the next row that does
 * describe a deploy, which is the one an operator would name if you asked them.
 *
 * Two shapes of "not standing behind it" are worth naming because each cost a real wedge:
 *
 *   * A change PARKED BY `markChangeReconcileBlocked` — a wave that failed SOMEWHERE ELSE, or an
 *     ADR-0006 `no_executor` masking gap. It is excluded from `listChangeRowsInStates` and therefore
 *     from every future tick, so its untouched `pending` rows at OTHER places will never be
 *     triggered. Hence `reconcile_blocked_at IS NULL` beside the state test rather than the state
 *     test alone: `executing` is necessary but not sufficient.
 *   * A change in `waiting` (or `coordinated`) whose plan was compiled at `evaluated -> coordinated`
 *     — BEFORE anything executes. Its `pending` rows are the plan, not a deploy.
 *
 * THE BOUNDARY, stated because it is deliberately NOT the same call: a `failed`/`aborted`/
 * `no_executor` LATEST TARGET is KEPT, and it holds — even though the change owning it is parked.
 * That row is terminal: a real attempt was made here and it failed, which is a fact about the place,
 * not about who is tending the change. "Do not deploy ahead of a dependency whose own deploy here
 * just failed" is the guarantee working. (An ADR-0006 `no_executor` gap therefore holds dependants
 * until it is fixed, rolled back, or cancelled — all three of which are actions somebody takes.) By
 * the same token a SUCCEEDED row stays believable after its change is cancelled: cancelling a change
 * does not un-deploy what already shipped.
 *
 * Separately, and for a different reason, a SOFT-DELETED change object is excluded outright. That is
 * the same join `component-pipeline.ts`'s `currentByPlacement` already makes for the same "what last
 * happened at this stage" question (`o.deleted_at IS NULL`). The two reads used to disagree, and a
 * hold that believes a row the pipeline view has stopped showing is unexplainable from the UI an
 * operator would reach for.
 *
 * "Most recent" is by the TARGET's `created_at` then `id`, matching how ids are minted (UUIDv7,
 * time-ordered) and NOT by `updated_at`, which moves on every poll: ordering by `updated_at` would
 * let an older row that is still being observed outrank the newer plan's row. Served by
 * `change_wave_targets_org_target`.
 */
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

/**
 * The "prior known-good state" lookup (DESIGN §9.4): the most recently SUCCEEDED wave-target
 * execution of `targetObjectId` **that ran on the CURRENT executor plugin instance**
 * (`executorPluginId`), across ANY change (not just the one currently being planned) — its
 * `executorRef` is what a fresh forward trigger captures a `priorStateRef` snapshot from (via
 * `status()`, by the caller), and its OWN `priorStateRef` is what a rollback of THIS specific
 * change's trigger would restore.
 *
 * The executor-instance filter is load-bearing: a target's most recent succeeded execution may
 * have run on a DIFFERENT executor (e.g. an infra push that fell back to the fake-executor vs. a
 * software promotion via argocd). That row's `executorRef` is only meaningful to the executor
 * that produced it — handing a foreign ref to this instance's `status()` makes it query a
 * resource that doesn't exist under it (e.g. argocd `GET /applications/<uuid>` → 403), which
 * throws inside the trigger tx and wedges the wave forever. So we only ever consider a prior
 * succeeded execution recorded under the SAME instance; when there is none, the caller leaves
 * `priorStateRef` null and the trigger proceeds normally.
 */
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

/** The corresponding wave target for `targetObjectId` on the change that `rollbackOfObjectId`
 *  refers to's MOST RECENT plan — used by a rollback change to find what `priorStateRef` its
 *  own trigger should carry (the original's captured "before this change touched it" snapshot).
 *  Filtered to the CURRENT executor plugin instance (`executorPluginId`) for the same reason as
 *  `findLatestSucceededExecution`: the original target's `priorStateRef` is an executor-specific
 *  state handle, and passing one produced by a DIFFERENT executor into this instance's rollback
 *  `trigger()` is meaningless (and dangerous). When the original ran on another executor, no row
 *  matches and the rollback carries a null `priorStateRef`. */
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
