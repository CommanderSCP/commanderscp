# Proposal: Per-Outpost Local Artifact & Source Infrastructure (Harbor + Gitea)

**Status:** Proposed — pending review (2026-07-18)
**Relates to:** DESIGN.md §12 (execution), §13 (federation), §16 (bundling); [ADR-0002](../adr/0002-execution-strategy.md) (execution strategy / bundled backends); [ADR-0004](../adr/0004-service-naming-commander-outpost-retrans.md) (commander/outpost/retrans); [ADR-0010](../adr/0010-outpost-local-artifact-infra.md) (this decision); proposals `bundled-executor-backends.md`, `import-existing-executors.md`
**Milestone:** M15 (provisional — post-M11 federation track; follows M14 poke-mode)

## Update 2026-07-18 — outpost = Gitea only (supersedes the "local Harbor" references below)

Owner decisions since this proposal was written (see [ADR-0012](../adr/0012-registry-consolidation.md), [ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md), and the master `promotion-and-execution-model.md`) simplify the outpost's local infra:

- **The outpost runs Gitea only — no local Harbor.** One light service is the outpost's **image** repo (OCI container registry), **code** repo (git), and **package** repo (rpm/npm/Maven/Helm/…). Harbor is **not bundled**; an org that runs Harbor coordinates its existing one via the import path (ADR-0012, M15.3). Where this doc says the outpost runs a "local Harbor," read **local Gitea registry**.
- **Outposts do not scan.** Scanning is a **boundary-crossing authorization gate** done **once at the source** (a coordinated Trivy step at the origin — the **commander consumes** its verdict, ADR-0013; [ADR-0017](../adr/0017-ownership-refinement.md) — SCP never runs the scan itself) — so the receiving outpost verifies the signed attestation/manifest but never re-scans, and therefore needs no scanning registry. This is *why* the outpost can drop Harbor and stay light.
- **Ownership model ([ADR-0017](../adr/0017-ownership-refinement.md), refined 2026-07-20):** **build execution devolves to the *originating* outpost** — the commander never runs build; it owns **only** the cross-boundary gate (consume scan verdict + cosign-sign **only** its own promotion manifest). *Repo/byte hosting is a separate axis:* the **shared** config/infra repos may stay **commander-hosted**, while **domain-specific** config/infra repos are **outpost-owned** on the outpost's local Gitea. Domain-specific artifacts are outpost-autonomous — the commander does not track, scan, or sign them, and they skip the boundary entirely.
- **The outpost's own local UI:** because it is one binary, an outpost already serves the full UI; scoped to its local domain it gives service/component/graph views for the domain-specific pipelines the commander doesn't track (distinct from the commander-side Outposts UI in M16).

The Create/Import mechanics, the git-service-agnostic executor, and the boundary/trust model below still apply — just with Gitea as the single registry and Harbor as an *optional* enterprise alternative (ADR-0012).

## Problem

Today Harbor sits with the commander (M11.4) and GitOps config repos live in GitHub via the `github` executor. Neither is reachable from inside a **FedRAMP High / IL5 / air-gapped** domain at deploy time. A high outpost therefore needs its **own local registry** (holding promoted, scanned, signed images) and its **own local git** (holding the desired-state manifests its Argo CD reconciles).

Grounding the current code shows this is a **foundational gap, not a config toggle**:

- **Federation bundles are metadata-only.** `SyncBundleSchema`/`PromotionBundleSchema` carry journal segments, change objects, control outcomes, audit, and referenced-artifact **digests** — never image or manifest **bytes** (`packages/schemas/src/federation.ts:169-175,232`; DESIGN.md:656). Bundled Argo CD runs against an *"offline registry"* the operator loads from the air-gap install bundle (skopeo OCI copy) — SCP moves no artifact bytes.
- **No git/manifest replication exists.** SCP never models or moves the desired-state repo Argo CD reconciles; it holds a scoped token and coordinates `sync` (DESIGN.md:594,614). "Config delivery" (DESIGN.md:642) means *commander global config*, not application GitOps manifests.
- **`retrans` (the CDS relay role) is declared but unbuilt** — no artifact-relay/CDS transfer logic ships (`ADR-0004:43-45`; `federation.ts:25`).
- **The git executor is GitHub-only** — App-JWT installation tokens, `api.github.com`, GitHub Actions `workflow_run`, GitHub webhook HMAC (`packages/plugins/github/src/index.ts:51-154,186,330`). No Gitea/GitLab plugin exists; the module allowlist is `fake-executor, github, argocd, terraform, managed-iac` (`executor-bindings-repo.ts:353-359`).
- **Harbor's "observe-only" is aspirational** — Harbor is *deployed* (M11.4) but there is **no registry/Harbor executor and no auto-wire token hook** in source (`grep harbor` over `apps/server/src`+`packages` is empty; only Argo CD ships an auto-wire hook). Nothing reads image/scan state yet.

