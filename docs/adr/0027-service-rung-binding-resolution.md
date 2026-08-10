# ADR 0027 — a SERVICE rung in executor-binding resolution

**Status:** Accepted (owner decisions, 2026-08-10). Implements the scope walk-up
[ADR-0007](0007-executor-binding-type-taxonomy.md) deferred.

**Relates to:** [ADR-0007](0007-executor-binding-type-taxonomy.md) ("Scope walk-up resolution
(component → service → deployment-target → cluster) — own work"), [ADR-0026](0026-placements-and-derived-stage-names.md)
(the placement rung this extends), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md)
(the fail-closed path an unresolved binding lands in), `apps/server/src/coordination/binding-resolution.ts`.

## Context

Infrastructure often serves a **whole service**, not one component. A cluster, a shared database, a
VPC — one `infrastructure` pipeline stands them up and every component of the service runs on top.
Modelling that as N identical bindings, one per component or per placement, is duplication that
drifts the moment a component is added.

Storage already permits the natural expression: `executor_bindings.target_object_id` is any object
id, so a binding can hang off a `service`. **Resolution does not.**
`resolveBindingForTarget` performs exactly two lookups — the target itself, then (for a component)
that component's placements — and there is no rung that walks *up* to the owning service.

The consequence is not a quiet no-op, which is what makes this worth an ADR. Falling through both
lookups reaches `blockWaveTargetNoExecutor` (ADR-0006's fail-closed path), so an `infrastructure`
change against a component whose only infra binding lives on its service is **blocked** with a
`no_executor` Decision. A service-level binding today is inert config that also breaks releases.

Measured on the live estate (2026-08-03, `iac-placements.md`): 61 bindings on placements, 4 on
deployment-targets, 1 on a component, **0 on a service** — because there has never been a reason to
create one that works.

## Decision

Add a **third rung**: after `direct` and `via_placement`, resolve the binding on the target's
**owning service**.

```
1. direct        — a binding on the target object itself
2. via_placement — the target is a component; EXACTLY ONE of its placements carries one
   (two or more ⇒ `ambiguous`, refuse — see D2)
3. via_service   — the owning service carries one            ← this ADR
4. none          — fail closed, exactly as today
```

**D1 — most-specific-wins, and the order is load-bearing.** A component's own binding beats its
placement's, which beats its service's. So adding this rung cannot change any resolution that
succeeds today: every existing answer is found at rung 1 or 2 and never reaches rung 3. The only
behaviour that changes is `none` → `via_service`, i.e. a target that is currently *blocked* may now
resolve. That is the whole point, and it is a strict widening.

**D2 — `ambiguous` does NOT fall through to the service.** Two placements bound for one Type is a
refusal, not an absence. Falling through would silently answer with the service's binding a question
the model says is unanswerable — reintroducing the cross-product bug ADR-0026 exists to kill, with
the refusal suppressed. Ambiguity stays terminal.

**D3 — the rung resolves from a PLACEMENT target too, via its component.** Stage-shaped compilation
makes wave targets placements, so a rung that only understood components would miss the case the
estate actually runs. A placement resolves its `componentId`, then that component's owning service.

**D4 — one service per component, and no deeper walk.** The owning service is the inbound `contains`
edge, guaranteed at most one by `contains`'s `one_to_many` plus migration 0022's partial unique index
— the same invariant `pipeline-resolution.ts` relies on. This ADR stops at the service. The
deployment-target and cluster rungs ADR-0007 also mentions are **not** included: each needs its own
precedence argument, and there is no demand for them.

**D5 — an indirect resolution is recorded on a Decision (charter principle 6).** `via_placement`
already writes one; `via_service` writes the same shape with `resolvedVia: "service"`. An operator
debugging a deploy must not have to infer that the binding came from somewhere other than the wave
target. Direct resolution stays undecorated — it is the overwhelmingly common path and a Decision per
trigger would double Decision volume, a live production concern on this instance
(see `scp-unbounded-decision-growth`).

## Consequences

- **A service-level infrastructure pipeline becomes real**, and the component pipeline view can show
  it without the "declared but never runs" caveat.
- **Strictly widening.** No currently-resolving target changes answer (D1). The new failure mode is
  the opposite of the old one: a service binding that an operator did *not* intend to apply to a
  component now applies to it. That is the ordinary cost of an inheritance rung, and D5's Decision is
  what makes it visible.
- **Cost:** one extra query, and only on the path that was about to resolve nothing and block.
- **Not covered:** deployment-target and cluster rungs (D4); resolution for `putExecutorBinding` and
  `setExecutorBindingType`, which keep the literal `getExecutorBinding` lookup because a fallback on
  a WRITE path would update the wrong row (the existing rule in `binding-resolution.ts`'s header).
