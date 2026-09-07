# authz

Long-form reference for the **authz** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 76 of 76 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## See also

- [`docs/authz/role-binding-door.md`](authz/role-binding-door.md) — hand-authored; its section numbering is cited from source.

## Files

- [`apps/server/src/authz/identity-mapping-door.ts`](#apps-server-src-authz-identity-mapping-door-ts) — §1–§2
- [`apps/server/src/authz/inverse-walk-drift.integration.test.ts`](#apps-server-src-authz-inverse-walk-drift-integration-test-ts) — §3–§16
- [`apps/server/src/authz/list-door-scope.ts`](#apps-server-src-authz-list-door-scope-ts) — §17–§21
- [`apps/server/src/authz/list-scope.ts`](#apps-server-src-authz-list-scope-ts) — §22–§23
- [`apps/server/src/authz/member-of-closure.test.ts`](#apps-server-src-authz-member-of-closure-test-ts) — §24–§24
- [`apps/server/src/authz/org-root-arm.ts`](#apps-server-src-authz-org-root-arm-ts) — §25–§25
- [`apps/server/src/authz/permission-drift.integration.test.ts`](#apps-server-src-authz-permission-drift-integration-test-ts) — §26–§31
- [`apps/server/src/authz/quorum-name-collision.integration.test.ts`](#apps-server-src-authz-quorum-name-collision-integration-test-ts) — §32–§32
- [`apps/server/src/authz/rbac-across-assembly.integration.test.ts`](#apps-server-src-authz-rbac-across-assembly-integration-test-ts) — §33–§36
- [`apps/server/src/authz/readable-scope-filter.test.ts`](#apps-server-src-authz-readable-scope-filter-test-ts) — §37–§37
- [`apps/server/src/authz/readable-scope.integration.test.ts`](#apps-server-src-authz-readable-scope-integration-test-ts) — §38–§42
- [`apps/server/src/authz/readable-scope.ts`](#apps-server-src-authz-readable-scope-ts) — §43–§48
- [`apps/server/src/authz/resolve.integration.test.ts`](#apps-server-src-authz-resolve-integration-test-ts) — §49–§49
- [`apps/server/src/authz/resolve.ts`](#apps-server-src-authz-resolve-ts) — §50–§69
- [`apps/server/src/authz/role-binding-door.test.ts`](#apps-server-src-authz-role-binding-door-test-ts) — §70–§71
- [`apps/server/src/authz/roles-repo.ts`](#apps-server-src-authz-roles-repo-ts) — §72–§75
- [`apps/server/src/authz/service-scope.integration.test.ts`](#apps-server-src-authz-service-scope-integration-test-ts) — §76–§76

## `apps/server/src/authz/identity-mapping-door.ts`

### §1. THE IdP MAPPING DOOR

THE IdP MAPPING DOOR — where the `member_of` subset rule's bar went

`auth/identity-sync.ts` is exempt from the no-escalation subset rule on `member_of`, because a login-time sync has no human actor to test. Owner decision (2026-08-28): move the bar here, to the act that DOES have one — deciding that an IdP claim value means a particular SCP group.

THE RULE. To set or change `externalIdentity.claimValue` on a group, the actor must:

```text
1. hold `role_binding:write` AT THE ORG ROOT — mapping identity is an org-wide federation act,
   and there is no narrower object it belongs to; and
2. for EVERY role binding the group currently holds, hold every permission that role carries
   AT THAT BINDING'S SCOPE — i.e. be someone who could have written that binding themselves.
```

Rule 2 composes `missingPermissionsFor`, the SAME helper the grant door and the `member_of` choke point use, so there is one definition of "a subset" across all three.

WHY BOTH ENDS ARE BOUNDED, AND THE ORDER THAT MAKES IT WORK
There are two ways to arrive at "an IdP claim confers OrgAdmin", and both are gated:

```text
MAP FIRST, BIND SECOND — the group is empty of bindings when mapped, so rule 2 is vacuous and
the mapping is cheap. Binding OrgAdmin to it afterwards goes through `POST /role-bindings`,
which applies the full subset rule to the BINDER. So the authority still cannot exceed a human
who held it.
```

```text
BIND FIRST, MAP SECOND — the group already carries OrgAdmin, and rule 2 refuses anyone who does
not hold OrgAdmin. Without rule 2 this ordering would be the hole: a Viewer with
`role_binding:write` could point a claim they control at a group somebody else made powerful.
```

The reversed-ordering pair is exactly the shape `docs/authz/role-binding-door.md` §2a/§2b had to be fixed for twice, which is why it is enumerated here rather than assumed.

WHAT THIS DOES *NOT* CLOSE, NAMED RATHER THAN IMPLIED
Whoever administers the identity provider can put anyone into a mapped group and thereby grant whatever it carries, holding no SCP permission at all. No door here can change that: it is what federating identity means. What this door ensures is that a HUMAN WITH THE MATCHING AUTHORITY chose to delegate that decision to the directory, for that specific group.

Nor does it re-check anything afterwards. A mapping authored today survives the author's own revocation tomorrow — the same write-time-only property `docs/authz/role-binding-door.md` §8 records for bindings, and for the same reason: a read-time mirror would put ~20 permission probes on every authorization.

### §2. Is this write introducing or changing a mapping?

Is this write introducing or changing a mapping?

Compares the RESOLVED value on each side rather than the raw property, so that reformatting, key reordering, or setting an unrelated sibling property is not treated as a mapping change and does not demand authority the writer would not otherwise need. Removing a mapping IS a change — it silently stops the directory managing a group, which an operator should have standing to do.

## `apps/server/src/authz/inverse-walk-drift.integration.test.ts`

### §3. THE DRIFT DETECTOR

THE DRIFT DETECTOR — upward and downward must be EXACT INVERSES (role-model.md §8.3)

`authz/resolve.ts` walks containment UPWARD from one object and asks "is a binding on this chain?". `authz/readable-scope.ts` walks the SAME containment DOWNWARD from the subject's bindings and asks "which objects does this authority reach?". Every get-by-id door runs the first; since increment 2.5b every LIST door runs the second. §8.3 names the invariant that ties them together and that nothing else in the tree enforces:

for every subject S and every object O:   hasPermission(S, O)  ⟺  O ∈ readableSet(S)

**A route present upward but not downward is not a "narrower list".** It is an object that `GET /objects/{id}` hands over at its own id and that `GET /objects/{type}` omits from every page — which an operator debugs as a caching bug, a replication bug or a UI bug, because those are what "the API has it but the list does not" looks like from outside. The opposite drift (downward reaching further than upward) is a read leak on the same silent terms.

The two walks are hand-synced ACROSS FILES on routes 1 and 2 (`graph/containment.ts`'s header records that they already drifted once, taking a service-scoped freeze OPEN and a service-scoped approval CLOSED with them, from one root cause), and share ONE fragment for routes 3 and 4. So this file exists to make any future divergence fail loudly here, on its first run, rather than in production as a mystery.

HOW THIS DIFFERS FROM `authz/readable-scope.integration.test.ts`, WHICH ALSO ASSERTS THE PAIR
That file pins the invariant over a fixture that was DESIGNED for it — every rung named, every route deliberately placed. A designed fixture proves the routes someone thought of. This one is generated: a pseudo-random containment tree of mixed kinds, mixed parent routes and mixed depths, whose shape nobody chose, plus an INDEPENDENT test-side model of reachability (below) that agrees with neither production walk by construction. The three-way agreement is the point:

```text
1. SQL upward   (`hasPermission`)                — production
2. SQL downward (`readableObjectFilterFor`)      — production
3. a JS breadth-first walk over the rows as they are actually PERSISTED  — this file only
```

(1) vs (2) catches one walk changing. (3) catches BOTH changing together, which is precisely what "hand-synced across two files" invites — a route deleted from `scopeExpandCte` AND from `containmentChildrenSql` in the same edit leaves (1) and (2) in perfect agreement about an authority that silently shrank.

> ⚠️ Model (3) is a fourth expression of the four containment routes, and CLAUDE.md's standing > rule ("do not hand-write a fourth copy of the containment walk") is about PRODUCTION code, > where a copy is a thing that can drift unnoticed and be believed. Here it is the control: an > oracle that agrees with the code under test is worthless, so this one is deliberately written > from the persisted rows (three flat, non-recursive `SELECT`s) with the recursion in JS. It is > ~25 lines, it is in one place, and if a FIFTH route is ever added it must be added here too — > by design, because that edit is exactly the moment somebody should be made to prove the new > route was taught to both walks.

THE SHAPE IS RANDOM; THE RUN IS NOT
The tree is built from a seeded PRNG with a FIXED default seed, so CI is deterministic — a test whose fixture changes per run reports failures nobody can reproduce, and this one is a gate, not a fuzzer. Set `SCP_DRIFT_SEED` to re-shape it (a good thing to do while changing either walk); the seed is printed in every failure message so a red run is reproducible from its own output.

TWO STATES DELIBERATELY ABSENT FROM THE GENERATED TREE — the invariant is NOT universal
The invariant holds exactly on a LEGAL, LIVE estate. Two states diverge on purpose, both already characterised and pinned by name in `authz/readable-scope.integration.test.ts`, and both are kept OUT of this fixture because including them would make the object-by-object sample red for a reason that is not drift:

```text
1. A TOMBSTONED ROW reached by route 1. `scopeExpandCte`'s SEED is raw — no lookup, no liveness
   filter — so `hasPermission` walks up from a soft-deleted row to its live parent and answers
   TRUE at that row's own id, while every downward arm filters children live and omits it.
   Inert: no list door serves tombstones (they all filter `deleted_at IS NULL`), so there is no
   row the API hands over that a list hides. **Nothing here is ever deleted**, which is why
   this file's sample can assert plain equality.
2. AN ORG-ROOT ALLOW CARRYING A DENY BELOW IT. The filter short-circuits to `null` (the whole
   org), while `hasPermission` in ISOLATION at a denied object answers false. That is not a
   defect but the thing that keeps the DOORS in agreement: `authz/org-root-arm.ts` evaluates
   the org-root arm first and deliberately never consults a below-root deny, so get-by-id
   admits those objects too. No subject here holds that combination.
```

If either is ever "fixed", both halves have to move together — and this note is where to start.

MUTATION LOG — each applied ALONE to production code, measured 2026-08-26, then reverted
A drift detector that survives an arm being deleted is worthless, so every arm was deleted.

| Mutation | Measured result |
| `containmentChildrenSql`: delete ARM 1 (the `domain_id` inverse) | **6 fail.** The invariant reports **25** disagreements; the model case 3 rows; `route 1 (domain_id)`; the deny case (`expected false to be true` — the ALLOWED sibling vanished with it); `a malformed effect does not SUBTRACT either`; and the depth case (`the row exactly at the bound must be readable: expected false to be true`). | | `containmentChildrenSql`: delete ARM 2 (the `contains` inverse) | **4 fail.** The invariant reports **46** disagreements; the model case 8 rows; `route 2 … TWO HOPS` (`expected [ Array(1) ] to include '…'`); and pagination (`expected [] to deeply equal [ …(12) ]` — the service-bound principal's whole page is gone). | | `containmentChildrenSql`: delete ARM 3 (the placement pair, routes 3 + 4) | **4 fail.** The invariant reports **17**; the model case 8; `route 3 (placement -> component)`; `route 4 (placement -> deployment-target)`. | | `readableObjectFilterSql`: drop the deny descend and the `EXCEPT` | **3 fail.** The invariant reports **6**; the model case 1; the deny case names the row: `… is below the deny and must be absent from the list: expected true to be false`. Deny goes INERT on every list while still refusing at get-by-id — a deny that fails OPEN. | | `partitionReadableRoots`: `effect === "allow"` → `effect !== "deny"` | **3 fail.** The invariant reports **12**; the model case 2; the malformed case: `ALLOW: the list must be empty: expected [ …(6) ] to deeply equal []`. A binding that grants NOTHING at get-by-id would hand over a whole subtree on every list. | | `listObjects`: accept `readableFilter` and never push it into `conditions` (the "built, never installed" shape) | **1 fail — and exactly the right one.** Only the pagination case runs through the real HTTP door, and only it goes red: `expected [ …(27) ] to deeply equal [ …(12) ]`. | | `insertMalformedEffectRoleBinding`: skip its `INSERT` — the FIXTURE, not production code | **File failed, `15 skipped`** — the guard throws in `beforeAll` with `insertMalformedEffectRoleBinding did not land … Every assertion resting on this row would have passed VACUOUSLY.` (Note the reporting shape: a dead `beforeAll` here reads as SKIPPED, never as failed tests. A run summary of `15 skipped` is a red file, not a quiet one.) With that read-back guard ALSO removed: **0 fail, 15 passed** — `a malformed effect grants NOTHING` is satisfied by there being no binding at all. Since drizzle/0096 this fixture has to drop a CHECK to write its row, so it is now the piece that can silently no-op; the guard is what keeps this suite from measuring nothing. | | THE DISQUALIFIED DESIGN, simulated in this file: no filter in the query, `items` filtered in the handler | **1 fail, on the CONTRACT rather than on the row set** — `page 1 returned 0 of 5 rows but still carries a nextCursor — the filter was applied AFTER the LIMIT`. §8.2's measured production failure, reproduced at fixture scale. |

### §4. The downward walk, run the way a list door runs it

The DOWNWARD walk, run the way a list door runs it: the filter composed into a query over live rows, i.e. `o.id IN (…)` before any LIMIT.

`null` is returned AS `null`, never as a set. It means NO FILTER (the org-root short-circuit), which is the opposite of the empty set, and every caller here has to say which one it expects.

### §5. The containment graph read as three flat selects

MODEL (3) — the containment graph read straight out of the tables, as three FLAT selects, with no recursion anywhere in SQL. Parent -> children, over the same four routes the two production walks use, expressed once, here, and nowhere else in test code.

Route 1 `objects.domain_id`; route 2 the `contains` edge read forwards; routes 3+4 a live placement's `componentId` and `deploymentTargetId` PROPERTIES (the source of truth per ADR-0026 D17 — the `places`/`placed_at` edges are derived). Only LIVE children are recorded, matching both walks: upward the ancestor JOIN filters `deleted_at IS NULL`, downward every arm does.

### §6. Model (3)'s walk

Model (3)'s walk: breadth-first from `roots`, bounded by the SAME constant both production walks use — a node found at depth `CONTAINMENT_WALK_MAX_DEPTH` is included, and is not expanded. `Set` dedupes on FIRST arrival, so a DAG node (a component reachable via its domain at depth 1 and via its service at depth 2) is visited once, at its SHORTEST depth. The production `UNION`s do NOT do that — their recursive rows are `(id, depth)` pairs, so such a node is emitted twice and its subtree walked twice (measured, PostgreSQL 16). The two still agree on the only thing compared here, MEMBERSHIP, and they agree at the BOUND too: shortest depth is what decides whether a node is within `CONTAINMENT_WALK_MAX_DEPTH` hops, and a duplicate arrival deeper down can only be expanded to rows the shorter route already reached.

### §7. A role binding written with an ARBITRARY `effect`

A role binding written with an ARBITRARY `effect` — the one thing here not built through the API, because no door will ever write anything but 'allow'/'deny'.

Since drizzle/0096 the DATABASE refuses anything else too (`role_bindings_effect_check`), so a malformed value is routed to `insertMalformedEffectRoleBinding` — which builds the row THE ONLY WAY IT CAN STILL EXIST (a privileged path with the CHECK momentarily dropped, i.e. what a pre-0096 `pg_dump` restores or a DBA does) rather than pretending the shape went away. See that helper's doc for why the constraint does not retire these cases: it stops the row being written, not the row being READ, and the resolver's exact-string classification is the inner layer that keeps it harmless. Legal effects still take the ordinary path, unchanged.

### §8. The four routes, placed deliberately rather than generated

---- the four routes, placed deliberately ------------------------------------------------ A generated tree can omit a route by chance, and a drift detector that silently stopped covering route 4 is exactly the failure this file exists to catch elsewhere. So the four routes are ALSO built by hand, named, and asserted individually below; the generated tree is what surrounds them.

### §9. Delimiter is '|', deliberately NOT NUL

Delimiter is '|', deliberately NOT NUL. This is a throwaway dedupe key for the loop below: never split apart, never persisted, never crossing a boundary. A uuid contains only hex and hyphens, so '|' cannot collide any more than NUL can -- and a NUL here would add this file to scripts/nul-census.mjs's permanent set, after which every recursive census in the repo silently drops one more file. The NUL delimiters in plan-diff.ts and friends ARE correct and load-bearing; this one would buy nothing.

### §10. MODEL (3). Catches the drift the test above cannot

MODEL (3). Catches the drift the test above cannot: both production walks changed together. The oracle is built from the persisted rows by three flat selects and a JS breadth-first walk, so it shares no SQL, no fragment and no file with either walk under test.

### §11. ⚠️ MUTATION-PROVEN (header table)

⚠️ MUTATION-PROVEN (header table): removing the deny descend + `EXCEPT` from `readableObjectFilterSql` fails this test AND the invariant test — deny goes INERT on every list door while still refusing on get-by-id. A deny that fails OPEN.

### §12. A binding effect that is neither allow nor deny

4. §8.3 hazard: A `role_bindings.effect` THAT IS NEITHER 'allow' NOR 'deny'. `role_bindings_effect_check` (drizzle/0096) refuses one at the database now; these rows are built through `insertMalformedEffectRoleBinding`, which reproduces the only way one can still exist — pre-dating the constraint, in a restored dump. See `bindRaw` above.

### §13. `hasPermission` classifies in JS

`hasPermission` classifies in JS — `effects.includes('deny')`, then `effects.includes('allow')` — so ANY other string grants nothing and denies nothing. A filter written `effect <> 'deny'` mirrors that function while being strictly LOOSER than it: the same row that is refused at get-by-id would hand over a whole subtree on every list door.

⚠️ MUTATION-PROVEN (header table): `partitionReadableRoots`'s `effect === "allow"` relaxed to `effect !== "deny"` fails both cases here and the invariant test.

`''` is covered as well as `'ALLOW'` deliberately: `<> 'deny'` and `= 'allow'` differ on EVERY other string, and the empty string is the one a bad migration default or a truncated write produces, where `'ALLOW'` is the one a human types.

### §14. §8.2 rejected per-row post-filtering on PAGINATION, not on cost

§8.2 rejected per-row post-filtering on PAGINATION, not on cost: every list repo is keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from the last UNFILTERED row, so a filter applied to the returned page is applied AFTER the LIMIT. Measured on a 20,910-object estate: an assembly-bound principal's 5 readable components at cursor ranks 97/140/254/339/440 of 18,500 give ONE row on page 1 and ZERO on pages 6 through 185, each carrying a valid `nextCursor`, while 27 of 30 `apps/web` list call sites fetch exactly one page.

"The subject sees only their subtree" does NOT catch that — it passes on one small page. These are the assertions that separate a query-side filter from a post-filter:

```text
- a page that carries a `nextCursor` is FULL;
- no page is empty while promising more;
- the walk terminates, and returns each readable row exactly once.
```

12 readable components interleaved 2:1 with 6 unreadable ones at `limit=5` — so no page is homogeneous, and the last page is deliberately SHORT (2 rows) with a null cursor.

### §15. Depth beyond the bound is loud upward, and what that pins

WHAT WAS DECIDED, AND WHAT THIS PINS
ADR-0037 converts an untrustworthy UPWARD refusal at depth > `CONTAINMENT_WALK_MAX_DEPTH` into a loud `walkDepthExceeded` (409). Downward there is no such conversion and — per `authz/readable-scope.ts`'s decision block — deliberately none: a row past the bound is simply absent from the list. §8.3 warns that the two walks disagreeing SILENTLY is the failure mode, so the decision is pinned here rather than left as prose.

WHAT THE TWO DIRECTIONS ACTUALLY DO, measured below:

```text
- MEMBERSHIP AGREES. Both walks are bounded by the same constant with the same `depth <`
  shape, so `descend(root)` and `scopeExpand(object)` truncate at exactly the same hop count:
  a row 10 hops below its binding is readable BOTH ways, and a row 11 hops below is refused
  BOTH ways. There is no row the list hides that get-by-id would have handed over.
- ONLY LOUDNESS DIFFERS. At 11 hops the upward door answers **409**, not 200 and not 403,
  because the refusal cannot be trusted; the list simply omits the row.
- THE ORG-ROOT PRINCIPAL — the one who can actually repair such a row — short-circuits to
  `null` and still sees it, exactly as today.
```

WHY THIS ORG IS BUILT PARTLY BY HAND, AND WHY IT IS A SEPARATE ORG
A live row past the bound CANNOT be created through the API: `assertContainmentDepthAdmits` refuses it at all three write doors, on create AND on move (`containment-depth-doors. integration.test.ts` is that door's own gate). It exists in exactly two ways — a federation import, which is carved out because the receiver does not referee a peer-authored containment, and legacy rows predating ADR-0037. So the last two links are planted with a direct `UPDATE`, the same "no API can write this, which is the hazard" exception the malformed-`effect` bindings take.

It gets its OWN ORG because a past-the-bound row makes `hasPermission` THROW for every subject at that row — it is a property of the row's chain, not of the caller — which would take the object-by-object invariant test above with it.

### §16. `?scopeObjectId=` RE-SEEDS THE BOUND

`?scopeObjectId=` RE-SEEDS THE BOUND — the one case where the hint is NOT a subset
`authz/list-door-scope.ts` documents the hint as "a narrowing of your own results, never a widening", justified by "every row below the hint is below your allow root too". That holds for membership and FAILS for the BOUND, because both descends are bounded `CONTAINMENT_WALK_MAX_DEPTH` FROM THEIR OWN SEED: a hint `k` hops below the allow root pushes the horizon `k` hops deeper.

This is the truncation case the three tests above do not reach — they all measure the UNHINTED filter. Measured here instead of argued: the binding is at hop 1, the hint at hop 3, and the hop-12 row that "must be absent from the list" two tests up comes BACK when the hint is supplied, because it is 9 hops below the hint and 11 below the binding.

TOLERATED, NOT FIXED — the same trade `readable-scope.ts`'s decision block already takes: unreachable on a legally-built estate (every write door keeps live rows within the bound of the org root), and where it does fire the extra rows are inside the caller's OWN allow subtree and answer 409 rather than 200 at get-by-id. Pinned so that changing it later — by intersecting the two descends, say — is a red test and a deliberate act.

## `apps/server/src/authz/list-door-scope.ts`

### §17. THE LIST DOOR'S GATE

THE LIST DOOR'S GATE — "may you list at all, and which rows?" — in ONE place

`authz/readable-scope.ts` builds the row FILTER (the containment walk run downward from a subject's bindings, composed into the repo query so it applies before the `LIMIT`). It does not decide whether the door opens. This module is the other half: the check a LIST handler runs where it used to run `authorize({ scopeObjectId: auth.orgId })`, plus the optional `?scopeObjectId=` narrowing, in the ONE order that is safe.

It exists as a module rather than as a paragraph in each route because the tree has a list door per family — `/campaigns`, `/placements`, `/changes`, `/components`, `/objects/{type}`, every typed registry, `/relationships`, `/change-sources/{kind}/mappings`, and `/objects/service`, whose check lives one directory away in `services/objects-service.ts` where a `routes/*.ts` census cannot see it (§8.1) — and the four things this does are only correct in one sequence. One idea hand-copied per call site is what `graph/containment.ts`'s header records costing a service-scoped freeze that failed OPEN and a service-scoped approval that failed CLOSED.

WHAT REPLACED WHAT, AND WHY THAT IS STILL A PURE WIDENING
Before: `authorize({ permission, scopeObjectId: auth.orgId })`, then every row in the org. After: the SAME check, first and unchanged, as the WIDE arm — and when it passes, the filter is `null` and the repo query is today's, verbatim (`readableObjectFilterSql`'s org-root short-circuit). Only when the wide arm REFUSES does anything new happen: instead of a 403, the subject's own allow roots are resolved, and the door opens onto exactly their subtrees.

So: everything that worked before works identically, and a subject with **no allow binding anywhere** still gets today's 403 — thrown by re-running today's check, so its wording cannot drift from `authorize()`'s. That is role-model.md §8.2 step 5's invariant, and it is what makes the change safe to ship without the behavioural tests §8.5 measured as absent.

> ⚠️ §8.2 step 5 says "keep the org-root `authorize()` **unchanged**", and read as "leave the > `authorize()` CALL exactly where it is and change nothing else" that is measurably inert: > `scope_expand` from the org root is the org root alone, so the only subject that clears it is > one holding an org-root allow — and that is precisely the subject for whom > `readableObjectFilterSql` returns `null`. The filter could then never apply to anybody. What is > kept unchanged here is the org-root ARM: the same check, same permission, same scope, run > FIRST, with the same 403 on the path where nothing else grants. §8.2's own step-5 sentence > ("a subject with no allow binding **anywhere** still gets today's 403") is the one that pins > the intent, and it is the one implemented.

THE ORDER, WHICH IS THE WHOLE POINT OF THE `resolveScopeObject` CALLBACK
```text
1. GATE — the permission at the org root, or an allow binding SOMEWHERE for it. Refuse here if
   neither, with the same 403 as before, and refuse *whether or not* a hint was supplied.
2. ONLY THEN resolve `?scopeObjectId=` — an id naming nothing is a 404, and resolving it before
   step 1 would make "does this id exist?" answerable by a caller who holds nothing at all: 403
   for a real id, 404 for a ghost. That is the pre-authorization existence oracle
   `routes/campaigns.ts`'s `resolveCampaignForScope` was written to close, and the first draft
   of this module reintroduced it exactly — the hint path authorized at the hint and never
   consulted the subject's own roots, so the gate effectively ran second. `no
   pre-authorization existence oracle` is the case that caught it.
3. AUTHORIZE at the RESOLVED id. Scoping at the raw query parameter instead would turn every
   404 on this route into a 403 for everybody, org-root Owner included, because
   `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence (§8.7's trap).
4. Seed the descend from the hint.
```

The caller supplies the resolver instead of this module importing one, so the ordering lives here (where it cannot be got wrong per route) while `authz/` keeps no dependency on `graph/`.

THE HINT IS A NARROWING OF *YOUR OWN* RESULTS, NEVER A WIDENING — WITH ONE MEASURED EXCEPTION
`descend(hint)` is a subset of what the caller could already read:

```text
- admitted by the WIDE arm — the caller reads the whole org, so any subtree of it is a subset.
  Unconditional: the unhinted answer is `null`, i.e. every row;
- admitted by the NARROW arm — `hasPermission(hint)` was true, so some allow root of theirs is
  an ancestor-or-self of the hint and no deny sits on the hint's own chain. Every row below the
  hint is therefore below that allow root too, minus the denies subtracted below.
```

> ⚠️ THE NARROW-ARM BULLET IS FALSE PAST THE WALK BOUND, and it is the one truncation case the > three past-the-bound tests did not cover. Both descends are bounded at > `CONTAINMENT_WALK_MAX_DEPTH` FROM THEIR OWN SEED. Re-seeding at a hint `k` hops below the allow > root therefore moves the horizon `k` hops DEEPER: a row at `bound + 1 .. bound + k` hops below > the allow root is absent from the unhinted answer and PRESENT in the hinted one. So the hint can > add rows — never rows outside the subtree the caller's own binding reaches (the hint is itself > under that binding, so the descend can only go down from it), only rows FURTHER DOWN it than > the unhinted walk sees. > > It cannot fire on a legally-built estate — the three write doors keep every live row within the > bound of the org root (`assertContainmentDepthAdmits`), so nothing sits more than `bound - 1` > hops below a non-root allow root. Where it CAN fire (federation-import carve-out, legacy rows) > the rows it adds are rows whose get-by-id answers **409**, not 200 — they are ungovernable in > both directions and belong to the caller's own subtree — which is the same trade > `readable-scope.ts`'s decision block already takes for downward truncation: a per-ROW fault is > not converted into a whole-PAGE refusal. Tolerated deliberately, and pinned rather than left as > prose: `authz/inverse-walk-drift.integration.test.ts`'s "a hint re-seeds the bound" case builds > the illegal estate and asserts the extra row, so narrowing this later is a red test rather than > a silent change.

WHICH DENY ROOTS SUBTRACT, AND WHY IT DEPENDS ON THE ARM THAT ADMITTED
`authz/org-root-arm.ts` states the doctrine this must not break: the org-root arm is evaluated first and "a deny bound below the org root, which the org-root pin never consulted, [...] this increment therefore must not start honouring". A get-by-id door admits an org-root holder at every object regardless of a deny lower down. So when the WIDE arm admitted, the hinted filter subtracts NOTHING — otherwise a hinted list would hide rows the get-by-id door hands over, which is exactly the §8.3 disagreement this increment exists to prevent.

When the NARROW arm admitted, the subject's deny roots DO subtract, because those are the denies `hasPermission` itself honours for that subject.

(This is why the hint path does not simply call `checkAtOrgRootOrScopes`: its `import("./org-root-arm.js").OrgRootOrScopedVerdict` deliberately reports only ok/not-ok and the single refused scope, never WHICH arm admitted, and the deny set depends on that. The wide arm is still evaluated first, with the same call, for the same reason. If that verdict ever grows an arm discriminator, collapse this into it.)

### §18. Resolves the scope ref to an id, 404 when it names nothing

Resolves `scopeObjectRef` to an object id, throwing 404 when it names nothing in this org. Called ONLY after the gate has admitted the caller — see the order above. Unused when `scopeObjectRef` is `undefined`.

### §19. The row filter a list repo should apply

The row filter a list repo should apply — or `null` for "no filter, run today's query verbatim".

Throws 403 when the subject may not list at all, and 404 when `?scopeObjectId=` names nothing.

⚠️ `null` AND an empty set are opposites. `null` means NO CONDITION; the filter that matches nothing is a real `SQL` value. Callers must write `if (filter) conditions.push(...)` and must never map `null` onto an empty id list — that would empty every org admin's lists.

### §20. Org root allowed yet refused can only mean a deny outranked

The allow roots contained the ORG ROOT and yet the wide arm above refused — which can only mean a deny binding at the org root outranked it (`scope_expand` from the org root is the org root alone, so there is nowhere else that verdict could come from). `null` means NO FILTER, so returning it would hand the entire org to the one subject the org root explicitly denies. A deny at the root reaches everything under it: refuse.

### §21. Today's 403, re-run so its wording can never drift

Today's 403, produced by re-running today's check so its wording can never drift from `authorize()`'s. `hasPermission` already answered false for this exact triple, in this transaction, so `authorize` always throws; the line after it exists only because TypeScript cannot know that, and it is a bug report rather than a fallback.

## `apps/server/src/authz/list-scope.ts`

### §22. THE `listObjects` LIST DOORS' ADAPTER onto the one list-door gate

THE `listObjects` LIST DOORS' ADAPTER onto the one list-door gate — NOT a second gate

`authz/list-door-scope.ts`'s `readableScopeForListDoor` is THE definition of a list door's gate: the org-root arm first and unchanged, then the subject's own allow roots, then today's 403 if neither grants, plus the optional `?scopeObjectId=` narrowing. This file contains NO authorization logic of its own and must not grow any — `graph/containment.ts`'s header records what two hand-synced copies of a walk cost this codebase (a service-scoped freeze failing OPEN and a service-scoped approval failing CLOSED, from one root cause), and a second copy of the GATE would be that mistake one layer up. An earlier draft of this module WAS that second copy: it and `list-door-scope.ts` were written in parallel by two agents in the same worktree, independently reaching the same two-arm design and the same org-root-deny fix. It was deleted in favour of this adapter as soon as that was found.

What this adds is one thing only: the shape the four `listObjects` callers need.

WHY AN ADAPTER EXISTS AT ALL — the hint parameter these four doors do not have
`readableScopeForListDoor` takes `scopeObjectRef` (the raw `?scopeObjectId=` value) and a `resolveScopeObject` callback to turn it into an id. That callback is REQUIRED by its interface and is documented there as "unused when `scopeObjectRef` is `undefined`".

`?scopeObjectId=` exists today on `PlacementListQuerySchema` and `CampaignListQuerySchema` — the two schemas increment 2.5b gave the hint to. `ObjectListQuerySchema` — the querystring of all four doors here (`/objects/{type}`, `/components`, `/objects/service`, and every typed registry) — does NOT carry it, so `scopeObjectRef` is ALWAYS `undefined` on this path and the resolver can never be called. Rather than hand-write that dead callback at four call sites, where four copies of an unreachable `throw` would be four things to get wrong and four places for someone to later wire a resolver that is never consulted, it is written ONCE, here, as a refusal.

(That list is a fact about the schemas and goes stale the moment a fifth door takes the hint. The load-bearing half is `ObjectListQuerySchema`, and it is checked rather than trusted: the resolver below THROWS, so wiring the hint into these four doors without also writing a real resolver is a loud 500 on the first request that uses it, not a silently ignored parameter.)

WHY IT TAKES A `PermissionCheck` AND NOT THE GATE'S OWN INPUT SHAPE
Each door builds ONE `PermissionCheck` literal and uses it for nothing else — it is what the gate's wide arm runs. Keeping the `permission` and the org-root `scopeObjectId` in a single literal at the door is deliberate on two counts:

```text
- the permission the door authorizes with and the permission its row filter is computed from
  are then the SAME expression, not two that must be edited together. The typed-registry
  factory's per-resource `readPermission` makes that a live concern, not a hypothetical one;
- `routes/org-root-scope-census.test.ts` anchors on a `scopeObjectId` ASSIGNMENT and resolves
  the permission out of the enclosing object literal. Keeping the literal in the route keeps
  each of these four doors individually listed and individually justified in that census
  instead of collapsing them into the shared entry — including
  `services/objects-service.ts`'s, the one a `routes/*.ts` census cannot see at all (§8.1).
```

The `scopeObjectId` on that literal MUST be the org root, and this refuses otherwise rather than trusting it, because the failure would be silent: the gate's `null` return means "no filter, list the whole org", and that is only a sound conclusion when the arm which licensed it was checked at the org root.

### §23. Unreachable by construction

Unreachable by construction: `scopeObjectRef` is `undefined` immediately above, and `readableScopeForListDoor` consults this only after finding a defined one. A bug report, not a fallback — and if these four doors ever DO accept `?scopeObjectId=`, this must become a real resolver that 404s an id naming nothing, never a raw pass-through: authorizing at an unresolved uuid turns every 404 on the route into a 403 for everybody, org-root Owner included (role-model.md §8.7).

## `apps/server/src/authz/member-of-closure.test.ts`

### §24. THE TWO `member_of` CLOSURES

THE TWO `member_of` CLOSURES — same edges, same bound, opposite directions

`resolve.integration.test.ts`, `inverse-walk-drift.integration.test.ts` and `rbac-role-binding-door.integration.test.ts` run these walks against real PostgreSQL and settle what they RETURN. No fake database appears here. What this file pins is the property that is decided before any row exists — the SHAPE of the emitted CTE — because that is the property this pair has already drifted on.

`subjectExpandCte`'s own docblock: it was "about to be hand-typed for the FIFTH time", and it NAMES two copies it did not convert (`authz/readable-scope.ts`, `governance/policy-resolve.ts`). CLAUDE.md's rule is that a well-written comment naming a hazard is a signal to sweep, not evidence it was handled. A drifted copy does not error: it returns a set that is a little wrong, and the symptom is rows quietly missing from a list or a binding quietly reaching one principal too many. The four facts asserted below are the four ways that drift shows up:

```text
1. the EDGE PREDICATE — `member_of` only, live edges only. Dropping `deleted_at IS NULL` makes a
   removed membership keep granting; widening `type_id` makes `contains` grant.
2. the DIRECTION — `subject_expand` walks a principal UP to its groups, `member_expand` walks a
   group DOWN to its principals. Seeding the up-walk at a group (the plausible mistake the
   docblock warns about) answers a different question with no error.
3. the BOUND — ADR-0037's shared depth, with the truncation probe's one-past-the-bound as the
   only override any caller makes.
4. the SEED and the org id are BOUND PARAMETERS, never concatenated. Both come from
   `role_bindings` columns that carry no type constraint.
```

The SQL is rendered with drizzle's own `PgDialect` — the serializer the driver uses.

## `apps/server/src/authz/org-root-arm.ts`

### §25. THE ORG-ROOT ARM

THE ORG-ROOT ARM — the one definition of "at the org root **OR** at the object this door governs"

Increment 2.5a (docs/proposals/role-model.md §8.7) re-scopes get-by-id doors off `scopeObjectId: auth.orgId` and onto the object each one actually governs, because `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD only: a check pinned at the org root is satisfiable by an ORG-ROOT binding and by nothing else, so a ServiceAdmin or ComponentAdmin could hold `object:read` and still be refused the thing they administer.

THAT RE-SCOPE MUST BE A PURE WIDENING — every request that succeeded against the org-root pin must still succeed, identically. Checking at the governed object ALONE is not that, and this helper exists because working out why takes a paragraph that must not be re-derived per door.

WHY THE SCOPED ARM IS NOT ENOUGH: `scopeExpandCte` IS LIVENESS-BLIND ONLY ON ITS SEED
```text
- the seed row is raw — `SELECT ${scopeObjectId}::uuid AS scope_id, 0 AS depth`, no lookup and
  no filter — so a SOFT-DELETED object does still seed the walk;
- but every ANCESTOR is joined `JOIN objects parent_o ON … AND parent_o.deleted_at IS NULL`
  (`resolve.ts`), so the chain is CUT at the first tombstoned ancestor. `scope_expand` then
  collapses to the seed alone, which matches NO binding at all — the org-root Owner's included.
```

That state is reachable through ordinary API calls, not hypothetical. `deleteObject`'s orphan guard counts children with `isNull(objects.deletedAt)` (`graph/objects-repo.ts`), so a service whose components are already soft-deleted has no LIVE children and is itself deletable, and then so is its domain. Three ordinary DELETEs later, any door that scopes at one of those tombstoned ids refuses everybody. Two in-tree paths reach exactly that:

```text
- a change's `properties.targets` are read back VERBATIM and deliberately never re-resolved
  (re-resolving would 404 "cancel the release against the component we just removed"), so a
  target may be a tombstone whose parents have since gone too;
- a component merge (M12 P5d, `docs/proposals/organize-after.md` §2.4/§4) soft-deletes the
  loser and deliberately does NOT re-point its `source_mappings`, stranding rows whose
  component the `DELETE /change-sources/{kind}/mappings` door exists to clean up.
```

WHY THE ORG-ROOT ARM IS TRIED FIRST
The org-root arm IS the pre-2.5a behaviour, so evaluating it first makes "everything that worked before still works" independent of anything the scoped object's chain does — including a `deny` bound below the org root, which the org-root pin never consulted and which this increment therefore must not start honouring (a narrowing nobody decided).

It matters beyond tidiness, because `hasPermission` does not always return: ADR-0037's truncation probe THROWS `walkDepthExceeded` on a refusal it cannot trust, and an arm that throws cannot be fallen through from. The SCOPE side of that probe can never fire on the org-root arm — expanding from the org root produces a single depth-0 row.

THE SUBJECT SIDE IS A DIFFERENT STORY, AND ORDER IS NOT NEUTRAL THERE. `assertDenyNotTruncated` re-walks the subject's `member_of` chain too, so a subject nested more than `WALK_TRUNCATION_PROBE_DEPTH` groups deep makes WHICHEVER ARM RUNS FIRST throw — pre-empting the other arm, which might have granted. The disjunction is therefore not order-independent; what ordering the org-root arm first buys is that the throw happens on exactly the check the door already ran before 2.5a, so the outcome for a deep subject is byte-identical to today's rather than merely similar.

WHY IT RETURNS A VERDICT INSTEAD OF THROWING
`hasPermission` rather than `authorize` on every arm, for the fall-through reason above, and the 403 is the CALLER'S to throw: each door names its own object ("at the org root and at source-mapping component X", "at any target of change Y") and a message assembled here would have to be generic on exactly the noun an operator needs. `OrgRootOrScopedVerdict` carries back the one fact a caller cannot recompute — which scope failed an `"every"` arm — so a write door's refusal can still name the single target the actor lacks standing on.

WHAT THIS IS NOT FOR
A bar that was ADDED beside an org-root check rather than replacing one (the two `routes/federation.ts` overlay doors) is a CONJUNCTION, not a disjunction: giving it an org-root arm would make it inert, because everything reaching it has already cleared an org-root check. Composing this helper there would silently delete a bar. See the block above those two doors.

AND THE PURE-WIDENING INVARIANT ABOVE DOES NOT REACH THOSE DOORS EITHER, which is the reason the paragraph above is a refusal rather than a TODO. This helper's invariant is written for a RE-SCOPE — a check that moved off the org root and must still admit everyone it used to. Adding a second bar is the opposite act, a deliberate narrowing, and by construction it refuses some of the principals the single bar admitted; that is what a bar is. Measuring a tightening against a widening invariant is a category error, and it produced one on this branch before it was named. The consequence the overlay doors accept in exchange (a base with tombstoned ancestors is unreachable to everyone until its chain is repaired) is stated at those doors and pinned by `routes/federation-overlay-base-authority.integration.test.ts`.

## `apps/server/src/authz/permission-drift.integration.test.ts`

### §26. THE PERMISSION DRIFT GATE

THE PERMISSION DRIFT GATE — role-model.md §5 step 4

THREE POPULATIONS THAT MUST AGREE, and until this file existed nothing compared any two of them:

```text
1. **What the code DEFINES** — `authz/resolve.ts`'s `PERMISSIONS`.
2. **What the database GRANTS** — the `permissions` array on every built-in (`org_id IS NULL`)
   role, as the migrations actually left it.
3. **What the code DEMANDS** — the permission literals appearing at call sites.
```

THE FAILURE THIS EXISTS TO CATCH IS NOT HYPOTHETICAL. `org:admin` was defined in (1), granted to Owner by drizzle/0002 in (2), and demanded at ZERO call sites in (3) — for its entire life. It advertised authority in a roles listing and gated nothing. It was found because a human ran a census by hand in 2026-08, which is not a control. Every population was internally consistent; the defect was only ever visible BETWEEN them.

WHY THIS IS AN INTEGRATION TEST, AND WHY THE SEEDED HALF IS READ FROM A DATABASE
The obvious cheap version greps the migration SQL for permission literals. It was written, run, and is wrong — measured on this repo, that census returns `org:admin` (a string drizzle/0099 REMOVES, so grepping the text reports the opposite of the truth), plus `scp:managed-by` and `scp:stack`, which are governance LABEL KEYS and not permissions at all. Migrations are a sequence of edits, and the only thing that knows their composition is a database that has run them. So this test runs them and reads `roles`.

WHY THE CALL-SITE CENSUS READS BYTES INSTEAD OF SHELLING OUT TO grep
CLAUDE.md's standing hazard: some tracked source files contain literal NUL bytes (NUL is a composite-key delimiter here and is correct), every search tool classifies those files as binary, and a recursive search DROPS them with no output and exit 0/1 — indistinguishable from "no such code exists". A census whose blind spot is invisible is worse than no census. `readFileSync` has no such notion: it returns the bytes. This walk is also FILTERLESS by construction — it descends every directory under `src/` and reads every `.ts` file, because a filter is exactly where the next instance hides.

### §27. A permission defined but granted to no built-in role

A permission this system DEFINES but deliberately grants to NO built-in role.

Empty today, and that is the finding rather than an oversight: every one of the 22 permissions is carried by at least one built-in. An entry here must say why the permission exists ungranted — the honest case is one reserved for custom roles (role-model.md §5 step 10), which do not exist.

### §28. A permission granted but demanded at no call site

A permission this system DEFINES and GRANTS but demands at no call site.

Empty today, deliberately and load-bearingly: `org:admin` is the only string that was ever in this state, and drizzle/0099 removed it rather than documenting it. An entry here is a claim that a permission which appears in `GET /roles` — advertising authority to every operator who reads it — gates nothing, and that claim should be hard to make quietly.

### §29. THE WIDENING REGISTRY

THE WIDENING REGISTRY — role-model.md §4.4's assertion, which is not about drift at all

A built-in role row is a SHARED SINGLETON: `org_id IS NULL`, read by every org on the deployment through the `roles` RLS `USING (org_id = current_org OR org_id IS NULL)` clause. So `array_append`ing a permission to one does not widen a role — it widens EVERY EXISTING BINDING OF THAT ROLE, in every org, at once, with no per-org opt-out and no re-check.

`docs/authz/role-binding-door.md` §8 records why that cannot be fixed at the write door: the subset rule is a WRITE-time test with no read-time mirror, so a binding written legitimately today confers whatever its role gains tomorrow. Re-testing at resolve time would put ~20 permission probes on the hot path of every authorization AND make a subject's authority depend on the current authority of whoever granted it years ago. Refusing the migration is worse: appending to a shared singleton is how every permission this system has ever added arrived.

So the control is not a refusal, it is a DECLARATION: a migration that changes a built-in's permission array must state, here, which role it changes and what the blast radius is. This registry and the migrations are compared IN BOTH DIRECTIONS below.

⚠️ THE DECLARATIONS LIVE HERE RATHER THAN AS COMMENTS IN THE .sql FILES, and that is forced: `drizzle-orm`'s migrator sha256s each migration's text into `__drizzle_migrations`, so editing an applied file to add a comment changes a recorded hash. Entries below for migrations 0010 through 0094 are BACKFILLED — they document history that predates the rule, and they were read off the migrations rather than remembered.

### §30. Parse every role-array mutation, deliberately over-broad

Parse every statement that mutates a built-in role's `permissions` array out of the migration SQL.

DELIBERATELY OVER-BROAD ON THE PATTERN. It matches `array_append`, `array_remove` and `array_cat` on a column named `permissions`, anywhere in the file, including inside a comment. A false positive costs one registry entry; a false negative is a silent widening, which is the entire thing being guarded. Wholesale replacement (`SET permissions = ARRAY[...]`) is matched too — there are none today, and there being none is asserted rather than assumed.

### §31. A whole-array assignment would slip past the parser above

`SET permissions = ARRAY[...]` would silently rewrite a shared singleton's whole grant, and the append/remove parser above would not see it. There are none; if one ever lands, this fails and the parser needs to grow rather than the assertion being relaxed. CAPTURE THE TOKEN, DO NOT LOOK AHEAD PAST `\s*`. The first version of this used `SET\s+permissions\s*=\s*(?!array_)` and fired on every legitimate `array_append` in the tree — because `\s*` backtracks to match FEWER spaces, putting the lookahead at a position where the next characters are whitespace rather than `array_`, which duly is not `array_`. A negative lookahead behind a variable-width match asserts nothing. Reading the token and comparing it cannot express that bug.

## `apps/server/src/authz/quorum-name-collision.integration.test.ts`

### §32. THE QUORUM BYPASS

THE QUORUM BYPASS — role-model.md §5 step 10's gate (owner decision, 2026-08-27)

`hasRoleAtScope` resolves approval-quorum eligibility by NAME. It joined `roles` and matched `rl.name` with NO `org_id` predicate on the roles row, while the `role_bindings` half was org-filtered — and `roles`' RLS is `USING (org_id = current_org OR org_id IS NULL)`, so the join matched the shared built-in `Approver` OR an org's own row of the same name.

An org able to author a ZERO-PERMISSION role named 'Approver' would therefore make its holders eligible quorum voters everywhere a policy names Approver — granting nothing and deciding everything. That is why the proposal gates custom roles behind closing this: shipping the authoring API without the predicate turns a documented hazard into a live one in the same release.

THE FIXTURE WRITES THE COLLIDING ROLE BY HAND, AND THAT IS THE POINT
There is no API that mints a role named 'Approver' for an org — `role-binding-door.ts`'s `builtInNameCollisionReason` refuses it at the authoring door that step 10 adds. So this test goes UNDER that door with a superuser INSERT, because the property under test is what the RESOLVER does when such a row exists, not what the door refuses. A restored dump, a hand-written row, or a future door with a gap all produce this state; the resolver has to be safe against it on its own, and a test that could only build the row through the door would be asserting the door's behaviour twice and the resolver's never.

## `apps/server/src/authz/rbac-across-assembly.integration.test.ts`

### §33. RBAC ACROSS AN ASSEMBLY

RBAC ACROSS AN ASSEMBLY — the two-hop `contains` chain (role-model.md §1.4, build step 2)

THE CLAIM THIS FILE PINS. `scopeExpandCte` (`authz/resolve.ts`) walks the `contains` edge with **no predicate on either endpoint's type**, and migration 0055 registered `contains` as `from_types = ['service','assembly']`, `to_types = ['assembly','component']`. Those two facts together mean `service -> assembly -> component` chains for free, at depths 1 AND 2. That is why 0055 shipped no edit to the resolver at all, and it is why role-model.md §7.1's ruling that *"assembly & component share a role"* (ComponentAdmin, `bindable_at: assembly, component`) costs nothing structurally: bound at an assembly, the role reaches that assembly's components through this walk and no new code.

A role design resting on a behaviour that was never asserted is a role design resting on a reading of a SQL fragment. This file makes the behaviour a gate.

WHY THIS WAS NOT ALREADY COVERED — the exact shape of a vacuous test
A filterless census (`grep -rna`, per CLAUDE.md) of every role binding in any assembly-bearing test found ONE, and it was checked at the assembly ITSELF — a **depth-0 self-match**, which the seed row of `scope_expand` satisfies before the recursive term runs even once. Such a test passes with the entire `contains` arm deleted from the LATERAL. It reads as coverage of the `contains` route and is coverage of nothing but the seed.

That is not a hypothetical failure mode here. `graph/containment.ts`'s header records that two hand-synced copies of this same walk DID drift, and the two symptoms were opposite — a service-scoped freeze that failed **OPEN** and a service-scoped `requireApprovals` that failed **CLOSED** — from one root cause. `scopeExpandCte` is still hand-synced with that file on routes 1 and 2 by design (it is a fragment composed into a larger query and cannot consume row output). So the only thing standing between a future edit and a silent authority change is a test that fails when the arm goes away. Every assertion below was measured against exactly that mutation — see the MUTATION LOG.

WHAT THIS FILE ADDS OVER THE TWO NEIGHBOURS THAT ALSO TOUCH `contains`
- `authz/service-scope.integration.test.ts` — the ONE-hop `service -> component` grant, at the real doors. It has no assembly anywhere: every chain in it is a single edge, so a walk bounded at depth 1 passes it entirely. - `authz/inverse-walk-drift.integration.test.ts` — has a `route 2 … TWO HOPS` case over a generated estate, and it is the closest thing in the tree to this file. It asserts the two-hop grant at the **primitive** (`hasPermission`) and at the **downward filter** (`readableObjectFilterFor`), because its subject is the INVERSE-WALK INVARIANT (`hasPermission(S,O) ⟺ O ∈ readableSet(S)`), not the chain. Its only HTTP door is the LIST pagination case.

```text
This file is deliberately the other half: the two-hop chain **through the real get-by-id and
PATCH doors**, plus the two asymmetries that neighbour does not build a fixture for — a
**SIBLING ASSEMBLY** under the same service (it has one sibling *service* and no sibling
assembly), and a **component-bound** subject failing to reach the assembly above it (it checks
assembly-bound -> service, one rung higher).
```

```text
Overlap is real and is not a reason to drop either: the two-hop primitive assertion appears in
both. Deleting it here would leave the door cases resting on a claim proved in a file whose
fixture is regenerated from `SCP_DRIFT_SEED` and whose stated purpose is a different invariant.
```

THE ASYMMETRY IS THE SECURITY PROPERTY, NOT AN IMPLEMENTATION DETAIL
`contains` is registered service -> component and walked BACKWARDS here (`r.to_id` is the object being checked, `r.from_id` its parent). So authority flows DOWN and only down:

```text
- a binding at a service reaches every assembly and component beneath it;
- a binding at an assembly reaches its own components and **nothing sideways** — not a sibling
  assembly, not a sibling assembly's components;
- a binding at a component reaches **nothing upward** — not its assembly, not its service.
```

If the walk were ever "fixed" to be symmetric, the component's own operator would inherit the service, and every ComponentAdmin in the estate would silently become a ServiceAdmin. The negative cases below are therefore not padding; they are the half that cannot be recovered by re-reading the code, because a too-permissive walk still passes every positive assertion.

THE FIXTURE — built through the REAL API (every object has a door, so nothing is hand-inserted)

```text
org root
└── domain D                                   (route 1: objects.domain_id)
    ├── service S      --contains-->  assembly A1  --contains-->  component C1
    │                                                             └── placement P1 (at target T)
    │                  --contains-->  assembly A2  --contains-->  component C2
    └── service S2     --contains-->  assembly A3  --contains-->  component C3
```

Assemblies, components and placements take no `domainId`, so `objects-repo.ts` roots them at the ORG ROOT — route 1 gives them the org root and nothing else. Their only path to S, D or each other is the `contains` edge under test. That is deliberate: if the fixture parented C1 under D via `domainId`, a service binding could reach it by route 1 and the `contains` mutation below would not go red.

The MUTATION LOG below records what each of those assertions was measured against.

### §34. Mutation log: each applied alone, measured, then reverted

MUTATION LOG — each applied ALONE to `authz/resolve.ts`, measured 2026-08-26, then reverted.

A test that survives mutation 1 is measuring the seed row of `scope_expand` and nothing else. A test that survives mutation 2 is measuring the PRESENCE of the arm rather than the DEPTH of the walk — the subtler failure, and the one the depth-0 self-match described above hides behind. Both were run; the second is the one that shaped this file's structure.

| # | Mutation applied to `scopeExpandCte` | Measured result |
| 1 | DELETE the `contains` arm (`SELECT r.from_id … type_id = 'contains'`) from the LATERAL | **9 of 13 fail.** Headline: `AssertionError: the SERVICE binding must reach the component two hops down, under an assembly: expected false to be true`. Every positive case goes with it — one-hop, two-hop, three-hop, and all four doors (`ScpApiError: Forbidden`). The four NEGATIVE tests stay GREEN, which is exactly why they are here and also exactly why they can never be the proof: a walk that grants nothing satisfies every "must not reach" claim ever written. | | 2 | BOUND the `contains` walk at ONE hop (`AND se.depth = 0` on that arm) | **4 fail, and precisely the right 4.** Red: the two-hop primitive, the three-hop placement case, `DOOR (read, TWO HOPS)` and `DOOR (write) … two hops up`. GREEN: `ONE HOP from the service`, `ONE HOP: a binding at the ASSEMBLY …`, and `DOOR (read, ONE HOP)`. That green/red split is the proof the assertions measure DEPTH. |

⚠️ MUTATION 2 WAS FIRST ATTEMPTED THE OBVIOUS WAY AND THAT WAY IS USELESS HERE. Setting `scopeExpandCte`'s shared bound to 1 outright (`maxDepth: number = 1`) does not fail these tests — it fails `beforeAll`, at `relationships.create`, with all 13 SKIPPED. The org bootstrap admin is bound at the ORG ROOT, and a service sits two hops below it (`service -> domain -> org root`), so a globally-bounded walk stops the FIXTURE from being built through the real API and the suite reports a red that says nothing about the property. Anyone re-running this log should mutate the ARM, not the shared bound; a "13 skipped" run is that mistake, not a discovery.

### §35. Hops are separate tests so a depth mutation stays legible

Hop 1 and hop 2 are SEPARATE tests on purpose, and the separation is what makes the depth mutation legible. Asserted together in one `it`, the hop-1 `expect` short-circuits the hop-2 one, so a walk bounded at depth 1 would report "must reach the assembly one hop down" — a message that names the assertion that STILL HOLDS. Split, the failing test names the hop that actually broke, and the pair reads as a measurement of depth rather than of presence.

### §36. 4. THE REAL DOORS

4. THE REAL DOORS — the layer that actually decides what a caller gets.

`hasPermission` is the primitive; a door is where it is (or is not) called with the right scope. CLAUDE.md's "component built, never installed" class lives exactly in that gap, so the property is pinned at BOTH layers or it is pinned at neither.

## `apps/server/src/authz/readable-scope-filter.test.ts`

### §37. THE READ-SURFACE FILTER'S PURE HALF

THE READ-SURFACE FILTER'S PURE HALF — the effect classifier, and the three-outcome contract

`readable-scope.integration.test.ts` drives both of these against real PostgreSQL and is where the WALK's correctness is settled — no fake database appears here and none should. What this file pins is the pair of properties that are decided in JavaScript before any query runs, and that an integration fixture can only reach one value of at a time:

- `partitionReadableRoots` classifies a RAW `role_bindings.effect` string. The docblock's rule is that it must match `hasPermission`'s exact-string comparison, so a row a pre-`0096` dump can still carry grants nothing AND denies nothing. Building each malformed value through the API is impossible (the CHECK refuses it) and through the harness costs a fixture per value; here every value is one line. - `readableObjectFilterSql`'s three outcomes. `null` and "matches nothing" are OPPOSITES — the module doc says treating `null` as "matches nothing" empties every org admin's lists, and treating "matches nothing" as `null` hands the whole org to a subject with no grant. The empty-allow branch has NO production caller that can observe it (`list-door-scope.ts` returns 403 first), so it is exactly the kind of fail-closed defence that only a direct call can pin.

The SQL is rendered with drizzle's own `PgDialect` — the same serializer the driver uses, not a reimplementation — so the assertions below are about the statement PostgreSQL would receive.

## `apps/server/src/authz/readable-scope.integration.test.ts`

### §38. THE DOWNWARD HALF OF RBAC

THE DOWNWARD HALF OF RBAC — `authz/readable-scope.ts` (role-model.md §8.2, increment 2.5b)

`scopeExpandCte` expands UPWARD, which answers "may this subject read THIS object?" and cannot answer "which objects may it list?". This file is the behavioural gate for the downward walk that does, and for the four silent-failure hazards §8.3 names. Each hazard ships a working-looking bug if missed, so each gets its own named case rather than being implied by a broader one:

```text
1. UPWARD AND DOWNWARD ARE EXACT INVERSES — "the two walks agree object by object" below is the
   drift detector for the whole increment. An object `authorize()` admits at its own id but the
   list omits reads as a cache bug, not an authz bug, and would be debugged as one.
2. A MALFORMED `role_bindings.effect` — "a malformed effect grants NOTHING". drizzle/0096
   now refuses one at the DB, but a row predating that constraint still has to fail closed.
3. DENY IS A SUBTRACTION, NOT AN ABSENCE — "a deny below an allow subtracts its subtree".
4. DOWNWARD TRUNCATION IS SILENT — "the bound is the same constant" pins the boundary case that
   makes the two directions inverses *including* their bound.
```

MUTATION LOG — each applied alone against `src/authz/`, measured, then reverted

| Mutation | Measured result (2026-08-26) |
| `readableObjectFilterSql`: drop the deny descend and the `EXCEPT`, returning the allow descend alone | **2 fail.** "a deny below an allow subtracts its subtree": `expected Set{ …(7) } to deeply equal Set{ …(2) }` — the denied service and its whole subtree are readable again. "the two walks agree object by object": `subject 'denied' — upward and downward disagree: expected [ …(5) ] to deeply equal []`. Deny goes INERT on lists while still working on get-by-id: a deny that fails OPEN. | | `partitionReadableRoots`: `effect === "allow"` → `effect !== "deny"` | **3 fail.** "a malformed effect ('ALLOW') grants NOTHING": `expected [ …(5) ] to deeply equal []`. "the two walks agree object by object": `subject 'malformed' — upward and downward disagree`. "`readableRootsFor` returns the raw effect…": `expected Set{ …(3) } to deeply equal Set{ …(2) }`. A row that grants nothing through `hasPermission` would grant a whole subtree through every list door. | | `containmentChildrenSql`: delete arm 2 (the `contains` inverse) | **6 fail**, incl. "a binding at a SERVICE reaches its assemblies and components" (`expected Set{ 1 id } to deeply equal Set{ …(5) }`), the inverse test, and the drizzle-composition case (`expected Set{} to deeply equal Set{ …(2) }`). The drift the exported fragment exists to make impossible. | | `readableObjectFilterSql`: return `null` instead of `MATCHES_NOTHING` for an empty allow set | **4 fail.** "no allow binding at all matches NOTHING": `an empty allow set must NOT be the no-filter answer: expected null not to be null`; the inverse test reports 33 disagreements for `subject 'malformed'`. The two `null`s mean opposite things, and collapsing them lets a subject with no grant read the entire org. | | `insertMalformedEffectRoleBinding`: skip its `INSERT` (the FIXTURE, not the code under test) | **4 fail**, every one with `insertMalformedEffectRoleBinding did not land … Every assertion resting on this row would have passed VACUOUSLY.` Then the SAME mutation with that read-back guard ALSO removed: **1 fail** here (only "`readableRootsFor` returns the raw effect…", which reads the row directly — `expected undefined to be 'ALLOW'`) and **0 fail, 15 passed, in `inverse-walk-drift.integration.test.ts`**. Both "a malformed effect grants NOTHING" cases go GREEN with no binding in the table at all. Since drizzle/0096 this fixture has to drop a CHECK to do its job, which is exactly what makes a silent no-op possible — hence the guard, and hence this row. |

FIXTURE — every one of the four containment routes, exercised in both directions

```text
orgRoot
├── domainA                       (route 1)
│   ├── serviceA                  (route 1)
│   │   ├── assemblyA             (route 2 — `contains`)
│   │   │   └── compA1            (route 2)
│   │   ├── compA2                (route 2)
│   │   └── compDoomed            (route 2, then soft-deleted)
│   └── serviceC                  (route 1 — the sibling that survives the deny on serviceA)
├── domainB ── serviceB ── compB1 (the non-leakage arm)
├── targetT                       (a deployment-target, `domain_id` = org root)
└── placementP                    (compA1 @ targetT — routes 3 AND 4)
```

Built through the real API (the SDK against a listening server), never by direct row writes. The ONE exception is the malformed-`effect` binding, which exists precisely because no API can write it — that is the hazard.

### §39. A role binding written with an ARBITRARY `effect` string

A role binding written with an ARBITRARY `effect` string — the only thing here not built through the API, because no door will ever write anything but 'allow'/'deny'.

Since drizzle/0096 the DATABASE refuses anything else too (`role_bindings_effect_check`), so a malformed value is routed to `insertMalformedEffectRoleBinding` — which builds the row THE ONLY WAY IT CAN STILL EXIST (a privileged path with the CHECK momentarily dropped, i.e. what a pre-0096 `pg_dump` restores or a DBA does) rather than pretending the shape went away. See that helper's doc for why the constraint does not retire these cases: it stops the row being written, not the row being READ, and the resolver's exact-string classification is the inner layer that keeps it harmless. Legal effects still take the ordinary path, unchanged.

### §40. A binding effect that is neither allow nor deny

3. §8.3 hazard: A `role_bindings.effect` THAT IS NEITHER 'allow' NOR 'deny'. `role_bindings_effect_check` (drizzle/0096) refuses one at the database now; these rows are built through `insertMalformedEffectRoleBinding`, which reproduces the only way one can still exist — pre-dating the constraint, in a restored dump. See `bindRaw` above.

### §41. The `domain_id` route is the one deliberate divergence

Route 1 (`domain_id`) is the case where they genuinely differ, and it is the ONE deliberate divergence: no cascade rewrites `domain_id`, so upward the raw SEED row still walks up to the live parent and `hasPermission` says TRUE, while downward every CHILD is filtered live and the row is absent. Inert by construction — list doors filter `deleted_at IS NULL` themselves unless `includeDeleted`, so no door can serve a row this omits.

### §42. The org-root arm runs first and ignores a deny below it

Deliberate, and it keeps the DOORS in agreement rather than breaking them: `checkAtOrgRootOrScopes` tries the org-root arm FIRST and never consults a deny bound below the org root, so get-by-id admits serviceA for this subject. A filter here would remove from the list exactly what get-by-id still serves — a narrowing nobody decided, and the mismatch §8.3's first hazard is about. (`hasPermission` at serviceA in ISOLATION does return false, which is why this case is pinned separately from the object-by-object sample above.)

## `apps/server/src/authz/readable-scope.ts`

### §43. THE READ SURFACE'S OTHER HALF

THE READ SURFACE'S OTHER HALF — "which objects does this subject's authority REACH?"

`authz/resolve.ts` answers ONE question: "may this subject do P at THIS object?", by expanding the object's containment chain UPWARD and looking for a binding on it. That is the right shape for a get-by-id door and the wrong shape for a LIST door, which has no single object to ask about.

Increment 2.5a re-scoped the get-by-id doors off `scopeObjectId: auth.orgId`. LIST doors are the other half (docs/proposals/role-model.md §8.2, §8.7): they run one org-root `object:read` check and then return every row in the org, so a ComponentAdmin cannot list at all. This module is the query-side intersection that fixes it — the containment walk run DOWNWARD from the subject's bindings, composed INTO the repo query so it applies BEFORE the `LIMIT`.

WHY IT IS A QUERY FILTER AND NOT A POST-FILTER — measured, not aesthetic
Every list repo is keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from the last UNFILTERED row, so filtering rows in the handler shrinks the page AFTER the LIMIT. On a 20,910-object estate an assembly-bound principal's 5 readable components sit at cursor ranks 97, 140, 254, 339 and 440 of 18,500: one readable row on page 1, one each on pages 2–5, and ZERO on pages 6 through 185 — each with a valid `nextCursor` — while 27 of 30 `apps/web` list call sites fetch exactly one page. A post-filter is therefore not a slower version of this; it is a silently wrong one. (role-model.md §8.2.)

THREE OUTCOMES, AND `null` IS THE DANGEROUS ONE TO MISREAD
`readableObjectFilterSql` returns:

```text
- `null`            — NO FILTER. The subject holds an allow binding at the ORG ROOT, so today's
                      query runs verbatim. Callers MUST treat null as "add nothing to the
                      WHERE clause"; treating it as "matches nothing" empties every org
                      admin's lists.
- an EMPTY id set   — matches NOTHING. The subject holds no allow binding at all for this
                      permission. This is the OPPOSITE of `null` and must never collapse into
                      it.
```

```text
                      ⚠️ NO PRODUCTION CALLER CAN OBSERVE IT TODAY, and saying so is the point.
                      The one production entry point, `list-door-scope.ts`'s
                      `readableScopeForListDoor`, returns a 403 on exactly that condition
                      (`if (roots.allowRoots.length === 0) return refuseAtOrgRoot(...)`) before
                      calling this, and its other two calls pass a single hint id. So this
                      branch is a DEFENCE ON THE PURE FUNCTION, not a shape any list door
                      renders: it exists so that a future caller which reaches this function
                      without that gate — or a refactor that drops the gate — fails CLOSED
                      instead of returning `null` and handing the whole org to a subject with
                      no grant. `routes/list-readable-scope.integration.test.ts` mutation-proves
                      the gate; `readable-scope.integration.test.ts` mutation-proves this
                      branch, calling it directly for that reason.
- a descend         — the recursive walk below the subject's allow roots, minus the walk below
                      its deny roots.
```

HOW A REPO COMPOSES IT (the whole integration surface)
The returned `SQL` is a parenthesised subquery yielding one `id` column, so a repo adds exactly one condition, before its LIMIT, using ITS OWN id expression (aliases differ per repo):

```ts const filter = await readableScopeForListDoor(tx, { orgId, subjectObjectId, permission, ... }); if (filter) conditions.push(sql`${objects.id} IN ${filter}`);   // null => no condition at all ```

The value comes from `authz/list-door-scope.ts`, never from `readableObjectFilterFor`: a list door must run the org-root arm FIRST and must refuse a subject with no allow root, and this module knows nothing about either. See `readableObjectFilterFor` for what that function is actually for.

The subquery is UNCORRELATED — it names no column of the outer query, only bound parameters — so the recursive walk is not re-run per row. Measured plan (`EXPLAIN ANALYZE`, PostgreSQL 16, small fixture): the descend plans as one `CTE Scan` under a `Nested Loop Semi Join`, i.e. materialised once and semi-joined against, 0.46 ms planning / 0.09 ms execution. The join strategy is the planner's and was not tuned here; what the composition GUARANTEES is the property the pagination argument above needs — the filter is part of the same statement, so it applies BEFORE the LIMIT.

For the OPTIONAL `?scopeObjectId=` narrowing (role-model.md §8.2 step 6) a route authorizes at the hint and then calls `readableObjectFilterSql(orgId, [hint], denyRoots)` — the allow roots are replaced, the deny roots are NOT, because a deny below the hint still subtracts.

THE PURE-WIDENING INVARIANT THIS MODULE MUST NOT BREAK
The org-root `authorize()` at the top of each list door STAYS. A subject with no allow binding anywhere still gets today's 403, and a subject with an org-root allow still gets today's rows — which is exactly what the `null` short-circuit guarantees, byte for byte.

That short-circuit is also what keeps the DOOR-LEVEL inverse invariant true for an org-root holder who ALSO carries a deny lower down. `authz/org-root-arm.ts`'s org-root arm is evaluated first and never consults such a deny (that is deliberate: "a deny bound below the org root, which the org-root pin never consulted and which this increment therefore must not start honouring"), so the LIST doors show those objects via `null`. **get-by-id does NOT admit them** — an earlier version of this paragraph claimed it did, and that was measured false (org-root allow + a deny at the object: `GET /objects/user/{id}` -> 403, while the list returns the row). Do not "repair" the LIST door to match get-by-id on the strength of a comment: `docs/authz/role-binding-door.md` §2d's projection bar is stated against the LIST behaviour, and that repair would silently make the grant preview the only door showing the row. No test pins this parity today — it is named in §8's open list. `hasPermission()` called in ISOLATION at that object returns false, so the drift test below deliberately measures scoped subjects, and pins the org-root-with-deny case as its own named short-circuit assertion rather than folding it into the sample.

### §44. Every scope where this subject's roles grant the permission

Every scope at which this subject holds a binding whose role grants `permission` — one query.

THE SUBJECT EXPANSION IS `hasPermission`'S, VERBATIM: the subject plus every group/team it transitively belongs to via `member_of`, walked from `from_id` to `to_id`, live edges only, at the same `CONTAINMENT_WALK_MAX_DEPTH` bound. It has to be identical, because the roots this returns are fed to a DOWNWARD walk that must reproduce `hasPermission`'s verdict object by object; a subject reachable there and not here shows up as rows missing from a list with no error anywhere.

⚠️ THIS IS A HAND-SYNCED COPY of that expansion — the FOURTH in the tree (`hasPermission`, `hasRoleAtScope` and `assertDenyNotTruncated` already each carry one; `graph/containment.ts`'s header records what hand-synced copies of the CONTAINMENT walk cost when they drifted). The right fix is to export a `subjectExpandCte` fragment from `resolve.ts` and compose it in all four, the way `placementParentsSql` and `containmentChildrenSql` are composed; that edit belongs to `resolve.ts`, which is outside this increment's file set, and is filed as a follow-up. Until then the drift detector is real rather than notional: `readable-scope.integration.test.ts` routes one subject's binding through a NESTED `member_of` chain and asserts `hasPermission` and the readable set agree object by object, so a divergence between the two expansions fails a named test.

DELIBERATELY NOT DEPTH-PROBED. `hasPermission` converts a nothing-found verdict into a loud `walkDepthExceeded` when either walk was truncated (ADR-0037). Here there is nothing to convert: the list door's own org-root `authorize()` runs `hasPermission` FIRST, so a subject nested past the bound has already met that 409 before this function is reached. Re-probing would pay for the same answer twice.

Measured at 0.3–0.5 ms on the existing `role_bindings_subject (org_id, subject_id)` index over a 20,910-object estate (role-model.md §8.2).

### §45. Split the roots into allow and deny by exact equality

Split `readableRootsFor`'s rows into the allow roots and the deny roots — by EXACT string equality, which is the whole point of this function existing.

⚠️ A `role_bindings.effect` THAT IS NEITHER STRING IS STILL REACHABLE, and `hasPermission` classifies it in JS: `effects.includes('deny')` then `effects.includes('allow')`. So a row spelled `'ALLOW'` matches NEITHER branch and grants NOTHING — it falls through to the default deny. Any classification here that is looser than that is a SILENT WIDENING of authority relative to the function it mirrors: written `effect !== 'deny'`, an `'ALLOW'` row that grants nothing on a get-by-id door would grant a whole subtree on every list door. Hence `=== "allow"` exactly, and `=== "deny"` exactly, and a row that is neither lands in neither set.

`role_bindings_effect_check` (drizzle/0096) makes the database refuse such a row on INSERT and UPDATE, and 0096 deletes the ones it finds. That is an OUTER layer, not a replacement for this one: a CHECK cannot un-write a row that pre-dates it, so any deployment restored from a pre-0096 dump — or touched by a superuser path that is not `scp_app` — can still present one here. This function is what makes that row harmless. (Mutation-proven: `readable-scope.integration.test.ts` and `inverse-walk-drift.integration.test.ts` both build such a row deliberately, via `test-support/harness.ts`'s `insertMalformedEffectRoleBinding`, and both go red the moment this is relaxed.)

The classification lives in JS rather than in the SQL above for one reason: `hasPermission`'s lives in JS, and two comparisons written in two languages are two things to keep in step.

### §46. The readable id set as a subquery; deny is a subtraction

The readable-object id set, as a subquery to intersect a list query with — or `null` for "no filter at all" (see the module doc's three outcomes).

DENY IS A SUBTRACTION, NOT AN ABSENCE — hence a SECOND descend and an `EXCEPT`
`resolve.ts` gives a deny binding priority at ANY matching scope on the object's upward chain: `hasPermission(o)` is false iff some deny binding sits at an ancestor-or-self of `o`. Read downward, that is exactly `o ∈ descend(denyRoots)`. So the readable set is `descend(allowRoots) EXCEPT descend(denyRoots)` — two walks, not one walk with a filtered seed. Omitting the second descend does not make deny approximate; it makes deny INERT on every list door while it still works on get-by-id — a deny that fails OPEN. (Mutation-proven: dropping the `EXCEPT` fails `readable-scope.integration.test.ts`'s named deny case.)

THE SEEDS ARE FILTERED LIVE — a tombstoned scope grants (and denies) nothing
Upward, `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a binding at a soft-deleted service stops reaching that service's live components. The downward mirror of that is the seed JOIN below: a deleted root contributes neither itself nor a subtree. It applies to the DENY seed for the same reason and in the same direction — upward, a tombstoned deny ancestor is off the chain and does not refuse, so downward it must not subtract.

THE BOUND, AND WHAT HAPPENS PAST IT (role-model.md §8.3's truncation hazard, decided)
The descend is bounded at `CONTAINMENT_WALK_MAX_DEPTH` — the SAME constant, with the same `depth < bound` shape, that `scopeExpandCte` bounds the upward walk with. That is what makes the two directions exact inverses rather than approximately so: the paths are literally the same sequences read backwards, so `o ∈ descend(r)` iff `r ∈ scopeExpand(o)`, truncation included.

Downward there is no `walkDepthExceeded` conversion, and that is a deliberate choice, not an oversight:

1. It cannot fire on a legally-built estate. Every live locally-written row reaches the org root within the bound — the three write doors refuse anything else (ADR-0037 Consequences, `assertContainmentDepthAdmits`) — and a non-org-root allow root sits at depth ≥ 1, so nothing below it can be more than `bound - 1` hops away. An org-root allow root short-circuits to `null` and never walks at all. 2. Where it CAN fire — a row planted past the bound by the federation-import carve-out or by legacy data — the row is already ungovernable in both directions: every UPWARD walk of it refuses loudly, so its get-by-id door answers 409 rather than 200. The list omitting it is not hiding something the API would otherwise hand over; membership still agrees, and only loudness differs. 3. Converting it would turn a per-ROW fault into a whole-PAGE 409 for the scoped principal — the exact trade ADR-0037's own federation carve-out rejects ("a per-CHANNEL failure for a per-row fault"). Meanwhile the principal who can actually repair such a row, the org-root admin, gets `null` here and still sees it in the list, exactly as today.

WHY `(VALUES ...)` AND NOT `unnest($1::uuid[])`
drizzle-orm's `sql` tag expands a JS array interpolation into a parenthesised parameter LIST, so `${roots}::uuid[]` receives a bare scalar or an anonymous record and fails to cast — measured and written down at `graph/sql-helpers.ts`. The in-tree idiom for a caller-sized set of typed parameters is `(VALUES (${id}::uuid), ...)` (`iac/stack-ownership.ts`, `coordination/service-board.ts`), and it binds each id as its own parameter, so no id is ever concatenated into SQL text.

### §47. One named `WITH RECURSIVE` term

One named `WITH RECURSIVE` term: the live seed roots, then `containmentChildrenSql` recursed to the shared bound.

`UNION` (not `UNION ALL`), and the reason is narrower than the one that used to be written here — MEASURED on PostgreSQL 16, because the plausible version is wrong. The recursive term emits `(id, depth)` PAIRS, so `UNION` can only collapse an id reached by two routes AT THE SAME DEPTH: two services that both `contains` one component, arriving at depth 2 twice. It does NOT collapse the case the old comment offered as its example — a component reachable via its domain at depth 1 AND via its service at depth 2 — which is two rows under `UNION` exactly as under `UNION ALL`, with its whole subtree walked from each. (Probed both ways: identical output, identical row counts.) So `UNION` buys same-depth fan-in, not DAG collapse, and it is not what terminates the walk either — the `depth <` guard below is.

That duplication is harmless HERE in a way it is not in `containmentSubtreeExceeds`: this term is consumed as `SELECT id FROM …` inside an `IN`/`EXCEPT`, where a repeated id is a no-op, whereas that walk reads `MAX(depth)` and needs the longest route per row. Membership is what this computes, so both readings agree; keep `UNION` anyway, because the same-depth fan-in it collapses is the common shape in a wide estate.

### §48. THE UNGATED READABLE SET

THE UNGATED READABLE SET — resolve the subject's roots, classify them, build the filter.

⚠️ NOT THE PRODUCTION PATH, and deliberately not wired to one. Every list door goes through `authz/list-door-scope.ts`'s `readableScopeForListDoor`, which does three things this does not and must not: it runs the org-root arm FIRST, it 403s a subject with no allow root instead of handing back a match-nothing set, and it refuses an org-root allow that an org-root DENY outranked. A repo that called this instead would answer 200-with-an-empty-page where the door owes a 403.

What it IS for: the drift detector. `readable-scope.integration.test.ts` and `inverse-walk-drift.integration.test.ts` need "the set the DOWNWARD walk produces for this subject" with no gate in front of it, so they can assert `hasPermission(o)` iff `o ∈ readableSet(subject)` over every live object — including the subjects the gate would have refused, which are precisely the interesting ones for that invariant. Exported for that, and kept here rather than in the test files so the two suites cannot each grow their own partition call and drift the `effect` classification back to `!== 'deny'`.

Returns exactly what `readableObjectFilterSql` returns, with the same three outcomes; `null` means NO FILTER.

## `apps/server/src/authz/resolve.integration.test.ts`

### §49. PR #4 security review, CRITICAL 2 / BUILD_AND_TEST.md §9

PR #4 security review, CRITICAL 2 / BUILD_AND_TEST.md §9 ("RBAC inheritance + deny-override matrix"): direct integration coverage of the permission evaluator (authz/resolve.ts) against real Postgres — containment inheritance, scope non-leakage, deny-override (direct and via groups), member_of expansion (flat and nested, user and service-account subjects), default deny, and unknown permissions failing closed.

Fixture containment: orgRoot ─▶ domain D ─▶ service S (plus sibling domain D2 for non-leakage checks). Subjects are created per-case so bindings never interfere.

## `apps/server/src/authz/resolve.ts`

### §50. RBAC permission resolution

RBAC permission resolution (DESIGN.md §7). One recursive CTE does both expansions the design calls for in the same query:

- **Subject expansion**: the acting subject (a `user`/`service-account` graph object) plus every group/team it transitively belongs to via built-in `member_of` relationships. - **Scope (containment) expansion**: the target object plus every containing ancestor, by two routes — `objects.domain_id` up to the org root (every object's chain is BUILT to terminate there — graph/objects-repo.ts defaults `domainId` to the org root object at creation time, so this walk never needs NULL special-casing beyond the root itself; a TOMBSTONED ancestor cuts it short, which is the caveat on route 1 in `scopeExpandCte`'s doc and matters more than it reads), AND the `contains` edge from a component to its service (migration 0021), which is what finally makes DESIGN §7's documented `component -> service -> domain -> organization` chain real. See `scopeExpandCte`.

`role_bindings` rows whose `(subject, scope)` pair matches either expansion, and whose role grants the requested permission, are collected; an explicit `deny` at ANY matching scope wins over any `allow` (deny-override, DESIGN.md §7). No matching binding at all is a default deny. Both expansions are depth-limited to 10 (DESIGN.md §5's traversal bound, reused here).

### §51. THE PERMISSION CATALOGUE

THE PERMISSION CATALOGUE — the single runtime source of truth, and the reason it is an ARRAY and not a union.

This was a hand-written `type Permission = "a" | "b" | ...` union for its whole life, which a TypeScript build erases: there was NO value at runtime enumerating the permissions this system defines, so nothing could ever ask "is every permission I define actually granted to somebody, and demanded somewhere?". `org:admin` is what that costs — seeded to Owner by drizzle/0002, demanded at ZERO call sites for its entire life, and removed only when a human ran a census by hand in 2026-08 because `GET /roles` was about to publish it.

`Permission` is now DERIVED from this array (below), so the type and the enumeration cannot disagree: adding a member to one adds it to the other, and there is no edit that changes the union without changing what the drift gate iterates. That is the property; the array is just how it is obtained.

ORDER IS PRESENTATION ONLY. Grouped by the milestone that introduced each member, because the comments below carry the reasoning per member and reasoning reads chronologically. Nothing depends on the order — `role-model.md` §5 step 4's gate compares SETS.

### §52. `org:admin` lived here: granted, never demanded, removed

(`org:admin` was here. Seeded to Owner alone by drizzle/0002 and demanded at ZERO call sites for its whole life, it was REMOVED by drizzle/0099 — the one deliberate subtraction in an otherwise additive design, taken now because role-model.md §5 step 5's `GET /roles` is about to publish these strings, and a permission that gates nothing while advertising authority in a roles listing is worse than no permission at all. Subtraction from a built-in role is normally unsafe here — `org_id IS NULL` rows are SHARED SINGLETONS read by every org through the `roles` RLS `USING (... OR org_id IS NULL)` clause, so removing a permission narrows every org on every deployment at once with no per-org opt-out (role-model.md §2). It is safe for exactly this one because no code path has ever asked for it, which is a property the filterless census re-run for drizzle/0099 measured rather than assumed.)

### §53. THE SECOND BAR ON PAIRING

THE SECOND BAR ON PAIRING — adding a federation peer, or re-keying one (owner ruling D4, 2026-08-25; docs/proposals/role-model.md §4.1). Demanded by `POST /api/v1/federation/peers` (`routes/federation.ts`) ON TOP OF the `federation:write` that door already demanded — added, never substituted, so nothing that could pair before this permission existed can pair without it.

THE CHAIN IT CLOSES. `POST /federation/peers` takes the peer's Ed25519 `publicKey` VERBATIM from the request body, and `POST /federation/imports` — same single `federation:write` — hands every entry of a bundle signed by that key to `applyEntry`, whose `object_upsert` branch resolves ANY registered `typeId` through `upsertObjectByUrn`. So on `federation:write` alone: pair a peer with a keypair you generated, import a bundle you signed with it, and you hold estate write authority having never held `object:write`. Pairing is the only link in that chain that can be gated — a throw on the IMPORT path wedges a legitimately paired peer's whole signed bundle, and an import from a legitimately paired peer writing what that peer sent IS the federation contract working.

WHY NOT JUST `federation:write`. The two are different acts: operating a link that somebody with standing established, versus establishing one. Only the second decides WHOSE SIGNATURE this instance will believe, which is the trust anchor for every bundle that arrives afterwards. A FederationAdmin role — `federation:read` + `federation:write`, `object:write` deliberately withheld — is being written on exactly that split, so folding the two together would make the role a lie the day it is bound.

NARROWS NOTHING LIVE. drizzle/0094 grants it to Administrator and Owner, which drizzle/0012 already makes the only holders of `federation:write`; no principal that can pair today loses the ability. It is withheld from the future FederationAdmin, which is the whole point.

SCOPED AT THE ORG ROOT, like every other check on these routes: `federation_peers` rows are an org-instance-wide concern with no containment scope of their own.

NOT DEMANDED BY `PATCH /federation/peers/{id}`, which is transport-only: its request schema (`UpdateFederationPeerRequestSchema`) admits no key material at all, so that door cannot rotate, supersede or revoke a trust anchor — the capability is absent from the contract, not merely unused. Editing a peer's endpoint stays `federation:write`; the moment that body could carry a key, this permission belongs there too.

### §54. The OPT-IN second bar on a containment MOVE

The OPT-IN second bar on a containment MOVE (drizzle/0083, docs/proposals/governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18). Demanded at-or-above the moved object AND at-or-above the destination — and ONLY where a rung of the move-enforcement lattice is enabled, so it is inert on every deployment that has set none.

Granted by drizzle/0083 to Administrator and Owner alone (owner decision Q2-A), deliberately NOT to Operator: Operator/Approver/Administrator/Owner all hold `object:write`, so an Operator-and-above grant would make every principal who can move also able to move under enforcement — the lattice would be inert until custom roles exist, and nothing authors one yet.

### §55. M25.6b (campaigns-rework §4.5, ADR-0042 §9)

M25.6b (campaigns-rework §4.5, ADR-0042 §9) — WAIVE A CAMPAIGN'S DEADLINE FOR ONE TARGET. Granted by drizzle/0088 to Owner ALONE, the `freeze:override` grant's shape exactly.

CHECKED AT THE CAMPAIGN OBJECT, never at the target. The thing being waived is *this campaign's* deadline, so the authority that waives it is authority over the campaign; a target-scoped check would hand the laggard their own waiver — the component's own operator excusing the component from the migration the campaign exists to force. `routes/campaigns.ts` then demands plain `object:write` AT EACH NAMED TARGET as a second, narrower bar, so a waiver cannot be minted over a component the actor has no standing on.

DELIBERATELY NOT `freeze:override`, which was available and is the wrong shape: one permission would then carry two unrelated blast radii — a freeze-override holder could waive migration deadlines and a deadline-waiver holder could bypass release freezes — and neither grant could afterwards be narrowed without taking the other with it.

### §56. THE THREE PERMISSION SPLITS

THE THREE PERMISSION SPLITS (role-model.md §5 step 3; drizzle/0099)
The permission census behind them found `object:write` demanded at 62 call sites and `object:read` at 45 — 107 of 170 — while every purpose-built high-consequence permission (`freeze:override`, `change:emergency`, `campaign:deadline-override`, `approval:write`, `audit:read`) is demanded exactly once. The care spent designing narrow permissions was not reflected in what actually gated the estate. These three take the highest-consequence acts back out of the two generic verbs.

ONE OF THE THREE SUBSTITUTES, TWO ARE ADDED. Which is which is the load-bearing detail and is stated on each member below; getting it backwards either silently deletes a bar or breaks a door nobody meant to break.

### §57. SUBSTITUTES `object:write` at the three CREDENTIAL doors

SUBSTITUTES `object:write` at the three CREDENTIAL doors (role-model.md §1.3d): `PUT` and `DELETE /api/v1/secrets/{key}` (`routes/executors.ts`) and `PUT /api/v1/change-sources/{sourceKind}/webhook-secret` (`routes/change-sources.ts`). Scope is unchanged — still the org root, still one of §8.6's deliberate escalation bars — and ONLY the permission moves.

THREE UNRELATED BLAST RADII SHARED ONE GRANT. Writing the tokens SCP uses to reach GitHub/ArgoCD/Terraform; DELETING them, which is an availability kill switch for all coordination on the deployment; and rotating the HMAC secret that authenticates inbound webhooks — where whoever sets the secret can thereafter forge signed source events into the estate. There was no way to give anyone ordinary org-root `object:write` without also handing them every execution-system credential the org holds.

THIS IS A BREAKING CHANGE, DELIBERATELY, AND THE ONLY SUBSTITUTION OF THE THREE. A principal holding org-root `object:write` and nothing else is now 403 at all three doors. drizzle/0099 grants it to Owner, Administrator and the new OrgAdmin, so the built-in ladder is unaffected; what loses the capability is a custom or purpose role that holds `object:write` alone.

WITHHELD FROM SecurityOfficer ON PURPOSE. Holding the org's outbound credentials is an OPERATIONS act, not a compliance one — a security officer authors ceilings and decides waivers, and giving them custody of the tokens that reach production would put the auditor inside the thing being audited.

### §58. Added to, never substituted for, the existing `policy:write`

ADDED TO — never substituted for — the `policy:write` already demanded on the scan-override DECIDE door (approve | deny | revoke) in `routes/scan-override-grants.ts`. Both are demanded, at the same derived tier object, in that order.

AUTHORING A SCAN CEILING AND WAIVING IT WERE THE SAME PERMISSION STRING AT THE SAME SCOPE (role-model.md §1.3e): rule authoring is `policy:write` at the tier (`routes/typed-registries.ts`), and deciding a waiver against that rule was `policy:write` at the tier too. A textbook separation-of-duty violation, which the route file itself concedes — its raiser≠approver check "survives intact the moment any SECOND principal holds the same scoped `policy:write`", which is to say it closes the one-actor shape and nothing else.

GRANTED TO Owner, Administrator AND the new SecurityOfficer (owner ruling D3 — no sixth `ScanWaiverApprover` role). Granting it to Administrator is what makes this a NO-OP on every live deployment: `policy:write` is held today by Administrator and Owner alone (drizzle/0010), so every principal who can decide a waiver today still can, and no in-flight waiver starts 403ing on upgrade.

THE SEPARATION OF DUTY IS THAT IT IS SEPARATELY WITHHOLDABLE. OrgAdmin holds `policy:write` and NOT this, so an org can seat an estate administrator who authors org policy and a security officer who owns the waiver, and neither is the other. That was impossible while the two acts shared one string, because the cumulative ladder welds a permission's blast radius to its rank.

### §59. Added to, never substituted for, the existing `object:write`

ADDED TO — never substituted for — the `object:write` already demanded at EVERY target of `POST /api/v1/changes/{id}/accept` and `POST /api/v1/changes/{id}/rollback` (`routes/changes.ts`). Same per-target loop, same EVERY-target quantifier, same org-root arm evaluated first; see `assertAcceptableAtEveryChangeTarget`.

WHY PER TARGET AND NOT AT THE CHANGE (role-model.md §4.3/§8.4, MEASURED). A change has no scope of its own: `objects.domain_id` for a change is the org root for every one of the five internal `proposeChange` callers, and `scp change propose` has no `--domain` flag, so both `scopeObjectId: change.domainId` and `scopeObjectId: change.id` are inert — they READ as a narrowing and ARE the org-root pin they replaced.

`cancel` DELIBERATELY DOES NOT DEMAND IT. Cancelling STOPS a release rather than authorizing one; folding it in would make a cancel-only incident-responder role — hold `object:write`, stop a bad release, authorize nothing — inexpressible, and that role is the obvious one an org wants to seat on-call.

THIS IS THE ONE INTENTIONALLY BREAKING GRANT IN THE DESIGN. drizzle/0099 grants it to Owner, Administrator, OrgAdmin, ServiceAdmin and ComponentAdmin, and DELIBERATELY NOT to Operator or Approver — both of which hold `object:write` and can accept and roll back releases today. On upgrade they stop being able to, which is the point: accepting a release into production is not the same authority as editing the graph, and it was only ever the same string because the ladder had no way to say otherwise. It must be announced, not discovered.

### §60. THE `member_of` CLOSURE

THE `member_of` CLOSURE — **ONE definition of the walk, emitted in either direction.**

`member_of` is registered `from_id = the member`, `to_id = the group`. Reading it forwards answers "which groups does this principal count as" (`subjectExpandCte`); reading the SAME edges backwards answers "which principals does this group reach" (`memberExpandCte`). Everything else about the two is identical — the org predicate, the live-edge filter, the depth bound, and `UNION` rather than `UNION ALL` so a `member_of` cycle terminates instead of spinning — so the direction is a parameter here rather than a second body.

That is not tidiness. The two directions are used to answer the two halves of ONE rule (`docs/authz/role-binding-door.md` §2a and §2b): the join door asks "what will this joiner inherit" and the grant door asks "who does this binding reach". If the walks disagreed about a live edge, about the bound, or about cycle termination, one ordering of the same two requests would be guarded and the other would not — which is the defect §2b exists to close, re-introduced one level down.

`sql.raw` is used for the CTE and column NAMES only. Both are module-local string literals chosen by the two wrappers below; no caller supplies either.

### §61. THE `member_of` SUBJECT EXPANSION

THE `member_of` SUBJECT EXPANSION — emitted as the `subject_expand` CTE term.

"Who does this subject count as" — itself, plus every group/team it transitively belongs to, walked `from_id -> to_id` over live `member_of` edges. It is the reason a role binding held by a GROUP grants authority to that group's members, and therefore the reason `graph/relationships-repo.ts` has to apply the role-binding door's subset rule when a `member_of` edge is CREATED (`docs/authz/role-binding-door.md` §2a): writing this edge is what makes the binding reach a new principal.

EXTRACTED 2026-08-27 BECAUSE IT WAS ABOUT TO BE HAND-TYPED FOR THE FIFTH TIME. The three copies in this file — `hasPermission`, `hasRoleAtScope` and `assertDenyNotTruncated` — were byte-identical apart from the depth bound, and they now compose this. Copies that are NOT converted here, named rather than left for the next census to rediscover: `authz/readable-scope.ts` (the LIST-door closure) and `governance/policy-resolve.ts` (`isMemberOf`, and `ownedByGroupOrItsMembers`'s downward group→members walk, which is `memberExpandCte`'s question with a different SELECT list and deliberately no depth bound). Those are out of this change's scope; this docblock is the record that they exist.

### §62. THE INVERSE WALK

THE INVERSE WALK — emitted as the `member_expand` CTE term. Same edges, same bound, read the other way: the seed group/team, plus every principal (and nested group) that transitively reaches it.

WHY A SECOND DIRECTION EXISTS AT ALL. `subjectExpandCte` is seeded at a KNOWN principal and finds the groups above it, which is what a permission check needs. `docs/authz/role-binding-door.md` §2b asks the opposite question — a binding is about to be written ON a group, and the door needs the principals BELOW it — and the group is the known end there. Seeding `subjectExpandCte` at the group would walk further UP into the groups the group belongs to, which is a different set and answers nothing about who the binding empowers.

The seed row is included at depth 0, so a caller that also wants "the subject itself" gets it without a special case; a caller that wants members ONLY filters `depth > 0`.

### §63. The scope expansion both resolvers share, so they cannot drift

The scope (containment) expansion, shared by `hasPermission` and `hasRoleAtScope` so the two can never drift — they answer different questions ("has permission P" vs "holds role R") but MUST agree on what "at-or-above this scope" means, or an Approver bound at a service would be eligible for one check and not the other.

Walks the target object plus every containing ancestor, by THREE routes:

1. `objects.domain_id` — up to the org root (objects-repo.ts defaults `domainId` to the org root at creation, so every chain STARTS OUT terminating there). It does not always END there: the ancestor JOIN below filters `deleted_at IS NULL`, so the walk STOPS at the first tombstoned ancestor and `scope_expand` is then whatever it reached below that point — the seed row alone when the immediate parent is the tombstone. Such a set matches no org-root binding at all, the Owner's included. That is deliberate (see the JOIN's own comment) and it is why every door re-scoped off an org-root pin needs `authz/org-root-arm.ts`'s disjunction rather than a bare check at the object it governs. 2. `contains` — a component's SERVICE is a containing scope (migration 0021, docs/proposals/service-component-model.md). DESIGN §7 has always described the chain as `component -> service -> domain -> organization`; until 0021 there was no service edge to walk, so the documented behaviour did not exist. This is what makes a service-scoped role binding reach that service's components. 3+4. a `placement`'s COMPONENT and its DEPLOYMENT-TARGET (ADR-0026), composed from the very same fragment `graph/containment.ts` walks — `placementParentsSql`. Sharing the SQL is deliberate: routes 1 and 2 are hand-synced between these two files and DID drift once, with a service-scoped freeze failing open and a service-scoped approval failing closed. A route that exists in one copy cannot drift — route 4 was added to the fragment alone and appeared here for free. Consequence: a role bound at a COMPONENT also grants that permission over that component's placements — which is the model (a placement is that component at one place, and declaring one already requires `relationship:write` over the component) — and a role bound at a DEPLOYMENT-TARGET grants it over everything placed there, which is what makes "operator of prod" expressible. Authority tracks the governance chain rather than lagging it. Measured before landing: 0 of the estate's role bindings are scoped to a deployment-target, so route 4 widens nothing that exists today.

The `contains` edge is registered service -> component, so it is walked BACKWARDS here (`r.to_id` = the object being checked, `r.from_id` = its service). That asymmetry is the security property: a binding at a SERVICE reaches its components, but a binding at a COMPONENT never reaches the service (a service has no incoming `contains` edge), nor its sibling components. Route 3 keeps it: a binding at a placement reaches nothing above it except by continuing up through the component, and a placement has no children.

All four routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference exactly once, so several recursive branches would error ("recursive reference ... more than once"). `UNION` (not `UNION ALL`) dedupes — with several routes the chain is a DAG, not a line (a component's domain is reachable directly AND via its service), and dedupe keeps that from re-walking.

### §64. The truncation probe runs only on deny, and why

ADR-0037 — the deny-path truncation probe, and why it runs only on deny.

An ALLOW found within the bound is always valid: the binding was reached, the grant is real. A DENY is the direction that can lie — "no binding reached" is indistinguishable from "the binding exists at an ancestor the walk never got to" (measured 2026-08-13: an org-root admin 403'd inside a deep domain chain with a detail naming neither depth nor bound, and the operator debugging that message debugs RBAC, not nesting). So `hasPermission`/`hasRoleAtScope` call this only after computing a refusal: both walks are re-run ONE level past the bound, and if either frontier is still expanding the refusal is converted into a loud depth error instead of a silent false. The hot allow-path pays nothing.

### §65. Approval-quorum eligibility, resolved by role name

Approval-quorum eligibility (DESIGN §10.2, BUILD_AND_TEST.md §8 M4 "N-of-M can't be forged"). Structurally identical to `hasPermission`'s recursive CTE (same subject/scope expansion, same deny-override) but matches on the BINDING'S ROLE NAME instead of a permission string — "does this subject hold role R at-or-above this scope", independent of whatever permissions R happens to grant. A SEPARATE query (not a `hasPermission` wrapper) because "holds role Approver" and "has permission approval:write" are different questions: an org could grant 'approval:write' to a broader custom role without that role being an eligible *quorum member* for a policy that specifically names 'Approver'.

### §66. Effective permissions at one object, in one round trip

EFFECTIVE PERMISSIONS — role-model.md §5 step 6

Answers "what may THIS subject do AT THIS object", in ONE round trip rather than one per permission.

WHY NOT A LOOP OVER `PERMISSIONS`. The obvious implementation calls `hasPermission` 22 times. Each call runs TWO recursive CTEs — the `member_of` subject walk and the containment scope walk — so the loop re-derives both expansions 22 times to vary one scalar in the WHERE clause, and the walks are the expensive half. Worse, it is not merely slow but RACY: 22 statements see 22 snapshots unless the caller wraps them, so a binding revoked mid-loop yields a permission set that never existed at any instant. One statement is one snapshot.

DENY-OVERRIDE IS PRESERVED EXACTLY, and it is per-permission rather than per-binding: a `deny` binding suppresses only the permissions ITS OWN ROLE carries. That is what `hasPermission` does — it filters to bindings whose role holds the requested permission and only then looks for a deny — and the `bool_or` pair below is the same rule evaluated for every permission at once. A whole-binding deny would be a different and much blunter semantics; getting this backwards would make one narrow deny silently revoke everything.

THE RETURNED STRINGS ARE NOT FILTERED THROUGH `PERMISSIONS`. `roles.permissions` is a plain `text[]` with no CHECK (drizzle/0002 §7), so a restored dump or a hand-written org role can hold a string the code does not define. This reports what the subject ACTUALLY holds, including such a string, because the question is "what does this binding confer" and quietly dropping it would make the answer disagree with `hasPermission` — which does a plain `= ANY(rl.permissions)` and would happily match it. The drift gate (`permission-drift.integration.test.ts`) is what keeps the BUILT-IN catalogue clean; this function does not re-litigate it.

### §67. ADR-0037, INHERITED DELIBERATELY

ADR-0037, INHERITED DELIBERATELY. Every permission ABSENT from `held` is a refusal, and a refusal produced by a walk that hit the depth bound is a lie: a grant may exist beyond it. The probe runs at most once here — `hasPermission` pays it per refusal, and this function would otherwise pay it up to 22 times to say the same thing about the same two walks.

The condition is "some permission was refused", not "nothing was found": a subject holding 3 of 22 permissions has been refused 19 times, and those 19 refusals are exactly as untrustworthy under truncation as a total blank would be.

### §68. The EXPLANATION half of {@link effectivePermissions}

The EXPLANATION half of `effectivePermissions` — every binding that reached the scope, and through which subject.

IT LIVES HERE, BESIDE THE WALKS, ON PURPOSE. The obvious home is `authz/roles-repo.ts` with the other binding reads, and putting it there would mean a SECOND transcription of the `member_of` and containment expansions. This repo has already paid for a duplicated walk definition (`docs/authz/role-binding-door.md` §2b emits its downward walk from the same `memberOfClosureCte` as the upward one for exactly this reason), and two copies of a traversal that disagree about the depth bound or a live edge is a defect that presents as an explanation which does not match the decision it explains.

DELIBERATELY UNFILTERED BY EFFECT. `deny` rows are returned alongside `allow` rows, because a caller asking "why can I not do X here" is usually looking at a deny, and omitting it would make the explanation actively misleading — a permission absent from the set with no visible reason.

### §69. Every binding the subject holds ANYWHERE in the org

Every binding the subject holds ANYWHERE in the org — direct, or through a group/team.

The subject expansion only; NO scope walk. That is the difference between this and `contributingBindingsAt`, and it is why the result must never be described as authority: these bindings are scattered across the estate and each one reaches only what sits beneath it. `packages/schemas/src/auth.ts`'s `permissionsAnywhere` carries the full warning.

## `apps/server/src/authz/role-binding-door.test.ts`

### §70. THE ROLE-BINDING DOOR'S PURE REFUSALS

THE ROLE-BINDING DOOR'S PURE REFUSALS — the half of the door that judges rows, not the database

`role-binding-door.ts` is mostly transaction-bound and is exercised end to end by `routes/rbac-role-binding-door.integration.test.ts` and `routes/rbac-administrative-floor. integration.test.ts` against real PostgreSQL, which is where it belongs (CLAUDE.md: integration tests never mock a DB). Nothing in this file mocks one. Every function below takes rows that have ALREADY been fetched and returns a verdict over them — set difference, string comparison, an own-property lookup — so a `TenantTx` would add nothing but a fixture.

WHAT THIS LAYER CAN REACH THAT THE INTEGRATION LAYER CANNOT REACH CHEAPLY. An integration case builds ONE membership through real `POST /relationships` calls and asserts one verdict. The properties these predicates actually promise are quantified over inputs a fixture cannot conveniently produce: an acknowledgement whose ids are in the wrong ORDER or DUPLICATED (the docblock says "order is irrelevant; duplicates are irrelevant; the comparison is set equality"), a `bindable_at` that is `[]` rather than `null`, a principal that is soft-deleted AND of a non-bindable type at the same time (the "only one reason per principal" rule), a built-in role whose name is `'toString'`. Each of those is one line here and a fixture there.

WHAT IS DELIBERATELY NOT HERE: `missingPermissionsFor`, `assertMayWriteRoleBinding`, `assertMayJoinRoleBearingSubject`, `principalsReachedBy`, `readableSubsetOf`, `assertOrgRetainsAdministrativeFloor`, `objectTouchesRoleAuthority`, `lockOrgRoleAuthority` and every function in `roles-repo.ts`. All of them ask PostgreSQL a question — the subset rule's whole correctness is that it runs `hasPermission` per permission rather than reading the actor's role rows, and a fake `tx` would let a wrong implementation pass. They stay in the integration layer.

### §71. The function's own docblock

The function's own docblock: "`tx` is kept in the signature though nothing in here uses it: this is a door, and every other assert in this module takes the transaction it judges." So no transaction is passed. If this ever throws a TypeError instead of failing an assertion, the function stopped being pure and belongs in the integration layer — which is the signal, not a flake.

## `apps/server/src/authz/roles-repo.ts`

### §72. Reads and writes for `roles` and `role_bindings`

Reads and writes for `roles` and `role_bindings` — the storage half of role-model.md §5 step 5. Deliberately dumb: every refusal lives in `authz/role-binding-door.ts` and every check runs before anything here is called. This module decides nothing.

RLS DOES THE TENANCY, NOT THIS FILE'S WHERE CLAUSES — and the two tables differ, which is the one thing worth knowing here. `roles`' policy is `USING (org_id = current_org OR org_id IS NULL)`, so a read sees this org's rows PLUS the shared built-in singletons; `role_bindings`' policy has no NULL arm, so a read sees this org's rows and nothing else (drizzle/0002 §2). The explicit `org_id` predicates below are belt-and-braces on top of that, in the same style as every other repo in this codebase.

### §73. `effect` is narrowed on read rather than trusted

`effect` is NARROWED here rather than trusted, and the direction of the narrowing is the point.

`role_bindings_effect_check` (drizzle/0097) constrains WRITES; PostgreSQL never re-checks a row on the way out, so a database restored from a pre-0097 `pg_dump` carries the pre-0097 schema and its illegal rows load intact (role-model.md §8.3). The response enum is closed at two values, so a third string has to become one of them.

`x === "allow" ? "allow" : "deny"` — not `x === "deny" ? "deny" : "allow"`. `hasPermission` classifies by exact string equality and treats a malformed row as NEITHER: it grants nothing and denies nothing. Of the two available lies, reporting it as the BLOCKING effect is the one that cannot make an operator believe authority exists where it does not, and it is the one that makes such a row look wrong in a listing instead of looking like a working grant.

### §74. Writes ONE grant, always `effect = 'allow'`

Writes ONE grant, always `effect = 'allow'` (deny is not exposed on the write API — see `packages/schemas/src/rbac.ts`'s module doc).

A duplicate is a 409, not a silent success and not a second row. `role_bindings_grant_key` (drizzle/0097) is the natural key `(org_id, subject_id, role_id, scope_object_id, effect)` and it landed BEFORE this API deliberately: without it a write door creates duplicate grants that are individually revocable and COLLECTIVELY still granting — revoke one, the other still grants, and the revoke reports success. `onConflictDoNothing` would reproduce that failure from the other end (a revoke against a binding the caller believes they created), so the conflict is surfaced.

### §75. `fromRole` AUTHORING-TIME VALIDATION

`fromRole` AUTHORING-TIME VALIDATION — role-model.md §5 step 6, unblocked by step 10's gate

A policy's `requireApprovals.fromRole` is a free-text string that `authz/resolve.ts`'s `hasRoleAtScope` resolves at VOTE time, and — since the quorum-bypass fix (owner decision 2026-08-27) — resolves against BUILT-IN roles only.

WHICH CREATES A NEW WAY TO FAIL SILENTLY, and closing it is the other half of that decision. A policy naming a role that is not a built-in is not merely wrong, it is UNSATISFIABLE: no principal can ever hold it as far as the quorum is concerned, so the gate blocks forever and the Decision record says "0 of 1 approvals" while an operator looks at a live binding of a role with exactly that name and concludes the approval engine is broken. A typo (`'Onwer'`) and a deliberate custom role produce the identical symptom.

SO IT IS REFUSED WHERE IT IS WRITTEN. The refusal names the unknown role AND lists the catalogue, because the failure this replaces is one where nothing anywhere states what a legal value is.

AT THE `objects-repo.ts` CHOKE POINT, not at the route — the same placement lesson §2a paid for: policies are ordinary graph objects, so `POST /objects/policy`, `PUT`, IaC apply and discovery accept all reach the same two functions, and a route-level check would leave IaC apply able to author an unsatisfiable policy. Federation import is exempt for the reason every guard there is: a throw mid-bundle wedges a peer's whole signed journal over a row this domain does not own.

## `apps/server/src/authz/service-scope.integration.test.ts`

### §76. Service-scoped RBAC across the `contains` edge

Service-scoped RBAC (model P2 — docs/proposals/service-component-model.md; the `contains` edge is migration 0021). DESIGN §7 has always documented the containment chain as `component -> service -> domain -> organization`, but until now `authz/resolve.ts` walked `objects.domain_id` ONLY — components and services are siblings under a domain, so a service-scoped role binding reached NOTHING. The claim was real; the behaviour was not.

This is an AUTHORIZATION change, so these tests are the gate. They must prove three things, and the last two matter more than the first — a too-permissive walk is a privilege-escalation bug:

```text
1. a binding at a SERVICE reaches its components (the new capability);
2. a binding at a COMPONENT does NOT reach the service (no upward leak);
3. a binding at a COMPONENT does NOT reach a SIBLING component (no lateral leak).
```

The asymmetry is structural: `contains` is registered service -> component, and the walk follows it backwards (to_id -> from_id), so a service is an ancestor of its components and never the reverse.
