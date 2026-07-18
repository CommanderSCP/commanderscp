# ADR-0012: Gitea as the default unified registry (image + code + package); Harbor removed from the default stack; scanning as a coordinated step

**Status:** Proposed (2026-07-18)
**Context doc:** [docs/proposals/promotion-and-execution-model.md](../proposals/promotion-and-execution-model.md)
**Relates to:** [ADR-0002](0002-execution-strategy.md) (bundled backends); [ADR-0010](0010-outpost-local-artifact-infra.md) (outpost local infra); [ADR-0013](0013-supply-chain-scan-sbom-manifest.md); M11 (Standard Stack)

## Context

M11.4 bundles **Harbor** as the registry with built-in Trivy scanning. But **Gitea** (bundled for git in M15) has a built-in package registry that speaks **OCI container images** *plus* rpm, npm, Maven, Helm, Go, NuGet, PyPI, Debian, and more — so one service can hold git *and* every artifact type. Meanwhile:

- **CommanderSCP is the promotion authority**, so Harbor's scan-on-push / block-vulnerable-pull policy engine is redundant — SCP simply won't promote a failed-scan artifact.
- Harbor's SCP integration was **never built** (no registry executor, no scan-reading, no auto-wire token hook — its "observe-only" is aspirational), so demoting it discards only bundle plumbing, not integration work.
- Harbor scans **images only**; rpm/npm need a scanning path anyway. A **coordinated Trivy step** (in Argo Workflows) scans *any* artifact type and emits the SBOM in the same pass.

## Decision

- **Gitea is the default unified registry, serving all three artifact classes**: **container images** (OCI registry), **code** (git), and **packages** (its built-in package registry — rpm, npm, Maven, Helm, Go, NuGet, PyPI, Debian, …). One service is the image repo, the code repo, and the package repo. Everywhere (commander and outpost); added to the **Standard Stack (M11)**.
- **Scanning moves out of the registry to a coordinated Trivy step** (Argo Workflows); results are made available to the commander as **gate evidence** (ADR-0013). SCP's coordination engine is the enforcement point, not the registry.
- **Harbor is removed from the default stack — not bundled.** Orgs that want an enterprise Harbor (or already run one) coordinate their **existing** Harbor via the **import path** (M15.3 — bind it as an execution-system), so no capability is lost and SCP ships/maintains one fewer heavy vendored backend. The vendored M11.4 Harbor bundle is retired from the default stack.
- **Outposts run Gitea only** (drop local Harbor). Outposts don't scan (trust-at-source, ADR-0013), so they need no scanning registry — only storage. Gitea is a single light Go binary; Harbor carries its own Postgres + Redis + Trivy + nine images. This meaningfully lightens M15.

## Consequences

**Positive**
- One service is the **image repo + code repo + package repo** — uniform build/store across images, git, and packages (rpm/npm/…).
- Outposts collapse onto a single backend — the biggest weight cut in M15.
- Scanning as a coordinated step is more uniform (all artifact types) and more aligned with coordinate-not-execute (a workflow step whose result gates promotion).

**Costs / honesty**
- Gitea's registry is **less battle-tested at large scale** and has fewer enterprise controls (replication, retention, quotas, robot accounts) than Harbor. That is covered not by keeping a Harbor bundle but by the **import path**: an org that needs Harbor coordinates its *own* Harbor as an execution-system (M15.3).
- The existing M11.4 Harbor bundle is **retired from the default stack** (removed, not kept as an optional bundle) — a write-down of that vendored plumbing, offset by one fewer heavy backend to ship/maintain.
- cosign signs fine against Gitea's OCI registry, so signing is unaffected.
