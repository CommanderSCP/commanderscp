# Renovate: our update bot, and a Standard Stack backend

**Status: PROPOSED 2026-11-25. Owner direction given; pending review.** Owner, 2026-11-25: *"I want to add Renovate as
our mechanism of automating the updating of images and such."* Asked to choose a scope and a host, the owner chose:

- **Scope: "Also bundle for customers."** Renovate keeps the CommanderSCP repo current. It is also shipped as a
  Standard Stack backend that SCP installs and coordinates for orgs.
- **Host: "Self-hosted in GitHub Actions."** Our own Renovate runs as a scheduled workflow using a pinned image. It is not
  the hosted Mend app.

Under the scope choice, our repo is **split by file**. Renovate owns everything except the Standard Stack's vendored
backends, which stay with `scp-managed-dep`'s `re-vendor` strategy (M29.8, ADR-0059). This changes
[zero-to-running.md §9.1](zero-to-running.md) step 1. That step said *"no separate bot is needed"*, and that is now
superseded for everything outside the vendored stack.

Bundling for customers adds a backend to the Standard Stack. The charter requires owner sign-off for that
(*"Extending the backend allowlist beyond the Standard Stack requires owner sign-off"*, PROJECT_CHARTER.md, Managed Standard
Stack). The owner's choice gives the direction, and the amendment text in §4 is for the owner to approve as worded.

## 1. What exists today (measured 2026-11-25)

| Fact | Where |
|---|---|
| No Renovate or Dependabot config in this repo | `grep -rna renovate` finds only the product's detection code |
| SCP already **detects** Renovate/Dependabot in a repo and treats it as the execution system for dependency bumps | `apps/server/src/dependencies/delegation-detection.ts` |
| `scp-managed-dep` enablement is **refused** where Renovate covers the same manifests (gate 1, "no existing executor") | DESIGN.md §`scp-managed-dep`; `assertComponentNotDelegated` |
| Delegation detection honours **only `includePaths`**. `ignorePaths`, `packageRules` and presets are not read, so any narrower config is treated as covering its paths entirely | `delegation-detection.ts:111-125` |
| Stack images and SCP's own images share files | `tools/ci-mirror/images.list` (176 lines), `deploy/airgap/src/bundle-images.ts`, `deploy/helm-bundled/values.yaml` |
| The five vendored backends are re-vendored from upstream release manifests rather than tag-edited | `tools/vendor-refresh`, ADR-0059 |
| CI must run offline, and tooling is vendored | charter principle 5; CLAUDE.md |

## 2. Part A: Renovate for the CommanderSCP repo

### A1. What Renovate owns, and what it does not

| Owned by Renovate | Owned by `scp-managed-dep` (`re-vendor`, M29.8) |
|---|---|
| npm (pnpm workspace + lockfile) | `deploy/helm-bundled/vendor/**` (Argo CD, Workflows, Rollouts, Events, Gitea manifests) |
| Dockerfiles' base images | The stack's images and companion images (Dex, argoexec, Valkey, …) wherever they are pinned |
| GitHub Actions (pinned by SHA) | |
| `tools/*` pinned binaries (helm, cosign, skopeo, trivy, node, busybox, openscap) via custom regex managers | |
| CI and runner images in `tools/ci-image`, `tools/ci-mirror` that are not stack images | |
| Helm chart deps in `deploy/helm` | |

**The boundary has to be a file boundary.** Delegation detection reads only `includePaths`. If Renovate's config names a
file that also holds a stack image, SCP refuses to manage the stack on its own repo. That is correct product behaviour,
since two bots would edit one file. Two ways to make the boundary hold:

- **(Recommended) Split the shared files.** Stack images move to their own files, for example `images.stack.list` and a
  separate `STACK_IMAGES` module next to `bundle-images.ts`. Renovate's `includePaths` lists only files that hold no stack
  image. This needs no product change, and the detection code stays strict.
- *(Alternative)* Teach delegation detection to read `ignorePaths` and per-`depName` disables. That is more surface in a
  security-relevant parser, and it is the kind of "comment names a hazard" change CLAUDE.md warns about.

A **standing census test** asserts that no file under Renovate's `includePaths` contains a stack image reference. The
reader is `parseKubernetesImages` plus the regex managers' own patterns. The test runs offline and is mutation-proved by
adding one stack image to a Renovate-owned file.

### A2. Where it runs

- A new workflow, `.github/workflows/renovate.yml`, runs on a schedule (daily, plus `workflow_dispatch`). It is the **only**
  workflow allowed to egress, and it is separate from `ci.yml`, which stays offline. Like `tools/vendor-refresh`, it is a
  maintenance tool, not CI.
- The Renovate image is **pinned by digest** and mirrored through `tools/ci-mirror`, and Renovate updates its own pin.
- **Credential:** a GitHub App installed on `CommanderSCP/commanderscp` only, with contents, pull-requests and issues
  write access. `GITHUB_TOKEN` won't work, because PRs it opens do not trigger `ci.yml`. A fine-grained PAT ties the bot
  to one person.
