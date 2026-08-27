import type { PipelineHookKind } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  artifactDigestOfSourceRef,
  commitShaOfSourceRef
} from "../governance/gate-orchestrator.js";
import { getChangeRow } from "./changes-repo.js";
import {
  alarmReportsInWindow,
  latestTestRunEvidence,
  listHooksForComponents,
  orgDeclaresHookKind,
  resolveHookSubjects,
  type PipelineHookRow,
  type PipelineHookSubject
} from "./pipeline-hooks-repo.js";
import {
  evaluateBakeGate,
  evaluatePostDeployGate,
  type BakeGateVerdict
} from "./pipeline-hook-verdicts.js";

/**
 * THE DECLARED-HOOK CONTRIBUTION TO THE WAVE-BOUNDARY GATE (team-pipeline-iac increment 8, D21).
 *
 * ============================================================================================
 * WHY A WAVE GATE, AND WHY THIS FILE ONLY READS
 * ============================================================================================
 * `packages/schemas/src/pipeline-behaviors.ts`'s module header is the specification, and its
 * mechanism table is not a suggestion: `postDeploy` and `bakeAlarms` are WAVE-BOUNDARY GATES,
 * `continuous` is a PER-TARGET HOLD (`./continuous-hold.ts`), and the choice per hook is a
 * statement about what should happen to the SIBLINGS. A failing integration suite must stop the
 * whole widening; a stale canary probe on one target must not.
 *
 * "Gating promotion OUT of wave N" IS "gating entry INTO wave N+1", so this hangs off
 * `evaluateWaveGate` — which `gate-orchestrator.ts` already documents as re-evaluated EVERY TICK
 * while a wave stays `pending`, with only the transition firing once. That property is what makes
 * `awaiting` safe to block on (below) and it is why nothing here needs a scheduler, a status flip,
 * or a second re-evaluation path.
 *
 * This module is a PREDICATE — the same split `./freeze-hold.ts` and `./stage-dependency-hold.ts`
 * state for themselves. It reads hooks and evidence and returns verdicts; `coordination/gates.ts`
 * is the seam that folds the answer into a verdict, and `reconcile.ts` is the seam that refuses.
 * It calls the mutation-proven verdict functions in `./pipeline-hook-verdicts.ts` and reimplements
 * none of their rules: a second copy of "does this bake window cover" is a second place to regress.
 *
 * ============================================================================================
 * A THIRD CONTRIBUTOR, NOT A REPLACEMENT
 * ============================================================================================
 * `evaluateWaveGate` already has two: the literal `gate_bindings` rows an operator bound to the
 * boundary, and the policy engine's `requireControls`. This is added BESIDE them and is ANDed with
 * them — a wave is admitted when all three allow. Neither existing contributor is weakened, and a
 * component that declares no hooks contributes nothing in either direction.
 *
 * ============================================================================================
 * `continuous` MUST NEVER REACH HERE
 * ============================================================================================
 * A `continuous` verdict at a wave gate would block a whole wave because ONE target's prober went
 * quiet, which is a lie about what is known and the exact failure the per-target hold exists to
 * avoid. `WaveGateKindSchema` already refuses to let a wave document ask for it. This module
 * enforces the same thing twice, on purpose: `WAVE_GATE_HOOK_KINDS` filters the declared set, and
 * `assertWaveGateHookKind` throws if one ever arrives anyway. The throw is loud rather than silent
 * — `advanceExecutingChanges` catches per change and logs, so a bug here fails one change visibly
 * instead of quietly widening a rollout past a hold.
 *
 * ============================================================================================
 * NO CLOCK REACHES THE RECORD
 * ============================================================================================
 * Every field of `PipelineHookGateEntry` is an id, a declared number, or an instant read straight
 * off a stored row. `now` is passed INTO the verdict functions (they take it explicitly and never
 * read it themselves) and never comes back out. That is ADR-0024's persist-on-change contract —
 * `insertDecisionIfChanged` compares the candidate against the standing row, and a clock in the
 * record makes every tick look new, which is the measured 1.44 GB/day incident rebuilt from parts.
 */

/** The three kinds that can gate a wave boundary. `continuous` is deliberately absent — see the
 *  module doc, and `WaveGateKindSchema`, which makes the same exclusion on the wire. */
const WAVE_GATE_HOOK_KINDS = new Set<PipelineHookKind>(["postMerge", "postDeploy", "bakeAlarms"]);

