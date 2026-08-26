# ADR-0045: `artifact` as a first-class object type, minted at the promotion boundary

**Status:** Accepted. The four decisions below were made by the owner 2026-08-25.
**Relates to:** [ADR-0026](0026-placements-and-derived-stage-names.md) (the "registry rows, not tables" precedent this ADR reuses verbatim); [ADR-0015](0015-cosign-cross-boundary-signing.md) (what the commander's signature covers — this ADR does not change it); [ADR-0019](0019-artifact-byte-channel.md) (bytes travel out of band; this ADR is about the graph fact of an artifact's *identity*, never its bytes); [ADR-0020](0020-first-class-commander-scanning.md) (scan-once-before-signing — the event this ADR's minting point rides); [ADR-0031](0031-domain-local-objects-never-federate.md) (why a destination-minted derivative is domain-local by construction, not by a special case); [docs/proposals/machine-image-publication.md](../proposals/machine-image-publication.md) §3 (the `derived_from` gap this ADR closes the identity half of); [docs/GLOSSARY.md](../GLOSSARY.md) (`artifact` is already vocabulary: "the immutable built thing identified by digest" — this ADR gives that vocabulary a graph row).

## Context

An artifact's identity is scattered. `coordination/artifact-facts.ts` — the one module every reader of a change's artifact facts is required to go through (`ociDigestsOfSourceRef`, `artifactSetOfSourceRef`, the managed-scan step's digest normalization, the gate orchestrator's control-context digest) — exists **because** that identity has no row of its own: it lives as `sourceRef.artifact_digest` / `artifactDigest` keys on a `changes` row, as the typed `artifacts[]` array inside a cosign-signed `PromotionManifestSchema` (`packages/schemas/src/federation.ts`), and as digest-bound `control_runs` evidence a scan step writes against a `changes.id`, never against the artifact itself. Three readers, three shapes, one underlying fact, reassembled at read time by convention rather than stated once as data. Two concrete gaps this scattering produces:

- **The version staircase** (component-pipeline.ts's per-stage `version`, Phase 4a) can say what was *observed* deployed at a stage, but nothing lets a client ask "what else is true of this exact digest" — which SBOM covers it, which scans passed it, which promotions carried it — without re-deriving the join from a change every time.
- **The machine-image `derived_from` gap** (machine-image-publication.md §3): a destination-modified image (bake in air-gap-local crypto, register an AMI) is a **different artifact with a different digest**, and "this AMI was deployed — what did the commander attest to?" has no answer, because there is no derivative-side row to hang a `derived_from` edge off of. The base half of that chain is a promoted, commander-signed digest; the derivative half is destination-local; today **neither** is a graph object.

Both gaps have the same shape: an artifact needs to be an addressable *thing*, not a string reassembled from three other things' properties, before a relationship (or a UI surface, or a future publication feature) can be built on top of it.

## Decision

### D1 — Identity: `(org, digest, type)`, `type` an open string, a partial unique index

An `artifact` object's identity is the triple `(orgId, properties.digest, properties.artifactType)`. `artifactType` is `'oci' | 'blob'` **today**, matching `PromotionManifestSchema.artifacts[].type`, but it is declared as an **open string in the registered schema** — no enum — because a closed enum on a federation-open registered type is a fail-closed version-skew hazard the moment a third type (`rpm`, `npm`, machine-image digest kinds already named in the artifact-facts.ts census) needs minting from a site running an older migration set (see D-Mechanism below; this is not a new argument, it is 0081's argument applied to a new type). The identity is enforced by a **partial unique index** on `(org_id, properties->>'digest', properties->>'artifactType') WHERE type_id = 'artifact' AND deleted_at IS NULL` — the same shape 0051 (`placement`) uses for its `(componentId, deploymentTargetId)` pair, for the identical reason: identity that must be uniquely indexed lives in `properties`, because nothing in this schema can index a relationship.

### D2 — Minting point: promotion export (commander) and promotion import (receiver), attested-only

An `artifact` object is minted in exactly two places, both already inside the promotion boundary-crossing machinery:

- **At export**, in `exportPromotionBundle` (`federation/promotion-repo.ts`), **after** the promotion manifest is cosign-signed (Phase 3) — the commander is attesting to this exact digest set, so the mint happens once that attestation is real, not before.
- **At import**, in `importPromotionBundle`'s `applyPromotionImport`, **after** signature and checksum verification both pass — the receiving domain's own anchor for "this digest arrived here, attested".

**Nothing else mints.** A build report, an `observe()` poll, a scan run — none of these creates an `artifact` object. This is deliberate and it is what keeps the population bounded: an artifact object exists **only for digests that were promoted** (attested-only), so there is no unbounded "every image ever built anywhere" table and therefore **no GC problem** — the population is already exactly as large as the promotion history that already exists and is already retained. A future increment that wants build-time minting is a new decision, not an extension of this one; it would need its own answer to the GC question this one avoids by construction.

### D3 — Federation: base artifacts are ordinary objects; destination-minted derivatives are domain-local by construction

A commander-minted (export-side) artifact object is an ordinary federated object — it rides `object_upsert` like any other registered type, exactly as a `placement` or `outpost` does. A **destination-minted derivative** (the machine-image case: bake local crypto, register an AMI, mint a NEW artifact object for the new digest) is created `domainLocal: true` **by construction**, not by a special-cased check — it is minted only at the outpost that produced it, the same way every other destination-originated object in this schema is domain-local by where it was created rather than by a flag someone remembered to set. This needs no new enforcement: ADR-0031's structural exemption already covers it (a domain-local object never journals), and if someone later tries to promote the derivative onward, the existing E6 export gate already refuses it fail-closed until it carries its own passing scan — exactly the machine-image proposal §3.2 precedent (itself reusing ADR-0018's dev-pipeline reasoning). No new gate, no new refusal path, no special case: this decision is "let the existing rules apply," stated so nobody re-derives it as a gap later.

