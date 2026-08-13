# ADR-0031: Domain-local objects never federate — locality is declared on the object, stamped into the journal, and is not an enforcement input

**Status:** **Accepted** (owner sign-off 2026-08-11, including the six decision points in the context doc's §10 — §6 below is amended by that sign-off, per Q2). **Amended 2026-08-13 (owner-decided): §6a adds containment-subtree declaration as inheritance at create**, resolving the layer §1 deferred and correcting a conflict between §1's "materialize at declaration time" wording and §6's permanent refusal of shared → domain-local. §1's constraint is preserved in substance — the bit is still written onto the row, never resolved by a walk — and §1's own text now points forward to §6a.
**Context doc:** [docs/proposals/domain-local-config-and-infra.md](../proposals/domain-local-config-and-infra.md)
**Relates to:** [ADR-0017](0017-ownership-refinement.md) (§2 — domain-specific config/infra is outpost-owned; this supplies the tracking model it assumed); [ADR-0022](0022-outpost-config-authority-split.md) (the commander→outpost declared-config replica — this is its mirror image, and the "journal cannot carry a peer" reasoning is reused); [ADR-0018](0018-domain-local-dev-pipelines.md) / [ADR-0030](0030-dev-branch-pipelines.md) (M18 dev pipelines — adjacent mechanism, different intent; §"Relationship to M18"); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan is a *boundary-crossing* authorization gate); [ADR-0011](0011-universal-outpost-validation.md) (§1 — domain-local artifacts have no transfer phase); [ADR-0010](0010-outpost-local-artifact-infra.md) (outpost-local Gitea); charter principle 1 (coordinate, not execute), 2 (graph-native), 3 (API-first parity), 6 (explainability), 7 (Simplicity first)

## Context

Some code is true in exactly one trust domain. A partition's VPC layout, route tables,
transit-gateway attachments, security-group rules and the per-domain slice of Kubernetes
configuration have **no upstream original**: they are authored in the domain, reviewed there, and
deployed there. [ADR-0017 §2](0017-ownership-refinement.md) already decided this class is
outpost-owned for build and repo hosting. It did not say how it is tracked, and the owner's
2026-08-11 direction adds the constraint that decides the design: **the commander sees nothing at
all.**

### The structural facts, measured at HEAD (2026-08-11)

- **Pipeline configuration already never federates.** `source_mappings` and `executor_bindings` call
  `appendJournalEntry` **zero** times, and no module under `apps/server/src/federation/` references
  either table. `JournalEntryKindSchema` admits nine kinds and none is mapping- or binding-shaped —
  the same "the journal cannot carry it" argument [ADR-0022](0022-outpost-config-authority-split.md)
  built on for `federation_peers`. The whole routing layer of a pipeline is therefore already
  per-instance local.
- **Graph objects and changes journal unconditionally.** `appendJournalEntry` fires from **six**
  writers — `graph/objects-repo.ts` (:241, :564, :898), `graph/relationships-repo.ts` (:326, :454),
  `coordination/changes-repo.ts` (:422), `coordination/transition.ts` (:337),
  `governance/approvals-repo.ts` (:276), `audit/audit-repo.ts` (:91) — in the same transaction as the
  mutation, never conditionally on content. **There is no per-object "do not federate" bit.**
- **The only filter is per-peer and inclusive-only.** `federation_peers.sync_scope` is applied at
  export (`federation/export-repo.ts:42`) and re-applied at import. Its five modes are coarse, and
  `custom`'s `labelSelector` (`federation/scope-filter.ts:38-45`) expresses "send **only** entries
  matching X" — never "send everything **except** the domain-local ones". Widening a peer's scope is
  documented to require a full re-sync from sequence 0.
- **The gate exemption is already structural.** `coordination/pre-deploy-gate.ts` exempts any change
  with no `importedFromDomain`; `boundary-segment.ts` returns `null` for a change that never crossed;
  `exportPromotionBundle` requires a federation peer, so a domain-local change never reaches E6.
- **The outpost already serves its own UI**, verified by
  `federation/outpost-local-ui.integration.test.ts` (M16.3, DONE).

So the capability is nearly all present. The single missing thing is the ability to say *"this
object's existence stays in this domain"* at a granularity finer than a whole peer.

### The distinction that shapes this ADR

