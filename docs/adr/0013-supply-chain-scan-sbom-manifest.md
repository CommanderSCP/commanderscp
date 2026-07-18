# ADR-0013: Supply chain — scan as a boundary-authorization gate, build-time SBOM, and a signed promotion manifest

**Status:** Proposed (2026-07-18)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0011](0011-universal-outpost-validation.md) (validation); [ADR-0012](0012-registry-consolidation.md) (scanning as a step); [ADR-0010](0010-outpost-local-artifact-infra.md) (trust scan-at-source)

## Context

Artifacts that cross a trust boundary into an outpost must be authorized and verifiable. We settled the mechanics with the owner (2026-07-18):

- Scanning exists **to authorize cross-boundary transfer** — it is not a general code-quality gate. That is why domain-locally-originated artifacts (which never cross a boundary) are not scanned, and why outposts stay light (they don't re-scan; they trust scan-at-source).
- The receiving side must be able to prove that **exactly** the artifacts that were signed at the source are the ones that arrived — nothing added or substituted in transit.

## Decision

Source-side, for **commander-tracked** artifacts only:

1. **Scan** with a coordinated **Trivy step** (Argo Workflows, ADR-0012); the verdict is made available to the commander as **gate evidence**. Scan is a **boundary-crossing authorization gate**.
2. **SBOM** is generated at **build time** (same Trivy pass — richest component inventory).
3. **Signed promotion manifest**: the commander uses **cosign** to sign an enumeration of exactly the authorized artifact set (digests) — the artifact(s), the SBOM, and the manifest. Signing happens **only if scans pass**.

Receiver-side, at **every hop** (retrans before crossing the CDS, outpost before deploy — ADR-0011): verify the commander's signature **and** that the arrived artifact set matches the signed manifest exactly — the **"nothing slipped in"** guarantee. No re-scan (trust scan-at-source); verification is signature + manifest/digest match, not SBOM re-derivation.

## Consequences

**Positive**
- One Trivy pass yields both scan verdict and SBOM; cosign already exists (M4/M6/M8).
- The signed manifest closes the "extra artifact injected in transit" hole with a lightweight check (signature + set match), consistent with "trust scan-at-source, no re-scan."
- Framing scanning as a *boundary-authorization* gate cleanly explains why domain-local artifacts are exempt and why outposts don't scan.

**Costs / scope**
- **New capability** — no scan-result ingestion, SBOM generation, or manifest signing/verification is wired today (grounding: scanning is observe-only-aspirational). Lands as **M17**.
- Domain-specific outpost-originated artifacts get **no scan/SBOM/manifest** by design (they don't cross a boundary) — an accepted tradeoff, and it keeps outposts light.