- `postUpgradeTasks` with an `allowedCommands` allowlist runs `pnpm install --frozen-lockfile=false`, then `pnpm gen`
  when a dependency feeding codegen moves. This keeps the "codegen outputs are committed" gate green on bot PRs.

### A3. Merge policy

This is the same table as zero-to-running §9.1 step 4, applied to Renovate's `packageRules`:

| Change | Merge |
|---|---|
| Security fix (CRITICAL/HIGH, via `vulnerabilityAlerts`/OSV) | Automatic once `ci.yml` is green |
| Patch, digest pin refresh | Automatic once green, grouped weekly |
| Minor | PR, reviewed |
| Major | PR, labelled, planned as its own work |

Automerge relies on branch protection requiring `ci.yml`, so Renovate cannot merge red. The Dependency Dashboard issue
is on.

### A4. Dogfooding

The CommanderSCP repo is registered on the homelab commander, so Renovate's PRs show up in SCP as **observed Changes from
an execution system**. That is exactly the coordinate-not-execute shape, and nothing new is needed for it.

## 3. Part B: Renovate in the Standard Stack (customer-facing)

### B1. Shape

- **Renovate is a sixth Standard Stack backend**, `renovate`, installed by `scp-stackd` like the others, with its own
  namespace and BYO/import per the Managed Standard Stack amendment.
- **It runs as an Argo Workflows `CronWorkflow`**, using a pinned `renovate/renovate` image and no long-running controller.
  It adds no stateful service, and an optional repository cache goes on a PVC or is off. PostgreSQL stays the only
  required stateful dependency.
- **Forges:** Renovate supports Gitea, GitLab, GitHub and Bitbucket, which covers every forge the stack can hold.
- **Credentials:** the forge token and registry/datasource credentials are entered through SCP and written straight into
  Renovate's Secret by the stack controller (M29.5, ADR-0063). `scpd` never holds them.
- **Air-gap / outposts:** Renovate only reaches datasources the domain can reach. Commanders use upstream registries.
  Outposts point `hostRules`/`registryAliases` at the domain's mirrors, or Renovate is off by role (proposed default:
  **on for commander, off for outpost/retrans**, the same rule as dependency polling being commander-only).

### B2. How it relates to `scp-managed-dep` (the main design question)

With Renovate bundled and **on by default**, gate 1 ("no existing executor") fails on every repo Renovate covers, so
`scp-managed-dep` would rarely run. The proposed model:

- **Renovate is the execution system for dependency bumps. SCP coordinates it.** Dependency subscriptions (ADR-0032) stay
  the desired-state surface, and **SCP renders them into Renovate configuration**. That means a stack-managed preset repo
  plus per-repo `extends`, written by the stack controller, so that "CommanderSCP is the surface". Users don't hand-edit
  Renovate config unless they opt out.
- **Renovate PRs are observed as Changes.** Merge policy, gates and quorum apply through SCP. Renovate's own `automerge`
  is **off** for stack-managed repos, so SCP's existing governed auto-merge control decides (ADR-0032 §8d).
- **`scp-managed-dep` stays** for the cases Renovate can't do: `re-vendor` of upstream install manifests, and orgs that
  choose to run without Renovate (BYO "none").

### B3. Licence

Renovate is **AGPL-3.0**. We would ship the unmodified upstream image as a separate container, invoked as a process,
which is the usual aggregation case. This still needs an **owner/legal check before bundling**, because shipping it in
the air-gap bundle is distribution.

## 4. Proposed charter amendment text (for owner approval)

Append to **Managed Standard Stack**:

> *Amendment approved YYYY-MM-DD (owner decision, docs/proposals/renovate.md).* Renovate is added to the Standard Stack
> as the execution system for dependency updates. It runs as a scheduled workflow on the bundled Argo Workflows, holds
> only the forge and datasource credentials brokered to it by the stack controller, and is coordinated like every other
> backend: dependency-update desired state is declared through CommanderSCP, and Renovate's pull requests are observed
> and governed as Changes. `scp-managed-dep` remains for re-vendoring and for organizations that run without Renovate.

## 5. Questions for the owner (each has a recommendation)

| # | Question | Recommendation |
|---|---|---|
| R1 | Split shared image files (A1), or teach delegation detection more Renovate syntax? | Split the files |
| R2 | GitHub App or fine-grained PAT for our Renovate? | GitHub App |
| R3 | Customer Renovate on by default, and for which roles? | On for commander, off for outpost/retrans |
| R4 | Who merges a customer Renovate PR: Renovate's automerge, or SCP's governed control? | SCP's governed control |
| R5 | AGPL-3.0: is a legal check required before Part B ships? | Yes, before B ships; A is unaffected (we don't distribute it) |
| R6 | Approve §4's amendment text as worded? | Yes after R4 |

## 6. Plan placement

- **Part A** lands as **M29.8(c)**, alongside (a)/(b), because it is the same "the stack stays current" goal. It does
  not block (b). The file split (R1) lands before (b)'s default-on subscriptions so that SCP's own enablement is not
  refused.
- **Part B** is a new milestone, **M30**, after M29. It depends on M29.4 (stack controller), M29.5 (credentials) and M29.2
  (auto-wire).
