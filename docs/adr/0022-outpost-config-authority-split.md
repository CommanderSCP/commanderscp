# ADR-0022: The outpost authority split — a `federation_peers` row and an `outpost` graph object own disjoint facts

**Status:** Accepted (2026-07-30, M16.2 phase A)
**Context doc:** [docs/proposals/federation-outposts-ui.md](../proposals/federation-outposts-ui.md)
**Relates to:** [ADR-0004](0004-service-naming-commander-outpost-retrans.md) (commander / outpost / retrans); [ADR-0011](0011-universal-outpost-validation.md) (universal outpost validation); [ADR-0009](0009-optional-poke-mode-federation.md) (poke-mode, a peer-row field); [ADR-0021](0021-terminology.md) (D4 trust vs containment domain); [GLOSSARY.md](../GLOSSARY.md) (**authoritative for vocabulary**); DESIGN.md §13

## Context

M16.2's Outposts UI needs to show and edit **commander-declared config about an outpost** — starting
with its **trust tier** — and to have that config reach the outpost.

The obvious implementation is a column on `federation_peers`. It does not work, for a reason the
journal makes unavoidable: **the sync journal cannot carry a peer.** `JournalEntryKindSchema` admits
exactly nine entry kinds, none of them peer-shaped, and `federation/peers-repo.ts` never calls
`appendJournalEntry`. Nothing written onto a peer row can ever travel. A trust tier stored there would
be a commander-local note the outpost could never see.

At the same time the peer row is genuinely authoritative for something else: it holds the peer's
trust-domain identity, its Ed25519 signing key and cosign verification key (with sequence-anchored
windows), `base_url`, `sync_scope`, `delivery_target`, `poke_mode`, and the scheduler's per-peer
timestamps. Every export, pull, poke and signature verification reads it and nothing else. It is
per-side and local by design, and it must stay that way — federation transport must not become
something a peer can reconfigure by sending a bundle.

So "an outpost" ends up existing **twice** in a commander's database, and the risk is the ordinary one:
two half-authorities drifting into overlapping claims about the same thing.

## Decision

**Split the facts, structurally, and write the split down as a normative rule.** The rule lives in
`apps/server/src/federation/outpost-binding.ts` (five clauses, each checked by
`outpost-object.integration.test.ts`); this ADR is the decision record behind it.

1. **The `federation_peers` row (+ `federation_peer_keys`) is the sole authority for transport identity
   and reachability.** Local, per-side, never journaled. Two write doors only: `POST /v1/federation/peers`
   (pair/re-pair — the only door that may touch key material) and `PATCH /v1/federation/peers/{id}`
   (transport only, structurally keyless).

2. **The `outpost` graph object is the sole authority for commander-declared config about that outpost**
   — today `trustTier`, plus the `peerDomainId` that binds it to (1). Commander-origin; rides the
   existing `object_upsert` entry kind; lands at the outpost as a **read-only replica** under the
   existing single-writer-authority guard. No new entry kind, no new table, no new column: registry
   data (charter principle 2).

3. **Neither may express the other's fields.** No transport field appears in the object's create/update
   request bodies; there is no trust-tier column on `federation_peers` and its PATCH body admits only
   `{name, baseUrl, syncScope, deliveryTarget, pokeMode}`. Observable consequence, asserted in both
   directions: a config write leaves `federation_peers`/`federation_peer_keys` byte-identical and
   appends exactly one journal entry; a transport write leaves the object's `version`/`revision`
   untouched and appends **no** journal entry at all.

4. **The peer row is the anchor; the binding is 1:1 and object→peer only.** An `outpost` object must
   name an already-paired peer holding role `outpost`; a second object for the same peer conflicts.
   The object never creates, mutates, or is required by the peer row — federation works exactly as
   before for a peer that has none.

5. **Tie-break: the peer row wins for anything about reachability.** "Is this outpost air-gapped?" is
   derived from `base_url`/`delivery_target`, never from the trust tier.

