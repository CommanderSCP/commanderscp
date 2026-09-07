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

/** ADR-0028 increment 3 — THE HOLD. See docs/coordination.md §949. */

/** FRESHNESS BOUND for the optional `minWeight` qualifier. See docs/coordination.md §950. */
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

/** One dependency's verdict at one place. See docs/coordination.md §951. */
export interface StageDependencyVerdict {
  /** The component object id depended on. For an `undeclarable` entry this is the raw stored entry
   *  rendered as JSON, because there was no parseable id to name. */
  dependsOn: string;
  branch: StageDependencyBranch;
  satisfied: boolean;
  /** `edge` when the dependency came from a plain edge. See docs/coordination.md §952. */
  source?: "edge";
  /** The status of the dependency's most recent wave target at this place, when it had one. */
  dependencyStatus?: string;
  /** Echoed only when the declaration carried the qualifier. */
  minWeight?: number;
  /** Set when the declared weight was not applied. See docs/coordination.md §953. */
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
  /** One verdict per applying dependency, then per edge. See docs/coordination.md §954. */
  verdicts: StageDependencyVerdict[];
}

const NOT_DECLARED: StageDependencyEvaluation = { held: false, stage: null, verdicts: [] };

/** Evaluates every declared dependency against one target. See docs/coordination.md §955. */
export async function evaluateStageDependencies(
  tx: TenantTx,
  input: {
    orgId: string;
    /** The wave target's `target_object_id` — a PLACEMENT in stage mode, a component in legacy. */
    waveTargetObjectId: string;
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
    // LEGACY-SHAPED WAVE TARGET. See docs/coordination.md §956.
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
  const edgeAsserted = new Set(
    edges
      .filter((e) => e.from === stage.componentObjectId && e.to !== stage.componentObjectId)
      .map((e) => e.to)
  );

  // COMPOSING THE TWO HALVES FOR A PAIR THAT HAS BOTH. See docs/coordination.md §957.
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

/** The universal test, the qualifier, then why it held. See docs/coordination.md §958. */
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

/** Reads `observed_state.rollout.weight` and dates it. See docs/coordination.md §959. */
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

/** The target's row, reduced to the pair a hold needs. See docs/coordination.md §960. */
export async function resolvePlacementPair(
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

/** One line per held target, for the reason tree and log. See docs/coordination.md §961. */
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
