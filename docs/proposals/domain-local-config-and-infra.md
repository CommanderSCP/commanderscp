# Proposal: domain-local config & infrastructure — code that lives in one domain, deploys in that domain, and never leaves it

**Status:** **Accepted and BUILT** — owner sign-off 2026-08-11 (including all six §10 decision points); delivered as M20.1–M20.7 between 2026-08-11 and 2026-08-13. [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) carries the normative record and is the document to read for current behaviour — it has been amended three times since this proposal was written (§6a subtree inheritance, §6b the publish/containment refusal, §6c locality provenance), and two of those amendments CORRECTED clauses this proposal describes. §10 below is preserved as the reasoning behind each original choice, not as a statement of what shipped.
**Relates to:** [ADR-0017](../adr/0017-ownership-refinement.md) (§2 — domain-specific config/infra is outpost-owned); [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) (outpost-local Gitea); [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (scan is a *boundary-crossing* authorization gate); [ADR-0018](../adr/0018-domain-local-dev-pipelines.md) / [ADR-0030](../adr/0030-dev-branch-pipelines.md) (M18 dev pipelines — **a different thing**, see §2); [ADR-0022](../adr/0022-outpost-config-authority-split.md) (the commander-declared-config replica direction — this is its mirror image); [ADR-0011](../adr/0011-universal-outpost-validation.md) (§1 — domain-local artifacts have no transfer phase); [GLOSSARY.md](../GLOSSARY.md); charter principles 1 (coordinate, not execute), 2 (graph-native), 6 (explainability), 7 (Simplicity first).
**ADR:** [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) — Accepted, and amended three times during implementation. Where this proposal and the ADR differ, **the ADR governs**: it records what was actually built.

---

## 1. Why now

> **Owner, 2026-08-11:** *"We must find out how to manage and track domain-specific code. These wouldn't flow down a pipeline from a single source of truth. Though we do still want people to be able to make a change in code within that domain and let it be deployed out. At the minimum, I can think of this being needed for Config and specific types of infra (ex: detailed networking). These will need to be handled by the Outposts, not Commander like other things. Though in this case, I don't think the Commander needs to know when these deploy out. Possible these would be in the Outpost UI only?"*
>
> **Owner, 2026-08-11 (follow-ups):** the commander sees **nothing at all**; and *"This is an Outpost function only used to deploy config and infra specific to a domain. That would be hosted in code."*

Every pipeline CommanderSCP models today assumes a **single source of truth upstream** and a **crossing**:
a change originates somewhere, is built, scanned, signed into a promotion manifest, and travels across a
trust boundary into each domain. That model is correct for the artifacts a company ships everywhere.

It is the wrong model for the code that is **true only in one domain**. An IL5 partition's VPC layout,
route tables, transit-gateway attachments, security-group rules, and the per-domain slice of Kubernetes
configuration have no upstream. There is no commercial-side original to promote. The code is authored in
the domain, reviewed in the domain, and deployed in the domain — and expressing it as "a promotion whose
source happens to be here" would be a fiction the graph would then have to maintain.

This proposal names that class, states what it means for it to never leave the domain, and identifies the
one place the current implementation does not honour that.

## 2. What this is **not**

**This is not M18.** [ADR-0018](../adr/0018-domain-local-dev-pipelines.md) / [ADR-0030](../adr/0030-dev-branch-pipelines.md)
cover **dev/beta pipelines** — an engineer iterating fast on the `dev` branch of a shared repo, producing
artifacts that are *not yet* ready for the gauntlet and that *may later be promoted*. M18's whole design
tension is the "later" — its safety argument is that a dev digest promoted afterwards is scanned **at the
crossing**, and its rejected alternatives are all about stopping a dev bit from riding onto a
boundary-crossing artifact.

This class has no "later". Domain-specific networking config **is** the production artifact of its domain
and there is nowhere for it to be promoted to. The two share most of the mechanism (both are domain-local,
both never reach `exportPromotionBundle`, both are therefore outside the cross-boundary gate) and none of
the intent. They must not be collapsed:

| | **M18 — dev/beta pipelines** | **This — domain-local config & infra** |
|---|---|---|
| Lifetime | Transient; iteration scratch | Permanent; the domain's production config |
| Upstream | A shared repo with a `main` that *is* promoted | **None.** This is the source of truth |
| Later promotion | Expected, and gated at E6 | **Never.** There is no destination |
| Recognised by | Source ref (`ref_pattern`, ADR-0030 §1) | An operator declaration on the object (§5) |
| Commander sees | The component and its releases | **Nothing at all** (owner, 2026-08-11) |
| Selected because | The dev loop must be fast | The artifact is meaningless outside its domain |

**This is also not cross-domain promotion with a short path.** Nothing here weakens, reroutes, or adds an
input to the export gate. See §7.

## 3. What already works — measured at HEAD, 2026-08-11

Most of this capability exists. The findings below are grounded in code, not inferred from docs.

### 3.1 Pipeline configuration already never federates

`source_mappings` and `executor_bindings` call `appendJournalEntry` **zero** times, and no module under
`apps/server/src/federation/` references either table. The journal admits nine entry kinds
(`JournalEntryKindSchema`, `packages/schemas/src/federation.ts`) and **none of them is mapping-shaped or
binding-shaped** — the same structural fact [ADR-0022](../adr/0022-outpost-config-authority-split.md) built
its authority split on for `federation_peers`.

So the entire routing layer of a pipeline — which repo/path/ref glob matches, which component it resolves
to, which routing Type it carries, and which Argo CD or Argo Workflows instance executes it — is
**already per-instance local by construction**. An outpost can wire a complete pipeline that the commander
structurally cannot see, today, with no new code.

`executor_bindings` is unique on `(org_id, target_object_id, type_id)`
(`executor_bindings_org_target_type_key`, `apps/server/src/db/schema.ts:1600`), so one component can own a
`configuration` pipeline and an `infrastructure` pipeline simultaneously — the shape detailed networking
needs.

### 3.2 The outpost already serves its own UI, and it is verified

M16.3 is **DONE**. `apps/server/src/federation/outpost-local-ui.integration.test.ts` proves a
`role: outpost` instance serves real `text/html` at `GET /` **and** that a domain-local component
round-trips through the generated SDK on that same instance. The "Outpost UI only" half of the owner's
question needs no build — see §8 for why it needs no *gating* either.

### 3.3 Locally-authored objects are already the outpost's alone to drive

An object created at an outpost is stamped `origin_domain_id = federation_self.domainId`
(`graph/objects-repo.ts`). The S10 single-writer guard — `if (object.originDomainId !== selfDomainId) continue;`
in six `reconcile.ts` loops plus `campaign-reconcile.ts`, and `coordination/transition.ts`'s explicit check —
means no other domain's engine will ever drive it. Ownership is already correct; only **visibility** is not.

### 3.4 The gate exemption is already structural, not a bypass

- `coordination/pre-deploy-gate.ts` exempts any change with no `importedFromDomain` — a domain-local change
  deploys ungated, and the neighbouring test asserts it persists **zero** Decisions (an `allow` there would
  attest a verification that never ran).
- `coordination/boundary-segment.ts` returns `null` for a change that never crossed — absent, never an
  empty pass.
- `exportPromotionBundle` **requires a federation peer**, so a domain-local change never reaches E6 at all.

Nothing in §5 changes any of this. The exemption stays a property of the path.

### 3.5 The ownership decision is already recorded

[ADR-0017 §2](../adr/0017-ownership-refinement.md) already states that build "of any tracked artifact:
image, rpm, npm, shared config/infra, or **domain-specific config/infra**" runs in the originating
outpost's Argo Workflows, and that **domain-specific config/infra repos are outpost-owned**. This proposal
does not re-decide that; it supplies the tracking model ADR-0017 assumed and did not specify.

Combined with [ADR-0010](../adr/0010-outpost-local-artifact-infra.md)'s outpost-local Gitea, the owner's
"hosted in code" is satisfied end to end without a single byte crossing a boundary:

```
outpost-local Gitea (git)  →  outpost webhook  →  outpost source_mappings  →  outpost component
                                                        →  outpost executor_binding  →  outpost Argo CD / Workflows
```

Every arrow in that chain is local table data on one instance.

## 4. The gap

**Graph objects and changes journal unconditionally.** `appendJournalEntry` is called — in the same
transaction as the mutation, never conditionally on content — from **six** writers:

| writer | entry kinds |
|---|---|
| `graph/objects-repo.ts` (:241, :564, :898) | `object_upsert`, `object_tombstone`, `policy_upsert` |
| `graph/relationships-repo.ts` (:326, :454) | `relationship_upsert`, `relationship_tombstone` |
| `coordination/changes-repo.ts` (:422) | `object_upsert` (typeId `change`) |
| `coordination/transition.ts` (:337) | `change_status` |
| `governance/approvals-repo.ts` (:276) | `approval_evidence` |
| `audit/audit-repo.ts` (:91) | `audit_segment` |

There is **no per-object "do not federate" bit**. The only filter is `federation_peers.sync_scope`, applied
at export (`federation/export-repo.ts:42`) and re-applied at import as defense in depth. Its five modes are
coarse, and the one flexible mode — `custom` with a `labelSelector` — is **inclusive-only**
(`federation/scope-filter.ts:38-45`): it expresses "send only entries matching X", never "send everything
except the domain-local ones".

So today, an outpost's domain-local component, its relationships, its changes, its change-status
transitions, and its audit segments all ride its own journal and are shipped to the commander at any scope
wide enough to carry them. The owner's "nothing at all" is currently expressible only as a **whole-peer**
setting (`status_only`), which is the wrong granularity — it would also suppress the upward reporting the
commander legitimately needs for cross-boundary work, and widening it back is documented to require a full
re-sync from sequence 0 (`scope-filter.ts` module doc).

**One consequence deserves naming on its own.** With no locality filter, a domain-local component's
`relationship_upsert` edges already leak its object id, `typeId`, `properties` and `labels` upward even
where the object itself is filtered — see §6.

## 5. Proposed design

Full normative statement in **[ADR-0031](../adr/0031-domain-local-objects-never-federate.md)**. Summary:

### D1 — Locality is a **declared property of the object**, read, never inferred

A new nullable boolean column `objects.domain_local`, set at create. The operator declares *"this component
is domain-local"*; nothing parses a repo name for `network`, no target label is consulted, no branch string
is matched. This mirrors [ADR-0030 §2](../adr/0030-dev-branch-pipelines.md) exactly, for the same reason
recorded there: a label named after *what matched* goes false the moment the thing it matched covers a
second kind — already shipped once in this repo, in a Decision where it had been wrong since before the
level that exposed it (charter principle 6).

A column rather than a reserved label, because a label is free-form user-writable data that already rides
the journal payload; the guarantee has to be enforceable at a write choke point, not conventional.

### D2 — The declaration is **stamped into the journal payload** at append time

Each of the six writers in §4 stamps `domainLocal: true` into the payload it already builds. This keeps
`entryMatchesScope` a **pure, synchronous predicate over the entry** — which it must stay, because it is
the same function applied on both the export and the import side, and the importer has no way to query the
sender's object state.

### D3 — A domain-local entry matches **no** peer scope, in either direction

One clause in `federation/scope-filter.ts`, **ahead of the mode switch**:

```ts
export function entryMatchesScope(entry: SyncJournalEntry, scope: SyncScope): boolean {
  if ((entry.payload as { domainLocal?: unknown }).domainLocal === true) return false;
  switch (scope.mode) { /* unchanged */ }
}
```

One predicate, already invoked at both ends, already probed reflexively by `scopeCarriesChangeObjects` so
the honesty helpers cannot drift from it. Bundles become sparser; they are already sparse under every
scoped mode and already verified with `verifyJournalChain({ contiguous: false })`, so the chain model needs
no change.

**Not a new `SyncScope` mode.** A mode is per-peer, so it cannot distinguish a shared component from a
domain-local one on the same peer; changing one re-anchors cursors; and `SyncScope` is a **required field
on `FederationPeerSchema`** (`packages/schemas/src/federation.ts:567`), i.e. a response, where a new
discriminated-union member is exactly the widening class the oasdiff gate catches.

### D4 — Relationships inherit locality from **either** endpoint

See §6 — this is the question the owner asked about, with options and a recommendation.

### D5 — A change may not span a locality boundary, and inherits from its targets

`coordination/changes-repo.ts::proposeChange` is the single creator and already resolves every target
(`:185-190`) — it is described in its own doc comment as "the SINGLE POINT where a change acquires its
release topology". Locality derivation belongs in that same loop. A change whose targets are **mixed**
(some domain-local, some not) is **refused at propose time** rather than resolved to either answer:
resolving it *local* would silently darken a legitimate cross-boundary release, and resolving it *shared*
would leak. Refusal is the only option with no silent failure mode.

### D6 — Locality is **immutable after create** in v1

**Shared → domain-local is refused permanently.** Federation has no un-send: once a component's existence
has crossed, declaring it local afterwards asserts a confidentiality property the system cannot deliver.

**Domain-local → shared is refused in v1**, as a named future increment rather than a silent hazard. It is
implementable (journal payloads are full-state upserts, not deltas, so re-journaling the object's current
state would publish it correctly from that point on) but it needs a companion census of the object's
existing edges, and a decision about what "no history before this point" means to a commander-side reader.
Out of scope here; recorded in ADR-0031 as future increment M20.4.

### D7 — This is **visibility only**, never an enforcement input

`domain_local` grants **no** scan exemption, relaxes **no** gate, and is read by **no** governance code
path. E6 stays input-free, exactly as [ADR-0030 §3](../adr/0030-dev-branch-pipelines.md) requires. The
exemption these objects enjoy continues to come from the **path** — they target no peer, so
`exportPromotionBundle` is never reached. Pinned by an inertness test (forging or removing the bit changes
no gate outcome), the same obligation [ADR-0018 §4](../adr/0018-domain-local-dev-pipelines.md) placed on
its own descriptive label.

## 6. The relationship question — options and recommendation

**The problem.** A domain-local networking component will naturally be `part_of` a service the commander
knows about, and `hosted_on` a deployment target. The outpost authors that **edge**, so the edge journals
in the outpost's own chain. Under D1–D3 the component's `object_upsert` is filtered but the
`relationship_upsert` is not — it arrives at the commander naming a `fromId` that does not exist there.

Today `federation/import-repo.ts:269-275` catches exactly this and skips the edge:

```
// Endpoints not yet replicated locally (out-of-order relative to this domain's own
// history — should not happen for a from-genesis or contiguous-cursor import, since a
// relationship's origin domain always creates its endpoints first in its OWN chain, but
// handled defensively rather than failing the whole bundle over one skippable edge).
```

That comment's premise is true today and **false under any locality filter**. Per CLAUDE.md's census
discipline, a well-written comment naming a hazard is a signal to sweep, not evidence it was handled.

### Option A — locality is inherited by the edge *(recommended)*

`createRelationship` already loads and validates both endpoints (that validation is the source of the 400
above), so it can stamp `domainLocal: true` when **either** endpoint is domain-local. The edge is then
filtered by the same single D3 clause; nothing about it ever leaves.

- **Satisfies "nothing at all" literally.** No id, type, property or label of a domain-local object crosses
  in any form.
- **No new mechanism** — it reuses the D2 stamp and the D3 predicate. One predicate governs objects, edges,
  changes, status and audit alike, which is the census-safe shape.
- **Either-endpoint, not both.** The interesting edge is precisely the mixed one (local component → shared
  service); requiring both endpoints to be local would let exactly the leaking case through.
- **Cost:** the commander cannot see that a shared service has domain-local children — but that is what
  "nothing at all" means, and §8 explains why it is the right default.

### Option B — leave the edge unfiltered; let the existing skip absorb it

Zero new code beyond correcting the comment. **Rejected**: the edge payload carries `fromId`, `toId`,
`typeId`, `properties` and `labels`, so the commander receives the domain-local component's identity and
metadata and merely declines to store it. That is not "nothing at all" — it is a leak with a swallow, and
it would sit in the commander's bundle files and transfer records regardless of whether the import applied
it. This option is disqualified by the owner's decision, not merely disfavoured by it.

### Option C — forbid the edge: locality partitions the graph

Refuse any relationship whose endpoints differ in locality, at the `createRelationship` choke point.
Structurally the cleanest guarantee — locality becomes a genuine partition and no filtering is needed for
edges at all. **Rejected**: it makes every domain-local component an orphan in the outpost's *own* graph.
The outpost UI's service and component views are built on containment; a networking component that cannot
be `part_of` anything renders nowhere useful, and the operator loses the only context that makes it
legible. Buying a structural guarantee by breaking the local modeling is the wrong trade under principle 7
(Simplicity is about the system, not about one predicate).

### Option D — locality as a containment subtree

Declare a containment `domain` object as domain-local and inherit locality down the tree. Attractive under
principle 2, and it would make the declaration a single act rather than a per-component one. **Not
recommended now, and not actually an answer to this question**: it relocates the cross-boundary-edge
problem rather than solving it (a component inside the local subtree still needs a `part_of` edge to a
service outside it), and it lands on the `domain` object type, which is an unpopulated slot with an
unresolved stage-vs-domain modeling question ahead of it. Worth revisiting as an ergonomic layer **over**
D1 once that question is settled — a declaration convenience, not a different mechanism.

**Recommendation: Option A**, with the `import-repo.ts:269` comment corrected in the same change to stop
claiming the dangling-edge case cannot arise. Under Option A it still cannot arise *from a locality filter*
— but the comment's stated reasoning ("the origin domain always creates its endpoints first in its OWN
chain") is no longer the reason, and a stale rationale in a defensive catch is how the next instance hides.

## 7. What does **not** change

Stated explicitly so no future reader reads this proposal as a carve-out:

- **E6 and `exportPromotionBundle` are untouched.** No new input, no new branch, no source-derived string
  reaching a fail-closed gate.
- **The nine journal entry kinds are unchanged.** No new kind, no bundle-format change — the same
  constraint that shaped [ADR-0022](../adr/0022-outpost-config-authority-split.md).
- **`federation_peers` is untouched.** No new column, no new mode, no transport change.
- **Single-writer authority is unchanged.** These objects were already locally originated and already
  driven only by their own domain.
- **Scan-at-source, cosign, manifest verification, the boundary segment** — all untouched. A domain-local
  object never enters any of those paths, and this proposal does not make it possible for one to.

## 8. The Outpost UI, and why it needs no role gate

The owner asked whether these would be "in the Outpost UI only". **It falls out — there is nothing to
gate.** The commander's UI renders what is in the commander's database; if the object never lands there, it
never appears, in any view, with no conditional rendering anywhere.

That is the desirable outcome and not merely a convenient one. M16.3's write-control census (P2) found the
opposite failure already shipped: `apps/web` offered Assign, Detach, Repurpose, Merge, Accept, Rollback and
Cancel on objects with **no notion of federation origin at all**, and the first attempt to fix it disabled
controls on the basis of a server refusal that, for most of them, did not exist. A role-conditional
"outpost mode" would be a second instance of that class. Absence of data is a stronger guarantee than a
conditional view, and it is one the UI cannot get wrong.

The outpost's operator sees these components in the ordinary service, component-journey and graph views
alongside everything else in the domain — which is correct, because from inside the domain they are not a
special class at all. They are simply the components whose source of truth is here.

## 9. Proposed milestone — M20

*(Provisional number; M19 — the execution-system import wizard — is currently the last milestone in
BUILD_AND_TEST.md §8. M20 is independent of both M18 and M19 and depends on neither.)*

- **M20.1 — the declaration.** `objects.domain_local` (additive expand migration), set at create, refused
  on update at the `createObject`/`updateObject` choke point per D6. API/SDK/CLI/IaC/UI parity
  (principle 3). Declaration is `federation:write`-adjacent, not plain `object:write` — a bit that governs
  what crosses a boundary is not an ordinary object property, and ADR-0022 already set that precedent for
  the mirror-image case.
- **M20.2 — the filter, and the six-writer census.** The D3 clause in `scope-filter.ts`, plus the D2 stamp
  in **all six** journal writers of §4 — enumerated, not grepped for, with the census recorded in the PR
  body. `audit_segment` is included even though the importer discards it: an audit segment naming a
  domain-local change's action is exactly the leak this closes, and "the receiver drops it anyway" is a
  property of the receiver, not a guarantee of the sender.
- **M20.3 — edges and changes.** Option A inheritance in `createRelationship`; D5 inheritance and the
  mixed-target refusal in `proposeChange`; the corrected `import-repo.ts:269` comment.
- **M20.4 — domain-local → shared publication — DONE.** `POST /v1/objects/{type}/{id}/publish`, shipped
  between this section's original planning and today; see BUILD_AND_TEST.md §8 M20.4 and
  [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) §6b for what actually shipped, which
  differs from D6's sketch below in the ways this document's own header already flags.

### Definition of done

Two genuinely separate Postgres databases via Testcontainers — the same faithful topology
`boundary-segment.integration.test.ts` established, since the whole claim is about what the commander's
database **cannot** contain:

1. An outpost declares a domain-local component, wires a source mapping and an executor binding, and drives
   a change through to deploy. After a real export→import at **`syncScope: {mode:'full'}`** — the widest
   scope, so the test cannot pass by accident of a narrow one — the commander's database contains **zero**
   rows referencing that component: no object, no relationship, no change, no change status, no audit
   segment, and no occurrence of its id or urn anywhere in the exported bundle body.
2. The **negative control in the same test**: a shared component in the same org, in the same bundle,
   arrives normally. A test that proves nothing crossed is vacuous unless it also proves something did.
3. The mixed-target `proposeChange` refusal, and both D6 immutability refusals.
4. **The inertness test (D7):** the same digest, promoted across a boundary, is refused at E6 without a
   passing digest-bound scan **whether or not** `domain_local` is set — mutation-proven, per ADR-0018 §4.
5. A `role: outpost` instance renders the domain-local component in its own service/component views
   (extending `outpost-local-ui.integration.test.ts`).

## 10. Decision points — options and recommendations

Six choices are open. Three are written into ADR-0031's clauses as drafted and are flagged here because
they were **decided rather than asked**; three were never decided. Each is stated with its options, the
reasoning, and a recommendation. **Where a recommendation differs from what ADR-0031 currently says, that
is called out** — the ADR is a draft and has not been amended ahead of this review.

### Q1 — A change whose targets span localities *(ADR-0031 §5, decided-not-asked)*

| | Option | Consequence |
|---|---|---|
| **1** | **Refuse at propose time (400)** | Loud, at authoring time. Cannot express a release spanning both. |
| 2 | Resolve to **local** if any target is local | Fail-closed on the leak — but **silently darkens a legitimate cross-boundary release**. |
| 3 | Resolve to **shared** if any target is shared | Leaks. Disqualified by the "nothing at all" decision. |
| 4 | **Auto-split** into two changes, one per locality | Attractive, but a change is the unit of coordination: waves, gates, approvals and M12 `provides`/`requires` coupling all attach to it. Splitting one into two unrelated changes silently breaks that. |

Option 2 is the tempting one and is worse than it looks: in a **coordination** platform, silently making a
real release invisible to the coordinator is a coordination failure, not a safe default. Option 4 is a
genuine v2 but needs an explicit relationship between the split changes or it recreates the same problem
one level down.

The refusal also bites rarely. Webhook-born changes target one component; multi-target changes come from
campaigns, initiatives and explicit API calls, where an author is already thinking about scope.

> **Recommend Option 1** (as drafted). Revisit Option 4 only if the refusal proves blunt in practice, and
> only with a modelled relationship between the halves.

### Q2 — Mutability of the locality declaration *(ADR-0031 §6, decided-not-asked)*

| | Option | Consequence |
|---|---|---|
| 1 | **Immutable both directions** *(as drafted)* | Simplest. An operator who declares wrong must create a new object. |
| **2** | **Shared→local refused forever; local→shared allowed via an explicit publish** | Honest in both directions. Needs a bounded edge census. |
| 3 | Fully mutable, "from now on" semantics | Out: shared→local cannot be honoured, so the API would answer 200 to a request it cannot satisfy. |
| 4 | Mutable within a grace window | A fuzzy predicate ("not yet referenced") that will be wrong at the boundary. |

**This is the recommendation that differs from the ADR as drafted.** §6 defers local→shared to M20.4 on the
grounds that it needs an edge census and raises a "no history before this point" question. On closer
reading both costs are smaller than that clause implies: journal payloads are **full-state upserts, not
deltas**, so re-journaling the object publishes it correctly from that point; the edge census is one
bounded query (`relationships` where `from_id` or `to_id` = the object) re-journaling only the edges whose
other endpoint is shared; and "no history" is close to a non-issue, because the importer does
`upsertObjectByUrn` and **discards imported audit segments anyway**.

The asymmetry is the whole point and must survive either way: **shared → domain-local stays refused
permanently**, because federation has no un-send and an API that answers 200 there is lying.

> **Recommend Option 2, pulling M20.4 into M20 scope.** Immutability is the clause most likely to cause
> real operational pain, and the honest version is cheaper than the draft assumed. If you prefer to keep
> M20 small, Option 1 ships safely and M20.4 stays a named increment — it forecloses nothing.

### Q3 — Which permission governs the declaration *(ADR-0031 §1, decided-not-asked)*

| | Option | Consequence |
|---|---|---|
| **1** | **`federation:write`** *(as drafted)* | Matches ADR-0022's precedent for the mirror-image case. |
| 2 | Plain `object:write` | Wrong: the generic `/objects/{type}` door and the IaC plan-apply path would write a boundary-governing bit with the weaker permission — the exact hole ADR-0022 closed. |
| 3 | A dedicated permission (`federation:locality`) | Cleanest in principle; adds an RBAC member for one bit. |
| 4 | `object:write` to create, `federation:write` to set the bit | This **is** Option 1, stated precisely. |

> **Recommend Option 1.** Revisit Option 3 only if a second boundary-governing bit ever appears — one bit
> does not earn its own permission (principle 7).

### Q4 — Where the declaration is made *(the same containment-subtree idea §6 weighs as its Option D, asked here as a standalone choice)*

| | Option | Consequence |
|---|---|---|
| 1 | **Per-component only** *(as drafted, D1)* | Simple; tedious for twenty networking components. |
| 2 | Containment subtree only | Couples this design to the `domain` object type — an unpopulated slot with the unresolved stage-vs-domain question ahead of it. |
| **3** | **Per-component now; subtree later as an ergonomic layer** | Additive, and forecloses nothing. |
| 4 | Both from day one | Creates a precedence question (does the object win, or the ancestor?) on day one, for no measured need. |

Subtree inheritance is **purely a declaration convenience** — it resolves to the same per-object bit — so
adding it later invalidates nothing built now.

> **Recommend Option 3**, with one implementation constraint worth fixing now: when the subtree layer
> lands, it should **materialize** the bit onto each object at declaration time rather than resolve it
> dynamically at export. That keeps the journal stamp a plain column read and puts no containment walk in
> the write path.

### Q5 — May a **commander** declare an object domain-local?

| | Option | Consequence |
|---|---|---|
| **1** | **Allow anywhere** | The commander's own domain is a domain. With no peer, nothing was going to be exported anyway. |
| 2 | Refuse unless `federation_self.role == 'outpost'` | A role-gated write on an **org-scoped, advisory** field — precisely what M16.3's P3 declined to do when it introduced the install-time `SCP_FEDERATION_ROLE` axis instead, because `self_domain.role` would fork from the Helm value. |
| 3 | Refuse unless at least one peer exists | Penalises the normal bootstrap state (a fresh instance has no peers yet). |
| 4 | Allow, but warn in the UI on a commander | A warning for a legitimate action trains operators to ignore warnings. |

Option 2 is also substantively wrong, not merely awkward: the root domain is dev-heavy and has its own
config and infra, so it has exactly this class of code.

> **Recommend Option 1** — and add a clause to ADR-0031 making the sequencing property explicit, because it
> is a genuine safety feature and not just a no-op: **declaring locality *before* a peer is paired means
> pairing later cannot retroactively publish anything.** That is the correct operational order to document.

### Q6 — Does the commander get any aggregate signal? *(you decided "nothing at all"; recorded for completeness)*

| | Option | Consequence |
|---|---|---|
| **1** | **Nothing at all** *(decided)* | Commander loses inventory visibility of a real part of the estate. |
| 2 | An aggregate count per outpost | Needs a new journal-carried fact — and a count is a **covert channel**: it moves when local work happens, which is the observability the decision rules out. |
| 3 | Type-level counts | Same cost as 2, higher resolution, same objection. |
| 4 | A commander-**entered** note on the existing `outpost` object (ADR-0022) | **Free** — no new machinery, no journal change. But it is the commander describing what it *believes*, never an observation. |

Option 4 is worth knowing about because it costs nothing: ADR-0022 already gives the commander an
`outpost` graph object it authors, carrying `provenance`/`originIsSelf` specifically so a reader can tell
an assertion from a verified fact. An operator wanting an inventory **annotation** can have one today,
provided it renders as commander-entered and never as observed.

> **Recommend keeping Option 1.** No code, no ADR change. If an annotation is ever wanted, reach for
> Option 4 rather than reopening the journal.

### Summary — all six decided, owner sign-off 2026-08-11

| | Question | Decision | Where it is normative |
|---|---|---|---|
| Q1 | Mixed-locality change | Refuse at propose time | ADR-0031 §5 |
| Q2 | Mutability | **Local→shared allowed via an explicit publication verb; shared→local refused permanently.** M20.4 pulled into M20 scope | ADR-0031 §6 (amended by this sign-off) |
| Q3 | Permission | `federation:write` | ADR-0031 §1 |
| Q4 | Declaration site | Per-component now; a subtree layer later **must materialize, never resolve**. **Resolved 2026-08-13 as M20.5** — inheritance at **create**, one hop, either containment route; *not* a backfill, because "materialize at declaration time" read literally is the shared → domain-local flip §6 refuses | ADR-0031 §1 + **§6a** |
| Q5 | Commander declaring | Allow on any instance in any role; **declare-then-pair** is the safe order | ADR-0031 §1 |
| Q6 | Aggregate signal | "Nothing at all" stands; ADR-0022's commander-entered note is the free fallback if an annotation is ever wanted | ADR-0031 §"Alternatives" |

## 11. Configuration as code — and why it is not scanned

The content class this milestone serves is **configuration as code**, now a
[GLOSSARY.md](../GLOSSARY.md) entry: declarative configuration and infrastructure kept in a git
repository and released through a pipeline like any other artifact. A large share of it is domain-local
— a security domain's VPC layout, route tables, transit-gateway attachments, security-group rules and
its per-domain Kubernetes configuration have no upstream original — which is precisely the class §1
opens with.

**It is not subject to the scan gate, and the reason is the path, never the location.** It crosses no
security-domain boundary, so there is no crossing to authorize — [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md)'s
domain-local case, already stated in the glossary's `scan gate` entry.

**"Because it is at the outpost" is not the reason.** An outpost is not a scan-free zone:
[ADR-0017 §2](../adr/0017-ownership-refinement.md) devolved **build to the originating outpost**, so an
outpost routinely produces artifacts that *do* need a passing, digest-bound scan before they may cross.
Recording location as the reason would license a bypass in the one place the gate matters most. Full
statement, including the Gate 1 / Gate 2 table, in **ADR-0031 §8**.

**The optional local scan Control is unaffected and stays available.** A domain that wants its own
network configuration scanned locally attaches an [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md)
scan requirement and gets one — a quality choice the org owns, never an authorization.
