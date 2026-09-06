# containment

Reference for `apps/server/src/graph/containment.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 15 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ROUTE 3 ALONE

ROUTE 3 ALONE — a placement's COMPONENT, exactly one row.

`coordination/service-board.ts` wants this and NOT the pair: it LEFT JOINs LATERAL to map a placement wave target back to the component whose column it fills, so a second row carrying a DEPLOYMENT-TARGET id would be a wrong-kind answer in a `component_id` column.

Measured, not assumed: swapping that call site to the pair fragment leaves its tests GREEN. The extra row really is produced — arm 1's `IN (componentIds)` filter then discards it (a deployment-target id is never in that list) and `DISTINCT ON (component_id)` collapses the rest. So the two fragments are kept distinct for the honest reason rather than the dramatic one: the board asks a narrower question, and answering it correctly should not depend on a downstream filter happening to throw the wrong row away. That accident holds only while `componentIds` contains components exclusively.

The pair fragment below is BUILT from this one, so the component route keeps a single definition and cannot drift across the three call sites.

## §2. Target -> ..

Target -> ... -> org root, with depth 0 = org root, increasing toward the target.

Walks FOUR routes up:

1. `objects.domain_id` — up to the org root (graph/objects-repo.ts defaults `domainId` to the org root object at creation time, so every chain terminates there and this walk never needs NULL special-casing beyond the root itself). 2. the `contains` edge from a component to its SERVICE (migration 0021). The edge is registered service -> component, so it is walked BACKWARDS (`r.to_id` = the child, `r.from_id` = its service). That asymmetry is a security property: a scope at a SERVICE reaches its components, but a scope at a COMPONENT never reaches its service or its sibling components. 3. the COMPONENT a `placement` places, and 4. the DEPLOYMENT-TARGET it places it at — both read from its properties (ADR-0026), see `placementParentsSql` above for why each route exists, what stopped working without route 3 and what route 4 newly blocks. Together they extend the chain to `org -> domain -> service -> component -> placement` AND `org -> ... -> target -> placement`, which is why a placement's chain is a DAG and `UNION` (not `UNION ALL`) matters below.

Until 0021 this walked domain_id only, so a service-scoped policy/freeze/role governed nothing — even though DESIGN §7 and §10 have always described the chain as `org -> domain -> service -> component`.

A DELETED ancestor is skipped by every route (`parent.deleted_at IS NULL`), while the TARGET itself is not filtered — governance may legitimately be evaluated over a deleted object, but a deleted object must not go on GOVERNING live ones.

That filter is load-bearing rather than defensive. `deleteObject` now tombstones the edges of the object it deletes, but that cascade cannot be complete: it refuses REPLICA edges (single-writer authority belongs to another domain) and it cannot retroactively fix rows already in a database. For those, this filter is the only thing standing between a deleted service and a policy or role binding scoped at it still reaching live components.

All four routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference exactly ONCE, so several recursive branches would error ("recursive reference ... more than once"). `UNION` (not `UNION ALL`) dedupes — with several routes the chain is a DAG, not a line.

DEPTH, and what it does and does NOT guarantee — read this before relying on it.

With several routes an ancestor can be reached at more than one walk depth. We keep the MAXIMUM per id (`DISTINCT ON (id) ... ORDER BY id, depth DESC`) — the longest path from the target, i.e. the least-specific reading — which the `maxDepth - depth` inversion below turns into "higher = more specific".

That reconciles the case where the SAME node is reachable by both routes (a component's own domain, reachable directly AND via its service's domain): the domain settles at the deeper walk depth, so it ranks BELOW the service. In the common shape — component and service sharing a domain — this does yield org < domain < service < component.

It does NOT, however, make a service strictly outrank a component's own domain in general. If a component's `domain_id` differs from its service's (C in domain Dx, S in domain Dy, S contains C — reachable via the organize-after-import flow), then Dx and S are each exactly ONE hop from C and TIE. They are structurally equidistant; max-depth cannot separate them, and no ordering of these two routes is obviously "correct" — a component genuinely sits in both. DO NOT write code that assumes a strict org < domain < service < component ordering across DIFFERENT kinds.

`nearestAncestorOfKind` is safe under that tie because it compares only ancestors of the SAME kind. The tie is otherwise INERT: `matchedAt.depth`'s only consumer is policy-model.ts, which groups by policy NAME and merges order-independently (max severity, union of effects), using depth solely to order a display-only `contributors` array. It WOULD become a real precedence bug the moment any code compares depth across differently-named policies to pick a single "most specific" winner — if you are about to write that, fix this first.

## §3. THE CONTAINER TYPES

THE CONTAINER TYPES — object types that may hold components (and each other, subject to the pairwise refusal below).

ONE constant, and every "is this a container?" question routes through it. The alternative — comparing `typeId === "service"` at each site — is how a level gets added to the model and applied at only some of the places that care, which is the failure mode this repo has been bitten by repeatedly (`bindings[0]`, the `currents` collapse, ADR-0027's rung at one of two exits). A single constant makes the census a definition rather than a search.

Note what this does NOT license: membership here says a type may CONTAIN, not that any pair is legal. `assembly -> assembly` is refused at write time (`relationships-repo.ts`), because `relationship_types` holds flat from/to arrays and cannot express a pairwise rule — see migration 0054's header.

## §4. THE DOWNWARD FRAGMENT

THE DOWNWARD FRAGMENT — "what does this row CONTAIN?", one `child_id` column, one definition

The exact INVERSE of the four routes `containmentChain` (and `authz/resolve.ts`'s `scopeExpandCte`) walk UP, and the single definition every downward consumer composes. The full list, recursive and single-level, is in this module's header — read it before adding a route.

```text
- `containmentSubtreeExceeds` — the depth doors: how tall is the subtree that travels
  with a moved row? (recursive)