Net: a self-contained offline outpost is currently a property the **operator must assemble** (their own registry + git mirror), undocumented as an SCP responsibility. This milestone makes it a **first-class, optional, per-outpost capability**.

## What already works (grounded)

- **Outpost-scoped bundling is mechanically possible today.** `bundledExecutor.{harbor,argocd}.enabled` are per-**installation** toggles tied to the cluster, not the commander; commander/outpost/retrans is a runtime DB identity (`self_domain.role`), orthogonal to the chart. `scripts/scp-bundled.sh enable <backend> --scp-release <outpost>` renders into `scp-<backend>` and flips the local flag regardless of role. **But it is ungoverned** — nothing constrains which backends an outpost may enable (no `federation.role` gate).
- **Import is graph-native.** An `execution-system` is a graph object (`typeId "execution-system"`, properties `{kind, serverUrl, tokenSecretKey, allowInternalEgress}`); binding rides `executor_bindings`; the import path is `POST /discovery/run` → review → `POST /discovery/accept` (`packages/schemas/src/executors.ts:213-281`). This is exactly the seam for "import any approved registry + git."
- **The bundled-backend recipe is well-established** (vendor unmodified sha-pinned upstream, `renderVendoredBackend` namespace/CRB re-homing, SCP-generated secrets via `lookup`, a scoped-token auto-wire Job, an `allow-<backend>` NetworkPolicy, `build-bundle.ts`/`install.sh` image retarget, helm-verify gates) — Gitea slots straight into it.

## Design

Two paths behind one execution-system model (owner decisions, 2026-07-18):

### Create (bundle)
- **Gitea** as a new Standard-Stack backend (MIT-licensed, air-gap-vendorable) following the established recipe. Coordinated through the new **git-service-agnostic** git executor (decision 3) via a Gitea adapter — because Gitea's auth (PAT/OAuth), webhook signature, and CI model don't map onto the GitHub plugin, the executor abstracts auth/webhook/CI behind one interface rather than being GitHub-shaped. Observe feeds via a Gitea → `change-source` webhook into the existing webhook processor (which requires a `source_mapping`, per the observe-correlation note). DB per decision 1 (shared bundled Postgres if available, else SQLite).
- **Harbor** made a *real* observe target: the missing auto-wire token hook + a **registry executor** that reads image/scan state through a scoped read token (closes the "observe-only is aspirational" gap).

### Import (bind existing — any approved registry + git)
- Bind an existing **Harbor / Artifactory / GitLab / Gitea** as `execution-system` graph objects via discovery. Reuses the graph-native import seam; needs the same generalized git executor (for Gitea/GitLab) and registry executor (for Harbor/Artifactory) as the create path.

