# ADR-0043: Org-tier freezes federate — as a graph object on the existing `object_upsert`, never as a new journal kind, and never above the org tier

**Status:** Accepted (owner decision **D6**, 2026-08-23, recorded in [campaigns-rework.md](../proposals/campaigns-rework.md) §"Owner decisions — second round"). Implemented as M25.7.

**Numbering note (2026-08-24):** `docs/adr/` tops out at 0042 (`0042-deadline-triggered-campaign-lock.md`); 0034 is reserved in prose by `docs/proposals/governance-label-namespace.md` and has no file. This is 0043.

**Relates to:** [ADR-0022](0022-outpost-config-authority-split.md) (config that must cross a boundary becomes a graph object; the `federation:write`-not-`object:write` line), [ADR-0026](0026-placements-and-derived-stage-names.md) (the same argument for `placement`, `drizzle/0051`), [ADR-0031](0031-domain-local-objects-never-federate.md) (locality is declared, never inferred), [ADR-0039](0039-per-target-freeze-admission.md) (the per-target admission an imported freeze feeds), [ADR-0040](0040-platform-tier-freezes.md) (the tier that does **not** federate, and the finding this ADR does not overturn), [ADR-0032 §6a](0032-dependency-subscriptions.md) (why the `object_upsert` import branch may not throw), `drizzle/0089`, charter principles 2, 3, 5, 6, 7.

---

## Context

### This ADR retracts a decision, not a gap

Until 2026-08-24 a freeze could not cross a security boundary at all, and every layer said so on purpose:

* `db/schema.ts` stated that the generic object model has no place for control-run evidence, approval quorum, or freezes — a freeze's whole state is a window, a scope and a reason, queried on a hot gate path, so it earned a dedicated projection table.
* `JournalEntryKindSchema` admits **nine** entry kinds and none is freeze-shaped, so nothing in the transport could carry one.
* `coordination/service-board.ts` therefore told operators, board-level, that a null `activeFreeze` means *"no freeze declared HERE"* and never *"no freeze applies"*.
* `apps/web/src/routes/outpost-configuration.tsx` rendered the same correction to the operator **verbatim** — M16.2's proposal had listed freezes as *"commander-origin, syncs down"*, that was found false at build time, and it was corrected honestly rather than shipped as a half-truth.
* And the absence was **pinned by a test**: `coordination/service-board-precedence.integration.test.ts` asserted freeze visibility is declared board-level *because* freezes never ride the journal.

None of that was wrong. What changed is the requirement: owner decision D6 rules that a commander must be able to declare a freeze that binds an outpost. A freeze that a commander declares and an outpost does not enforce is not a governance boundary; it is a suggestion with a UI.

Because this is a retraction, the artefacts above were **rewritten with their retired reasoning intact** rather than edited to look as though they had always said the new thing — the house shape for inverting a deliberate absence, and the reason the flip is auditable at all.

### What forced the shape

Two findings from the proposal's §2.3, both re-verified during implementation:

**A new `JournalEntryKind` is a cliff, twice over.** `JournalEntryKindSchema` is a nine-literal `z.enum` that also appears in the **200 response** of `POST /federation/exports`, so widening it is an oasdiff `response-property-one-of-added` break. Far worse, it is **fail-closed at the far end**: `POST /federation/imports` validates the whole bundle against `SyncBundleSchema` **at the route boundary**, so a peer that does not know the new kind rejects the **entire bundle** with a 400 — every unrelated entry in it lost, and retried forever by `inbox-loop.ts`. `import-repo.ts`'s tolerant `default: return;` is never reached.

**A platform-tier freeze structurally cannot federate.** `SyncJournalEntrySchema.orgId` is a **required** field; `appendJournalEntry` takes `input.orgId`; the hash chain is keyed `(orgId, originDomainId)` under an advisory lock on that pair; `exportSyncBundle` runs inside `withTenantTx(db, orgId, …)`. Every layer is org-scoped, and `instance_freezes` (drizzle/0086) has no `org_id` and is declared by no commander. There is no non-arbitrary org for it to acquire, and re-expressing it as N per-org entries would require the commander to enumerate the outpost's tenants — which it does not know — and would turn an instance-scoped fact back into tenant data.

---

## Decision

### 1. A freeze that federates gains a graph object; the projection row stays

`freezes.object_id` (drizzle/0089) is `NULL` by default and names a `freeze` graph object when set. The object is the **wire form**; the row remains the **enforcement form**.

