# ADR-0010: Per-outpost local artifact & source infrastructure (Harbor + Gitea)

**Status:** Proposed (2026-07-18)
**Context doc:** [docs/proposals/outpost-local-artifact-infra.md](../proposals/outpost-local-artifact-infra.md)
**Relates to:** [ADR-0002](0002-execution-strategy.md) (execution strategy / bundled backends); [ADR-0004](0004-service-naming-commander-outpost-retrans.md) (commander/outpost/retrans); [ADR-0012](0012-registry-consolidation.md), [ADR-0013](0013-supply-chain-scan-sbom-manifest.md); DESIGN.md §12/§13/§16

## Amendment 2026-07-18 — outpost = Gitea only

Superseded by [ADR-0012](0012-registry-consolidation.md)/[ADR-0013](0013-supply-chain-scan-sbom-manifest.md): the outpost's local infra is **Gitea only** — one service serving **images** (OCI container registry), **code** (git), and **packages** (rpm/npm/…) — **no local Harbor**. Outposts do not scan (scanning is a source-side boundary-authorization gate, ADR-0013), so they need no scanning registry; they verify the signed attestation/manifest and stay light. Harbor is **not bundled**; an org that runs Harbor coordinates its existing one via the import path (ADR-0012, M15.3). Read "local Harbor" below as "local Gitea registry."

## Context

A FedRAMP-High / IL5 / air-gapped outpost cannot reach the commander's Harbor or GitHub at deploy time, so it needs a **local registry** (promoted, scanned, signed images) and a **local git** (desired-state manifests). Grounding the code shows this is a foundational gap, not a toggle:

- Federation/promotion bundles are **metadata-only** — digests, change objects, control outcomes, audit; never image/manifest **bytes** (`packages/schemas/src/federation.ts:169-175,232`).
- SCP never models or moves the GitOps desired-state repo; **no git/manifest replication** exists across a boundary.
- **`retrans`** (the CDS relay role) is **declared but unbuilt** (`ADR-0004:43-45`).
- The git executor is **GitHub-only**; no Gitea/GitLab plugin exists. Harbor's **"observe-only" is aspirational** — no registry executor, no auto-wire token hook.
- Bundled backends are per-**installation** toggles (role-agnostic), so an outpost can *mechanically* stand one up already — but this is **ungoverned** (no `federation.role` gate).
- `execution-system` is a **graph object** with a discovery-based import path — a clean, graph-native seam for "import an existing system."

Self-contained-offline is therefore, today, an **operator-assembled** property, undocumented as an SCP responsibility.

## Decision

Make per-outpost **local Harbor + local Gitea** a **first-class, optional capability**, offered two ways behind the existing `execution-system` model:

- **Create** = bundle **Gitea** (new Standard-Stack backend, coordinated through a new **git-service-agnostic** git executor) and make **Harbor** a real observe target (auto-wire token hook + a **registry executor**).
- **Import** = bind an existing **Harbor / Artifactory / GitLab / Gitea** as `execution-system` graph objects via discovery (owner decision: any approved registry + git, not only the bundled pair).

**Boundary artifact model — trust scan-at-source (owner decision, 2026-07-18):** images are scanned + signed commander-side; the digest + signature + scan attestation ride the metadata bundle; the outpost's local Harbor **verifies against the signed attestation before deploy — no local re-scan**. The Trivy gate stays at the source (M11.4). *(Superseded/corrected 2026-07-20: (i) the **registry is Gitea**, not Harbor — [ADR-0012](0012-registry-consolidation.md); (ii) artifacts are **not** signed commander-side — the **executor** cosign-signs the artifact(s) and the build-time SBOM at build, and the commander cosign-signs only its own promotion manifest ([ADR-0015 §5](0015-cosign-cross-boundary-signing.md)); (iii) **M11.4 was the deleted Harbor bundle** — the scan gate is **M17** ([ADR-0013](0013-supply-chain-scan-sbom-manifest.md)), with scoped pass-criteria at M17.5 ([ADR-0016](0016-scoped-scan-requirement-policies.md)). "Scan-at-source, no re-scan at the outpost" still holds.)*

**Artifact bytes** are, in the first phases, **operator-loaded** via the existing air-gap install-bundle path and **SCP-verified** against the signed digest; building the `retrans`/CDS byte-relay is deferred to a later, separate phase.

The capability is **opt-in and role-scoped** — a `federation.role` gate + policy turns today's "mechanically possible on any install" into "supported and governed on a designated outpost." Not for commercial/connected outposts.

## Consequences

**Positive**
- A high/air-gap outpost becomes genuinely self-contained for artifacts + source, offline — the air-gap principle made concrete.
- Reuses proven seams: the bundled-backend recipe, the graph-native `execution-system`/discovery import, and the keyful/offline **cosign** release-signing wrapper (`deploy/airgap`) — extended to cross-boundary artifacts + the promotion manifest in [ADR-0015](0015-cosign-cross-boundary-signing.md). *(Note: runtime signing built at M4/M6/M8 was **Ed25519**, not cosign; cross-boundary cosign is new — ADR-0015. What is reused is the wrapper's **flag behaviour**: the cosign **binary is not vendored today** — it is an operator prerequisite on `PATH` — and a runtime sign/verify path must vendor a pinned one.)*
- Credential-asymmetry holds **unamended** (SCP holds scoped tokens; backends keep their own creds), same as bundled Argo CD/Harbor.

**Costs / constraints**
- **Net-new git executor.** Gitea/GitLab is a new plugin (auth, webhook signature, CI model) — the largest single lift; observe also needs a `source_mapping`.
- **Harbor observe must actually be built** (auto-wire hook + registry executor) — it is aspirational today.
- **The artifact-bytes transport gap is real** and explicitly *not* closed by the metadata bundle; P1–P4 rely on operator-loaded bytes + SCP verification, with a byte-relay deferred to P5.
- Adds a `federation.role` chart gate + governance for bundled backends.

**Resolved (owner, 2026-07-18)**
- **Gitea DB** = shared bundled Postgres if an existing bundled instance is available, else SQLite+PVC — never a dedicated new Postgres just for Gitea.
- **Artifact-bytes transport** = operator-loaded + SCP-verify against the signed attestation, first; the retrans/CDS byte-relay is deferred (M15.5).
- **Git executor** = **git-service-agnostic** (provider adapters behind one interface: GitHub/GitLab/Gitea/generic git), not a Gitea-specific module.
