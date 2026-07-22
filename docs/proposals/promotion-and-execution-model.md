# Proposal: End-to-End Promotion & Execution Model

**Status:** Proposed — pending review (2026-07-18)
**Role:** Master synthesis of the change→build→supply-chain→promotion→validation→deploy flow settled with the owner on 2026-07-18. It ties together and is authoritative over the per-topic ADRs it references.
**Relates to:** [ADR-0009](../adr/0009-optional-poke-mode-federation.md) (poke), [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) (outpost local infra), [ADR-0011](../adr/0011-universal-outpost-validation.md) (validation), [ADR-0012](../adr/0012-registry-consolidation.md) (registry), [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md) (supply chain), [ADR-0015](../adr/0015-cosign-cross-boundary-signing.md) (cosign end-to-end signing), [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) (scoped scan policies), [ADR-0017](../adr/0017-ownership-refinement.md) (**build devolves to the originating outpost; the commander owns only the cross-boundary gate — this §2/§3 is rewritten to match, 2026-07-20**), [ADR-0018](../adr/0018-domain-local-dev-pipelines.md) (domain-local dev/beta pipelines are scan-exempt by path); proposals `bundled-executor-backends.md`, `outpost-local-artifact-infra.md`, `federation-outposts-ui.md`, `managed-execution-tier.md`, `execution-strategy.md`; DESIGN.md §12–§13.

## 0. The invariant that governs everything

CommanderSCP **coordinates** execution systems; it does not build, test, scan, sign, or deploy *itself*. Every stage below runs on a coordinated execution system (bundled or BYO), and SCP triggers/observes/gates it and consumes results as evidence. There are exactly **two** scoped execution exceptions, both pre-authorized:

- **`scp-managed-iac`** — trivial IaC releases for pipeline-less orgs, ephemeral containers, `--network none` except cloud APIs, vaulted scoped creds (charter, 2026-07-08).
- **`scp-runner-ops`** (proposed) — host-reaching Ansible from a closed, cosign-signed task catalog (OS package install/upgrade/pin, config/template push, systemd/cron; never arbitrary shell), holding host login creds behind hard preconditions — SSTI/Jinja closure, SSH-CA blast-radius analysis (charter amendment, 2026-07-12; `managed-execution-tier.md`).

## 1. Execution map (what runs each stage)

| Stage | Mechanism | Notes |
|---|---|---|
| **build + test** (any artifact: image, rpm, npm, deb, …) | **the originating outpost's Argo Workflows** (bundled, M11.3) — [ADR-0017](../adr/0017-ownership-refinement.md) | Generic containerized-step engine — tool-agnostic. Images use Kaniko/Buildkit; packages just run their toolchain. BYO CI (GitHub Actions / GitLab) coordinated instead where present. **Build runs in the domain where the change originates — the commander never runs build** (ADR-0017 §2, a favorable tightening of principle 1). SCP never runs CI. |
| **scan + SBOM** | **coordinated Trivy step** (in Argo Workflows) | One pass emits both the vulnerability scan and the SBOM. Results made available to the commander as **gate evidence** — not a registry feature (see §4, ADR-0013). Pass-criteria is **scoped** (platform → trust domain (partition) → org → containment domain → service → component, most-restrictive-wins — ADR-0016). |
| **store** — **images** (OCI), **code** (git), **packages** (rpm/npm/Maven/Helm/…) | **Gitea unified registry** (default) — the image repo, code repo, **and** package repo in one service | Harbor is **not bundled**; an org that wants Harbor coordinates its **existing** one via the import path (ADR-0012, M15.3). |
| **sign** | **cosign — end-to-end** (ADR-0015) | cosign signs **all** cross-boundary artifact types (images, rpm/deb/npm, config bundles, infra plans, SBOM) **and** the promotion manifest — a **new** supply-chain layer, keyful/offline (`--tlog-upload=false`, no Fulcio/Rekor). cosign is **already used on the release path (operator-supplied on `PATH`, unpinned by design) — *not vendored today***; M17.3 must vendor a **pinned** binary for the runtime sign/verify path (ADR-0015 Consequences). **Ed25519 stays for federation transport** (bundle envelope / journal / attestations), unchanged — cosign is NOT the M4/M6/M8 signing (that was Ed25519). The **executor signs the artifact(s) and the SBOM** at build; the **commander signs only its own promotion manifest** (coordinate-not-execute). |
| **deploy → Kubernetes** (image workloads **and** non-image k8s config: Helm, CRDs, operators, ConfigMaps, NetworkPolicy) | **Argo CD** (bundled, M11.2) | GitOps. |
| **deploy → hosts/VMs** (rpm/npm install, config files, systemd) | **Ansible** via **`scp-runner-ops`** (behind the scenes) / BYO Ansible-Tower/Salt | Argo CD is k8s-only and cannot reach a host. Most sensitive execution class in the system. |
| **provision → cloud infra** (Terraform / OpenTofu / CDK / CDKTF / Pulumi) | **Argo Workflows** plan→gate→apply, or **`scp-managed-iac`** | SCP gates the *plan*; cloud creds live in the workflow env, not SCP. Not Argo CD (it cannot natively run IaC; Crossplane/tf-controller would be a separate, larger commitment — not chosen). |