### D4 — Relationship: `derived_from` (artifact → artifact, `many_to_one`); `produced_by` deferred

One relationship type, `derived_from`, `from_types: ['artifact']`, `to_types: ['artifact']`, cardinality `many_to_one` — one derivative names exactly one base (the "from" side singular), a base may be the origin of many derivatives (the "to" side plural). `many_to_one` is already an enforced cardinality (`graph/relationships-repo.ts`'s `assertCardinality`, `SINGULAR_SIDES.many_to_one = { from: true, to: false }` — refuses a second `derived_from` edge out of the same artifact, which is exactly "REFUSES a second base for one derivative"). `produced_by` (artifact → the build/executor run that produced it) is **explicitly deferred** — it answers a different question ("what process made this") than `derived_from` answers ("what artifact is this a modification of"), and nothing in this increment's motivating gaps (the version staircase, machine-image provenance) needs it yet. Naming it here and deferring it is deliberate, so a future increment does not have to re-discover that the two are separate relationships.

### D2a — Amendment (2026-08-26): a D2/D3 collision converges by adoption, never drops

D2 mints a receiver-local anchor at promotion import time; D3 makes that anchor an ordinary
(non-domain-local) object the moment it exists. Put together, those two decisions produce a
collision D2/D3 did not separately anticipate: the **exporter's own** minted row for the identical
`(digest, artifactType)` is *also* ordinary, and reaches the same receiver independently via
ordinary full-scope sync, whenever that receiver syncs at `full` scope (routine, not an edge case).
Two different ids, one identity — `objects_artifact_one_per_digest_type` (0094) refuses the second
row outright, and `federation/import-repo.ts`'s pre-check (built alongside the type-registration
skip-and-record it sits beside) caught this the same way: drop the entry, record it as
`federation.import.entry_dropped`.

That was the wrong steady state. The 0051/0043 skip-and-record precedent is correct for an
*accidental* one-off collision. This one is not accidental — it is **guaranteed** for every
promoted digest that also reaches the peer under full scope — so skip-and-record produced one
dropped entry per promotion per peer **forever**, and the receiver's own anchor never learned the
shared base had arrived.

**The fix, in three parts:**

- **(a) Import-mint only when no object with that identity exists.** Unchanged from D2/D1 as
  written — `mintArtifactObjects`'s upsert-by-identity (`findArtifactByIdentity`, keyed on
  `(digest, artifactType)`) already never mints a second row for an identity this domain already
  holds. Restated here because D2a's fix depends on this invariant continuing to hold exactly as
  D1 specified it.
