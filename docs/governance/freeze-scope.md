# freeze-scope

Reference for `apps/server/src/governance/freeze-scope.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 8 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. PER-TARGET FREEZE RESOLUTION

PER-TARGET FREEZE RESOLUTION — the primitive M25.2's per-target wave admission is built on (docs/proposals/campaigns-rework.md §1.1(b)).

Until now the only question the freeze path could ask was "is ANY of this wave's scope frozen?": `checkFreeze` unioned every target's containment chain into one `scopeObjectIds` set and got one verdict back, so a freeze over one region parked all four. This module answers the same question one target at a time, and `unionFreezes` folds the answers back into exactly the set the whole-change semantics already consume.

TWO LOAD-BEARING PROPERTIES

1. **INERTNESS.** `activeFreezesInWindow` runs FIRST, org-wide, with no scope filter. If it returns nothing, every target comes back with `freezes: []` and NOT ONE containment chain is walked. That is not an optimisation to be traded away later: this runs for every executing change on the instance on every 1 s tick, and a containment walk is a recursive CTE per target. An org with no active freeze — which is nearly every org nearly all of the time — pays one indexed read on `freezes_org_window` and nothing else. It has its own test, and the test counts queries rather than reading the code.

2. **SET EQUALITY WITH THE OLD PATH.** `unionFreezes(await freezesByTarget(tx, org, T, now))` is set-equal to `activeFreezesForScopes(tx, org, await containmentScopeIds(tx, org, T), now)` BY CONSTRUCTION — `containmentScopeIds` is literally the union of `containmentChain` over each id, and `filterFreezesByScopes` distributes over that union. It is pinned by a test anyway, because "by construction" is a claim about two functions that can be edited independently.

WALK `containmentChain`, PER TARGET, AND NOTHING ELSE
Never a hand-rolled walk and never `[targetObjectId]` alone. `graph/containment.ts`'s header records what both shortcuts cost: three row-returning copies of one walk drifted, one kept a `domain_id`-only route, and a SERVICE-scoped freeze failed OPEN — silently, because a freeze that stops matching produces the same `allow` a freeze that never existed would. A stage-mode wave target is a PLACEMENT, whose chain reaches its component (route 3) and its deployment-target (route 4) and continues up through both; `[targetObjectId]` alone would find only a freeze declared at that exact placement, which nobody has ever authored.

READS ONLY, and takes a `TenantTx` the caller owns — the caller decides what to persist and does it in its own transaction, exactly as `coordination/stage-dependency-hold.ts` does.

## §2. ONE FREEZE IN FORCE, FROM EITHER TIER

ONE FREEZE IN FORCE, FROM EITHER TIER — the discriminated union every consumer of this module now handles (M25.3, owner decision D1).

A DISCRIMINATED UNION AND NOT A FLATTENED ROW, deliberately. The two tiers differ in the one field authorization is decided on: an org freeze carries `scopeObjectId`, the object `freeze:override` is checked at; a platform freeze has none, because object ids are per-org rows and no id names anything in a second tenant. Flattening the two into one shape with a nullable `scopeObjectId` would let `checkFreeze`, `freeze-hold.ts` and the service board each read that null and decide for themselves what it means — and the natural guesses are all wrong (the proposal §2.2 names three: an org-root scope hands every org Administrator the lift of a platform freeze, a synthetic sentinel id makes it un-overridable BY ACCIDENT, and an operator token on the request cannot exist for the case that matters because wave-boundary gates run under `SYSTEM_ACTOR_ID` with no HTTP request in scope). With a union, TypeScript REFUSES to compile a consumer that reads `scopeObjectId` without first asking which tier it is holding.

Every field the whole-change pipeline actually consumes — `id`, `name`, `endsAt`, `reason`, `atomic` — is present on BOTH arms with the same meaning, so the dedupe, the ordering, the `atomic` union and the Decision projections work across tiers with no per-tier branch at all.

## §3. THE INSTANCE TIER FIRST

THE INSTANCE TIER FIRST — and the ORDER IS REPORTING, NOT SEMANTICS.
`checkFreeze`'s loop is a universal quantifier and stays order-independent (`unionFreezes` says so and must keep being true). Platform freezes are listed first only so that when a change is covered by both tiers, the reason an operator reads names the one they cannot override rather than the one they can.

## §4. THE ORG TIER

THE ORG TIER — UNION, NOT OVERRIDE. A freeze is a PREDICATE and the merge is an OR.
Note what this loop does NOT do: it never consults the instance tier before walking, and the instance tier never consults it. An org that declared nothing still gets every platform freeze (the empty org set contributes FALSE to an OR), and nothing an org can author subtracts from a platform freeze. The "floor" property lives entirely in the override rule (`instance_freezes.overridable`), never here. Contrast ADR-0016's scan floors, which merge by per-severity MIN because a threshold is a number.
