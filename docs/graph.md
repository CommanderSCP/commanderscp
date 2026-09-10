# graph

Long-form reference for the **graph** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 197 of 197 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/graph/artifact-mint-race.integration.test.ts`](#apps-server-src-graph-artifact-mint-race-integration-test-ts) — §1–§3
- [`apps/server/src/graph/artifacts-repo.ts`](#apps-server-src-graph-artifacts-repo-ts) — §4–§11
- [`apps/server/src/graph/cardinality.integration.test.ts`](#apps-server-src-graph-cardinality-integration-test-ts) — §12–§14
- [`apps/server/src/graph/components-repo.ts`](#apps-server-src-graph-components-repo-ts) — §15–§18
- [`apps/server/src/graph/container-delete-guard.integration.test.ts`](#apps-server-src-graph-container-delete-guard-integration-test-ts) — §19–§19
- [`apps/server/src/graph/containment-depth-doors.integration.test.ts`](#apps-server-src-graph-containment-depth-doors-integration-test-ts) — §20–§21
- [`apps/server/src/graph/containment-parent-authz.ts`](#apps-server-src-graph-containment-parent-authz-ts) — §22–§28
- [`apps/server/src/graph/containment.ts`](#apps-server-src-graph-containment-ts) — §29–§43
- [`apps/server/src/graph/content-hash.ts`](#apps-server-src-graph-content-hash-ts) — §44–§45
- [`apps/server/src/graph/custom-type.integration.test.ts`](#apps-server-src-graph-custom-type-integration-test-ts) — §46–§46
- [`apps/server/src/graph/delete-tombstones-edges.integration.test.ts`](#apps-server-src-graph-delete-tombstones-edges-integration-test-ts) — §47–§49
- [`apps/server/src/graph/domain-delete-orphan-guard.integration.test.ts`](#apps-server-src-graph-domain-delete-orphan-guard-integration-test-ts) — §50–§51
- [`apps/server/src/graph/idempotency.integration.test.ts`](#apps-server-src-graph-idempotency-integration-test-ts) — §52–§52
- [`apps/server/src/graph/integrity-repo.ts`](#apps-server-src-graph-integrity-repo-ts) — §53–§54
- [`apps/server/src/graph/integrity.integration.test.ts`](#apps-server-src-graph-integrity-integration-test-ts) — §55–§55
- [`apps/server/src/graph/list-pagination.integration.test.ts`](#apps-server-src-graph-list-pagination-integration-test-ts) — §56–§56
- [`apps/server/src/graph/named-queries.integration.test.ts`](#apps-server-src-graph-named-queries-integration-test-ts) — §57–§63
- [`apps/server/src/graph/named-queries.ts`](#apps-server-src-graph-named-queries-ts) — §64–§67
- [`apps/server/src/graph/nested-domains.integration.test.ts`](#apps-server-src-graph-nested-domains-integration-test-ts) — §68–§72
- [`apps/server/src/graph/object-health-repo.ts`](#apps-server-src-graph-object-health-repo-ts) — §73–§73
- [`apps/server/src/graph/objects-repo.ts`](#apps-server-src-graph-objects-repo-ts) — §74–§130
- [`apps/server/src/graph/pair-bound-types.ts`](#apps-server-src-graph-pair-bound-types-ts) — §131–§131
- [`apps/server/src/graph/placements-repo.ts`](#apps-server-src-graph-placements-repo-ts) — §132–§143
- [`apps/server/src/graph/placements.integration.test.ts`](#apps-server-src-graph-placements-integration-test-ts) — §144–§145
- [`apps/server/src/graph/property-schema-live-edit.integration.test.ts`](#apps-server-src-graph-property-schema-live-edit-integration-test-ts) — §146–§147
- [`apps/server/src/graph/property-validation.test.ts`](#apps-server-src-graph-property-validation-test-ts) — §148–§149
- [`apps/server/src/graph/property-validation.ts`](#apps-server-src-graph-property-validation-ts) — §150–§152
- [`apps/server/src/graph/query-timeout.integration.test.ts`](#apps-server-src-graph-query-timeout-integration-test-ts) — §153–§158
- [`apps/server/src/graph/query-timeout.ts`](#apps-server-src-graph-query-timeout-ts) — §159–§160
- [`apps/server/src/graph/raw-row-mappers.ts`](#apps-server-src-graph-raw-row-mappers-ts) — §161–§162
- [`apps/server/src/graph/relationship-authz.integration.test.ts`](#apps-server-src-graph-relationship-authz-integration-test-ts) — §163–§163
- [`apps/server/src/graph/relationship-resurrection.integration.test.ts`](#apps-server-src-graph-relationship-resurrection-integration-test-ts) — §164–§165
- [`apps/server/src/graph/relationships-repo.ts`](#apps-server-src-graph-relationships-repo-ts) — §166–§180
- [`apps/server/src/graph/rls.integration.test.ts`](#apps-server-src-graph-rls-integration-test-ts) — §181–§184
- [`apps/server/src/graph/service-contains.integration.test.ts`](#apps-server-src-graph-service-contains-integration-test-ts) — §185–§190
- [`apps/server/src/graph/service-member-types.ts`](#apps-server-src-graph-service-member-types-ts) — §191–§191
- [`apps/server/src/graph/sql-helpers.ts`](#apps-server-src-graph-sql-helpers-ts) — §192–§192
- [`apps/server/src/graph/system-managed-relationships.ts`](#apps-server-src-graph-system-managed-relationships-ts) — §193–§193
- [`apps/server/src/graph/traverse.ts`](#apps-server-src-graph-traverse-ts) — §194–§196
- [`apps/server/src/graph/urn.ts`](#apps-server-src-graph-urn-ts) — §197–§197

## `apps/server/src/graph/artifact-mint-race.integration.test.ts`

### §1. `mintArtifactObjects` / `upsertArtifactByIdentity` (ADR-0045 D2)

`mintArtifactObjects` / `upsertArtifactByIdentity` (ADR-0045 D2) — the identity race a concurrent double-mint creates, and the FIX for the dead race-catch this file pins: `createObject` (objects-repo.ts) already converts the raw pg `23505` unique violation into a `ProblemError` 409 BEFORE `artifacts-repo.ts`'s own `catch` ever sees it, so a `isUniqueViolation(err, "objects_artifact_one_per_digest_type")` check there can never match — the 409 used to escape `mintArtifactObjects` uncaught instead of converging, which could reject a signature-verified promotion import over nothing but timing.

### §2. Resolves once a backend is genuinely parked on a lock

Resolves once some backend in this database is genuinely PARKED on a lock — the positive signal that proves the second mint's INSERT collided with the first's still-open one, rather than hoping a fixed sleep bought enough time (`test-support/integration-sleep-census.test.ts`). Polls fast (25ms) because the state is local and near-instant.

### §3. The deterministic race, driven at the repo seam

The deterministic form of the race, driven at the repo seam so the interleaving is exact rather than hoped for: tx1 inserts the artifact row directly (bypassing the mint wrapper's own find-first check, exactly as a genuinely concurrent second promotion attempt would look to THIS call) and STAYS OPEN, holding both unique indexes' entries uncommitted, while tx2 runs the real `mintArtifactObjects` path. Under READ COMMITTED, tx2's own `findArtifactByIdentity` read returns nothing no matter when it lands inside this window (it cannot see tx1's uncommitted row), so it always proceeds to INSERT — which then blocks behind tx1's uncommitted row until tx1 commits, at which point Postgres raises the unique violation `createObject` turns into a 409 `ProblemError`. That is exactly the shape the fix in `artifacts-repo.ts` exists to catch and resolve by re-reading, rather than let escape.

## `apps/server/src/graph/artifacts-repo.ts`

### §4. The immutable built thing, minted at the promotion boundary

`artifact` — THE IMMUTABLE BUILT THING IDENTIFIED BY DIGEST, as a first-class object (ADR-0045).

MINTED ONLY AT THE PROMOTION BOUNDARY (ADR-0045 D2) — `exportPromotionBundle` (commander, after the manifest is cosign-signed) and `importPromotionBundle` (receiver, after signature + checksum verification pass). Neither a build report nor an `observe()` poll mints. That is what keeps the population bounded to promoted digests — attested-only, no GC problem — and this module has no opinion on either caller; it is the one place identity is resolved and rows are written, called from `federation/promotion-repo.ts`.

### §5. One `artifact` row, keyed by its identity

One `artifact` row, keyed by its identity — read straight off the partial unique index 0095 installs, so this is the exact query that index makes an index probe rather than a scan. EXPORTED for `federation/import-repo.ts`'s ordinary `object_upsert` pre-check — see that module's "AN ARTIFACT IDENTITY COLLISION COSTS ONE ENTRY" section for why a second reader of this exact query exists outside the mint path.

### §6. UPSERT-BY-IDENTITY, one artifact at a time

UPSERT-BY-IDENTITY, one artifact at a time: find by `(orgId, digest, artifactType)`; if absent, create. Called for every entry in `artifacts[]` by `mintArtifactObjects`.

IDEMPOTENT ACROSS CALLS — a re-export of an already-exported change, or a second call racing the first (two concurrent promotion attempts naming the same digest), converges on ONE row: the find-then-create is not atomic, so a lost race surfaces as an INSERT failing on `objects_artifact_one_per_digest_type` (this identity) or `objects_org_id_urn_key` (the urn `deriveUrn` derives from the same identity is deterministic, so the two indexes fire on the same race) — never a 409 surfaced to the caller, because neither `exportPromotionBundle` nor `importPromotionBundle` has anything to do with a caller-facing conflict over an artifact object's existence.

DETECTED AS A `ProblemError` 409, NOT A RAW PG 23505 — `createObject` (objects-repo.ts) already catches both unique violations itself and rethrows a `conflict()` `ProblemError` before this function's own `catch` ever sees the original driver error, so `isUniqueViolation` can never match here (a `ProblemError` carries no `.code`). The only conflict `createObject` can throw from this call is one of those two races, so catching `ProblemError` + `status === 409` here and re-reading by identity is precise, not a broad swallow.

THE SAME CLASS OF RISK 0051/0043 ALREADY CARRY, NOT A NEW ONE: an `artifact` object is an ordinary (non-domain-local) object once minted (ADR-0045 D3), so it journals and may ALSO arrive at a peer through ordinary full-scope sync, independently of a promotion bundle — carrying the MINTING domain's own urn embedded verbatim (every replicated object does; urns are not re-derived on import). That replica and a row this function creates locally can never collide on `objects_org_id_urn_key` (their urns differ), which is exactly the exposure 0051's own header accepted for `placement` and 0043 accepted for `outpost` — general to every identity-bearing registered type in this schema, not specific to `artifact`, and not solved here for the same reason it was not solved there.

### §7. A SAVEPOINT (nested `tx.transaction`), not a bare `try`/`catch`

A SAVEPOINT (nested `tx.transaction`), not a bare `try`/`catch` — `placements-repo.ts` and `webhook-processor.ts` state the same rule this call needs: a unique violation aborts the WHOLE enclosing Postgres transaction, so a `catch` that re-reads on the SAME `tx` afterward hits every statement it issues with `25P02` ("current transaction is aborted") rather than the answer it is trying to converge on. `tx.transaction(...)` here is a real `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` around exactly the risky INSERT, so a lost race rolls back only that nested scope and leaves the caller's transaction usable for the re-read below.

### §8. Mint (or find) one `artifact` object per entry in `artifacts`

Mint (or find) one `artifact` object per entry in `artifacts` — the ONLY two call sites are `exportPromotionBundle` and `importPromotionBundle` (ADR-0045 D2). Order-preserving; duplicate `(digest, artifactType)` pairs within one call converge on the same returned object, same as across calls.

### §9. Sequential, not `Promise.all`

Sequential, not `Promise.all`: two entries in the SAME call sharing an identity (a malformed or duplicated artifact set) must also converge on one row, and interleaved concurrent finds would both see "absent" and both attempt to create — the exact race `upsertArtifactByIdentity`'s catch exists to resolve, but resolving it N-ways per call is needless when strict ordering avoids it for free. Promotion artifact sets are small (single digits), so this costs nothing worth parallelizing away.

### §10. Converge by adoption, the fix for the identity collision

ADR-0045 D2a — CONVERGE BY ADOPTION, the D2/D3 fix for the artifact identity collision that `mintArtifactObjects`'s import-mint (D2) and ordinary full-scope sync (D3) otherwise produce FOREVER, once per promotion per peer: `importPromotionBundle` mints this domain's own local anchor for a digest the moment it is promoted in (D2 — the receiver needs SOMETHING to point its newly-proposed change's `sourceRef` at immediately, before any ordinary sync could possibly have carried the exporter's copy). That row is an ORDINARY object once minted (D3), so it journals — and the exporter's OWN minted row for the identical `(digest, artifactType)` is ALSO ordinary and WILL eventually arrive here via full-scope sync, independently of any promotion. Two different ids, one identity: `objects_artifact_one_per_digest_type` (0095) refuses the second row outright.

The prior behavior (`import-repo.ts`'s pre-check) SKIPPED the incoming entry and recorded an `federation.import.entry_dropped` audit event — correct for an accidental one-off collision (0051/0043's precedent), wrong here: this collision is not accidental, it is GUARANTEED for every promoted digest that also reaches this peer under `full` scope, so skip-and-record produces one dropped entry per promotion per peer forever and the receiver's anchor never learns the shared base is now present.

INSTEAD: adopt. The existing (import-minted) row's AUTHORITY moves to the incoming entry's verified signer — id and urn stay exactly as they were (every local reference the receiver's own promoted change already holds — `sourceRef.artifactDigests`, `derived_from` edges, anything keyed on this artifact's id — keeps resolving, which is the whole reason the id must NOT become the incoming one, unlike `upsertObjectByUrn`'s unrelated hand-fill-reconciliation branch). `revision` and `properties` move to the incoming entry's, EXCEPT `firstPromotedChangeId`: that field is this receiver's own local history ("the promotion that first caused this identity to be minted HERE" — `MintArtifactObjectsOptions`'s doc above) and stays true after adoption exactly as before it, the same "never overwritten on convergence" rule a plain re-mint already honors.

NOT RE-JOURNALED. This is treated as what it now is — an ordinary imported replica of the peer's own artifact object, same as any other `federationImport` write (`objects-repo.ts`'s `!input. federationImport` journal gate) — so this call does not itself emit a fresh `object_upsert`; the LOCAL audit row is written unconditionally either way (charter principle 6), and any further relay of the now-adopted row to a THIRD domain goes through the ordinary replica-relay path, not this write.

WHY NOT MAKE THE IMPORT-MINTED ANCHOR `domainLocal: true` INSTEAD (the alternative ADR-0045 D2a considered and rejected): a domain-local anchor never journals at all, which looks like it sidesteps the collision — but it also means the exporter's later-arriving SHARED copy could never land under the SAME id (a domain-local object's identity is invisible to every peer by design, ADR-0031 §2), so the receiver would be permanently split between its own local-only anchor and the real shared artifact the rest of the federation actually references. M20's whole semantics — "this object IS the org's one graph object for this identity, replicated with authority" — would wedge for every promoted artifact, forever, which is a worse and more permanent version of the exact problem this fix exists to close.

### §11. IDEMPOTENT REPLAY (DESIGN §13 DoD: "double-import is a no-op")

IDEMPOTENT REPLAY (DESIGN §13 DoD: "double-import is a no-op") — this call's own caller keys adoption on IDENTITY (digest+artifactType), never on `payload.id`, so `existingId !== payload. id` is true for EVERY subsequent ordinary resync of the same exporter entry after the first adoption, not only the first time. Without this guard, a from-genesis resync or an ordinary channel replay would re-adopt on every delivery — bumping `version`, rewriting `content_hash` and appending a fresh audit event forever, the exact unbounded-growth shape this codebase has already been burned by once (persist-on-change exists for Decisions for the same reason). Already adopted from this same (or a newer) origin/revision: return unchanged.

## `apps/server/src/graph/cardinality.integration.test.ts`

### §12. `many_to_one` cardinality and the attachment edge

`many_to_one` cardinality and the `releases_via` pipeline-attachment edge (migration 0049, ADR-0026, post-import-configuration.md D11).

Two properties are pinned here, and both are the kind that stays green while being broken:

1. **A cardinality with no enforcing branch is silently unenforced.** `assertCardinality` used to be a chain of `if`s over three known values with an implicit fall-through for everything else, and `relationship_types.cardinality` is plain `text` with NO CHECK constraint — so a fourth value (or a typo) read as a declared constraint and enforced nothing. Migration 0021's header had to design around exactly that trap. The last test here inserts an unknown cardinality by privileged surgery and requires the write to FAIL rather than fall through. 2. **A from-side constraint is invisible to a to-side test.** `one_to_many`'s check is on `to_id` only; a `many_to_one` implemented by accidentally reusing it would pass any test that asserts "the second create was rejected" while rejecting the WRONG second create. Every rejection test below therefore also asserts which edge SURVIVED, and the positive test asserts that the many side (two components sharing one pipeline) still works.

**Mutation log** (each mutation applied alone, then reverted — recorded because the two guards cover for each other and a single mutation therefore proves less than it looks):

| Mutation | Result |
| `many_to_one` → neither side singular (app check off) | all 6 PASS — the 0049 index alone holds | | 0049 index removed (app check on) | the RACE test fails; the sequential ones pass | | both of the above together | "REFUSES a second pipeline" AND the race test fail | | `many_to_one` → `{from:false,to:true}` (the `one_to_many` copy-paste) | "ALLOWS many components" fails | | 0049 index without `deleted_at IS NULL` | "frees the component to be re-attached" fails | | fail-closed `throw` → `return` | "FAILS CLOSED" fails |

The second row is the one worth keeping: the app-level check is a SELECT-then-INSERT under READ COMMITTED, and two concurrent HTTP creates really do both get past it — so the index is not belt-and-braces, it is the only thing holding under concurrency.

### §13. 0049 registered `component` ALONE on purpose

0049 registered `component` ALONE on purpose — the higher rungs exist to be READ by the resolution walk, and registering an endpoint nothing could resolve would have let an operator attach a pipeline that silently did nothing. Migration 0052 widened it when that walk landed, and this assertion moved with it rather than being loosened: `domain` is still absent, which is the part that would re-create the attach-but-never-resolve trap (D15 dropped that axis). Migration 0054 inserted `assembly` between component and service: the middle rung is now a LADDER (intermediate-grouping D1), so an assembly must be able to CARRY the attachment the ladder now consults it for — otherwise the level is decoration. `domain` is still absent, which is the part that would re-create the attach-but-never-resolve trap (D15 dropped that axis).

### §14. A select-then-insert under READ COMMITTED can double-write

`assertCardinality` is a SELECT-then-INSERT under READ COMMITTED with no row lock, so two concurrent creates can both pass the check and both insert. `UNIQUE (org_id, type_id, from_id, to_id)` does not help here — the to_ids differ. Migration 0049's partial unique index on (org_id, from_id) is the backstop, mirroring 0022. Driven CONCURRENTLY, which the sequential tests above cannot catch.

## `apps/server/src/graph/components-repo.ts`

### §15. Strict component create

Strict component create (M12 P5a, docs/proposals/organize-after.md): the component object AND its `service --contains--> component` edge, written in ONE transaction, so a component created DIRECTLY always belongs to a service (owner ruling). Imports (discovery/accept, federation, overlay) call `createObject` directly and never reach this path, so they stay permissive by construction.

Modeled on `coordination/campaign-repo.ts`'s `proposeCampaign` — the same object + both-endpoint authz + edge + Decision shape (NOT campaign/change, which store targets as a properties array). The `contains` cardinality (one_to_many) plus migration 0022's partial unique index enforce one-service-per-component for free, and `createRelationship`'s endpoint-type check rejects a `service` ref that isn't a service.

### §16. M20.5 (ADR-0031 §6a) — THE SECOND CONTAINMENT ROUTE

M20.5 (ADR-0031 §6a) — THE SECOND CONTAINMENT ROUTE. `createObject` inherits from the `domain_id` parent; it cannot see this one, because the `contains` edge to `service` does not exist yet — it is written below, AFTER the object. So the container's locality has to be read here and passed in.

`service` is already loaded and type-checked above, so this costs no extra query. Combined with the caller's own declaration, mirroring §4's either-endpoint rule: a component is domain-local if it says so OR if the thing containing it is.

Note this is the reason `domainLocal` is threaded rather than inferred later: making the component local when the EDGE is created would be a shared -> domain-local flip, which §6 refuses permanently. It has to be true at create or never. M20.5 kept only the caller's own declaration here; M20.7 (ADR-0031 §6c) passes the container SEPARATELY so `createObject` can tell "the operator declared this" from "it followed its service". Folding them into one boolean, as M20.5 did, still produced a domain-local component but lost which of the two made it one — the entire question the provenance field answers.

### §17. Idempotent atomic assign-or-move of a component into a service

Idempotent atomic assign-or-move of a component into a service (M12 P5b, docs/proposals/ organize-after.md) — the one verb behind `PUT /components/{idOrUrn}/service`. It sets the component's sole `contains` parent to `serviceIdOrUrn` whether the component currently has NO service (ASSIGN — the 50-orphan homelab case), a DIFFERENT one (MOVE — re-parent), or the SAME one (NOOP). Idempotent-set (not a create-only "assign") is deliberate: bulk-organizing orphans must be safely re-runnable, and the generic `POST /relationships` already covers create-only-409.

MOVE is atomic (owner ruling Q6): the old `contains` edge is soft-deleted and the new one created in the SAME transaction, so the RBAC/policy/freeze walks that traverse `contains` (authz/resolve.ts, governance/policy-resolve.ts, graph/containment.ts) never observe the component orphaned — and the migration-0022 partial unique index (which filters `deleted_at IS NULL`) permits the new edge only because the old one is already soft-deleted within this tx. A two-request delete-then-create would momentarily strip the component from every scope; this closes that window.

Both-endpoint authority, but WIDER than create-strict: the component PRE-EXISTS (unlike `createComponentInService`'s fresh object), so the actor needs `relationship:write` over the COMPONENT and the NEW service, PLUS the OLD service on a move (it loses a child). Cloning create-strict's service-only check would under-authorize — assign needs 2 scopes, move needs 3. A component whose current `contains` edge is a federation replica cannot be moved locally: `deleteRelationship` refuses to mutate a read-only replicated edge (409), surfaced here unchanged.

### §18. THE SECOND, OPT-IN BAR

THE SECOND, OPT-IN BAR (proposal §9.2 door (c), owner ruling 2026-08-18). This verb is the `contains`-route move: the MOVED object is the component, the DESTINATION the new service or assembly. Checked here rather than only at the generic `/relationships` doors because this route never touches them — it calls `deleteRelationship`/`createRelationship` directly, which is the shape that let #244's containment fix ship inert on one of its three routes.

An ASSIGN (no current edge) is a move too under this bar, and deliberately: the component's governance reach changes exactly as much when it acquires its first container as when it swaps one. `governance/move-enforcement.ts` decides whether any rung applies; a deployment with none pays one singleton read.

## `apps/server/src/graph/container-delete-guard.integration.test.ts`

### §19. Deleting a container that still has children is refused

RULING 2 — DELETING A CONTAINER THAT STILL HAS CONTAINMENT CHILDREN IS REFUSED. (docs/proposals/governance-reach-on-containment-move.md §9.3; owner ruling 2026-08-18, Q3-A.)

`deleteObject` already COUNTED three dependent routes (`governance/governance-reach.ts`'s `countContainmentDependents`) and used the count only to decide whether to record a reach Decision — it never refused. The guard that DID refuse covered route 1 (`objects.domain_id` children) alone; route 2's children were left live and detached, and placements — which name their endpoints by JSON property rather than by an edge the cascade can see — were left live and DANGLING. The owner retired that asymmetry: all three routes now block, and the dangling-placement gap closes by refusal rather than by cascade.

Route 1's own cases stay in `graph/domain-delete-orphan-guard.integration.test.ts` (whose CONTROL for route 2 is inverted there, with the reason written where the old reason was). THIS file covers the widening and — the part that actually needs protecting — THE CARVE-OUTS.

MUTATION LOG — each mutation applied ALONE, run, reverted, restoration verified with `cmp`
m7  drop the widening (guard only `domainChildren`, as before) → RED: "a service with components", "an assembly with components", "a component with a live placement", "a deployment-target with a live placement" m8  drop the `!removedForeignShadow` / `!input.federationImport` carve-out → RED: "a federation IMPORT delete with children still lands", "removing a foreign SHADOW row with children still lands"

## `apps/server/src/graph/containment-depth-doors.integration.test.ts`

### §20. THE DOOR INVARIANT

THE DOOR INVARIANT (owner ruling 2026-08-18; ADR-0037 Consequences): after every write, every live row's LONGEST containment route to the org root — over all four routes, the placement pair counted — is at most `CONTAINMENT_WALK_MAX_DEPTH` (10) hops. A write that would leave ANY live row past it is refused at the door with ONE message shape (400, "would exceed the supported containment depth (10 hops, ADR-0037)"), the resulting depth named, the subtree named when the subtree is the reason.

WHY. Since ADR-0037 every recursive walk refuses LOUDLY when a row exists past the bound. That made a row AT hop eleven a row nobody could govern (`containmentChain` throws for it — policy matching, freeze scoping, gate evaluation, ADR-0032 enablement) and, when the eleven-hop route was its ONLY route, a row nobody could read, rename or move back either (RBAC's nothing-found becomes the loud refusal). Measured before this round on the real HTTP doors: `POST /domains {domainId: <a domain at hop ten>}` answered 201, and the org-root admin's own next `GET` of the row and the `PATCH` that would have moved it back both answered **409**. The doors were letting the walks' ceiling be crossed by exactly one row, because the create-side check had been carved out against the PRE-ADR-0037 silently-truncating walk (`graph/containment.ts`'s retired `childIsNew` reasoning).

THE FOUR DOORS, and what each case here pins (see `assertContainmentDepthAdmits` for the shared arithmetic `hops(parent) + 1 + height(child) > bound`):

```text
D1  `createObject` `domain_id`     — a domain / service / component created under a hop-ten
                                     parent (childIsNew: height 0)
D2  `updateObject` `domain_id` MOVE — the moved row's SUBTREE counts (height walked downward),
                                     with one case per ARM of the downward walk: `domain_id`
                                     (D2-subtree), `contains` read forwards (D2-contains-arm),
                                     a placement naming the row as target (D2-target-arm); the
                                     component arm is D3's PUT-service case
D3  `contains` edge                 — a component attached to a hop-ten container, an existing
                                     component (with a placement under it) moved to a hop-nine one
D4  a placement's PAIR              — a placement of a hop-ten component, or at a hop-ten target;
                                     and its one bypass, federation hand-fill of a `placement`,
                                     now refused as the fifth pair-bound door