This is object-**plus**-projection, the pattern `changes` and `campaigns` already use, and both halves are load-bearing:

* Everything that enforces a freeze reads the table — `activeFreezesInWindow` (the single owner of the half-open window predicate `starts_at <= at < ends_at AND lifted_at IS NULL`), and through it `freezesByTarget`, `checkFreeze`, `evaluateFreezeHolds` and the service board. Moving that into `objects.properties` would mean re-expressing the window predicate as jsonb comparisons on a hot gate path and rewriting every reader, to gain nothing — and would create a second copy of the one comparison `freezes-repo.ts`'s header exists to keep singular. That drift is not hypothetical: a second copy of the containment walk once made a service-scoped freeze fail **open**.
* Nothing table-shaped travels. ADR-0022 clause 2 already settled that: config that must cross a boundary rides `object_upsert` as a graph object.

**Rejected: move freezes wholly into the object model and delete the table.** It re-litigates a settled storage decision, touches every enforcement reader on the hot path, and buys only the removal of one nullable column.

### 2. The `freeze` object type is a **migration seed**, on both sides

`object_types` never journals. It is seeded by a migration at every instance, which is exactly what lets this design need **no new entry kind and no new importer branch for type registration**: `import-repo.ts`'s `object_upsert` branch resolves `typeId` through `upsertObjectByUrn` with no try/catch, and `createObject` **404s on an unregistered type** — so a runtime-registered custom type would abort a peer's entire signed bundle. Both ends know `freeze` because both ends ran drizzle/0089.

The registered schema has `required` but **not** `additionalProperties: false`, per 0043's own rule as restated by drizzle/0051: this type is Ajv-validated on the **receiving** side, so a closed schema would make every future property addition a fail-closed version-skew hazard at an older peer. `required` carries no such risk and enforces the constitutive fields (`freezeId`, `scopeObjectId`, `startsAt`, `endsAt`, `reason`) at every write door.

### 3. Authoring: `federate` defaults to **false**, and the federating form needs `federation:write`

`POST /api/v1/freezes` gains `federate?: boolean`. Omitted, the request is byte-identical to a pre-M25.7 one and so is everything that happens to it — **a new reach never defaults on**.

The federating form additionally requires **`federation:write` at the freeze's own scope**, on top of the `freeze:write` every freeze already requires. `freeze:write` is the permission for freezing your own estate; declaring a freeze that stops releases in **another security domain** is a categorically different act. This is exactly the line ADR-0022 drew for commander-authored outpost config, in the same direction. It is **added, never substituted**, and only `true` is gated — the same asymmetry `assertMayDeclareDomainLocal` uses.

**On EVERY verb that publishes, not only on create** (round-2 correction). §7 below has both write routes re-snapshotting the object, so gating only the create left the same reach available with strictly less authority: a `freeze:write`-only actor could `PATCH` a federating freeze's `endsAt` a year out — extending a release-stopping block across a boundary they hold no federation authority over — or lift it, retracting a commander's protection at every downstream instance. `DELETE /v1/freezes/{id}` and `PATCH /v1/freezes/{id}` therefore demand `federation:write` at the freeze's own scope whenever `objectId` is non-null, i.e. **exactly when `syncFreezeObject` will actually publish**, read from the row rather than inferred. A non-federating freeze never reaches the check, so every pre-M25.7 caller is unchanged. It is not the §6 replica guard and does not subsume it: that one refuses a write to a freeze another **domain** owns (409); this refuses a write by an actor without federation authority to a freeze **this** domain owns (403).

An **outpost-declared** freeze may be authored `domainLocal: true` (ADR-0031: locality is declared, never inferred), which `federation/scope-filter.ts` withholds in **both** directions even under `full` scope. `domainLocal` without `federate` is **refused (400)** rather than ignored: without an object there is no journal entry to withhold, so accepting it would store a declaration nowhere and read it back as absent — a field that lies.

### 4. There is exactly **one** authoring door, and the type is governance-managed

`freeze` joins `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`. Without that, any door taking a caller-supplied `typeId` would let a holder of plain `object:write` mint a `freeze` object and stop releases in another domain — a wider blast radius than the `policy` hole that set was created for, with the same shape (authority carried in `properties` that no generic door inspects).

