/**
 * THE DOMAIN RECONCILER'S DECISION (ADR-0046 section 4; team-pipeline-iac section 6, D4, and
 * section 14 resolutions 2 and 7) - given the placements visible in this domain and the
 * `executorBinding` effects matching each target, decide which `executor_bindings` rows should
 * exist, and which placements are UNBOUND.
 *
 * PURE. No database, no I/O. The impure half - reading placements, matching policies against each
 * target's containment chain, writing rows - belongs to the reconciler loop; this is the decision
 * it carries out, so the rules below are unit-testable without a container.
 *
 * THREE RULES, EACH A REFUSAL TO GUESS
 *
 * 1. NEAREST RUNG WINS. A policy matched at the target itself beats one matched at its container,
 *    which beats one at the domain - the same depth ordering the rest of the governance machinery
 *    uses (`MatchedPolicy.matchedAt.depth`). That is what lets a domain declare one broad default
 *    and override it for a single cluster.
 *
 * 2. A TIE IS AMBIGUOUS, NOT A COIN FLIP. Two policies at the SAME depth naming DIFFERENT execution
 *    systems for one (target, Type, lane) is a state no rule can adjudicate: unlike a constraint
 *    there is no "more restrictive" answer - one of them is simply going to run the work. Picking
 *    the lower id would be reproducible and still wrong, and the operator would never learn they
 *    had written two. So it is reported, and NOTHING is bound - failing closed exactly as
 *    `registration-match.ts` does when two config sources match one repo.
 *
 *    Two policies at one depth naming the SAME system are not a tie. They agree, and agreeing twice
 *    is not a conflict.
 *
 * 3. NO ORG-TIER FALLBACK. A (target, Type) nothing matches is UNBOUND and reported (res 2). There
 *    is deliberately no default executor: a silent default is how an unbound placement
 *    FAKE-SUCCEEDS today (ADR-0006 case (a), the post-import hazard), and turning that silence into
 *    a reported state is half the reason this reconciler is worth building.
 *
 * THE TEST LANE FALLS BACK; IT DOES NOT DEFAULT (resolution 7)
 *
 * A `test` lane request with no `test` declaration resolves to the BUILD lane's answer, and the
 * result says so (`viaLaneFallback`). That is a real declaration someone wrote, attributable to a
 * policy - not an invented default. A domain that never separates lanes behaves exactly as it does
 * today; one that does gets separation from a single extra policy line. If the build lane is itself
 * unbound, the test lane is unbound too: fallback cannot manufacture an answer that does not exist.
 */

import type { ExecutorBindingEffect, ExecutorLane, ExecutorType } from "@scp/schemas";

/** One `executorBinding` effect that matched a target, with the coordinates that make the winner
 *  explainable (DESIGN section 10.4: the reason tree is the return value, not a log line). */
export interface BindingContribution {
  policyObjectId: string;
  policyVersion: number;
  policyName: string;
  /** `MatchedPolicy.matchedAt.depth` - 0 at the target itself, larger further up the chain. */
  depth: number;
  effect: ExecutorBindingEffect;
}

/** One placement the reconciler must bind, and what it needs bound. */
export interface PlacementBindingNeed {
  targetObjectId: string;
  componentObjectId: string;
  /** The Types this component actually releases via - never "every Type", which would report every
   *  target as unbound for Types nobody uses. */
  types: readonly ExecutorType[];
  /** Lanes to resolve per Type. `build` always; `test` only where the component declares a test
   *  hook, so an estate with no hooks reports no test-lane gaps. */
  lanes: readonly ExecutorLane[];
}

export interface ResolvedBinding {
  targetObjectId: string;
  componentObjectId: string;
  type: ExecutorType;
  lane: ExecutorLane;
  executionSystemUrn: string;
  externalRef?: string;
  /** The winning contribution's coordinates - read from the row later, never re-derived. */
  policyObjectId: string;
  policyVersion: number;
  /** True when a `test` lane resolved through the build lane's declaration (resolution 7). */
  viaLaneFallback: boolean;
}

export type BindingGap =
  | {
      reason: "unbound";
      targetObjectId: string;
      componentObjectId: string;
      type: ExecutorType;
      lane: ExecutorLane;
    }
  | {
      reason: "ambiguous";
      targetObjectId: string;
      componentObjectId: string;
      type: ExecutorType;
      lane: ExecutorLane;
      depth: number;
      /** Every execution system named at the winning depth, sorted - never the one a tiebreak would
       *  have silently chosen. */
      executionSystemUrns: string[];
      policyObjectIds: string[];
    };

