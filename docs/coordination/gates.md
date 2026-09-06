# gates

Reference for `apps/server/src/coordination/gates.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 11 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. The wave-boundary counterpart (DESIGN §9.3)

The wave-boundary counterpart (DESIGN §9.3). Always governance-evaluated (module doc comment — unlike lifecycle edges, waiting at a wave boundary can never deadlock the engine: reconcile retries every tick, and an approval/control can resolve independently of this specific check).

## §2. THE THIRD CONTRIBUTOR

THE THIRD CONTRIBUTOR — declared pipeline hooks (increment 8)
ADDED BESIDE the other two, never replacing either: the verdict below is the AND of the orchestrator's answer (policies, controls, approvals, freezes) and this one. A component that declares no hooks contributes `allowed: true` with an empty entry list and changes nothing.

EVALUATED EVEN WHEN THE ORCHESTRATOR ALREADY BLOCKED, deliberately. The Decision must explain EVERY reason the wave is not moving, or an operator clears the policy block and discovers a second one they were never told about — one round trip per contributor. The cost is bounded by `evaluatePipelineHookGate`'s inertness gate (two indexed existence reads for an org that declares nothing).

`awaiting` / `no_source` / `window_not_covered` BLOCK AND KEEP BLOCKING, and that is safe here rather than a deadlock: this gate is re-evaluated on EVERY tick while the wave stays `pending` (only the transition fires once — `gate-orchestrator.ts`: "waiting at a wave boundary can never deadlock the engine"), so an in-flight suite that finishes, or a first alarm report that arrives, is noticed within a tick with no scheduler and no status flip.

## §3. NOTHING HERE IS DERIVED FROM A CLOCK

NOTHING HERE IS DERIVED FROM A CLOCK — every entry field is an id, a declared number, or an instant read straight off a stored row (see `PipelineHookGateEntry`). That is what keeps a re-evaluated block byte-identical on every tick so `insertDecisionIfChanged` suppresses it, which is ADR-0024's 1.44 GB/day contract. Omitted entirely when no hook context was supplied, so an unchanged campaign-side Decision keeps exactly the bytes it had.
