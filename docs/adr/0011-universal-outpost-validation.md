# ADR-0011: Signature validation at the receiving outpost is a universal pre-deploy gate

**Status:** Accepted (2026-07-18; M15.2 + M17.4(a) shipped, status flipped 2026-07-24)
**Context doc:** [docs/proposals/federation-outposts-ui.md](../proposals/federation-outposts-ui.md)
**Relates to:** [ADR-0010](0010-outpost-local-artifact-infra.md) (trust scan-at-source); [ADR-0004](0004-service-naming-commander-outpost-retrans.md); [ADR-0012](0012-registry-consolidation.md) (outpost = Gitea-only); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md) (what is validated); DESIGN.md §13

## Refinement 2026-07-18 (two clarifications from the owner)

1. **"Universal" means universal for *cross-boundary* artifacts.** Domain-locally-originated artifacts (outpost-owned domain-specific config/infra — [ADR-0010](0010-outpost-local-artifact-infra.md), ownership model) **never cross a boundary**, so they have **no transfer stage and nothing to validate** — a shorter pipeline. The "always-shown boundary stages" (M16.1) and this gate apply to changes that cross *into* a domain, not to ones already home.
2. **Full validation at *every* hop.** A **retrans** performs the **same full validation** (signature + SBOM/manifest, ADR-0013) **before** letting anything cross the CDS — nothing invalid enters the air-gapped domain in the first place — and the **outpost re-validates inside the domain before deploy**. Not a lighter bundle-integrity check at the retrans; the same level at each hop (defense in depth).

## Context

Designing the component-pipeline "transferred to outpost" + "signatures validated" stages raised the question of *when* they apply. The initial framing treated them as conditional — only for changes that cross into a high/air-gap outpost.

The owner corrected this (2026-07-18): **a change cannot reach an outpost without being validated.** Deployment always terminates *at an outpost* (the per-environment/trust/geo instance that fronts the deploy target), and the receiving outpost always validates the signed artifact/config before it deploys. This holds in **commercial** too: there, the commander owns the git and image repos, but the artifact/config still must move to the outpost for the actual deployment, and the outpost still validates signatures first.

What differs by trust tier is **who owns the git/image repos** — commander-owned in commercial; **outpost-local** (the outpost's own Gitea registry — Harbor optional, [ADR-0012](0012-registry-consolidation.md)) in FedRAMP-High / IL5 / air-gap (M15) — **not whether validation occurs**.

## Decision

Treat **signature (+ scan-attestation) validation at the receiving outpost as a universal pre-deploy gate**: every deployment, in every trust tier, is mediated by the outpost that will deploy it, and that outpost validates the signed artifact/config before deploying. This generalizes M15's *trust-scan-at-source* (ADR-0010) from high/air-gap to **all** outposts.

Consequences for the UI: the component pipeline's *transferred → validated* boundary segment is **always shown** on every change (never conditional). It is Layer-B observe-enrichment on the federation boundary — SCP **observes and records** the transfer + validation outcomes and renders them; it drives nothing (coordinate-not-execute).

## Consequences

**Positive**
- A single, consistent deployment model: source (commander-owned or outpost-local) → transfer to the deploying outpost → **validate** → deploy. No special-casing high/air-gap in the pipeline view.
- Makes the trust boundary and its verification legible in every pipeline, reinforcing the air-gap-first and explainability principles.
- Cleanly frames M15 (the outpost's local Gitea registry) as a change of *repo ownership/location*, not a change of *whether validation happens*.

**Costs / honesty**
- **Per-artifact cosign + scan-attestation verification before deploy is only partly built** — bundle-level signature/hash-chain validation exists (fail-closed import); the per-artifact pre-deploy verification is M15.2 (partly aspirational) *(the cosign-verify step itself lands at **M17.4** — [ADR-0015 §6](0015-cosign-cross-boundary-signing.md))*. The UI must render an explicit "not-yet-verified" state rather than a fabricated pass until it lands.
- Asserting "deployment always terminates at an outpost" is a **model statement**: a non-federated single-instance install is its own commander+outpost; the universal-gate framing must degrade gracefully there (the validating party is the local instance).

## Alternatives considered

- **Conditional stages (high/air-gap only).** Rejected per the owner: it misrepresents commercial, where validation also happens; it would also make the pipeline view's stage set inconsistent across changes.
