# ADR-0035: The shared containment depth bound is loud — walks refuse past it instead of truncating silently

**Status:** Accepted (owner instruction 2026-08-13: "please do both", after the measured escalation below)
**Relates to:** [ADR-0026](0026-placements-and-derived-stage-names.md) (the failure shape this prevents: 11 dormant `required` prod gates, a fail-open service-scoped freeze), the nested-domains decision ([outpost-ui.md §5(b)](../proposals/outpost-ui.md), owner 2026-08-13), M21 dependency subscriptions (second consumer of `containmentChain` via `governance/scan-requirements.ts`), charter principle 6 (explainability).

## Context — measured, not hypothesized

Six recursive walks shared a hardcoded `depth < 10` that **stopped expanding silently** (filterless census 2026-08-13, one instance initially hidden by a truncated grep — the census method lesson is recorded in project memory):

| Site | Walk |
|---|---|
| `graph/containment.ts` (`containmentChain`) | containment, 4 routes |
| `graph/named-queries.ts` (`groupByDomain`) | `domain_id` ancestry |
| `governance/policy-resolve.ts` (`isMemberOf`) | `member_of` groups |
| `authz/resolve.ts` ×3 (`scopeExpandCte` + two `member_of` expansions) | RBAC scope + subject |

Two live consequences, both reproduced through the public API once nested containment domains became first-class:

1. **The relabel.** `containmentChain` inverts depths so callers read "index 0 = org root". A chain cut by the bound presented the outermost *survivor* at index 0 — and because the org still arrived via the short service route at a *nonzero* depth, **nothing was missing; the order was wrong**. Org-scoped required policies and freezes silently stopped matching for exactly the most-nested components. Reachable with ~10 nested domains plus one component.
2. **The permission-shaped refusal.** The authz copy refused deep writes fail-closed — but with `subject … lacks 'object:write' at scope …`, naming neither depth nor bound. Operators debugging that message debug RBAC, not nesting. (The two copies' ceilings even differ by walk seeding, which no message admitted.)

## Decision

1. **One constant.** `CONTAINMENT_WALK_MAX_DEPTH = 10` (`graph/containment.ts`), imported by all six sites. Raising capacity is a one-line change there and only there; a raise editing any single site is the six-copies bug this ends.
2. **The probe.** Each walk recurses to `WALK_TRUNCATION_PROBE_DEPTH = MAX + 1`. A row landing at the probe depth proves the walk was *cut*, not complete — the one fact silent truncation destroyed.
3. **Refusal, with an asymmetry that matters.** A **positive** found within the bound is always valid (a reached binding, a proven membership) and is never disturbed. Only the **negative** can be fabricated by a cut walk, so only negatives convert: `containmentChain` and `groupByDomain` throw `walkDepthExceeded` (409, one shared message shape naming the bound and ADR); `isMemberOf` throws only on *no-match with a still-expanding frontier*; `hasPermission`/`hasRoleAtScope` probe **only after** computing a nothing-found refusal (the hot allow-path pays nothing) and convert it — every caller of those two inherits loudness, present and future. An explicit `deny` binding is a real reached binding and stays a plain false.
4. **Fail-closed stays fail-closed, but honest.** Deep writes still refuse; the refusal now says *"exceeds the supported containment depth (10 hops, ADR-0035) … a grant may exist beyond the bound"* instead of impersonating a missing role.

## Alternatives considered

- **Raise the bound** — orthogonal; a bigger number lies at a bigger depth. The constant makes a future raise trivial *after* this ADR makes the ceiling visible.
- **Return completeness as a fact for callers to check** — rejected: pushes the obligation to every present and future caller; the incomplete-census failure mode as an API.
- **Tolerate tombstoned/deep intermediates in the authz walk** — rejected; loosening a security walk to improve ergonomics inverts the priority.

## Consequences

- The at-bound integration test (`graph/nested-domains.integration.test.ts`) flipped **deliberately** from hazard-pin to contract-pin: deep creates refuse naming the depth; a chain that would truncate refuses instead of relabeling; a chain that fits still presents the org at index 0.
- Estates with shapes already past the bound will now see explicit 409s where they previously saw wrong-but-quiet governance. That is the point; the remedy is in the message (flatten the nesting, or bind nearer the scope).
- M21's enablement resolution inherits the loud behavior unchanged, via `containmentChain`.
- Sibling fix, same incident (`objects-repo.ts`): deleting a domain with live `domain_id` children is refused with the children named — a tombstoned route-1 parent made them permanently unadministrable (the authz walk's `deleted_at IS NULL` join dead-ends). Route-2 (`contains`) children keep their deliberate cascade semantics, pinned by a control test.
