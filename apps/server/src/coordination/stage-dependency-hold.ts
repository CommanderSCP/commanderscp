import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { listPlacementsForComponents } from "../graph/placements-repo.js";
import {
  findLatestWaveTargetForObject,
  type WaveTargetObservedState
} from "./wave-targets-repo.js";
import type { ResolvedStageDependency } from "./changes-repo.js";
import type { DependsOnEdge } from "./plan-compiler.js";

/**
 * ADR-0028 increment 3 — THE HOLD.
 *
 * The guarantee, stated so it can be kept: *A's deploy at stage S is not TRIGGERED until, for every
 * declared dependency B of A that applies at S, B's deploy at S is satisfied.*
 *
 * TWO SOURCES FEED ONE DEPENDENCY SET, and the second is not an extension — it is the domain of the
 * check ADR-0028 decision 6 removed from `plan-compiler.ts`, landing where the duty went:
 *
 *   1. the change's own DECLARED `stageDependencies`, carrying the `minWeight`/`atTargets`
 *      qualifiers; and
 *   2. plain `depends_on` EDGES with BOTH endpoints among this change's own targets — no
 *      qualifiers, the universal `succeeded` test only.
 *
 * (2) exists because the removed compiler check keyed on the EDGE, not on a declaration: it refused
 * (400) any plan putting two edge-joined targets in one wave, whatever wrote the edge — a seed, an
 * IaC manifest, an operator, or an EARLIER change's declaration. Keying the hold only on this
 * change's own declarations would have left that set ordering nothing at all, which is a silent
 * regression rather than a design choice. The scope is deliberately not one inch wider: an edge with
 * an endpoint OUTSIDE this change's target set ordered nothing before and orders nothing now, so a
 * bulk edge import cannot turn the org's whole graph into a release gate (`graph.dependentIds` is a
 * live CEL policy input — ADR-0028 decision 6 cautions about exactly that blast radius).
 *
 * This module is the PREDICATE only; `reconcile.ts`'s per-target loop is the seam that acts on it.
 * The split is deliberate — the predicate is a pure-ish read that a test can drive directly, and the
 * seam is three lines whose two invariants (the target counted as in flight before the `continue`,
 * and the skip happening before the advisory trigger-claim lock) are copied verbatim from the
 * backoff gate beside it. With ONE thing the backoff gate never needed: a held target must not keep
 * an already-failed wave alive, so the seam's terminalization asks whether every target still in
 * flight is a held one rather than whether any is (reconcile.ts, end of the per-target loop).
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
 * place (there is no time series — ADR-0008 decision 1 deferred one), so a snapshot's age is
 * UNBOUNDED. TWO DIFFERENT WAYS a reading goes stale, and the second is why the bound is measured
 * off the reading's own `observedAt` rather than off `last_observed_at`:
 *
 *  * THE TARGET STOPS BEING POLLED. Reconcile skips a target the moment it terminalizes
 *    (`if (target.status === "succeeded") continue;`). The specific way that bites: a paused Argo
 *    Rollout can aggregate to Application health `Suspended`, which the argocd plugin maps to
 *    `succeeded` — so a dependency parked at 10% reads as done and its stored weight stays 10%
 *    forever, even after a human promotes it to 100%.
 *  * THE TARGET IS STILL POLLED AND THE POLLS SAY NOTHING. `updateWaveTargetObserved` refreshes
 *    `last_observed_at` on every poll but writes `observed_state` only when `observedStateFrom`
 *    returned something, and that returns `undefined` for a status with no stateRef, no images and
 *    no rollout — the argocd plugin's shape for an Application that has been deleted or renamed.
 *    The weight then freezes while its poll timestamp keeps moving, so a bound read off
 *    `last_observed_at` NEVER fires and the hold keeps releasing dependants against a world that no
 *    longer exists.
 *
 * Either way, trusting that number later would be asserting a fact about the world from a reading
 * nobody has taken since.
 *
 * TEN MINUTES, chosen from the two pressures that actually bound it:
 *
 *  * LOWER BOUND — it must never call a normally-polled in-flight target stale. The tick is 1 s and
 *    an `observing` target is polled on every tick its change is served, but `listChangeRowsInStates`
 *    serves oldest-first capped at `BATCH_LIMIT` (25) per state per tick, so a busy instance can
 *    legitimately go many ticks between two polls of the same change. Ten minutes is ~600 ticks of
 *    slack — far past any scheduling delay that is not itself an outage. (A live target restamps
 *    its reading on every poll: a real Argo Application reports a stateRef, so `observedStateFrom`
 *    returns a payload and `updateWaveTargetObserved` writes it.)
 *  * UPPER BOUND — it must reject a frozen snapshot in human time. A weight left over from a
 *    terminalized (or `Suspended`) target, or from an Application that has since been deleted, goes
 *    unreadable within one coffee break rather than being believed for days.
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
  /** This wave target names a COMPONENT rather than a placement (legacy-shaped topology, or NO
   *  topology at all — pipeline resolution finding nothing at any rung puts the plan on
   *  `compilePlan`'s toposort path, whose waves name the change's own targets). There is no place
   *  for a stage-scoped hold to be scoped by. Treated as satisfied because legacy mode keeps its
   *  OWN guarantee: `plan-compiler.ts` still refuses to put two components joined by a `depends_on`
   *  edge in one legacy wave — but that covers only the plain pairing, never a `minWeight` or a
   *  dependency on a component this change does not target.
   *
   *  ITS OWN BRANCH BECAUSE THE FAIL-OPEN HAS TO BE FINDABLE. `reconcile.ts`'s
   *  `recordStageDependencyUnscoped` persists a `warn` Decision naming every dependency that landed
   *  here, so "you declared a coupling and it was not enforced" is a row an operator can query
   *  rather than something they have to deduce from an absence. */
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
  /** A weight is stored but nothing DATES it — the payload carries no `observedAt`.
   *
   *  Reachable for one population and one only: rows whose `observed_state` was written before that
   *  field existed (it is deliberately not backfilled — inferring a reading's age after the fact
   *  would fabricate the very thing the bound exists to check). Also the backstop for a row that
   *  arrived another way, a federation replay or a hand repair. Either way "a weight with no date on
   *  it" degrades rather than being believed, and the next poll of a live target dates it. The
   *  ordinary "no poll has landed yet" case reports `no_weight` instead, because the whole jsonb is
   *  null. */
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
  /** `"edge"` when this dependency came from a plain `depends_on` edge between two of this change's
   *  own targets rather than from the change's own declaration — the domain of the compile-time
   *  check ADR-0028 decision 6 replaced. ABSENT for a declared dependency, deliberately: the
   *  overwhelmingly common case keeps writing the Decision it already wrote, so no existing hold's
   *  `inputContext` changes shape and none of them re-write once for the upgrade. An operator seeing
   *  a hold naming a dependency their CI never declared needs this field to know where it came
   *  from. */
  source?: "edge";
  /** The status of the dependency's most recent wave target at this place, when it had one. */
  dependencyStatus?: string;
  /** Echoed only when the declaration carried the qualifier. */
  minWeight?: number;
  /** Set when the declaration's `minWeight` was NOT applied because the pair also carries a plain
   *  `depends_on` edge between two targets of this change, which asserts the stricter universal
   *  `succeeded` test. `minWeight` is still echoed beside it: the record has to say what was asked
   *  for as well as what was enforced, or "why did my minWeight not let this through?" has no
   *  answer. Discrete and slow-moving like every other field here. */
  minWeightSupersededByEdge?: true;
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
  /** One verdict per declared dependency that APPLIES here, in declaration order, then one per
   *  edge-derived dependency (sorted, since edge rows arrive in no meaningful order), then one per
   *  malformed stored entry. Dependencies excluded by `atTargets` produce no verdict at all —
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
    /** `depends_on` edges with BOTH endpoints among this change's own targets — the exact set
     *  `loadDependsOnEdges` hands the compiler, so the hold orders exactly what the removed
     *  same-wave check refused. Component ids, not placements: the edges are component→component
     *  and this resolves the wave target to its component before matching. */
    edgeDependencies?: readonly DependsOnEdge[];
    /** Injected so a test can pin the freshness boundary without sleeping. Defaults to now. */
    now?: number;
  }
): Promise<StageDependencyEvaluation> {
  const { orgId, waveTargetObjectId, stageDependencies, malformed } = input;
  const edges = input.edgeDependencies ?? [];
  if (stageDependencies.length === 0 && malformed.length === 0 && edges.length === 0) {
    return NOT_DECLARED;
  }

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
    // none is VISIBLE: `reconcile.ts` collects these separately from the holds and writes them as a
    // `warn` Decision of their own, whether or not anything else about the same target holds.
    //
    // EDGE-DERIVED dependencies produce no verdict at all here, unlike declared ones. There is
    // nothing to report: legacy mode's compile-time check is still enforcing that exact edge set, so
    // an edge-joined pair never reaches this loop in one wave to begin with.
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

  const scoped: { dep: ResolvedStageDependency; edgeDerived: boolean }[] = [];
  for (const dep of applicable) {
    if (dep.dependsOn === stage.componentObjectId) {
      // A self-declaration would resolve to THIS very placement, find THIS very wave target sitting
      // in `pending`, and hold forever. Dropped for the same reason `materialiseStageDependencyEdges`
      // drops the self-edge: it means nothing either way, and refusing it late is worse than
      // ignoring it.
      verdicts.push({ dependsOn: dep.dependsOn, branch: "self", satisfied: true });
      continue;
    }
    scoped.push({ dep, edgeDerived: false });
  }

  // THE EDGE-DERIVED HALF — the domain of the compile-time check ADR-0028 decision 6 replaced. The
  // caller already restricted these to edges with BOTH endpoints among this change's own targets;
  // all that remains is to keep the ones pointing OUT of the component this wave target is for.
  // Sorted, because rows come back in no meaningful order and the resulting verdict list lands in a
  // Decision's `inputContext` — an unsorted list would make an unchanged situation look new on the
  // tick a row order changed, and `insertDecisionIfChanged` would write again.
  const edgeAsserted = new Set(
    edges
      .filter((e) => e.from === stage.componentObjectId && e.to !== stage.componentObjectId)
      .map((e) => e.to)
  );

  // ==========================================================================================
  // COMPOSING THE TWO HALVES FOR A PAIR THAT HAS BOTH. THE RULE: A DECLARATION MAY ADD TO ITS OWN
  // COUPLING, OR NARROW WHERE IT APPLIES — IT MAY NEVER MAKE THE PAIR'S EDGE-ASSERTED ORDERING
  // WEAKER (ADR-0028 decision 6's corollary, both halves of it).
  //
  // The two sources are not symmetric, and the asymmetry is the whole point. The EDGE asserts the
  // universal test: `succeeded` at this place. A DECLARATION's `minWeight` is a RELAXATION of that
  // test — "you may go once it reaches N%" — and `atTargets` is a narrowing of where its own
  // declaration applies. So for a pair carrying both, the STRICTEST applicable constraint wins,
  // which is always the edge's plain `succeeded`:
  //
  //   * `atTargets` elsewhere -> the declaration does not apply here at all, and the edge speaks
  //     for the pair (one verdict, `source: "edge"`). Keyed on `applicable`, the atTargets-filtered
  //     set, not on everything declared — that is what stops a prod-scoped declaration silencing
  //     the pair's edge at gamma.
  //   * declaration applies here with NO `minWeight` -> the same constraint from both sources, so
  //     it is ONE verdict attributed to the declaration; the edge adds nothing.
  //   * declaration applies here WITH `minWeight` -> the qualifier is dropped for this pair and the
  //     edge's plain `succeeded` test is what runs, recorded as `minWeightSupersededByEdge`.
  //
  // Without that last case the feature SUBTRACTS an ordering somebody else wrote: an operator, a
  // seed or an earlier change mints app -> dep, and the party being ordered then neutralises it for
  // free by adding `minWeight: 1` to its own declaration — deploying in parallel with a dependency
  // sitting at 5%, on an input that was a loud 400 before decision 6. The whole authority story
  // around minting these edges (`relationship:write` at BOTH endpoints) would be pointless if a
  // declaration could weaken one without any authority at all.
  //
  // WHAT THIS DOES NOT COST: the edge set is only ever non-empty when BOTH endpoints are targets of
  // this same change (`loadDependsOnEdges`), so the 277-of-281 single-target release — the shape
  // `minWeight` exists for, "hold A at gamma until B is 10% there" across two separate pushes —
  // never reaches this rule at all. Only a pair travelling in ONE change does, and that pair used
  // to be refused outright.
  const declaredHere = new Set(applicable.map((dep) => dep.dependsOn));
  for (const dependsOn of [...edgeAsserted].sort()) {
    if (declaredHere.has(dependsOn)) continue;
    scoped.push({ dep: { dependsOn }, edgeDerived: true });
  }

  if (scoped.length === 0) return finish(stage, verdicts, malformedVerdicts);

  // Where each dependency is placed. One query for all of them, filtered down to THIS place —
  // reusing the same properties-are-the-source-of-truth read (ADR-0026 D17) that `plan-service.ts`
  // and `binding-resolution.ts` use, so a placement can never mean one thing here and another there.
  const placements = await listPlacementsForComponents(
    tx,
    orgId,
    scoped.map((entry) => entry.dep.dependsOn)
  );
  const placementHere = new Map<string, string>();
  for (const p of placements) {
    if (p.deploymentTargetObjectId === stage.deploymentTargetObjectId) {
      placementHere.set(p.componentObjectId, p.placementId);
    }
  }

  const now = input.now ?? Date.now();
  for (const entry of scoped) {
    const { dep } = entry;
    // `source` is stamped on the way OUT rather than threaded through `stageDependencyVerdict`,
    // which stays a pure function of (declaration, stored row, clock) and knows nothing about where
    // the declaration came from. Always last in the object; key order is irrelevant to
    // `restatesDecision` (it canonicalises), but a stable shape keeps the stored JSON diffable.
    const source = entry.edgeDerived ? { source: "edge" as const } : {};
    const placementId = placementHere.get(dep.dependsOn);
    if (placementId === undefined) {
      verdicts.push({ dependsOn: dep.dependsOn, branch: "not_placed", satisfied: true, ...source });
      continue;
    }
    const latest = await findLatestWaveTargetForObject(tx, orgId, placementId);
    verdicts.push({
      ...stageDependencyVerdict(dep, latest, now, edgeAsserted.has(dep.dependsOn)),
      ...source
    });
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
        /** Accepted (the caller hands over a whole wave-target row) and deliberately NOT READ. It
         *  dates the POLL, not the reading — see `weightUnreadableCause`. */
        lastObservedAt?: Date | null;
      }
    | undefined,
  now: number,
  /** True when a plain `depends_on` edge between two of this change's own targets ALSO asserts this
   *  pair. That edge asserts the universal `succeeded` test, and a `minWeight` is a RELAXATION of
   *  it, so the qualifier does not apply — see the composition rule in `evaluateStageDependencies`.
   *  Defaults to false: a dependency with no edge behind it is the ordinary cross-change case. */
  edgeAsserted = false
): StageDependencyVerdict {
  // The STRICTEST applicable constraint. `minWeight` is echoed either way — an operator has to be
  // able to see the qualifier they wrote, and to see that it was superseded rather than ignored.
  const superseded = edgeAsserted && dep.minWeight !== undefined;
  const minWeight = superseded ? undefined : dep.minWeight;
  const qualifier = {
    ...(dep.minWeight === undefined ? {} : { minWeight: dep.minWeight }),
    ...(superseded ? { minWeightSupersededByEdge: true as const } : {})
  };

  if (latest === undefined) {
    // Placed here, never deployed here. Distinct from `behind` because the remedies differ: this one
    // usually means the dependency's own pipeline has not run yet, not that it is mid-flight.
    return { dependsOn: dep.dependsOn, branch: "never_deployed", satisfied: false, ...qualifier };
  }

  // THE UNIVERSAL TEST FIRST. `status` is a column every executor produces, so this branch is always
  // readable — which is exactly why the `minWeight` qualifier is allowed to be best-effort.
  if (latest.status === "succeeded") {
    const unreadable =
      minWeight === undefined ? undefined : weightUnreadableCause(latest, now).cause;
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

  if (minWeight !== undefined) {
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
    if (weight >= minWeight) {
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

/**
 * Reads `observed_state.rollout.weight` and dates it. Returns the cause when it cannot be believed,
 * or the number when it can. Callers must treat `cause !== undefined` as UNREADABLE, never as a
 * weight of zero — the two are different claims and only one of them is true.
 *
 * THE AGE IS THE READING'S OWN (`observed_state.observedAt`), NEVER `last_observed_at`. The column
 * beside it is the obvious-looking choice and is wrong: `updateWaveTargetObserved` refreshes
 * `last_observed_at` on EVERY poll while writing `observed_state` only when the poll returned
 * something storable, and `observedStateFrom` returns `undefined` for a status carrying no stateRef,
 * no images and no rollout — which is exactly the argocd plugin's 404 shape for an Application that
 * has been deleted or renamed mid-canary. Dating the snapshot by the poll would then leave the last
 * weight frozen in place while every subsequent tick refreshed its timestamp: the reading is
 * arbitrarily old, `stale` never fires, and the hold keeps RELEASING dependants against a world that
 * no longer exists. Fail-open in the branch ADR-0028 calls the owner's headline requirement.
 */
function weightUnreadableCause(
  latest: { observedState: unknown },
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
  const observedAt = observed?.observedAt === undefined ? NaN : Date.parse(observed.observedAt);
  // Undated (a row written before the field existed, a replay, a hand repair) or undateable.
  if (Number.isNaN(observedAt)) return { cause: "not_observed", weight };
  if (now - observedAt > OBSERVED_WEIGHT_FRESHNESS_MS) return { cause: "stale", weight };
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
  // WHERE THE DEPENDENCY CAME FROM, on every edge-derived line. An operator reading "held behind X"
  // for a coupling their CI never declared has no way to act on it without this: the remedy is to
  // delete a `depends_on` edge, not to edit a pipeline.
  const via =
    verdict.source === "edge"
      ? " (a `depends_on` edge between two targets of this change, not a declaration)"
      : "";
  return describeBranch(verdict) + via;
}

function describeBranch(verdict: StageDependencyVerdict): string {
  switch (verdict.branch) {
    case "never_deployed":
      return `'${verdict.dependsOn}' is placed here but has never deployed here`;
    case "behind":
      // A SUPERSEDED qualifier reads as the plain test PLUS why the number it names did not apply.
      // Saying "below the declared minWeight" would be a lie — the weight was never consulted —
      // and saying nothing would leave the author of a `minWeight: 1` with no account of why their
      // release is held behind a dependency sitting well above it.
      if (verdict.minWeightSupersededByEdge) {
        return `'${verdict.dependsOn}' has not succeeded here (its latest deploy is '${verdict.dependencyStatus}') — the declared minWeight of ${verdict.minWeight} does not apply, because a \`depends_on\` edge between two targets of this change asserts plain success and a declaration cannot weaken it`;
      }
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