**Enforcement is at one choke point, not per route.** Clause (4) is checked inside
`graph/objects-repo.ts`'s `createObject`/`updateObject`, so every local write door inherits it — the
generic `/objects/{type}` endpoints, the IaC plan-apply path, the federation overlay route,
`POST /discovery/{…}/accept`, and anything added later. Guarding routes one at a time is the
incomplete-call-site-census failure this project keeps paying for.

**The keyless PATCH is deliberate.** `pairPeer` requires `publicKey` and treats a different value as a
**key rotation** that supersedes the current window and hard-revokes the old key at the applied-sequence
anchor. A settings form built on it rotates a peer's trust anchor the first time it drops or mangles the
key. `PATCH /v1/federation/peers/{id}` therefore admits **no key material at all** — the capability is
structurally missing, not conditionally skipped — and `role` is likewise not patchable, because a peer's
federation role is an identity-level assertion made at pairing.

**Trust tier and transport are separate fields, and only one of them is an assertion.** `trustTier` is
owner-**entered**: it has no other source, is never derived, never negotiated with the outpost, and is
**absent** until an operator sets one (never blank, never defaulted to `commercial`). `transportMode` is
**derived from config** — `dialable` when an https/mTLS base URL is configured, `air-gap` when there is
no base URL and a delivery target is, `null` otherwise — and it deliberately does **not** claim
reachability, which lives in `lastPullAttemptAt`/`lastPullSuccessAt`/`effectiveCadence`. One field
meaning both trust posture and reachability would mean neither.

**The trust-tier vocabulary comes from the glossary.** [GLOSSARY.md](../GLOSSARY.md) is authoritative for
vocabulary (CLAUDE.md), and its `security domain` entry states plainly that the security domain **is**
the trust tier, listing `commercial`, `govcloud`, `il5`, `airgap` as stage `<domain>` values and naming
FedRAMP in prose; [ADR-0011](0011-universal-outpost-validation.md) says "FedRAMP-High / IL5 / air-gap".
The enum is therefore **`commercial | govcloud | fedramp-high | il5 | airgap`**. Its first cut
(`commercial | fedramp-high | il5`) left a **GovCloud outpost with no representable value**, so an
operator had to either leave the tier unknown or assert `commercial` — an **invented posture**, which is
precisely what this milestone exists to prevent.

