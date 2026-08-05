import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { listPlacementsForComponents } from "../graph/placements-repo.js";
import {
  findLatestWaveTargetForObject,
  type WaveTargetObservedState
} from "./wave-targets-repo.js";
import type { ResolvedStageDependency } from "./changes-repo.js";

/**
 * ADR-0028 increment 3 — THE HOLD.
 *
 * The guarantee, stated so it can be kept: *A's deploy at stage S is not TRIGGERED until, for every
 * declared dependency B of A that applies at S, B's deploy at S is satisfied.*
 *
 * This module is the PREDICATE only; `reconcile.ts`'s per-target loop is the seam that acts on it.
 * The split is deliberate — the predicate is a pure-ish read that a test can drive directly, and the
 * seam is three lines whose two invariants (`allTerminal = false` before the `continue`, and the
 * skip happening before the advisory trigger-claim lock) are copied verbatim from the backoff gate
 * beside it.
 *
 * WHAT THIS IS NOT: it is not a rollout-step hold. `ExecutorPlugin` is exactly `observe`/`trigger`/
 * `status`/`abort`/`describeCapabilities`; there is no advance/pause/resume verb to withhold once a
 * Rollout is running, and ADR-0008 forbids adding one. SCP declines to make a call it was always
 * free not to make yet — the same authority ADR-0006's binding gate and freezes already exercise.
 * The finest grain enforceable here is therefore "is A triggered at this place at all".
 */

/**
 * FRESHNESS BOUND for the optional `minWeight` qualifier — how old the dependency's last observed
 * rollout snapshot may be before it stops counting as "currently observed at >= N".
 *
 * A bound is REQUIRED, not defensive: `updateWaveTargetObserved` overwrites `observed_state` in
 * place (there is no time series — ADR-0008 decision 1 deferred one), and reconcile stops polling a
 * target the moment it terminalizes (`if (target.status === "succeeded") continue;`). A snapshot's
 * age is therefore UNBOUNDED. The specific way that bites: a paused Argo Rollout can aggregate to
 * Application health `Suspended`, which the argocd plugin maps to `succeeded` — so a dependency
 * parked at 10% reads as done and its stored weight stays 10% forever, even after a human promotes
 * it to 100%. Trusting that number a week later would be asserting a fact about the world from a
 * reading nobody has taken since.
 *
 * TEN MINUTES, chosen from the two pressures that actually bound it:
 *
 *  * LOWER BOUND — it must never call a normally-polled in-flight target stale. The tick is 1 s and
 *    an `observing` target is polled on every tick its change is served, but `listChangeRowsInStates`
 *    serves oldest-first capped at `BATCH_LIMIT` (25) per state per tick, so a busy instance can
 *    legitimately go many ticks between two polls of the same change. Ten minutes is ~600 ticks of
 *    slack — far past any scheduling delay that is not itself an outage.
 *  * UPPER BOUND — it must reject a frozen snapshot in human time. A weight left over from a
 *    terminalized (or `Suspended`) target goes unreadable within one coffee break rather than being
 *    believed for days.
 *
 * Stale does NOT mean "satisfied" and does not mean "hold" either: it makes the WEIGHT unreadable,
 * which degrades that dependency to the universal `status = 'succeeded'` test (ADR-0028 decision 4).
 */
export const OBSERVED_WEIGHT_FRESHNESS_MS = 10 * 60_000;

/**
 * Which of the branches ADR-0028 decision 4 requires to be DISTINGUISHABLE produced this verdict.
 * Three of them satisfy, three hold, and one records that the coupling had nothing to scope by.
 */