```

Every refusal has a SHALLOW CONTROL that succeeds, so a refuse-everything mutation goes red; and a row at EXACTLY the bound is asserted readable, because ten is a ceiling, not a ban.

MUTATION LOG (each applied ALONE, then reverted — recorded in the round summary too): | skip refusal 2 when `childIsNew` (the pre-ruling carve-out) | D1 ×3, D4 ×2 and the IaC twin go red | | delete the downward walk in `assertContainmentDepthAdmits`   | D2-subtree, D2-contains-arm, D2-target-arm and D3-subtree go red | | neuter the downward walk's `contains` arm (`type_id = 'contains-never'`) | D2-contains-arm goes red (was 29/29 green before it existed — verifier M6b) | | drop the downward walk's `deploymentTargetId` branch (`OR FALSE`)  | D2-target-arm goes red (was 29/29 green before it existed — verifier M6c) | | drop the downward walk's `componentId` branch                    | D3-subtree goes red | | drop the downward walk's `domain_id` arm                         | D2-subtree goes red | | delete the `assertContainmentDepthAdmits` call in the `contains` door | D3 ×3 go red | | delete the pair loop in `createPlacement`                    | D4 ×2 go red | | delete the pair-bound refusal in `handFillObject`             | the hand-fill case goes red (201, a live placement row) | | refuse everything (`rowDepth > 0`)                            | every control goes red |

Run from `apps/server` with the integration config and READ THE FILE LIST vitest prints — the default config excludes `*.integration.test.ts` and a scoped run without it reports green having executed nothing:

```text
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true \
  npx vitest run --config vitest.integration.config.ts \
    src/graph/containment-depth-doors.integration.test.ts
```

### §21. The two D2 cases above hang the moved row's subtree off `domain_id`

The two D2 cases above hang the moved row's subtree off `domain_id` (D2-subtree) or off nothing (D2-row). The downward walk has THREE MORE arms — `contains` edges read forwards, and a placement naming the row as component or as target — and each arm needs a case whose subtree hangs off THAT arm alone, or deleting the arm leaves the suite green while a hop-eleven row lands (verifier mutations M6b/M6c, 2026-08-18: neutering the `contains` arm or the `deploymentTargetId` arm left 29/29 green; only the `domain_id` and `componentId` arms had a pin). The `componentId` arm is pinned by D3's PUT-service case below; these two pin the other two.

## `apps/server/src/graph/containment-parent-authz.ts`

### §22. The one place a caller's `domainId` becomes a containment parent

THE ONE PLACE A CALLER-SUPPLIED `domainId` BECOMES A CONTAINMENT PARENT.

`objects.domain_id` is not an ordinary column, and the two things that make it special are both invisible at the call site that writes it:

1. **It is authorization-bearing.** RBAC scope expansion runs strictly UPWARD (`authz/resolve.ts`'s `scopeExpandCte`), so an object's containment parent decides *who else* holds authority over it. Re-parenting X under V hands every holder of a binding at-or-above V custody of X. A door that authorizes a move only at X therefore lets an actor whose entire authority is "write this one object" plant it inside a stranger's subtree — a privilege ESCALATION dressed as a field edit. A move is a write at two places and must be authorized at both ends. 2. **`null` is not a containment parent.** The column has no FK and no CHECK (`drizzle/0001_graph_core.sql:32`), so `NULL` is writable — and a row with `domain_id IS NULL` is DETACHED: its scope expansion terminates at itself, so no ancestor binding, *not even the org root Owner's*, can ever reach it again. It cannot be read, edited, moved back or deleted through the API by anyone. Governance does not stop, either: policy matching reads only `properties.scope` and never the policy row's own placement (`governance/policy-scope-authz.ts` documents that at length), so a detached row keeps being governed while becoming ungovernable. `NULL` therefore means exactly one thing in this system — "I AM the org root" — and is written by exactly one caller, org bootstrap (`auth/local-auth.ts`).

## What a wire `null` means, and why

**`null` on a request body means "the default containment parent" — the org root — never "detach".** Two doors already coerced it that way by hand (`routes/typed-registries.ts` and `routes/objects-generic.ts`, both POST: `containmentDomainIdFromWire(...) ?? undefined`) and four did not (both PUT create branches, `POST /components`, and `PUT /components/{urn}`'s create branch), while every update door wrote the `null` straight through. That asymmetry — not either meaning on its own — was the defect: the same body produced an org-root child through one door and an unreachable orphan through another.

Of the two candidate meanings, "default parent" is the only one that is expressible. "Detach" has no representation in a model whose authority, containment and audit chains all terminate at the org root, and a verb that produces a row nobody can subsequently touch is not a feature. Note the meaning is *not* "unspecified": on an UPDATE, an omitted `domainId` leaves the parent alone, while an explicit `null` moves the row to the org root — and, being a move, is authorized there.

## Why a helper called by every door rather than a check inside the repo

The same split `federation/domain-local.ts` argues for, and for the same reason: **authorization at the door, invariant at the repo.** `updateObject`/`upsertObjectByUrn` are also the path the federation importer, IaC apply and internal machinery take, and their `actorObjectId` is a synthetic subject that holds no bindings — running an `authorize()` down there would abort every import rather than protect anything. What the repo owns is the invariant half: `resolveContainmentParent` is what rejects a `domainId` that does not name a LIVE object in this org, and it is called from here, from `createObject`, and from `updateObject`.

THAT THIRD CALL SITE WAS MISSING until it was measured, and the gap is worth recording because its shape recurs. This paragraph asserted the repo owned the invariant half while only `createObject` actually called the function — so the guarantee held for every caller that arrived through a door here, and for nobody else. `coordination-as-code/plans-repo.ts` is the "nobody else": it resolves a manifest's parent ONCE at PLAN time, persists the resolved id in the plan diff, and replays that stored pointer through `updateObject` at APPLY time without ever calling this helper. Soft-delete the parent in the window between the two requests and the tombstone was written onto the row; the org-root admin's own next GET, PATCH and DELETE of it then answered 403, permanently. The walk (`assertRootedContainmentParent`) does not substitute for this check — it seeds `containmentChain` with the parent row UNFILTERED by `deleted_at`, on purpose, so a dead parent with live ancestors is pronounced rooted. `graph/objects-repo.ts`'s `updateObject` carries the full account; `routes/containment-parent-liveness.integration.test.ts` pins it.

The risk that a NEW door forgets to call this is handled the way this codebase already handles it for ADR-0022 and ADR-0031's route sets — by a census test that enumerates every door whose body schema admits `domainId` and asserts each one refuses a move it must refuse (`routes/containment-move-authz.integration.test.ts`, plus `routes/containment-parent-doors-census.integration.test.ts` for the doors it does not name).

## What this function does NOT own

The ROOT-REACHABILITY invariant — no cycle, and the destination itself reaches the org root — is subject-free and therefore lives at the repo, in `createObject` AND `updateObject`, via `graph/containment.ts`'s `assertRootedContainmentParent`. It is called from here too on the MOVE branch, so a door gets the diagnostic 400 before spending an authorization round trip, but the repo calls are the ones that cover `coordination-as-code/plans-repo.ts`, which both creates and re-parents objects without ever coming through here.

The CREATE branch of this function deliberately does NOT call it — `createObject` does, and that is the only placement that covers apply. It went in late: the invariant shipped on the move path alone, on the reasoning that "a fresh id cannot already be an ancestor". That covers the CYCLE refusal and nothing else; root-reachability is a property of the PARENT's chain, so a create under an unrooted parent produced the same unreachable row through a different verb — and the DEPTH bound (owner ruling 2026-08-18) is a property of the parent's chain plus the row being written, so a create under a parent at exactly the bound planted a row past it. `createObject` runs both on a create (`childIsNew` skips only the cycle question). `routes/containment-move-cycle-and-source-authz.integration.test.ts` pins the move half, `routes/containment-root-source-and-create-rooting.integration.test.ts` the create half, and `graph/containment-depth-doors.integration.test.ts` the depth bound at every door.

### §23. The row as it stands, or `undefined` when this write CREATES it

The row as it stands, or `undefined` when this write CREATES it.

A create needs no destination check *here*: every create door already authorizes at the resolved parent, because for a new object that parent is the only scope there is. Passing the row rather than a boolean keeps the two questions this function asks — "is this a move?" and "would it make the row its own parent?" — answerable without a second lookup.

### §24. Resolves a caller's `domainId`, authorizing a move when it is one

Resolves a caller-supplied `domainId` into the value to write, authorizing it as a MOVE when it is one. Returns `undefined` when the caller named no parent — which `createObject` reads as "default to the org root" and `updateObject` reads as "leave the parent alone".

### §25. A CYCLE IS A DETACH WITH NO `null` IN IT

A CYCLE IS A DETACH WITH NO `null` IN IT. This used to read `destination === current.id` — a depth-1 self-parent — and a two-hop loop walked straight past it: move X under its own child C and `X -> C -> X` has no org-root ancestor at all, so both rows leave every authority, governance and audit chain permanently. Measured on the real doors before the fix: the move answered 200 and the ORG-ROOT ADMIN's own next GET/PATCH/DELETE of both rows answered 403, forever.

The full walk lives in `graph/containment.ts` (with the depth bound, and failing CLOSED at it), and `updateObject` calls the SAME function as the repo-side invariant. Called here as well rather than only there because this is the doors' choke point: an operator gets the 400 that names the loop before an authorization round trip, and a door that grows a new create/update branch inherits the refusal from the helper it already had to call. Since the depth-bound half walks the moved row's SUBTREE too (owner ruling 2026-08-18), a refused-for-depth move pays that bounded downward walk here and, if it gets that far, again in `updateObject`; a move is rare enough that the diagnostic-before-authz ordering is worth the second bounded query.

### §26. The org root is not a destination that gains custody

THE ORG ROOT IS NOT A DESTINATION THAT GAINS CUSTODY, and this is the MIRROR of the source-side exemption below — the same argument, run in the other direction, and it had never been made.

The destination check exists for one stated reason (module doc §1): "re-parenting X under V hands every holder of a binding at-or-above V custody of X", so an actor whose whole authority is "write this one object" must not be able to plant it in a stranger's subtree. Take V = the org root and that premise is FALSE:

```text
- AFTER the move, X's containment chain is exactly `X -> org root`, so the holders who gain
  custody are the org root's.
- BEFORE the move, X's chain already terminated at the org root — that is the ROOT-REACHABILITY
  invariant `assertRootedContainmentParent` enforces on every `domain_id` write, on the create
  half (`objects-repo.ts::createObject`) as well as the move half. So the org root's holders
  ALREADY held custody of X.
```

The set of principals with custody of X therefore SHRINKS across this move — it goes from "everyone at-or-above any node on `X -> S -> ... -> root`" to "everyone at-or-above `X -> root`", a subset — and a move that can only ever remove custodians is not the escalation this check stops. Every other destination genuinely adds one, which is why the exemption is the org root and nothing else.

WHAT THIS IS NOT. It is NOT "the destination is already on X's chain", which is the general form of the argument (moving X up to its own grandparent grants nobody anything either). That generalisation is deliberately not taken: proving it needs a second containment walk — of the SOURCE's chain — on every move, and the org root is the one destination that is on EVERY rooted row's chain without walking anything. Simplicity over the wider exemption (charter priority 1).

WHERE THE PROOF IS ONE STEP WEAKER THAN THE SOURCE-SIDE ONE, stated rather than glossed: the source-side exemption proves BOTH its halves locally (the row's current parent IS the root by hypothesis, and `assertRootedContainmentParent` has just proven the destination reaches the root). This one leans on the global invariant for its "before" half. The residual case is a row whose chain does NOT reach the org root — a legacy row, or one planted before these doors were closed. Moving such a row to the org root REPAIRS it: the org root's holders gain custody of something no principal above it could previously reach at all, which is a strictly better state and the only way out of it for the one principal bound directly at the row. A repair is not an escalation, so the exemption holds there too — it just holds for a different reason.

THIS IS NOT A FREE MOVE. The SOURCE check below still runs, and `current.domainId` on any row this exemption applies to is a real container (the `null` and `=== orgId` cases have already returned above — a restatement and a cycle respectively). So promoting a row to the top level requires `permission` at the object AND at-or-above the container it is leaving: exactly "an actor who fully owns the subtree may move their own object out of it", which is what was being refused. `routes/containment-root-destination-authz.integration.test.ts` leads with that SUCCESS case, because an over-broad refusal and a deliberate one look identical from a failing test and a suite made of refusals cannot tell them apart.

### §27. THE OTHER END

THE OTHER END. The module doc has said "a move is a write at two places and must be authorized at both ends" since this function existed, and only ONE end was ever checked. Authority expands strictly UPWARD (`authz/resolve.ts`), so holding it AT an object implies nothing whatsoever about the container the object currently sits in: an actor bound narrowly at X could take X out of a container they hold nothing at, which is the mirror image of the escalation the destination check above exists to stop — the source container loses a child, and its holders lose custody, without anyone who holds it consenting.

Same shape as `graph/components-repo.ts`'s `setComponentService` ("the OLD service too on a move (it loses a child)"), which this module's doc already cites as its precedent. Held to the SAME permission bar as the object and the destination, never a weaker one.

TWO SOURCES ARE EXEMPT, AND THE SECOND ONE IS NOT AN EXCEPTION — IT IS THE RULE APPLIED. (The DESTINATION has the mirror of the second one, for the mirror reason — see the block above. This one shipped a round before that one, and the gap between them is the whole lesson: the argument was made at one end of a check that this module's own doc calls two-ended.)

- `current.domainId === null` means there IS no source container: the row IS the org root. Nothing to authorize at; the destination check above is the whole of it.

- `current.domainId === orgId` — the org ROOT OBJECT — is exempt because the org root cannot lose custody of anything that stays inside the org. This half was missing, and it did not refuse an edge case: `createObject` defaults an unnamed `domainId` to the org root, so MOST objects sit there, and requiring authority at the source made every ordinary reorganisation out of the root demand ORG-ROOT authority — an actor who owns the destination outright, and the object outright, was refused. Over-broad in exactly the direction a suite of refusals cannot see, which is why `routes/containment-root-source-and-create-rooting.integration.test.ts` leads with the SUCCESS case.

```text
 It is provable, not a judgement call, and the proof is two statements above:
 `assertRootedContainmentParent` has just established that the DESTINATION reaches the org
 root. So the org root is on the moved row's chain after the move exactly as it was before —
 the premise of this whole check ("the source container loses a child, and its holders lose
 custody") is FALSE for the org root and for no other container. `resolveContainmentParent`
 additionally refuses any `domainId` outside this org, so there is no destination for which
 that reasoning could fail.
```

```text
 Same shape as the precedent this module cites: `components-repo.ts`'s `setComponentService`
 adds the old parent to its scope set only `if (currentEdge)` — a component with no service is
 an ASSIGN, not a move out of anything. The org root is this model's equivalent of "not in a
 container yet", and it is written as an id rather than as `null` only because ADR-0021 D4
 makes the root an ordinary object.
```

`input.orgId` IS the org root object's id (`auth/local-auth.ts`'s `ensureOrgRootObject` creates it with `id: orgId`) — the same identity every door already relies on writing `scopeObjectId ?? orgId`, and the one `assertRootedContainmentParent` looks for on the chain.

### §28. THE SECOND, OPT-IN BAR

THE SECOND, OPT-IN BAR: `governance:move` (proposal §9.2 door (a), owner ruling 2026-08-18).

Runs AFTER the `permission` pair above, never instead of it — an enabled rung ADDS a demand, it never relaxes one. On every deployment with no rung set (all of them until an operator sets one) this is one singleton read plus two bounded chain walks and no behaviour change at all, which is why the four protected move-authz suites keep their outcomes.

AND ITS ORG-ROOT RULE IS THE OPPOSITE OF THE TWO EXEMPTIONS ABOVE, deliberately. Both exemptions here are proved from CUSTODY: the org root's holders already hold every rooted row, so a move to or out of the root can only shrink the custodian set. `governance:move` is not about custody but about governance REACH, which runs with containment — so moving a row out of a governed subtree up to the org root is exactly the reach reduction the permission exists to gate, the archetypal case rather than an edge case. The two checks follow opposite rules at the same node because they are asking different questions; `governance/move-enforcement.ts`'s header carries the full argument, and cross-references this block.

## `apps/server/src/graph/containment.ts`

### §29. THE containment walk

THE containment walk — "what contains this object?" — in ONE place.

There used to be three row-returning copies of this concept (policy-resolve.ts's `containmentChain`, and gate-orchestrator.ts's freeze-scope and approval-scope walks). Migration 0021 added the `contains` edge; the follow-up taught only the policy copy to walk it, and the two gate-orchestrator copies silently kept their old domain_id-only walk. The result was a service-scoped freeze that failed OPEN and a `requireApprovals: {scope:"service"}` that failed CLOSED — opposite symptoms, one root cause: divergent copies of one idea. Hence one function.

`authz/resolve.ts`'s `scopeExpandCte` deliberately stays separate and MUST be kept in sync by hand: it is a SQL FRAGMENT composed into a single larger query that joins `role_bindings`/`roles`, so the deny-override decision happens in one round-trip. It cannot consume row output from here without splitting that query in two. It walks the same two routes with the same depth bound — if you change the routes here, change them there too. Routes 3 and 4 below do NOT have to be hand-synced: they are exported as ONE SQL fragment composed into both walks, because a route added twice by hand is exactly how routes 1 and 2 drifted in the first place. Route 4 arriving after route 3 is the proof it was worth doing — adding it touched the fragment, not the two walks.

THE DOWNWARD DIRECTION HAS ONE DEFINITION OF THE ROUTE SET: `containmentChildrenSql` — with one deliberate, bounded exception named below. Not "exactly one definition" full stop: an earlier draft of this header said that, and it was false while the delete guard still hand-typed arms 1 and 2. Stated precisely because this whole module exists to stop a claim of uniqueness standing in for the thing itself. Its consumers, ALL of them:

```text
- `containmentSubtreeExceeds` — the depth doors (recursive);
- `authz/readable-scope.ts`'s `descendSql` — which objects a role binding REACHES
  (recursive; role-model.md §8.2);
- `governance/governance-reach.ts`'s `countContainmentDependents` — how many rows a container's
  tombstone detaches (ONE LEVEL, counted);
- `graph/objects-repo.ts`'s container-delete guard — the same one level, ENUMERATED per route
  so the refusal can name the blockers. It composes the routes-3+4 half,
  `placementNamesObjectSql`, rather than the whole fragment, because it needs each route's
  rows separately and with `urn`/`type_id` attached. **Arms 1 and 2 are still hand-typed there**,
  and calling them "a plain test no guard can spell wrong" would be the same overconfidence that
  produced the drift: `countContainmentDependents`'s arm 2 DID spell it wrong — it counted
  `contains` EDGES without joining the child live, so a live edge to a tombstoned child was a
  dependent, and a container whose only child was already gone wrote a hash-chained audit event
  claiming it "detached 1 contained object(s)". The delete guard's arms 1 and 2 happen to be
  correct today (verified 2026-08-26; arm 2 there does join the child live) — that is a
  measurement, not a property of their being short.
```

⚠️ THE LAST TWO ARE ONE LEVEL, NOT RECURSIVE, AND THAT IS HOW THEY HID. A census run for `WITH RECURSIVE` — or for "the downward walk" — returns the first two and concludes there is one definition. Both of the others were hand-typed copies of these same three arms, found only by censusing the PROPERTY ("code that enumerates the rows contained by a given row") over each route's predicate. BUILD_AND_TEST.md §4.4: a bug found by a symptom is one instance; the property is the class. If you add a route here, search `domain_id =`, `type_id = 'contains'` with a `from_id`, and `type_id = 'placement'` — filterless, `grep -rna` — not `WITH RECURSIVE`.

Both directions must stay inverses of each other: a route this file walks up and that fragment does not walk down means an object `authorize()` admits is missing from the list that should contain it. That equivalence is not left to review — `authz/readable-scope.integration.test.ts` asserts `hasPermission(o)` iff `o ∈ readableSet(subject)` over every live object of a fixture that exercises all four routes.

### §30. ROUTES 3 AND 4, shared verbatim by BOTH containment walks

ROUTES 3 AND 4, shared verbatim by BOTH containment walks: **a `placement` is contained by the component it places AND by the deployment-target it names** (ADR-0026). Both endpoints of the pair are containing scopes, which is what makes a placement a pair rather than a component in disguise.

ROUTE 4 (the deployment-target) IS AN OWNER DECISION, NOT A BUG FIX — 2026-08-02
It was found the same way as route 3 and deliberately NOT shipped with it, because unlike route 3 it does not restore lost gating — it starts gating something that never was. The estate holds 12 `required` `prod-gate*` policies; eleven are component-scoped, and the twelfth is scoped to the `prod (DOKS hosted)` deployment-target and had NEVER matched anything. That target is nobody's `domain_id` (0 rows) and its only incoming edges are `placed_at`/`hosted_on`, neither a containment route — so a `required` prod gate sat inert, looking exactly like a gate that worked.

Landing this route makes it fire: every stage-shaped release to prod now waits on that policy's approval. A change that newly BLOCKS cannot be slipped in under a fix, so it was escalated and approved on its own terms. Deliberately NOT extended to `hosted_on` from a legacy component-shaped wave target, which would change behaviour on the estate exactly as it runs today.

What it also buys: "freeze prod" becomes expressible for the first time — `containmentScopeIds` now puts the deployment-target on every placement's chain, so a freeze scoped at a stage catches everything deploying there. Before this there was no way to say it at all.

Authority follows the same chain (`authz/resolve.ts` composes this identical fragment), so a role bound at a deployment-target now reaches the placements there. Measured blast radius on the live estate: 0 of 1 role bindings are scoped to a deployment-target, and no deployment-target has an incoming `contains` edge, so this route cannot drag a service in behind it.

WHY ROUTE 3 (the component) EXISTS — WHAT SILENTLY STOPPED WORKING WITHOUT IT
Under stage-shaped plan compilation a `change_wave_targets.target_object_id` is a PLACEMENT, not a component (`plan-service.ts`'s `resolveStagePlacements`). Every wave-boundary governance decision is derived from that id's containment chain — `matchPoliciesForTargets`, `containmentScopeIds` for freezes, `resolveApprovalScope`, and `resolveEffectiveScanThreshold`'s tier labels all walk it.

A placement's chain without this route is `[org root, placement]` and nothing else: its `domain_id` is the org root, and it has NO incoming `contains` edge (measured on the live estate — 61 placements, 0 incoming `contains`). So the moment a wave target became a placement, every component-scoped and service-scoped policy stopped matching at the wave boundary and every service-scoped freeze failed OPEN. On the live estate that is 11 `required` component-scoped prod-gate policies that would have quietly stopped gating prod — the same failure mode, in the same file, that this module's header records being paid for once already.

DIRECTION, AND WHY IT IS SAFE
Route 2 walks `contains` BACKWARDS because that edge is registered service -> component. The placement edges point the other way (`placement -places-> component`), so these routes read FORWARDS — and the asymmetry route 2 relies on is preserved: a scope at a component reaches its placements, a scope at a placement never reaches its component's siblings or its service directly (it reaches them only by continuing up through the component, which is the whole point).

They read the PROPERTIES, not the `places`/`placed_at` edges, because ADR-0026 D17 makes the properties the source of truth for the pair and the edges derived — the same half `binding-resolution.ts`, `plan-service.ts` and `regional-executors.ts` read. They also survive a federation bundle whose `object_upsert` lands before its `relationship_upsert` siblings, where the edges do not exist yet.

The CASE guard is not decoration. `createObject` is called directly by journal replay, which does not go through the typed `/placements` route, so a corrupt or hostile peer could ship a placement whose `componentId` is not a UUID. A bare `::uuid` cast would then throw inside EVERY containment walk in that org — one bad row taking out all governance evaluation, fail-open by way of a crash. `CASE` guarantees the ordering a WHERE-clause guard does not, so a malformed value yields no ancestor instead of an error. Route 4 needs it for the SAME reason and gets it the same way: one fragment emitting both parents, so neither the guard nor the route can be added to one walk and forgotten in the other.

Both parents sit at the SAME walk depth from the placement. That is the documented cross-KIND depth tie (see `containmentChain` below), not a new hazard: it is inert for every current consumer, and `nearestAncestorOfKind` is unaffected because it only ever compares ancestors of one kind.

### §31. ROUTE 3 ALONE

ROUTE 3 ALONE — a placement's COMPONENT, exactly one row.

`coordination/service-board.ts` wants this and NOT the pair: it LEFT JOINs LATERAL to map a placement wave target back to the component whose column it fills, so a second row carrying a DEPLOYMENT-TARGET id would be a wrong-kind answer in a `component_id` column.

Measured, not assumed: swapping that call site to the pair fragment leaves its tests GREEN. The extra row really is produced — arm 1's `IN (componentIds)` filter then discards it (a deployment-target id is never in that list) and `DISTINCT ON (component_id)` collapses the rest. So the two fragments are kept distinct for the honest reason rather than the dramatic one: the board asks a narrower question, and answering it correctly should not depend on a downstream filter happening to throw the wrong row away. That accident holds only while `componentIds` contains components exclusively.

The pair fragment below is BUILT from this one, so the component route keeps a single definition and cannot drift across the three call sites.

### §32. ROUTES 3 + 4 AS A PREDICATE OVER A PLACEMENT ROW

ROUTES 3 + 4 AS A PREDICATE OVER A PLACEMENT ROW — "does this placement name `objectIdSql` as either endpoint of its pair?" — the downward reading of `placementParentsSql`, in ONE place.

Exported for the same reason `placementParentsSql` is: the pair is the route most often written out by hand, because it is the only one that lives in JSON rather than in a column or an edge. Two consumers compose it — `containmentChildrenSql`'s arm 3 and `graph/objects-repo.ts`'s container-delete guard — and until 2026-08-26 both of the ONE-LEVEL consumers (that guard and `governance/governance-reach.ts`'s `countContainmentDependents`) carried their own copy, spelled as a RAW TEXT comparison with no `UUID_TEXT_PATTERN` guard and no cast.

WHY THE CAST FORM IS THE RIGHT ONE, and the text form the drift — MEASURED, PostgreSQL 16:

```text
  '0191F1E2-AAAA-7000-8000-0000000000AA'::uuid = '0191f1e2-…-aa'::uuid   ->  TRUE
  '0191F1E2-AAAA-7000-8000-0000000000AA'       = '0191f1e2-…-aa'         ->  FALSE
```

`uuid` equality is case-insensitive and `text` equality is not, while every id this is compared against arrives from a `uuid` column and is therefore lower-case. So an upper-case-hex `componentId` is a PARENT going up (`placementParentsSql` casts, because it must join `objects.id`) and, under the text form, was NOT a child coming down — the two directions disagreeing about which values count, which is precisely the failure class the shared fragment exists to end. The INDEX NOTE on `containmentChildrenSql` records the same trade being decided the same way against migration 0051's text index.

The `CASE` guard is load-bearing for the reason `placementEndpointParentSql` gives above: a malformed value must yield NO MATCH, never an error, because a bare `::uuid` on a hostile or corrupt federated row would throw inside every walk in the org.

`propertiesSql` is spliced in unqualified — pass the caller's own qualified expression (`sql\`pl.properties\``, `sql\`${objects.properties}\``), not a bare `properties`.