**That membership is necessary and NOT sufficient, and the first version of this clause said otherwise.** It claimed membership "closes all five doors at once". It closes **two** — `{POST,PATCH,PUT,DELETE} /objects/{type}` and `POST /discovery/accept` refuse every governance-managed type outright. At the other **three** — `POST /plans`+apply, `POST /federation/overlays`, `POST /federation/hand-fill` — membership means "demand `policy:write` instead of `object:write`", which is a permission **upgrade**, not a refusal, and `policy:write` is neither of the permissions a freeze requires. Measured on the M25.7 tree before the fix: an actor holding `policy:write` at a narrow domain, and `freeze:write`/`federation:write` **nowhere**, could mint a federating freeze through any of the three. Three things went wrong at once and only the first is a permission problem — (1) `policy:write` substituted for both real gates; (2) `prepareApplyChecks` scope-binds a declared `properties.*` for `policy` and `campaign` only, so the freeze's declared `scopeObjectId` was bound to nothing; (3) the result was **unliftable at both ends**, because only `POST /v1/freezes` writes the object and the row together, so `DELETE /v1/freezes/{id}` 404s at the authoring instance while the peer, which *does* rebuild the row, refuses to lift a freeze whose origin domain is foreign.

The remedy is a second set, `PROJECTION_BOUND_OBJECT_TYPE_IDS`, consulted by exactly those three doors, which **refuse** the type the way `pair-bound-types.ts` refuses `placement`. Refusal loses nothing real: there is no "annotate a distributed freeze" use case — a freeze has no strictness lattice for an overlay to add to — and none of the three can write the projection row anyway, so what they would produce is the broken half-record above. The membership question for that set is *"does a row of this type require a second write, in another table, that only a typed route performs?"*; `scan_override_grant` does not, which is why it stays permission-gated.

`governance-managed-write-doors.integration.test.ts` drives all five doors with an actor holding **every permission those doors ask for except `freeze:write`**, plus a control proving the same actor is still admitted for a type whose bar genuinely *is* `policy:write` — so "refused" is measured, and measured to be about the **type** rather than about the actor.

The second reason matters as much as the first: `POST /api/v1/freezes` is the only place that writes the object and its projection row **together**, so a `freeze` object minted anywhere else would federate a freeze that does not exist at the instance that declared it.

Federation journal replay remains **not a door**, unchanged: `typeId` there arrives from a signature- and chain-verified bundle, and a refusal in that branch aborts a whole signed bundle (ADR-0032 §6a). A hostile peer is a **pairing** problem.

### 5. Import rebuilds the projection — and never throws

`federation/import-repo.ts`'s `object_upsert` branch calls `rebuildFreezeProjectionFromObject` for a `freeze`-typed row that landed. **This is the feature.** Without it the object replicates into the graph and every enforcement reader goes on seeing nothing, so a commander-declared freeze still would not be a freeze at the outpost.

* **Idempotent by primary key.** `freezes.id` **is** `properties.freezeId`, preserved verbatim from the origin, so a replayed bundle converges through `ON CONFLICT (id) DO UPDATE`. The update arm is guarded `WHERE object_id = <this object>`, so a peer can only ever overwrite the row its own object owns; drizzle/0089's partial unique index `(org_id, object_id)` is the same invariant from the other side.
* **Preserving the id is also an explainability decision.** A `freeze_admission` Decision written at the outpost names an id its operator can resolve against `GET /v1/freezes/{id}` at the commander (charter principle 6).
* **Malformed content is skipped, not thrown.** The branch has no try/catch; a throw wedges the channel. The compensating control is that authoring-time refusal belongs at the authoring instance, where exactly one door builds these properties and the registered schema marks them required.
  * **Round-2 correction: the first implementation of that guarantee did not hold.** "Missing" was checked with a non-empty-string test, but four of the fields become `uuid` **columns** (`freezes.id`, `scope_object_id`, `created_by_actor_id`, `lifted_by_actor_id`), and a non-UUID raises `22P02` at the INSERT — which does not fail one entry, it **poisons the transaction**, so the peer's whole bundle is rejected and retried forever. All four are now read through `isUuid` and a non-UUID is treated exactly like an absent value. Note the shape: the hazard was correctly named in prose and the code checked something adjacent to it.
  * **The type-registration hazard is now survivable too.** `createObject` 404s on an unregistered type, so the first federated freeze reaching a peer that has not yet run drizzle/0089 — the window a rolling upgrade produces by construction — used to wedge that peer's inbox on **every** bundle, not just this entry. `import-repo.ts` now checks registration **before** the write (a pre-check, not a `catch`: a caught error can leave a poisoned connection) and skips-and-records the entry as a `federation.import.entry_dropped` event in the receiver's own hash-chained audit log. One entry may be lost; the channel must not be. Recovery is a from-genesis re-sync after the upgrade. ADR-0022's `outpost` and ADR-0026's `placement` carried the same exposure and were lucky; `freeze` is the first such type reachable from an ordinary operator action.