export interface BindingResolution {
  /** Sorted by (target, type, lane) so two runs over one state produce the same list and a diff
   *  against the stored rows is stable. */
  bindings: ResolvedBinding[];
  /** Sorted the same way. Empty in a fully-declared domain. */
  gaps: BindingGap[];
}

function laneOf(effect: ExecutorBindingEffect): ExecutorLane {
  // ABSENT MEANS `build`, resolved here rather than by a Zod default so the rule lives in one
  // place: a document written before lanes existed means the build lane, which is what every
  // binding in every estate is today.
  return effect.lane ?? "build";
}

type LaneOutcome =
  | { outcome: "bound"; contribution: BindingContribution }
  | {
      outcome: "ambiguous";
      depth: number;
      executionSystemUrns: string[];
      policyObjectIds: string[];
    }
  | { outcome: "none" };

/** Nearest-rung winner among contributions already filtered to one (type, lane). */
function resolveLane(candidates: readonly BindingContribution[]): LaneOutcome {
  if (candidates.length === 0) return { outcome: "none" };
  const minDepth = Math.min(...candidates.map((c) => c.depth));
  const nearest = candidates.filter((c) => c.depth === minDepth);
  const systems = [...new Set(nearest.map((c) => c.effect.executionSystemUrn))].sort();
  if (systems.length > 1) {
    return {
      outcome: "ambiguous",
      depth: minDepth,
      executionSystemUrns: systems,
      policyObjectIds: [...new Set(nearest.map((c) => c.policyObjectId))].sort()
    };
  }
  // Agreement is not a tie. Where several policies at one depth name the SAME system, the winner is
  // deterministic by policy id so recorded provenance does not flap between reconcile ticks.
  const winner = [...nearest].sort((a, b) =>
    a.policyObjectId < b.policyObjectId ? -1 : a.policyObjectId > b.policyObjectId ? 1 : 0
  )[0] as BindingContribution;
  return { outcome: "bound", contribution: winner };
}

/**
 * Resolve every placement's bindings.
 *
 * `contributionsByTarget` carries the effects that matched EACH target's own containment chain, so
 * this function never has to know how policy matching works.
 */
export function resolveExecutorBindings(
  needs: readonly PlacementBindingNeed[],
  contributionsByTarget: ReadonlyMap<string, readonly BindingContribution[]>
): BindingResolution {
  const bindings: ResolvedBinding[] = [];
  const gaps: BindingGap[] = [];

  for (const need of needs) {
    const all = contributionsByTarget.get(need.targetObjectId) ?? [];
    for (const type of need.types) {
      const forType = all.filter((c) => c.effect.type === type);
      for (const lane of need.lanes) {
        const own = resolveLane(forType.filter((c) => laneOf(c.effect) === lane));

        let outcome = own;
        let viaLaneFallback = false;
        // Resolution 7 - a `test` request with no `test` declaration takes the BUILD lane's answer.
        // ONLY `none` falls back: an AMBIGUOUS test lane is a conflict the operator must resolve,
        // and substituting the build lane would resolve it for them in favour of a declaration they
        // did not make for this lane.
        if (lane === "test" && own.outcome === "none") {
          outcome = resolveLane(forType.filter((c) => laneOf(c.effect) === "build"));
          viaLaneFallback = outcome.outcome === "bound";
        }

        if (outcome.outcome === "bound") {
          const { contribution } = outcome;
          bindings.push({
            targetObjectId: need.targetObjectId,
            componentObjectId: need.componentObjectId,
            type,
            lane,
            executionSystemUrn: contribution.effect.executionSystemUrn,
            ...(contribution.effect.externalRef !== undefined
              ? { externalRef: contribution.effect.externalRef }
              : {}),
            policyObjectId: contribution.policyObjectId,
            policyVersion: contribution.policyVersion,
            viaLaneFallback
          });
        } else if (outcome.outcome === "ambiguous") {
          gaps.push({
            reason: "ambiguous",
            targetObjectId: need.targetObjectId,
            componentObjectId: need.componentObjectId,
            type,
            lane,
            depth: outcome.depth,
            executionSystemUrns: outcome.executionSystemUrns,
            policyObjectIds: outcome.policyObjectIds
          });
        } else {
          gaps.push({
            reason: "unbound",
            targetObjectId: need.targetObjectId,
            componentObjectId: need.componentObjectId,
            type,
            lane
          });
        }
      }
    }
  }

  const key = (e: { targetObjectId: string; type: string; lane: string }): string =>
    [e.targetObjectId, e.type, e.lane].join(" ");
  bindings.sort((a, b) => key(a).localeCompare(key(b)));
  gaps.sort((a, b) => key(a).localeCompare(key(b)));
  return { bindings, gaps };
}
