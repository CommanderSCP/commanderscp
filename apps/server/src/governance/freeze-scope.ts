import type { TenantTx } from "../db/tenant-tx.js";
import { containmentChain } from "../graph/containment.js";
import {
  activeFreezesInWindow,
  filterFreezesByScopes,
  type FreezeRow
} from "./freezes-repo.js";

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

/** One wave target and every ACTIVE freeze covering it, at the instant asked about. `freezes` is
 *  empty for a target nothing covers — an entry is always present for every id passed in, so a
 *  caller can index the result without deciding what a missing key means. */
export interface TargetFreezes {
  targetObjectId: string;
  freezes: FreezeRow[];
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
  // PROPERTY 1 — INERTNESS. The org-wide window read comes FIRST and short-circuits the whole
  // function. Do not move a containment walk above this line, and do not "optimise" it into the
  // loop: one query for the org is what makes a change with nothing frozen cost nothing.
  const active = await activeFreezesInWindow(tx, orgId, now);
  if (active.length === 0) return targetObjectIds.map((id) => ({ targetObjectId: id, freezes: [] }));

  const byTarget: TargetFreezes[] = [];
  for (const targetObjectId of targetObjectIds) {
    const chain = await containmentChain(tx, orgId, targetObjectId);
    byTarget.push({
      targetObjectId,
      freezes: filterFreezesByScopes(
        active,
        chain.map((entry) => entry.id)
      )
    });
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
export function unionFreezes(byTarget: TargetFreezes[]): FreezeRow[] {
  const seen = new Set<string>();
  const union: FreezeRow[] = [];
  for (const entry of byTarget) {
    for (const freeze of entry.freezes) {
      if (seen.has(freeze.id)) continue;
      seen.add(freeze.id);
      union.push(freeze);
    }
  }
  return union;
}