**The registered JSON Schema is deliberately open** (`trustTier` is a plain string; no
`additionalProperties: false`). This type is **journaled**, and the receiving side validates it with Ajv
on an import path with no per-entry try/catch — so a closed schema makes every future addition a
fail-closed version-skew hazard: the first time a newer commander adds a second declared-config property
or a later tier, every outpost on an older migration set rejects that entry and **the whole sync bundle
aborts**, wedging federation for that peer until upgrade. The strictness that matters is at the API,
where it costs nothing: the request bodies are `z.strictObject`, so an unknown property or an invented
tier is **refused with 400** — not silently stripped. That distinction is load-bearing and was wrong in
the first cut (review round 5, N6): a plain `z.object` DROPPED the unknown key and answered 201, so a
newer client writing a phase-B property to an older commander got a success and lost its field with no
signal. An unrecognised tier arriving on the JOURNAL is a different case and is read as **no tier** and
declared unknown, never coerced — that asymmetry (strict at the operator's door, open on the wire) is
the whole design.

## Consequences

**Positive**

- Commander-declared outpost config genuinely reaches the outpost, through machinery that already
  exists — journaled, audited, content-hashed, single-writer-guarded, with no parallel mechanism.
- Federation transport stays untouchable from the wire: a peer cannot reconfigure how it is reached by
  sending a bundle, because no journal entry can express a peer row.
- A settings form can safely rename a peer or change its transport without any risk of rotating its
  trust anchor.
- Adding a second declared-config property in phase B is a schema-and-UI change only; the journal, the
  importer, and older outposts all keep working.

**Costs / honesty**

- Two rows describe one outpost, and an operator must know which one answers which question. The rule
  above is the answer, and it is stated in code where the enforcement is.
- `provenance`/`originIsSelf` now ride the config's read view specifically so a consumer can tell a
  commander's own assertion from an unverified hand-filled shadow. Without that, a UI cannot tell them
  apart at all, and the honest-unknown contract is only as good as what it exposes.
- The 1:1 binding needs a **recovery** verb, not only a refusal: a duplicate config object made the
  commander's own PATCH 409 permanently with no delete door, and an unrecoverable state reachable by a
  supported call is worse than the state it was preventing.
  `POST /v1/federation/outposts/{peer}/reconcile` is that verb — it keeps the authoritative row, adopts
  an unverified shadow when nothing authoritative survives, removes the remaining unverified shadows,
  and — by default — refuses to touch a signature-verified replica (adopting or deleting one would trade
  this wedge for a **sync** wedge: the next real import from that peer would be a single-writer
  violation).
- **`?keep=<objectId>` (added after acceptance, review round 5, N9) closes the VERIFIED-DUPLICATE class
  the default refusal above deliberately leaves open.** Before it, a signature-verified foreign-origin
  duplicate bound to one peer had **no public-API recovery at all**: the commander's own `PATCH` 409s
  forever (the binding scan's blocking filter exempts only `provenance='manual'`), the default
  `reconcile` refuses by design, `DELETE /api/v1/objects/outpost/{id}` is 403 by this same milestone's
  own refusal, and IaC prune only touches stack-managed objects. Not reachable in canonical hub-and-spoke
  — no bundle a commander imports carries an `outpost` row bound to one of *its own* peers — but reachable
  the moment two authoring domains describe one outpost (a sub-commander hierarchy, or a dual-homed
  outpost), which phase A's design does not rule out.
  **The safety argument, which is what makes `?keep=` acceptable rather than a second wedge door:**
  `?keep=<objectId>` lets the caller name which of the peer's live claimant rows should survive. If the
  survivor is a row **this domain authored**, `reconcile` deletes the *other* row — and when that other
  row is *also* locally authored, that delete is an **ordinary journaled tombstone**: it is
  indistinguishable from any other local delete, it re-declares cleanly, and it is safe precisely because
  this domain is the row's own authority. **Deleting a signature-verified replica stays refused
  unconditionally, with or without `?keep=`** — that half is unchanged and is what stops this from
  trading a config wedge for a sync wedge: this domain is never the authority for a replica, so deleting
  one would not be an ordinary tombstone, it would be claiming authorship of a row the real authority
  still owns.
  The read side of the same call reports the two removal cases **separately**
  (`removedShadowObjectIds` vs `removedLocalObjectIds`, review round 6, M1) rather than one bucket: an
  unverified shadow removal is a silent local cleanup nothing downstream ever sees, while a locally
  authored removal is this domain's own declared config being deleted and propagated — an operator (and
  the CLI's `reconcile` output) must be able to tell the two apart.
- **Open, and a docs-first question, not a schema one:** `fedramp-high` carries a hyphen, so it is not
  usable as a stage `<domain>` **segment** under the glossary's hyphen-free segment rule (which
  disambiguates stage names by segment count). Naming a stage in that security domain needs an
  owner-chosen hyphen-free token; the API enum is unaffected either way. Likewise whether FedRAMP
  Moderate needs its own member is a vocabulary decision for the glossary, not something to settle by
  editing an enum.

## Alternatives considered

- **A `trust_tier` column on `federation_peers`** — rejected: it can never reach the outpost (no
  peer-shaped journal entry kind), so the config would be commander-local forever.
- **A new peer-shaped journal entry kind** — rejected: it changes the bundle format and makes peer
  transport state something the wire can carry, which is the property clauses (1) and (3) exist to
  prevent. (The same reasoning rejected a verification-outcome entry kind in M16.1.)
- **Guarding the 1:1 binding at each route** — rejected: four free-form-`typeId` local write doors
  already exist and any new one would silently be a fifth. Review round 4 found exactly that
  (`POST /v1/federation/hand-fill`), which is the argument for the choke point rather than against it;
  hand-fill needed its own narrowing only because it stamps the import context that makes the choke
  point skip.
- **Folding connectivity into the trust tier** — rejected by the owner: one field meaning both trust
  posture and reachability means neither.
- **Reusing `POST /v1/federation/peers` for the settings form** — rejected: it is a re-pair, and a
  re-pair rotates keys.
