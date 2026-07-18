# Proposal: Federation / Outposts UI + Universal Boundary Pipeline Stages

**Status:** Proposed — pending review (2026-07-18)
**Relates to:** `coordination-ui-views.md` (the pipeline/board/graph views); poke-mode (M14, [ADR-0009](../adr/0009-optional-poke-mode-federation.md)); local-infra (M15, [ADR-0010](../adr/0010-outpost-local-artifact-infra.md)); observe-enrichment ([ADR-0008](../adr/0008-observe-enrichment-signals.md)); [ADR-0011](../adr/0011-universal-outpost-validation.md) (this decision); DESIGN.md §13
**Milestone:** M16 (provisional — federation UI track)

## Motivation

Two related gaps in the UI's federation story:

1. There is **no place to see or manage the outposts** the commander syncs with — their status, settings, or per-outpost configuration. As we add per-outpost config (poke-mode M14; local Gitea registry M15; freeze windows; enabled bundled backends), there is nowhere it converges.
2. The component-pipeline view stops at the executor stages; it doesn't show the **boundary crossing** — when a change is transferred to the outpost that will deploy it, and when that outpost validates the signed artifact/config before deploying.

## Part A — Outposts management UI

A top-level **Outposts** nav section (covering both `outpost` and `retrans` roles). **Build approach (owner decision, 2026-07-18): all at once** — overview + settings + configuration as one cohesive unit. Because it surfaces per-outpost config, it **lands after M14 (poke) and M15 (local-infra)** build the surfaces it manages.

- **Overview** — a dashboard of every enrolled outpost/retrans: role, **trust tier** (commercial / FedRAMP High / IL5 / air-gap), **connectivity** (connected vs air-gap), **last-sync** — honoring DESIGN §13's rule that air-gap outposts are labeled *"as of ⟨bundle/date⟩"*, never shown as live — plus sync health, pending-transfer count, and the health rollup from observe-enrichment increment 5.
- **Per-outpost → Settings** — enrollment/identity/transport: peer identity, mTLS cert, trust tier, transport mode (connected mTLS vs air-gap bundle).
- **Per-outpost → Configuration** — the commander-origin operational policy that **syncs down**: poke-mode toggle (M14), local Gitea registry create/import (M15; Harbor optional per [ADR-0012](../adr/0012-registry-consolidation.md)), freeze windows, enabled bundled backends.
- **Commander-origin, read-only-downstream.** Because outposts hold commander config read-only, all editing happens here at the commander and propagates via the federation journal/bundle; air-gap edits ride the next bundle, so the UI shows **pending-vs-applied**, never pretending an air-gap change is instant.

## Part B — Universal boundary pipeline stages

Extend the component pipeline with a **boundary segment** that is **always shown** on every change:

```
code → build → image repo → config → ⟨ transfer → validate signatures ⟩ → deploy (gamma → prod)
```

- **Transferred to outpost** — the change/artifact reference crossing to the outpost that will deploy it (observable via the existing bundle transfer tracking: export → *submitted* → *confirmed*, DESIGN §13; promotion bundle).
- **Signatures validated** — the receiving outpost verifying the **cosign signature + scan attestation** (trust-scan-at-source, M15.2) before deploy.

**Always shown for cross-boundary changes (owner decision, 2026-07-18).** A change cannot reach an outpost without being validated. Deployment always terminates at an outpost, and the receiving outpost always validates the signed artifact/config before deploying — **including commercial**. The only thing that differs by trust tier is *who owns the git/image repos* (commander-owned in commercial; outpost-local in high/air-gap, M15), **not whether validation happens** (see [ADR-0011](../adr/0011-universal-outpost-validation.md)).

**Exception — domain-local changes have a shorter pipeline.** Domain-specific config/infra that *originates* on the outpost (outpost-owned, [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) ownership model) never crosses a boundary, so it has no transfer/validate stage. And where the change *does* cross a CDS, **validation runs at full strength at every hop** — the retrans validates before crossing, the outpost re-validates before deploy ([ADR-0011](../adr/0011-universal-outpost-validation.md)).

This is Layer-B observe-enrichment (ADR-0008) applied to the **federation boundary** rather than an executor — SCP observes and records the transfer + validation events and renders them as stages, driving nothing.

### Built vs. aspirational (honest)

- **Transfer:** bundle transfer tracking (export → submitted → confirmed) exists in the federation model; surfacing it per-change in the pipeline is new view + a per-change transfer status.
- **Validation:** bundle-level signature/hash-chain validation is built (fail-closed import); **per-artifact cosign + scan-attestation verification before deploy is M15.2 (partly aspirational)** — the stage renders what's observed and an explicit "not yet verified" state otherwise, never a fabricated pass.

## Part C — the outpost's own local UI

Because CommanderSCP is **one binary** (commander/outpost/retrans are runtime roles), an outpost already serves the full UI. Scoped to its local domain, that gives service/component/graph views for the **domain-specific pipelines the commander does not track** ([ADR-0010](../adr/0010-outpost-local-artifact-infra.md) ownership model). This is the mirror image of Part A: Part A is the *commander looking out* at its outposts; Part C is an *outpost looking at its own* domain. Same view components, locally scoped — largely free once the views exist. (Owner ask, 2026-07-18.)

## Invariants

- **Coordinate-not-execute.** Validation is a gate/control the outpost performs; SCP observes and records it — it drives no deployment.
- **Graph-native.** Outpost config is commander-origin graph data synced down; transfer/validation status is observe-enrichment on the change/wave-target, not new top-level concepts.
- **Air-gap first-class.** The Overview's "as of ⟨bundle⟩" labeling and the boundary segment both make the air-gap reality visible rather than hiding it.
- **Explainability.** A validation stage reflects a persisted verification outcome (Decision), like any engine verdict.

## Milestone scope (M16)

- **M16.1 — Universal boundary stages** (can land sooner; tied to observe-enrichment): always-shown *transferred → validated* segment in the component pipeline, from real transfer + validation observations; explicit "not-yet-verified" state, no fabrication.
- **M16.2 — Outposts UI, all-at-once** (lands after M14 + M15): Overview + per-outpost Settings + Configuration; commander-origin editing that syncs down; air-gap pending-vs-applied; API→SDK→CLI→UI parity (a federation/outpost read + config API the UI consumes only through the SDK).

## Open decisions (for review)

1. **Nav naming:** "Outposts" (covers outpost + retrans) vs "Federation". I lean **Outposts** (matches ADR-0004 role names; "Federation" reads as a mechanism, not a place).
2. **M16.1 vs M16.2 sequencing:** land the boundary stages (M16.1) before the full Outposts UI (M16.2), since M16.1 doesn't depend on M14/M15 — or hold both until M14/M15 land and ship together.

## Non-goals

- No new drive/deploy capability — Part B observes the boundary, it doesn't move bytes or trigger validation.
- The Outposts UI edits commander-origin config only; it does not reach into an outpost directly (that would violate the federation data-direction invariant, cf. ADR-0009).