export type WaveGateHookKind = "postMerge" | "postDeploy" | "bakeAlarms";

/** THE ASSERTION the module doc promises. Exported so a unit test can drive it directly rather than
 *  having to manufacture a `continuous` row that the filter above would already have dropped. */
export function assertWaveGateHookKind(kind: PipelineHookKind): asserts kind is WaveGateHookKind {
  if (kind === "continuous") {
    throw new Error(
      "a `continuous` hook reached the wave-boundary gate — it is a PER-TARGET HOLD (coordination/continuous-hold.ts) and blocking a whole wave on one target's probe freshness would be a claim about targets nobody looked at"
    );
  }
}

/** One target of a wave, with the instant its deploy was recorded — the bake window's start.
 *  `deployedAt` is DATA off the wave-target row, never a clock read here; `null` for a target that
 *  has not deployed, which has no window to be quiet in. */
export interface PipelineHookGateWaveTarget {
  targetObjectId: string;
  deployedAt: string | null;
}

export interface PipelineHookGateContext {
  orgId: string;
  /** The change being admitted — the row whose `source_ref` carries the evidence BINDINGS. Read
   *  LAZILY, once, and only after the inertness gate below has established that some hook of the
   *  applicable kind is actually declared: an org that declares nothing must not pay a change read
   *  per pending wave per tick for a binding nobody will use. */
  changeObjectId: string;
  /**
   * The wave whose EXIT this admission is — the previous wave, with the stage it ran at and the
   * targets that actually deployed there. `null` when the wave being admitted is the FIRST wave
   * with targets, which has no previous wave to have exited: that case gates on `postMerge`
   * instead (`ManifestPostMergeHookSchema` — "this hook gates the first thing SCP genuinely
   * controls: the change entering its first wave").
   */
  previousWave: {
    waveIndex: number;
    /** The wave's stage name. `change_waves.name` IS the stage: `plan-compiler.ts` copies the
     *  topology wave's name onto every step it produces, and D6 makes the vocabulary operator
     *  data that SCP never enforces. `null` for a wave the topology left unnamed, which no
     *  stage-narrowed hook can match. */
    stage: string | null;
    targets: PipelineHookGateWaveTarget[];
  } | null;
  /** Targets of the wave being ADMITTED. Read only when `previousWave` is `null`, as the subjects
   *  of the `postMerge` gate. */
  admittedTargets: { targetObjectId: string }[];
  /** Injected for testability, exactly as `freeze-hold.ts` injects it and for the same reason: the
   *  gate path has no clock seam, so a window-boundary test would otherwise need a real sleep.
   *  Production passes nothing. It reaches the verdict functions and NEVER the returned entries. */
  now?: Date | undefined;
}

/** One (hook x target) verdict. Every field is an id, a declared number, or a stored instant — this
 *  array goes VERBATIM into the wave gate's Decision `inputContext`. */
export interface PipelineHookGateEntry {
  kind: WaveGateHookKind;
  hookId: string;
  componentObjectId: string;
  targetObjectId: string;
  /** The stage the hook was NARROWED to, or `null` when it gates every wave.
   *
   *  READ THE DIRECTION CAREFULLY, because the intuitive reading is backwards and D21(a) says so
   *  explicitly: ABSENT `stage` is the DEFAULT and gates EVERY wave; adding a `stage` REMOVES
   *  gates, it does not add one. The strict end is the default on purpose — a team that declares
   *  an integration suite and forgets to say where it applies gets it applied everywhere, which is
   *  the safe direction to be wrong in. */
  stage: string | null;
  /** The wave whose exit this gates. `null` for `postMerge`, which belongs to no wave. */
  gatedWaveIndex: number | null;
  /** `pass`/`fail`/`awaiting` for a test hook; `evaluateBakeGate`'s four reasons for a bake hook.
   *  NEVER collapsed: `no_source` ("a declared bake gate has no evidence source") and
   *  `window_not_covered` ("reports exist and leave a gap") demand different operator actions, and
   *  `awaiting` ("the suite is still running") is not a failure at all. */
  outcome: "pass" | "fail" | "awaiting" | BakeGateVerdict["reason"];
  satisfied: boolean;
  /** Bake only. Which sources affirmatively covered the whole window — so an operator can see that
   *  only `pushed` covered a quiet gate in an air-gapped domain. */
  coveredBy?: BakeGateVerdict["coveredBy"];
  /** Bake only. Every alarm, from any source, that fired inside the required window. */
  firingAlarms?: BakeGateVerdict["firingAlarms"];
  /** Bake only. The required window as DATA — `deployedAt` and `deployedAt + quietWindowSeconds`.
   *  Recorded so a reader can see the boundary the comparison used without the record itself
   *  carrying the clock that made it. */
  window?: { start: string; end: string };
}

