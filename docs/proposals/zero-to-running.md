# Zero to running: the Standard Stack behind CommanderSCP

**Status: DIRECTION ACCEPTED 2026-09-25.** The owner answered §7's questions by ruling on the principle: *"If that goes
against the current charter, then the current charter must be fixed … CommanderSCP must be the surface. Though ideally
CommanderSCP makes things automatic except where users set things to be manual (ex: manual deploy steps within a
CommanderSCP pipeline)."* The charter now carries the **Managed Standard Stack** amendment and two adoption principles,
**CommanderSCP Is the Surface** and **Automatic by Default** (PROJECT_CHARTER.md, 2026-09-25). The §7 recommendations are
adopted as D1–D4:

- **D1 (Q1):** a separate stack controller installs and operates the bundled backends.
- **D2 (Q2):** credentials use write-only passthrough, with workload identity preferred.
- **D3 (Q3):** the Standard Stack is on by default for a new install, sized by role.
- **D4 (Q4):** backend UIs are hidden, with an audited, read-only break-glass link. **Refined the same day:** two
  kinds of UI are deliberately left open, as below.

**Refinements, owner 2026-09-25 (second ruling):**

- **D5, bring-your-own means import and take over.** A customer who already runs Argo CD, Gitea, Harbor, GitLab or
  GitHub imports it into the stack, and from then on SCP operates it like a bundled one. Import is the entry path; the
  customer is not asked to keep operating it by hand.
- **D6, the git forge is a choice:** bundled Gitea, GitLab or GitHub. The artifact registry is likewise a choice:
  bundled Gitea (ADR-0012), an imported Harbor, GHCR, and so on.
- **D7, the two exceptions to "SCP is the entire surface":**
  1. **Git repositories:** the forge's own UI, for pull requests, review and browsing code.
  2. **Artifact repositories** (images, RPMs, npm packages, …): the registry's own UI, for browsing what is available.

  Everything else about those systems (creating repos, access, webhooks, tokens, retention, upgrades) still happens
  through SCP. Every other backend UI stays hidden, per D4.

**Open under D5: what "takes over" means for an imported instance.** SCP can operate an imported system's configuration
(access, projects, webhooks, tokens, the wiring in §6) without owning its installation. Taking over its *lifecycle* as
well (upgrades, sizing) means SCP applying its own manifests over an install someone else made, which is safe only when
that install matches a shape SCP recognises.

- **Recommendation:** configuration takeover on import by default. Offer lifecycle adoption as an explicit step when the
  install is recognised (for example an upstream-manifest Argo CD) and refuse it, with the reason, when it is not.
- **SaaS forges** (GitHub, GitLab.com) only ever get configuration takeover.

§8 (M29) is the build plan, pending the owner's go.

## 1. The goal, in the owner's words

*"All of these services should sit behind the scenes. They shouldn't ever actually need to go to these for any setup or
really any operations. It all should be done through CommanderSCP. Whether it be a Commander, Outpost, or Retrans."*

The customer in view has nothing: no Argo CD, no Argo Workflows, no Gitea, no Argo Rollouts, no registry. They install
CommanderSCP, and from then on every setup and operational act (enabling a capability, connecting a repo, adding a
credential, upgrading, rotating, diagnosing) happens through SCP's API, SDK, CLI, IaC and UI (charter principle 3). The Argo
family and Gitea become implementation details of an SCP install: present, healthy, upgraded and wired, but never a surface
the customer has to learn.

## 2. What that customer faces today (measured 2026-09-25)

There is no single entry point. The repo has no root README and no quickstart; there is no `scp init`/`scp setup`; the web
app's home route is the ordinary dashboard (`apps/web/src/router.tsx:53-66`), and the useful `/setup` checklist
(`apps/web/src/routes/setup.tsx`) is not linked from it. A newcomer has to discover, independently, which `deploy/` folder
to install from, that `scripts/scp-bundled.sh` exists, and that `/connect/$kind` and `/setup` exist.

The steps they would then take, and where each breaks the goal:

