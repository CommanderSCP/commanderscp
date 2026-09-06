# gate-orchestrator

Reference for `apps/server/src/governance/gate-orchestrator.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 40 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHERE `freeze:override` IS CHECKED

WHERE `freeze:override` IS CHECKED. Org tier: the freeze's OWN scope, unchanged since CRITICAL #2 — a narrow-scope holder must not slip a change past a broader freeze. Platform tier, and only once the operator has set `overridable`: the ORG ROOT, the widest scope a tenant has, because the freeze binds the whole org and there is no narrower object it could honestly be checked at. Note the two authorities stay independent and BOTH are required — the operator admits the override by setting the bit, the tenant must still hold the permission at its root and still must supply a reason.

## §2. THE ROLLBACK EXEMPTION

THE ROLLBACK EXEMPTION (owner decision D7) — the ALL-frozen half of it. `partiallyFrozen` above only stands the gate aside when some sibling is still admissible; a rollback whose every target is frozen has no admissible sibling and would be refused here, which is precisely the case D7 is about. `evaluateLifecycleGate` has exempted rollbacks since M4 and the wave boundary never learned the same fact — an oversight, not a decision, and the one that left `scp change rollback` as the documented exit from a stuck release while a freeze closed that exit.

NARROW: it lifts the FREEZE block and nothing else. Execution continues into policy matching, controls and approvals below, all of which still apply to a rollback's wave. QUALIFIED ON `wave_boundary`, exactly like `partiallyFrozen` above, and not merely on `isRollback`. Today `isRollback` is set only by `evaluateWaveGate`, so the conjunct is inert — but `isRollback` lives on the SHARED `GateContext`, and one future caller setting it on the lifecycle path would silently lift the freeze at `validating -> accepted` AND on `POST /policy-evaluate`. `lifecycle_edge` keeps any-target-frozen => block by design (there is no such thing as accepting three quarters of a change), and D7 is a WAVE-boundary decision.

AND TIER-AWARE (M25.3 review finding 1). `rollbackExemptible` is the ONE definition of "may D7 stand this covering set aside", shared verbatim with `reconcile.ts`'s per-target seam: a PLATFORM freeze is never stood aside for a rollback. Shipped tier-blind, this conjunct handed any principal holding `object:write` (all `POST /v1/changes/{id}/rollback` requires — no `freeze:override`, no reason, no operator token) a route past the freeze `checkFreeze`'s block sentence promises "no tenant role can override, however privileged", and a CHEAPER one than the override it was contrasted with. The full reasoning, including why `overridable` is deliberately NOT consulted and what this narrows, is on `rollbackExemptible`.

## §3. M22.7 — the actuator at the EVALUATE site

M22.7 — the actuator at the EVALUATE site. This is a SECOND call site, not a duplicate: the prewarm's run authorizes the host-less accept edge, this one authorizes a wave boundary, and M22.0a keys them separately on purpose — so a wave parked for days behind a failing scan is exactly the case where a grant approved in the meantime has to take effect. Wiring only one of the two is the precise mistake M22.2's measured mutation M-2 found in the threading itself.

Resolved even when `host` is null (it costs one indexed read per accept attempt and nothing on a reconcile tick) so the `force` below is computed from the same expression on both branches; the host-less branch cannot run a control at all, so it simply never uses it.
