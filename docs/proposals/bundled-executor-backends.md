# Proposal — Bundled Executor Backends ("batteries-included coordination")

> **Status: Exploration — pending owner decision.** Companion to
> [managed-execution-tier.md](managed-execution-tier.md). Captures a multi-lens design exploration
> (2026-07-12) of SCP optionally **bundling a real executor backend** (canonical: ArgoCD) so a
> team/domain that lacks one gets it *from* SCP — while SCP still only **coordinates** it. Where
> anything here conflicts with the charter, the charter governs.

## The steer

Owner intent: teams should have **options**; for complex CI/CD "there's no reason to reinvent" — so
could SCP ship systems like ArgoCD *under the hood* and handle the rest itself?

## The headline finding

**Bundling preserves the credential-asymmetry invariant — Principle 1 holds *unamended*.** The bundled
ArgoCD keeps the kube credentials and its own reconcile loop; SCP holds only a **scoped ArgoCD API
token** (never admin) and speaks the same `observe/trigger/status/abort` interface it uses for a
BYO ArgoCD (`packages/plugins/argocd` — only stable `/api/v1` calls). This is a structurally *cleaner*
fit than the managed-execution tier, which is why that one needed a charter amendment and this one
does not — **on the credential axis**. (The guardian's caveat lands on a different axis; see below.)

## One strategy, three modes (the unifying frame)

One unchanged `ExecutorPlugin` interface; one question per `(class-of-change, domain)`: *"does a mature
execution system exist for this class, and where do its infra credentials live?"*

| Mode | When | Credential posture | Charter touch |
|---|---|---|---|
| **A — BYO-coordinate** (default, always preferred) | Domain already runs the system (ArgoCD, real CI, TF pipeline) | SCP holds a scoped API token to *their* system | None — core identity |
| **B — Bundle-coordinate** | A mature, self-contained execution *service* exists as software but the domain lacks it | Backend keeps its own infra creds + reconcile loop; SCP holds a scoped API token | Scope decision (see guardian) — **not** a Principle-1 amendment |
| **C — Managed-execute** | No mature executor exists; simple declarative long tail (RPM/config/systemd) | SCP itself holds scoped host creds in an ephemeral runner | **Real charter amendment** (approved-in-principle; see companion doc) |

The B/C dividing line: **B is for credential-holding services** (bundle + coordinate); **C is for the
simple long tail** where no such system exists. **IaC deliberately sits in C** (`scp-runner-iac`), not B —
a `tofu` CLI has no persistent creds/loop of its own to coordinate, so "bundling" it yields no
asymmetry win.

## How bundling works (the four rungs, and the line)

1. **SHIP** — vendor pinned upstream images/manifests into the signed `scp-bundle` as OCI layout
   (exactly like `scpd`/`scp-runner-iac`/eval-postgres today, DESIGN §16). **Never a live upstream Helm
   subchart** — §16 already rejects subcharts/operators (licensing/registry churn; a live subchart pulls
   external images at install = air-gap break).
2. **DEPLOY** — opt-in, **off-by-default** Helm profile (`bundledExecutor.argocd.enabled: false`), a
   clone of the `managedIac` profile shape; own namespace, own limits, per-host egress allow mirroring
   `allow-postgres`/`allow-nats`.
3. **AUTO-WIRE** — post-install hook mints a **scoped** ArgoCD apiKey account (sync+get, project-scoped,
   never admin), stores it in SCP's secret store, seeds the executor binding at the in-cluster Service
   DNS. Enabling the profile yields a ready executor with zero token plumbing. *(Hook must be idempotent
   + non-fatal to core SCP install — guardian condition.)*
4. **OPERATE** — SCP owns the pin, CVE tracking, upgrade/rollback docs, and a narrow supported-version
   matrix.

**Three prohibitions define the line:** never **fork/patch** the engine (fixes flow from upstream — the
Weave lesson); never promise "identical to upstream" while hardening (own the support boundary honestly —
the OpenShift GitOps trap); never let the bundled backend become **load-bearing for SCP itself** (the
Rancher/Fleet trap — machine-check that the profile-off manifest set has no Valkey and the two-container
floor holds).

**Key operability decisions:**
- **Upgrade decoupling:** the ArgoCD image is an independently-bumpable value (like
  `managedIac.runnerImage`) defaulted to a per-release tested pin — an ArgoCD CVE patch does not wait for
  an SCP release. *(Guardian narrowing: true for in-range **patch** bumps; minor/major upgrades ride an
  SCP release because SCP owns the rendered manifests/CRDs. Publish the matrix with that distinction.)*
- **Failure isolation holds both ways by construction:** SCP-down ⇏ deploys-stop (ArgoCD keeps its own
  loop + creds — charter: coordination-down ≠ services-down); ArgoCD churn surfaces to SCP only as
  retryable executor HTTP errors.
- **Federation:** the bundled backend is **per-child/per-domain** (executors are domain-local, DESIGN
  §13), enabled by each child's own values, never parent-distributed. Air-gapped children get a deploy
  engine via the same signed bundle — a strong story.

## Licensing matrix (facts to verify with counsel — not legal advice)

| Component | License | Verdict |
|---|---|---|
| **ArgoCD** | Apache-2.0 (CNCF graduated) | **Bundle** — canonical |
| **Valkey** (Redis fork) | BSD-3-Clause (LF) | **Bundle as ArgoCD's cache** — see contradiction below |
| **Redis 7.4+/8** | SSPL/RSALv2, then AGPLv3 | **Do not bundle** — the one real licensing landmine |
| **Flux** | Apache-2.0 (CNCF) | Bundleable later (no Redis at all); explicitly **deferred** |
| **OpenTofu** | MPL-2.0 | Not this path — routes to Mode C (`scp-runner-iac`) |
| **Terraform** | BUSL-1.1 | **Never** — competing-product restriction |
| **ansible-core** | GPLv3 | **Quarantine** — Mode C runner only, process-isolated; never in-image with scpd |
| Atlantis/Jenkins/Tekton/Argo Workflows | mixed | Tier B — **not prioritized** (and see guardian: a standing backlog is itself the creep vector) |

## Guardian verdict — `needs-amendment`, but on the *scope* axis

The guardian **agrees Principle 1 holds unamended** — the credential story is genuinely clean. Its
`needs-amendment` lands on **product scope / Simplicity (#1)**: the four-rung SHIP/DEPLOY/AUTO-WIRE/
OPERATE machinery makes SCP a **distributor + lifecycle-operator of a deploy engine** the charter's
product boundaries say it "is not." Conditions before build:

1. **[MAJOR] A real, owner-signed charter *scope decision*** (decision-log entry, parallel to the
   2026-07-08 entries) stating bundling+operating unmodified upstream engines is in-scope — and
   explicitly **not** a coordination-principle amendment. Not a "light note."
2. **[MAJOR] A hard, charter-anchored enumerated backend allowlist** — **v1: ArgoCD only** (Valkey as its
   mandated cache; Flux explicitly deferred); owner sign-off required to extend. A ranked Tier-B backlog
   is itself the scope-creep vector ("any permissively-licensed service a customer lacks" = the
   GitLab/OpenShift-distro slide).
3. **[MAJOR] Resolve the Valkey contradiction:** mandating Valkey-for-Redis **is** a modification of
   upstream's shipped composition, which contradicts "never fork/patch, unmodified upstream." Either own
   it as a **supported deviation** (SCP tests ArgoCD-on-Valkey per pin — accepting that compat burden), or
   keep upstream Redis and solve licensing another way. Must be explicit before claiming "no amendment."
4. **[MINOR] Honest Principle-4 framing:** enabling Mode B adds a stateful service (Valkey) *that domain*
   must run/back up — SCP itself never requires it, but stop implying the added surface is free.
5. **[MINOR] The `observe()` gap gates Mode B's product value:** bundling ArgoCD without the
   observe/status-polling loop wired (tracked follow-up — see `scp-observe-not-wired`) does not deliver
   "batteries-included coordination" by itself. Bundle + change-detection are separate deliverables;
   the ADR must say so.

## Pivotal owner decisions

1. **Scope:** GitOps-only for Mode B (IaC stays Mode C)? → *Recommended: yes — the single most important
   scoping call; keeps B and C non-overlapping.*
2. **Valkey vs Redis** for the bundled cache → *Recommended: Valkey as an owned, tested, supported
   deviation (per guardian condition 3), enforced by a bundle-time license scanner.*
3. **Upgrade ownership** → *Recommended: decoupled image value + narrow support matrix (patch-bumps
   off-train; minor/major on-train).*
4. **Support posture** → *Recommended: unmodified upstream (modulo the owned Valkey deviation), never
   fork, disposable wrapper.*
5. **Go/no-go** → *Recommended: approve ArgoCD-first, strictly opt-in + inert-by-default, with the
   charter-anchored v1 allowlist (ArgoCD only) and the never-load-bearing CI invariant.*

## Required doc changes (if approved)

- **`PROJECT_CHARTER.md` decision log** — the owner-signed **scope decision** (bundling in-scope; not a
  Principle-1 amendment) + the **enumerated v1 backend allowlist (ArgoCD only)**.
- **`docs/adr/NNNN-bundled-executor-backends.md`** — the three-mode strategy, four rungs + three
  prohibitions, Valkey deviation ownership, support matrix, auto-wire failure-isolation analysis, the
  observe()-gap dependency.
- **`docs/DESIGN.md §12/§16`** — Mode B subsection + bundle-vendoring mechanics + the honest "enabling
  Mode B adds Valkey for that domain" note.
- **`docs/BUILD_AND_TEST.md`** — machine-checked DoD: profile-off = no Valkey + two-container floor;
  license scanner; offline install/upgrade drill for the bundled profile.