## 2. Ownership model — refined 2026-07-20 ([ADR-0017](../adr/0017-ownership-refinement.md))

**Build execution devolves to the originating outpost; the commander owns *only* the cross-boundary gate.**

- **Build (of any tracked artifact: image, rpm, npm, shared config/infra, or domain-specific config/infra)** → runs in the **originating outpost's own Argo Workflows** (or BYO CI). **The commander never runs build.**
- **The commander owns only the cross-boundary gate:** it **consumes the scan verdict** (M17.1; scoped pass-criteria ADR-0016/M17.5) and **cosign-signs only its own promotion manifest** (M17.3 E4–E6) — never an origin artifact or the SBOM ([ADR-0015 §5](../adr/0015-cosign-cross-boundary-signing.md)). Its export-time gate (M17.3 E6) hard-refuses any digest lacking a passing, digest-bound scan.
- **Repo/byte hosting per trust tier is a separate, unchanged axis:** the **shared config/infra repo** and the commercial-tier git/image repos may remain **commander-hosted**, while **domain-specific config/infra repos** are **outpost-owned** on the outpost's local Gitea ([ADR-0010](../adr/0010-outpost-local-artifact-infra.md), [ADR-0011](../adr/0011-universal-outpost-validation.md), [ADR-0012](../adr/0012-registry-consolidation.md), M15). *Where bytes live* is orthogonal to *where build executes* (ADR-0017 §2).

**Domain-specific artifacts are outpost-autonomous:** built, tested, and deployed within the outpost's own domain; the commander does **not** track, scan, or sign them. They therefore never cross a boundary and skip the supply-chain gate and validation entirely (§4, §6). *Domain-local **dev/beta** pipelines are likewise scan-exempt — by path, backstopped by the E6 export gate — see [ADR-0018](../adr/0018-domain-local-dev-pipelines.md).*

## 3. The flow, end to end