export type StageDependencyBranch =
  /** The dependency is not placed at this deployment-target. SATISFIED — a declared fact per
   *  ADR-0026 D8 (`plan-service.ts` births such a wave `skipped`), not an absence of information.
   *  Failing closed here would hold the release forever for a CORRECT configuration. */
  | "not_placed"
  /** The dependency's most recent wave target at this place reports `succeeded`. SATISFIED — the
   *  universal test, readable for every executor because every executor writes that column. */
  | "succeeded"
  /** `minWeight` was declared and the dependency's observed canary weight at this place is >= it,
   *  freshly enough to be believed. SATISFIED — this is the qualifier that lets a release proceed at
   *  a partial rollout instead of waiting for the whole stage to finish. */
  | "min_weight"
  /** The dependency is placed here and has NEVER had a wave target at this place. HOLD. */
  | "never_deployed"
  /** The dependency is placed here and its most recent wave target has not succeeded (and either no
   *  `minWeight` was declared, or the weight was readable and below it). HOLD. */
  | "behind"
  /** `minWeight` was declared but the weight could not be read — so the dependency fell back to the
   *  universal `succeeded` test, which it also failed. HOLD, with `weightUnreadable` naming the
   *  cause. An unreadable weight NEVER means "satisfied". */
  | "weight_unreadable"
  /** A stored entry that does not parse as `{dependsOn, minWeight?, atTargets?}`. HOLD — dropping it
   *  fails OPEN, deploying with no hold at all, ahead of the very component its author named. */
  | "undeclarable"
  /** This wave target names a COMPONENT rather than a placement (legacy-shaped topology, or no
   *  topology at all), so there is no place for a stage-scoped hold to be scoped by. Treated as
   *  satisfied because legacy mode keeps its OWN guarantee: `plan-compiler.ts` still refuses to put
   *  two components joined by a `depends_on` edge in one legacy wave. Recorded as its own branch
   *  rather than silently skipped so the fail-open is visible in a Decision and in a test. */
  | "unscopeable"
  /** The declaring component named ITSELF. Satisfied, and dropped rather than refused, matching
   *  `materialiseStageDependencyEdges`'s handling of the same declaration — a self-hold would wait
   *  on this very wave target and could never clear. */
  | "self";

/** Why a declared `minWeight` could not be read. Never a reason to satisfy — only to fall back. */
export type WeightUnreadableCause =
  /** The dependency's wave target carries no `observed_state.rollout.weight` at all: a non-ArgoCD
   *  executor, a blue/green Rollout (which populates no `status.canary` whatsoever), or an extra API
   *  call that failed and returned `undefined` with no marker. This is the DEFAULT case, not the
   *  exception. */
  | "no_weight"
  /** A weight is stored but the target has never been observed, so nothing dates the reading.
   *
   *  NOT REACHABLE THROUGH TODAY'S WRITERS, and named rather than dropped: `observed_state` is only
   *  ever written by `updateWaveTargetObserved`, which sets `last_observed_at` in the same UPDATE,
   *  so the two are written together or not at all. This is the backstop for a row that arrived
   *  another way — a federation replay, a hand-repaired row, or a future writer that separates them
   *  — and it exists so that "a weight with no date on it" degrades rather than being believed. The
   *  ordinary "no poll has landed yet" case reports `no_weight`, because the whole jsonb is null. */
  | "not_observed"
  /** The reading is older than {@link OBSERVED_WEIGHT_FRESHNESS_MS}. */
  | "stale";

/** One dependency's verdict at one place. Every field is DISCRETE and slow-moving on purpose: this
 *  is what lands in a Decision's `inputContext`, and a field that changes every tick would re-open
 *  the 1.44 GB/day write amplification of ADR-0024. Note in particular what is ABSENT — the observed
 *  weight itself. A dependency walking 10 -> 20 -> 30 below a `minWeight` of 50 would otherwise
 *  write a new Decision per weight change, which is the same bug wearing a different hat. The
 *  qualitative branch is what explains the hold; the number is live telemetry and belongs on the
 *  observe surface, not in the audit record. */
export interface StageDependencyVerdict {
  /** The component object id depended on. For an `undeclarable` entry this is the raw stored entry
   *  rendered as JSON, because there was no parseable id to name. */
  dependsOn: string;
  branch: StageDependencyBranch;
  satisfied: boolean;
  /** The status of the dependency's most recent wave target at this place, when it had one. */
  dependencyStatus?: string;
  /** Echoed only when the declaration carried the qualifier. */
  minWeight?: number;
  /** Set whenever `minWeight` was declared and the weight could not be read — INCLUDING on a verdict
   *  that went on to be satisfied by the universal `succeeded` test. That is the "record a warning"
   *  half of ADR-0028 decision 4: the release proceeded, but not for the reason its author asked
   *  for, and the record has to say so. */
  weightUnreadable?: WeightUnreadableCause;
}

