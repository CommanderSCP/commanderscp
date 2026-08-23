import type { TenantTx } from "../db/tenant-tx.js";
import { containmentChain } from "../graph/containment.js";
import { readStageCoordinate } from "../coordination/regional-executors.js";
import { activeFreezesInWindow, filterFreezesByScopes, type FreezeRow } from "./freezes-repo.js";
import {
  activeInstanceFreezesInWindow,
  instanceFreezeCovers,
  type InstanceFreezeRow
} from "./instance-freezes-repo.js";

/**
 * PER-TARGET FREEZE RESOLUTION — the primitive M25.2's per-target wave admission is built on
 * (docs/proposals/campaigns-rework.md §1.1(b)).
 *
 * Until now the only question the freeze path could ask was "is ANY of this wave's scope frozen?":
 * `checkFreeze` unioned every target's containment chain into one `scopeObjectIds` set and got one
 * verdict back, so a freeze over one region parked all four. This module answers the same question
 * one target at a time, and `unionFreezes` folds the answers back into exactly the set the
 * whole-change semantics already consume.
 *
 * ============================================================================================
 * TWO LOAD-BEARING PROPERTIES
 * ============================================================================================
 *
 * 1. **INERTNESS.** `activeFreezesInWindow` runs FIRST, org-wide, with no scope filter. If it
 *    returns nothing, every target comes back with `freezes: []` and NOT ONE containment chain is
 *    walked. That is not an optimisation to be traded away later: this runs for every executing
 *    change on the instance on every 1 s tick, and a containment walk is a recursive CTE per
 *    target. An org with no active freeze — which is nearly every org nearly all of the time —
 *    pays one indexed read on `freezes_org_window` and nothing else. It has its own test, and the
 *    test counts queries rather than reading the code.
 *
 * 2. **SET EQUALITY WITH THE OLD PATH.** `unionFreezes(await freezesByTarget(tx, org, T, now))` is
 *    set-equal to `activeFreezesForScopes(tx, org, await containmentScopeIds(tx, org, T), now)`
 *    BY CONSTRUCTION — `containmentScopeIds` is literally the union of `containmentChain` over each
 *    id, and `filterFreezesByScopes` distributes over that union. It is pinned by a test anyway,
 *    because "by construction" is a claim about two functions that can be edited independently.
 *
 * ============================================================================================
 * WALK `containmentChain`, PER TARGET, AND NOTHING ELSE
 * ============================================================================================
 * Never a hand-rolled walk and never `[targetObjectId]` alone. `graph/containment.ts`'s header
 * records what both shortcuts cost: three row-returning copies of one walk drifted, one kept a
 * `domain_id`-only route, and a SERVICE-scoped freeze failed OPEN — silently, because a freeze that
 * stops matching produces the same `allow` a freeze that never existed would. A stage-mode wave
 * target is a PLACEMENT, whose chain reaches its component (route 3) and its deployment-target
 * (route 4) and continues up through both; `[targetObjectId]` alone would find only a freeze
 * declared at that exact placement, which nobody has ever authored.
 *
 * READS ONLY, and takes a `TenantTx` the caller owns — the caller decides what to persist and does
 * it in its own transaction, exactly as `coordination/stage-dependency-hold.ts` does.
 */

/**
 * ONE FREEZE IN FORCE, FROM EITHER TIER — the discriminated union every consumer of this module
 * now handles (M25.3, owner decision D1).
 *
 * A DISCRIMINATED UNION AND NOT A FLATTENED ROW, deliberately. The two tiers differ in the one
 * field authorization is decided on: an org freeze carries `scopeObjectId`, the object
 * `freeze:override` is checked at; a platform freeze has none, because object ids are per-org rows
 * and no id names anything in a second tenant. Flattening the two into one shape with a nullable
 * `scopeObjectId` would let `checkFreeze`, `freeze-hold.ts` and the service board each read that
 * null and decide for themselves what it means — and the natural guesses are all wrong (the
 * proposal §2.2 names three: an org-root scope hands every org Administrator the lift of a
 * platform freeze, a synthetic sentinel id makes it un-overridable BY ACCIDENT, and an operator
 * token on the request cannot exist for the case that matters because wave-boundary gates run
 * under `SYSTEM_ACTOR_ID` with no HTTP request in scope). With a union, TypeScript REFUSES to
 * compile a consumer that reads `scopeObjectId` without first asking which tier it is holding.
 *
 * Every field the whole-change pipeline actually consumes — `id`, `name`, `endsAt`, `reason`,
 * `atomic` — is present on BOTH arms with the same meaning, so the dedupe, the ordering, the
 * `atomic` union and the Decision projections work across tiers with no per-tier branch at all.
 */
export type EffectiveFreeze =
  ({ tier: "org" } & FreezeRow) | ({ tier: "platform" } & InstanceFreezeRow);

/** One wave target and every ACTIVE freeze covering it, at the instant asked about, from BOTH
 *  tiers. `freezes` is empty for a target nothing covers — an entry is always present for every id
 *  passed in, so a caller can index the result without deciding what a missing key means. */
export interface TargetFreezes {
  targetObjectId: string;
  freezes: EffectiveFreeze[];
}

