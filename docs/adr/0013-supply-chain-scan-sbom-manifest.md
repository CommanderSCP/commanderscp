# ADR-0013: Supply chain — scan as a boundary-authorization gate, build-time SBOM, and a signed promotion manifest

**Status:** Proposed (2026-07-18) — **corrected 2026-07-19 and again 2026-07-20** (see note below)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0011](0011-universal-outpost-validation.md) (validation); [ADR-0012](0012-registry-consolidation.md) (scanning as a step); [ADR-0010](0010-outpost-local-artifact-infra.md) (trust scan-at-source); [ADR-0015](0015-cosign-cross-boundary-signing.md) (**the cosign signing mechanism this ADR relies on — NEW, not pre-existing**); [ADR-0016](0016-scoped-scan-requirement-policies.md) (scoped scan pass-criteria)

> **Evolution note (2026-07-23, [ADR-0020](0020-first-class-commander-scanning.md)):** the scan **location** is evolved — the first-class evidence producer is now the commander's promotion scan step (`scp-managed-scan`, scan-before-sign at the commander), and the coordinated org-pipeline Trivy step described below becomes the supported **alternate** ingress. Everything else here stands: scan as boundary authorization (not a quality gate), never-re-scan downstream, the who-signs-what split, and the gates consuming evidence unchanged.

## Correction notes

### 2026-07-20 — who signs what, and cosign is not vendored

Two claims survived the 2026-07-19 pass and are corrected in the Decision/Consequences text below:

1. **Actor.** Decision item 3 still read "the commander uses cosign … to sign … the artifact(s), the SBOM, and the manifest" — i.e. the commander signing origin artifacts, which contradicts [ADR-0015 §5](0015-cosign-cross-boundary-signing.md) and charter principle 1. Corrected: the **executor** signs the artifact(s) **and** the build-time SBOM at build; the **commander** signs **only** its own promotion manifest.
2. **"cosign is already vendored" is false.** It is an operator-supplied prerequisite on `PATH` (`deploy/airgap/README.md:51`, `BUILD_AND_TEST.md:35`), installed unpinned in CI, and absent from `deploy/helm-bundled/vendor/`. What is proven is the **keyful/offline flag behaviour**, not vendoring. A runtime sign/verify path must vendor a pinned binary — see ADR-0015 Consequences.

### 2026-07-19 — cosign is new work, not M4/M6/M8

This ADR originally claimed cosign already existed from M4/M6/M8 and that the commander already used cosign to sign digests. **That is factually wrong.** M4/M6/M8 built **Ed25519** runtime signing (`node:crypto`: `governance/attestation.ts`, `federation-journal.ts`), **not** cosign. The only cosign in the tree today is release-only (`deploy/airgap/src/cosign.ts`, air-gap bundle signing). Signing cross-boundary artifacts + the promotion manifest with cosign is **new work**, decided in [ADR-0015](0015-cosign-cross-boundary-signing.md) (owner, 2026-07-19). The Decision/Consequences text below is updated to point at ADR-0015; the scan gate's scoped pass-criteria is [ADR-0016](0016-scoped-scan-requirement-policies.md).

## Context

Artifacts that cross a trust boundary into an outpost must be authorized and verifiable. We settled the mechanics with the owner (2026-07-18):

- Scanning exists **to authorize cross-boundary transfer** — it is not a general code-quality gate. That is why domain-locally-originated artifacts (which never cross a boundary) are not scanned, and why outposts stay light (they don't re-scan; they trust scan-at-source).
- The receiving side must be able to prove that **exactly** the artifacts that were signed at the source are the ones that arrived — nothing added or substituted in transit.

## Decision

Source-side, for **commander-tracked** artifacts only:

1. **Scan** with a coordinated **Trivy step** (Argo Workflows, ADR-0012); the verdict is made available to the commander as **gate evidence**. Scan is a **boundary-crossing authorization gate**.
2. **SBOM** is generated at **build time** (same Trivy pass — richest component inventory).
3. **cosign signing, with the actors split** — the **new** cross-boundary signing layer decided in [ADR-0015](0015-cosign-cross-boundary-signing.md), **not** the pre-existing Ed25519 federation-transport layer:
   - the **EXECUTOR** cosign-signs **the artifact(s) and the build-time SBOM at build**, in the build system, with the build system's credentials (the SBOM is an output of the executor's Trivy pass);
   - the **COMMANDER** cosign-signs **only its own promotion manifest** — an enumeration of exactly the authorized artifact set (digests + origin `signatureRef`s).

   **SCP never cosign-signs an origin artifact, including the SBOM** — see [ADR-0015 §5](0015-cosign-cross-boundary-signing.md). Signing happens **only if scans pass**. (Ed25519 stays in place for the federation bundle envelope / journal / attestations; cosign is the additive supply-chain layer — see ADR-0015 §1.)

Receiver-side, at **every hop** (retrans before crossing the CDS — *target model, retrans is unbuilt today*; outpost before deploy — ADR-0011): verify the **commander's manifest signature** **and** that the arrived artifact set matches the signed manifest exactly — the **"nothing slipped in"** guarantee. No re-scan (trust scan-at-source); verification is signature + manifest/digest match, not SBOM re-derivation. **Per-artifact** `cosign verify` against each artifact's **origin** signature is a separate step that happens where the artifact **bytes** land, not at metadata-bundle import — see the split in [ADR-0015 §6](0015-cosign-cross-boundary-signing.md).

## Consequences

**Positive**
- One Trivy pass yields both scan verdict and SBOM. Signing reuses the **proven keyful/offline flag behaviour** of the release-path wrapper (`deploy/airgap/src/cosign.ts`) — cosign is **already used on the release path (operator-supplied on `PATH`, unpinned by design), not vendored**; a runtime sign/verify path must vendor a pinned binary (ADR-0015 Consequences) — and applying it to cross-boundary artifacts + the manifest is **new work** ([ADR-0015](0015-cosign-cross-boundary-signing.md)), **not** a pre-existing M4/M6/M8 capability (that was Ed25519).
- The signed manifest closes the "extra artifact injected in transit" hole with a lightweight check (signature + set match), consistent with "trust scan-at-source, no re-scan."
- Framing scanning as a *boundary-authorization* gate cleanly explains why domain-local artifacts are exempt and why outposts don't scan.

**Costs / scope**
- **New capability** — no scan-result ingestion, SBOM generation, or manifest signing/verification is wired today (grounding: scanning is observe-only-aspirational). Lands as **M17**.
- Domain-specific outpost-originated artifacts get **no scan/SBOM/manifest** by design (they don't cross a boundary) — an accepted tradeoff, and it keeps outposts light.