1. **Engineer merges to main** in the relevant repo (owned per §2).
2. **Build + test** run on the **originating outpost's** Argo Workflows — the domain where the change originates, for **every** tracked artifact including shared config/infra ([ADR-0017](../adr/0017-ownership-refinement.md) §2; **the commander never runs build**). SCP consumes pass/fail as gate evidence.
3. **The commander consumes the scan verdict** for the cross-boundary artifact(s) it gates (the coordinated Trivy step runs at the origin; the commander does not run it) — see §4. *Domain-specific outpost artifacts are never scanned (they don't cross a boundary).*
4. **SBOM is emitted by the same coordinated Trivy pass** at build time — an **executor** output the commander consumes and references (SCP never runs the pass itself, §0).
5. **Signing (cosign, end-to-end — ADR-0015):** the **executor cosign-signs the artifact(s) AND the SBOM at build** (the SBOM is a build-time output of the executor's Trivy pass); the **commander cosign-signs ONLY the promotion manifest** enumerating exactly the authorized artifact set — only if scans pass. SCP never signs an origin artifact, SBOM included (ADR-0015 §5). cosign covers **all** cross-boundary artifact types + the manifest; Ed25519 remains the untouched federation-transport layer.
6. **Commander notifies** the relevant outposts/retrans, in pipeline order, that a promotion is pending — **poke** (poke-mode, opt-in per outpost) / **poll** (default) / **air-gap bundle file** (sneakernet). Poke reaches air-gapped domains via the retrans chain (§5).
7. **Outposts/retrans pull** the pending promotion. What crosses is **metadata** (change object, digests, signatures, SBOM refs, signed manifest) — **never artifact bytes** (§5).
8. **Validate** at every hop with **explicit cosign-verify** (ADR-0015, §6): the **retrans cosign-verifies** every artifact + manifest match before letting anything cross the CDS, and the **receiving outpost cosign-verifies** again inside the domain before deploy (§6). Offline pubkey (distributed via federation config); fail-closed; no re-scan. *(Target model — retrans is unbuilt today, now scheduled as the M15.5(c) byte-relay ([ADR-0019](../adr/0019-artifact-byte-channel.md)), whose VALIDATE step reuses the M17.4 machinery; M17.4 lands the outpost-side verify first, [ADR-0015 §6](../adr/0015-cosign-cross-boundary-signing.md). Note also that §6's verify splits: manifest-signature + arrived-set equality at metadata-bundle import, per-artifact verify where the bytes land.)*
9. **Outpost handles the rest of CI/CD** — coordinating Argo CD (k8s), Ansible/`scp-runner-ops` (hosts), or IaC (infra) within its domain.
10. **Outpost pushes status upward** as steps occur (if not air-gapped; air-gapped reports via returned bundles, shown "as of ⟨bundle⟩").
11. On success, the **commander advances** to the next outpost/retrans in the pipeline (the wave engine).

## 4. Supply-chain gate (source side) — ADR-0013 / ADR-0015 / ADR-0016

Applies only to **commander-tracked** artifacts (things that cross a boundary):

- **Scan is a boundary-crossing *authorization* gate**, not a general quality gate. That is *why* domain-local artifacts skip it and why outposts stay light (they don't scan — trust-at-source). A coordinated Trivy step produces the verdict; SCP gates promotion on it. **Pass-criteria is scoped** over six tiers — **platform → trust domain (partition) → org → containment domain → service → component** — **most-restrictive-wins** (child may only tighten; per-severity MIN, which is order-independent — [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md)). *The **trust domain (partition)** is the ambient federation boundary above org; the **containment domain** is the intra-org `domain` object type below org — different concepts, never conflated.*
- **SBOM** is generated at build time (richest component inventory) in the same Trivy pass.
- **Signing is cosign, end-to-end** ([ADR-0015](../adr/0015-cosign-cross-boundary-signing.md)): the **executor cosign-signs the artifact(s) AND the SBOM at build**; the **commander cosign-signs ONLY the promotion manifest** enumerating exactly the authorized artifact set (all cross-boundary types) — SCP never signs an origin artifact or the SBOM (ADR-0015 §5). Its job is the "**nothing slipped in**" guarantee — a receiver cosign-verifies that the arrived set matches the signed set, with no additions or substitutions. This is a **new** supply-chain signature layer; Ed25519 remains the federation-transport layer (bundle/journal/attestations), unchanged.

## 5. Delivery: metadata vs. bytes, and reaching the air gap — ADR-0009 + ADR-0019

- **Federation/promotion bundles are metadata-only** (`packages/schemas/src/federation.ts`) — digests, signatures, SBOM refs, signed manifest, change objects, control outcomes; **no image/manifest bytes**. The commander never *pushes* artifacts; the outpost/retrans **pulls** from the approved source. *(Unchanged by the byte channel below — the relay is a **separate channel**, never a bundle-format change.)*
- **Artifact bytes travel on a separate channel — designed per tier in [ADR-0019](../adr/0019-artifact-byte-channel.md)** (per-tier transport table §1; the retrans validate-then-relay pipeline §2; the vaulted, scoped **artifact-store credential class** — source-registry READ + destination-Gitea PUSH, registry creds not exec-infra creds — §3; the byte-channel config surface §4: `SCP_ARTIFACT_BLOB_BASE_URLS` + the symmetric `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist, both fail-closed when unset): a connected **commercial** outpost's deploy tool pulls the image **by digest** from the commander's registry (SCP writes no transport code — hosting + M17.4b verify only); a **high/air-gap** outpost receives bytes via **operator-loaded media** (MVP, done) or the **retrans validate-then-relay tarball** (M15.5(c), to build) into its **local Gitea registry** — the receiving outpost re-verifies (M17.4a+b) either way, granting the relay zero trust.
- **Poke reaches air-gapped domains via the retrans chain**, hop by hop: commander pokes the (reachable) low-side retrans → it pulls/validates/packages a tarball → pushes across the CDS → the high-side retrans **inside** the air gap receives it → **pokes the outpost locally** (intra-domain, reachable, **required**). The commander never dials the outpost directly. Pure **sneakernet** (no CDS data path at all) is the only fully-manual case.

## 6. Validation — universal for cross-boundary artifacts — ADR-0011

- Validation (**cosign-verify** signature + SBOM/manifest, ADR-0015) happens at **full strength at every hop**: the **retrans cosign-verifies before crossing the CDS** (nothing invalid enters the air-gapped domain), and the **outpost cosign-verifies again inside the domain before deploy** (defense in depth). Same level at each — not a lighter retrans check. Verification uses the offline-distributed cosign pubkey (federation config); no network fetch. *(Target model — retrans is unbuilt today, now scheduled as the M15.5(c) byte-relay ([ADR-0019](../adr/0019-artifact-byte-channel.md)), whose VALIDATE step reuses the M17.4 machinery; M17.4 lands the outpost-side verify first, [ADR-0015 §6](../adr/0015-cosign-cross-boundary-signing.md). Note also that the verify **splits by what is present at each hop**: at a **metadata-only** federation-bundle import there are no artifact bytes ([ADR-0015 §6](../adr/0015-cosign-cross-boundary-signing.md)), so the check there is **manifest-signature verify + arrived-set equality**; **per-artifact cosign verify happens where the bytes land** — the retrans carries bytes (§5), and the outpost verifies them before deploy. "Full strength at every hop" means the strongest check available at that hop, not per-artifact verification at a metadata-only import.)*
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
| Coordinated Trivy scan + build-time SBOM + cosign-signed artifacts + manifest (ADR-0015) + cross-hop cosign-verify | **M17.1–M17.4 (new)** |
| Scoped scan-requirement policies — platform / trust domain (partition) / org / containment domain / service / component, most-restrictive-wins (ADR-0016) | **M17.5 (new)** |
| git-service-agnostic executor; outpost = Gitea-only | M15 |
| Poke-mode + retrans relay | M14 |
| Universal (cross-boundary) validation + boundary pipeline stages | M16 |
| Outposts management UI + outpost's own local UI | M16 |
| Cloud IaC via Argo Workflows / `scp-managed-iac` | M7 (managed-iac exists) |
| Host deploy via `scp-runner-ops` | proposed (`managed-execution-tier.md`) — needs a milestone home |
| Ownership refinement — build devolves to originating outpost; commander = boundary gate only (ADR-0017) | **docs-only (ADR-0017)** — no new build code; does not block M17.4/M15.2/M15.5 |
| Multi-region Argo CD *setting* — one outpost owns Argo CD per region for a prod env (ADR-0017 §3) | **M15.6 (new, small)** — per-region deploy-target bindings already work; adds the config surface + test |
| Domain-local dev/beta pipelines — scan-exempt by path, E6-backstopped (ADR-0018) | **M18 (new, the very end)** |
| Artifact byte channel — per-tier transport, retrans validate-then-relay, artifact-store credential class ([ADR-0019](../adr/0019-artifact-byte-channel.md)) | **M15.5(a) documented / (b) DONE / (c) the build** |

## Open items carried forward

- `scp-runner-ops` is proposed, not built (the host lane is the least-built deploy path).
- The retrans/CDS byte-relay (§5, high/air-gap) is **M15.5(c) — required, designed in [ADR-0019](../adr/0019-artifact-byte-channel.md)** (owner finish-all-of-M15 mandate, 2026-07-20; no longer deferred/optional).
- Crossplane/tf-controller (infra-as-k8s-CRs under Argo CD) was **considered and not chosen**; revisit only if the IaC model changes.