export interface StageDependencyEvaluation {
  /** True when at least one verdict is unsatisfied — the target's trigger is withheld this tick. */
  held: boolean;
  /** The (component, place) pair this wave target resolves to, or `null` when it resolved to no
   *  placement at all (legacy-shaped target — see the `unscopeable` branch). */
  stage: { componentObjectId: string; deploymentTargetObjectId: string } | null;
  /** One verdict per declared dependency that APPLIES here, in declaration order, followed by one
   *  per malformed stored entry. Dependencies excluded by `atTargets` produce no verdict at all —
   *  they were never in scope, and listing them would make the Decision's inputs churn with
   *  irrelevance. Empty when nothing was declared. */
  verdicts: StageDependencyVerdict[];
}

const NOT_DECLARED: StageDependencyEvaluation = { held: false, stage: null, verdicts: [] };

/**
 * Evaluates every declared stage dependency of a change against ONE of its wave targets.
 *
 * INERT WHEN NOTHING IS DECLARED, and structurally so: the caller's parse happens in memory and this
 * returns before issuing a single query. The overwhelming majority of changes declare nothing, and
 * they must not pay a graph read per pending target per tick for a feature they do not use.
 *
 * Takes a `TenantTx` and reads only — the caller decides what to persist, and does it in its own
 * transaction, so a hold evaluation can never half-commit anything.
 */
export async function evaluateStageDependencies(
  tx: TenantTx,
  input: {
    orgId: string;
    /** The wave target's `target_object_id` — a PLACEMENT in stage mode, a component in legacy. */
    waveTargetObjectId: string;
    /** Already parsed off the change's properties by `stageDependenciesOf`. */
    stageDependencies: readonly ResolvedStageDependency[];
    /** Stored entries that did not parse. Each becomes one `undeclarable` (holding) verdict. */
    malformed: readonly unknown[];
    /** Injected so a test can pin the freshness boundary without sleeping. Defaults to now. */
    now?: number;
  }
): Promise<StageDependencyEvaluation> {
  const { orgId, waveTargetObjectId, stageDependencies, malformed } = input;
  if (stageDependencies.length === 0 && malformed.length === 0) return NOT_DECLARED;

  // FAIL-CLOSED ON MALFORMED, BEFORE ANYTHING ELSE AND REGARDLESS OF SHAPE. A stored entry that does
  // not parse names a coupling somebody asked for and this version cannot honour; the only reading
  // of it that is not fail-open is "unsatisfiable". It needs no place to be scoped by, so it holds
  // even on a legacy-shaped target — which is also why it is computed before the placement lookup.
  const verdicts: StageDependencyVerdict[] = [];
  const malformedVerdicts: StageDependencyVerdict[] = malformed.map((entry) => ({
    dependsOn: safeJson(entry),
    branch: "undeclarable" as const,
    satisfied: false
  }));

  const stage = await resolvePlacementPair(tx, orgId, waveTargetObjectId);

  if (!stage) {
    // LEGACY-SHAPED WAVE TARGET — it names a component, and a component is not a place. The
    // guarantee is not lost here, it was never this mechanism's to keep: `plan-compiler.ts`'s legacy
    // path STILL refuses to schedule two components joined by a `depends_on` edge into one wave
    // (only the STAGE path's copy of that check was replaced by this hold, ADR-0028 decision 6).
    // Recorded as a verdict rather than skipped so that a change which declared a coupling and got
    // none is visible in the Decision when anything else about the same target holds.
    for (const dep of stageDependencies) {
      verdicts.push({ dependsOn: dep.dependsOn, branch: "unscopeable", satisfied: true });
    }
    return finish(stage, verdicts, malformedVerdicts);
  }

  // `atTargets` is scoped by DEPLOYMENT-TARGET id, never by a stage-name glob: a stage name is
  // derived on a UI read path and is `null` outright for a replicated deployment-target, so a name
  // glob would silently match nothing at exactly the federation boundary where the coupling matters.
  const applicable = stageDependencies.filter(
    (dep) => dep.atTargets === undefined || dep.atTargets.includes(stage.deploymentTargetObjectId)
  );

  const scoped: ResolvedStageDependency[] = [];
  for (const dep of applicable) {
    if (dep.dependsOn === stage.componentObjectId) {
      // A self-declaration would resolve to THIS very placement, find THIS very wave target sitting
      // in `pending`, and hold forever. Dropped for the same reason `materialiseStageDependencyEdges`
      // drops the self-edge: it means nothing either way, and refusing it late is worse than
      // ignoring it.
      verdicts.push({ dependsOn: dep.dependsOn, branch: "self", satisfied: true });
      continue;
    }
    scoped.push(dep);
  }

  if (scoped.length === 0) return finish(stage, verdicts, malformedVerdicts);

  // Where each dependency is placed. One query for all of them, filtered down to THIS place —
  // reusing the same properties-are-the-source-of-truth read (ADR-0026 D17) that `plan-service.ts`
  // and `binding-resolution.ts` use, so a placement can never mean one thing here and another there.
  const placements = await listPlacementsForComponents(
    tx,
    orgId,
    scoped.map((dep) => dep.dependsOn)
  );
  const placementHere = new Map<string, string>();
  for (const p of placements) {
    if (p.deploymentTargetObjectId === stage.deploymentTargetObjectId) {
      placementHere.set(p.componentObjectId, p.placementId);
    }
  }

  const now = input.now ?? Date.now();
  for (const dep of scoped) {
    const placementId = placementHere.get(dep.dependsOn);
    if (placementId === undefined) {
      verdicts.push({ dependsOn: dep.dependsOn, branch: "not_placed", satisfied: true });
      continue;
    }
    const latest = await findLatestWaveTargetForObject(tx, orgId, placementId);
    verdicts.push(stageDependencyVerdict(dep, latest, now));
  }

  return finish(stage, verdicts, malformedVerdicts);
}