`entryMatchesScope` is a **pure, synchronous predicate over one entry**, and it must stay that way,
because the **same function runs on both sides**: the exporter filters with it and the importer
re-applies it as defense in depth. The importer has no way to query the sender's object state. Any
design in which locality is resolved by a database lookup at export time is therefore a design in
which the two sides can silently disagree — which is the property the existing double application
exists to prevent.

## Decision

### 1. Locality is a **declared property of the object**, read, never inferred

A **`NOT NULL DEFAULT false`** boolean column `objects.domain_local`, set at create. An operator
declares *"this component is domain-local"*. Nothing parses a repo name for `network`, consults a
deployment-target label, or matches a branch string.

**Corrected during M20.1 (2026-08-11); this clause originally said "nullable".** Locality is a
two-state property — an object either stays home or it does not — and a nullable boolean invites a
third reading, *unknown*, which the export filter would then have to resolve. A predicate deciding
what crosses a security boundary must have no unknown case, which is why
`federation/scope-filter.ts` tests `=== true` and why the column carries a default instead of a
null. `false` for every pre-existing row is exactly today's behaviour, so the expand needs no
backfill. Rationale is restated in the migration header (`drizzle/0059_objects_domain_local.sql`).

This mirrors [ADR-0030 §2](0030-dev-branch-pipelines.md) deliberately and for the recorded reason: a
label named after *what matched* goes false the moment the thing it matched covers a second kind —
already shipped once in this repo, in a Decision where it had been wrong since before the level that
exposed it (charter principle 6).

**A column, not a reserved label.** Labels are free-form user-writable data that already ride the
journal payload; a guarantee about what crosses a trust boundary must be enforceable at a write choke
point, not conventional. The declaration is gated on `federation:write`, not plain `object:write` —
[ADR-0022](0022-outpost-config-authority-split.md) set exactly that precedent for the mirror-image
case, and for the same reason: a property that governs a boundary is not an ordinary object field.

**Declarable on any instance, in any role** (owner Q5, 2026-08-11) — the commander's own domain is a
domain too, and the root domain is dev-heavy and has exactly this class of code. Gating on
`federation_self.role` was rejected: that field is **org-scoped and advisory**, and M16.3's P3 already
declined to use it for an authorization decision, introducing the install-time `SCP_FEDERATION_ROLE`
axis instead precisely because the advisory value forks from the Helm one.

**The sequencing property is a safety feature, not a no-op, and is worth documenting for operators:
declare locality *before* pairing a peer, and pairing later cannot retroactively publish anything.**
On an instance with no peers nothing was going to be exported in any case; the declaration is what
guarantees that adding a peer tomorrow does not change that. The safe order is declare-then-pair.

**A containment-subtree declaration layer must MATERIALIZE, not resolve** (owner Q4, 2026-08-11).
Declaring locality once on a containment ancestor instead of on twenty networking components is an
ergonomic layer worth having — but it must write the bit onto each object, never resolve it by walking
containment at export. Resolving dynamically would put a graph walk in the write path and turn the
journal stamp from a column read into a traversal, which is where a filter of this kind acquires the
failure mode it exists to prevent.

> **Superseded in part by [§6a](#6a-containment-subtree-declaration-is-inheritance-at-create-never-a-backfill-m205) (2026-08-13).** The
> requirement above stands; the phrase *"at declaration time"* did not. Read literally it means a bulk
> flip of existing descendants — the **shared → domain-local** direction §6 refuses permanently — so
> the bit is written at each object's **own create** instead. The dependency this clause named (the
> stage-vs-`domain`-object question) was already resolved by [ADR-0026](0026-placements-and-derived-stage-names.md) D1.

### 2. A domain-local object is **never journaled**; the stamp and filter remain as the import-side check