* **A tombstoned freeze object lifts its projection row.** `object_tombstone` soft-deletes the `objects` row, which is the whole job for a type whose object *is* the record — but a freeze's enforcement lives in `freezes`, and nothing there joins `objects`. Without a `freeze` branch the projection row **outlived its own wire form**: still returned by `activeFreezesInWindow`, still refusing every gate, and unliftable, because §6 refuses a local lift of a foreign-origin freeze and the declaring domain has just destroyed the object a re-snapshot would have ridden. A commander deleting a freeze object would have frozen its outposts permanently. The importer therefore lifts the row (`lifted_at = now()`, `lift_reason` naming the tombstone) rather than deleting it — soft, so a `freeze_admission` Decision citing the id keeps resolving.
* **Scope resolves by URN first, id second.** Ids survive replication verbatim so the two normally agree; the urn is what survives hand-fill reconciliation, which re-keys a placeholder id onto the authoritative one. If neither resolves, the origin's raw id is stored — not a fail-open, because membership is exact-set over a **local** containment chain, so a scope this instance never replicated cannot be an ancestor of any local target.

### 5a. It reaches **`full`-scope peers only**, and the drop is silent at both ends

`federation/scope-filter.ts`'s `entryMatchesScope` admits an `object_upsert` under exactly two modes: `full` (everything) and `changes_only` — and `changes_only` admits it only when `payload.typeId` is `change`, which a freeze's is not. `policies_only` admits `policy_upsert` and `key_rotation` only; `status_only` admits `change_status` and `audit_segment` only; a `custom` label selector matches on `payload.labels`, and `attachFreezeObject` writes none, so any non-empty selector excludes it. **A federating freeze therefore reaches a peer paired at `full` and no other scope.**

That is the same reach `outpost` config (ADR-0022) and `placement` (ADR-0026) already have, and it is *why* the modes exist: a `policies_only` peer is scoped narrow **for confidentiality**, and widening the filter to smuggle one governance object through would defeat the mode for every operator who chose it. Redefining `policies_only` to mean "policies and freezes" is a separate decision with its own blast radius and is **not** taken here.

What this design owes is honesty about it, and the honest statement is uncomfortable: **the drop is silent at both ends.** The sender's export filter withholds the entry with no record, and the receiver never sees it, so neither instance can report that a freeze was withheld — a commander operator who declares `federate: true` against a `policies_only` outpost gets a 201 and no block downstream. Three things follow, and only the first is built:

* The requirement is **stated**: here, in `CreateFreezeRequestSchema.federate`'s field doc (the contract clients read, and the one that reaches the generated SDK/OpenAPI), in GLOSSARY's freeze entry, and in `scp freeze create --federate`'s help text.
* It is **not probed at the create door.** A probe would read every peer's `sync_scope` and warn — but `FreezeSchema` has nowhere to put a warning, and the answer is wrong the moment a peer is re-scoped, because scope is evaluated at **export** time, per bundle, for the life of the freeze.
* It is **not recorded at import.** The receiver's scope filter drops the entry before `applyEntry` runs, and there is no freeze-shaped store for evidence never received. `federation_unattached_change_status` (drizzle/0040) is the shape a future increment would follow, and it needed its own table. Named as **unbuilt** rather than implied to work.

The board's existing caveat is what an operator actually has: a null `activeFreeze` means "no freeze visible here", and the reasons it may be invisible now include "this peer's sync scope carries no object upserts" alongside "the declaring domain did not federate it".

### 6. Precedence: an outpost cannot lift a commander freeze

No new mechanism. `graph/objects-repo.ts`'s single-writer guard already refuses a local write to a row with a foreign `origin_domain_id` — proven end to end by `federation/outpost-config-sync.integration.test.ts` case 2 for `outpost` config, and re-proven here for `freeze`.