/**
 * The universal test, then the optional qualifier, then the reason it held — the whole branch matrix
 * of ADR-0028 decision 4 for ONE dependency against ONE stored row.
 *
 * EXPORTED FOR DIRECT UNIT TESTING, on the same reasoning `decisions-repo.ts` exports
 * `restatesDecision`: this is the entire decision content of the feature, and its most plausible
 * failure mode — an unreadable weight quietly counting as satisfied, or as a weight of zero — is
 * invisible from the outside because both produce a plausible-looking verdict. Everything around it
 * (which rows are read, what is persisted) is pinned by the integration suite instead.
 */
export function stageDependencyVerdict(
  dep: ResolvedStageDependency,
  latest:
    | {
        status: string;
        observedState: unknown;
        lastObservedAt: Date | null;
      }
    | undefined,
  now: number
): StageDependencyVerdict {
  const qualifier = dep.minWeight === undefined ? {} : { minWeight: dep.minWeight };

  if (latest === undefined) {
    // Placed here, never deployed here. Distinct from `behind` because the remedies differ: this one
    // usually means the dependency's own pipeline has not run yet, not that it is mid-flight.
    return { dependsOn: dep.dependsOn, branch: "never_deployed", satisfied: false, ...qualifier };
  }

  // THE UNIVERSAL TEST FIRST. `status` is a column every executor produces, so this branch is always
  // readable — which is exactly why the `minWeight` qualifier is allowed to be best-effort.
  if (latest.status === "succeeded") {
    const unreadable =
      dep.minWeight === undefined ? undefined : weightUnreadableCause(latest, now).cause;
    return {
      dependsOn: dep.dependsOn,
      branch: "succeeded",
      satisfied: true,
      dependencyStatus: latest.status,
      ...qualifier,
      // Satisfied, but NOT for the reason the author asked for. Recorded so an operator can see that
      // the weight qualifier they wrote has never once been consulted (an RBAC gap on the extra Argo
      // call, or a blue/green Rollout that structurally has no weight) instead of assuming it works.
      ...(unreadable ? { weightUnreadable: unreadable } : {})
    };
  }

  if (dep.minWeight !== undefined) {
    const { cause, weight } = weightUnreadableCause(latest, now);
    if (cause !== undefined) {
      // Degraded to the universal test, which just failed above. NEVER to "satisfied".
      return {
        dependsOn: dep.dependsOn,
        branch: "weight_unreadable",
        satisfied: false,
        dependencyStatus: latest.status,
        ...qualifier,
        weightUnreadable: cause
      };
    }
    if (weight >= dep.minWeight) {
      // THE OWNER'S HEADLINE CASE: the dependency is still rolling out here and the release proceeds
      // anyway, because it has reached the partial weight its dependant declared as enough.
      return {
        dependsOn: dep.dependsOn,
        branch: "min_weight",
        satisfied: true,
        dependencyStatus: latest.status,
        ...qualifier
      };
    }
  }

  return {
    dependsOn: dep.dependsOn,
    branch: "behind",
    satisfied: false,
    dependencyStatus: latest.status,
    ...qualifier
  };
}