export interface PipelineHookGateContribution {
  /** True when every applicable declared hook is satisfied — including vacuously, when none
   *  applies. This ANDs with the other two contributors; it never overrides either. */
  allowed: boolean;
  /** Sorted, so a reordered query result can never make an unchanged situation look new to
   *  `insertDecisionIfChanged`. `restatesDecision` canonicalizes object KEYS only — array element
   *  ORDER is significant, and this array is read straight out of query results whose order is not
   *  guaranteed across ticks. */
  entries: PipelineHookGateEntry[];
}

const ALLOW_NOTHING_DECLARED: PipelineHookGateContribution = { allowed: true, entries: [] };

/**
 * Resolves every declared wave-boundary hook that applies to this admission and returns its verdict.
 *
 * INERT WHEN NOTHING IS DECLARED, structurally: `orgDeclaresHookKind` is one indexed existence read
 * and this returns before resolving a single placement when it comes back false for both kinds. An
 * org that declares no hooks — nearly every org, nearly all the time — pays two reads per pending
 * wave per tick and nothing else, and a wave that is already `running` never calls this at all.
 */
export async function evaluatePipelineHookGate(
  tx: TenantTx,
  ctx: PipelineHookGateContext
): Promise<PipelineHookGateContribution> {
  const now = ctx.now ?? new Date();

  if (ctx.previousWave === null) {
    // WAVE 0 (or the first wave with targets — see `previousWave`'s doc). Nothing has exited yet,
    // so `postDeploy` and `bakeAlarms` have no window and no deploy to be about. `postMerge` is the
    // gate that applies here.
    if (!(await orgDeclaresHookKind(tx, ctx.orgId, "postMerge"))) return ALLOW_NOTHING_DECLARED;
    return await evaluateForTargets(tx, ctx, {
      // `deployedAt: null` — nothing in the wave being admitted has deployed yet, which is exactly
      // why `bakeAlarms` cannot apply here and `postMerge` is the only kind asked for.
      targets: ctx.admittedTargets.map((t) => ({
        targetObjectId: t.targetObjectId,
        deployedAt: null
      })),
      kinds: ["postMerge"],
      stage: null,
      gatedWaveIndex: null,
      now
    });
  }

  const declaresPostDeploy = await orgDeclaresHookKind(tx, ctx.orgId, "postDeploy");
  const declaresBake = await orgDeclaresHookKind(tx, ctx.orgId, "bakeAlarms");
  if (!declaresPostDeploy && !declaresBake) return ALLOW_NOTHING_DECLARED;

  const kinds: WaveGateHookKind[] = [];
  if (declaresPostDeploy) kinds.push("postDeploy");
  if (declaresBake) kinds.push("bakeAlarms");

  return await evaluateForTargets(tx, ctx, {
    targets: ctx.previousWave.targets,
    kinds,
    stage: ctx.previousWave.stage,
    gatedWaveIndex: ctx.previousWave.waveIndex,
    now
  });
}

/**
 * THE EVIDENCE BINDINGS, read once off the change's `source_ref`.
 *
 * `postMerge` binds to the COMMIT (it runs before any artifact exists) and the other kinds bind to
 * the artifact DIGEST — `pipeline_evidence`'s column doc states exactly that split. Both come from
 * the SAME two readers `gate-orchestrator.ts` uses to bind a control's context, imported rather
 * than re-derived: a gate asking about different bytes than the control beside it is a defect that
 * would never show up as an error, only as a wave admitted on the wrong evidence.
 *
 * `undefined` means DO NOT FILTER on that axis, which is `latestTestRunEvidence`'s documented
 * asymmetry and the honest reading for a change that tracks no digest at all: the latest word about
 * this target, since there are no other bytes to confuse it with. Best-effort, never a throw — a
 * missing change row must not turn a gate into an error.
 */
