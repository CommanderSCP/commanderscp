# ADR-0031: Domain-local objects never federate — locality is declared on the object, stamped into the journal, and is not an enforcement input

**Status:** **Draft — proposed, pending owner review** (2026-08-11)
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

A nullable boolean column `objects.domain_local`, set at create. An operator declares *"this
component is domain-local"*. Nothing parses a repo name for `network`, consults a deployment-target
label, or matches a branch string.

This mirrors [ADR-0030 §2](0030-dev-branch-pipelines.md) deliberately and for the recorded reason: a
label named after *what matched* goes false the moment the thing it matched covers a second kind —
already shipped once in this repo, in a Decision where it had been wrong since before the level that
exposed it (charter principle 6).

**A column, not a reserved label.** Labels are free-form user-writable data that already ride the
journal payload; a guarantee about what crosses a trust boundary must be enforceable at a write choke
point, not conventional. The declaration is gated on `federation:write`, not plain `object:write` —
[ADR-0022](0022-outpost-config-authority-split.md) set exactly that precedent for the mirror-image
case, and for the same reason: a property that governs a boundary is not an ordinary object field.

### 2. The declaration is **stamped into the journal payload** at append time

Each of the six writers above stamps `domainLocal: true` into the payload it already builds. Both
payloads are already full-state (`object_upsert` carries `properties`/`labels`/`version`;
`relationship_upsert` carries `fromId`/`toId`/`properties`/`labels`), so this is one more field, not
a shape change, and **no new journal entry kind** — the nine kinds are unchanged and the bundle
format does not move.

Stamping is what keeps `entryMatchesScope` pure and keeps the two sides in agreement, per §Context.

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
- **Domain-local → shared is refused in v1** and named as future increment **M20.4**. It is
  implementable — journal payloads are full-state upserts, not deltas, so re-journaling the object's
  current state would publish it correctly from that point forward — but it needs a companion census
  of the object's existing edges and a decision about what "no history before this point" means to a
  commander-side reader. Shipping it half-done would create an object the commander holds with an
  unexplained genesis.

Both refusals are enforced at the `createObject`/`updateObject` choke point in
`graph/objects-repo.ts`, not per route, so every write door inherits them — the same choke-point
argument [ADR-0022](0022-outpost-config-authority-split.md) clause 4 makes, and for the same reason:
four free-form-`typeId` local write doors already exist and any new one would silently be a fifth.

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
- **Locality as a containment subtree (declare a `domain` object local, inherit downward) — deferred,
  not rejected.** It does not actually answer the cross-boundary-edge question (a component inside the
  subtree still needs an edge to a service outside it), and it lands on the `domain` object type,
  which is an unpopulated slot with an unresolved stage-vs-domain modeling question ahead of it. Worth
  revisiting as an **ergonomic layer over** §1 once that settles — a declaration convenience, not a
  different mechanism.
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
- **The immutability in §6 is a real ergonomic cost.** An operator who declares a component local and
  later needs it shared must create a new object until M20.4 exists. Accepted because every mutable
  alternative has a silent-divergence failure mode and federation has no un-send.
- **The DoD must include a negative control.** A test that proves nothing crossed is vacuous unless it
  also proves something did — and it must run at `syncScope: {mode:'full'}`, the widest scope, so it
  cannot pass by accident of a narrow one. This repo has shipped six vacuous tests in two days before;
  the mutation obligation is not optional here.
- **§7's inertness is a standing invariant, not a one-time test.** If any future code path reads
  `domain_local` to decide a gate outcome, this ADR's separation from ADR-0018's rejected
  per-artifact-bypass collapses. The inertness test is what makes that failure loud.
