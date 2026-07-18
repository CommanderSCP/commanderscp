# Proposal: End-to-End Promotion & Execution Model

**Status:** Proposed — pending review (2026-07-18)
**Role:** Master synthesis of the change→build→supply-chain→promotion→validation→deploy flow settled with the owner on 2026-07-18. It ties together and is authoritative over the per-topic ADRs it references.
**Relates to:** [ADR-0009](../adr/0009-optional-poke-mode-federation.md) (poke), [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) (outpost local infra), [ADR-0011](../adr/0011-universal-outpost-validation.md) (validation), [ADR-0012](../adr/0012-registry-consolidation.md) (registry), [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (supply chain); proposals `bundled-executor-backends.md`, `outpost-local-artifact-infra.md`, `federation-outposts-ui.md`, `managed-execution-tier.md`, `execution-strategy.md`; DESIGN.md §12–§13.

## 0. The invariant that governs everything

CommanderSCP **coordinates** execution systems; it does not build, test, scan, sign, or deploy *itself*. Every stage below runs on a coordinated execution system (bundled or BYO), and SCP triggers/observes/gates it and consumes results as evidence. There are exactly **two** scoped execution exceptions, both pre-authorized:

- **`scp-managed-iac`** — trivial IaC releases for pipeline-less orgs, ephemeral containers, `--network none` except cloud APIs, vaulted scoped creds (charter, 2026-07-08).
- **`scp-runner-ops`** (proposed) — host-reaching Ansible from a closed, cosign-signed task catalog (OS package install/upgrade/pin, config/template push, systemd/cron; never arbitrary shell), holding host login creds behind hard preconditions — SSTI/Jinja closure, SSH-CA blast-radius analysis (charter amendment, 2026-07-12; `managed-execution-tier.md`).

## 1. Execution map (what runs each stage)

| Stage | Mechanism | Notes |
|---|---|---|
| **build + test** (any artifact: image, rpm, npm, deb, …) | **Argo Workflows** (bundled, M11.3) | Generic containerized-step engine — tool-agnostic. Images use Kaniko/Buildkit; packages just run their toolchain. BYO CI (GitHub Actions / GitLab) coordinated instead where present. SCP never runs CI. |
| **scan + SBOM** | **coordinated Trivy step** (in Argo Workflows) | One pass emits both the vulnerability scan and the SBOM. Results made available to the commander as **gate evidence** — not a registry feature (see §4, ADR-0013). |
| **store** — **images** (OCI), **code** (git), **packages** (rpm/npm/Maven/Helm/…) | **Gitea unified registry** (default) — the image repo, code repo, **and** package repo in one service | Harbor is **not bundled**; an org that wants Harbor coordinates its **existing** one via the import path (ADR-0012, M15.3). |
| **sign** | **cosign** | Signs the artifact, the SBOM, and the promotion manifest (M4/M6/M8). |
| **deploy → Kubernetes** (image workloads **and** non-image k8s config: Helm, CRDs, operators, ConfigMaps, NetworkPolicy) | **Argo CD** (bundled, M11.2) | GitOps. |
| **deploy → hosts/VMs** (rpm/npm install, config files, systemd) | **Ansible** via **`scp-runner-ops`** (behind the scenes) / BYO Ansible-Tower/Salt | Argo CD is k8s-only and cannot reach a host. Most sensitive execution class in the system. |
| **provision → cloud infra** (Terraform / OpenTofu / CDK / CDKTF / Pulumi) | **Argo Workflows** plan→gate→apply, or **`scp-managed-iac`** | SCP gates the *plan*; cloud creds live in the workflow env, not SCP. Not Argo CD (it cannot natively run IaC; Crossplane/tf-controller would be a separate, larger commitment — not chosen). |

## 2. Ownership model

- **Build artifacts** (image, rpm, npm) → **commander-owned**.
- **Shared config/infra repo** → **commander-owned**.
- **Domain-specific config/infra repo** (for outposts in a *different* domain than the commander) → **outpost-owned**, on the outpost's local Gitea.

**Domain-specific artifacts are outpost-autonomous:** built, tested, and deployed within the outpost's own domain; the commander does **not** track, scan, or sign them. They therefore never cross a boundary and skip the supply-chain gate and validation entirely (§4, §6).

## 3. The flow, end to end

1. **Engineer merges to main** in the relevant repo (owned per §2).
2. **Build + test** run on the coordinating domain's Argo Workflows (commander for builds + shared config/infra; the outpost for its own domain-specific config/infra). SCP consumes pass/fail as gate evidence.
3. **Commander scans** the artifact(s) it tracks (Trivy step) — see §4. *Domain-specific outpost artifacts are never scanned (they don't cross a boundary).*
4. **Commander generates the SBOM** (same Trivy pass, build-time).
5. **Commander signs** the artifact(s), SBOM, and a **promotion manifest** with cosign — only if scans pass.
6. **Commander notifies** the relevant outposts/retrans, in pipeline order, that a promotion is pending — **poke** (poke-mode, opt-in per outpost) / **poll** (default) / **air-gap bundle file** (sneakernet). Poke reaches air-gapped domains via the retrans chain (§5).
7. **Outposts/retrans pull** the pending promotion. What crosses is **metadata** (change object, digests, signatures, SBOM refs, signed manifest) — **never artifact bytes** (§5).
8. **Validate** at every hop: the retrans fully validates before letting anything cross the CDS, and the receiving outpost fully re-validates inside the domain before deploy (§6).
9. **Outpost handles the rest of CI/CD** — coordinating Argo CD (k8s), Ansible/`scp-runner-ops` (hosts), or IaC (infra) within its domain.
10. **Outpost pushes status upward** as steps occur (if not air-gapped; air-gapped reports via returned bundles, shown "as of ⟨bundle⟩").
11. On success, the **commander advances** to the next outpost/retrans in the pipeline (the wave engine).

## 4. Supply-chain gate (source side) — ADR-0013

Applies only to **commander-tracked** artifacts (things that cross a boundary):

- **Scan is a boundary-crossing *authorization* gate**, not a general quality gate. That is *why* domain-local artifacts skip it and why outposts stay light (they don't scan — trust-at-source). A coordinated Trivy step produces the verdict; SCP gates promotion on it.
- **SBOM** is generated at build time (richest component inventory) in the same Trivy pass.
- **Signed promotion manifest**: the commander signs an enumeration of exactly the authorized artifact set (digests). Its job is the "**nothing slipped in**" guarantee — a receiver verifies that the arrived set matches the signed set, with no additions or substitutions.

## 5. Delivery: metadata vs. bytes, and reaching the air gap — ADR-0009

- **Federation/promotion bundles are metadata-only** (`packages/schemas/src/federation.ts`) — digests, signatures, SBOM refs, signed manifest, change objects, control outcomes; **no image/manifest bytes**. The commander never *pushes* artifacts; the outpost/retrans **pulls** from the approved source.
- **Artifact bytes travel on a separate channel**: a connected commercial outpost pulls the image from the commander's registry; a high/air-gap outpost receives bytes via the **retrans tarball** into its **local Gitea registry**.
- **Poke reaches air-gapped domains via the retrans chain**, hop by hop: commander pokes the (reachable) low-side retrans → it pulls/validates/packages a tarball → pushes across the CDS → the high-side retrans **inside** the air gap receives it → **pokes the outpost locally** (intra-domain, reachable, **required**). The commander never dials the outpost directly. Pure **sneakernet** (no CDS data path at all) is the only fully-manual case.

## 6. Validation — universal for cross-boundary artifacts — ADR-0011

- Validation (signature + SBOM/manifest) happens at **full strength at every hop**: the **retrans validates before crossing the CDS** (nothing invalid enters the air-gapped domain), and the **outpost re-validates inside the domain before deploy** (defense in depth). Same level at each — not a lighter retrans check.
- It is **universal for cross-boundary artifacts**: deployment always terminates at an outpost, and the receiving outpost always validates before deploying — commercial included; trust tiers differ only in git/image-repo *ownership* (§2), not in *whether* validation happens.
- **Exception:** domain-locally-originated artifacts (outpost-owned, §2) never cross a boundary, so they have **no transfer stage and nothing to validate** — a shorter pipeline. "Always-shown boundary stages" and "universal validation" apply to cross-boundary changes only.

## 7. The outpost's own local UI

Because CommanderSCP is **one binary** (commander/outpost/retrans are runtime roles), an outpost already serves the full UI. Scoped to its local domain, that is a "small UI" with the same service/component/graph views for the **domain-specific pipelines the commander does not track**. This is **distinct from M16**: M16 is the *commander looking out* at its outposts; this is an *outpost looking at its own* domain. Same view components, locally scoped.

## 8. Milestone mapping

| Capability | Milestone |
|---|---|
| Argo Workflows / Argo CD bundled (build/test, k8s deploy) | M11.2 / M11.3 (existing) |
| Gitea unified registry (default; image + code + package) added to the Standard Stack | **M11 (updated)** / M15 (outpost-local) |
| Harbor removed from the default stack (existing Harbor via import) | **M11.4 (updated)**, **M15.3** (import) |
| Coordinated Trivy scan + build-time SBOM + signed promotion manifest + cross-hop validation | **M17 (new)** |
| git-service-agnostic executor; outpost = Gitea-only | M15 |
| Poke-mode + retrans relay | M14 |
| Universal (cross-boundary) validation + boundary pipeline stages | M16 |
| Outposts management UI + outpost's own local UI | M16 |
| Cloud IaC via Argo Workflows / `scp-managed-iac` | M7 (managed-iac exists) |
| Host deploy via `scp-runner-ops` | proposed (`managed-execution-tier.md`) — needs a milestone home |

## Open items carried forward

- `scp-runner-ops` is proposed, not built (the host lane is the least-built deploy path).
- The retrans/CDS byte-relay (§5, high/air-gap) is M15.5 — deferred/optional.
- Crossplane/tf-controller (infra-as-k8s-CRs under Argo CD) was **considered and not chosen**; revisit only if the IaC model changes.