> **Corrected during M20.2 (2026-08-12).** This clause originally said the object *is* journaled and
> withheld at export by §3's filter, and asserted that "bundles become sparser … so the chain model
> needs no change". **That was wrong, and the M20.2 invisibility test found it.** The correction is
> recorded in full because the reasoning matters more than the outcome.
>
> **Why filtering alone breaks federation.** A filtered bundle is *sparse* — its sequence has gaps —
> and `federation/import-repo.ts` only accepts a sparse chain when the **receiver's own**
> `sync_scope` is narrow (`receiverExpectsContiguity = peer.syncScope.mode === "full"`). A `full`
> scope is the default and the widest, and it demands a gap-free chain. So under the original design,
> the first object anyone declared domain-local would have made every subsequent bundle fail a
> contiguity check at the most common kind of peer, with a 409 that reads as a tampering alarm. The
> claim that sparse bundles are "already verified with `contiguous: false`" was true only of the
> narrow scopes, which is not the case that matters.
>
> **Why not journaling is also strictly more private**, which is what makes this a correction rather
> than a workaround: a withheld-but-numbered entry leaks *its own existence*. The gap in the sequence
> tells a peer how many domain-local objects exist and when they changed — precisely the aggregate
> signal declined under Q6. An entry that was never allocated a sequence leaves nothing to count.
>
> **What is unchanged:** the local `audit_events` chain is written in full for domain-local objects
> and stays complete and verifiable (principle 6). Locality governs what **leaves** this domain,
> never what this domain records about itself.

