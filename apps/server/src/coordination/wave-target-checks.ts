import type {
  PipelineHookKind,
  PipelineHookState,
  WaveTargetCheckSlot,
  WaveTargetChecks
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { changeWaves, changeWaveTargets } from "../db/schema.js";
import {
  alarmReportsInWindow,
  latestTestRunEvidence,
  listHooksForComponents,
  resolveHookSubjects,
  type PipelineHookRow,
  type PipelineHookSubject
} from "./pipeline-hooks-repo.js";
import { evaluateBakeGate, evaluateContinuousHold } from "./pipeline-hook-verdicts.js";
import { waveTargetDeployedAt } from "./pipeline-hook-gate.js";
import { listHookRunsForChange, type PipelineHookRunRow } from "./pipeline-hook-runs.js";

/** THE PER-TARGET CHECKS RAIL, projected — `ChangeWaveTargetSchema.checks`
 *  (docs/schemas.md §67a, docs/proposals/pipeline-mockup-data.md §3, increment 3).
 *
 *  A READ PROJECTION and nothing else: no Decision, no write, no table. Every verdict comes from
 *  the SAME function the enforcing path calls — `evaluateContinuousHold` (the per-target hold),
 *  `evaluateBakeGate` and `waveTargetDeployedAt` (the wave-boundary gate). That is the whole
 *  correctness argument: a second copy of any of them would let the rail and the gate disagree
 *  about the same target, which is worse than showing nothing. */

/** THE FOUR SLOTS, IN PIPELINE ORDER — fixed, always all four, never filtered down to the declared
 *  ones. Fixed position is what makes a column of target rows scannable ("the third slot is always
 *  the canary"), and a slot that disappears when nothing is declared is exactly the absence the
 *  rail exists to make visible. */
export const CHECK_SLOT_ORDER = [
  "postMerge",
  "postDeploy",
  "continuous",
  "bakeAlarms"
] as const satisfies readonly PipelineHookKind[];

/** WHAT THE RECORD BEHIND EACH KIND IS KEYED BY. See `WaveTargetCheckSlotSchema.grain`:
 *  `pipeline_hook_runs` is identified by `(change, hookId, waveIndex)` and NOT by target, so the
 *  first two kinds repeat a wave-level (or change-level) fact across a wave's target rows. Stated
 *  on the wire rather than left for the UI to assume. */
const SLOT_GRAIN: Record<(typeof CHECK_SLOT_ORDER)[number], string> = {
  postMerge: "per_change",
  postDeploy: "per_wave",
  continuous: "per_target",
  bakeAlarms: "per_target"
};

type WaveRow = typeof changeWaves.$inferSelect;
type TargetRow = typeof changeWaveTargets.$inferSelect;

export interface ResolveWaveTargetChecksInput {
  changeObjectId: string;
  /** The plan's waves — read for each target's `waveIndex` (the `postDeploy` run's identity) and
   *  `name` (the STAGE a stage-narrowed hook is matched against; `plan-compiler.ts` copies the
   *  topology wave's name onto every step, which is what makes `change_waves.name` the stage). */
  waves: WaveRow[];
  targets: TargetRow[];
  /** Injected for testability, exactly as the gate injects it. Production passes nothing. */
  now?: Date | undefined;
}

/** `ChangeWaveTargetSchema.checks`, for every row in `targets`, keyed by the row's OWN id. */
export async function resolveWaveTargetChecks(
  tx: TenantTx,
  orgId: string,
  input: ResolveWaveTargetChecksInput
): Promise<Map<string, WaveTargetChecks>> {
  const result = new Map<string, WaveTargetChecks>();
  if (input.targets.length === 0) return result;
  const now = input.now ?? new Date();

  const targetObjectIds = [...new Set(input.targets.map((t) => t.targetObjectId))];
  const subjects = await resolveHookSubjects(tx, orgId, targetObjectIds);
  const componentObjectIds = [...new Set([...subjects.values()].map((s) => s.componentObjectId))];

  // ONE indexed read for every declaration on every component in the plan. This is also the
  // inertness gate: an org that declares nothing gets four empty slots per target and not a single
  // further query — the empty slots ARE the answer ("nobody promised any of this"), so they are
  // emitted rather than skipped.
  const hooks = await listHooksForComponents(tx, orgId, componentObjectIds);
  const byComponent = new Map<string, PipelineHookRow[]>();
  for (const hook of hooks) {
    const list = byComponent.get(hook.componentObjectId) ?? [];
    list.push(hook);
    byComponent.set(hook.componentObjectId, list);
  }

  // ONE indexed read (`pipeline_hook_runs_by_change`) for the whole change, and only when some
  // run-backed kind is actually declared — the other two kinds are evidence-backed and never look
  // at a run row.
  const anyRunBackedHook = hooks.some((h) => h.kind === "postMerge" || h.kind === "postDeploy");
  const runs = anyRunBackedHook ? await listHookRunsForChange(tx, orgId, input.changeObjectId) : [];

  const waveById = new Map(input.waves.map((w) => [w.id, w]));

  for (const target of input.targets) {
    const subject = subjects.get(target.targetObjectId);
    if (!subject) {
      // NO SUBJECT, NO ANSWER. `resolveHookSubjects` drops a soft-deleted target object and a
      // `placement` missing half its identity, so there is no component whose declarations could be
      // read. "Nothing is declared" would be a claim this instance cannot make; `unresolvable` says
      // what actually happened.
      result.set(target.id, {
        basis: "unresolvable",
        reason:
          "this wave target's object could not be resolved to a component — it is deleted, or it is a placement missing its component or deployment-target id, so no hook declaration can be read for it"
      });
      continue;
    }
    const wave = waveById.get(target.waveId);
    const applicable = byComponent.get(subject.componentObjectId) ?? [];

    const slots: WaveTargetCheckSlot[] = [];
    for (const kind of CHECK_SLOT_ORDER) {
      const declared = applicable
        .filter((h) => h.kind === kind)
        .sort((a, b) => a.hookId.localeCompare(b.hookId));
      const states: PipelineHookState[] = [];
      for (const hook of declared) {
        states.push(
          await hookState(tx, orgId, {
            hook,
            subject,
            target,
            wave,
            runs,
            now
          })
        );
      }
      slots.push({ kind, grain: SLOT_GRAIN[kind], hooks: states });
    }
    result.set(target.id, { basis: "resolved", slots });
  }

  return result;
}

interface HookStateInput {
  hook: PipelineHookRow;
  subject: PipelineHookSubject;
  target: TargetRow;
  /** `undefined` only for a target row whose wave row was not passed in — see the branch below. */
  wave: WaveRow | undefined;
  runs: PipelineHookRunRow[];
  now: Date;
}

async function hookState(
  tx: TenantTx,
  orgId: string,
  input: HookStateInput
): Promise<PipelineHookState> {
  const { hook, subject, target, wave, runs, now } = input;
  const hookId = hook.hookId;

  if (wave === undefined) {
    // Defensive: a target row whose wave row is missing has no wave index and no stage, so neither
    // the run identity nor the stage rule can be evaluated. Stating that beats guessing `not_run`.
    return {
      state: "not_applicable",
      hookId,
      reason: `this wave target's wave row was not loaded, so neither the run identity (change, '${hookId}', waveIndex) nor the stage narrowing can be resolved`
    };
  }

  // THE STAGE RULE, read off `pipeline-hook-gate.ts`'s one-liner rather than re-invented: an absent
  // `stage` applies everywhere, and a present one narrows to waves at that stage.
  if (kindIsStageNarrowable(hook.kind) && hook.stage !== null && hook.stage !== wave.name) {
    return {
      state: "not_applicable",
      hookId,
      reason: `declared only for stage '${hook.stage}', and this wave's stage is ${wave.name === null ? "unnamed" : `'${wave.name}'`}`
    };
  }
  if (hook.kind === "postMerge" && hook.stage !== null) {
    // A stage-narrowed `postMerge` hook gates NOTHING, ever: the gate's post-merge path runs before
    // any wave and passes `stage: null`, against which every non-null `stage` fails the same
    // one-line rule. Worth saying out loud — it is almost certainly an authoring mistake, and
    // silently rendering it as `not_run` would hide it forever.
    return {
      state: "not_applicable",
      hookId,
      reason: `declared for stage '${hook.stage}', but the post-merge gate runs before any wave has a stage, so no stage-narrowed post-merge hook can ever apply`
    };
  }

  switch (hook.kind) {
    case "postMerge":
      // `postMerge` belongs to NO wave — its run's `waveIndex` is NULL (`HookRunIdentity`), and the
      // same run is therefore the state of every target of the change. `grain: "per_change"` is how
      // the UI is told not to call it this target's run.
      return runState(hookId, findRun(runs, hookId, null));
    case "postDeploy":
      // The run gating a wave's EXIT carries that wave's index (`gatedWaveIndex` in the gate), so a
      // target in wave N reads the run at waveIndex N — shared by every target of the wave.
      return runState(hookId, findRun(runs, hookId, wave.waveIndex));
    case "continuous":
      return await continuousState(tx, orgId, hook, subject, now);
    case "bakeAlarms":
      return await bakeState(tx, orgId, hook, subject, target, now);
  }
}

/** `postMerge` is matched against `stage: null` by the gate, so the generic stage rule would
 *  mis-describe it; it gets its own, louder branch above. */
function kindIsStageNarrowable(kind: PipelineHookKind): boolean {
  return kind === "postDeploy" || kind === "bakeAlarms";
}

/** The run for one identity tuple, out of the single by-change read. `waveIndex: null` is matched
 *  as NULL, the same reading `findHookRun`'s `IS NULL` gives the constraint's `NULLS NOT DISTINCT`
 *  — a `=== null` comparison here is the in-memory equivalent and must not become `== undefined`,
 *  which would also match a wave-scoped run. */
function findRun(
  runs: PipelineHookRunRow[],
  hookId: string,
  waveIndex: number | null
): PipelineHookRunRow | undefined {
  return runs.find((r) => r.hookId === hookId && r.waveIndex === waveIndex);
}

function runState(hookId: string, run: PipelineHookRunRow | undefined): PipelineHookState {
  // BOUND AND NOT REACHED. Not the same as "no hook declared" (an empty slot) — this check exists
  // and is waiting, the other will never happen.
  if (run === undefined) return { state: "not_run", hookId };

  // `concludedAt` is the poll that SAW the terminal status. Null for a run that reached terminal
  // without one (the trigger itself returned a terminal phase) — never backfilled from `updatedAt`,
  // which moves on attempt bumps the run's own conclusion did not cause.
  const concludedAt = run.lastObservedAt?.toISOString() ?? null;
  switch (run.status) {
    case "succeeded":
      return { state: "passed", hookId, concludedAt, externalUrl: run.externalUrl };
    case "failed":
    case "aborted":
      // ABORTED IS A FAILED WITH ITS OWN WORD. Same colour (the check did not pass), different
      // recorded fact, and `runStatus` carries it verbatim so the UI never has to say "failed"
      // about a run a human cancelled.
      return {
        state: "failed",
        hookId,
        concludedAt,
        runStatus: run.status,
        externalUrl: run.externalUrl
      };
    default:
      // `pending` (dispatched, not started) and `running` (started) are both in flight. They share
      // a state because the operator action is the same — wait — and keep their distinction in
      // `runStatus`, which is a plain string precisely so the pair can grow.
      return {
        state: "running",
        hookId,
        startedAt: run.startedAt.toISOString(),
        runStatus: run.status,
        externalUrl: run.externalUrl
      };
  }
}

async function continuousState(
  tx: TenantTx,
  orgId: string,
  hook: PipelineHookRow,
  subject: PipelineHookSubject,
  now: Date
): Promise<PipelineHookState> {
  const maxAgeSeconds = hook.maxAgeSeconds;
  if (maxAgeSeconds === null) {
    // REQUIRED on this kind (`ManifestContinuousHookSchema`), nullable in the table only because
    // the four kinds share it. `continuous-hold.ts` skips such a row rather than defaulting to a
    // window nobody declared; the rail says so instead of rendering a verdict it cannot have.
    return {
      state: "not_applicable",
      hookId: hook.hookId,
      reason:
        "this continuous hook row carries no maxAgeSeconds, so it declares no freshness rule and nothing can satisfy or fail it"
    };
  }

  // NO BINDING FILTER — that is the contract, matching `continuous-hold.ts` exactly: a continuous
  // probe reports on the target as it currently stands, not on one commit or digest.
  const row = await latestTestRunEvidence(tx, orgId, {
    componentObjectId: subject.componentObjectId,
    targetObjectId: subject.targetObjectId,
    hookId: hook.hookId
  });
  const payload =
    row === null ? null : (row.payload as { outcome: "passed" | "failed"; completedAt: string });
  const verdict = evaluateContinuousHold({ maxAgeSeconds }, payload, now);

  if (!verdict.held) {
    // Passed AND inside the window — the only combination `evaluateContinuousHold` releases on.
    return {
      state: "passed",
      hookId: hook.hookId,
      concludedAt: verdict.lastReportedAt,
      externalUrl: null
    };
  }
  switch (verdict.reason) {
    case "failed":
      return {
        state: "failed",
        hookId: hook.hookId,
        concludedAt: verdict.lastReportedAt,
        // No run row behind evidence — this arrived through `POST /pipelines/evidence` or a peer's
        // journal, neither of which has one. `null`, never an invented word.
        runStatus: null,
        externalUrl: null
      };
    case "stale":
      // REPORTED, THEN WENT QUIET. `staleAfter` and `lastReportedAt` are both non-null on this
      // branch by construction (`evaluateContinuousHold` sets them from the evidence it just read).
      return {
        state: "stale",
        hookId: hook.hookId,
        maxAgeSeconds,
        newestEvidenceAt: verdict.lastReportedAt!,
        staleAfter: verdict.staleAfter!
      };
    default:
      // NEVER REPORTED AT ALL. A different place to look than `stale` — the prober was never wired
      // up, rather than wired up and now silent.
      return { state: "no_evidence", hookId: hook.hookId, maxAgeSeconds };
  }
}

async function bakeState(
  tx: TenantTx,
  orgId: string,
  hook: PipelineHookRow,
  subject: PipelineHookSubject,
  target: TargetRow,
  now: Date
): Promise<PipelineHookState> {
  const quietWindowSeconds = hook.quietWindowSeconds;
  if (quietWindowSeconds === null) {
    return {
      state: "not_applicable",
      hookId: hook.hookId,
      reason:
        "this bakeAlarms hook row carries no quietWindowSeconds, so it declares no window and nothing can satisfy or fail it"
    };
  }

  const deployedAtIso = waveTargetDeployedAt(target);
  if (deployedAtIso === null) {
    // DECLARED, AND THE WINDOW HAS NOT OPENED. The mockup's dashed "bake 10 m — not started". The
    // gate drops this case (`bakeEntry` returns null for a target with no deploy instant), which is
    // right for a gate and is why this is the only path by which the fact reaches an operator.
    return { state: "bake_not_started", hookId: hook.hookId, quietWindowSeconds };
  }

  const deployedAt = new Date(deployedAtIso);
  const windowEnd = new Date(deployedAt.getTime() + quietWindowSeconds * 1000);
  const windowEndsAt = windowEnd.toISOString();
  const reports = await alarmReportsInWindow(tx, orgId, {
    componentObjectId: subject.componentObjectId,
    targetObjectId: subject.targetObjectId,
    hookId: hook.hookId,
    windowStart: deployedAt,
    windowEnd
  });
  const verdict = evaluateBakeGate({ quietWindowSeconds }, reports, deployedAt, now);

  if (verdict.reason === "alarm_firing") {
    // FAIL-SAFE ON FIRING, reported even while the window is still open: an alarm that already
    // fired is not pending news, and the gate has already stopped widening on it.
    const since = verdict.firingAlarms
      .map((a) => a.firedAt)
      .sort()
      .at(0)!;
    return { state: "alarm_firing", hookId: hook.hookId, windowEndsAt, since };
  }
  if (verdict.reason === "quiet") {
    return {
      state: "quiet",
      hookId: hook.hookId,
      quietWindowSeconds,
      windowEndsAt,
      coveredBy: verdict.coveredBy
    };
  }
  // `window_not_covered` / `no_source` WHILE THE WINDOW IS STILL OPEN is not a finding — it is the
  // ordinary state of a bake in progress, and evidence for the remainder of the window has not had
  // a chance to arrive. Only once the window has elapsed does the gate's reason become a statement
  // about coverage, so only then is it reported as one.
  if (windowEnd.getTime() > now.getTime()) {
    return { state: "baking", hookId: hook.hookId, quietWindowSeconds, windowEndsAt };
  }
  return {
    state: verdict.reason === "no_source" ? "no_source" : "window_not_covered",
    hookId: hook.hookId,
    quietWindowSeconds,
    windowEndsAt
  };
}