| Step | Today | What breaks the goal |
|---|---|---|
| Install SCP | Three unrelated paths: compose (eval only), `helm install` with hand-made Secrets, air-gap `install.sh` | No role choice, no profile choice, no guidance |
| First login | Bootstrap password printed once to the **api pod log** (`apps/server/src/auth/local-auth.ts:95-97`) | Requires `kubectl logs`: the first thing the customer does is leave SCP |
| Argo CD / Gitea | `scp-bundled.sh enable <backend>`; auto-wire mints a token, **but never creates the execution-system object**, and the bind command is printed **only to the Job's pod log** (`apps/server/src/bundled-argocd-autowire-bin.ts:139-150`) | Half-wired; the finishing step is in a log |
| Argo Workflows | Bundled, but **no auto-wire** (`deploy/helm/values.yaml:707-718`, whose comment is also stale: the bundled server runs `--auth-mode=client`); TLS trust (`executorTls`) set by hand from a hint the script prints | Token, TLS and registration all manual |
| Gitea | **Bundled:** `scp-bundled.sh enable gitea` stands it up and auto-wire mints its token, with the same execution-system gap as Argo CD. **An existing Gitea** (bring-your-own): no `scp connect gitea` and no wizard, only `scp executor bind --module gitea` | Bundled Gitea is half-wired; connecting an existing one has no guided path |
| Egress | Declared in SCP **and** allowed again in operator env (`SCP_INTERNAL_EGRESS_HOSTS`) **and** in NetworkPolicy values (`deploy/helm/values.yaml:936-939`) | Three places; any one missing fails quietly |
| Canary | Host the authoring carrier chart in a repo **you control**, then re-run `scp connect argocd --authoring-*` (ADR-0055); omit it and the canary **silently becomes a plain rolling update** | Needs a repo the customer does not have yet |
| Build / infra | Hand-create `scp-build-registry`, `scp-infra-plan-credentials`, `scp-infra-apply-credentials` Secrets in the Argo namespace; set chart values without which the RPM and infra templates **silently do not render** | `kubectl create secret` and chart values |
| Operations | `helm upgrade --reuse-values` drops new defaults (`deploy/helm/values.yaml:1070-1075`); `scp_operator` needs a manual `ALTER ROLE` (`deploy/helm/README.md:414-439`); `helm uninstall` leaves Secrets and the eval Postgres behind | Operating the stack means operating Helm and Kubernetes |

What already exists and should be kept: `scp-bundled.sh` renders, applies server-side, waits and diagnoses in one command;
the auto-wire Jobs; `scp doctor`; the signed air-gap `install.sh`; the `/setup` checklist; the manifest-driven
`/connect/$kind` wizard; `tools/helm-verify`, which gates every wiring claim structurally.

## 3. The model: SCP installs and operates its own Standard Stack

Two kinds of software sit on either side of charter principle 1, and keeping them apart is what makes this possible without
eroding it:

- **The execution systems themselves** (Argo CD, Argo Workflows, Argo Rollouts, Argo Events, Gitea). Installing,
  upgrading and configuring *these* is software lifecycle, the same job `scp-bundled.sh` and `install.sh` already do at
  deploy time.
- **The infrastructure those systems manage** (the customer's clusters, clouds and hosts). Principle 1 stays exactly as it is
  for this: SCP never holds credentials to it and never executes against it, apart from the scoped Managed Execution
  Exception.

The proposal moves the first kind from "a script the operator runs once" to **a component of SCP that keeps it in its
desired state**, the **stack controller**. It is a small, separately deployed controller (`scp-stackd`), not part of `scpd`.
It holds cluster rights to install and upgrade the bundled backends in their own namespaces and **nothing else**. It reads a
declarative desired state that SCP's API writes (which backends, which versions, which sizing, which wiring). `scpd` keeps
only scoped API tokens, exactly as today (Mode B, ADR-0002). The separation is the point: the process that coordinates
changes never gains the rights of the process that installs software, and neither holds infrastructure credentials.

The Standard Stack follows SCP's version: one SCP upgrade upgrades every backend to the versions that release was tested
with. The customer never picks an Argo version.

## 4. The customer journey this produces

1. **Install, one command, any substrate.** `scp install --role commander|outpost|retrans [--profile eval|production]
   [--bundle <air-gap bundle>]`, run against a kube context or a VM (compose). It installs SCP, the stack controller and the
   role's default stack, then prints the admin URL and a one-time password **to the installer's own terminal**.
   The stack is presented as choices with the role's defaults pre-selected (for example Gitea as the registry
   and git forge on a commander or outpost). The user can switch any backend off, or point SCP at one they
   already run (an existing Gitea, GHCR, Argo CD). Whatever stays selected is stood up and wired automatically.
2. **First run is a wizard, not a dashboard.** An org with nothing configured lands on the first-run flow (today's `/setup`
   checklist, promoted to the home route):
   - connect a source (GitHub/GitLab app, or the bundled Gitea);
   - register a first service from a repo (the existing discovery/scaffold path);
   - name the environments.

   Targets are created under the HQ outpost (GLOSSARY "HQ outpost"), which is declared automatically at install.
3. **Capabilities are switches in SCP, not installs.** "Enable canary deployments" or "enable infra plan/apply" is a toggle
   on a **Stack** page (and `scp stack enable rollouts`). The stack controller installs, wires and health-checks it, and the
   page shows when it is ready. There is no chart value, no Secret and no log to read.
4. **Credentials are entered once, in SCP** (registry push token, cloud credentials, git token), and land where the backend
   needs them. How they may travel is charter question Q2 (§7).
5. **Operations stay in SCP.** The Stack page shows each backend's health, version, last upgrade and recent failures;
   rotating tokens and certificates is a button; a diagnostics bundle is a download. The backends' own UIs are not exposed
   by default (Q4).

## 5. Per role