- `authz/readable-scope.ts`'s `readableObjectFilterSql` — which objects does a role binding at
  this row REACH? (recursive; docs/proposals/role-model.md §8.2, increment 2.5b.)
- `governance/governance-reach.ts`'s `countContainmentDependents` and
  `graph/objects-repo.ts`'s container-delete guard — ONE LEVEL, "what does tombstoning this row
  detach?" (2026-08-26; the second composes `placementNamesObjectSql` alone, see the
  header).
```

It is exported for the reason routes 3 and 4 are exported upward, and the count is worth stating because it was UNDERCOUNTED when this fragment landed. `containmentSubtreeExceeds` was believed to be the third hand-typed copy; censusing the PROPERTY rather than the recursive shape found FIVE, two of them already drifted (`governance-reach.ts` counted `contains` EDGES rather than live children, and both one-level copies compared the placement pair as raw TEXT rather than as `uuid`). This module's header records what the FIRST two copies cost when they drifted — a service-scoped freeze failing OPEN and a service-scoped approval failing CLOSED, from one root cause. Every consumer now composes, so the next route added here reaches all of them.

ROUTE BY ROUTE — which downward arm inverts which upward route. (role-model.md §8.3's first hazard: the two directions MUST be exact inverses, or an object `authorize()` admits at its own id is missing from the list that should contain it, which reads as a cache bug rather than an authz bug.)

```text
arm 1 inverts ROUTE 1 (`objects.domain_id`, walked child -> parent) — rows whose `domain_id`
      IS this row. ANY type: `objects.domain_id` carries no type constraint, so a component or
      a placement can have `domain_id` children too, and this arm is not optional for any type.
arm 2 inverts ROUTE 2 (the `contains` edge, walked BACKWARDS up) — `contains` edges FROM this
      row, read FORWARDS (the edge is registered container -> member, so the child is `to_id`).
      The asymmetry route 2 rests on is preserved by construction: downward reaches a
      container's members and never a member's container, which is the same security property
      read the other way round.