/** Reads `observed_state.rollout.weight` and dates it. Returns the cause when it cannot be believed,
 *  or the number when it can. Callers must treat `cause !== undefined` as UNREADABLE, never as a
 *  weight of zero — the two are different claims and only one of them is true. */
function weightUnreadableCause(
  latest: { observedState: unknown; lastObservedAt: Date | null },
  now: number
): { cause: WeightUnreadableCause; weight: number } | { cause: undefined; weight: number } {
  const observed = latest.observedState as WaveTargetObservedState | null | undefined;
  const weight = observed?.rollout?.weight;
  // Only argocd produces rollout data, via a second call whose failure returns `undefined` with no
  // marker, and a blue/green Rollout populates no `status.canary` at all — so "absent" is the
  // ordinary case for most of the estate, not a fault.
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    return { cause: "no_weight", weight: 0 };
  }
  if (latest.lastObservedAt === null) return { cause: "not_observed", weight };
  if (now - latest.lastObservedAt.getTime() > OBSERVED_WEIGHT_FRESHNESS_MS) {
    return { cause: "stale", weight };
  }
  return { cause: undefined, weight };
}

/** The wave target's object row, reduced to the pair a stage-scoped hold needs. `null` for anything
 *  that is not a live placement — a legacy-shaped wave target naming a component, or a placement
 *  whose stored pair is unusable (which `plan-service.ts` skips for the same reason). */
async function resolvePlacementPair(
  tx: TenantTx,
  orgId: string,
  waveTargetObjectId: string
): Promise<{ componentObjectId: string; deploymentTargetObjectId: string } | null> {
  const rows = await tx
    .select({ typeId: objects.typeId, properties: objects.properties })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), eq(objects.id, waveTargetObjectId), isNull(objects.deletedAt))
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.typeId !== "placement") return null;
  const props = row.properties as { componentId?: unknown; deploymentTargetId?: unknown };
  if (typeof props.componentId !== "string" || typeof props.deploymentTargetId !== "string") {
    return null;
  }
  return {
    componentObjectId: props.componentId,
    deploymentTargetObjectId: props.deploymentTargetId
  };
}

function finish(
  stage: { componentObjectId: string; deploymentTargetObjectId: string } | null,
  verdicts: StageDependencyVerdict[],
  malformedVerdicts: StageDependencyVerdict[]
): StageDependencyEvaluation {
  const all = [...verdicts, ...malformedVerdicts];
  return { held: all.some((v) => !v.satisfied), stage, verdicts: all };
}

/** A malformed entry is arbitrary stored JSON, including shapes `JSON.stringify` refuses (a cycle
 *  cannot arrive through `jsonb`, but a `bigint` from a future column type could). Never throws:
 *  this runs inside the reconcile loop, where one corrupt row must not wedge every other target. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * One line per held target, for the Decision's `reasonTree` and the operator-facing log. Built from
 * ids and branch names only — no timestamps, no weights — so the sentence is byte-stable for as long
 * as the situation is, which is what lets `insertDecisionIfChanged` suppress the restatement.
 */
export function describeStageDependencyHold(verdict: StageDependencyVerdict): string {
  switch (verdict.branch) {
    case "never_deployed":
      return `'${verdict.dependsOn}' is placed here but has never deployed here`;
    case "behind":
      return verdict.minWeight === undefined
        ? `'${verdict.dependsOn}' has not succeeded here (its latest deploy is '${verdict.dependencyStatus}')`
        : `'${verdict.dependsOn}' is below the declared minWeight of ${verdict.minWeight} here (its latest deploy is '${verdict.dependencyStatus}')`;
    case "weight_unreadable":
      return `'${verdict.dependsOn}' declared minWeight ${verdict.minWeight} but its observed weight here is unreadable (${verdict.weightUnreadable}), so it fell back to requiring success — and its latest deploy is '${verdict.dependencyStatus}'`;
    case "undeclarable":
      return `a stored stageDependencies entry does not parse and is therefore unsatisfiable: ${verdict.dependsOn}`;
    default:
      return `'${verdict.dependsOn}' is satisfied here (${verdict.branch})`;
  }
}
