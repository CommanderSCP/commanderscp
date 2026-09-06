# stage-dependency-hold

Reference for `apps/server/src/coordination/stage-dependency-hold.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 13 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ADR-0028 increment 3 — THE HOLD

ADR-0028 increment 3 — THE HOLD.

The guarantee, stated so it can be kept: *A's deploy at stage S is not TRIGGERED until, for every declared dependency B of A that applies at S, B's deploy at S is satisfied.*

TWO SOURCES FEED ONE DEPENDENCY SET, and the second is not an extension — it is the domain of the check ADR-0028 decision 6 removed from `plan-compiler.ts`, landing where the duty went:

```text
1. the change's own DECLARED `stageDependencies`, carrying the `minWeight`/`atTargets`
   qualifiers; and
2. plain `depends_on` EDGES with BOTH endpoints among this change's own targets — no
   qualifiers, the universal `succeeded` test only.
```

(2) exists because the removed compiler check keyed on the EDGE, not on a declaration: it refused (400) any plan putting two edge-joined targets in one wave, whatever wrote the edge — a seed, an IaC manifest, an operator, or an EARLIER change's declaration. Keying the hold only on this change's own declarations would have left that set ordering nothing at all, which is a silent regression rather than a design choice. The scope is deliberately not one inch wider: an edge with an endpoint OUTSIDE this change's target set ordered nothing before and orders nothing now, so a bulk edge import cannot turn the org's whole graph into a release gate (`graph.dependentIds` is a live CEL policy input — ADR-0028 decision 6 cautions about exactly that blast radius).

This module is the PREDICATE only; `reconcile.ts`'s per-target loop is the seam that acts on it. The split is deliberate — the predicate is a pure-ish read that a test can drive directly, and the seam is three lines whose two invariants (the target counted as in flight before the `continue`, and the skip happening before the advisory trigger-claim lock) are copied verbatim from the backoff gate beside it. With ONE thing the backoff gate never needed: a held target must not keep an already-failed wave alive, so the seam's terminalization asks whether every target still in flight is a held one rather than whether any is (reconcile.ts, end of the per-target loop).

WHAT THIS IS NOT: it is not a rollout-step hold. `ExecutorPlugin` is exactly `observe`/`trigger`/ `status`/`abort`/`describeCapabilities`; there is no advance/pause/resume verb to withhold once a Rollout is running, and ADR-0008 forbids adding one. SCP declines to make a call it was always free not to make yet — the same authority ADR-0006's binding gate and freezes already exercise. The finest grain enforceable here is therefore "is A triggered at this place at all".

## §2. One dependency's verdict at one place

One dependency's verdict at one place. Every field is DISCRETE and slow-moving on purpose: this is what lands in a Decision's `inputContext`, and a field that changes every tick would re-open the 1.44 GB/day write amplification of ADR-0024. Note in particular what is ABSENT — the observed weight itself. A dependency walking 10 -> 20 -> 30 below a `minWeight` of 50 would otherwise write a new Decision per weight change, which is the same bug wearing a different hat. The qualitative branch is what explains the hold; the number is live telemetry and belongs on the observe surface, not in the audit record.

## §3. LEGACY-SHAPED WAVE TARGET

LEGACY-SHAPED WAVE TARGET — it names a component, and a component is not a place. The guarantee is not lost here, it was never this mechanism's to keep: `plan-compiler.ts`'s legacy path STILL refuses to schedule two components joined by a `depends_on` edge into one wave (only the STAGE path's copy of that check was replaced by this hold, ADR-0028 decision 6). Recorded as a verdict rather than skipped so that a change which declared a coupling and got none is VISIBLE: `reconcile.ts` collects these separately from the holds and writes them as a `warn` Decision of their own, whether or not anything else about the same target holds.

EDGE-DERIVED dependencies produce no verdict at all here, unlike declared ones. There is nothing to report: legacy mode's compile-time check is still enforcing that exact edge set, so an edge-joined pair never reaches this loop in one wave to begin with.