interface HookEvidenceBindings {
  artifactDigest: string | undefined;
  commitSha: string | undefined;
}

async function resolveBindings(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<HookEvidenceBindings> {
  const row = await getChangeRow(tx, orgId, changeObjectId).catch(() => null);
  const sourceRef = row?.sourceRef ?? {};
  return {
    artifactDigest: artifactDigestOfSourceRef(sourceRef),
    commitSha: commitShaOfSourceRef(sourceRef)
  };
}

async function evaluateForTargets(
  tx: TenantTx,
  ctx: PipelineHookGateContext,
  input: {
    targets: PipelineHookGateWaveTarget[];
    kinds: WaveGateHookKind[];
    /** The stage the gated wave ran at — what a stage-narrowed hook is matched against. `null` for
     *  the `postMerge` path, which has no wave and therefore no stage to narrow by. */
    stage: string | null;
    gatedWaveIndex: number | null;
    now: Date;
  }
): Promise<PipelineHookGateContribution> {
  if (input.targets.length === 0) return ALLOW_NOTHING_DECLARED;

  const subjects = await resolveHookSubjects(
    tx,
    ctx.orgId,
    input.targets.map((t) => t.targetObjectId)
  );
  const componentObjectIds = [...new Set([...subjects.values()].map((s) => s.componentObjectId))];
  const hooks = (await listHooksForComponents(tx, ctx.orgId, componentObjectIds)).filter((h) =>
    WAVE_GATE_HOOK_KINDS.has(h.kind)
  );
  if (hooks.length === 0) return ALLOW_NOTHING_DECLARED;

  // AFTER the hook lookup, deliberately — see `PipelineHookGateContext.changeObjectId`.
  const bindings = await resolveBindings(tx, ctx.orgId, ctx.changeObjectId);

  const byComponent = new Map<string, PipelineHookRow[]>();
  for (const hook of hooks) {
    const list = byComponent.get(hook.componentObjectId) ?? [];
    list.push(hook);
    byComponent.set(hook.componentObjectId, list);
  }

  const entries: PipelineHookGateEntry[] = [];
  for (const target of input.targets) {
    const subject = subjects.get(target.targetObjectId);
    // Absent means deleted, or a placement missing half its identity (`resolveHookSubjects`). A
    // hook cannot be about an object that is not there; the target contributes nothing rather than
    // holding the wave open forever on evidence nobody can ever produce.
    if (!subject) continue;

    for (const hook of byComponent.get(subject.componentObjectId) ?? []) {
      assertWaveGateHookKind(hook.kind);
      if (!input.kinds.includes(hook.kind)) continue;
      // THE STAGE RULE, in one line, both directions. Absent `stage` gates every wave; a `stage`
      // narrows to waves at that stage. See `PipelineHookGateEntry.stage` for why the intuitive
      // reading is backwards.
      if (hook.stage !== null && hook.stage !== input.stage) continue;

      const entry =
        hook.kind === "bakeAlarms"
          ? await bakeEntry(tx, ctx, subject, hook, target, input.gatedWaveIndex, input.now)
          : await testRunEntry(tx, ctx, bindings, subject, hook, input.gatedWaveIndex, input.now);
      if (entry) entries.push(entry);
    }
  }

  entries.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.hookId.localeCompare(b.hookId) ||
      a.targetObjectId.localeCompare(b.targetObjectId)
  );
  return { allowed: entries.every((e) => e.satisfied), entries };
}

/**
 * `postMerge` and `postDeploy` — the same question ("did the declared suite run, and did it pass"),
 * so the same verdict function answers both.
 *
 * `evaluatePostDeployGate` IS REUSED rather than copied for `postMerge`: the two hooks differ in
 * WHEN they are consulted and WHAT the evidence is bound to (commit vs digest), not in how a
 * concluded run is read. A second implementation would be a second place for `awaiting` to get
 * mapped to `fail`, which that function's doc calls out as the one thing that must never happen.
 */