arm 3 inverts ROUTES 3 + 4 TOGETHER (`placementParentsSql`'s pair) — live `placement`s NAMING
      this row as their `componentId` or their `deploymentTargetId`, read from the PROPERTIES
      exactly as the upward fragment reads them (ADR-0026 D17) and with the SAME `CASE` guard
      and the SAME `uuid` cast, so a malformed value matches nothing here just as it yields no
      parent there and the two directions agree on which values count. Delegated to
      `placementNamesObjectSql` so that the ONE-LEVEL consumers can compose the predicate
      without composing the whole fragment — this pair is the route that had already been
      hand-copied twice, and both copies had dropped the guard and the cast.
```

LIVENESS — and the ONE place the two directions do not agree, stated rather than discovered. Upward, every PARENT is joined `deleted_at IS NULL` while the seed row is raw (`authz/org-root-arm.ts` documents at length what that seed asymmetry costs). Downward, every CHILD is filtered `deleted_at IS NULL` and the seed is the caller's business — and BOTH callers filter their seed live. So along a path `root -> ... -> object`, both directions require every INTERMEDIATE node and the ROOT to be live; the only difference is the far endpoint, which upward never checks and downward always does. That difference is observable ONLY for a TOMBSTONED object, which no list door returns (`listObjects` filters `deleted_at IS NULL` unless `includeDeleted`) and which the depth doors do not count. It is pinned by a named case in `authz/readable-scope.integration.test.ts` rather than left as a comment.

NOT BOUNDED HERE. The bound belongs to the walk, because the two consumers count different things: the depth doors walk `budget + 1` levels (they only need "taller than the budget?"), while the read filter walks `CONTAINMENT_WALK_MAX_DEPTH` — the same bound `scopeExpandCte` uses, which is what makes the two directions exact inverses over the same path set.

ALIASES. The three arms use `child_o`, `r` and `pl` internally; `parentIdSql` is spliced in unqualified, so it must not be an expression that those names could capture (both callers pass a column of an OUTER recursive CTE — `d.id` — which nothing here shadows).

INDEX NOTE, so nobody "fixes" arm 3's `CASE` form for speed (it moved here with the fragment): migration 0051's pair index is on the TEXT expression `(properties ->> 'componentId')`, which the cast form cannot use; a text comparison could, but would be a STRICTER match than the upward walk (upper-case hex would be a parent going up and not a child coming down). The mirror is worth more than the index — the placement population is small (61 on the live estate, per this module's header) and both callers bound their walk.

## §5. THE DOWNWARD WALK

THE DOWNWARD WALK — "how deep is the subtree under this row?" — `containmentChildrenSql` (the exact inverse of the four routes `containmentChain` walks up) recursed, bounded, live rows only.

Exists for ONE caller, `assertContainmentDepthAdmits`: a MOVE takes the moved row's whole subtree with it, so the door has to know how far below the row the deepest live descendant sits. It used to carry its own hand-typed copy of the three arms, which is why the fragment above was exported rather than another one written for the read surface. (It was called "the third copy" here; a census by property later found five — see the fragment's own note.)

Every CHILD is filtered `deleted_at IS NULL` (as every PARENT is upward): a tombstoned descendant is on no walk and costs no depth. The seed is filtered live too — the callers pass a row they have just loaded live, and a deleted seed has no subtree worth counting.

BOUNDED at `budget + 1` levels and answers a yes/no question, on purpose: the caller only needs to know whether the subtree is TALLER than the budget it has left, and a row found at depth `budget + 1` proves that without walking the rest. The bound literal is `sql.raw` for the reason `authz/resolve.ts` gives at its own walk (an untyped `$n` against a recursive CTE's depth column).

`UNION` (not `UNION ALL`), and MEASURED rather than assumed, because the obvious justification is wrong: the recursive term's rows are `(id, depth)` PAIRS, so `UNION` can only collapse a row reached by two routes AT THE SAME DEPTH (two services both containing one component). A component reachable via its domain at depth 1 AND via its service at depth 2 is TWO rows under `UNION` just as it is under `UNION ALL` — measured on PostgreSQL 16, identical output for that shape, and its subtree walked twice either way. That case is handled by `MAX(depth)` keeping the LONGEST route per row, which is what the invariant counts; `UNION` is what stops the same-depth fan-in from multiplying. Neither is what terminates the walk — the `depth <` guard is, which is also why a self-parented legacy row (`domain_id` = own id) costs `probeDepth + 1` rows and no more.

`budget` is never negative here: the ONE caller, `assertContainmentDepthAdmits`, refuses `rowDepth > MAX` BEFORE computing `budget = MAX - rowDepth`, so a parent at the bound never reaches this walk (a "negative budget" branch used to sit here as a `return true` — dead by that ordering, and a verifier measured that inverting it left the whole suite green; a claim no test can hold to is not kept as behaviour).

## §6. THE MESSAGE STATES THIS BRANCH'S OWN CONDITION

THE MESSAGE STATES THIS BRANCH'S OWN CONDITION — the container is ALREADY past the bound (a legacy or imported row the doors never saw), so a row under it would be past the bound on that route and every walk that reads it refuses. It does NOT talk about cycles (this helper now serves the CREATE doors too, where the cycle question is deliberately not asked) and it does not claim the org root is missing (refusal 3's condition, not this one's) — an earlier wording did both, lifted verbatim from the move-only era.
