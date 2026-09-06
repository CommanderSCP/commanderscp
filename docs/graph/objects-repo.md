# objects-repo

Reference for `apps/server/src/graph/objects-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 12 of 57 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE RESERVED GOVERNANCE LABEL NAMESPACE

THE RESERVED GOVERNANCE LABEL NAMESPACE — the THIRD and FOURTH refusals at this choke point, here for the identical reason the two above are, against the identical `federationImport` census, and closed at the identical other caller (`federation/handfill-repo.ts`).

A selector-scoped policy's match key must be out of its own subject's write reach, in both directions: the DOCUMENT may only key on a reserved label, and the reserved LABEL may only be written by org-root `policy:write`. Installing either half alone leaves the evasion — a namespace nobody is required to use, or a required namespace anyone may edit. See `governance/governance-labels.ts`.

## §2. M20.1 (ADR-0031 §1)

M20.1 (ADR-0031 §1). Forced `false` on the import path regardless of what the caller passed: a row that arrived over the journal is, by definition, one that crossed a boundary, so it cannot be domain-local. Coercing here rather than trusting `import-repo.ts` not to pass it keeps the invariant at the choke point every write door funnels through. M20.5 (ADR-0031 §6a): declared OR inherited. The `||` is the either-route rule — a container's locality reaches its children without the child restating it, which is the whole ergonomic point of the subtree layer. `containmentParent.domainLocal` is `false` on the import path by construction (a replica's parent is a replica), and the ternary forces `false` there anyway.

## §3. M20.7 (ADR-0031 §6c) — record WHY, not just whether

M20.7 (ADR-0031 §6c) — record WHY, not just whether.

DECLARED WINS. A caller can pass `domainLocal: true` while creating under an already-local container; the row records DECLARED (null provenance) because that is what the operator actually did, even though the object would have been local anyway. Recording it as inherited would erase an act that happened.

`inheritedFrom` is therefore set ONLY when inheritance is what made it local — the caller did not declare, and a container did. The two columns are written together and cleared together, so the "id without urn" state is unreachable.

## §4. OWNER RULING 2026-08-25

OWNER RULING 2026-08-25 (D1 b-i) — WIDENING A CAMPAIGN'S DEADLINE. The UPDATE half and the ONLY half: a create is always a first set, which the ruling leaves at `object:write`.

Here rather than only at `POST /campaigns/{id}/deadline` for the reason `assertValidCampaignRecipe` two guards up is here — `campaign-recipe-guard.ts`'s census of the SAME property found three write doors, and a route-level guard is invisible to two of them. The ruling shipped at the route alone, and IaC apply reaches this function directly with a free-form `typeId` and free-form `properties`: a manifest that simply omitted `deadline` produced exactly the effect the route refuses, at exactly the permission it was raised above.

A DELTA OVER THE STORED ROW (`existing.properties` vs `nextProperties`), exactly like the two guards above it and for the same two reasons at once: a PATCH that never mentions `deadline` must stay free, and a full-replacement write that OMITS it is a REMOVAL and must be priced as one. Those are the same bytes on the wire and only the stored row tells them apart.

Cheap by construction on every write that is not about a campaign deadline: it returns before resolving anything unless a READABLE deadline is stored and the incoming document releases it. See `governance/campaign-deadline-widening-guard.ts` — including why it asks a strictly NARROWER question than the route's check, so it can never refuse what the route admits, and why `federationImport` (this block's exemption) leaves no local-actor bypass at hand-fill.

## §5. THE VALIDATION HALF OF THIS WRITE

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

## §6. CONTAINMENT ROUTE 1

CONTAINMENT ROUTE 1 — a `domain_id` MOVE changes which policies reach this object, under `object:write`, which is weaker and differently held than the `policy:write` that authored them. See `governance/governance-reach.ts` for the property and why the recording lives at this choke point rather than at the ~18 route handlers that admit `domainId`.

The `!==` guard is what keeps this off the ordinary write path: a PATCH that never mentions `domainId`, and a full-replacement PUT restating the parent the row already has, both resolve to `nextDomainId === existing.domainId` and cost NOTHING — no query, no walk. Only a genuine move pays. Creates are not instrumented at all: a new object has no prior reach to have changed.

## §7. M20.2 (ADR-0031 §2)

M20.2 (ADR-0031 §2). Read from the ROW, never from the request: locality is immutable and `UpdateObjectRequestSchema` cannot express it, so the row is the only truth here.

This stamp is not optional convenience — without it a domain-local object leaks on its SECOND write. Its create entry would be filtered and every later `object_upsert` would sail through carrying its id, urn, name, properties and labels, which is the whole object arriving one revision late. The create-path stamp alone protects nothing.

## §8. CONTAINMENT ROUTE 1, SECOND WRITE SITE

CONTAINMENT ROUTE 1, SECOND WRITE SITE. This branch deliberately does NOT delegate to `updateObject` (see the `subjectDomainLocal` note below), so it needs its own capture for exactly the reason it needs its own audit stamp — and a recorder installed at one of two write sites for one concept is this repo's most-repeated defect (CLAUDE.md's census rule).

Reached only by signed-journal replay reconciling a hand-filled shadow onto its authoritative id, so the actor is the federation import subject rather than a tenant — which is precisely why it is worth recording: a peer's reconciliation can re-parent a local row, and that must be as visible as a local operator doing it.

This `domain_id` write carries NO containment door — neither the root-reachability walk nor the depth bound (`assertRootedContainmentParent`). It is `federationImport`-only by the guard above, so it wears the same carve-out `updateObject` states at its own call: the receiver does not referee a peer-authored containment, and this branch's failure mode is per-CHANNEL (no try/catch around `object_upsert`). Named here so the census of `domain_id` write sites reads "two sites, one door, one deliberate carve-out" and not "one site forgotten".

## §9. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7) — DOOR C, HALF ONE: the RELEVANCE PROBE, which has to be read HERE because the tombstone below and the edge cascade further down both destroy the evidence it reads. The check itself runs at the END of this function.

Tombstoning the USER who holds the org's only administrative binding removes no edge at all, so the cascade's per-edge check cannot see it; tombstoning the TEAM that holds it cascades its `member_of` edges, which the cascade's check does see. Both are covered by asking the invariant once, after everything this function does.

The probe is sound rather than convenient: the floor reads `role_bindings` rows at the org root, `roles.permissions`, live `member_of` edges and `objects.deleted_at`/`type_id`. An object that is no binding's subject and has no live `member_of` edge is in no candidate closure, and this function's cascade will tombstone no `member_of` edge either — so its tombstone cannot change the floor's answer. It reads exactly the two tables the floor reads, which is what keeps the short-circuit honest as those inputs change.

The same two carve-outs the cascade and the orphan guard take, for the same reasons: a peer's `object_tombstone` must not be refused (it would abort the whole signed bundle and diverge this replica from its authority), and a foreign-shadow removal is local cleanup of a row this domain never authored.

## §10. CONTAINMENT ROUTE 3

CONTAINMENT ROUTE 3 — TOMBSTONING A CONTAINER, which writes no containment field and yet detaches everything beneath it (every route in `graph/containment.ts` skips a deleted ANCESTOR).

Captured BEFORE the tombstone, and that ordering is the whole of it. The edge cascade further down re-uses `deleteRelationship`, whose own route-2 recorder runs AFTER this row is already tombstoned — so its before-reach has lost this container too and its diff is empty. The cascade therefore records NOTHING on this path, which is why the container case is instrumented here rather than assumed covered by the edges it deletes.

## §11. CASCADE: an object's edges must not outlive the object

CASCADE: an object's edges must not outlive the object.

Deleting an object used to tombstone the object ROW alone, leaving every `relationships` row touching it with `deleted_at IS NULL` — a live edge to a dead node. Measured on the live homelab (2026-08-02): soft-deleting one component during the post-import-configuration.md §6 pair merge took the estate from 0 such edges to 1, and it had to be cleaned up by hand.

It is not cosmetic, because the containment walk is built out of those edges. `graph/containment.ts` route 2 walks `contains` from `r.to_id` to `r.from_id` filtering on the EDGE's `deleted_at` only, so a dangling edge keeps a deleted service on a live component's chain — and that chain is what `matchPoliciesForTargets`, `containmentScopeIds` and `authz/resolve.ts`'s `scopeExpandCte` all read. A policy or role binding scoped at a DELETED service would go on governing. (The walk now also skips deleted ancestors, which covers the rows this cascade cannot reach — see below.)

WHAT THIS DELIBERATELY DOES NOT DO:

- it does not run on the FEDERATION IMPORT path. The authoritative domain journals its own `relationship_tombstone` entries beside the `object_tombstone`; cascading here would tombstone at a revision that authority never issued, and the import would then reject its real entry as a stale replay. - it does not touch REPLICA edges (`originDomainId !== self`). `deleteRelationship` refuses those by design — single-writer authority — so they are skipped rather than attempted. Such an edge genuinely can outlive this object until its own authority removes it, which is precisely why the reader-side filter in `containment.ts` exists as well: this cascade cannot be complete on its own, and a fix that only prevented NEW dangling edges would leave both the foreign ones and every row already in the database. - it does not run for `removedForeignShadow`, which is local cleanup of a row this domain never authored and deliberately does not journal.

## §12. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR — DOOR C, HALF TWO. AFTER the tombstone AND after the edge cascade, so it judges the state this whole operation actually leaves behind rather than modelling any part of it. MEASURED before this guard, four plain sequential requests: `DELETE /objects/user/{id}` on the org's only administrator returned 200 and left the estate holding a `role_bindings` row naming a tombstone — unadministrable, hand-written SQL the only recovery.

The cascade's own per-edge check (`graph/relationships-repo.ts`) already covers the case where this row is a GROUP with members; that redundancy is deliberate and cheap. What only this call catches is the row that IS the principal: tombstoning it removes no edge, so nothing in the cascade fires.

The predicate takes §0's org lock itself, which this transaction is already holding by now (every `appendAuditEvent` in the cascade took the same key). See `docs/authz/role-binding-door.md` §7.