| Role | Default stack | Why |
|---|---|---|
| **Commander** | Argo Workflows (build, scan, sign: the commander scans and signs per ADR-0013/0020) · Argo Events · Gitea (default registry, ADR-0012) · **plus** Argo CD + Argo Rollouts for its own targets, because the commander is its own HQ outpost | One install covers a single-domain customer end to end |
| **Field outpost** | Argo CD · Argo Rollouts · Gitea (outposts are Gitea-only, ADR-0012) · Argo Workflows **only if** the domain builds or plans locally (M18 dev pipelines, domain-owned infra) | Outposts stay light; deploy-side only by default |
| **Retrans** | None | A relay validates and forwards; it runs nothing |

## 6. What auto-wiring must cover (the gaps in §2, closed)

- **Registration.** Every bundled backend is registered as an `execution-system` object, with its scoped account, token,
  TLS trust and NetworkPolicy egress, in one step. No bind command is ever printed for a human to run. This covers Argo
  Workflows, which has no auto-wire today, and Gitea.
- **Egress in one place.** Declaring a bundled backend opens the app-layer allowlist and the NetworkPolicy together,
  because the stack controller knows both ends.
- **The authoring carrier is served by the bundled Gitea.** The dedicated AppProject is created at enable time. Canary works
  the moment Rollouts is switched on, and a component that asks for a canary where authoring is off is **refused with a
  Decision**, never silently rolled.
- **Templates that cannot render say so.** A catalog template missing a required value shows as "needs: state backend" on
  the Stack page instead of silently not rendering.
- **Allowlists stay authority decisions.** Namespace, repo and source allowlists remain explicit, `secret:write` gated
  choices, but the wizard **proposes** them in context ("you registered repo X; allow it to build with these
  credentials?") so the decision is one confirmation rather than a hunt.
- **BYO stays first-class (Mode A).** Every backend can be "use mine" at install or later; the managed stack is the
  default, not the only path.
- **Air-gap parity.** `scp install --bundle` consumes the signed bundle and runs the identical wiring; `install.sh`'s logic
  moves behind it.

## 7. Questions for the owner (charter-level; each has a recommendation)

- **Q1: Does SCP install and operate its own bundled executors at runtime?** The stack controller of §3 is new privileged
  software.
  - **Recommended:** yes, as a separate component with cluster rights scoped to the backends' namespaces. Amend principle 1
    to say SCP may install and operate the execution systems it bundles, never the infrastructure they manage.
  - Alternative: installation stays a deploy-time script. §4 steps 3 and 5 then cannot exist.
- **Q2: How do credentials get from SCP's UI to the backend?**
  - **(a) Recommended: write-only passthrough.** SCP accepts the value and the stack controller writes it straight into the
    backend namespace's Secret. `scpd` never persists it and has no read-back path; the audit event records who wrote which
    key, never the value.
  - (b) Workload identity only (IRSA, Roles Anywhere, GKE WI): nothing is ever entered, but it is unavailable on many
    homelab and on-prem clusters.
  - (c) The customer creates Kubernetes Secrets, as today. This breaks the goal.
  - Recommend (a), with (b) preferred wherever the substrate supports it. Today's charter reads as forbidding SCP from
    holding these; (a) is designed so it never does, but that is for you to rule on.
- **Q3: Is the Standard Stack on by default?**
  - **Recommended:** yes, on by default for new installs, with BYO chosen per backend.
  - This touches principle 4 (PostgreSQL is the only *required* stateful dependency): Gitea needs storage, and Argo CD
    brings Valkey. Keeping them optional-but-default preserves the letter of principle 4. Having Gitea use a separate
    database on SCP's own Postgres server keeps the stateful footprint to one engine.
- **Q4: Are the backends' own UIs reachable?**
  - **Recommended:** not exposed by default. A break-glass, read-only, time-boxed link sits on the Stack page, audited, for
    support and debugging. Every *write* stays through SCP.

## 8. Proposed milestone: M29, "zero to running"

Each increment below has a machine-checked DoD in the M28 style, including the rule that deleting the wiring turns a test
red.

- **M29.1 Front door.** Root README and quickstart; `scp install` (role + profile, connected and air-gap); the admin
  credential shown by the installer, never only in a log; the first-run flow as the home route for an empty org; the HQ
  outpost declared at install.
- **M29.2 Complete auto-wire.** Every bundled backend registered as an execution system, with token, TLS trust and egress
  in one step, Argo Workflows and Gitea included; `scp connect gitea`; stale chart comments corrected.
- **M29.3 Canary out of the box.** The authoring carrier on the bundled Gitea, the AppProject at enable time, and refusal
  (not silent degradation) when authoring is off.
- **M29.4 Stack controller and Stack page** (after Q1). Enable, disable, health, version, upgrade-with-SCP, rotate,
  diagnostics; `scp stack …`; IaC parity.
- **M29.5 Credentials through SCP** (after Q2).
- **M29.6 Role stacks.** Outpost and retrans profiles; field outposts get their stack from the same installer.
- **M29.7 The proof, as a standing CI gate.** A fresh kind cluster goes from `scp install` to an image build, a canary
  deploy that advances through its steps, and an infra plan and apply, with **no command addressed to any backend** (no
  `kubectl` into a backend namespace, no backend URL). This is also the first run of the M28 lanes against real
  controllers, which M28 never had.