/**
 * Every target's covering freezes, in the order the targets were given.
 *
 * `now` is REQUIRED here rather than defaulted, deliberately: the two production callers
 * (`gate-orchestrator.ts`'s `evaluateGovernanceGate` and `coordination/freeze-hold.ts`) each
 * snapshot one instant and use it for the whole evaluation, and a default would let a caller
 * silently evaluate two targets of one wave against two different clocks.
 *
 * DUPLICATE TARGET IDS produce duplicate entries, one per occurrence, rather than being collapsed.
 * A wave cannot hold the same target twice, so this never arises in production — and collapsing
 * would make the result's length differ from the input's, which is precisely the shape a caller's
 * `frozenIds.length < ctx.targetObjectIds.length` comparison must be able to trust.
 */
export async function freezesByTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[],
  now: Date
): Promise<TargetFreezes[]> {
  // PROPERTY 1 — INERTNESS. BOTH window reads come FIRST and short-circuit the whole function
  // together. Do not move a containment walk or a coordinate read above this line, and do not
  // "optimise" either into the loop: two indexed queries are what make a change with nothing
  // frozen cost nothing. M25.3 added exactly ONE query to this regime (the instance-tier window
  // read, over a table that ships empty), and not a single graph traversal.
  const orgActive = await activeFreezesInWindow(tx, orgId, now);
  const instanceActive = await activeInstanceFreezesInWindow(tx, now);
  if (orgActive.length === 0 && instanceActive.length === 0)
    return targetObjectIds.map((id) => ({ targetObjectId: id, freezes: [] }));

  // The stage coordinate is read PER TARGET and only when some live instance freeze is actually
  // addressed by one. A deployment-wide freeze (`matchAllEnvironments`) covers every target
  // regardless of coordinate, so asking the graph where each target runs would be two reads per
  // target per tick answering a question the matcher does not consult.
  const coordinateAddressed = instanceActive.some((f) => !f.matchAllEnvironments);

  const byTarget: TargetFreezes[] = [];
  for (const targetObjectId of targetObjectIds) {
    const freezes: EffectiveFreeze[] = [];

    // ==========================================================================================
    // THE INSTANCE TIER FIRST — and the ORDER IS REPORTING, NOT SEMANTICS.
    // ==========================================================================================
    // `checkFreeze`'s loop is a universal quantifier and stays order-independent (`unionFreezes`
    // says so and must keep being true). Platform freezes are listed first only so that when a
    // change is covered by both tiers, the reason an operator reads names the one they cannot
    // override rather than the one they can.
    if (instanceActive.length > 0) {
      // `readStageCoordinate` performs the placement -> deployment-target hop itself; without it a
      // stage-shaped wave target (ADR-0026) declares nothing and an environment-addressed platform
      // freeze silently matches NOTHING, indistinguishable from a freeze that was never declared.
      const coordinate = coordinateAddressed
        ? await readStageCoordinate(tx, orgId, targetObjectId)
        : null;
      for (const f of instanceActive) {
        if (instanceFreezeCovers(f, coordinate)) freezes.push({ tier: "platform", ...f });
      }
    }

    // ==========================================================================================
    // THE ORG TIER — UNION, NOT OVERRIDE. A freeze is a PREDICATE and the merge is an OR.
    // ==========================================================================================
    // Note what this loop does NOT do: it never consults the instance tier before walking, and the
    // instance tier never consults it. An org that declared nothing still gets every platform
    // freeze (the empty org set contributes FALSE to an OR), and nothing an org can author
    // subtracts from a platform freeze. The "floor" property lives entirely in the override rule
    // (`instance_freezes.overridable`), never here. Contrast ADR-0016's scan floors, which merge
    // by per-severity MIN because a threshold is a number.
    if (orgActive.length > 0) {
      const chain = await containmentChain(tx, orgId, targetObjectId);
      for (const f of filterFreezesByScopes(
        orgActive,
        chain.map((entry) => entry.id)
      )) {
        freezes.push({ tier: "org", ...f });
      }
    }

    byTarget.push({ targetObjectId, freezes });
  }
  return byTarget;
}

/**
 * The union across targets — deduped by freeze id, in a STABLE order (first appearance, targets in
 * the order they were resolved).
 *
 * This is what whole-change semantics consume, and `gate-orchestrator.ts`'s `checkFreeze` takes it
 * INSTEAD of the per-target map on purpose. `checkFreeze` holds CRITICAL #2 — every active freeze
 * individually overridden by an actor holding `freeze:override` at THAT freeze's own scope — and
 * handing it a flat list means a per-target early return, or a `byTarget[0]` degradation, is not
 * expressible at that call site at all. Checking only `active[0]` was a shipped bug once; the fix
 * is structural rather than a comment asking the next reader not to reintroduce it.
 *
 * Order is stable but NOT semantically meaningful: the override loop is a universal quantifier and
 * must stay order-independent. The stability is here so a Decision built from this list cannot
 * churn because a wave's targets came back in a different order.
 */
export function unionFreezes(byTarget: TargetFreezes[]): EffectiveFreeze[] {
  const seen = new Set<string>();
  const union: EffectiveFreeze[] = [];
  for (const entry of byTarget) {
    for (const freeze of entry.freezes) {
      if (seen.has(freeze.id)) continue;
      seen.add(freeze.id);
      union.push(freeze);
    }
  }
  return union;
}