### §33. Target up to org root, walking four containment routes

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

### §34. THE CONTAINER TYPES

THE CONTAINER TYPES — object types that may hold components (and each other, subject to the pairwise refusal below).

ONE constant, and every "is this a container?" question routes through it. The alternative — comparing `typeId === "service"` at each site — is how a level gets added to the model and applied at only some of the places that care, which is the failure mode this repo has been bitten by repeatedly (`bindings[0]`, the `currents` collapse, ADR-0027's rung at one of two exits). A single constant makes the census a definition rather than a search.

Note what this does NOT license: membership here says a type may CONTAIN, not that any pair is legal. `assembly -> assembly` is refused at write time (`relationships-repo.ts`), because `relationship_types` holds flat from/to arrays and cannot express a pairwise rule — see migration 0054's header.

### §35. THE ONE DEPTH BOUND every recursive graph walk shares (ADR-0037)

THE ONE DEPTH BOUND every recursive graph walk shares (ADR-0037) — and the reason it is loud.

Six sites recurse with this bound (filterless census, 2026-08-13): this file's `containmentChain`, `named-queries.ts`'s `groupByDomain`, `policy-resolve.ts`'s `isMemberOf`, and `authz/resolve.ts`'s three walks (two `member_of` expansions + `scopeExpandCte`, the hand-synced copy this file's header warns about). Before ADR-0037 each carried a literal `10` and STOPPED EXPANDING silently at it — and `containmentChain`'s depth inversion then presented the outermost SURVIVOR as the org root, so an over-deep chain didn't look broken, it looked like a shallower org whose root was a mid-level domain. Org-scoped required policies silently stopped matching: the ADR-0026 failure shape, measured as reachable through the public API once nested domains landed (~10 domain levels + one component).

The fix is not a bigger number — it is that hitting the bound is now an ERROR, detected by walking ONE level past it (`WALK_TRUNCATION_PROBE_DEPTH`) and refusing if anything is found there. Raising capacity later is a one-line change HERE, and only here; a raise that edits any single call site instead is the six-copies bug this constant exists to end.

It is a real ceiling, not a formality, and the WRITE DOORS are what keep every live row under it (owner ruling 2026-08-18, ADR-0037 Consequences): `assertRootedContainmentParent`, `relationships-repo.ts`'s `contains` door and `placements-repo.ts`'s pair door all refuse any LOCAL write that would leave a live row past the bound — see `assertContainmentDepthAdmits` for the arithmetic. The federation-import paths are CARVED OUT (ADR-0037 Consequences: the receiver does not referee a peer-authored containment, and one refusal there is a per-CHANNEL failure for a per-row fault), so a replica can still land past the bound; the doors convert the walk's loud refusal into their own 400 for a local write UNDER such a row (legacy or imported) rather than ever seeing a shortened ancestry — `containmentParentChainForDoor`.

### §36. The phrase every DOOR refusal carries

The phrase every DOOR refusal carries — a write that WOULD put a live row past the bound. It is deliberately NOT a substring match for `WALK_DEPTH_EXCEEDED_PHRASE` ("would exceed" vs "exceeds"): `isWalkDepthExceeded` reads the walk's phrase, and a door 400 must never be mistaken for a walk 409 by that marker or by an operator. The bound and the ADR are still named, so both refusals tell one story.

### §37. THE DOWNWARD FRAGMENT

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

### §38. THE DOWNWARD WALK

THE DOWNWARD WALK — "how deep is the subtree under this row?" — `containmentChildrenSql` (the exact inverse of the four routes `containmentChain` walks up) recursed, bounded, live rows only.

Exists for ONE caller, `assertContainmentDepthAdmits`: a MOVE takes the moved row's whole subtree with it, so the door has to know how far below the row the deepest live descendant sits. It used to carry its own hand-typed copy of the three arms, which is why the fragment above was exported rather than another one written for the read surface. (It was called "the third copy" here; a census by property later found five — see the fragment's own note.)

Every CHILD is filtered `deleted_at IS NULL` (as every PARENT is upward): a tombstoned descendant is on no walk and costs no depth. The seed is filtered live too — the callers pass a row they have just loaded live, and a deleted seed has no subtree worth counting.

BOUNDED at `budget + 1` levels and answers a yes/no question, on purpose: the caller only needs to know whether the subtree is TALLER than the budget it has left, and a row found at depth `budget + 1` proves that without walking the rest. The bound literal is `sql.raw` for the reason `authz/resolve.ts` gives at its own walk (an untyped `$n` against a recursive CTE's depth column).

`UNION` (not `UNION ALL`), and MEASURED rather than assumed, because the obvious justification is wrong: the recursive term's rows are `(id, depth)` PAIRS, so `UNION` can only collapse a row reached by two routes AT THE SAME DEPTH (two services both containing one component). A component reachable via its domain at depth 1 AND via its service at depth 2 is TWO rows under `UNION` just as it is under `UNION ALL` — measured on PostgreSQL 16, identical output for that shape, and its subtree walked twice either way. That case is handled by `MAX(depth)` keeping the LONGEST route per row, which is what the invariant counts; `UNION` is what stops the same-depth fan-in from multiplying. Neither is what terminates the walk — the `depth <` guard is, which is also why a self-parented legacy row (`domain_id` = own id) costs `probeDepth + 1` rows and no more.

`budget` is never negative here: the ONE caller, `assertContainmentDepthAdmits`, refuses `rowDepth > MAX` BEFORE computing `budget = MAX - rowDepth`, so a parent at the bound never reaches this walk (a "negative budget" branch used to sit here as a `return true` — dead by that ordering, and a verifier measured that inverting it left the whole suite green; a claim no test can hold to is not kept as behaviour).

### §39. The parent's chain, with the hop count a door needs

The parent's chain, AS A DOOR NEEDS IT: the walk plus the number of hops the parent sits from the org root, with the walk's own ADR-0037 refusal converted into the door's 400.

`containmentChain` INVERTS depth on the way out (0 = topmost ancestor found, max = the target itself, which the recursive walk reached at raw depth 0), so the largest returned depth is exactly how many hops the walk took — the LONGEST route to the root when the chain is a DAG, which is the route the invariant counts.

THE CONVERSION BRANCH: since ADR-0037 the walk REFUSES past the bound instead of returning a truncated chain. A parent whose own chain is already past it is a row that was planted below the doors (legacy, or imported under the `federationImport` carve-out); the door answers with its own 400 that names the container and what a row under it would cost, rather than let the walk's 409 speak for a write it does not know about. The depth bound and the ADR are still named, so an operator meets one story from either side. This message keeps the WALK's phrase on purpose — it is the one door refusal that IS the walk refusing — where every other door refusal carries `CONTAINMENT_DEPTH_DOOR_PHRASE`.

### §40. THE MESSAGE STATES THIS BRANCH'S OWN CONDITION

THE MESSAGE STATES THIS BRANCH'S OWN CONDITION — the container is ALREADY past the bound (a legacy or imported row the doors never saw), so a row under it would be past the bound on that route and every walk that reads it refuses. It does NOT talk about cycles (this helper now serves the CREATE doors too, where the cycle question is deliberately not asked) and it does not claim the org root is missing (refusal 3's condition, not this one's) — an earlier wording did both, lifted verbatim from the move-only era.

### §41. THE DOOR INVARIANT'S ARITHMETIC, in one place

THE DOOR INVARIANT'S ARITHMETIC, in one place (owner ruling 2026-08-18; ADR-0037 Consequences):

hops(parent) + 1 + height(child) > CONTAINMENT_WALK_MAX_DEPTH   =>   refuse (400)

The child would sit at `hops(parent) + 1`; its deepest live descendant (over the inverse of the same routes, `containmentSubtreeExceeds`) at `hops(parent) + 1 + height(child)`. Every live row must reach the org root within the bound over its LONGEST route, or the walks that read it refuse loudly (ADR-0037) — so a write that would leave any row past it is refused at the door, where it is one 400 with a remedy, instead of later, where it is an ungovernable row.

Called by all three doors that add a containment hop — `assertRootedContainmentParent` (route 1, create and move), `relationships-repo.ts`'s `contains` door (route 2) and `placements-repo.ts`'s pair door (routes 3 and 4) — so the rule and the message cannot drift between them.

COST, in the order the ruling asked for it: no query at all when the parent is the org root (`createObject`'s existing shortcut never calls this); the row's own depth is decided from the chain the door already walked, so `hops + 1 > bound` refuses before any downward walk; the downward walk is skipped for a CREATE (height 0 by definition) and, on a move, runs bounded at `budget + 1` levels where `budget = bound - hops - 1` is the room left under the parent.

ONE message shape: names the child, the parent, the depth the row would sit at, the subtree when the subtree is the reason, the bound and the ADR, and the remedy.

### §42. THE INVARIANT BEHIND EVERY `domain_id` WRITE

THE INVARIANT BEHIND EVERY `domain_id` WRITE: after it, the row must still reach the org root.

`graph/containment-parent-authz.ts` documents at length why a row whose scope expansion cannot reach the org root is unrecoverable — authority, governance and audit all terminate there, so NOTHING, not even the org Owner's binding, can read, edit, move back or delete it. That module closed the two values then known to produce that state (a wire `null`, and a soft-deleted parent). A CYCLE is a third, and it needs no `null` at all: `X -> C -> X` terminates inside itself.

Measured before this existed, on the real HTTP doors: create C under X, then `PATCH /services/X {domainId: C}` answered **200**, and the org-root admin's own next `GET`/`PATCH`/`DELETE` of BOTH rows answered **403 — permanently**. The refusal it was supposed to hit tested `destination === current.id`, a depth-1 self-parent, and a two-hop loop walks straight past it.

Three refusals, all of them the same property reached through different values:

1. **the child is already an ancestor of the parent** — the move closes a loop. Checked over the WHOLE walk, every route, not just `domain_id`: a `contains` edge is a containment route too (route 2), so `service -> component -> service` is a cycle even though only one hop is a `domain_id`. Authority expands along exactly these routes, so a loop in any of them is a loop. 2. **the write would put a live row PAST `CONTAINMENT_WALK_MAX_DEPTH`** — the DOOR INVARIANT (owner ruling 2026-08-18, ADR-0037 Consequences): after every write, every live row's LONGEST containment route to the org root — over all four routes, the pair counted — is at most `CONTAINMENT_WALK_MAX_DEPTH` hops. The row being parented sits at `hops(parent) + 1`; if it already has a subtree, that subtree comes with it, so the deepest row after the write sits at `hops(parent) + 1 + height(child)`. Refused when that exceeds the bound — `assertContainmentDepthAdmits` is the one place the arithmetic lives, and `relationships-repo.ts` (a `contains` edge) and `placements-repo.ts` (a placement's pair) call the same function, so the three ways a hop is added share one rule and one message. Why it is an invariant and not caution: since ADR-0037 EVERY walk of a row past the bound refuses loudly (RBAC when no grant is found before the bound, policy matching, freeze and gate scoping, ADR-0032 enablement), so a row planted at hop eleven is a row nobody can govern and — when the eleven-hop route is its only one — nobody can read, rename or move back, the org Owner included. Measured on the real doors before this refusal existed: `POST /domains {domainId: <a domain at hop ten>}` answered 201, and the org-root admin's own next GET of the new row and the PATCH that would have moved it back both answered **409**. 3. **the org root is not on the parent's chain** — the parent is ALREADY detached (a legacy row, or one planted before the doors were closed), so parenting under it detaches the child too. This is the soft-deleted-ancestor case one level up: `containmentChain` refuses to walk through a tombstone, exactly as `scopeExpandCte` does, so a live parent under a dead one has no route to the root and cannot lend one.

## `childIsNew` — which of the three a CREATE gets

Refusal 1 asks about the CHILD's id — "is it already on the parent's chain?" — and on a CREATE that question is unaskable: the child is not in the graph yet, so it is on no chain, and the id cannot secretly belong to an existing row either (the insert's primary key would conflict). So a create skips 1. Refusals 2 and 3 are properties of the PARENT's chain and of the row about to be written, and a create gets BOTH: for 2 the child's height is zero by definition (a fresh row has no subtree), so the rule collapses to `hops(parent) + 1 <= bound`, and no downward walk is issued.

RETIRED REASONING, kept so nobody reinstalls it: an earlier version of this block skipped refusal 2 on a create too, arguing that it "exists solely because a truncated walk leaves 1's answer unproven" and that running it would "move the documented nesting ceiling from ten levels to nine". Both halves were written against the PRE-ADR-0037 walk, which silently truncated at the bound; under the loud walk a parent at exactly ten hops has a COMPLETE chain, and the create that skip admitted was precisely the one that planted an ungovernable row at hop eleven. Ten hops remains the ceiling — the org root within ten hops of EVERY live row — the door simply has to count the row it is about to write. The pinned shape that used to argue for the skip (`routes/containment-move-cycle-and-source-authz.integration.test.ts`'s past-the-bound case) is now planted below the doors in that test, because it can no longer be built through one; the door cases live in `graph/containment-depth-doors.integration.test.ts`.

It DEFAULTS to false, so a caller that says nothing gets the strict, move-path behaviour.

`orgId` IS the org root object's id — `auth/local-auth.ts`'s `ensureOrgRootObject` creates it with `id: orgId` ("stable, predictable id for the org root object"), which is the same identity every door already relies on when it writes `scopeObjectId ?? orgId`.

Deliberately subject-free, so it can live at the REPO (see `federation/domain-local.ts`'s "authorization at the door, invariant at the repo"): the federation importer and IaC apply reach `updateObject` with synthetic or drained-list actors, and an invariant that needed a subject would have to be re-implemented at each of them — which is how the apply path came to carry its own, weaker, copy of the destination check in the first place.

### §43. The NEAREST ancestor of `chain` carrying `typeId`

The NEAREST ancestor of `chain` carrying `typeId` (the target itself counts), or null.

"Nearest" = greatest `depth` (most specific). Comparing depth is only sound here because every candidate has the SAME kind — the documented domain/service tie is a cross-KIND phenomenon and cannot arise between two ancestors of one kind. Ties among same-kind candidates (not reachable today: `contains` is one_to_many, so a component has at most one service, and `domain_id` is a single column) break deterministically by id so the answer is never order-dependent.

## `apps/server/src/graph/content-hash.ts`

### §44. `content_hash = sha256(canonical row content)` (DESIGN.md §4.1)

`content_hash = sha256(canonical row content)` (DESIGN.md §4.1) — used for federation change-detection (a peer can tell a row changed without comparing every column) and recomputed on every write. Field order is fixed so identical logical content always hashes identically.

### §45. A declared pipeline hook's canonical hash

A declared pipeline hook's canonical hash (outpost-run probes). Same fixed-field-order discipline as the two above: the hash is what lets an outpost tell "this hook changed" from "this hook was re-journalled" without diffing every column, and it is the value a tombstone carries so a delete references the exact content it removes.

IDENTITY FIELDS ONLY PLUS THE DECLARATION. `id` is deliberately ABSENT — a hook's identity is `(orgId, componentObjectId, kind, hookId)` (migration 0096's unique constraint), and the row's uuid is local to whichever instance minted it. Including it would make the commander's row and the outpost's copy of the same declaration hash differently, which is exactly the comparison this exists to support.

## `apps/server/src/graph/custom-type.integration.test.ts`

### §46. BUILD_AND_TEST.md §8 M1 DoD (b)

BUILD_AND_TEST.md §8 M1 DoD (b): "a custom object type + custom relationship type registered via the API are immediately usable through the generic endpoints, SDK, and CLI with no deploy." One test org exercises the SDK surface; a second exercises the real `scp` CLI binary end to end (login -> register type -> create -> list), proving all three interface tiers.

## `apps/server/src/graph/delete-tombstones-edges.integration.test.ts`

### §47. AN OBJECT'S EDGES MUST NOT OUTLIVE THE OBJECT

AN OBJECT'S EDGES MUST NOT OUTLIVE THE OBJECT — AND A DELETED ANCESTOR MUST NOT GOVERN.

THE PROPERTY, AND HOW IT WAS FOUND
`deleteObject` tombstoned the object ROW alone. Every `relationships` row touching it kept `deleted_at IS NULL` — a live edge to a dead node.

Measured on the live homelab (2026-08-02) during the `docs/proposals/post-import-configuration.md` §6 pair merge: soft-deleting one absorbed component took the estate from 0 dangling `contains` edges to 1, and it had to be removed by hand. §6's own verification list demands "the absorbed component is soft-deleted with no live `contains` edge", which says the hazard was anticipated and never enforced anywhere in code.

It is not tidiness. The containment walk is BUILT from those edges and filtered only on the EDGE's `deleted_at`, so a dangling edge keeps a deleted service on a live component's chain — and that chain is what `matchPoliciesForTargets`, `containmentScopeIds` for freezes and `authz/resolve.ts` both read.

WHY THE FIX HAS TWO HALVES, AND WHY NEITHER IS SUFFICIENT ALONE
```text
the CASCADE (objects-repo) — stops NEW dangling edges. It cannot be complete: it refuses REPLICA
                             edges, because single-writer authority for those belongs to another
                             domain, and it obviously cannot fix rows already in a database.
the FILTER (containment +   — makes a deleted ancestor stop governing regardless of why its edge
authz)                       is still live. This is what covers the two cases the cascade can't.
```

A fix that shipped only the cascade would read as complete and leave both gaps.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `objects-repo.ts`: drop the cascade block | the dangling-edge test FAILS (1 live edge to a dead node, exactly what was measured live) | | `containment.ts`: drop `svc.deleted_at IS NULL` from route 2 | the deleted-service-still-governs test FAILS — the policy fires from a dead scope | | `authz/resolve.ts`: drop the `parent_o.deleted_at IS NULL` join | the deleted-service-still-grants test FAILS — a role bound at a dead service still authorizes writes | | `objects-repo.ts`: cascade WITHOUT the `originDomainId = self` filter | the replica-edge test FAILS with a single-writer conflict, taking the whole delete down with it |

### §48. Tombstones an object BELOW THE DOORS

Tombstones an object BELOW THE DOORS — a bare `deleted_at` write that runs no cascade and no guard — leaving its `contains` edge LIVE with a dead `from_id`. That is the exact state a replica row, or any row predating the container-delete guard, is already in.

It has to be surgery since the 2026-08-18 owner ruling (ADR-0038 clause 5): `DELETE` on a container that still has containment children answers 409 with the blockers named, so the live-child-under-dead-ancestor shape can no longer be REACHED through any door — which is the point of the guard, and why the reader-side pins below still matter: they are the defence-in-depth for the legacy/imported population. The write runs in its OWN committed transaction and is READ BACK, because a fixture that silently updates zero rows leaves the test measuring the fixed state and passing for the wrong reason.

### §49. The cascade matches both directions, not just one

The cascade matches `from_id` OR `to_id`; a fix that only handled one direction would leave every component pointing at a dead service. DELIBERATE FLIP (2026-08-18, ADR-0038 clause 5): this case used to delete a service that still CONTAINED a component — the container-delete guard now refuses exactly that (pinned below), so the from_id direction is pinned on a non-containment edge instead: a childless service with a `depends_on` edge FROM it.

## `apps/server/src/graph/domain-delete-orphan-guard.integration.test.ts`

### §50. THE ROUTE-1 ORPHAN GUARD

THE ROUTE-1 ORPHAN GUARD (objects-repo.ts::deleteObject, measured incident 2026-08-13).

Deleting a domain whose live children name it via `objects.domain_id` used to succeed — and every such child then 403'd on UPDATE and DELETE forever (org-root admin included), because the authz scope expansion joins parents on `deleted_at IS NULL` and a `domain_id` chain has exactly one upward path: the tombstone dead-ends it. Two API calls to permanent, admin-proof garbage.

The guard refuses the delete with the blockers NAMED.

SINCE THE OWNER RULING OF 2026-08-18 IT COVERS ALL THREE DEPENDENT ROUTES (proposal governance-reach-on-containment-move.md §9.3): `domain_id` children, `contains` children, and placements naming the row. The last test in this file used to be the CONTROL asserting route 2 still cascaded; it is inverted here with the reason written in, and the wider surface — placements, the `federationImport` / `removedForeignShadow` carve-outs, an assembly, an empty container — lives in `graph/container-delete-guard.integration.test.ts`.

### §51. This test is the inversion of a control, and why

THIS TEST IS THE INVERSION OF A CONTROL, AND THE REASON IS WRITTEN WHERE THE OLD REASON WAS.

It used to assert the opposite: "route-2 (contains) children still CASCADE — deleting a service with components succeeds", pinning that the route-1 guard "cannot quietly widen". That control was doing its job — the widening is not quiet, it is an OWNER RULING (2026-08-18, docs/proposals/governance-reach-on-containment-move.md §9.3 / §9.6 Q3-A) taken after the measurement that the cascade tombstones the EDGES and leaves the children LIVE and detached from every authority, governance and audit chain.

What the suite protects now is the CARVE-OUT SET, not the asymmetry: a `federationImport` delete with children must still land or a peer's bundle wedges, and that case lives in `container-delete-guard.integration.test.ts` alongside the `removedForeignShadow` twin.

## `apps/server/src/graph/idempotency.integration.test.ts`

### §52. BUILD_AND_TEST.md §8 M1 DoD (e)

BUILD_AND_TEST.md §8 M1 DoD (e): "fast-check property tests: randomized PUT upsert-by-URN sequences and replayed Idempotency-Key POSTs converge to identical graph state on all write endpoints." One shared org (writes are independent per random URN/key, so tests don't collide) with a modest `numRuns` — each run is a handful of real HTTP round trips against a real Postgres, not a pure in-memory check.

## `apps/server/src/graph/integrity-repo.ts`

### §53. GRAPH INTEGRITY — rows that outlived the object they hang off

GRAPH INTEGRITY — rows that outlived the object they hang off.

WHY THIS EXISTS AS A REPORT RATHER THAN A GUARD
`deleteObject` now cascades: it tombstones every edge touching the object, through `deleteRelationship`, so each gets its own audit event and journal entry. That closes the SOURCE. It cannot close the BACKLOG, and by design it never will close two cases:

```text
- rows stranded by a delete that ran BEFORE the cascade shipped. On the live homelab that is
  the `docs/proposals/post-import-configuration.md` §6 pair merges: five components
  soft-deleted on 2026-08-02/03, leaving 52
  dangling edges, 12 source mappings and 1 executor binding behind.
- REPLICA edges (`origin_domain_id != self`). The cascade skips them deliberately — single-writer
  authority means only the authoring domain may tombstone them — so such an edge legitimately
  outlives a locally-deleted object until its own authority catches up.
```

A guard that only stops NEW strandings leaves both. Hence a report: it is the only thing that can see rows already in the database, and it stays useful after the cascade is doing its job.

THESE ARE INERT, AND SAYING SO IS PART OF THE REPORT'S HONESTY
Every read path already filters them: `containment.ts` skips deleted ancestors (so no policy or role binding governs through a dead node), `correlation.ts`'s `componentIsLive()` drops events correlated to a dead component, and `targetObjectIsLive` hides a stranded binding. This is hygiene, not an outage — the report must not imply otherwise, or it becomes an alarm that gets muted.

### §54. Every integrity finding for one org, in one read-only pass

Every integrity finding for one org, in one read-only pass.

Scoped by `orgId` and run inside `withTenantTx` like every other repo function — this is a TENANT report, not an instance-wide one, so an operator in one org can never enumerate another's object names through it.

## `apps/server/src/graph/integrity.integration.test.ts`

### §55. GRAPH INTEGRITY REPORT + repair through the ordinary doors

GRAPH INTEGRITY REPORT + repair through the ordinary doors.

THE FIXTURE HAS TO FORGE LEGACY DATA, AND THAT IS THE POINT
`deleteObject` now CASCADES, so the normal door can no longer produce a dangling edge — which is exactly why the backlog needs a report rather than a guard. To test the report at all, the fixture must soft-delete an object the way the pre-cascade code did: an UPDATE of `deleted_at` alone, leaving the edges live.

That write happens AFTER the creating requests have committed, and the row is read back to prove it took effect. A fixture that silently updates nothing would leave this suite measuring an intact graph and passing for the wrong reason.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| report only `from`-side deaths | the `to`-side test FAILS (`owns` edges on the live estate are all to-side) | | mark replica edges `repairable: true` | the replica test FAILS — repair would attempt a row `deleteRelationship` refuses | | drop the `deleted_at is not null` filter on orphan mappings | the orphan-mapping test FAILS. It did NOT fail before that test existed — the first pass of this file had no mapping coverage at all, and the mutation exposed the hole rather than the code |

## `apps/server/src/graph/list-pagination.integration.test.ts`

### §56. Regression for the `scp object list component` hang

Regression for the `scp object list component` hang (cursor-precision pagination bug).

`objects.created_at` is stored at Postgres microsecond precision, but the pagination cursor round-trips through a JS `Date` (millisecond precision) — so a keyset comparison of `created_at > cursor.created_at` used to RE-INCLUDE the boundary row (its microseconds make it strictly greater than the millisecond-truncated cursor). When more than one page of rows shares a `created_at` millisecond — exactly what a bulk discovery import of components produces, all created in one transaction with an identical `now()` — `nextCursor` never advanced and the SDK/CLI `listAllObjects` iterator looped forever. Services stayed dormant only because there were fewer of them than one page, so pagination never engaged.

## `apps/server/src/graph/named-queries.integration.test.ts`

### §57. A closure MIXING an object whose immediate parent IS a domain

A closure MIXING an object whose immediate parent IS a domain (`serviceInDomain`, domainId = payments-domain) with objects whose immediate parent is the org root ORGANIZATION (a default service). The old single-hop blast-radius keyed the latter by `domain:${orgRootUuid}` — labeling the organization a "domain" and keying by a raw uuid — while domains-impacted rolled it to the org's URN. The two "count by domain" queries disagreed; they must now agree.

### §58. A raw database pair, bypassing the HTTP and auth layers

Builds a `{db, raw}` pair against the shared Testcontainers Postgres, bypassing the HTTP/auth layer entirely (same technique as `load-test/graph-scale.ts` and `query-timeout.integration.test.ts`'s bulk-insert test) — this suite calls `runNamedQuery` directly, so it needs neither a listening server nor an admin token, only a tenant `db` handle (`withTenantTx`) and a raw `scp_app`-authenticated connection for bulk `INSERT ... unnest(...)` (drizzle's own `sql` tag can't bind a real array parameter — see graph/sql-helpers.ts's doc comment — so bulk loads always go through `RawScpAppClient` instead, exactly as production's own load-test script does).

### §59. Bulk-inserts the objects and one edge per pair

Bulk-inserts `nodeIds.length` `service` objects and one `depends_on` relationship per `edges` pair (deduped — `relationships_org_type_from_to_key` is a unique constraint) directly against the tables, bypassing `graph/objects-repo.ts`/`graph/relationships-repo.ts` (audit/ journal/outbox writes are irrelevant here — same rationale as `load-test/graph-scale.ts`'s module doc). `domain_id` is left `NULL` (no FK on that column) since these tests call `runNamedQuery` directly and never go through `authorize()`/RBAC scope resolution.

### §60. Plain-TypeScript reference oracle

Plain-TypeScript reference oracle: "which node indices are within `maxDepth` hops of `startIdx` walking `edges` BACKWARD" (i.e. node `p` counts if `p depends_on frontier-member` — the exact relation `transitiveReverseClosure` walks). A textbook visited-set BFS — deliberately NOT mirroring named-queries.ts's SQL mechanics (no `(id, depth)` re-expansion) — except for one genuine semantic rule the SQL enforces on purpose and this oracle must match: `startIdx` itself can only appear via a DIRECT edge into itself (self-loop, depth 1); it can never re-enter via a longer cycle (depth ≥ 2) — see `transitiveReverseClosure`'s doc comment for why. Everything else about *how* the SQL internally re-visits nodes is irrelevant to the final node SET this oracle checks against (proved in that same doc comment).

### §61. BUILD_AND_TEST.md §8 M9 item

BUILD_AND_TEST.md §8 M9 item: property-based proof that the M9.1 node-dedup rewrite of `transitiveReverseClosure` (named-queries.ts) preserves exact output semantics — the returned node SET, for every one of the five reachability named queries, must equal a naive BFS computed independently in plain TypeScript, across randomly generated directed graphs that deliberately include cycles (a node pointing back into its own ancestry) and shared-component fan-in (several nodes converging on one common node) — precisely the topology shape that used to blow up (see this file's sibling `query-timeout.integration.test.ts` and named-queries.ts's own doc comment).

### §62. BUILD_AND_TEST.md §8 M9 item

BUILD_AND_TEST.md §8 M9 item: performance-regression proof that the M9.1 fix actually removed the blowup, not merely relocated it. Builds the exact pathological SHAPE that used to run 7+ minutes before exhausting disk (this suite's sibling `query-timeout.integration.test.ts` module doc, and named-queries.ts's own doc comment): wide fan-in AND, on top of that, genuine multi-depth convergence on the very same shared nodes (via extra "skip" edges spanning two layers at once) — the specific case named-queries.ts's doc comment calls out as the one residual (but bounded, not exponential) source of duplicate rows post-fix. Every one of the five reachability queries must complete in a small fraction of the configured `statement_timeout` (the M8 guardrail — deliberately left untouched, see query-timeout.ts) with the correct closure.

### §63. 14 nodes/layer x 10 layers

14 nodes/layer x 10 layers: complete bipartite between CONSECUTIVE layers (the shape that alone used to blow up), PLUS complete bipartite "skip" edges from layer i to layer i+2 — every node in layers 0..7 is now reachable from the last layer via (at least) two different-length routes, forcing genuine same-node-different-depth reconvergence, not just same-depth fan-in.

## `apps/server/src/graph/named-queries.ts`

### §64. Named graph queries (DESIGN.md §5)

Named graph queries (DESIGN.md §5): depth-limited recursive CTEs over indexed adjacency, depth ≤ 10. Every query here is org-scoped (the `relationships`/`objects` RLS policies apply — these run inside the caller's `withTenantTx`, same as any other read) and soft-delete-aware.

Two cycle-detection/dedup strategies coexist here, deliberately:

- The five REACHABILITY queries (`impact-of`/`dependents-of`/`consumers-of`/`blast-radius`/ `domains-impacted` — all backed by `transitiveReverseClosure` below) only ever need the SET of reachable nodes, never the route taken to reach them. These dedupe at the NODE level between recursion steps (plain `UNION`, no `path` array — M9.1 fix, see that function's doc for the full "why" and the correctness argument for why this is safe). - `paths-between` (and `graph/traverse.ts`'s own generic walk, a separate capability) genuinely need the actual sequence of hops, so they keep full path-array tracking and simple-path (`NOT x = ANY(path)`) cycle detection — untouched by M9.1, and not safe to change the same way (collapsing to node-level dedup there would silently drop legitimate alternate routes).

### §65. Transitive reverse closure

Transitive reverse closure: "what points at `startId` (directly or transitively) via any of `relTypes`" — i.e. walk edges backward from `startId`. This is DESIGN.md §5's `impact-of` example, generalized over the relationship-type set so `dependents-of`/`consumers-of`/ `impact-of`/`blast-radius`/`domains-impacted` all share this one implementation.

M9.1 fix (previously: PR #15's `query-timeout.ts` guardrail, adversarial review of that PR): the old version tracked a full `path` array per row and only deduped with a final `SELECT DISTINCT` — on a high-fan-in ("shared component") topology the same node gets re-expanded once per DISTINCT PATH that reaches it, so intermediate row count grows roughly as (effective fan-in)^depth before that final DISTINCT ever collapses it (measured: 7+ minutes / disk exhaustion on an ~11-way fan-out — see `query-timeout.ts`'s module doc and `named-queries.integration.test.ts`'s perf-regression test for the concrete repro).

Fix: dedupe at the NODE level between recursion steps instead — drop `path` entirely and use `UNION` (not `UNION ALL`), so Postgres's own recursive-CTE duplicate elimination does the work. This query never needs `depth`/distance in its OUTPUT (the final `SELECT DISTINCT o.*` never selects it — `depth` exists only to enforce the `maxDepth` hop-limit, i.e. it's a *control* column, not a *result* column), so a bare `(id)` row would be ideal; the one thing standing in the way is that `c.depth < maxDepth` still needs `depth` to enforce the hop limit, which makes the recursive term's dedup key technically `(id, depth)`, not `id` alone. That's fine here, deliberately, for two reasons:

```text
1. It doesn't reopen the blowup: fan-in causes many DISTINCT PATHS to reconverge on the same
   node AT THE SAME DEPTH (that's the actual shape of the pathological topology — a uniform
   layered DAG puts every node at one deterministic distance from the start) — `(id, depth)`
   collapses all of those immediately, every iteration. The only residual duplication is a
   node genuinely reachable at several DIFFERENT depths, which — because `maxDepth` is
   schema-capped at 10 (`packages/schemas/src/graph.ts`) — bounds any one node to at most 10
   redundant occurrences: a constant, linear factor, nothing like the old exponential blowup.
2. It's necessary for correctness, not just incidental: `maxDepth` is a real, user-facing
   truncation ("nodes within N hops"), not merely a runaway-query guard, so the recursion
   genuinely cannot drop the depth cutoff without changing which nodes come back for a given
   `maxDepth` input.
```

`AND r.from_id != startId` in the recursive term replaces the path array's other job: the old `path` was always seeded with `startId` as its first element (`ARRAY[startId, r.from_id]`), so `NOT r.from_id = ANY(c.path)` implicitly ALSO forbade ever re-adding `startId` itself at any depth ≥ 2, unconditionally (a node can't be its own dependent via a cycle back through itself). That invariant is semantically load-bearing — dropping it would let `startId` reappear in its own closure whenever it sits on a cycle within `maxDepth` — so it's kept explicitly rather than as a side effect of path-tracking. (The *base* case — direct predecessors of `startId` — is intentionally left unfiltered, exactly matching the old base case: a literal self-loop edge on `startId` was, and still is, included at depth 1 either way.)

For every node other than `startId`, dropping the "simple path" restriction (any node can now be revisited mid-walk, not just avoided-in-this-specific-path) does not change which nodes come back for a given `maxDepth`: if some walk of length ≤ maxDepth reaches node Y (Y ≠ startId) and that walk revisits an earlier node, splicing out the revisited segment yields a strictly SHORTER (still ≤ maxDepth) SIMPLE path to Y — so "reachable via a walk" and "reachable via a simple path" agree for every Y ≠ startId, at every depth bound. Combined with the previous paragraph's explicit `startId` exclusion, the returned node SET is identical to the prior (path-array) implementation for every input — only the internal dedup mechanism changed.

### §66. The caller's readable object-id set

The caller's readable object-id set (`object:read` scope), or `null` for an org-root reader. Every result object, path, and count below is intersected with it, so a named query never enumerates objects the caller lacks `object:read` on — the enumeration bypass role-model.md §8.6a tracked. Counts are computed AFTER filtering, so they cannot leak the existence of non-readable objects.

### §67. Domain grouping MUST match `domains-impacted` (below)

Domain grouping MUST match `domains-impacted` (below) — both queries claim to "count by domain" and must agree on what that means. Reuse `groupByDomain`, which walks each object's `domain_id` ancestry to the NEAREST `domain`/`organization` ancestor and keys by its URN. The old inline version here was single-hop: it keyed by the object's IMMEDIATE `domain_id` (a raw uuid) and labeled it `domain:` unconditionally — so any object whose direct parent is NOT a domain (the org root, a service, or a future deployment-target/region under a stage-domain) was mis-keyed and mis-labeled, disagreeing with `domains-impacted`.

## `apps/server/src/graph/nested-domains.integration.test.ts`

### §68. Containment domains nest: a domain inside a domain

G2 (outpost-ui.md §5, owner decision 2026-08-13): CONTAINMENT DOMAINS NEST — a `domain` object may be created inside another `domain`, first-class rather than an unexercised capability.

The proposal's own §5 measured that nothing exercised this before today: `resolveDomainId` never constrained the parent's type, and `containmentChain`'s route 1 (`child.domain_id -> parent`) is already generic across the recursive walk — so a domain-under-domain was always structurally reachable, just never created and never pinned. This file is that census: (a) create + round-trip, (b) M20.5 locality inheritance crossing the domain rung, (c) whether a RESOLVER that walks `domainId` parents actually resolves through the nesting.

### §69. Does a resolver that walks parents actually traverse nesting

(c) does a RESOLVER that walks domainId parents actually traverse the nesting?

Two candidate resolvers, per the section 1 task: executor-binding resolution's org/domain rung, and policy scope expansion. They give OPPOSITE answers, and both are pinned rather than assumed.

### §70. binding-resolution.ts:224's own header is explicit

binding-resolution.ts:224's own header is explicit: "a binding on a containment `domain` does not resolve" (ADR-0029 D2) — the ladder walks the `contains` edge only (component -> service -> assembly -> org root), and never consults `domain_id`. This is NOT a nesting-specific gap; a binding on a domain does not resolve even ONE hop up under the CURRENT (unnested) model. Pinned here with a real resolution attempt, so the negative is asserted rather than assumed.

### §71. AT THE BOUND

AT THE BOUND — the ADR-0037 loudness contract, flipped DELIBERATELY from this test's first life as a hazard pin (M21 crossover, 2026-08-13). Every recursive walk shares one bound (CONTAINMENT_WALK_MAX_DEPTH, six census sites), and before ADR-0037 each STOPPED EXPANDING silently: authz refused deep domain creates with a permission-shaped 403 naming neither depth nor bound, while a component created under the deepest allowed domain got a chain whose depth inversion presented a mid-level domain at "org root" — org-scoped required policies silently stopped matching (the ADR-0026 failure shape), reachable through the public API. Both halves are now LOUD: the walks probe one level past the bound and refuse with the depth named. This test pins that contract from the operator's side.

### §72. The other half of the old hazard

The other half of the old hazard: a component created under the deepest allowed domain used to get a silently truncated chain whose inversion presented a mid-level domain as the org root. Now NOTHING is silent — walk back from the deepest domain: every component whose chain would exceed the bound is refused LOUDLY AT CREATE, naming the depth, and the deepest one whose chain FITS must still produce the honest shape (organization at index 0).

FLIPPED 2026-08-18 (owner ruling; ADR-0037 Consequences; `containment-depth-doors. integration.test.ts`). This loop used to tolerate EITHER arm — a create refused loudly, OR a create that succeeded and whose chain read then threw — because before the doors counted the row they were writing, a component under the deepest allowed domain WAS created (201) and was refused only when something walked it (M22's governance-reach capture, in an org with a policy; a chain read, otherwise). That second arm is now a FAILURE, not a contract: the door invariant says no write leaves a live row past the bound, so a successful create MUST yield a complete chain. A create-then-409-on-read here means a door went quiet.

## `apps/server/src/graph/object-health-repo.ts`

### §73. Latest-object-health projection repo

Latest-object-health projection repo (observe-enrichment signal 4; ADR-0008 decision 4).

INVARIANT (coordinate-not-execute, charter principle 1): SCP never probes/polls/computes health. Every write here is a PUSH-IN (owner PUT today; a future opt-in health-source binding writes the SAME row via `source`). Upsert-in-place — one latest row per (org, object), no delete path — mirroring `executor_observe_cursors`. The row references an EXISTING graph object by `objects(id)` (DESIGN §4.1 projection pattern); it is not a new top-level concept.

## `apps/server/src/graph/objects-repo.ts`

### §74. M6 single-writer authority

M6 single-writer authority (DESIGN.md §13 — SECURITY-SENSITIVE, M6 PR body flag): "every object has exactly one authoritative origin domain; non-authoritative copies are read-only replicas... conflict resolution is 'authority wins' — no merge." `FederationImportContext` is the ONLY way `createObject`/`updateObject`/`deleteObject` will accept/preserve a foreign `originDomainId` — every ordinary route handler omits it, so every ordinary write stamps THIS domain's own identity and can only ever touch rows this domain already owns (checked below). Only `federation/import-repo.ts`'s bundle-apply path constructs one of these, and only after `verifyJournalChain`/`verifyBundleSignature` have already passed — so a row's `originDomainId` can never be forged into pointing at a domain that didn't cryptographically sign for it.

### §75. RESYNC ONLY (§7.2.6 — SECURITY-SENSITIVE)

RESYNC ONLY (§7.2.6 — SECURITY-SENSITIVE). When true, the revision-STALENESS guard is bypassed: an incoming revision at or below what is already stored still OVERWRITES, instead of no-op'ing as a stale replay. This is the ONLY way a lost-tail resync re-converges the graph on the exporter's restored reality — the re-minted entries carry their ORIGINAL (now-stale) revisions, so without this every one of them would silently no-op against the staleness guard ("converged nothing").

It bypasses ONLY the staleness guard — NEVER the single-writer authority check (a resync still cannot forge authorship of a row another domain owns). Set exclusively by the resync import path under a mutually-authorized permit; no ordinary import or route ever sets it.

### §76. Change objects deliberately keep the object entry kinds

NOTE: `change` objects deliberately stay `object_upsert`/`object_tombstone` here, even though `entryKind: "change_status"` also exists as a journal entry kind — that one is produced EXCLUSIVELY by `coordination/changes-repo.ts`/`coordination/transition.ts` with a distinct, richer state-machine-shaped payload (objectId/fromState/toState/...). Having two producers emit the SAME entryKind with two different payload shapes would make the importer's dispatch ambiguous — so the graph-object snapshot for a `change` and its lifecycle-state snapshot are kept as clearly separate entry kinds/payload shapes instead.

### §77. `canonicalJson` moved to `util/canonical-json.ts`

`canonicalJson` moved to `util/canonical-json.ts` (M6 — see that module's doc comment for why: breaking an objects-repo -> journal-repo -> attestation -> objects-repo import cycle), imported above and re-exported here so every EXISTING import of `canonicalJson` FROM THIS module (several other files still do `import { canonicalJson } from "../graph/objects-repo.js"`) keeps compiling unchanged.

### §78. The org's root graph object

The org's root graph object (type `organization`, `domain_id IS NULL`) — every other object's containment chain terminates here, which is what lets the RBAC recursive CTE (authz/resolve.ts) walk `domain_id` all the way to an org-level scope with one query and no NULL special-casing. Created once at org bootstrap (auth/local-auth.ts).

### §79. M20.1 (ADR-0031 §1) — declare that this object never federates

M20.1 (ADR-0031 §1) — declare that this object never federates. Defaults to `false`.

THIS IS THE ONLY PLACE IN THE CODEBASE THAT SETS `objects.domain_local`. `updateObject`, `upsertObjectByUrn`'s update branch, `deleteObject`'s soft-delete and the campaign fairness update all omit the column entirely, which is what makes locality immutable *by construction* rather than by a guard someone can forget to add at a sixth write site.

Deliberately NOT settable on the `federationImport` path: an imported row is by definition something that crossed a boundary, so it is never domain-local. A journal entry carrying the flag is dropped by `scope-filter.ts` before it can reach this function at all — this is the defense-in-depth half, not the primary guard.

### §80. Provenance for the `contains` route, which create cannot see

M20.7 (ADR-0031 §6c) — provenance for the `contains` containment route, which `createObject` cannot see for itself: the edge to the container does not exist yet when this runs. `graph/components-repo.ts::createComponentInService` supplies it.

Passed SEPARATELY from `domainLocal` on purpose. Folding it into the boolean (as M20.5 did) still makes the object local, but destroys the distinction between "the operator declared this" and "it followed its container" — which is the entire question this field exists to answer.

### §81. Resolves the `domain_id` an object create should use

Resolves the `domain_id` an object create should use: `undefined` defaults to the org root object (see `getOrgRootObjectId`); `null` means "this object IS the org root" (bootstrap only); an explicit id is validated to belong to the same org. Exported so route handlers can resolve the same value for the pre-write RBAC scope check (authz/resolve.ts) without a second round trip drifting from what `createObject` itself will use.

### §82. The same resolution, plus the locality a child inherits

M20.5 (ADR-0031 §6a) — the same resolution as `resolveDomainId`, plus the parent's **locality**, which a child inherits at its own create.

## Why this exists rather than a second lookup

Both branches were ALREADY reading the parent row — `getOrgRootObjectId` selects the org root and returns only its id, and the explicit branch selects the named parent purely to validate it exists. Returning `domainLocal` from reads that already happen makes subtree inheritance cost **zero extra queries**. That is not micro-optimisation: `createObject` is the hottest write path in the system (the M1 DoD alone drives 5,000 sequential creates against a 180s budget that already runs at ~60% of it on CI hardware), and a per-create SELECT added for a feature most creates never use is the kind of thing that turns a green suite amber a month later.

## Why one hop is enough

ADR-0031 §6a: every intermediate container is itself stamped at ITS create, so the immediate parent's flag already equals what a full ancestor walk would return, by induction. That is what keeps `containmentChain` — a recursive CTE — out of the write path, which §1 requires.

The induction is load-bearing, and its precondition is that EVERY create door funnels through here or through `graph/components-repo.ts::createComponentInService`. A future door that resolves a containment parent by itself would silently produce a shared object inside a domain-local subtree; `domain-local-inheritance.integration.test.ts` is the census that keeps that honest.

### §83. A soft-deleted parent is not a parent

A SOFT-DELETED PARENT IS NOT A PARENT, and this filter is the difference between a contained row and an unreachable one. `authz/resolve.ts`'s `scopeExpandCte` joins `parent_o.deleted_at IS NULL` on every hop, so an object parented under a tombstone has its scope expansion terminate at itself — exactly the state `domain_id IS NULL` produced, reached through a different value. Measured before this filter existed: `DELETE /domains/{d}` then `PATCH /services/{s} {domainId: d}` returned 200, and the org-root admin's own next GET of that service 403'd with "lacks 'object:read'", permanently. Policy still governs the row either way (matching reads `properties.scope`, never placement), so the outcome is a governed object nobody can read, edit, move back or delete.

Applied here rather than at the doors on purpose: it needs no subject and gives the same answer for every caller, which is this codebase's test for an INVARIANT (see `federation/domain-local.ts`'s "authorization at the door, invariant at the repo"). The federation import path is unaffected — `resolveImportDomainId` already filters `deleted_at` and falls back to `undefined`, so a replica whose parent is locally tombstoned lands at the org root rather than being refused.

### §84. `fromRole` AUTHORING-TIME VALIDATION

`fromRole` AUTHORING-TIME VALIDATION (role-model.md §5 step 6). Here rather than at the route, for §2a's reason: a policy is an ordinary graph object, so POST /objects/policy, PUT, IaC apply and discovery accept all pass through this function, and a route-level check would leave IaC apply free to author a quorum no principal can ever satisfy. Import is exempt as every guard here is — a throw mid-bundle wedges a peer's entire signed journal.

### §85. Inherit locality from the containment parent, at create

M20.5 (ADR-0031 §6a) — INHERIT LOCALITY FROM THE CONTAINMENT PARENT, at create.

An explicit `false` under a domain-local parent is REFUSED, not silently overridden. Both of the silent options are worse: honouring it creates a federating object inside a subtree whose whole point is that it stays home — its name alone can disclose what the subtree is about — while quietly upgrading it to `true` would mean an operator who asked for a shared object got a local one and was never told. A 400 at authoring time is the only outcome that leaves nobody with a false belief.

The `federationImport` path is exempt: an imported row crossed a boundary by definition, its parent is a replica, and the coercion below already forces `false` for it regardless.

### §86. The root-reachability invariant, on the create half

THE ROOT-REACHABILITY INVARIANT, on the CREATE half of the same choke point `updateObject` carries it on (see the long comment there, and `graph/containment.ts` for the three refusals).

It was installed on the MOVE path only, and the reasoning that left creates out was "a fresh id cannot already be an ancestor of the parent". That is true, and it covers exactly the ONE refusal that ASKS about the child's id — the CYCLE. It says nothing about the other two, which are properties of the PARENT's chain and of the row about to be written: the parent does not itself reach the org root (an ancestor was soft-deleted), and — since the owner ruling of 2026-08-18 — the new row would sit PAST `CONTAINMENT_WALK_MAX_DEPTH` (a parent at exactly the bound has a complete chain, and a child under it is the ungovernable hop-eleven row every walk refuses). Hence `childIsNew` — refusal 1 skipped, refusals 2 and 3 run, refusal 2 with height 0 and therefore without a downward walk; `containment.ts` carries the arithmetic and the retired "running 2 on a create lowers a documented limit" reasoning, which was written against the pre-ADR-0037 truncating walk.

MEASURED on the real doors before this call existed, not reasoned about: soft-delete a domain, then `POST /services {domainId: <a service still inside it>}` answered **201**, and the ORG-ROOT ADMIN's own GET, PATCH and DELETE of the new row all answered **403 — permanently**, while the principal bound inside the stranded subtree could see it and had nowhere to move it to. That is byte-for-byte the unreachable row the move path refuses, produced through a different verb.

AT THE REPO, for the same reason the update half is: `coordination-as-code/plans-repo.ts`'s `executePlanDiff` calls `createObject` DIRECTLY through its own drained check list and never touches `graph/containment-parent-authz.ts`, so a fix at the door helper alone ships INERT for IaC apply — which is a second, independent create door and was measured writing the unreachable row happily. It needs no subject, and gives every caller the same answer, which is this codebase's test for an invariant (`federation/domain-local.ts`: authorization at the door, invariant at the repo).

`domainId === null` is the org root's OWN create (bootstrap) — it has no parent whose chain could be broken.

`domainId === input.orgId` — the ORG ROOT as the parent — is skipped because the call is a PROVABLE no-op there, not because it is cheap enough to be worth risking. All three refusals are decided before the query returns:

```text
- refusal 1 (cycle) does not run at all on a create: `childIsNew` is true, which is the whole
  point of that flag (see `containment.ts`).
- refusal 2 (the depth bound) is decided in advance: the org root sits at hops 0, the new row
  has no subtree, so `0 + 1 + 0` is under any bound worth having — no walk can change it.
- refusal 3 asks `ids.has(orgId)` over `containmentChain(orgId, orgId)`, and that walk seeds
  itself with the target row at depth 0. The org root IS the target, so it is in the set no
  matter what the recursive term finds — the answer cannot be anything but "rooted", however
  the graph above it is shaped.
```

That is why the guard is `!== orgId` and not a broader "shallow parents are fine": for any OTHER parent the walk is load-bearing (it is what caught the soft-deleted-ancestor create measured below), and the moment the org root is not seeded at depth 0 this reasoning stops holding.

It is not a micro-optimisation on a cold path either. `createObject` defaults an unnamed `domainId` to the org root, so this is the MAJORITY create shape, and the M1 DoD drives 5,000 sequential creates against a 180s budget. MEASURED on this machine (500 iterations, warmed, inside one transaction against the Testcontainers PostgreSQL):

```text
isolated `assertRootedContainmentParent(parent = org root)`   0.93-1.04 ms/call
end-to-end default `createObject`, before                          11.35 ms/create
end-to-end default `createObject`, after (3 runs)          8.04 / 9.10 / 9.30 ms/create
```

— a ~1 ms round trip removed from an ~11 ms create, for an answer that was fixed in advance. The isolated figure is the honest one: it is the query that stops being issued. The end-to-end spread is wider than 1 ms in both directions, so read it as corroboration, not as the measurement.

Every other create still pays one bounded recursive-CTE round trip; unlike the update half there is no "unchanged re-apply" to guard against, because a create always writes a parent.

`federationImport` is exempt, exactly as it is on the update half and for the same reason: an imported row's parent comes from `resolveImportDomainId`, which already filters tombstones and falls back to the org root, and `federation/import-repo.ts`'s `object_upsert` branch has no try/catch — one refusal here would abort a whole signed bundle and wedge that channel over a row this domain does not own. The receiving domain also has no standing to referee the containment its authoring domain chose.

### §87. The authority-split rule, at the one local write choke point

M16.2 phase A (E1) — clause (4) of the authority-split rule, at the ONE choke point every LOCAL write door funnels through (see `federation/outpost-binding.ts` for the rule and for why it is here and not per-route). Skipped for `federationImport`, and that skip is NARROWER than it looks: a JOURNAL replica's `peerDomainId` may name any domain the exporter knew about (a commander with full sync scope carries outpost B's config down to outpost A), so applying the guard on the import path would abort whole bundles. The skip is therefore kept for the verified journal path and CLOSED AT THE OTHER `federationImport` CALLER — `federation/handfill-repo.ts`, whose `assertHandFillableType` restricts a hand-filled peer-bound object to this instance's OWN domain id. Those two modules are the complete census of `federationImport` suppliers.

### §88. A group-scoped subscription opt-out is refused

ADR-0032 §6a (M21.3, review round) — A GROUP-SCOPED DEPENDENCY-SUBSCRIPTION OPT-OUT IS REFUSED, installed HERE for exactly the reason the block above is: this is the one choke point every local write door funnels through.

It shipped in one place — the typed `/policies` routes' composed `validateWrite` — next to `assertPolicyScopeWithinAuthority`, which was itself installed in THREE (that config plus `coordination-as-code/plans-repo.ts`'s create and update branches). Censusing the SIBLING is what exposed the hole: `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill` and `POST /federation/overlays` all reach `createObject` with a free-form `typeId` and free-form `properties`, and all three planted the exact document the typed route answers 400 to. Adding three more calls would have rebuilt the same rake for the next door; one call here covers every door that exists and every door that will.

THE EXEMPTION, AND WHY IT IS EXACTLY THIS WIDE
`federationImport` is skipped, and the reason is NOT "imported data is trusted" — it is that a throw here is not survivable on that path. `federation/import-repo.ts`'s `object_upsert` branch has NO try/catch, so one refusal aborts the WHOLE signed bundle and wedges that channel until an operator intervenes (proposal §10 Q6; the same fail-closed version-skew class the `additionalProperties` relaxation fixed for `outpost`). A receiving domain also has no standing to referee a document its AUTHORING instance already accepted or refused: the guard is an authoring-time refusal by construction, and the authoring instance is where it runs.

BUT `federationImport` DOES NOT MEAN "ARRIVED OVER THE JOURNAL". CENSUS (filterless, re-run for this change — `grep -rn federationImport apps packages tools`): it is SUPPLIED in exactly two modules, `federation/import-repo.ts` (signature/chain-verified bundle replay) and `federation/handfill-repo.ts`. Every other hit is a comment or a type declaration. That census matches the one `federation/outpost-binding.ts` and `handfill-repo.ts` already assert, and it is still true.

Hand-fill is a LOCAL OPERATOR ACTION wearing the import flag: a `federation:write` holder typing a free-form `typeId` + `properties` into `POST /api/v1/federation/hand-fill`. Nothing about it is a channel that can wedge — there is no bundle, no chain, and the operator is standing right there to read a 400. Exempting it would hand every operator the bypass this guard exists to close. So the skip is kept for the verified journal path ONLY and CLOSED AT THE OTHER CALLER: `handfill-repo.ts` calls the guard itself, before its upsert. That is the identical shape M16.2 clause (4) uses two blocks above, for the identical reason, against the identical two-module census.

### §89. Security declarations: strict locally, open on the wire

M22.5 (ADR-0033 §6 guard 3) — the component's security DECLARATIONS, strict at the local author's door and open on the wire. Installed HERE rather than at the component routes for exactly the reason the two guards below are: a filterless census of doors reaching this function with free-form `properties` found four, and a per-route install would have missed three of them (`governance/component-declaration-guard.ts` names them).

### §90. The campaign recipe, guarded like its neighbours

M25.4 (ADR-0041) — the CAMPAIGN RECIPE, here for the identical reason its neighbours are and against the identical `federationImport` census. `POST /campaigns` is only ONE of the three doors that reach `campaign.properties`; IaC apply (`coordination-as-code/plans-repo.ts`) calls this function DIRECTLY with a free-form `typeId` and free-form `properties`, so a guard at the campaign route would never see it. See `governance/campaign-recipe-guard.ts`, including why `change` is deliberately NOT guarded here.

### §91. The other half of the split, which the line above cannot reach

M22.5 — the OTHER half of ADR-0033 §6's split, and the half the line above cannot reach. That one bounds what a COMPONENT may declare; this one bounds what a POLICY may do with a declaration. A `declared_fact` clause carrying no narrowing matcher excludes every finding at every severity, and admission is per CLASS — so no tier above can see the clause's reach and consent to it. See `scan-rule-authoring-guard.ts`.

Ordered here, among the SYNCHRONOUS refusals and ahead of every awaited one, for the reason stated on the M22.8 guard below: it reads only the document, so a bad write is rejected before anything pays for a round trip.

### §92. THE RESERVED GOVERNANCE LABEL NAMESPACE

THE RESERVED GOVERNANCE LABEL NAMESPACE — the THIRD and FOURTH refusals at this choke point, here for the identical reason the two above are, against the identical `federationImport` census, and closed at the identical other caller (`federation/handfill-repo.ts`).

A selector-scoped policy's match key must be out of its own subject's write reach, in both directions: the DOCUMENT may only key on a reserved label, and the reserved LABEL may only be written by org-root `policy:write`. Installing either half alone leaves the evasion — a namespace nobody is required to use, or a required namespace anyone may edit. See `governance/governance-labels.ts`.

### §93. The fifth authoring refusal, ending a common first experience

M22.8 — the FIFTH authoring refusal at this choke point, and the one that ends M22's most common first-time experience: a `scanThreshold`/`scanExclusion` rule that requires no scan control constrains nothing, silently (the reconcile prewarm never even resolves the two dimensions, and no scan verdict is ever produced for them to act on). Installed here rather than at the `/policies` route for the reason the four above are — `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill` and `POST /federation/overlays` all reach this function with a free-form `typeId` and free-form `properties`, and a per-route install would miss all three.

Ordered LAST of the five deliberately: it is the only one that issues a query of its own (it reads the org's controls to ask whether any scan control is required), so every cheaper refusal above — two of them purely synchronous — gets to reject a bad write before this one spends a round trip.

### §94. The fourth authoring refusal, closing the override's door

M22.6 (ADR-0033 §6a) — the FOURTH authoring refusal at this choke point, and the one that ends the override design's second door. `scan_override_grant` being governance-managed maps the IaC path to `policy:write`, which a routine domain-scoped policy author holds — so the manifest `{status: "approved", expiresAt: "2999-…"}` was accepted with no tier check on the rule being waived, no Decision and no audit event. Installed here for the reason the three above are: a per-route install would miss `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill`, `POST /federation/overlays` and the typed registries.

### §95. The sixth refusal, and the first whose subject is an identity

ADR-0046 §1 — the SIXTH authoring refusal at this choke point, and the first one whose subject is an identity rather than a document. A `config-source` row says "manifests from this repo apply AS THIS TEAM", and the sync loop hands that team's object id straight to `executePlanDiff` as `actorObjectId` — so minting one is a grant of the team's whole write reach, with the same shape a `member_of` edge has. Installed here rather than at a route for the reason every guard above it is: four doors reach this function with a free-form `typeId` and free-form `properties`. Ordered LAST because it is the most expensive — it resolves each named team and then a permission at that team's scope — so every cheaper refusal rejects a bad write first. See `config-source/authoring-guard.ts`.

### §96. Forced false on import: a journalled row is not local

M20.1 (ADR-0031 §1). Forced `false` on the import path regardless of what the caller passed: a row that arrived over the journal is, by definition, one that crossed a boundary, so it cannot be domain-local. Coercing here rather than trusting `import-repo.ts` not to pass it keeps the invariant at the choke point every write door funnels through. M20.5 (ADR-0031 §6a): declared OR inherited. The `||` is the either-route rule — a container's locality reaches its children without the child restating it, which is the whole ergonomic point of the subtree layer. `containmentParent.domainLocal` is `false` on the import path by construction (a replica's parent is a replica), and the ternary forces `false` there anyway.

### §97. M20.7 (ADR-0031 §6c) — record WHY, not just whether

M20.7 (ADR-0031 §6c) — record WHY, not just whether.

DECLARED WINS. A caller can pass `domainLocal: true` while creating under an already-local container; the row records DECLARED (null provenance) because that is what the operator actually did, even though the object would have been local anyway. Recording it as inherited would erase an act that happened.

`inheritedFrom` is therefore set ONLY when inheritance is what made it local — the caller did not declare, and a container did. The two columns are written together and cleared together, so the "id without urn" state is unreachable.

### §98. Only journal writes THIS domain actually authored

Only journal writes THIS domain actually authored — an imported row was already journaled (and signed) by ITS origin domain; re-journaling it here would falsely claim co-authorship and corrupt this domain's own hash chain with content it didn't originate (DESIGN §13 single-writer authority: "no merge algorithm exists because none is needed").

...AND NEVER JOURNAL A DOMAIN-LOCAL OBJECT AT ALL (M20.2, ADR-0031 §2 as corrected). The first cut journaled it and filtered it at export. That is wrong, and `domain-local-invisibility` caught it: a filtered bundle is SPARSE, and `import-repo.ts` only accepts a sparse chain when the RECEIVER's own `sync_scope` is narrow (`receiverExpectsContiguity = mode === 'full'`). A `full`-scope peer — the default, and the widest — would refuse every bundle with a contiguity-break 409 the moment any object in the org was declared domain-local. The feature would have broken federation for exactly the most common peer.

Not journaling is also STRICTLY MORE PRIVATE than filtering, which is what makes this a correction rather than a workaround. A withheld-but-numbered entry leaks its own existence: the gap in the sequence tells a peer how many local objects there are and when they changed — the aggregate signal the owner explicitly declined (ADR-0031 "Alternatives", Q6). An entry that was never allocated a sequence leaves nothing to count.

The export-side filter in `federation/scope-filter.ts` therefore no longer has anything of ours to catch, and is kept deliberately: it is the IMPORT-side defense against a peer that ships a domain-local-stamped entry anyway. The stamps below remain for the same reason — so that if such an entry is ever produced, both ends still recognise and drop it.

### §99. Stamped so the scope predicate stays pure and synchronous

M20.1 (ADR-0031 §2) — stamped so `entryMatchesScope` stays a PURE, synchronous predicate over one entry. That purity is not a style preference: the exporter filters with that function and the importer re-applies it as defense in depth, and the importer cannot query the sender's object state. Resolving locality by a lookup at export time would be a design in which the two sides can silently disagree.

Present ONLY when true, so a non-local object's payload stays BYTE-IDENTICAL to what ships today — this is a pure addition for the declared minority, not a wire change for every entry. (The entries that do carry it never cross, by construction.)

### §100. Same lookup as `getObjectByIdOrUrn`, but without a fixed `typeId`

Same lookup as `getObjectByIdOrUrn`, but without a fixed `typeId` — for M2 ownership ergonomics (routes/ownership.ts) where the owner side of an `owns` edge can be a team/group/user/ service-account and the caller doesn't know which ahead of time. Endpoint-type constraints are still enforced (by `createRelationship`, against the relationship type registry) — this helper only resolves the id-or-urn to a live object, it does not validate the object's type.

### §101. The same lookup, returning `undefined` instead of throwing

The same lookup, returning `undefined` instead of throwing — for the callers whose answer to "no such object" is NOT a 404 on this request. Today that is the stage-dependency authority check (`coordination/campaign-scope-authz.ts`), which must not turn an unresolvable reference on the persist-then-process ingress path into a 4xx: that path's contract is that a caller-shaped defect surfaces as a recorded refusal at process time, not as an error on the webhook/report POST.

Shares the id-or-urn condition with `getObjectByIdOrUrnAnyType` rather than restating it, so the "is it a UUID or a URN" rule can never mean one thing for a check and another for the write it guards.

### §102. The type-scoped object list

The type-scoped object list — `/objects/{type}`, `/components`, `/objects/service` and every typed registry, which are its FOUR callers and therefore ~23 wire routes.

`readableFilter` — THE ROW-LEVEL READ SCOPE (role-model.md §8.2 step 4), AND WHY IT IS A PARAMETER
`authz/list-scope.ts`'s `authorizeListAndScope` produces it: `null` for a principal whose authority covers the whole org, otherwise a subquery of the object ids their role bindings reach downward. It arrives here as an already-decided value rather than being computed inside, because the permission it must be computed with is the door's own (`object:read` for most, whatever `readPermission` a typed registry declares for the rest) and it has to be the SAME permission the door authorized with. Deciding both in one place at the door is what keeps those two from drifting.

It is a REQUIRED parameter, not an optional one, and that is deliberate: `undefined` would be indistinguishable from "forgot", and forgetting is how a list door silently keeps returning the whole org. A caller with no subject to scope to passes `null` explicitly and says why.

IT GOES IN `conditions`, WHICH IS THE ENTIRE POINT. This query is keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from the last row it actually selected, so a filter applied anywhere but inside the statement is applied AFTER the LIMIT — shrinking pages, and eventually producing whole empty pages that still carry a non-null `nextCursor`. §8.2 measured that on a 20,910-object estate: an assembly-bound principal's 5 readable components at cursor ranks 97/140/254/339/440 of 18,500 yield ONE row on page 1 and zero on pages 6–185, while 27 of 30 `apps/web` list call sites fetch exactly one page. Composed here, the page is full, the cursor is honest, and there is no empty-page-with-cursor state.

NOTE on `includeDeleted`: the descend behind the filter walks LIVE rows only (a tombstoned ancestor stops the chain upward, so it must stop it downward too — `authz/readable-scope.ts`), so a SCOPED principal asking for `includeDeleted` still sees no tombstones. That is not a narrowing of anything: before this parameter existed those principals were refused the door outright. An org-root principal gets `null` and is unaffected.

### §103. The unverified-shadow adoption hatch, and nothing wider

M16.2 phase A (review round 4) — THE UNVERIFIED-SHADOW ADOPTION ESCAPE HATCH, and nothing wider. Honored ONLY when the locked row carries `provenance = 'manual'` — a hand-filled, never-verified shadow copy that DESIGN §13 already declares "reconciled (confirmed or REPLACED)". When honored, this local write is permitted against a foreign-origin row and RE-STAMPS it as locally authored (`origin_domain_id` = this domain, `provenance` = NULL), so it journals and syncs onward like any other local object. A row with `provenance = NULL` — a signature-verified replica — is NEVER adoptable: the ordinary single-writer refusal still fires, because adopting one would make the next real import a single-writer violation and wedge that peer's sync. Set by exactly one caller (`federation/outposts-repo.ts`'s `reconcileOutpostConfig`), which is the API-level recovery path for a peer wedged by a duplicate hand-filled object.

### §104. Uses the drizzle query builder

Uses the drizzle query builder (not raw `tx.execute(sql...)`) specifically so the result is auto-mapped from the DB's snake_case columns to `objects.$inferSelect`'s camelCase shape — `tx.execute()` returns raw pg driver rows (literal column names, bigint columns as strings), which is exactly right for the recursive-CTE named queries (graph/named-queries.ts, graph/traverse.ts — genuinely need raw SQL) but wrong here, where a normal `SELECT ... FOR UPDATE` maps 1:1 onto a query-builder call.

### §105. Idempotent replay / interrupted-transfer resume

Idempotent replay / interrupted-transfer resume (DESIGN §13, DoD "double-import is a no-op"): a revision at-or-behind what's already stored is stale — return the row unchanged, no audit event, no journal entry, no version bump. RESYNC (§7.2.6) bypasses this: under a mutually-authorized permit a stale revision still OVERWRITES, so a lost-tail restore re-converges instead of silently no-op'ing. The single-writer check above is NEVER bypassed.

### §106. ADR-0032 §6a — the UPDATE half of the same choke point

ADR-0032 §6a — the UPDATE half of the same choke point (see `createObject` above for the full reasoning and for the `federationImport` census). Not optional: `updateObject` replaces `properties` wholesale, so an ordinary PATCH/PUT that rewrites `scope`/`effects` can turn an enforceable policy into an unenforceable one without ever passing through a create.

`nextProperties` — the value about to be STORED — is what is checked, deliberately, rather than `input.properties`. That makes the invariant a property of the ROW rather than of the request, so a PATCH touching only `name` cannot leave a refused document in place. The cost is that a grandfathered row (one planted through a door before this guard reached the choke point) becomes un-editable until its scope is fixed — which is the remedy the error already names, and is the fail-closed direction.

### §107. The update half of the unnarrowed declaration refusal

M22.5 — the UPDATE half of the unnarrowed-`declared_fact` refusal, checked against `nextProperties` for the identical reason its neighbours are, and it is the half that matters: the attack is an EDIT. A policy authored with `pkgName: "openssl"` clears the create guard, and a later PATCH that merely DROPS that key widens the clause from one package to every finding — the same bytes-on-the-wire ambiguity the label delta below describes, where only the stored row can tell a narrowing from a removal. Synchronous, so it sits ahead of the awaited refusals.

### §108. The update half, which is where the evasion actually lives

THE UPDATE HALF of the governance-label namespace, and the half that actually closes the reported evasion — the attack is an EDIT, not a create. `nextLabels` vs `existing.labels` is a DELTA over the stored row, deliberately, and it is a delta rather than a check on the request field for two reasons at once: a PATCH that never mentions `labels` must stay free (the delta is empty, so no permission is even resolved), and a full-replacement PUT that OMITS a governance label is a REMOVAL and must be refused (the delta is not empty). Those two are the same bytes on the wire and only the stored row can tell them apart.

Ordered FIRST of the three because it is the cheapest: the selector check is pure and synchronous, and the label check resolves a permission only when the delta is non-empty — so a refused write never pays for the region walk below it.

### §109. The update half of the un-declaration guard

M15.6 / ADR-0017 §3 — the UPDATE half of the un-declaration guard, checked against `nextProperties` (the value about to be STORED) beside the two above and for the same reason: `updateObject` replaces `properties` wholesale, so a full-replacement PUT that merely OMITS `region` deletes it, and omission is the whole attack. See `region-membership-guard.ts` for the measured evasion this closes and why the bar is org-root `object:write`.

INDEPENDENT of the governance-label guards above: that pair keys on `labels`, this one on `properties.region`/`properties.environment`. Same property (a match key writable by its own subject), different key, different bar — neither subsumes the other.

### §110. The update half of the delegation refusal, and why it matters

ADR-0046 §1 — THE UPDATE HALF of the config-source delegation refusal, and the half that matters most: the escalation is an EDIT. A registration authored against a team the author administers clears the create guard; a later PATCH that merely rewrites `team` — or adds one `stackTeams` entry — repoints the same repo at ANOTHER team's authority. `updateObject` replaces `properties` wholesale, so the check runs against `nextProperties`, the value about to be stored, exactly as its neighbours do.

### §111. OWNER RULING 2026-08-25 (D1 b-i) — WIDENING A CAMPAIGN'S DEADLINE

OWNER RULING 2026-08-25 (D1 b-i) — WIDENING A CAMPAIGN'S DEADLINE. The UPDATE half and the ONLY half: a create is always a first set, which the ruling leaves at `object:write`.

Here rather than only at `POST /campaigns/{id}/deadline` for the reason `assertValidCampaignRecipe` two guards up is here — `campaign-recipe-guard.ts`'s census of the SAME property found three write doors, and a route-level guard is invisible to two of them. The ruling shipped at the route alone, and IaC apply reaches this function directly with a free-form `typeId` and free-form `properties`: a manifest that simply omitted `deadline` produced exactly the effect the route refuses, at exactly the permission it was raised above.

A DELTA OVER THE STORED ROW (`existing.properties` vs `nextProperties`), exactly like the two guards above it and for the same two reasons at once: a PATCH that never mentions `deadline` must stay free, and a full-replacement write that OMITS it is a REMOVAL and must be priced as one. Those are the same bytes on the wire and only the stored row tells them apart.

Cheap by construction on every write that is not about a campaign deadline: it returns before resolving anything unless a READABLE deadline is stored and the incoming document releases it. See `governance/campaign-deadline-widening-guard.ts` — including why it asks a strictly NARROWER question than the route's check, so it can never refuse what the route admits, and why `federationImport` (this block's exemption) leaves no local-actor bypass at hand-fill.

### §112. M22.8 — the UPDATE half, checked against `nextProperties`

M22.8 — the UPDATE half, checked against `nextProperties` (the value about to be STORED) for the identical reason the three above are: a PATCH that adds a `scanThreshold` effect, or one that strips the `requireControls` effect out from under an existing ceiling, turns an enforceable rule into an inert one without ever passing through a create.

Ordered LAST of the four for the same reason as on the create half: it is the only one here that issues its own query, so the synchronous selector check and the delta-gated label check both get to refuse before this one pays for a round trip.

### §113. The two subject-free invariants behind a parent write

THE TWO SUBJECT-FREE INVARIANTS BEHIND AN EXISTING ROW'S CONTAINMENT-PARENT WRITE, at the one place it happens: the parent must still EXIST AND BE LIVE IN THIS ORG (the first call in the block), and the row must still REACH THE ORG ROOT afterwards (the second). They are separate questions with separate refusals — see the first call's comment for why the walk does not subsume the liveness check, which is precisely the assumption that left the liveness half uninstalled here for four rounds of work on this code.

`upsertObjectByUrn`'s update branch delegates here; its only other `domain_id` write is the federation hand-fill id replacement, which is `federationImport`-only and exempt below.

At the REPO rather than at the doors on purpose — the doctrine `containment-parent-authz.ts` states and `federation/domain-local.ts` argues: authorization at the door, invariant at the repo. It needs no subject and gives every caller the same answer, and — decisively — `coordination-as-code/plans-repo.ts` reaches this function through its own drained check list without ever calling that helper. A door-only cycle refusal ships INERT for IaC apply, which is the second copy of this decision and was measured writing the cycle happily (`routes/containment-move-cycle-and-source-authz.integration.test.ts` pins both doors).

Guarded on an actual CHANGE, so an unchanged re-apply pays no recursive-CTE round trip, and exempt for `federationImport`: an imported row's parent comes from `resolveImportDomainId`, which already falls back to the org root, and a refusal here would abort a whole peer bundle over a row this domain does not own.

### §114. THE VALIDATION HALF OF THIS WRITE

THE VALIDATION HALF OF THIS WRITE — "does this id still name a LIVE object in this org?" — and it belongs FIRST, ahead of the walk below, for two independent reasons.

`createObject` has always resolved its parent through this function; `updateObject` never did. It took `input.domainId` and put it on the column. `containment-parent-authz.ts`'s module doc has named this split from the day it was written — "what the repo owns is the invariant half: `resolveContainmentParent` (called from here) is what rejects a `domainId` naming an object outside the org, and `createObject` still resolves the default parent for itself" — and the update half of that sentence was never installed.

WHY THE WALK BELOW IS NOT THIS CHECK, which is what made it survive four rounds of work on this exact code. `assertRootedContainmentParent` walks `containmentChain(parentId)`, and that walk deliberately does NOT filter `deleted_at` on its SEED row — "the TARGET itself is not filtered — governance may legitimately be evaluated over a deleted object", which is correct for its own purpose. The consequence here is that a TOMBSTONED parent seeds the walk, climbs to the org root through its own still-live ancestors, and is pronounced rooted. The two functions ask genuinely different questions and only one of them asks this one.

MEASURED on the real doors before this call existed, not reasoned about. `POST /plans` resolves a manifest's `domainId` ONCE, at plan-compute time, and PERSISTS the resolved id in the plan's diff; `POST /plans/{id}/apply` is a separate request that replays that stored pointer through this function without ever calling the door helper. Soft-delete the parent in the window between them and apply answered **200**, the row landed under the tombstone, and the ORG-ROOT ADMIN's own next GET, PATCH and DELETE of it all answered **403 — permanently** (`authz/resolve.ts`'s `scopeExpandCte` joins `parent_o.deleted_at IS NULL` on every hop, so the row's scope expansion terminates at itself). That is byte-for-byte the unrecoverable state this column's guards exist to prevent, and `resolveContainmentParent`'s own comment records being paid for once already through `PATCH /services/{s}`.

The same TOCTOU on the CREATE branch of apply is already refused — because `createObject` re-validates at APPLY time by calling this function. The asymmetry WAS the bug.

FIRST, AND CHEAP. This is one PK-indexed SELECT; the walk below is a bounded recursive CTE (~1 ms measured on this machine). Ordering the narrow refusal ahead of the broad walk is how the guards on this path have been sequenced since they were installed, and it also produces the RIGHT diagnostic: a dead parent reported as "does not reference a live object" rather than as the walk's "does not itself reach the org root", which would send an operator to repair an ancestor that is fine.

GATED ON A CHANGE, WHICH IS ALSO THE FAIL DIRECTION — worth separating from the cost argument the outer guard makes, because they happen to agree here and do not always. A row that is ALREADY parented under a tombstone (grandfathered, or planted before this call existed) can still be written, including by a full-replacement PUT that restates the parent it has: that resolves to `nextDomainId === existing.domainId` and never reaches this check. That is deliberate and is the opposite choice from ADR-0032 §6a's guard a few lines above, which checks the value about to be STORED precisely so a grandfathered row becomes un-editable until it is fixed. The difference is what "fixed" costs: an unenforceable policy document can be rewritten by its author, whereas a detached row's only remaining principal is one bound directly at it, and refusing its writes would take away the last handle anyone has on it. Refuse NEW detachments; never brick an existing one further.

The return value is discarded on purpose: the refusal is the whole point. The resolved id is `nextDomainId` by construction for any non-null argument, and the `domainLocal` half is a CREATE-only concern (ADR-0031 §2 — locality is immutable on an update, and `updateObject` reads it from the ROW, never from the request).

FEDERATION IMPORT IS EXEMPT, and here the exemption is PROVABLY INERT rather than a hole — worth stating, because an exemption whose safety is only asserted is where the next one hides. `import-repo.ts`'s `object_upsert` branch obtains its `domainId` from `resolveImportDomainId`, which runs the identical `deleted_at IS NULL` filter and falls back to `undefined` (the org root) for anything else, so an import can only ever arrive here with `undefined` or an id already shown to be live and in-org — this guard could never fire for it. The exemption is therefore kept for consistency with every sibling guard in this function, and because that branch has NO try/catch: a refusal raised mid-bundle aborts a peer's whole signed journal and wedges that channel over a row this domain does not own and has no standing to referee. If `resolveImportDomainId` ever stops filtering tombstones, IT is the place to fix that — not here, where the blast radius is a peer's entire sync rather than one entry.

"PROVABLY INERT" is true of the LIVENESS half only. It is NOT true of the DEPTH half of the walk below: `resolveImportDomainId` checks that the parent is a live in-org row and nothing about how deep that row sits, so an imported row CAN land past `CONTAINMENT_WALK_MAX_DEPTH` (a peer-authored nesting this org's tree cannot hold). Accepted, per the owner ruling of 2026-08-18, for the reason above — the receiver does not referee a peer-authored containment, and this branch's failure mode is per-CHANNEL, not per-entry — and stated here so "provably inert" is never read as covering it. `containmentParentChainForDoor`'s conversion branch is what answers a local write UNDER such a row.

### §115. CONTAINMENT ROUTE 1

CONTAINMENT ROUTE 1 — a `domain_id` MOVE changes which policies reach this object, under `object:write`, which is weaker and differently held than the `policy:write` that authored them. See `governance/governance-reach.ts` for the property and why the recording lives at this choke point rather than at the ~18 route handlers that admit `domainId`.

The `!==` guard is what keeps this off the ordinary write path: a PATCH that never mentions `domainId`, and a full-replacement PUT restating the parent the row already has, both resolve to `nextDomainId === existing.domainId` and cost NOTHING — no query, no walk. Only a genuine move pays. Creates are not instrumented at all: a new object has no prior reach to have changed.

### §116. M20.2 (ADR-0031 §2). Read from the ROW, never from the request

M20.2 (ADR-0031 §2). Read from the ROW, never from the request: locality is immutable and `UpdateObjectRequestSchema` cannot express it, so the row is the only truth here.

This stamp is not optional convenience — without it a domain-local object leaks on its SECOND write. Its create entry would be filtered and every later `object_upsert` would sail through carrying its id, urn, name, properties and labels, which is the whole object arriving one revision late. The create-path stamp alone protects nothing.

### §117. Locality is immutable, so this is a precondition not a write

M20.1 (ADR-0031 §6) — locality is immutable, so on an EXISTING row `domainLocal` is a precondition rather than a write.

`undefined` (the overwhelmingly common case, and every caller that predates M20) asserts nothing. A value EQUAL to the stored one is an idempotent no-op — load-bearing, because `PUT` is defined as idempotent here and `scp apply` re-sends an unchanged stack routinely; if a matching declaration 409'd, declaring locality in IaC would make the stack un-reappliable. A value that DIFFERS is refused, in both directions and with the direction named:

- **shared → domain-local** is refused *permanently*, and no verb will ever grant it. Federation has no un-send: once a row's existence has crossed, a later claim that it is local asserts a confidentiality property the system cannot deliver, and answering 200 would be a lie. - **domain-local → shared** is a real, supported transition — but it is the deliberate one-way publication verb (M20.4), which re-journals the object's full current state and sweeps its edges. It is emphatically not a side effect of a `PUT` body, so the refusal here names that verb instead of silently doing half of it.

### §118. `PUT /objects/{type}/{urn}` — idempotent upsert-by-URN

`PUT /objects/{type}/{urn}` — idempotent upsert-by-URN (DESIGN.md §6). Creates the object if no row exists for `(org_id, urn)`, otherwise fully replaces the mutable fields. Applying the exact same request any number of times converges to the same graph state (fast-check-tested).

### §119. M6 hand-fill reconciliation

M6 hand-fill reconciliation (DESIGN §13: "reconciled — CONFIRMED OR REPLACED — when a signed bundle later arrives"): a hand-filled row (`provenance: 'manual'`) was created by an operator who could not have known the real object's id (a human can't hand-type a UUID they've never seen) — `handfill-repo.ts` generates a local placeholder id for it. When the REAL, signature- verified import for the SAME urn later arrives carrying the object's true id, an ordinary UPDATE would silently keep the WRONG (locally-generated) id forever — every future entry that references the object by its real id (a relationship endpoint, a `domainId` parent, ...) would then fail to resolve locally, since this org's row would still be filed under the placeholder id. So this case REPLACES the id in place via `UPDATE ... SET id = ...` — never a hard DELETE (`scp_app` is deliberately never granted DELETE on `objects`, DESIGN.md §4.1's append/soft- delete-only discipline). If some OTHER row already references the placeholder id via a foreign key (a relationship endpoint created against the unverified hand-filled row), this UPDATE fails closed with a foreign-key violation rather than silently orphaning it — an acceptable v1 scope boundary (hand-filled rows are expected to accumulate local references rarely, if ever, before reconciliation). Never fires for an ordinary (non-hand-filled) reconciliation, where the id is already correct and stable.

### §120. CONTAINMENT ROUTE 1, SECOND WRITE SITE

CONTAINMENT ROUTE 1, SECOND WRITE SITE. This branch deliberately does NOT delegate to `updateObject` (see the `subjectDomainLocal` note below), so it needs its own capture for exactly the reason it needs its own audit stamp — and a recorder installed at one of two write sites for one concept is this repo's most-repeated defect (CLAUDE.md's census rule).

Reached only by signed-journal replay reconciling a hand-filled shadow onto its authoritative id, so the actor is the federation import subject rather than a tenant — which is precisely why it is worth recording: a peer's reconciliation can re-parent a local row, and that must be as visible as a local operator doing it.

This `domain_id` write carries NO containment door — neither the root-reachability walk nor the depth bound (`assertRootedContainmentParent`). It is `federationImport`-only by the guard above, so it wears the same carve-out `updateObject` states at its own call: the receiver does not referee a peer-authored containment, and this branch's failure mode is per-CHANNEL (no try/catch around `object_upsert`). Named here so the census of `domain_id` write sites reads "two sites, one door, one deliberate carve-out" and not "one site forgotten".

### §121. True idempotency: replaying an unchanged body is a no-op

True idempotency: replaying the exact same PUT body against an unchanged row is a no-op — no version/revision bump, no audit event, no outbox event. Without this, a byte-identical replay would still increment `version` forever, which is "safe" for federation convergence (content matches either way) but not actually idempotent in the HTTP sense the endpoint claims to be (fast-check-tested: graph/idempotency.integration.test.ts).

### §122. M6: a hand-filled row

M6: a hand-filled row (`provenance: 'manual'`) whose content happens to already match an arriving REAL import must still fall through to `updateObject` — never take the no-op fast path — so `provenance` actually clears and `revision` actually advances. Otherwise a byte-identical signed bundle would leave the object permanently stuck flagged "unverified" even though it was JUST verified (DESIGN §13 hand-fill reconciliation).

### §123. M15.6 / ADR-0017 §3 — the DELETE half of the un-declaration guard

M15.6 / ADR-0017 §3 — the DELETE half of the un-declaration guard. Removing the ROW withdraws the target from its multi-region environment just as surely as blanking `properties.region` does, and it was the third measured evasion vector: `readDeclaredRegionMembership` filters `deleted_at IS NULL`, so soft-deleting a region target that a proposed change already names makes the gate stop firing and the wave target dispatch against the shared default executor.

FIRST, ahead of the route-1 orphan guard and the containment-reach capture below, for the reason that capture itself was placed after `assertRootedContainmentParent` in `updateObject`: a REFUSAL should not pay for work whose only consumer is the write it refuses. This check is read-only and short-circuits on `typeId !== 'deployment-target'`, so it costs nothing on the ordinary path, while the reach capture below runs two recursive containment walks. Ordering them the other way would make every refused un-declaration pay for a reach diff that is then thrown away with the transaction. Neither guard reads the other's state — one authorizes, one observes — so the order is purely a cost decision, and both still run strictly BEFORE the tombstone.

### §124. ROUTE-1 ORPHAN GUARD

ROUTE-1 ORPHAN GUARD: a tombstoned domain parent makes its `domain_id` children permanently unadministrable, so a delete that would do that is refused — not cascaded, not tolerated.

Measured 2026-08-13 (two API calls, depth 1): delete a domain whose live children name it via `objects.domain_id` → 200; every such child then 403s on UPDATE and DELETE forever, for the org-root admin included, because the authz scope expansion joins parents on `deleted_at IS NULL` and the child's one upward chain dead-ends at the tombstone.

WIDENED TO ALL THREE DEPENDENT ROUTES (owner ruling 2026-08-18, proposal §9.3 / §9.6 Q3-A). It used to guard route 1 alone, on the reasoning that route 2 (`contains` edges) has deliberate CASCADE semantics and the reader-side filter backstops what the cascade cannot reach. THE OWNER RETIRED THAT ASYMMETRY, and the measurement behind it is `countContainmentDependents`' own (`governance/governance-reach.ts`): the cascade tombstones the EDGES, so a deleted service's components stay LIVE and detached — and placements are worse still, because a placement names its component and target by JSON PROPERTY, not by an edge the cascade can see, so deleting a component today leaves its placements live and dangling. One rule now covers all three:

```text
route 1  `objects.domain_id` children   — the measured incident above
route 2  `contains` children            — a service's components, left live and detached
routes 3+4  placements naming this row  — invisible to the cascade entirely
```

The counts are the same three `countContainmentDependents` computes (kept as counts THERE, for the reach Decision, because that record only needs the blast radius' size); here the rows are ENUMERATED, because a refusal an operator cannot act on is a wall, not a guard.

CONSEQUENCE WORTH STATING: deleting a component with placements is now REFUSED. That closes the dangling-placement gap by refusal rather than by cascade — §9.6 Q3 offered the cascade and the owner chose refusal, so a placement is removed by `DELETE /placements/{id}` and never implicitly.

NOT applied on the federation-import path, and not when removing a foreign SHADOW row — the same two carve-outs the edge cascade below has, for the same reason. The authoritative domain already deleted this object, and refusing the import would silently diverge this replica from its authority (a worse failure than the orphaning, which the reader-side deleted-ancestor filter at least bounds); a shadow removal is purely local cleanup of a row this domain never authored. A local child naming a foreign replica as its parent therefore CAN still be orphaned by that authority's delete; recorded as a cost, same class as the replica edges the cascade cannot reach.

### §125. Placements name their endpoints by JSON property

Placements name their endpoints by JSON property (`componentId` / `deploymentTargetId`), so this arm COMPOSES `graph/containment.ts`'s `placementNamesObjectSql` — the one definition of routes 3+4 read downward, which `containmentChildrenSql`'s arm 3 also composes. The guard, the reach record (`countContainmentDependents`) and both containment walks therefore cannot disagree about what depends on this row.

⚠️ IT WAS A HAND-TYPED COPY AND IT HAD DRIFTED, 2026-08-26. The predicate here was a RAW TEXT comparison with no `UUID_TEXT_PATTERN` guard and no `::uuid` cast. `uuid` equality is case-insensitive and `text` equality is not (measured, PostgreSQL 16), and every id compared here comes out of a `uuid` column lower-case — so a placement whose `componentId` was written as UPPER-CASE HEX was on this object's containment chain going UP, and INVISIBLE to this guard coming down. BEHAVIOUR CHANGE, stated rather than folded in: deleting such a component or deployment-target is now REFUSED instead of silently leaving the placement live and dangling, which is this guard's whole purpose. It is not reachable through `createPlacement` (that resolves both endpoints and writes their own ids), only through `createObject` directly — federation import, or legacy rows — which is the same population `placementEndpointParentSql`'s `CASE` guard exists for.

### §126. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7) — DOOR C, HALF ONE: the RELEVANCE PROBE, which has to be read HERE because the tombstone below and the edge cascade further down both destroy the evidence it reads. The check itself runs at the END of this function.

Tombstoning the USER who holds the org's only administrative binding removes no edge at all, so the cascade's per-edge check cannot see it; tombstoning the TEAM that holds it cascades its `member_of` edges, which the cascade's check does see. Both are covered by asking the invariant once, after everything this function does.

The probe is sound rather than convenient: the floor reads `role_bindings` rows at the org root, `roles.permissions`, live `member_of` edges and `objects.deleted_at`/`type_id`. An object that is no binding's subject and has no live `member_of` edge is in no candidate closure, and this function's cascade will tombstone no `member_of` edge either — so its tombstone cannot change the floor's answer. It reads exactly the two tables the floor reads, which is what keeps the short-circuit honest as those inputs change.

The same two carve-outs the cascade and the orphan guard take, for the same reasons: a peer's `object_tombstone` must not be refused (it would abort the whole signed bundle and diverge this replica from its authority), and a foreign-shadow removal is local cleanup of a row this domain never authored.

### §127. CONTAINMENT ROUTE 3

CONTAINMENT ROUTE 3 — TOMBSTONING A CONTAINER, which writes no containment field and yet detaches everything beneath it (every route in `graph/containment.ts` skips a deleted ANCESTOR).

Captured BEFORE the tombstone, and that ordering is the whole of it. The edge cascade further down re-uses `deleteRelationship`, whose own route-2 recorder runs AFTER this row is already tombstoned — so its before-reach has lost this container too and its diff is empty. The cascade therefore records NOTHING on this path, which is why the container case is instrumented here rather than assumed covered by the edges it deletes.

### §128. CASCADE: an object's edges must not outlive the object

CASCADE: an object's edges must not outlive the object.

Deleting an object used to tombstone the object ROW alone, leaving every `relationships` row touching it with `deleted_at IS NULL` — a live edge to a dead node. Measured on the live homelab (2026-08-02): soft-deleting one component during the post-import-configuration.md §6 pair merge took the estate from 0 such edges to 1, and it had to be cleaned up by hand.

It is not cosmetic, because the containment walk is built out of those edges. `graph/containment.ts` route 2 walks `contains` from `r.to_id` to `r.from_id` filtering on the EDGE's `deleted_at` only, so a dangling edge keeps a deleted service on a live component's chain — and that chain is what `matchPoliciesForTargets`, `containmentScopeIds` and `authz/resolve.ts`'s `scopeExpandCte` all read. A policy or role binding scoped at a DELETED service would go on governing. (The walk now also skips deleted ancestors, which covers the rows this cascade cannot reach — see below.)

WHAT THIS DELIBERATELY DOES NOT DO:

- it does not run on the FEDERATION IMPORT path. The authoritative domain journals its own `relationship_tombstone` entries beside the `object_tombstone`; cascading here would tombstone at a revision that authority never issued, and the import would then reject its real entry as a stale replay. - it does not touch REPLICA edges (`originDomainId !== self`). `deleteRelationship` refuses those by design — single-writer authority — so they are skipped rather than attempted. Such an edge genuinely can outlive this object until its own authority removes it, which is precisely why the reader-side filter in `containment.ts` exists as well: this cascade cannot be complete on its own, and a fix that only prevented NEW dangling edges would leave both the foreign ones and every row already in the database. - it does not run for `removedForeignShadow`, which is local cleanup of a row this domain never authored and deliberately does not journal.

### §129. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR — DOOR C, HALF TWO. AFTER the tombstone AND after the edge cascade, so it judges the state this whole operation actually leaves behind rather than modelling any part of it. MEASURED before this guard, four plain sequential requests: `DELETE /objects/user/{id}` on the org's only administrator returned 200 and left the estate holding a `role_bindings` row naming a tombstone — unadministrable, hand-written SQL the only recovery.

The cascade's own per-edge check (`graph/relationships-repo.ts`) already covers the case where this row is a GROUP with members; that redundancy is deliberate and cheap. What only this call catches is the row that IS the principal: tombstoning it removes no edge, so nothing in the cascade fires.

The predicate takes §0's org lock itself, which this transaction is already holding by now (every `appendAuditEvent` in the cascade took the same key). See `docs/authz/role-binding-door.md` §7.

### §130. The tombstone needs it too, and is the easiest to miss

M20.2 (ADR-0031 §2) — the TOMBSTONE needs it too, and this is the easiest one to miss because a tombstone "carries no data". It carries the id and the URN, and a URN is `urn:scp:<org>:<type>:<name>` — the object's NAME in plain text. Letting a domain-local object's deletion cross would leak both its existence and its name, and would additionally tell a peer that something it was never shown has now been removed.

## `apps/server/src/graph/pair-bound-types.ts`

### §131. Types whose identity is a pair of other objects

Object types whose identity IS a pair of other objects, and which therefore cannot be created through any door that takes free-form `properties` (ADR-0026 D2/D3, owner decision D17).

A `placement` is one component at one deployment-target. Three things must happen together for it to be well-formed, and only a typed route that takes both endpoints can do them:

```text
1. each ref is resolved and TYPE-CHECKED (a placement whose "component" is a service is
   meaningless, and the generic route would happily store the UUID);
2. the two DERIVED edges (`places`, `placed_at`) are written in the SAME transaction, without
   which the placement is an island invisible to every traversal and impact query;
3. the URN is built from both endpoints rather than from a single free-text name.
```

Migration 0051's `required: [componentId, deploymentTargetId]` catches (1)'s absence at every write door, but it cannot catch a well-formed-looking pair of UUIDs pointing at the wrong types, and it cannot write edges. Hence the refusal.

This mirrors `service-member-types.ts` exactly. FIVE surfaces consult it, and the list is the point — it was wrong three times, in the same way, and every miss was a user-facing write door that reaches `createObject` WITHOUT passing through a create route:

```text
- the generic `/objects/{type}` route (`routes/objects-generic.ts`)
- the federation overlay route (`federation/overlay-repo.ts`)
- IaC plan/apply (`coordination-as-code/plans-repo.ts`) — added 2026-08-03 after a manifest declaring
  `typeId: "placement"` was PROVEN to apply cleanly and write an edgeless island
- discovery accept (`routes/executors.ts`) — added at the same time; see the note below
- federation hand-fill (`federation/handfill-repo.ts`) — added 2026-08-18: it wears
  `federationImport`, so it read as an import path, but its `typeId` and `properties` are a local
  operator's free-form request; PROVEN to hand-fill an edgeless placement that also sat past the
  ADR-0037 depth bound (the pair door lives only in `graph/placements-repo.ts`, which hand-fill
  never reaches)
```

BEFORE ADDING A SIXTH DOOR, RE-RUN THE CENSUS: `grep -rna "createObject(" apps/server/src` and ask of each caller whether its `typeId` is FIXED (safe — it cannot name a pair-bound type) or CALLER-SUPPLIED (must guard). That question, not the list, is what makes the set complete. It is a SEPARATE set from `SERVICE_MEMBER_OBJECT_TYPE_IDS` on purpose: that set's reason is service MEMBERSHIP, this one's is pair IDENTITY, and merging them would produce a guard whose comment lies about why it fires.

TRUE import paths stay permissive: federation-journal replay calls `createObject` directly and never touches a create ROUTE, and a replica arrives with its edges as their own `relationship_upsert` entries, so replication reproduces both halves.

`discovery/accept` USED TO BE CLASSED HERE AND SHOULD NOT HAVE BEEN. It takes its proposal from the REQUEST BODY, so a client can hand-write one that never came from a plugin run — which makes it a user-facing create door wearing an import path's clothes. Measured 2026-08-03: a hand-written proposal returned 201 and created a placement with no derived edges. It now refuses. The distinction that matters is not "is it called an import path" but "can a caller choose the typeId, and can this path write the derived edges?" — accept fails the second test either way.

## `apps/server/src/graph/placements-repo.ts`

### §132. `placement` — one component at one deployment target

`placement` — one component at one deployment target (ADR-0026 D2/D3/D14, owner decision D17).

THIS MODULE IS THE SINGLE WRITER that keeps a placement's two representations in agreement, and that is its whole reason to exist. Migration 0051's header states the shape and why both halves are needed; restated here because this is where it is enforced:

```text
* `properties.componentId` / `properties.deploymentTargetId` are the SOURCE OF TRUTH. Only they
  can carry the unique index — nothing in the schema can reference a relationship id, and
  uniqueness over a PAIR of relationship rows is not expressible as one index.
* The `places` / `placed_at` edges are DERIVED. Only they are traversable — `traverse`,
  blast-radius and the graph explorer walk `relationships`, and a placement whose endpoints
  lived only as property UUIDs would be an island in the graph.
```

One fact in two places is a real cost and it is paid deliberately. It is contained by there being exactly ONE local write path: `createPlacement` writes both in one transaction, and the generic `/objects/placement`, overlay, IaC, discovery-accept and hand-fill doors are refused outright (`graph/pair-bound-types.ts` — five doors, the last added 2026-08-18). The federation path reproduces both halves without this module, because a replicated placement arrives as an `object_upsert` plus its own `relationship_upsert` entries.

### §133. The URN separator, and why it is `/`

The URN separator, and why it is `/` (owner decision D17, second addition).

ADR-0026 D3 names a placement `<component>@<deployment-target>`, but a NAME is not a URN: `slugify` maps every `[^a-z0-9]+` run to a single `-`, so `keycloak@commercial-prod` and a literal component named `keycloak commercial prod` both derive `keycloak-commercial-prod`. Deriving the URN from the display name would therefore be quietly AMBIGUOUS — and while D8 forbids relying on name-based uniqueness anyway (migration 0051's index is the guarantee), an ambiguous identifier is its own bug: two different placements would race for one URN and the loser would get an unexplainable 409.

`/` is the fix and the only clean one available: the URN grammar's slug-path (`UrnSchema` in packages/schemas/src/graph.ts) explicitly admits it, while `slugify` STRIPS it — so a `/` in a placement URN can only ever be the separator this function put there, never a character that leaked out of an endpoint's name. It also reads as what it is: a path from a component to a place. No alphanumeric separator (`-at-`, `_at_`) has that property; each is forgeable by an endpoint whose own name contains it.

The DISPLAY name keeps `@` per D3. The two identifiers answer different questions and are allowed to differ.

### §134. The derived edges as one list, so create and withdraw agree

The DERIVED edges, as one list so create and withdraw cannot drift apart — adding a third edge type in one place and forgetting the other is precisely the incomplete-call-site shape this repo keeps paying for.

### §135. The pair index is the identity guarantee, not a backstop

Migration 0051's pair index is the IDENTITY guarantee, not a backstop (see its header) — reached either by a plain duplicate declaration or by two CONCURRENT ones under READ COMMITTED. Says what actually happened, rather than the generic URN-collision 409, which would blame the name.

### §136. Declares a placement

Declares a placement: the object, its two derived edges, and a Decision, in ONE transaction.

Placements are DECLARED, never inferred (D8) — nothing here pairs objects by name, and nothing may. The proposal's own §1.2 data is the reason: `agentkit-bootstrap` / `agentkit-db-bootstrap-prod` and `agentkit-selfhost` / `agentkit-hosted` look like pairs and are different Argo CD applications. An undeclared pair stays undeclared until a human says otherwise.

### §137. Both-endpoint authority, which edge creation does not check

Both-endpoint authority — the security check `createRelationship` alone does NOT do (it validates endpoint TYPES and cardinality, never authority). A placement grants the component reach into that deployment-target, and an executor binding attaches to the result, so the actor must hold `relationship:write` over BOTH ends. Modelled on `components-repo.ts`'s service check, one endpoint further: neither end here is the actor's own fresh object.

### §138. Withdraw then re-declare, against a full unique constraint

WITHDRAW-THEN-RE-DECLARE. `objects_org_id_urn_key` is a PLAIN unique constraint — unlike every partial index in this schema it does NOT filter `deleted_at IS NULL` — so a withdrawn placement holds its URN forever. Migration 0051's pair index deliberately frees the PAIR on withdrawal, and D8 makes withdraw-then-re-declare the only way to change a placement (there is no PATCH), so without this the documented lifecycle would 409 on its second step and 0051's header would describe something that does not work.

Checked UP FRONT rather than caught: a unique violation aborts the whole Postgres transaction, so a retry inside the same `tx` cannot work without a savepoint, and this create writes two edges and a Decision after the object — all of which would be lost.

The suffix is the new object's own id, following `webhook-processor.ts`'s precedent for the same collision, and appears ONLY on a re-declaration: the first declaration of any pair keeps the clean `<component>/<target>` URN. A caller-supplied `urn` is never rewritten — that is the caller asserting an identity, and silently altering it would be worse than the 409.

A lost race here (two re-declarations of the same withdrawn pair at once) still cannot produce a duplicate: the pair index catches it and raises the 409 below. This only chooses a URN.

### §139. CONTAINMENT ROUTES 3 AND 4

CONTAINMENT ROUTES 3 AND 4 — THE PAIR DOOR (owner ruling 2026-08-18, ADR-0037 Consequences).

A placement is CONTAINED by both endpoints it names (`graph/containment.ts` `placementParentsSql` — read from these very properties), so declaring one adds a hop under the component AND under the deployment-target, exactly as a `domain_id` write or a `contains` edge adds one. `createObject` below runs the `domain_id` half of the invariant for the placement's route-1 parent and cannot see these two, because they arrive as properties. So the same arithmetic runs HERE, once per endpoint, before anything is written: `hops(endpoint) + 1 > bound` refuses (the placement is new, height 0, no downward walk). MEASURED before this existed: `POST /placements {component: <a component at hop ten>, deploymentTarget: <root target>}` answered 201, and `containmentChain` of the new placement then threw — a placement no policy, freeze or gate could ever scope.

`authorize` above already 409s (ADR-0037's deny-probe) when an endpoint is itself PAST the bound and no grant is found before it; it passes at exactly the bound, which is the case this closes. An endpoint past the bound that a short route made readable is the conversion branch's case (`containmentParentChainForDoor` turns the walk's 409 into this door's 400).

WHERE, and why not `createObject`: this module is the SINGLE local writer of a placement (module doc — the generic, overlay, IaC, discovery and hand-fill doors all refuse the type, and IaC apply funnels through THIS function), so the door is complete here for every local path. Federation import never reaches this function (a replica arrives as `object_upsert` + its own `relationship_upsert` entries, straight into `createObject` under `federationImport`), so the D1/D2 carve-out — the receiver does not referee a peer-authored containment, and `import-repo.ts`'s `object_upsert` branch has no try/catch, so one refusal would abort a whole signed bundle — is inherited by construction rather than restated as a flag. Hand-fill (`federation/handfill-repo.ts`) also wears `federationImport` but is a LOCAL operator's free-form request, not a channel; it used to admit a `placement` (proven: a hop-eleven placement landed there while this door refused the same pair) and now refuses the type outright as the fifth door of the pair-bound census (`graph/pair-bound-types.ts`), so every local placement write reaches THIS door.

### §140. Withdraws a placement

Withdraws a placement: BOTH derived edges and the object, soft-deleted in ONE transaction.

This exists because `deleteObject` does not touch relationships — nothing in the graph cascades — so a placement removed through the plain object delete would leave its `places` / `placed_at` edges LIVE, pointing out of a dead object. That is not a tidiness issue, it is the exact failure the properties-are-truth/edges-are-derived split has to defend against, and it would surface as a traversal or blast-radius result naming a placement that no longer exists.

It is also reachable, not hypothetical: migration 0051's unique index filters `deleted_at IS NULL` on the OBJECT, so withdrawing frees the pair to be re-declared — and the re-declaration writes a second pair of edges. Without this, one component would accumulate an edge per withdrawal, all live, and the graph would report it placed at the same target N times.

Edges first, then the object, so no intermediate state has a live edge out of a dead object.

### §141. The rows this caller's authority reaches, as a subquery

The rows this caller's authority REACHES, as a subquery yielding `id` (`authz/list-door-scope.ts` builds it; `authz/readable-scope.ts` defines it).

`null`/absent means NO FILTER — the caller holds the permission at the ORG ROOT, so this is today's query verbatim. It is NOT "matches nothing": a subject with no allow binding at all yields a real match-nothing subquery, and the two must never collapse.

### §142. Lists placements, optionally filtered by either end of the pair

Lists placements, optionally filtered by either end of the pair.

Filters read the PROPERTIES, not the edges — the source of truth, and the half the unique index covers. Reading the edges instead would answer subtly differently the moment the two ever disagreed, and a query that silently disagrees with the constraint is worse than no query.

⚠️ `ListPlacementsQuery.readableFilter` is applied HERE, as a `WHERE` condition, and not in the handler over the returned page. This list is keyset-paginated with `.limit(limit + 1)` and derives `nextCursor` from the last row it selected, so a handler-side filter would shrink the page AFTER the `LIMIT` — role-model.md §8.2 measured that shape returning one readable row on page 1 and zero on pages 6 through 185, each with a valid `nextCursor`, while 27 of 30 `apps/web` list call sites fetch exactly one page. Any future filter that expresses "which rows may this caller see" belongs in `conditions` for the same reason.

### §143. Live placements whose COMPONENT is one of `componentObjectIds`

Live placements whose COMPONENT is one of `componentObjectIds` — the IaC ownership-scoped pool (C1 decision Q4: a placement belongs to the stack that owns its component, the same rule `listSourceMappingsForComponents` already applies to mappings).

Reads the pair from `properties`, which ADR-0026 D17 makes the source of truth — the same half `binding-resolution.ts`, `plan-service.ts` and `component-pipeline.ts` read. Returns nothing for an empty id list rather than scanning the org.

## `apps/server/src/graph/placements.integration.test.ts`

### §144. `placement` — one component at one deployment target

`placement` — one component at one deployment target (ADR-0026 D2/D3/D14, owner decision D17).

The properties are the SOURCE OF TRUTH and the two edges are DERIVED. One fact in two places is the cost of the shape, and every test below that touches a write asserts BOTH halves, because a bug in this design does not look like an error — it looks like a placement that is fine until something traverses it, or an edge pointing out of an object that no longer exists.

**Mutation log** (each applied alone, then reverted):

| Mutation | Result |
| drop the 0051 unique index | the duplicate test AND the race test fail | | index without `deleted_at IS NULL` | "re-declared after withdrawal" fails | | drop `placed_at` from the derived-edge list (create) | "both derived edges" fails | | withdrawal skips the edges | "withdrawal removes the derived edges" AND "re-declared" fail | | remove `placement` from `PAIR_BOUND_OBJECT_TYPE_IDS` | BOTH door tests fail | | drop the component type-check in `createPlacement` | **all pass** — see below |

That last row is recorded because it is a true negative, not a gap: the `places` edge's own registered `to_types` (migration 0051) refuses a non-component one step later, inside the same transaction, so the write is still rejected and nothing is stored. The explicit check earns its place by failing BEFORE any write and by saying which endpoint was wrong — but it is not the only guard, and a test asserting "this throws" cannot separate the two. Stated plainly rather than dressed up as proof.

The race test's history is also worth keeping: it originally passed with the 0051 index REMOVED ENTIRELY, because two derived-URN creates of the same pair compute the same URN and `objects_org_id_urn_key` serialised them incidentally. It measures the pair index only because it now supplies distinct explicit URNs.

### §145. Explicit distinct URNs, without which this asserted nothing

EXPLICIT, DISTINCT URNs are load-bearing here, and this test asserted nothing without them. Two derived-URN creates of the same pair compute the SAME base URN, so `objects_org_id_urn_key` serialises them incidentally — the test passed with migration 0051's pair index removed entirely, i.e. it was measuring the wrong constraint. Distinct URNs take that constraint out of the picture and leave the pair index as the only thing that can hold.

The race itself is not theoretical: 0049's mutation testing showed two concurrent creates both getting past an application-level check under READ COMMITTED. Here there is no application-level pre-check at all, so the index is the sole guard by construction.

## `apps/server/src/graph/property-schema-live-edit.integration.test.ts`

### §146. REGRESSION GUARD for a "component built, never installed" defect

REGRESSION GUARD for a "component built, never installed" defect: the Ajv compiled-validator cache in `graph/property-validation.ts` was keyed on `object_types.id`, and its exported `invalidatePropertyValidatorCache` had ZERO callers anywhere in the tree. A long-lived process therefore validated every write against the FIRST `property_schema` it ever compiled for a type, for the whole life of the process.

WHY THIS TEST IS SHAPED THE WAY IT IS. The schema edit below is applied over a SEPARATE ADMIN CONNECTION, and the server under test is then driven only through its real HTTP routes. Nothing tells the server the schema moved: no restart, no cache API, no hook, no in-process call. That is not incidental — it is the entire point, and it mirrors production exactly. The only thing that ever rewrites `property_schema` is a SQL migration, and on the Helm split topology those arrive from `migrate-bin.ts` running as a `pre-upgrade` Job: a different, short-lived process that applies the `UPDATE`, exits, and deliberately leaves the running api/worker pods serving (the chart defaults to 2 + 2). A test that reached into the cache directly — or that called an invalidator itself — would prove nothing about that, because in production there is no in-process caller to do the reaching. It would go green against the exact bug it was written to catch.

MUTATION-CHECKED, both halves: re-keying the cache on the type id (the old behaviour) makes the `tier`-missing rejection below fail, and removing the write in step 1 that warms the cache makes the test vacuous rather than failing — so the warm-up assertions are load-bearing and are asserted on, not merely performed.

The type is created through the API and edited by SQL because that is the real division of labour: the API can only INSERT a type (`type-registry-repo.ts` has no update), so a `property_schema` that CHANGES can only ever get there by migration. M22 does exactly this to `component` and `policy`.

### §147. The same live process must enforce the new schema both ways

STEP 3 — the SAME live process must now enforce the NEW schema, in BOTH directions. One direction alone is not enough: a cache that always recompiled from scratch and a cache that was simply disabled would both pass (a), so (b) pins that valid writes still succeed.

(a) newly-required `tier` is missing. Under the id-keyed cache this call SUCCEEDED — this is the assertion that dies if the fix is reverted.

## `apps/server/src/graph/property-validation.test.ts`

### §148. Unit cover for `validateProperties`' content-addressed cache

Unit cover for `validateProperties`' content-addressed cache. The behaviour that matters most — a `property_schema` edit reaching a LIVE process — is proved end to end in `property-schema-live-edit.integration.test.ts` through the real HTTP write path, because that is the only shape that can prove it (see that file's header). What is left for a unit test is the part the integration test cannot reach in reasonable time: the bounded-cache reset branch.

That branch exists for a deployment with more distinct schemas than `CACHE_LIMIT`, which no normal estate hits — so without this test it would be a code path that ships unexercised, which is the same defect class this whole change is about.

### §149. Asserts the write was refused, keyed on status not wording

Asserts the write was REFUSED, and returns the refusal so a caller can inspect it.

Deliberately keys on the 400 status rather than on the message: `badRequest` builds a `ProblemError` whose `.message` is the generic title "Bad Request" and whose `.detail` carries the Ajv text, so a `toThrow(/JSON Schema/)` matcher passes vacuously against `.message` — it would go green for a refusal thrown by something else entirely.

## `apps/server/src/graph/property-validation.ts`

### §150. Validates properties against the type's registered schema

Validates instance `properties` against a registered type's `property_schema` (JSON Schema) at write time (DESIGN.md §4.1 "instance properties validated against the registered JSON Schema (Ajv) at write time"). One Ajv instance, plus a compiled-validator cache — compiling is the expensive part and schemas change only a few times a year.

THE CACHE IS KEYED ON THE SCHEMA'S CONTENT, NOT ON THE TYPE'S IDENTITY. That is the whole design, and it is a correctness property rather than a micro-optimisation, so it is worth stating why the obvious alternative is wrong.

This cache used to be keyed on `object_types.id` and paired with an exported `invalidatePropertyValidatorCache(typeId)`. That function had ZERO callers for its entire life — but wiring it up would not have fixed anything either, because the only thing that ever mutates `object_types.property_schema` is a SQL migration, and migrations reach a running deployment from a process that has no cache to invalidate:

```text
- `main.ts` applies migrations at boot, before `app.listen` — this process's cache is empty
  at that moment, so there is nothing to invalidate and never was.
- `migrate-bin.ts` is the real path — the Helm chart's `pre-upgrade` Job, which the Ansible
  fleet rollout also reaches, since that role delegates to `helm upgrade --install` rather
  than migrating itself. It is a SEPARATE, SHORT-LIVED process that applies the `UPDATE`,
  exits, and by design leaves the already-running api/worker pods serving
  (`deploy/helm/templates/migrations-job.yaml`: "old-version pods keep serving ... for the
  whole rollout window").
  Those pods are where the stale validator lives, and a function call in the Job's heap
  cannot reach them. The chart defaults to 2 api + 2 worker replicas.
```

So an in-process invalidation call is a no-op against the one path that matters, and the real choice was between three cross-process designs:

```text
(1) LISTEN/NOTIFY on `object_types` (the precedent exists — `events/outbox-relay.ts` LISTENs
    on `scp_outbox_insert`). Costs a trigger migration and a DEDICATED long-lived Postgres
    connection in every process, including the api pods, which hold no listener today. And it
    is still only eventually consistent: NOTIFY is asynchronous, so a request already in
    flight validates against the stale validator regardless.
(2) A short TTL. No migration and no connection, but it is knowingly wrong for the length of
    the TTL, and it re-compiles every schema forever to defend against an event that happens
    a few times a year.
(3) This: make the key the schema itself. The cached validator is then, by construction, the
    validator for the exact document the caller just read out of the database inside the
    current transaction. Staleness stops being a bug that must be corrected and becomes
    UNREPRESENTABLE — a changed schema is a different key.
```

(3) wins on charter decision priority #1 (Simplicity) against both alternatives, and it is the only one of the three that is correct with no window at all. It adds no required stateful service, no connection and no background machinery, so charter principle 4 is untouched. It is also correct on one process or fifty, api or worker, under compose, Helm, Ansible or an air-gap bundle, because it coordinates nothing.

It matters just as much that (3) deletes the install site rather than adding one. An invalidation call is a step every future migration author has to remember, and the failure mode when they forget is silent and green — which is precisely how the zero-caller invalidator survived this long. There is now nothing to remember: every caller already goes through this function, and this function cannot be given a schema and use a different one.

The hash is a CONSERVATIVE key, which is the property that makes this safe. Different content always yields a different key (so a stale hit is impossible); identical content normally yields the same key, and if it ever did not — key ordering differing between two reads, say — the cost is one redundant compile, never a wrong verdict. In practice Postgres normalises jsonb key order, so a given stored document always stringifies identically. Two distinct types with byte-identical schemas (`{"type":"object"}` is very common here) correctly share one validator.

### §151. BOUNDED, and the Ajv instance is replaced rather than kept

BOUNDED, and the Ajv instance is replaced rather than kept — not belt-and-braces. Ajv 8 keeps its OWN `_cache: Map<AnySchema, SchemaEnv>` keyed on the schema OBJECT REFERENCE (ajv/dist/core.js `_cache.get(schema)` / `_cache.set(sch.schema, sch)`). Every read of a jsonb `property_schema` produces a fresh object, so each `compile()` adds an entry there that is never reachable again. Clearing only the map below would therefore cap our memory and leak Ajv's. Dropping both together is the only reset that actually resets.

This is a backstop, not a working eviction policy: the whole estate has a few dozen registered types, so the limit is not reached in any normal deployment. It exists because the previous id-keyed cache was already unbounded along the same axis (`type_registry:write` mints new type ids without limit) and nothing capped it.

### §152. Throws unless properties satisfy the schema; null allows all

Throws `badRequest` if `properties` does not satisfy `propertySchema`. A null/undefined schema means "unconstrained" and validates everything.

Deliberately takes NO cache key. The schema IS the key (see the module comment) — a caller cannot pass a stale or mismatched one, because there is nothing to pass.

## `apps/server/src/graph/query-timeout.integration.test.ts`

### §153. Defensive graph guardrail (adversarial review of PR #15)

Defensive graph guardrail (adversarial review of PR #15) — see query-timeout.ts's module doc for the full "why" (the `impact-of` recursive CTE's measured fan-in^depth blowup; the CTE fix itself is a separate, pending owner decision — this suite is only about the timeout bound).

### §154. Route-level confirmation that `GraphQueryTimeoutError`

Route-level confirmation that `GraphQueryTimeoutError` (thrown by `withStatementTimeout` above) actually reaches the client as the RFC 9457 HTTP 408 problem-details response `routes/graph.ts` promises (catch `GraphQueryTimeoutError` → `errors.ts`'s `requestTimeout()`) — not a raw 500, not a hung request. Adversarial review of PR #18 flagged that this end-to-end mapping lost its only assertion when the M9.1 CTE fix (below) turned its old pathological-topology fixture into a fast 200 — the `withStatementTimeout`-level tests above only assert the error TYPE (via a `pg_sleep` unit call), never that a real route response carries it as a 408.

Deliberately does NOT rebuild the old EXPONENTIAL fan-out^depth topology to force this — the whole point of M9.1 is that a normal topology no longer explodes (see the suite below), so reintroducing that shape here would be exactly the slow/flaky test this task was told to avoid.

It's tempting to reach for `config.ts`'s existing `SCP_GRAPH_QUERY_TIMEOUT_MS` seam (already exercised below at a looser 3000ms) turned down to the tightest non-disabling value (1ms — Postgres treats `statement_timeout = 0` as "disabled", i.e. unlimited) against a trivially small (2-node) graph. Empirically that is FLAKY, not just slow: `statement_timeout` cancellation is delivered via a timer signal (Postgres `timeout.c`), and at ~1ms the race between "does the signal get delivered and observed at the next `CHECK_FOR_INTERRUPTS`" and "does the (genuinely sub-millisecond, on a 2-node graph, warm connection) query just finish first" is decided by OS timer/scheduling jitter, not by the query actually being slow — repeated local runs against a 2-node graph at 1ms came back a clean 200 (no cancellation at all) as often as a 408. Widening the *graph* (still no depth beyond one hop, still linear — not the old exponential shape) instead widens the gap between "real query cost" and "timeout bound" enough to make the outcome deterministic: a single-level fan-in of WIDTH ordinary objects that all `depends_on` one target (bulk INSERT, same technique the CTE-fix suite below uses).

SIZING (corrected). An earlier version used WIDTH=1000 against the 10ms bound below and claimed a "~4-5x margin, flake-free". That held in ISOLATION but occasionally returned 200 in the FULL suite: after ~340 prior tests Postgres's shared buffers are warm, so the 1000-row walk finished under 10ms before the timer fired — a real flake, not a phantom. The walk is CPU-bound and O(WIDTH), so the fix is simply a much larger margin: WIDTH=30000 costs on the order of hundreds of ms of unavoidable CPU work (~50-150x the 10ms bound), which no cache warmth or faster machine can compress below 10ms, and full-suite CPU contention only makes slower (more likely to cancel). 30k rows is one bulk INSERT (~1s to seed) and is still NOT the pathological shape — linear fan-in, one hop, no recursion-step blowup is even possible here.

### §155. A single-level fan-in

A single-level fan-in: WIDTH ordinary service objects, each with its own depends_on edge into one target — genuine, non-exponential work (see module doc for why this width/timeout pair was chosen). Bulk INSERT bypassing the API, same technique as the CTE-fix suite below.

WIDTH sized for a LARGE margin (~50-150x), not a tight one. The prior 1000/10ms pair was flake-free in ISOLATION but occasionally returned 200 in the FULL suite: by then Postgres's shared buffers are warm from ~340 prior tests, so the 1000-row walk finished under the 10ms bound before the timeout fired. A ~10ms recursive walk of 1000 warm rows is CPU-bound and O(WIDTH), so 30k rows costs ~30x that — hundreds of ms of unavoidable CPU work that no cache warmth or faster machine can compress below the 10ms bound, while full-suite CPU contention only makes it slower (more likely to cancel, never less). 30k rows is one bulk INSERT (~1s to seed) and is still emphatically NOT the pathological shape — linear fan-in, one hop, no recursion-step blowup.

### §156. End-to-end, route-level confirmation that the M9.1 CTE fix

End-to-end, route-level confirmation that the M9.1 CTE fix (graph/named-queries.ts's `transitiveReverseClosure` — see its doc comment for the approach) actually resolved the pathological case this guardrail was originally built to merely survive: the exact fan-in^depth topology that used to run unbounded (this test used to assert a 408 here) now returns a normal 200, with the correct closure, comfortably inside a tight timeout — not just "doesn't hang", but "computes the right answer fast". The generic guardrail mechanism itself (statement_timeout translating to a clean 408 on a genuinely slow statement) is still covered above by the pg_sleep-based tests, and remains in place as belt-and-braces — see `query-timeout.ts`'s module doc.

### §157. A small but combinatorially explosive fan-in graph

A small, cheap-to-insert, but (pre-M9.1) COMBINATORIALLY EXPLOSIVE fan-in DAG (bulk INSERT, bypassing the API — same technique load-test/graph-scale.ts uses for scale, at a tiny fraction of its size): LAYERS layers of WIDTH nodes each, EVERY node in layer i depends_on EVERY node in layer i+1 (a complete bipartite join per layer). Walking `impact-of` BACKWARD from a single last-layer node used to explore WIDTH^(LAYERS-1) distinct PATHS (named-queries.ts's old "no intermediate node-dedup" root cause — see this suite's module doc) — with WIDTH=12, LAYERS=9 that's 12^8 ≈ 4.3*10^8 paths, genuinely unbounded pre-fix, while costing only ~1,260 rows to set up. Post-M9.1, node-level dedup means this same topology costs only ~WIDTH*(LAYERS-1) closure rows (every node sits at exactly one distance from the target in this uniform layered DAG), hence the assertions below.

### §158. The permission walk climbs `domain_id` to the bound scope

RBAC (authz/resolve.ts's scope_expand) walks `domain_id` from the queried object up to the scope a role binding actually covers — bulk-inserting with `domain_id: NULL` (as load-test/graph-scale.ts does, since that script calls runNamedQuery directly and never goes through authorize()) would make every synthetic object its OWN unreachable scope island, and the admin's org-root role binding would never match. Point every synthetic object's domain_id at the REAL org root object (one hop to the admin's actual scope) so this test exercises normal RBAC, not a bypass of it.

## `apps/server/src/graph/query-timeout.ts`

### §159. Defensive graph guardrail (adversarial review of PR #15)

Defensive graph guardrail (adversarial review of PR #15): the five reachability named queries (graph/named-queries.ts's `transitiveReverseClosure`, backing `impact-of`/`dependents-of`/ `consumers-of`/`blast-radius`/`domains-impacted`) used to NOT node-dedupe between recursion steps — only the final `SELECT DISTINCT` did — so intermediate row count grew roughly as (effective fan-in)^depth on a shared-component topology. Measured (see the M8 PR body's Load/perf section): a ~11-way fan-out at depth 10 ran 7+ minutes and then exhausted disk via recursive-CTE temp-file spill; even a ~3-way fan-out over 10 hops tripped a 30s ad hoc timeout during that same load test.

M9.1 FIXED the CTE itself (node-level dedup between recursion steps — see `transitiveReverseClosure`'s doc comment for the approach and the correctness argument for why the returned node set is unchanged). `graph/traverse.ts`'s own generic walk is a separate capability with the same shape of cost and was NOT touched by that fix — it still relies solely on this timeout guardrail. This module's job stays exactly what it was: bound the RUNTIME so ANY pathological topology (including ones this fix doesn't cover, or a future regression) fails cleanly (a 408, not a hung worker/connection or a disk-exhaustion incident) instead of running unbounded — belt-and-braces, not a substitute for the CTE fix. `apps/server/src/load-test/ graph-scale.ts` already uses the identical `set_config('statement_timeout', ...)` pattern as its own safety net during load testing (see its module doc) — this is the same mechanism, wired into the actual API routes with a much tighter, production-appropriate default.

### §160. Bounds every statement with `SET LOCAL statement_timeout`

Runs `fn` with Postgres's own `statement_timeout` bounding every statement `fn` issues on `tx`, `SET LOCAL` so the bound never leaks past this transaction onto a pooled connection reused by an unrelated request. `SET` itself doesn't accept a bind parameter (unlike a regular `SELECT`), so this uses `set_config(...)`, same pattern db/tenant-tx.ts uses for `app.current_org_id`.

A statement cancelled by that timeout (Postgres error 57014) is translated to `GraphQueryTimeoutError` — never a raw driver error reaching the caller unrecognized.

## `apps/server/src/graph/raw-row-mappers.ts`

### §161. Raw `execute` returns untyped rows, so map them here

`tx.execute(sql\`...\`)` (used by the recursive-CTE named queries and traversal — drizzle's query builder can't express those) returns *raw* pg driver rows: literal snake_case column names, and `bigint` columns (`revision`, `version`) come back as strings (node-postgres's default int8 handling, to avoid precision loss) rather than the numbers drizzle's query builder would produce via its `bigint({ mode: 'number' })` column type. `objects-repo.ts`'s `toGraphObject` assumes the query-builder shape, so raw-SQL call sites map through here instead — same public `GraphObject` shape, correct field names and types either way.

### §162. A plain boolean, unlike the bigints above

M20.1 (ADR-0031). Plain `boolean` with no string variant, unlike the bigints above: pg returns bool as a JS boolean, and the column is NOT NULL so every `SELECT *` row carries one. All four raw call sites (`named-queries.ts` ×3, `traverse.ts` ×1) select `*`/`o.*`, so it arrives without touching their SQL — but a future raw query that enumerates columns must include it, or this mapper would emit `undefined` for a field the wire schema requires.

## `apps/server/src/graph/relationship-authz.integration.test.ts`

### §163. PR #4 security review, CRITICAL 1

PR #4 security review, CRITICAL 1: relationship writes require `relationship:write` at BOTH endpoints' scopes (docs/DESIGN.md §7). The attack this forecloses: `member_of` edges feed RBAC subject expansion (authz/resolve.ts), so a from-side-only check would let any subject with `relationship:write` at their own user object add themselves `member_of` any team/group and inherit its role bindings — privilege escalation through the graph itself.

## `apps/server/src/graph/relationship-resurrection.integration.test.ts`

### §164. RE-CREATING A REMOVED RELATIONSHIP

RE-CREATING A REMOVED RELATIONSHIP — a pre-existing defect, found by needing leave-and-rejoin

`relationships_org_type_from_to_key` is a FULL unique constraint on `(org_id, type_id, from_id, to_id)`, while every removal in this codebase is a SOFT delete. Those two facts together meant an edge could be created exactly ONCE, ever: after a delete the triple stayed occupied by a tombstone that confers nothing, and re-creating it returned `409 relationship already exists` — naming a row the caller cannot see and which grants nothing.

MEASURED on the ordinary route before the fix: join a group, `DELETE /relationships/{id}`, POST the same edge -> 409. So a person removed from a team could never be re-added, by anyone, for the life of the deployment.

It is INDEPENDENT OF SSO and predates it. It surfaced only because a directory sync has to handle leave-and-rejoin, which is an entirely ordinary directory event — the feature did not cause the bug, it just made it unavoidable.

The fix is RESURRECTION rather than a partial index: reviving the row keeps ONE row per triple, which is the identity the constraint already asserts, where a partial index would allow N tombstones beside one live row and make every reader that joins on the triple pick between them.

### §165. A RESURRECTION IS A CREATE

A RESURRECTION IS A CREATE — and it must leave every trace a create leaves

The resurrection branch returned as soon as it had un-tombstoned the row, so reviving an edge was the ONE write in `relationships-repo.ts` that happened invisibly: no audit event, no sync-journal entry, no event publish. The tests above cover the row, the revision and the authority it confers — all of which were already green while the rejoin was unauditable, unreplicable and unobservable. That is exactly the shape of a test that passes for a reason other than its claim, so the traces get their own assertions here, on a fresh org so the counts mean what they say.

## `apps/server/src/graph/relationships-repo.ts`

### §166. Does either endpoint stay inside its own security domain

M20.3 (ADR-0031 §4) — does either endpoint of an edge stay inside its own security domain?

Deliberately reads endpoints **including soft-deleted ones** (no `deletedAt` predicate): the one caller is `deleteRelationship`, which frequently runs while an endpoint is itself being torn down, and resolving a deleted endpoint to "not domain-local" would leak precisely at teardown — the moment a `relationship_tombstone` naming its id would otherwise cross.

One query for both endpoints; a self-edge collapses to a single row, which `.some()` handles without a special case.

### §167. The shared 409 when the `to` side already has such an edge

The 409 for "the `to` side already has an incoming edge of this type" — shared by BOTH the app-level `assertCardinality` pre-check AND the DB-index race backstop in `createRelationship`'s catch block, so a component that already has a service surfaces the SAME message whichever guard fires (M12 P5b — the migration-0022 partial unique index caught a concurrent create with the misleading generic "relationship id already exists" before this).

### §168. The mirror of `cardinalityToSideConflict` for the FROM side

The mirror of `cardinalityToSideConflict` for the FROM side — shared by the app-level `assertCardinality` pre-check and by the migration-0049 index race backstop, so a component that already has a pipeline surfaces the SAME message whichever guard fires.

### §169. Which side of the edge each cardinality makes singular

Which side of the edge each cardinality makes singular. Exhaustive BY CONSTRUCTION: an unrecognised value is absent from this map and `assertCardinality` refuses the write rather than falling through unenforced (`relationship_types.cardinality` is plain `text` with no CHECK constraint, so a typo in a migration is reachable). That silent fall-through is exactly the trap migration 0021 had to design around when `many_to_one` did not exist.

### §170. Refuses a `contains` edge that would close a containment cycle

Refuses a `contains` edge that would close a containment cycle — **over BOTH containment routes, because containment has two and this check used to walk one.**

Before the `assembly` level, a cycle was IMPOSSIBLE by construction: `contains` only ran `service -> component`, and a component has no children. Widening the type makes A-contains-B, B-contains-A expressible for the first time.

## What this used to claim, and what was actually true

The previous wording said a cycle "is an infinite walk in the code paths that authorize releases", and named `containmentChain` (policy scope, freeze scope, RBAC scope) and the ADR-0029 binding ladder as the victims. Both halves were wrong, and they were wrong in opposite directions:

- **Not infinite.** Every named consumer is bounded. `graph/containment.ts`'s `containmentChain` and `authz/resolve.ts`'s `scopeExpandCte` both stop at `CONTAINMENT_WALK_MAX_DEPTH`; `coordination/binding-resolution.ts`'s ladder stops at `MAX_ANCESTOR_HOPS` (3). A loop costs them iterations, not termination. - **Not protected.** `containmentChain` walks `domain_id` AND `contains` (and a placement's pair). This function walked `contains` alone, so the MIXED loop — one hop of each — was invisible to it and writable through this door. MEASURED before this change, on the real HTTP doors: create an assembly A, create a service S with `domainId: A`, then `POST /relationships {contains, from: S, to: A}` answered **201**, and `S -> A -> S` was in the table. The `domain_id` door refuses exactly that loop (`graph/containment-parent-authz.ts` calls `assertRootedContainmentParent`, which checks the WHOLE walk and says so in as many words); the edge door did not. One concept, two doors, one of them taught.

## What a mixed loop actually costs, since it is not a hang

It cannot DETACH a row — adding an edge only adds parents, and `domain_id` parents are kept rooted by their own door, so the org root stays on every chain. What it corrupts is DEPTH. `containmentChain` re-reaches a looped node at every second iteration, keeps the MAXIMUM raw depth per id, and then inverts, so the target of the walk can come out at inverted depth 0 — the value the convention reserves for the org root — with the actual org root ranked BELOW it. Measured on the loop above: the walk ran to the depth bound and `assertRootedContainmentParent`'s `hops` (derived from that inverted depth) reported **1**. That matters because the truncation refusal `hops` feeds exists precisely to fail CLOSED when a walk was cut short and the cycle answer is therefore unproven — near a loop it silently stops firing. Refusing to write the loop is the cheapest place to stop that, and it is the place the other door already stops it.

## Why `containmentChain` rather than a widened hand-rolled walk

It is the definition of "what contains this object" that every consumer of this decision reads, so a route added there (route 4 arrived after route 3) is inherited here instead of drifting away from here — the exact failure `graph/containment.ts`'s header records paying for twice. It is also a FIXED one query, where the hand-rolled walk was one round trip PER HOP (1 in the common shape, up to 32), so the widened check is not paid for in latency on the deep shapes. Its bound is the shared `CONTAINMENT_WALK_MAX_DEPTH`, and since nested domains landed the walk from `fromId` covers the container's whole `domain_id` ancestry too — a container under nine stacked domains sits at ten hops, which is why the depth question below is asked here at all. It also skips tombstoned ancestors, matching `scopeExpandCte` — a deleted object is not a container.

## The cycle question AND the depth question — not `assertRootedContainmentParent` wholesale

A `contains` edge is containment ROUTE 2 (`graph/containment.ts`), so writing one adds a hop to the `to` row's chain exactly as a `domain_id` write does — and to every row UNDER it. The DOOR INVARIANT (owner ruling 2026-08-18, ADR-0037 Consequences: every live row reaches the org root within the bound over its longest route) therefore has to be enforced here as well as at the `domain_id` doors, with the ONE shared arithmetic in `assertContainmentDepthAdmits`: `hops(container) + 1 + height(to) > bound` refuses. RETIRED REASONING, kept so nobody reinstalls it: an earlier version of this block declined the depth refusal on the grounds that "a ten-hop chain is complete and readable" and that refusing under such a container "would quietly lower a documented limit". The container's chain IS complete at ten hops; the COMPONENT attached to it then sits at hop eleven, and every walk of that component refuses (measured: `containmentChain` threw, `matchPoliciesForTargets` threw, and in an org with any policy at all the reach capture below refused the create with the walk's 409 AFTER the row was written, so the whole thing was already being refused — accidentally, and only when a policy existed). The limit was never lowered; the door now counts the row it writes.

The ROOT-REACHABILITY refusal (`assertRootedContainmentParent`'s third) is still deliberately left out here: it would newly reject edges inside an already-stranded subtree, which is the one place an operator still has to work.

## `federationImport` — the cycle question runs, the depth question does not

A signed-journal replica reaches this door too (`federation/import-repo.ts` `relationship_upsert`). The depth refusal is carved out for it for the reason the `domain_id` doors state at theirs: the receiving domain does not referee a peer-authored containment — and here the depth of a replica's chain is not even the origin's depth, because `resolveImportDomainId` may have re-parented the replicated rows above it onto THIS org's root. Failure mode, grounded: that importer catches a 400 per ENTRY (the edge is skipped) but re-throws anything else, so a door 400 here would silently drop a peer's edge rather than wedge the channel, and the walk's own 409 — `containmentChain` refusing because the imported CONTAINER is already past the bound — DOES wedge the whole bundle today, independent of this door. Both are named rather than fixed here. The cycle check keeps running on import (a loop is invalid in any org), and its 400 is the one that importer skips.

### §171. IdP GROUP SYNC (`auth/identity-sync.ts`)

IdP GROUP SYNC (`auth/identity-sync.ts`) — exempts this write from the `member_of` subset rule below, and from NOTHING ELSE.

A login-time sync has no human actor: the "actor" is the identity provider, so the rule that asks whether the actor already holds what the group confers can never be satisfied. Owner decision (2026-08-28): carve the sync out and move the bar to AUTHORING THE MAPPING (`authz/identity-mapping-door.ts`), because the escalation §2a closes is a principal choosing to join a high-privileged group — and nobody chooses their own claims.

DELIBERATELY A SEPARATE FLAG FROM `federationImport`, not a reuse of it. The two exemptions cover different guards for different reasons, and folding this into that boolean would silently widen the federation path the day either rule changes.

### §172. THE RESERVED GOVERNANCE LABEL NAMESPACE, on the edge table too

THE RESERVED GOVERNANCE LABEL NAMESPACE, on the edge table too — see `governance/governance-labels.ts`. No governance decision reads a RELATIONSHIP's labels today (`coordination-as-code/plans-repo.ts`'s stack-ownership markers are the only reader), and that is exactly why it is guarded here rather than later: the namespace is worth having only if the sentence "a `scp.governance/` key was set by an org-root `policy:write` holder" is true of every labels bag in the system. Left off, the next consumer to read an edge label inherits the same evasion, and nothing about this file would flag it. Relationships have no update verb (create + soft-delete only — see `deleteRelationship`), so this create is the complete census of edge-label writes.

The `federationImport` exemption is the one this repo already applies at both choke points, for the same reason: `federation/import-repo.ts`'s replay branch has no try/catch, so a throw there aborts a whole signed bundle rather than one entry.

### §173. THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS

THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS (migration 0055's header). `relationship_types` holds flat from/to arrays — a cross-product — so widening `contains` to admit the `assembly` level necessarily also admits `assembly -> assembly`, which is not a shape we want. It is refused here, with the containment cycle check, because there is nowhere in the registry to say it.

### §174. A `member_of` EDGE IS A ROLE GRANT

A `member_of` EDGE IS A ROLE GRANT — the no-escalation subset rule, at the choke point.

`authz/resolve.ts`'s `subject_expand` walks `member_of` from_id -> to_id, so a role binding held by a GROUP or TEAM resolves for every member. Writing this edge therefore hands `toId`'s authority to `fromId` without a `role_bindings` row ever being written — which routes straight around `docs/authz/role-binding-door.md` §2, the rule that stops a `role_binding:write` holder minting themselves Owner. MEASURED before this guard: an org-root **Operator** — four rungs below Administrator — self-joined a group holding Owner and resolved as Owner, using only the `relationship:write` every org-root principal from Operator upward holds at every object.

The both-endpoint `relationship:write` check in `routes/relationships.ts` was designed for exactly this attack and its docblock says so; it only constrains a principal whose `relationship:write` is NARROW, and an org-root binding is not narrow.

HERE AND NOT AT THE ROUTE, because this function is where an edge is actually created: IaC apply (`coordination-as-code/plans-repo.ts` replays the manifest diff's free-form `typeId`) and discovery-accept (`routes/executors.ts`) both reach it without passing through `POST /relationships`. A route-only guard is the shape the campaign-deadline fix in this same programme had to abandon twice. The full reasoning, the exploit chain and what this deliberately does NOT do (removal is a narrowing and stays ungated; bar §1 is not applied here) are in that module's §2a.

THIS GUARDS ONE OF TWO ORDERINGS. Joining a group that ALREADY holds a binding is refused here; joining an empty group and having a binding written onto it afterwards is not, and must not be — the empty-group join is every ordinary team membership on the estate. The other ordering is `docs/authz/role-binding-door.md` §2b, on the grant door, and §8 of that module lists what neither closes.

AND THERE IS A THIRD ORDERING: NEITHER. Concurrently, this join and that grant each read before the other writes, so a request pair whose every SERIAL order refuses one of the two is admitted twice. `assertMayJoinRoleBearingSubject` takes the org's advisory lock as its own first statement to close that (`docs/authz/role-binding-door.md` §0) — HERE and not at the route, and taken inside the guard and not beside it, because `createRelationship` has thirteen callers.

The `federationImport` exemption is the one this file already applies to `assertMayWriteGovernanceLabels` above, for the identical reason: `federation/import-repo.ts`'s replay branch skips only a 400, so a 403 here would abort a peer's whole signed bundle rather than one edge. A replicated membership was decided at the authoring domain's own door.

The type guard keeps this off every other relationship write in the system — a `contains`, `owns`, `places` or `depends_on` create short-circuits on a string comparison and costs nothing.

### §175. CONTAINMENT ROUTE 2

CONTAINMENT ROUTE 2 — a `contains` edge IS a containment parent (`graph/containment.ts` route 2, walked backwards), so creating one changes which policies reach the CHILD, under `relationship:write`. That is weaker and differently held than the `policy:write` that authored those policies — see `governance/governance-reach.ts`.

The type guard keeps this off every other relationship write in the system: a `member_of`, `owns`, `places` or `depends_on` create short-circuits on a string comparison and costs nothing.

### §176. Resurrection: re-creating an edge that was removed

RESURRECTION — re-creating an edge that was previously removed

`relationships_org_type_from_to_key` is a FULL unique constraint on `(org_id, type_id, from_id, to_id)` — NOT partial on `deleted_at IS NULL` — while every removal in this codebase is a SOFT delete. Those two facts together meant an edge could be created exactly once, ever: after a delete the triple was permanently occupied by a tombstone that confers nothing, and re-creating it returned `409 relationship already exists` naming a row the caller cannot see and which grants nothing.

MEASURED on the ordinary route, not inferred: join a group, `DELETE /relationships/{id}`, then POST the same edge -> 409. So a person removed from a team could never be re-added, by anyone, for the life of the deployment. Pre-existing and independent of any IdP; found because a directory sync must handle leave-and-rejoin, which is an entirely ordinary event.

THE FIX IS RESURRECTION, NOT A PARTIAL INDEX. Making the index partial would allow N tombstones plus one live row for the same triple, so `member_of` history would fan out and every reader joining on the triple would have to learn to pick. Reviving the existing row keeps ONE row per triple — the identity the constraint already asserts — and keeps the tombstone's history.

EVERY GUARD ABOVE HAS ALREADY RUN at this point, including the `member_of` subset rule, so a resurrection is authorized exactly as strictly as a first-time create. It deliberately does NOT reuse the tombstone's old properties/labels: this is a new edge that happens to reuse a triple, so the caller's current input wins, and `revision` advances rather than resetting.

### §177. A RESURRECTION IS A CREATE, AND IT OWES EVERYTHING A CREATE OWES

A RESURRECTION IS A CREATE, AND IT OWES EVERYTHING A CREATE OWES.

This branch used to `return` right here, which made reviving an edge the one write in this file that happened invisibly: no audit event, no governance-reach record for a `contains` edge, no journal entry, no event publish. An operator reading the audit log saw the leave and never the rejoin, a subscriber never learned the edge was back, and a peer that had already replicated the tombstone kept it forever. The four calls below are the insert branch's, in the same order and in the SAME transaction — the audit hash chain admits nothing else.

### §178. M20.3 (ADR-0031 §4) — AN EDGE INHERITS LOCALITY FROM EITHER ENDPOINT

M20.3 (ADR-0031 §4) — AN EDGE INHERITS LOCALITY FROM EITHER ENDPOINT.

EITHER, not both, and that is the whole point: the interesting edge is the MIXED one — a domain-local networking component `part_of` a service the commander knows about. Requiring both endpoints to be local would let exactly the leaking case through, because a `relationship_upsert` payload carries `fromId`, `toId`, `typeId`, `properties` and `labels`. Shipping that and letting the receiver decline to store it is a leak with a swallow, not invisibility — the edge still names the local object's id in a file written to disk and relayed.

Both endpoints are already loaded and validated above (`requireLiveObject`), so this costs no extra query — and reading them is the only correct source, since locality is a property of the objects, never of the edge's own request.

### §179. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7) — DOOR B, AND THE CASCADE OF DOOR C.

Removing the `member_of` edge under a group's administrative binding leaves the BINDING ROW INTACT while no live principal resolves through it any more. MEASURED, in four plain sequential requests with no concurrency and no special privilege: create a team, join it, bind Owner to it, revoke the bootstrap admin's binding (admitted — the team reaches a live member), then `DELETE /relationships/{that member_of edge}` -> 200, and the org is unadministrable with hand-written SQL the only recovery. The revoke-time guard counted the surviving row and reported success, because a check that models ONE verb is a check the other verbs route around.

`deleteObject`'s edge cascade calls this function per edge, so tombstoning a group that HOLDS an administrative binding is refused here too, on the edge whose removal actually empties the floor rather than on the object tombstone that is merely its cause.

AFTER the tombstone, on purpose: the predicate asks what is TRUE now rather than modelling what this write is about to do, which is what makes it blind to the verb and therefore complete over the cascade. It takes §0's org lock itself. See §7.

`type_id = 'member_of'` is a statement about the floor's inputs, not a filter over callers: the closure it walks contains no other edge type, so no other edge tombstone can change its answer. Every other relationship delete in the system costs one string comparison.

FEDERATION IMPORT IS EXEMPT, the mechanism this file already applies to `assertMayWriteGovernanceLabels` and `assertMayJoinRoleBearingSubject`: `import-repo.ts`'s replay branch re-throws anything but a 400, so a 409 here would abort a peer's whole signed bundle over one replicated membership this instance has no authority to keep.

### §180. The tombstone re-resolves locality, as the create did

M20.3 (ADR-0031 §4) — the tombstone inherits locality the same way the create did, and it has to be RE-RESOLVED here: the edge row itself carries no locality (locality belongs to the objects), so this is a real lookup rather than a field read. A tombstone payload names `fromId` and `toId`, so letting it cross would disclose the local object's id and the fact that its edge was removed. Endpoints are read even when soft-deleted — a deleted endpoint is still a domain-local one, and resolving it to "not local" would leak precisely at teardown.

## `apps/server/src/graph/rls.integration.test.ts`

### §181. BUILD_AND_TEST.md §8 M1 DoD (a)

BUILD_AND_TEST.md §8 M1 DoD (a): "adversarial RLS cross-org probes: cross-org reads/writes with wrong or unset app.current_org_id fail closed on every tenant table". Everything here goes through `RawScpAppClient` — a raw `pg.Client` running as the same least-privileged `scp_app` role a real request uses, but issuing hand-written SQL directly (no application code, no `withTenantTx`) — so these probes exercise the database's own defenses, independent of whether the app layer remembers to filter by org.

### §182. The leak the role split itself introduced in review

Regression guard for the subtle leak the role split itself introduced in review: RLS policies naming a role also apply to members that INHERIT from it, so a plain `GRANT scp_relay TO scp_app` would have silently given every ordinary scp_app query cross-org outbox visibility. Membership is INHERIT FALSE — relay powers exist only inside an explicit SET LOCAL ROLE scp_relay transaction (previous test).

### §183. M8 security pass (drizzle/0016_instance_keys_rls.sql)

M8 security pass (drizzle/0016_instance_keys_rls.sql): `instance_keys` became org-scoped in M6 (one Ed25519 PRIVATE SIGNING KEY per org) but was never given an `org_isolation` policy — its "no RLS" reasoning predated M6 and was written for a single global row. Regression coverage for that fix, same adversarial-probe shape as every other tenant table above: wrong/unset org context must fail closed, and a cross-org INSERT must be rejected.

### §184. `scp_app` only ever has SELECT+INSERT on this table

`scp_app` only ever has SELECT+INSERT on this table (drizzle/0010_governance.sql — never UPDATE/DELETE), so `ON CONFLICT ... DO NOTHING` (not DO UPDATE) is required — and a row for `orgAId` may already exist (e.g. `governance/attestation.ts`'s `ensureInstanceKey` lazily provisioning one via some earlier test/setup path in this suite; unique index on org_id means at most one row per org either way). This test only cares that SOME row is visible from orgA's own context and that exact row is invisible from orgB's — not which attempt actually won the insert.

## `apps/server/src/graph/service-contains.integration.test.ts`

### §185. `contains` — service/component membership

`contains` — service/component membership (docs/proposals/service-component-model.md, migration 0021). Every component belongs to at most ONE service (owner decision, 2026-07-15).

These tests exist because the enforcement is SUBTLE and easy to get wrong in a way that looks fine: the domain reads "component is part of a service", but registering `component -> service` with `many_to_one` would have been silently unenforced — that cardinality was absent from CardinalitySchema AND had no branch in assertCardinality, so it fell through every check. We therefore register the MIRROR (`service -> component`, `one_to_many`), whose "to side is singular" rule is what actually delivers "one service per component". If someone later "fixes" the direction to read more naturally, these tests fail — which is the point.

`many_to_one` IS enforced as of migration 0049 (ADR-0026 D11), and `assertCardinality` now fails closed on any cardinality it cannot enforce — see cardinality.integration.test.ts. That does not license flipping this edge: 0022's partial unique index and the authz/policy containment walks all key on `service -> component`, so the direction below stays exactly as shipped.

### §186. MUTATION LOG — the `assembly` level

MUTATION LOG — the `assembly` level (migration 0055). Each applied ALONE, then reverted.
| Mutation | Result |
| allow `assembly -> assembly` (drop the app-level refusal) | the assembly-in-assembly test FAILS — the registry's flat from/to arrays admit the pair, so only the app can refuse it | | delete `assertNoContainmentCycle` | **NO TEST FAILS**, and that is recorded rather than hidden. `to_types` excludes `service`, so `assembly -> service` is refused by the endpoint check and a type-legal cycle cannot be built today. The check is unreachable defence-in-depth, kept because widening the arrays makes it live; the loop test pins the OUTCOME, not the mechanism, and says so |

MUTATION LOG — the MIXED-ROUTE loop (M21.7 item E). SUPERSEDES the last row above.
| Mutation | Result |
| delete `assertNoContainmentCycle` | the MIXED-loop test FAILS. The row above was true only while the check walked `contains` alone: it was unreachable because a PURE-`contains` cycle is unconstructible by endpoint type. It now walks both containment routes, and the one-hop-of-each loop IS constructible with legal types — so the check is live, and deleting it is caught | | make the walk `contains`-only again (the pre-M21.7 hand-rolled loop) | the MIXED-loop test FAILS, and nothing else does — which is the measurement of what the old walk could not see | | refuse every `contains` edge | the CONTROL inside the mixed-loop test FAILS, plus most of this file |

RENAMED 2026-08-18: `assertNoContainmentCycle` is now `assertContainsEdgeAdmissible` — the same cycle question plus the DEPTH-BOUND question (owner ruling, ADR-0037 Consequences: no write may leave a live row past `CONTAINMENT_WALK_MAX_DEPTH`). The rows above are kept under the old name as the history they record; the depth half is pinned, per door and with mutation, in `containment-depth-doors.integration.test.ts`, not here.

### §187. THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS

THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS (migration 0055). `relationship_types` holds flat from/to arrays — a cross-product — so widening `contains` for the `assembly` level necessarily admits shapes we do not want. They are refused in the app, and these are the tests that keep the refusals honest.

### §188. READ THIS BEFORE TRUSTING IT

READ THIS BEFORE TRUSTING IT. This test passes, but NOT because of `assertNoContainmentCycle` — deleting that check leaves this test GREEN (recorded in the mutation log). With `to_types = {assembly, component}`, a `service` is not a legal `to` endpoint at all, so `assembly -> service` is refused one layer earlier and a type-legal cycle is currently unconstructible.

The check is kept anyway as defence-in-depth for THIS shape, and it becomes reachable for it the moment anyone widens those arrays — e.g. to allow `service -> service`, which was the rejected alternative shape for this very level.

What this test therefore pins is the OUTCOME (the loop cannot be closed), not the mechanism. If you widen the endpoint arrays, come back and make this test construct a type-legal PURE-`contains` cycle, or that half of the check goes back to being untested.

The check is NOT untested overall any more: the MIXED loop below reaches it, and dies when it is removed. (The claim that used to sit here — "a cycle is an infinite walk in the code that authorizes releases" — was wrong and has been removed from the check's own doc too. Every walk named is depth-bounded. What a cycle actually corrupts is measured there.)

### §189. The hole the check had, and the case that now kills it

THE HOLE THE CHECK HAD, AND THE CASE THAT NOW KILLS IT IF IT IS DELETED.

Containment has TWO routes (`graph/containment.ts`: `domain_id`, and the `contains` edge walked backwards). `assertNoContainmentCycle` walked `contains` alone, so this loop — legal endpoint types, one hop of each route — went straight past it. MEASURED on these doors before the fix: the edge answered **201** and `svc -> asm -> svc` was in the table.

It is the same loop the `domain_id` door already refuses (`assertRootedContainmentParent` checks the whole walk); the two doors simply disagreed about what containment is. Which door you happen to write it through is not a security or integrity boundary.

### §190. A select-then-insert under READ COMMITTED can double-write

assertCardinality is a SELECT-then-INSERT under READ COMMITTED with no row lock, so two concurrent creates can both pass the check and both insert (found by adversarial review of P2). Once `contains` bounds RBAC reach, a doubly-contained component is reachable from BOTH services' bindings — so migration 0022 backs the invariant with a partial unique index. This drives the two creates CONCURRENTLY (Promise.allSettled), which the sequential tests above cannot catch: exactly one must win, whether it loses at the app check or the DB constraint.

## `apps/server/src/graph/service-member-types.ts`

### §191. Object types that MUST belong to a service (M12 P5a)

Object types that MUST belong to a service (M12 P5a) — a `component` is created only through the strict `POST /components` route (which requires a service and writes the `contains` edge atomically), never through a generic/side-door path. The single source of truth so every guard agrees: the generic `/objects/{type}` route (`routes/objects-generic.ts`) and the federation overlay route (`federation/overlay-repo.ts`, M12 P5 follow-up) both refuse these types.

Imports stay permissive by a DIFFERENT mechanism: `discovery/accept` and federation-journal replay call `createObject` directly (server-side, never these routes), so an imported component may be an orphan until organized. Overlay is NOT such an import path — it's a user-facing create surface — so it is guarded here too.

## `apps/server/src/graph/sql-helpers.ts`

### §192. `column IN (…)`, deliberately not `= ANY` over an array

`column IN (v1, v2, ...)`. Deliberately NOT `column = ANY(${values}::type[])`: drizzle-orm's `sql` template tag special-cases JS array interpolations by expanding them into a parenthesized, comma-separated parameter list (`(v1, v2, ...)`) rather than binding a single array-typed parameter — so `${values}::text[]` receives a bare scalar (1 element) or an anonymous record tuple (2+ elements) and fails to cast. `IN` embraces that expansion instead of fighting it. Caller must ensure `values` is non-empty (`IN ()` is invalid SQL).

## `apps/server/src/graph/system-managed-relationships.ts`

### §193. Relationship types the ENGINE owns end to end

Relationship types the ENGINE owns end to end — the generic `POST`/`DELETE /relationships` endpoint AND the IaC plan/apply path must both refuse to create or delete them directly, so the ONLY way one of these edges comes into existence is a dedicated, authority-checked internal path that calls `graph/relationships-repo.ts`'s `createRelationship` directly (never the guarded HTTP endpoint). Single source of truth for both call sites (`routes/relationships.ts`, `coordination-as-code/plans-repo.ts`) — mirrors `governance/governance-managed-types.ts`'s pattern for governance-owned OBJECT types.

- `approves` (DESIGN §10.2 approval EVIDENCE): a fabricated one is a graph-visible fake "X approved this". Created ONLY by the approval-vote path (`governance/approvals-repo.ts`'s `castApprovalVote`); removed only by a rollback of the underlying vote. - `annotates` (DESIGN §13 federation OVERLAYS, M6): a non-owning domain's only legal way to contribute to an object it doesn't own. Per-type overlay rules bound what may be layered (policy overlays may only ADD strictness, never weaken/remove a base requirement) — a rule only `federation/overlay-repo.ts`'s dedicated `createOverlay` enforces before calling `createRelationship` directly. If any actor holding plain `relationship:write` could create an `annotates` edge via the generic endpoint, they could layer a WEAKENING "overlay" that policy-merge-at-read-time code would need to separately distrust — closing the creation vector here means readers can trust every `annotates` edge they see was strictness-checked. - `coordinates` (DESIGN §9.5 campaign MEMBERSHIP): CRITICAL (M5 adversarial review) — campaign rollback reads campaign membership, and a member Change swept into a rollback is a real, side-effectful revert. If any actor holding org-scoped `relationship:write` could inject a `coordinates` edge from a victim's campaign to an arbitrary Change via the generic endpoint (or an IaC manifest), the victim's next legitimate rollback would revert the injected Change too — bypassing `proposeCampaign`'s per-target authority check, the headline campaign coordinates-authz invariant. So `coordinates` is created ONLY by the authority-checked dedicated path: `campaign-repo.ts`'s `proposeCampaign` (campaign -> change, via the reconciler `campaign-reconcile.ts`), which `authorize()`-checks the acting actor's authority before creating the edge. (A second writer was removed with the grouping rung above campaigns — ADR-0036.) Rollback itself no longer trusts these raw edges at all — it sources membership from the plan-compiled `campaign_wave_targets` (`campaign-rollback.ts`) — this block is defense-in-depth on the creation side, closing the injection VECTOR outright.

## `apps/server/src/graph/traverse.ts`

### §194. Generic bounded `/graph/traverse` (DESIGN.md §5)

Generic bounded `/graph/traverse` (DESIGN.md §5) — direction, relationship-type set, depth ≤ 10, org-scoped. Backs the UI graph explorer / custom tooling where a named query doesn't fit.

Two steps: (1) a recursive CTE walks `direction` edges from `objectId` up to `maxDepth`, building the visited node set; (2) the returned edge set is the *induced subgraph* on that node set (every live relationship with both endpoints visited) — richer than just the tree edges used to reach each node, which is what a graph explorer actually wants to render.

### §195. The caller's readable object-id set

The caller's readable object-id set (`object:read` scope), or `null` for an org-root reader who may read everything. When a Set, the returned objects/edges are intersected with it, so a sub-org-scoped principal never sees an object it lacks `object:read` on — the same authority `GET /objects/{type}/{id}` enforces, which the org-only walk otherwise bypassed (2026-08-31 security review; role-model.md §8.6a). `graph:query` gates whether the traversal may run at all; this gates which of its results are visible. Resolved once in routes/graph.ts.

### §196. Induced-subgraph edges over an explicit object-id set

Induced-subgraph edges over an explicit object-id set (DESIGN.md §5). The named graph queries (`impact-of`/`blast-radius`/…) return only the reachable object SET, never the edges among it; this returns exactly the live relationships whose BOTH endpoints are in `ids` — the same induced-subgraph edge set `traverse`'s step (2) computes over its own visited set, but for a caller-supplied node set. One round-trip, org-scoped, soft-delete-aware. The result carries no `objects` (the caller already holds them from the query that produced `ids`) — only the edges.

## `apps/server/src/graph/urn.ts`

### §197. URN scheme: `urn:scp:{org}:{type}:{slug-path}`

URN scheme: `urn:scp:{org}:{type}:{slug-path}` (DESIGN.md §4.1). Callers may supply their own URN (federation imports, IaC, deliberate naming); when omitted, one is derived from the object's name so `POST /objects/{type}` never requires the caller to think about it.