What M25.7 adds is that the **projection row** cannot be edited around it. The object guard alone would protect the wire form while `freezes.lifted_at` — the column `activeFreezesInWindow` actually filters on — stayed locally writable, so an outpost could lift a commander freeze without ever touching the object. The check therefore lives in `freezes-repo.ts`'s **`lockFreezeRow`**, the read half **both** write verbs already share, rather than in `liftFreeze` and `updateFreezeWindow` separately. Two copies of one refusal is the repeated defect; the asymmetric version is worse than either, because a guarded lift beside an unguarded `PATCH endsAt` lets an outpost push the window into the past and achieve the retraction it was refused.

The remedy at a replica is **`freeze:override` at that freeze's own scope** — per change, reasoned, audited, and already universally quantified over every covering freeze (`gate-orchestrator.ts`'s CRITICAL #2 loop). Never deletion of a protection another domain declared.

### 7. A lift and a window edit propagate downstream

Both write routes re-snapshot the object (`syncFreezeObject`, a no-op when `object_id` is null). Without that, a commander could declare a freeze that blocks at an outpost and never retract it there — M25.1's *"a surface with an entrance and no exit"* defect rebuilt one boundary over, and strictly worse, because §6 deliberately denies the outpost a local exit.

### 8. Org tier and below. Never platform tier.

`instance_freezes` is untouched by this ADR and by drizzle/0089. ADR-0040's finding stands verbatim, and GLOSSARY's `platform-tier freeze` entry — *"Does not federate, under any decision"* — remains **true**. Multi-instance distribution of a platform freeze is a deployment-tooling problem: the same path that distributes `SCP_OPERATOR_TOKEN` can `PUT` the same freeze to each instance.

---

## Consequences

**A commander's governance now reaches its outposts, and the board's honesty rule survives on a narrower reason.** `service-board.ts`'s board-level `serviceFreeze`/`rows[].activeFreeze` caveat still fires unconditionally whenever a peer exists, because `federate` **defaults off** and nothing in a bundle reports the freezes a peer withheld. A null `activeFreeze` now means *"no freeze visible here"* rather than *"no freeze declared here"*. Weakening the caveat to fire only when the org has no federated freeze would be exactly backwards — the un-federated ones are the invisible ones.

**Nine call sites asserted the retracted claim and were each corrected or consciously kept**, with the retired reasoning preserved wherever the artefact was a pin. The census was run filterless (`grep -rna`) and found **more** than the three the proposal named, including `packages/schemas/src/services.ts` (the published `unknownFields` contract, three places) and `service-board.ts`'s own file header — which is the standing lesson: a census assembled from a prior handoff's list inherits that list's blind spots.

**`Freeze.objectId` is on the wire** as a required nullable response property (additive; the standing rule is never to make an *existing* required field optional). It answers exactly one question — **does this freeze federate?** — read, never inferred from role or from the presence of a peer.

**It does NOT answer "can I lift this?", and a first draft of both this clause and the CLI column claimed it did.** `objectId` is non-null on a commander's own federating freeze and on an outpost's replica of it alike; the fact that separates them is the **object's** `origin_domain_id`, which this response shape does not carry. The CLI column is therefore named `federates`, which is what the field supports, rather than `federated`, which reads as a statement about provenance. Resolving lift-ability needs `scp object get freeze <objectId>` (its `originDomainId`), or the 409 itself, which names the declaring domain. Putting origin on the freeze row would mean a required-nullable `originDomainId` plus a join in `listFreezes`; **not built**, and deliberately not faked from data that cannot support it.

**A freeze scoped at an object the receiver never replicated covers nothing there.** The row is still stored, faithfully recording what the declaring domain said, and blocks nothing locally because no local target's containment chain contains that scope. An org-root-scoped commander freeze is the case to know about: each instance's org root is its own object, so such a freeze does not cover the outpost's estate. Scope a federating freeze at a **replicated** service, component or deployment target.

**No new journal kind, no enum widening, no oasdiff response break, no new importer branch, no new stateful dependency.** The only wire change is two optional request fields and one required-nullable response field.

**Known and not addressed here.** There is no UI for `federate` — freeze authoring UI is the UI session's surface (coordinated in campaigns-rework.md §2.3), and `scp freeze create --federate` is the door until then. A commander cannot observe whether an outpost has *applied* a freeze it sent; that is the same pending-**export**-not-pending-apply boundary M16.2 recorded and M16.4 owns.
