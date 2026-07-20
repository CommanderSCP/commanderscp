# Proposal — The SCP Execution Strategy (capstone)

> **Status: Exploration synthesis — pending owner decision.** Consolidates three explorations
> (2026-07-12): [managed-execution-tier.md](managed-execution-tier.md) (Mode C),
> [bundled-executor-backends.md](bundled-executor-backends.md) (Mode B), and the executor-portfolio
> exploration (this doc). Guardian corrections are applied inline. Where anything conflicts with the
> charter, the charter governs.

## Update 2026-07-18 — Gitea replaced Harbor (ADR-0012)

**This document predates [ADR-0012](../adr/0012-registry-consolidation.md) and still shows Harbor as the bundled default registry. That is superseded.** The default out-of-the-box registry is the **Gitea unified registry** (image repo + code repo + package repo in one service); **Harbor is import-only and is not bundled** — an org that runs Harbor coordinates its *existing* one via the discovery/import path (ADR-0012, M15.3). Specifically superseded below:

- the **Container registry** row of the capability table (Harbor / Bundle (B)) → **Gitea**, bundled;
- the "**one coherent family**" paragraph, which lists Harbor as part of the bundled Argo-ecosystem family;
- the **Mode-B bundle allowlist** — read `{Argo CD, Argo Workflows, Argo Events, **Gitea**}` (+ Valkey as Argo CD's cache); Harbor is **not** on the bundled allowlist.

Everything else in this document (the three-tier model, the four-arm ownership test, Modes A/B/C, the owned runners) stands.

## One strategy, one test, three tiers

**The strategy in one paragraph.** SCP's executor portfolio is a three-tier surface governed by one
four-arm ownership test, with verdicts attached to **(change-class, layer, domain)** graph
relationships — never to tools. **Tier 1:** a deliberately small dedicated-plugin roster (GitHub
Actions, ArgoCD, Terraform-pipeline Mode-1 today; GitLab next; others only on demonstrated demand).
**Tier 2:** one **generic pipeline executor** — extracted from the terraform Mode-1 shape
(URL-template trigger + status poll + inbound `scp change-source report`/webhook with a **required
structured-evidence schema**) — covering the entire CI/CD/IaC long tail at zero marginal engineering
per system, air-gap-friendly via the pull-side CLI path. **Tier 3:** exactly **two** owned,
closed-catalog, ephemeral runners (`scp-runner-iac` approved; `scp-runner-ops` proposed) that exist
only where the six-gate boundary test passes. **Bundling changes only who *supplies* an executor,
never the strategy**: a bundled instance flips gate 1 to "executor exists" and is coordinated through
the same plugin verbs.

## The four-arm ownership test

Run per **(class-of-change, layer, domain)** — never per tool. Default: **COORDINATE**. The verdict is
governed, federated **graph data**, not a plugin-install decision.

- **Q0 — IGNORE:** does SCP need to model/govern this class at all? (dev tooling, CI caches,
  standalone ingress → unbound graph inventory at most).
- **Q1 — COORDINATE:** does the domain have an existing execution system for this class? *(= gate 1 of
  the six-gate test, reused as the router.)* If yes — coordinate, full stop. *Dedicated plugin vs
  generic:* dedicated only if high prevalence in a target profile **and** ≥2 of {correlation richness,
  native abort matters, non-trivial auth}.
- **Q2 — BUNDLE:** no existing system, but a mature credential-holding backend is worth shipping?
  Criteria: Apache-2.0/MPL only; air-gap vendorable; version-decoupled; operable at SCP's footprint;
  and once installed it **flips gate 1** — the bundled instance is coordinated like any BYO one.
- **Q3 — OWN (managed-execute):** no existing system **and** the class is too small to justify a
  backend. **All six gates** must hold verbatim + the anti-CI corollary. Fail any → back to
  COORDINATE or IGNORE.

**Binding policy (owner decision):** a domain's opt-in to a bundled backend **automatically revokes**
managed-execute eligibility for the overlapping classes (one governed graph-data flip) — otherwise
Modes B and C silently compete and "own only when nothing else exists" stops being true.

All four arms live in **one combined ADR** with the six-gate test (the OWN arm) — separate documents
would drift.

## The final matrix

*(Status annotations per guardian: a verdict is a strategy, not shipped support.)*

| Verdict | System | Notes |
|---|---|---|
| coordinate-now | **GitHub Actions** | plugin built (App auth) — *[gap: observe driver unwired]* |
| coordinate-now | **ArgoCD** (BYO) | plugin built — *[gap: mock-tested only; agentkit trial is the real-cluster validation]* |
| coordinate-now | **TFC/TFE, Atlantis, workflow-wrapped tofu** | covered by terraform Mode-1 URL-template pattern today |
| bundle-candidate | **ArgoCD** (supply-side) | canonical Mode B; allowlist = the SCP Standard Stack (Argo CD ships first — see below); **operator-installed, never applied by scpd** |
| bundle-candidate | **OpenTofu** | already effectively bundled inside `scp-runner-iac`; never BUSL Terraform |
| coordinate-later | **GitLab (SCM+CI)** | highest-leverage next dedicated plugin — charter-named twice, one API covers both, opens the enterprise + air-gapped profiles |
| coordinate-later | **Flux · AWX/AAP · Satellite/Foreman** | demand-gated; each starts with a 1-day API spike |
| coordinate-generic | **Jenkins · Azure DevOps · Pulumi Cloud · Tekton · CircleCI · Buildkite · CodeBuild/CodePipeline · Spinnaker · Harness · Spacelift · env0 · CloudFormation · Salt · Puppet · Chef · Nomad · Octopus · Rundeck …** | one generic executor covers ~20 systems — *[blocked-on: `@scp/plugin-pipeline-generic` extraction]* |
| own-managed | **`scp-runner-iac`** (IaC long tail) | approved 2026-07-08; eligible only where gate 1 holds |
| own-managed | **`scp-runner-ops`** (RPM/config/cron/systemd) | proposed; inert until the charter amendment lands |
| never-own | **Artifact registries** (GHCR/Harbor/ECR) | fact stores, not pipelines — observe-only plugin mid-term, never executor verbs |
| never-own | **Argo Rollouts / progressive delivery** | status enrichment via the argocd plugin; replicating the control loop = execution |
| never-own | **vSphere / cloud APIs directly** | substrates — a per-cloud executor would hold standing infra creds (credential asymmetry) |
| never-own | **CI engines, artifact build, GitOps reconcilers, IaC state backends, config-mgmt DSLs, shell/runbook executors, secret-rotation execution** | charter non-goals ("not a Terraform replacement / not an ArgoCD replacement") + anti-CI corollary + gate 6 |

## The SCP Standard Stack (out-of-the-box default)

**Owner decision 2026-07-12.** SCP ships an optional, *advertised* **Standard Stack** — a complete,
coherent, fully-permissive set of execution backends a domain can deploy with **one switch**, or
decline in favor of its own. Every capability is a per-`(class, domain)` **choice**: bring-your-own
(coordinate) or deploy-ours (bundle/own). The coordination brain (promotion, release topology, waves,
gates, approvals, decisions, audit) is **always SCP's, never bundled or optional — it is the product.**

| Capability | Out-of-the-box default | License | Mode |
|---|---|---|---|
| CI / build / **test execution** | **Argo Workflows + Argo Events** | Apache-2.0 | Bundle (B) |
| Container **registry** | ~~**Harbor**~~ → **Gitea** unified registry (superseded, ADR-0012) | MIT | Bundle (B) |
| **k8s CD / deploy** | **Argo CD** + Valkey | Apache-2.0 / BSD | Bundle (B) |
| **Cloud IaC** | **OpenTofu** (`scp-runner-iac`) | MPL-2.0 | Own (C) |
| **Host / config / package** | **Ansible** + closed catalog (`scp-runner-ops`) | GPLv3 (process-isolated) | Own (C) |
| **Code promote + release orchestration** | **SCP core** | — | Always ours |

- **One coherent family.** The bundled supply side is deliberately the **Argo ecosystem** (Workflows +
  Events + CD) + ~~Harbor~~ **Gitea** *(superseded — ADR-0012; Harbor is import-only, not bundled)* — permissive, air-gap-vendorable, one mental model. **Argo
  Events doubles as a driver for the `observe()`/change-detection path** (the known gap) — the bundled
  CI choice and the roadmap's #1 item reinforce each other.
- **SCP never executes CI itself.** Bundled Argo Workflows *runs* the tests/builds; SCP consumes the
  **result** as gate evidence. The anti-CI corollary holds — we *ship* a CI engine, we never *become* one.
- **Easy setup.** Each backend is an opt-in, **off-by-default** Helm profile (`standardStack.enabled`,
  or per-component toggles), deployed into its own namespace, **auto-wired** to its executor binding via
  the idempotent scoped-token install hook. A greenfield org flips one switch and gets build → push →
  deploy → promote end-to-end; a brownfield org leaves them off and points SCP at what it has. The UI
  presents a per-capability checklist: *"CD: ⟨use my ArgoCD⟩ or ⟨deploy one for me⟩."*
- **Charter allowlist impact.** This extends the Mode-B bundle allowlist from `{ArgoCD}` to
  `{Argo CD, Argo Workflows, Argo Events, ~~Harbor~~ **Gitea** — superseded, ADR-0012}` (+ Valkey as Argo CD's cache), all **operator-installed**
  (scpd never applies/upgrades their manifests). Owned runners (Mode C): `scp-runner-iac`, `scp-runner-ops`.
  *(Reflected in the charter's "Bundled Executor Backends" amendment and ADR-0002 — allowlist = this set.)*
- **Honest cost (guardian).** This *is* the turnkey platform-in-a-box the guardian flagged. Legitimate
  because it is opt-in and every piece is unmodified upstream — but each bundled backend is permanent
  CVE-tracking + air-gap re-vendoring surface, so the allowlist stays **charter-anchored** and each
  addition is an owner-signed decision, not open-ended growth.

## The per-layer composition model (the "one service = a mix" answer)

Each **layer instance** is its own Component/DeploymentTarget with its own **1:1 executor binding**;
one change strings heterogeneous executors across waves. *(L6 default corrected per guardian: managed-
execute is never a layer default — the six-gate test is the only router into OWN.)*

| Layer | Default strategy |
|---|---|
| L1 App build/test (CI) | Coordinate-BYO. CI is primarily **gate evidence** (controls); trigger permitted where a Component is explicitly bound for re-run/correlation |
| L2 Artifact/registry | Observe-only (fold into L1 evidence; mid-term observe-only plugin for provenance) |
| L3 k8s GitOps CD | Coordinate-BYO (ArgoCD canonical; per-cluster = per-plugin-instance bindings). Bundle-then-coordinate where the org lacks CD |
| L4 VM/host app deploy | Coordinate-BYO where a controller exists (AWX/AAP/Chef/Puppet); managed-ops **only** where all six gates hold |
| L5 Cloud IaC | Coordinate Mode-1 default; Mode-2 `scp-runner-iac` for pipeline-less orgs |
| L6 Host OS/config/packages | **Coordinate-BYO where any executor exists (Satellite/AWX/AAP); managed-execute via `scp-runner-ops` only where all six gates hold per (class, domain)** |
| L7 DB migrations | **Never executed by SCP.** Rides L3/L1; SCP contributes *ordering* (migration wave before app wave) + expand/contract gate policy |
| L8 Edge/DNS/certs | Collapses into L5 when DNS is IaC; cert-manager rides L3; standalone edge is observe/ignore |
| L9 Secrets | **Never execute, never hold** (fails gate 6, permanently). Rotation = gate controls; sops/sealed-secrets are git data via L3 |

### Acceptance test — the agentkit mapping (guardian-corrected)

Canonical change "ship agentkit to prod": Components per buildable unit → **github** plugin (L1,
CI-green as gate evidence) · GHCR digests → L2 evidence only · **Wave 0 (infra, split per guardian):**
the six terragrunt units must each pass the six-gate test individually — `dns`, `email-inbound`,
`packages-storage` plausibly pass (small, plannable, reversible) → Mode-2 candidates; **`doks-cluster`,
`platform`, `managed-postgres` fail gate 4 (cluster/stateful-DB provisioning is not mechanically
reversible) → COORDINATE** (wrap in a pipeline or keep operator-driven) · **Wave 1:** db-bootstrap
ArgoCD app → argocd(DOKS) — the L7 ordering case is literally an ArgoCD sync-wave app already ·
**Wave 2 (canary):** gamma k3s targets → argocd(k3s instance) + bake/health gate · **Wave 3:** DOKS
prod targets → argocd(DOKS instance). sops + Tailscale carry no bindings (L9/L8). One Service node
legitimately carries five verdicts at once — no unmodeled layer: **the model passes.**

### Composition mechanics — verified in code, not aspirational

Heterogeneous executors across one change's waves are **natively supported today**: bindings are 1:1
per graph object (`executor-bindings-repo.ts:15`); resolution happens independently **per wave target**
at trigger time (`reconcile.ts:591` → `resolveExecutorPluginInstance`), with the plugin id persisted
per wave-target row across worker restarts; ordering comes from `depends_on` toposort or explicit
ReleaseTopology (validated, contradictions rejected); `evaluateWaveGate` runs before every wave — the
seam where cross-layer evidence ("CI green for digest X") gates the infra→app boundary. **Caveat:** the
compiler cannot invent missing `depends_on` edges — a missing infra→app edge silently fan-outs into the
same wave → add a discovery-time control ("every DeploymentTarget has a depends_on to its infra target").

## Prioritized roadmap

| Horizon | Item |
|---|---|
| **now** | Wire the **observe()/status polling driver** (the gap that multiplies everything — it also gates Mode B's product value) |
| **now** | Harden **argocd plugin against real clusters** via the agentkit trial; document per-cluster-instance bindings |
| **now** | Land the **charter amendment + the one combined four-arm/six-gate ADR**; then `scp-runner-ops` per the tier proposal's own steps |
| **near** | Ship a concrete **"CI green for digest X" control** bindable at wave gates (the composition model's signature move) |
| **near** | **GitLab dedicated plugin**; then extract **`@scp/plugin-pipeline-generic`** from Mode-1 (Mode-1 becomes a preset; required structured-evidence schema, `additionalProperties:false` — the only thing separating it from a generic "call any URL" bus) |
| **mid** | Bundled **ArgoCD (+ OpenTofu) opt-in profile** (operator-installed); **registry observation** plugin (observe-only, verb restriction enforced in plugin-api types); Jenkins as generic preset |
| **long** | Flux / AWX / Satellite / Azure DevOps / Pulumi dedicated plugins — each demand-gated behind a real prospect + 1-day API spike |
| **never** | SCP-native CI or artifact build; general shell/runbook executor; per-cloud credential-holding plugins; secret-rotation execution; progressive-delivery control loops |

## Consolidated guardian conditions (all three explorations)

1. **Mode C (managed-execution):** real charter amendment (credential-asymmetry invariant bends);
   SSTI/Jinja2 RCE closure machine-checked; SSH-CA blast-radius analysis + HSM/KMS; enumerated class
   allowlist in the charter. *(Blocking Mode C build.)*
2. **Mode B (bundling):** owner-signed charter **scope decision** (distributor/operator role);
   **backend allowlist = the SCP Standard Stack** (Argo CD ships first); resolve the Valkey-vs-unmodified-upstream contradiction as
   an owned, tested deviation; bundled backends are **operator-installed** (scpd never applies
   manifests — keeps credential asymmetry true even transiently); honest "enabling Mode B adds Valkey
   for that domain" note.
3. **Portfolio:** managed-execute is never a layer default (L6 corrected); the agentkit terragrunt
   units split per the six-gate test (cluster/managed-DB → coordinate); matrix verdicts carry status
   annotations so strategy ≠ shipped support; the aggregate greenfield suite (bundled ArgoCD + OpenTofu
   + two runners) is a de facto turnkey deploy stack — keep each piece opt-in and the allowlists
   charter-anchored so the *combination* stays a sanctioned filler, not the product.

## Owner decisions (consolidated)

1. **Approve the docs package**: one charter amendment (Mode C invariant + Mode B scope decision +
   both enumerated allowlists) + **one combined ADR** (four-arm test, six gates, bundling-flips-gate-1)
   + DESIGN.md §12/§16 edits (three-mode strategy + layer table + agentkit worked example) +
   BUILD_AND_TEST milestone (machine-checked DoDs incl. the observe driver + generic executor).
2. **Bundling flips gate 1** as binding policy (automatic revocation of managed-execute eligibility on
   bundle opt-in). *Recommended: yes.*
3. **Sequencing**: GitLab dedicated plugin first, generic extraction immediately after. *Recommended.*
4. **CI doctrine**: evidence-by-default, trigger permitted where explicitly bound. *Recommended.*