**A domain-local object's mutations are never appended to the sync journal at all.** The three object
writers (`createObject`, `updateObject`, `upsertObjectByUrn`'s update branch) and the tombstone in
`deleteObject` each skip `appendJournalEntry`, alongside the existing `federationImport` skip — and so
does `audit/audit-repo.ts`, whose `audit_segment` carries `subjectId`, i.e. the object's id. That last
one is the one that hides: the graph entries can be correctly withheld while the object's identity
sails out in the audit stream beside them, which is exactly what the M20.2 test caught by searching
the serialized bundle for the id rather than by checking which rows landed.

### 2a. The stamp and the export filter are retained as the **import-side** check

Because of §2 this domain now produces **no** stamped entries of its own, so the stamp and §3's
filter no longer do the primary work. **Both are kept deliberately**, and their job is now precisely
stated: they are the **receiving** side's defense against a peer that ships a domain-local-stamped
entry anyway — a misconfigured, downgraded, or older sender. Without them the receiver would simply
apply it.

Where an entry does carry the stamp, it is one field on a payload that is already full-state
(`object_upsert` carries `properties`/`labels`/`version`; `relationship_upsert` carries
`fromId`/`toId`/`properties`/`labels`), present **only when true**, so no ordinary payload changes
shape and **no new journal entry kind** is introduced — the nine kinds are unchanged and the bundle
format does not move.

Keeping the stamp in the payload is also what allows §3 to stay a **pure** predicate that both ends
evaluate identically, per §Context. Resolving locality by a database lookup at export time would
leave the receiving side with nothing to check at all.

### 3. A domain-local entry matches **no** peer scope, in **either** direction

One clause in `federation/scope-filter.ts`, ahead of the mode switch:

```ts
export function entryMatchesScope(entry: SyncJournalEntry, scope: SyncScope): boolean {
  if ((entry.payload as { domainLocal?: unknown }).domainLocal === true) return false;
  switch (scope.mode) { /* unchanged */ }
}
```

One predicate, invoked at both ends, already probed reflexively by `scopeCarriesChangeObjects` so the
board's honesty helpers cannot drift from it. Bundles become sparser; they are already sparse under
every scoped mode and already verified with `verifyJournalChain({ contiguous: false })`, so the chain
model is unaffected.

**Not a new `SyncScope` mode.** A mode is per-peer, so it cannot distinguish a shared component from a
domain-local one on the same peer; changing one re-anchors cursors; and `SyncScope` is a **required
field on `FederationPeerSchema`** (`packages/schemas/src/federation.ts:567`) — a response — where a
new discriminated-union member is precisely the widening class the oasdiff gate catches.

### 4. Relationships inherit locality from **either** endpoint

`createRelationship` already loads and validates both endpoints, so it stamps `domainLocal: true`
whenever **either** is domain-local.

**Either, not both**, because the interesting edge is the mixed one: a domain-local networking
component `part_of` a service the commander knows. Requiring both endpoints to be local would let
exactly the leaking case through — the edge payload carries the local object's `fromId`, `typeId`,
`properties` and `labels`, so shipping it and letting the receiver decline to store it is a leak with
a swallow, not "nothing at all".

**`federation/import-repo.ts:269-275`'s comment must be corrected in the same change.** It currently
justifies its skip-on-missing-endpoint with "should not happen … since a relationship's origin domain
always creates its endpoints first in its OWN chain". Under this clause the dangling edge still cannot
arise, but *that* is no longer the reason. Per CLAUDE.md's census discipline, a well-written comment
naming a hazard is a signal to sweep, not evidence it was handled — and a stale rationale inside a
defensive catch is how the next instance hides.

### 5. A change may not span a locality boundary

`coordination/changes-repo.ts::proposeChange` is the single change creator and already resolves every
target in one loop (`:185-190`), described in its own doc comment as "the SINGLE POINT where a change
acquires its release topology". Locality inheritance belongs in that loop.

A change whose targets are **mixed** is **refused at propose time**. Neither resolution is safe:
resolving it *local* silently darkens a legitimate cross-boundary release; resolving it *shared*
leaks. Refusal is the only outcome with no silent failure mode, and it is a 400 at authoring time
rather than a divergence discovered later.

### 6. Locality is **immutable after create**

- **Shared → domain-local is refused permanently.** Federation has no un-send. Once a component's
  existence has crossed, declaring it local afterwards asserts a confidentiality property the system
  cannot deliver, and an API that answers 200 to that request is lying.
- **Domain-local → shared is allowed, through an explicit publication verb** (amended by the owner's
  Q2 sign-off, 2026-08-11; the first draft deferred this to M20.4 and overstated its cost). Journal
  payloads are **full-state upserts, not deltas**, so re-journaling the object publishes it correctly
  from that point forward; the companion edge census is one bounded query over `relationships` where
  the object is `from_id` or `to_id`, re-journaling only those edges whose **other** endpoint is
  shared. The "no history before this point" worry that motivated the deferral is close to a
  non-issue: the importer does `upsertObjectByUrn`, and imported audit segments are discarded on the
  import path regardless.

  It is a **verb, not a property write** — `POST /v1/objects/{type}/{id}/publish` rather than a PATCH
  of the column — because it performs the re-journal and the edge sweep, and an operator must be able
  to see that publication is an action with an effect rather than a field edit. It is **one-way**, and
  the response reports exactly which edges were published so the sweep is legible rather than implicit.

Both refusals are enforced at the `createObject`/`updateObject` choke point in
`graph/objects-repo.ts`, not per route, so every write door inherits them — the same choke-point
argument [ADR-0022](0022-outpost-config-authority-split.md) clause 4 makes, and for the same reason:
four free-form-`typeId` local write doors already exist and any new one would silently be a fifth.

### 6a. Containment-subtree declaration is **inheritance at create**, never a backfill (M20.5)

> **Added 2026-08-13 (owner-decided), resolving the layer §1 deferred.** §1 said a future subtree
> layer "must write the bit onto each object at declaration time, never resolve it by walking
> containment at export", and deferred it on the unresolved stage-vs-`domain`-object question. Both
> halves of that deferral are now settled — one by another ADR, one by a conflict §1 did not notice.

**The dependency is gone.** [ADR-0026](0026-placements-and-derived-stage-names.md) D1 decided there
will be **no `stage` entity** — a stage name is *derived* — and explicitly rejected a `stage` object
type. Stage therefore never claimed the `domain` containment slot, and the ambiguity §1 was waiting
on does not exist.

**But §1's wording, taken literally, contradicts §6.** "Write the bit onto each object at declaration
time" reads as a bulk update flipping existing descendants to domain-local. That is precisely the
**shared → domain-local** direction §6 refuses *permanently*: a descendant that already federates may
already have reached a peer, and federation has no un-send, so declaring its ancestor local would
assert a confidentiality property the system cannot deliver. The two clauses cannot both hold for any
ancestor that already has shared descendants.

**Decision: locality is inherited at CREATE, one hop, along either containment route.**

1. **A container declares its own locality at its own create**, under the same immutable rule as every
   other object (§1, §6). There is no verb that makes an existing container domain-local.

2. **An object created under a domain-local container inherits the bit at ITS create.** Both
   containment routes count, and the resolution is *either*, mirroring §4's either-endpoint rule for
   edges:
   - the **`domain_id` parent** — `graph/objects-repo.ts::createObject` already resolves it
     (`resolveDomainId`), so this is one column read on a row it has already fetched;
   - the **`contains` parent** — `graph/components-repo.ts::createComponentInService` already resolves
     and type-checks the container before creating the component, so the same read serves.

3. **One hop is sufficient, by induction, and that is why no walk is needed.** If a container is
   domain-local, everything created under it is domain-local at its own create; so any *intermediate*
   container is itself already stamped by the time a grandchild is created, and reading the immediate
   parent yields the same answer a full ancestor walk would. This is the property that keeps
   `containmentChain` out of the write path — §1's real requirement, which this clause preserves
   exactly. What changes is **when** the bit is written, never **what** is written or read.

4. **Adding a `contains` edge later NEVER flips an existing object.** Attaching a shared component to a
   domain-local service leaves both objects' locality untouched; the *edge* is withheld by §4's
   either-endpoint rule, and the component keeps federating. This is the only behaviour consistent
   with §6, and it is also the honest one: the component's existence has already crossed.

**The cost, stated plainly: an existing populated subtree cannot be retrofitted.** An operator who
wants a domain-local grouping declares the container local and builds underneath it. For a subtree
whose members already federate there is no remedy — and there should not be one, because the remedy
would be a lie. This is the same asymmetry §6 already imposes on individual objects, applied one level
up; it is not a new limitation, only a newly visible one.

### 7. `domain_local` is **visibility only** — never an enforcement input

It grants **no** scan exemption, relaxes **no** gate, and is read by **no** governance code path. E6
stays input-free, exactly as [ADR-0030 §3](0030-dev-branch-pipelines.md) requires.

The exemption these objects enjoy continues to come from the **path**: they target no federation peer,
so `exportPromotionBundle` is never reached, so the cross-boundary gate structurally never applies —
the [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) domain-local case, unchanged. If a digest
associated with a domain-local component were ever promoted across a boundary, E6 hard-refuses it
without a passing, digest-bound scan **exactly as it would for any other digest**.

This must be pinned by an **inertness test** — forging or removing the bit changes no gate outcome,
mutation-proven — the same obligation [ADR-0018 §4](0018-domain-local-dev-pipelines.md) placed on its
own descriptive label. The bit and the gate are deliberately unaware of each other.

### 8. Configuration as code is not scanned when it is domain-local — because of the **path**, never the location

Most of what this ADR governs is **configuration as code** (now a [GLOSSARY.md](../GLOSSARY.md) entry): a
security domain's VPC layout, route tables, transit-gateway attachments, security-group rules and its
per-domain Kubernetes configuration, kept in a git repository in that domain and released through an
ordinary pipeline.

It is **not subject to the scan gate**, and the reason must be stated exactly:

> It crosses **no security-domain boundary**, so there is **no crossing to authorize**.

This is [ADR-0013](0013-supply-chain-scan-sbom-manifest.md)'s existing domain-local case, already written
into the glossary's `scan gate` entry ("domain-local artifacts are never scanned — they never cross a
boundary, so there is nothing to authorize"). It is the **path** property §7 relies on, restated for the
content class an operator actually recognises.

**"Because it is at the outpost" is NOT the reason, and must never be recorded as one.** An outpost is not
a scan-free zone: [ADR-0017 §2](0017-ownership-refinement.md) devolved **build to the originating
outpost**, so an outpost routinely produces artifacts that *do* require a passing, digest-bound scan
before they may cross. Location-based reasoning would license exactly that leak, and it would license it
in the one place — an outpost — where the artifacts most need the gate. Only the absence of a crossing
exempts anything.

**The separate local scan Control stays available and is unaffected.** [ADR-0030](0030-dev-branch-pipelines.md)
distinguishes two gates, and only the second is structurally inapplicable here:

| | **Gate 1 — the local scan Control** | **Gate 2 — E6, the export gate** |
|---|---|---|
| What it is | An *optional* operator-attached scan requirement ([ADR-0016](0016-scoped-scan-requirement-policies.md)) | The fail-closed cross-boundary authorization gate |
| Default for domain-local config | **Off** — ungated, as today | **Structurally never reached** — there is no peer, so no export |
| May an operator change it? | **Yes** — attach one and it applies | **No, in either direction.** No policy turns it on for a non-crossing path, and none turns it off for a crossing one |

So an IL5 domain that wants its own network configuration scanned locally simply attaches a scan
requirement, and gets one. That is a **quality** choice the org owns. Nothing in this ADR removes it, and
nothing in this ADR makes it an authorization.

## Relationship to M18 (ADR-0018 / ADR-0030)

They share mechanism and share no intent, and collapsing them would be a mistake in both directions.

| | **M18 — dev/beta pipelines** | **This ADR — domain-local config & infra** |
|---|---|---|
| Lifetime | Transient iteration scratch | Permanent; the domain's production config |
| Upstream source of truth | A shared repo whose `main` **is** promoted | **None** — this *is* the source of truth |
| Later promotion | **Expected**, and gated at E6 | **Never** — there is no destination |
| Recognised by | Source ref (`ref_pattern`, ADR-0030 §1) | An operator declaration on the object (§1) |
| What the commander sees | The component and its releases | **Nothing at all** |

M18's entire safety argument is about the "later" — stopping a dev bit from riding onto a
boundary-crossing artifact. This ADR has no "later" to defend against, which is why it can afford a
per-object declaration where ADR-0018 §1 explicitly rejected one. **That difference is load-bearing
and is the reason §7 exists**: the moment `domain_local` became an enforcement input, ADR-0018's
rejected alternative would be back, and this ADR would be wrong.

## Charter alignment

- **Coordinate, not execute (1):** unchanged. The outpost coordinates its own Argo CD / Argo Workflows
  exactly as it does for any other pipeline; SCP runs nothing.
- **Graph-native (2):** the declaration is one nullable column on the existing `objects` table plus a
  clause in an existing predicate — no new top-level table, no new object type, no new journal entry
  kind, no new peer field.
- **API-first parity (3):** the declaration is API → SDK → CLI → IaC → UI like any other property.
- **Air-gap (5):** strengthened — an air-gapped outpost's domain-specific networking never needs to
  appear in a bundle at all.
- **Explainability (6):** a change refused for a mixed-target locality span, and an update refused for
  attempting a locality flip, are both explicit 400/409 refusals with reasons — not silent drops. The
  filter's effect is legible locally: the entry exists in the outpost's own journal and audit chain,
  it simply matches no peer scope.
- **Simplicity first (7):** one column, one predicate clause, one stamp repeated across six existing
  writers. The alternative designs below each add a mechanism.

## Alternatives considered

- **A new `SyncScope` mode (e.g. an exclusion selector) — rejected.** Wrong granularity (per-peer
  cannot distinguish two objects on one peer), operationally expensive (a scope change re-anchors the
  cursor and requires a re-sync from sequence 0), and `SyncScope` is a required field on a **response**
  schema, so a new union member is an oasdiff widening on the exact class this repo's gate catches.
- **Reuse `custom` + `labelSelector` — rejected.** It is inclusive-only. Expressing "everything except
  domain-local" would require labelling every *other* object correctly forever, which fails open on
  the first object someone forgets — the incomplete-call-site-census failure this project keeps paying
  for, converted into a confidentiality bug.
- **Leave relationships unfiltered and rely on the importer's existing skip — rejected.** The edge
  payload carries the domain-local object's id, type, properties and labels. The commander would
  receive them and merely decline to store them; they would still sit in bundle files and transfer
  records. That is not "nothing at all".
- **Forbid cross-locality relationships entirely — rejected.** It would make every domain-local
  component an orphan in the outpost's *own* graph, since the outpost's service and component-journey
  views are built on containment. Buying a structural guarantee by breaking the local modeling is the
  wrong trade.
- **Locality as a containment subtree (declare a `domain` object local, inherit downward) — deferred
  2026-08-11, RESOLVED 2026-08-13 as §6a.** The deferral rested on the stage-vs-`domain`-object
  question, which [ADR-0026](0026-placements-and-derived-stage-names.md) D1 had already settled by
  deciding there is no `stage` entity. Adopted as **inheritance at create**; the two readings below
  are what it was chosen over.
- **Bulk-materialize onto existing descendants at declaration time — rejected (§6a).** This is §1's
  own wording read literally, and it is a **shared → domain-local flip**, which §6 refuses
  permanently. A descendant that already federates may already have reached a peer; no write on this
  side can retract that, so the operation would claim a guarantee the system cannot deliver.
- **Bulk-materialize, but REFUSE when any descendant is already shared — rejected as a different
  feature, not as a bad idea.** It is honest where the previous option is not, and it may be worth
  building later. It was not adopted now for two reasons: it is a **bulk verb with its own failure
  modes** (what an operator does with a subtree that refuses, and how they find the offending
  descendant, are a design problem of their own), and it is **racy against concurrent creates** — a
  descendant created between the check and the write is shared, unstamped, and inside a subtree that
  now claims otherwise. Closing that needs subtree-wide locking, which is a real cost to impose for an
  ergonomic layer. Recorded so a future reader knows the honest variant was considered on its merits.
- **Resolve locality by walking containment at export instead of storing it — rejected by §1 and
  restated here.** It would put a graph walk in the write path and turn the journal stamp from a
  column read into a traversal, which is where a filter of this kind acquires the failure mode it
  exists to prevent. §6a's one-hop-at-create inheritance is what makes the walk unnecessary.
- **A per-outpost aggregate count reported upward ("14 domain-local components") — not proposed.**
  It would preserve an inventory signal for governance rollups, but it contradicts the owner's
  "nothing at all" and would need a new journal-carried fact. Recorded so a future reader knows it was
  considered and declined, not overlooked.

## Consequences

**Positive**

- The owner's requirement becomes expressible at all — today it is not, at any granularity below a
  whole peer.
- No new journal entry kind, no bundle-format change, no `federation_peers` change: an older commander
  and a newer outpost interoperate unchanged, because the filtered entries simply never appear.
- The "Outpost UI only" question dissolves. The commander's UI renders what its database holds; if the
  object never lands there it never appears, with no conditional rendering anywhere. That is a
  stronger guarantee than a role-gated view — and M16.3's write-control census already found the
  failure mode a conditional view invites.
- The outpost's operator sees these components in the ordinary views alongside everything else, which
  is correct: from inside the domain they are not a special class.

**Costs / honesty**

- **The commander loses inventory visibility of a real part of the estate.** A domain-specific
  networking component is invisible to commander-side ownership rollups, freeze scoping, and audit
  aggregation. This is the owner's explicit decision (2026-08-11), taken with the tradeoff named — not
  an oversight, and not something to quietly re-open by adding a "small" upward signal later. Doing so
  needs a superseding ADR.
- **The stamp must land in all six journal writers, enumerated rather than grepped.** Missing one is a
  silent confidentiality leak that no test will notice unless the DoD asserts *absence across every
  entry kind*. `audit_segment` is the easiest to skip and must not be: an audit segment naming a
  domain-local change's action is exactly this leak, and "the importer discards audit segments anyway"
  is a property of the receiver, not a guarantee of the sender.
- **The one-way asymmetry in §6 remains a real constraint**, even with publication in scope. An
  operator who declares a component **shared** and later wants it local has no remedy but to create a
  new object, and that is permanent — federation has no un-send, and an API answering 200 to
  "un-publish this" would assert a confidentiality property the system cannot deliver. The publication
  verb makes the *recoverable* direction recoverable; it deliberately does not make both directions
  symmetric.
- **Publication re-journals, so a commander sees a component with no history before that point.**
  Accepted as harmless (the importer upserts by urn, and imported audit segments are discarded
  regardless), but it is a real observable: the commander's first knowledge of a published component is
  its state at publication, not its origin. An operator reading commander-side history must not read
  that absence as "this component was created then".
- **§6a means an existing populated subtree can never be made domain-local.** Declaring a container
  local is a decision taken when the container is created; there is no retrofit, and the operator's
  only path for an already-shared subtree is to build a new one. This will be the most common
  complaint about the feature, and the answer is not a missing verb — it is §6's asymmetry one level
  up. Anything that appeared to fix it would be claiming a crossing can be un-made.
- **§6a's one-hop inheritance is sound only because every intermediate is itself stamped at create.**
  That induction is the whole reason no containment walk is needed, and it is therefore load-bearing:
  any future path that creates an object *under* a domain-local container **without** going through
  `createObject`'s `domain_id` resolution or `createComponentInService`'s container resolution would
  break the chain silently, producing a shared object inside a local subtree. A new create door is the
  thing to watch, exactly as the eight-door census was for the declaration itself.
- **The DoD must include a negative control.** A test that proves nothing crossed is vacuous unless it
  also proves something did — and it must run at `syncScope: {mode:'full'}`, the widest scope, so it
  cannot pass by accident of a narrow one. This repo has shipped six vacuous tests in two days before;
  the mutation obligation is not optional here.
- **§7's inertness is a standing invariant, not a one-time test.** If any future code path reads
  `domain_local` to decide a gate outcome, this ADR's separation from ADR-0018's rejected
  per-artifact-bypass collapses. The inertness test is what makes that failure loud.
