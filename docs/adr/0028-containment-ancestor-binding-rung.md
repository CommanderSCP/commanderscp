# ADR 0028 — from one service rung to a capped CONTAINMENT-ANCESTOR ladder

**Status:** Accepted (owner decisions, 2026-08-04 — `intermediate-grouping.md` D1/D2/D4). **Amends
[ADR-0027](0027-service-rung-binding-resolution.md)**, whose D4 stopped at the service and explicitly
excluded the org rung.

**Relates to:** [ADR-0027](0027-service-rung-binding-resolution.md) (the single service rung this
generalises), [ADR-0026](0026-placements-and-derived-stage-names.md) (the placement rung),
[ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (the fail-closed path),
[ADR-0007](0007-executor-binding-type-taxonomy.md) (Type as routing key),
`docs/proposals/intermediate-grouping.md` (D1 walk-up/nearest-wins, D2 cap 3, D4 attachment-point
scope), `apps/server/src/graph/containment.ts` (and why this does NOT use `containmentChain`).

## Context

Two owner decisions on 2026-08-04 make ADR-0027's single service rung insufficient:

**D4 — infra scope IS the attachment point.** *"A cluster could serve an org, service, component, or
somewhere in between. Meanwhile other infra (ex: S3 bucket) could be specific to a component. It
depends."* The resolution is that there is no correlation rule to write: where a binding hangs
declares what it serves. That only works if resolution can FIND a binding at whatever level it hangs
— including the **org**, which ADR-0027 D4 excluded.

**D1 — walk up, nearest wins**, and an optional intermediate level (`assembly`, D5) may sit between
service and component. A ladder with exactly one service rung cannot express either.

## Decision

Replace the single service rung with an ordered **containment-ancestor ladder**:

```
1. direct        — a binding on the target object itself
2. via_placement — the target is a component; EXACTLY ONE of its placements carries one
                   (two or more ⇒ `ambiguous`, refuse — ADR-0027 D2, unchanged)
3. via_ancestor  — walk `contains` PARENTS upward, nearest first, and take the first that
                   carries a binding of this Type. Capped at 3 hops (D2).
4. via_org       — the org root
5. none          — fail closed, exactly as today
```

**D1 — nearest wins, so this stays strictly widening.** Every resolution that succeeds today is found
at rung 1 or 2 and never reaches the ladder. As with ADR-0027, the only behaviour that moves is
`none` → resolved: a target that was *blocked* may now resolve.

**D2 — the ladder walks `contains` ONLY, and deliberately does NOT use `containmentChain`.**
`containmentChain` walks two axes per hop (the `contains` edge AND `domain_id`) and its own docblock
records that when a component's `domain_id` differs from its service's, the domain and the service are
each exactly one hop away and **TIE** — "no ordering of these two routes is obviously correct". It then
says, in as many words:

> It WOULD become a real precedence bug the moment any code compares depth across differently-named
> policies to pick a single "most specific" winner — if you are about to write that, fix this first.

A nearest-wins binding ladder is exactly that code. So this walk uses the single `contains` axis,
where "nearest" is unambiguous, and `containmentChain` is left untouched — the same reasoning
`pipeline-resolution.ts` gives for walking named rungs instead of reusing it. **A binding on a
containment `domain` therefore does NOT resolve.** That is a deliberate exclusion, not an oversight:
admitting the domain axis would import the tie.

**D3 — capped at 3 `contains` hops** (`intermediate-grouping.md` D2), so the walk's cost is provable
and a mis-declared cycle cannot spin. The cap is on hops, applied before the org rung, which is
reached directly rather than by walking.

**D4 — the ladder is TYPE-AGNOSTIC about the ancestor.** It does not care whether a parent is a
`service`, an `assembly`, or a type that does not exist yet; it asks only "does this ancestor carry a
binding of this Type?". This is what makes the rung correct whichever shape `assembly` takes — a
distinct object type or a role a nested service plays — and it is why this ADR can land before that is
settled.

**D5 — an indirect resolution is recorded on a Decision** (charter principle 6), carrying
`resolvedVia` and the object it resolved through, so an operator never has to infer that the binding
came from somewhere other than the wave target. ADR-0027 D5, extended to name the ancestor.

## Consequences

- **D4's "attachment point is the scope" becomes real.** A cluster binds at the org and serves
  everything; an S3 bucket binds at the component. Nothing is inferred.
- **The inheritance surprise is the cost**, and it grows with the ladder: a binding an operator meant
  for one level now applies to everything under it. D5's Decision is what keeps that visible, and it
  is the same trade every inheritance rung in this system already makes (policy, freeze, pipeline).
- **Cost:** at most 3 extra single-row queries plus one org lookup, and only on the path that was
  about to resolve nothing and block.
- **Not covered:** the `deployment-target` and `cluster` rungs ADR-0007 also mentioned. A
  deployment-target is not a containment ancestor of a component — it is the other axis of a placement
  — so it does not belong on this ladder and would need its own argument.
- **Write paths are unchanged.** `putExecutorBinding` and `setExecutorBindingType` keep the literal
  `getExecutorBinding` lookup; a fallback there would update the wrong row
  (`binding-resolution.ts`'s standing rule).