async function testRunEntry(
  tx: TenantTx,
  ctx: PipelineHookGateContext,
  bindings: HookEvidenceBindings,
  subject: PipelineHookSubject,
  hook: PipelineHookRow,
  gatedWaveIndex: number | null,
  now: Date
): Promise<PipelineHookGateEntry> {
  const binding =
    hook.kind === "postMerge"
      ? bindings.commitSha === undefined
        ? {}
        : { commitSha: bindings.commitSha }
      : bindings.artifactDigest === undefined
        ? {}
        : { artifactDigest: bindings.artifactDigest };

  const row = await latestTestRunEvidence(tx, ctx.orgId, {
    componentObjectId: subject.componentObjectId,
    targetObjectId: subject.targetObjectId,
    hookId: hook.hookId,
    ...binding
  });
  const payload = row === null ? null : (row.payload as { outcome: "passed" | "failed" });
  const verdict = evaluatePostDeployGate(
    { hookId: hook.hookId },
    payload === null ? null : { outcome: payload.outcome },
    now
  );

  return {
    kind: hook.kind as WaveGateHookKind,
    hookId: hook.hookId,
    componentObjectId: subject.componentObjectId,
    targetObjectId: subject.targetObjectId,
    stage: hook.stage,
    gatedWaveIndex,
    outcome: verdict.outcome,
    // `awaiting` BLOCKS AND IS NOT A FAILURE. The wave stays `pending` and is re-decided next tick,
    // which is the documented non-deadlocking behaviour — an in-flight suite is not a failed suite,
    // and mapping it to `fail` would fail a change on a test that has not finished running.
    satisfied: verdict.outcome === "pass"
  };
}

async function bakeEntry(
  tx: TenantTx,
  ctx: PipelineHookGateContext,
  subject: PipelineHookSubject,
  hook: PipelineHookRow,
  target: PipelineHookGateWaveTarget,
  gatedWaveIndex: number | null,
  now: Date
): Promise<PipelineHookGateEntry | null> {
  // A `bakeAlarms` row without a quiet window is not a gate — nothing can satisfy or fail it. The
  // column is nullable because the four kinds share one table (see `pipelineHooks.kind`), and Zod
  // is what closes the per-kind shape at the write door; here it is simply skipped rather than
  // defaulted to a number nobody declared.
  if (hook.quietWindowSeconds === null) return null;

  // No deploy instant means no window. Unreachable on the `postMerge` path (which never asks for
  // this kind) and, on the previous-wave path, only reachable for a target that never deployed —
  // for which "the window was quiet" is not a question that has an answer. Contributes nothing
  // rather than holding the wave open on evidence that can never arrive.
  if (target.deployedAt === null) return null;

  // PER TARGET, WITH THAT TARGET'S OWN DEPLOY AS THE WINDOW START — the contract's exact words
  // ("each target's window starts when THAT target deployed"). The GATE is still the whole wave's:
  // an alarm anywhere in wave N stops the widening to wave N+1, which is the entire point of
  // progressive delivery. A per-target hold would keep widening around the one target that noticed.
  const deployedAt = new Date(target.deployedAt);
  const windowEnd = new Date(deployedAt.getTime() + hook.quietWindowSeconds * 1000);

  const reports = await alarmReportsInWindow(tx, ctx.orgId, {
    componentObjectId: subject.componentObjectId,
    targetObjectId: subject.targetObjectId,
    hookId: hook.hookId,
    windowStart: deployedAt,
    windowEnd
  });
  const verdict = evaluateBakeGate(
    { quietWindowSeconds: hook.quietWindowSeconds },
    reports,
    deployedAt,
    now
  );

  return {
    kind: "bakeAlarms",
    hookId: hook.hookId,
    componentObjectId: subject.componentObjectId,
    targetObjectId: subject.targetObjectId,
    stage: hook.stage,
    gatedWaveIndex,
    outcome: verdict.reason,
    satisfied: verdict.satisfied,
    coveredBy: verdict.coveredBy,
    firingAlarms: verdict.firingAlarms,
    window: { start: deployedAt.toISOString(), end: windowEnd.toISOString() }
  };
}

/** One line an operator can read — the reason-tree half. Ids and reasons only, never a name that
 *  can drift, so a Decision's `reasonTree` stays byte-stable across a rename. */
export function describePipelineHookGate(contribution: PipelineHookGateContribution): string {
  const unsatisfied = contribution.entries.filter((e) => !e.satisfied);
  if (unsatisfied.length === 0) {
    return `${contribution.entries.length} declared pipeline hook(s) satisfied`;
  }
  return unsatisfied
    .map(
      (e) =>
        `${e.kind} '${e.hookId}' on component ${e.componentObjectId} at target ${e.targetObjectId} is '${e.outcome}'`
    )
    .join("; ");
}