### Boundary artifact model — trust scan-at-source (owner decision, 2026-07-18)
- Images are **scanned + signed at the source**. *(Superseded/corrected: (i) the registry is **Gitea**, not Harbor — ADR-0012; (ii) cross-boundary **cosign** signing is **new** work — [ADR-0015](../adr/0015-cosign-cross-boundary-signing.md) — not a pre-existing M4/M6/M8 capability, which was Ed25519, and cosign is **not vendored today** (operator-supplied on `PATH`); (iii) **who signs**: the **executor** cosign-signs the artifact(s) and the build-time SBOM at build — **not** the commander, which signs only its own promotion manifest ([ADR-0015 §5](../adr/0015-cosign-cross-boundary-signing.md)); (iv) **where the scan runs**: under build-devolution the coordinated **Trivy** step runs **once at the origin** (the originating outpost's executor), and the **commander only consumes the verdict** as gate evidence — it does **not** run the scan ([ADR-0017 §2](../adr/0017-ownership-refinement.md)).)* The **digest + signature + scan attestation** ride the *metadata* federation/promotion bundle; the outpost's **local registry holds the image bytes** and **cosign-verifies them against the signed digest+attestation before deploy — no re-scan**. The coordinated Trivy scan runs once at the origin (the commander consumes the verdict, [ADR-0017 §2](../adr/0017-ownership-refinement.md)); the receiving outpost never re-scans.
- **The artifact-bytes transport is the honest open gap.** Because bundles are metadata-only, the image/manifest *bytes* must still reach the outpost's local Harbor/Gitea by some channel. Two options (open decision):
  - **(a, recommended first) Operator-loaded + SCP-verified.** Bytes arrive via the existing air-gap install-bundle path (skopeo OCI → local Harbor; manifests → local Gitea); SCP **verifies** each promoted digest against the signed source attestation and records a Decision, and coordinates the local backends. Lighter, honest, builds on what exists.
  - **(b, later) Build the retrans/CDS artifact-relay** to carry bytes across the boundary — the currently-unbuilt `retrans` logic. Heavier; a separate track.

## Invariants held

- **Coordinate-not-execute.** SCP coordinates the local Harbor/Gitea with scoped tokens; the backends keep their own credentials — the credential-asymmetry invariant holds **unamended**, exactly as bundled Argo CD/Harbor today.
- **Graph-native.** Local Harbor/Gitea are `execution-system` graph objects scoped to the outpost's domain; no bespoke tables.
- **Air-gap first-class.** This is the air-gap principle made concrete: a domain self-contained for artifacts + source, offline.
- **Explainable promotion.** Verifying a promoted image's digest against its signed source attestation persists a Decision like any other engine verdict.

## Milestone scope (M15, phased)

- **P1 — Gitea bundle + Gitea git-executor module** (create-path git): vendored sha-pinned Gitea, SCP-generated secrets, scoped-token auto-wire hook, `allow-gitea` NetworkPolicy, bundle image carry/retarget, `scp-bundled.sh` verb, helm-verify gates; a `gitea` executor (trigger/observe/status/abort) + webhook→`change-source` wiring + `source_mapping`.
- **P2 — Harbor as a real observe target**: the missing auto-wire token hook + a registry executor reading image/scan state; scan-attestation verification (trust-scan-at-source) as gate evidence.
- **P3 — Import path**: bind existing Harbor/Artifactory/GitLab/Gitea execution-systems via discovery (generalize the git + registry executors beyond the bundled pair).
- **P4 — Role-scoped governance**: a `federation.role` gate + policy so local-infra is an *explicit, governed* per-outpost option — turning "mechanically possible" into "supported and intended."
- **P5 (optional/later)** — artifact-bytes transport across the boundary (retrans/CDS relay) if operator-loaded bytes prove insufficient.

## Decisions (owner, 2026-07-18)

1. **Gitea DB → shared bundled Postgres if available, else SQLite.** Prefer a bundled Postgres *shared with an existing bundled instance* (Gitea's own database + credentials on the same server); fall back to bundled **SQLite + PVC** rather than stand up a **dedicated new** Postgres just for Gitea. Priority: reuse an existing instance > SQLite > a new dedicated Postgres.
2. **Artifact-bytes transport → operator-loaded + SCP-verify, first.** No real fork: bytes arrive via the existing air-gap install-bundle path and SCP verifies each promoted digest against the signed source attestation; the retrans/CDS byte-relay is a later, separate track (M15.5).
3. **Git executor → git-service-agnostic.** Build a **provider-agnostic** git executor — auth, webhook-signature, and CI-model adapters behind one interface (GitHub / GitLab / Gitea / generic git) — not a Gitea-specific module. Closes the single-vendor (GitHub-only) portability gap the charter's self-hosting/air-gap goals push against.

## Non-goals

- SCP does **not** become a registry or git host itself — it coordinates the bundled/imported ones (coordinate-not-execute).
- **Not for commercial/connected outposts** — they keep using the commander's Harbor / GitHub. This is opt-in, motivated by high/air-gap domains.
- No change to the metadata-only federation bundle format in P1–P4; the byte-transport question is isolated to P5.