- **(b) The import-minted anchor carries `mintedBy: 'import'` provenance.** Also unchanged —
  `MintArtifactObjectsOptions.mintedBy` already stamps this at mint time (`federation/promotion-
  repo.ts`'s `applyPromotionImport` call). Restated because D2a's adoption path preserves this
  historical fact rather than overwriting it (see below).
- **(c) The sync import path, for `artifact` identity collisions ONLY, converges by ADOPTION
  instead of skip-and-record.** When an incoming, signature-verified `object_upsert` entry's
  `(digest, artifactType)` already exists locally under a different id, the existing row's
  **authority** (`originDomainId`, `revision`, `provenance`) and **properties** move onto the
  incoming entry's — with one carve-out: `properties.firstPromotedChangeId` (this receiver's own
  local history — "the promotion that first caused this identity to be minted HERE") is preserved,
  never overwritten by convergence, the same rule a plain re-mint already honors. The row's **id and
  urn never change** — every local reference the receiver's own promoted change already holds
  (`sourceRef.artifactDigests`, any `derived_from` edge) keeps resolving. The incoming entry itself
  is then fully consumed by the adoption; it is not additionally applied through the ordinary
  `upsertObjectByUrn` path. Implemented in `graph/artifacts-repo.ts`'s `adoptArtifactIdentity`,
  called from `federation/import-repo.ts`'s `object_upsert` branch in place of the prior
  skip-and-record. Idempotent: a resync or channel replay of an already-adopted (or older-revision)
  entry is a no-op, matching DESIGN §13's "double-import is a no-op" DoD for every other entry kind.

**The alternative considered and rejected: make the import-minted anchor `domainLocal: true`.** A
domain-local object never journals, which looks like it sidesteps the collision entirely. It does
not solve the problem, it relocates it: a domain-local anchor's identity is invisible to every peer
by design (ADR-0031 §2), so the exporter's later-arriving shared copy could never land under the
SAME id, and the receiver would be permanently split between its own local-only anchor and the real
shared artifact the rest of the federation actually references. This ADR's own D3 states plainly
that "this object IS the org's one graph object for this identity, replicated with authority" — a
domain-local anchor breaks exactly that, for every promoted artifact, forever, which is a more
permanent version of the same problem this amendment exists to close, not a fix for it.

This keeps D2 (a receiver anchor exists immediately, before any ordinary sync could possibly have
carried the exporter's copy) and D3 (the base artifact is the commander's, shared) coherent with
each other, with zero permanent drops.

## Mechanism

**Registry rows, not tables** (charter principle 2; the ADR-0026/0051 precedent, applied verbatim). `artifact` is one `INSERT INTO object_types`; `derived_from` is one `INSERT INTO relationship_types`. No new column, no new table, no schema migration beyond the registry rows and the one partial unique index D1 requires. A component's pipeline view, the graph explorer, `traverse`, blast-radius — every generic object/relationship surface this platform already has — gets artifact support for free, the same way `placement` did.

**Federation-open property schema.** `artifact.property_schema` declares `required: ["digest", "artifactType"]`, both plain strings, **no `enum`, no `additionalProperties: false`** — 0081's header rule (`deployment-target`'s `substrate` field, `publishes_to`'s `property_schema`), restated for a new type: this type is journaled (`object_upsert`), Ajv validates on the **receiving** side of federation with no `try`/`catch` around that branch, and a closed schema turns every future property addition, or any peer one migration behind, into a hard abort of the peer's **entire** signed bundle — not just the one entry. `federation/import-repo.ts`'s M25.7-round-2 hardening (`getObjectType` returning undefined for an unregistered type costs one **skipped entry**, recorded, never the whole channel) is the backstop for the type itself being unknown to an older peer; keeping the schema open is what keeps a **known** type's entries from failing for the same reason one row over.

## Consequences

- A component's artifact facts (`artifact-facts.ts`) gain a stable row to eventually point at instead of re-deriving digest identity from three shapes on every read — not built this round (see below), but now possible without a second migration.
- `derived_from` gives the machine-image provenance chain (base digest → destination modification → published AMI) a graph edge to exist on, closing the identity half of machine-image-publication.md §3's gap. Publication itself (registering the AMI, §2 of that proposal) is untouched — still an open owner question, still not this ADR's concern.
- The artifact population stays bounded to promoted digests, permanently, by construction (D2) — no retention policy, no GC pass, no unbounded-growth risk of the shape ADR-0024 (Decision retention) had to build a fix for after the fact.
- A destination-minted derivative is invisible to every peer by the same mechanism every other domain-local object already uses (D3) — no artifact-specific federation rule to keep correct over time.

## What is deliberately NOT built this round

- **No minting from builds or `observe()`.** Only export/import mint (D2). A build-time artifact record is a future decision with its own GC/retention answer to give.
- **No artifact-specific UI.** An artifact object is visible through the generic object/relationship surfaces (graph explorer, `traverse`) this round; a dedicated artifact detail view, a version-staircase projection that reads from `artifact` rows instead of `sourceRef`, and a `derived_from` chain visualization are all out of scope here.
- **No `produced_by`.** Named and deferred (D4).
- **No change to what the commander's signature covers, to E6, or to any existing gate.** This ADR adds a graph fact about identity; it does not touch scanning, signing, or the export/import gates that already exist (ADR-0015, ADR-0020, machine-image-publication.md §3.2).
