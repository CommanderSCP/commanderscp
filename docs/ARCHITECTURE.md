# CommanderSCP — Architecture Diagrams

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | **Approved** — owner sign-off 2026-07-08 |
| **Derives from** | [PROJECT_CHARTER.md](../PROJECT_CHARTER.md) and [DESIGN.md](DESIGN.md) — where a diagram and DESIGN.md disagree, DESIGN.md governs. |

Three views of the same system. Every instance — **commander**, **outpost**, or **retrans** — runs the identical `scpd` image plus PostgreSQL; the differences are configuration (role, enrollment) and which objects the instance is the single-writer authority for. The retrans is a **third first-class instance shape** (deployment profile owner-decided 2026-07-23): the same `scpd` image started in a deliberately slim `role: retrans` profile that sits at a CDS boundary and does exactly three things — **validate the cosign signature** (the commander's promotion-manifest and per-artifact signatures, the transitive proof that scans passed at the commander), **drop** the verified artifacts into the CDS via the destination peer's DeliveryTarget, and **track** the pass-through. It carries the vendored cosign + skopeo binaries and exercises only a relay slice of PostgreSQL (peers/keys, the `bundle_transfers` ledger, Decisions + audit, the imported-promotion reference data, pg-boss); it ships **none** of the outpost stack — no local Gitea/registry, no executor coordination, no deploy machinery, no UI. See DESIGN.md §13, [ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md), and [docs/proposals/airgap-cds-validate-promote.md §13.1](proposals/airgap-cds-validate-promote.md).

## 1. Commander instance (detailed)

![Commander instance](diagrams/commander-instance.svg)

The commander is the Global Coordination Layer (DESIGN.md §13). What this view shows:

- **api / worker split** — one image, two roles: the stateless API tier (AuthN/AuthZ, REST `/v1`, graph queries, plan/apply, webhook ingress, SSE) and the crash-resumable worker tier (Coordination Engine, Governance Engine, watchdog, scheduler, reconciliation loops).
- **Federation Engine, commander side** — builds the outbox-derived, hash-chained sync journal; signs segments and approval attestations with the commander's Ed25519 domain key; serves the journal endpoint outposts pull over mTLS; exports/imports `.scpbundle` files for air-gapped outposts.
- **Authoritative global config** — domain registry, org structure, global policies, release topologies, campaigns/initiatives, control definitions. The commander is the single-writer origin; every outpost holds these as read-only replicas.
- **PostgreSQL as everything** — graph, outbox, pg-boss jobs, Decisions, hash-chained audit, sync journal, role bindings; NATS is the optional high-volume event backend; object storage holds bundles, evidence, and audit anchors.
- **Cross-domain view** — outposts report status upward; the commander UI shows every domain, its sync freshness, in-flight changes, and campaign roll-up. The commander never edits outpost-owned data.
- **Promotion scan step** (owner decision 2026-07-23, [ADR-0020](adr/0020-first-class-commander-scanning.md)) — the commander's promotion process runs **scan → evaluate → sign → export**: the charter-enumerated `scp-managed-scan` launches ephemeral runners from the separate `scp-runner-scan` image, evidence lands commander-resident, and the E6 export gate signs only if scans pass. Not yet drawn in the SVG (see the diagram note below).

## 2. Outpost domain instance (detailed)

![Outpost instance](diagrams/outpost-instance.svg)

An outpost (Commercial, GovCloud, air-gapped, …) is where changes actually get coordinated against execution systems (DESIGN.md §9–§13). What this view shows:

- **Federation inbound** — commander config arrives by mTLS journal pull, `.scpbundle` file, or operator hand-entry (`provenance: manual`, reconciled on the next signed import). Every import verifies Ed25519 signatures, the hash chain, and approval attestations before applying.
- **Change lifecycle** — proposed → evaluated → coordinated → executing → validating → promoted, with cancelled and rolled_back branches; every transition passes through one guarded function that atomically checks gates, writes the audit event, and writes the Decision.
- **Waves and gates** — the plan compiler turns a release topology plus `depends_on` toposort into waves; gates bind required controls at wave boundaries; fan-out/fan-in and canary are wave patterns, not special code.
- **Governance feeding the gates** — CEL policies (global ⊆ stricter local), security scans (Trivy/Snyk/Semgrep/Grype), quality and operational controls, CAB/ticket via webhook-control, N-of-M approvals with Ed25519 attestations, freezes with audited overrides.
- **Rollback** — a first-class Change through the same wave machinery, triggered automatically (gate/control failure, canary threshold, health check, policy violation) or manually, returning to the prior revision / artifact digest / IaC state ref.
- **Plugin host and integrations** — every plugin in its own subprocess; GitHub App (webhooks + polling + discovery), Argo CD, Terraform Mode 1 (pipeline-mediated), and the managed-iac Mode 2 orchestrator, which launches ephemeral containers from the separate `scp-runner-iac` image (the charter's Managed Execution Exception — highlighted in red).
- **Federation outbound** — local status, changes, and audit segments signed with the outpost's key and returned to the commander by mTLS or bundle file.

## 3. Multi-domain overview

![Multi-domain overview](diagrams/multi-domain-overview.svg)

The hub-and-spoke reference topology (DESIGN.md §13). What this view shows:

- **Commander at the hub** — global config flows down as read-only replicas; status and audit flow up; the air-gapped spoke exchanges the same signed artifacts as files over removable media.
- **Three outposts, one machinery** — connected Commercial, stricter GovCloud/FedRAMP, and a fully disconnected air-gapped domain all run the same image with the same engines; only policy strictness and transport differ. Every domain is fully operational when disconnected.
- **Federated promotion** — Commercial → GovCloud → Air-gapped is a release topology whose waves are domains. A Promotion Bundle carries the change, provenance, control evidence, artifact digests, and per-approval Ed25519 attestations; each importing domain verifies signatures and attestations, instantiates its own local change, and re-gates under its own policies. **Approvals transfer as evidence, never authority.**
- **Retrans at the CDS boundary** — between domains separated by a cross-domain solution sits the third instance shape (see the intro): a slim `role: retrans` relay that validates the commander's cosign signatures (never re-scanning — the signature is the transitive, non-decaying proof of scan-pass at the commander), drops verified artifacts into the CDS via the destination peer's DeliveryTarget, and records the pass-through in `bundle_transfers`. It never originates config, holds no local authoritative objects, and never terminates a promotion ([ADR-0004](adr/0004-service-naming-commander-outpost-retrans.md)); the receiving outpost still runs its full M17.4 verification, unweakened. Not yet drawn in the SVG (see the diagram note below).

## Conventions used in all three diagrams

- **Solid teal lines** — connected sync (mTLS HTTPS journal pull). **Dashed teal** — air-gap file transfer (`.scpbundle`). **Dotted gray** — manual entry.
- **Red** — rollback paths and the managed-execution exception. **Yellow** — gates and governance. **Green** — data stores. **Orange** — plugin host. **Teal** — federation and signing.
- Every export is Ed25519-signed and hash-chained; every import is verified before apply.

Diagrams are hand-maintained SVG in [diagrams/](diagrams/); update them alongside any DESIGN.md change that alters what they depict.

> **Diagram deferral note (2026-07-23).** The SVGs do not yet depict the two 2026-07-23 evolutions described above: the **retrans node** (third instance shape, multi-domain overview) and the **commander promotion-scan step** ([ADR-0020](adr/0020-first-class-commander-scanning.md), commander view). The diagram updates are deliberately not redrawn in the docs PR that records the decisions; they are part of **M13.1's definition of done** (BUILD_AND_TEST.md §8, M13.1) so the deferral is tracked, not silent.
