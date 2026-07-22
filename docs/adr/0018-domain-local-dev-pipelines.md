# ADR-0018: Domain-local dev/beta pipelines are scan-exempt by path, backstopped by the export-time gate

**Status:** Accepted (owner-decided 2026-07-20 — "for the very end")
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (scan is a *boundary-crossing* authorization gate — the domain-local case is exempt because it never crosses); [ADR-0016](0016-scoped-scan-requirement-policies.md) ("local" origin discriminator on the instance-scoped floor); [ADR-0008](0008-observe-enrichment-signals.md) (SCP *observes* deploy weight, never sets it); [ADR-0011](0011-universal-outpost-validation.md) (validation applies to cross-boundary changes only); [ADR-0017](0017-ownership-refinement.md) (the commander's export-time gate — E6 — is the backstop); charter principle 1 (coordinate, not execute)

## Context

The owner wants domain-local **dev/beta pipelines** — a late ("for the very end") capability: an engineer iterates
on a change inside a single domain, deploying to a dev/beta target, **without** the cross-boundary supply-chain
gate (scan + SBOM + manifest sign/verify) applying. The question is how to express "dev is exempt" **without**
opening a hole that a real, boundary-crossing artifact could slip through.

The structural facts that make this safe already exist and must not be contradicted:

- **A "pipeline" is not a first-class object.** It is an emergent shape: a component + a routing Type +
  an `executor_binding`. There is nothing to tag "dev" on as an enforcement primitive.
- **The only cross-boundary egress is `exportPromotionBundle`** (`apps/server/src/federation/promotion-repo.ts`),
  which **requires a federation peer**. A domain-local change targets **no peer**, so it **never reaches export**.
- **Scanning is a *boundary-crossing authorization* gate, not a general quality gate**
  ([ADR-0013](0013-supply-chain-scan-sbom-manifest.md)). It exists to authorize a *crossing*. A change that never
  crosses has nothing for the gate to authorize — the gate **structurally never applies**, exactly as
  domain-locally-originated artifacts are already exempt.
- **The export-time gate (M17.3 E6, [ADR-0017](0017-ownership-refinement.md)) is fail-closed and universal.** If
  a digest is later promoted across a boundary, `exportPromotionBundle` **hard-refuses** it unless a passing,
  **digest-bound** scan exists for that exact digest — a **missing** scan refuses exactly like a **failed** one,
  whether or not any scan-requirement policy was bound (M17.3 E6, #103). Export **re-verifies at the crossing**;
  it never runs a scanner.
- **Deploy weight is observed, not set.** A dev rollout's 10%/100% is the dev's **Argo Rollout spec**; SCP
  **observes** the weight ([ADR-0008](0008-observe-enrichment-signals.md) decision 3) and **never sets** it —
  consistent with coordinate-not-execute.

## Decision

**Domain-local dev/beta pipelines are scan-exempt because they are the [ADR-0013](0013-supply-chain-scan-sbom-manifest.md)
domain-local case — and the exemption is a property of the *path*, not of the artifact.**

### 1. The exemption keys on origin-domain-locality (a path property), never on a per-artifact tag

A dev change is exempt **because of where it goes**, not because of a label it carries:

- A domain-local dev change **targets no federation peer**, so it **never enters `exportPromotionBundle`**, so the
  cross-boundary scan gate **structurally never runs**. This is the same reason domain-locally-originated
  artifacts are already exempt ([ADR-0013](0013-supply-chain-scan-sbom-manifest.md), §"Context"): no crossing,
  nothing to authorize.
- The exemption therefore keys on **origin-domain-locality — a property of the change's *path*** (does this path
  reach a cross-boundary export?), **not** a per-artifact `dev` bit that travels with the digest. There is no
  "skip-scan" flag on an artifact, and none is introduced. This matters because a per-artifact bypass would be a
  bit that could be lifted onto a boundary-crossing artifact; a path property cannot be — the same digest
  promoted across a boundary takes a different path and hits the gate.

### 2. The leakage guarantee is E6 plus the absence of a local-deploy→export path

Two independent facts, together, close the hole:

- **E6 is the backstop for "dev digest promoted later."** If a digest built and deployed in a dev pipeline is
  *later* promoted across a boundary, the export-time gate ([ADR-0017](0017-ownership-refinement.md) §2, M17.3
  E6) **hard-refuses** it unless a passing, digest-bound scan exists for that digest. The dev digest is **scanned
  at the crossing's gate** (its scan evidence is re-verified there), **not exempted** — the exemption never
  followed the artifact, only the local path.
- **No local-deploy path reaches the export.** A domain-local deploy terminates inside the domain (dev/beta
  target); it has no step that calls `exportPromotionBundle`. So a dev change cannot *accidentally* cross: to
  cross it must be explicitly promoted to a peer, which routes it straight into the E6 gate.

The exemption is thus **safe by construction**: it is the absence of a crossing (path), backstopped by a
fail-closed gate at the only crossing that exists (E6). It is **not** a per-artifact bypass.

### 3. Deploy percentage (10% / 100%) is the dev's Argo Rollout spec — SCP observes, never sets

A dev/beta pipeline's progressive rollout weight is the **dev team's own Argo Rollout spec**. SCP **observes** the
weight as an enrichment signal ([ADR-0008](0008-observe-enrichment-signals.md) decision 3) and renders it; it
**never sets or drives** the weight. Coordinate-not-execute holds unamended — the dev pipeline is a coordinated
execution system like any other.

### 4. Optional operator labeling is descriptive only — NOT a new enforcement path

An operator **may** classify a target — e.g. a `deploymentTarget` `classification='dev'`, or the
[ADR-0016](0016-scoped-scan-requirement-policies.md) `origin='local'` discriminator — for **UI/reporting**
legibility (so a dev pipeline reads as "dev" in the pipeline view). This is **labeling only**. It is **not** an
enforcement input: it does **not** grant a scan exemption, and removing or forging it does **not** let a
boundary-crossing artifact skip the gate. Enforcement keys **solely** on the path (does it reach a cross-boundary
export → E6), never on the label. Stated explicitly so no future reader mistakes the label for a bypass switch.

## Charter alignment

- **Coordinate, not execute (principle 1):** OK — dev pipelines are coordinated execution systems; SCP observes
  rollout weight (never sets it) and runs no dev build/deploy itself.
- **Explainability (principle 6):** unchanged — a dev change that is later promoted and refused at E6 persists a
  block Decision + hash-chained audit event (M17.3 E6), so "why was my dev digest refused at the boundary?" is
  answerable.
- **Simplicity / Extensibility (priority order):** the exemption adds **no** new enforcement primitive — it is the
  existing "no crossing ⇒ no gate" property, named. Optional labeling is additive and inert.

## Alternatives considered

- **A per-artifact `dev`/`skip-scan` tag (rejected).** A bit that travels with the digest could be lifted onto a
  boundary-crossing artifact, turning an exemption into a bypass. The path-property framing has no such failure
  mode: promoting the same digest across a boundary takes a different path straight into E6.
- **A first-class "dev pipeline" object with its own exemption rules (rejected).** A pipeline is not a
  first-class object (component + Type + binding); inventing one to carry an exemption is new machinery for a
  property that already falls out of "no crossing ⇒ no gate" (principle: Simplicity).
- **Make the operator `classification='dev'` label the enforcement switch (rejected).** That would make a
  descriptive label a security-relevant input — forgeable, and divergent from the actual guarantee (the path).
  The label stays inert; the path enforces.
- **Relax E6 for dev-originated digests (rejected).** E6's fail-closed, missing-equals-failed universality is the
  backstop; carving a dev exception into it re-opens the hole this ADR closes.

## Consequences

**Positive**
- Domain-local dev/beta pipelines skip the cross-boundary supply-chain gate with **zero new enforcement code** —
  it is the existing domain-local exemption, and the guarantee is the existing fail-closed E6 gate.
- A dev digest that is later promoted is **scanned at the crossing**, not grandfathered — the exemption cannot
  leak across a boundary because it never attached to the artifact.
- Optional `dev` labeling gives the pipeline view legibility without becoming a bypass surface.

**Costs / honesty**
- This is a **late** milestone ("for the very end" — BUILD_AND_TEST §8, M18) and depends on nothing in M17; it is
  primarily a documentation of an existing structural property plus optional labeling + a leakage test.
- The safety argument rests on **`exportPromotionBundle` remaining the only cross-boundary egress** and **E6
  remaining fail-closed**. If a future feature adds another egress, it must carry the same digest-bound scan gate
  or this exemption's backstop weakens — a standing invariant to check when adding any cross-boundary path.
- The optional `classification='dev'` / `origin='local'` label must be covered by a test proving it is **inert**
  for enforcement (forging/removing it changes no gate outcome).
