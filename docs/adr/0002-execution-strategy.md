# ADR-0002: The execution strategy — three modes, one ownership test, one boundary test

| | |
|---|---|
| **Status** | **Accepted** — owner-approved 2026-07-12 |
| **Date** | 2026-07-12 |
| **Deciders** | Owner (jag8765) |
| **Relates to** | [DESIGN.md §12 (Executor Integrations)](../DESIGN.md), [DESIGN.md §16 (Deployment & Packaging)](../DESIGN.md), PROJECT_CHARTER.md (Managed Execution Exception — amended 2026-07-12; Bundled Executor Backends — scope decision 2026-07-12), the three explorations in [docs/proposals/](../proposals/) ([execution-strategy.md](../proposals/execution-strategy.md), [managed-execution-tier.md](../proposals/managed-execution-tier.md), [bundled-executor-backends.md](../proposals/bundled-executor-backends.md)), [BUILD_AND_TEST.md §8 M10](../BUILD_AND_TEST.md) |

> This ADR is the **normative home** of the four-arm ownership test and the six-gate boundary test. The three proposals hold the exploratory detail (threat analyses, licensing matrix, per-layer composition model, agentkit worked example) and remain the record of *why*; where any of them conflicts with this ADR or the charter, this ADR and the charter govern. One combined ADR is deliberate — the tests reference each other (gate 1 is the router; bundling flips gate 1) and separate documents would drift.

## Context

The charter's coordination boundary is enforced twice in DESIGN §12: the ExecutorPlugin verb set has no execute/deploy primitive, and **credential asymmetry** — SCP holds credentials to execution systems' APIs, never to the infrastructure those systems manage. One scoped exception exists (owner decision, 2026-07-08): the `scp-managed-iac` executor with its ephemeral `scp-runner-iac` image.

Owner steer (2026-07-12): teams should have **options** — SCP is not trying to replace mature execution systems, but standing one up is itself per-team toil, and the long tail of small operational changes (packages, config files, cron/systemd units) often has no executor at all. Three explorations examined this from different angles and converged: a managed-execution tier beyond IaC (`scp-runner-ops`, host-reaching — bends the credential-asymmetry invariant, needs a real charter amendment), bundled executor backends (ArgoCD supply-side — credential asymmetry holds unamended, but SCP becomes a distributor/operator, needs a charter scope decision), and a portfolio synthesis that unified both under one strategy. The adversarial guardian reviewed all three; its corrections are folded in below as binding preconditions, not advisories.

Without a single governing test, three failure modes loom: the managed tier creeps class-by-class into a general runner platform (the AWX/Rundeck/Salt shape the charter rejects); bundling creeps backend-by-backend into a distro (the GitLab/OpenShift slide); and the two modes silently compete for the same classes, making "own only when nothing else exists" false. This ADR fixes the strategy, the tests, and the guardrails in one place.

## Decision

### 1. Three modes, one interface

SCP's executor portfolio is a three-mode surface behind the **one unchanged `ExecutorPlugin` interface** (`observe/trigger/status/abort` — no execute/deploy verb, ever):

| Mode | When | Credential posture | Charter touch |
|---|---|---|---|
| **A — BYO-coordinate** (default, always preferred) | The domain already runs an execution system for the class | SCP holds a scoped API token to *their* system | None — core identity |
| **B — Bundle-coordinate** | A mature, self-contained, credential-holding execution *service* exists as software but the domain lacks it | The bundled backend keeps its own infra creds + reconcile loop; SCP holds a scoped API token | Charter **scope decision** (distributor/operator role in-scope) — explicitly **not** a coordination-principle amendment |
| **C — Managed-execute** | No mature executor exists and the class is too small to justify a backend | SCP itself holds scoped, short-lived host/infra creds inside an ephemeral runner | Real charter **amendment** (credential-asymmetry invariant bends; enumerated class allowlist lives in the charter) |

Mode C comprises exactly **two** owned, closed-catalog, ephemeral runners: `scp-runner-iac` (approved 2026-07-08) and `scp-runner-ops` (approved 2026-07-12, subject to the preconditions in Consequences). Mode B's backend allowlist is the **SCP Standard Stack** (owner-approved 2026-07-12; see [execution-strategy.md](../proposals/execution-strategy.md) §"The SCP Standard Stack"): **Argo CD** (canonical GitOps CD — ships first; Valkey as its mandated cache, owned as a tested supported deviation), **Argo Workflows + Argo Events** (bundled CI / build / test), and **Harbor** (bundled registry) — all CNCF-graduated and permissively licensed (Apache-2.0 / BSD), deliberately one ecosystem; Flux explicitly deferred. Extending the allowlist beyond the Standard Stack requires owner sign-off. IaC deliberately sits in Mode C, not B — a `tofu` CLI has no persistent credentials or reconcile loop of its own to coordinate, so bundling it yields no asymmetry win.

### 2. The four-arm ownership test

Run per **(class-of-change, layer, domain)** — never per tool. Default verdict: **COORDINATE**. The verdict is governed, federated **graph data** (a property on the relationship, carried per domain by federation), never a plugin-install decision.

- **Q0 — IGNORE:** does SCP need to model/govern this class at all? (Dev tooling, CI caches, standalone ingress → unbound graph inventory at most.)
- **Q1 — COORDINATE:** does the domain have an existing execution system for this class? *(= gate 1 of the six-gate test, reused as the router.)* If yes — coordinate, full stop. *Dedicated-plugin vs generic sub-test:* a dedicated plugin only if the system has high prevalence in a target profile **and** ≥2 of {correlation richness, native abort matters, non-trivial auth}; otherwise the generic pipeline executor (URL-template trigger + status poll + required structured-evidence schema) covers it at zero marginal engineering.
- **Q2 — BUNDLE:** no existing system, but a mature credential-holding backend is worth shipping? Five criteria, all required: (1) Apache-2.0/MPL licensing only; (2) air-gap vendorable into the signed bundle; (3) version-decoupled from SCP's release train; (4) operable at SCP's footprint; (5) once installed it **flips gate 1** — the bundled instance is coordinated exactly like a BYO one.
- **Q3 — OWN (managed-execute):** no existing system **and** the class is too small to justify a backend. **All six gates** of the boundary test must hold, plus the anti-CI corollary. Fail any gate → back to COORDINATE or IGNORE.

### 3. The six-gate boundary test (the only router into OWN)

A class of change is **MANAGED-EXECUTED only if ALL six gates hold**; otherwise it is **COORDINATED**. Default is always coordinate.

1. **No existing executor** — the domain has no execution system for this class (the charter's own trigger condition). If any pipeline/control-plane exists, coordinate through it.
2. **Declarative + idempotent** — desired-state; re-running converges; no imperative side-effect ordering.
3. **Plannable** — a dry-run/diff exists and **is** the reviewable evidence attached to the Change (`tofu plan`; `ansible --check --diff`).
4. **Reversible** — a captured prior-state snapshot enables rollback expressed as the **same** trigger verb with different intent (`rollback` kind + `priorStateRef`). For host classes this is **best-effort convergent rollback with captured prior-state evidence** — package downgrades trigger post-install scripts and dependency cascades; a re-rendered config does not restore prior *process* state — so canary-health auto-rollback plus per-wave gates are the real blast-radius control, and no stronger guarantee may be claimed.
5. **Single-shot ephemeral runner** — one short-lived container, pinned toolchain + minimal shim. No build farm, no compilation, no multi-stage pipeline, no persistent environment.
6. **Narrowly-scoped short-lived creds** — per-run, per-org, per-target vaulted credentials only. Never broad standing creds or persistent infra access.

**Corollary (anti-CI ceiling):** if a class needs artifact build/compile, test orchestration, standing credentials, or bespoke persistent pipeline logic, it is **CI/CD by definition — coordinate, never manage**.

**Canonical negative examples** (normative — cite them when a new class is proposed): **service restart** (fails 2+3+4 — *"can SCP technically run it"* is not the test), **secret rotation** (fails 6, permanently), **DB/schema migration** (fails 4; rides the app/GitOps path, SCP contributes ordering and gate policy), **cert renewal** (fails 1+6), **one-off runbook ops** (fail 2/3/4). The execute-eligible set is the enumerated allowlist in the charter: small IaC; RPM/OS-package install-upgrade-pin; config-file/template render+push; cron/systemd unit changes. Growing that set is a charter change, not a catalog PR.

### 4. Binding policy — bundling flips gate 1

A domain's opt-in to a bundled backend **automatically revokes** managed-execute eligibility for the overlapping classes — one governed graph-data flip, enforced by the engine, not by convention. Otherwise Modes B and C silently compete and "own only when nothing else exists" stops being true.

### 5. Managed-execute is never a layer default

No layer of the composition model (DESIGN §12) defaults to OWN. The six-gate test, run per (class, layer, domain), is the **only** router into managed execution — including L6 (host OS/config/packages), where coordinate-BYO applies whenever any executor (Satellite/AWX/AAP/…) exists.

### 6. CI doctrine — evidence by default

CI is primarily **gate evidence** (controls consume "CI green for digest X"); `trigger` against CI is permitted only where a Component is explicitly bound for re-run/correlation. SCP never becomes a CI engine (anti-CI corollary above).

### 7. Sequencing

GitLab gets a dedicated plugin **before** the generic pipeline executor is extracted from the terraform Mode-1 shape (Mode 1 then becomes a preset of the generic executor, whose required structured-evidence schema — `additionalProperties:false` — is the only thing separating it from a generic "call any URL" bus).

### 8. Matrix verdicts are strategy, not shipped support

The portfolio matrix in [execution-strategy.md](../proposals/execution-strategy.md) records *intended* verdicts per system with status annotations. A verdict of coordinate-now/bundle-candidate/own-managed does not assert working, supported integration; shipped support is claimed only by BUILD_AND_TEST milestone completion.

## Consequences

**Preconditions (guardian conditions — binding, machine-checked where stated; the corresponding builds do not start until met):**

- **Mode C / `scp-runner-ops` — SSTI/Jinja2 closure, machine-checked.** Tenant parameters are **data-only, never rendered as Jinja2**; dangerous lookups (`pipe/command/shell/raw/script/uri`) are disabled with a lockdown `ansible.cfg` and a CI test asserting they **fail closed inside the image**; a permanent **SSTI-fuzz CI gate** runs adversarial params against every catalog role. "No `shell/command/raw` module reachable" alone is not sufficient — template rendering is itself a code-execution surface.
- **Mode C — SSH-CA discipline.** An explicit CA-compromise blast-radius analysis (a fleet-trusted signing key, if compromised, mints valid host certs for the entire fleet until rotation — a larger worst case than the static keys it replaces); CA-key protection commensurate with a fleet root of trust (HSM/KMS or offline signing); short CA lifetimes; **air-gap-workable rotation and revocation**. The pre-seeded per-host trust + restricted sudoers footprint must be justified against the standing-fleet shape the charter rejects.
- **Mode C — the class allowlist lives in the charter.** The enumerated execute-eligible set (small IaC; RPM/OS-package install-upgrade-pin; config-file/template render+push; cron/systemd unit changes) is charter text; the six-gate test admits classes only within it.
- **Mode B — bundled backends are operator-installed.** `scpd` never applies or upgrades backend manifests; enabling the profile renders/stages them for the operator. This keeps credential asymmetry true even transiently — SCP's process never touches the backend's infra credentials or cluster-admin surface.
- **Mode B — Valkey is an owned, tested, supported deviation.** Mandating Valkey as ArgoCD's cache modifies upstream's shipped composition; SCP owns that deviation explicitly (ArgoCD-on-Valkey tested per pin) rather than claiming "unmodified upstream." Honest Principle-4 framing: **enabling a Standard Stack backend adds that backend's own stateful services that the enabling domain must run and back up** — Valkey for Argo CD, and Postgres + Redis + object storage for Harbor (the heaviest bundled component) — SCP itself never requires any of them, and the profile-off manifest set carries none (machine-checked; two-container floor holds).
- **Mode B — upgrade ownership.** The backend image is an independently-bumpable value defaulted to a per-release tested pin: **patch bumps ride off-train** (a CVE fix does not wait for an SCP release); **minor/major upgrades ride the SCP release train** because SCP owns the rendered manifests/CRDs. Published as a narrow supported-version matrix with that distinction.
- **Mode B — product value is gated on the observe() driver.** Bundling ArgoCD without the observe/status-polling loop wired does not deliver "batteries-included coordination"; bundle and change-detection are separate deliverables and are sequenced accordingly (M10).

**Positive**

- One test, one router, one document — the ownership question is answered the same way for every (class, layer, domain), the answer is governed graph data federation carries per domain, and the two expansion vectors (catalog growth, backend allowlist growth) are both charter-anchored.
- The default remains COORDINATE everywhere; the long tail gets served (Mode C) and pipeline-less domains get a real deploy engine (Mode B) without either becoming the product.
- Bundling-flips-gate-1 structurally prevents Mode B/C overlap.
- Air-gap and self-hosting are preserved: both runner images and the bundled backend ship in the same signed bundle; nothing phones home; the pull-side CLI path keeps the generic executor air-gap-friendly.

**Negative / cost**

- SCP takes on distributor/operator obligations for bundled ArgoCD (pin, CVE tracking, upgrade/rollback docs, the Valkey deviation's compat burden) and fleet-credential obligations for `scp-runner-ops` (SSH CA lifecycle, catalog signing, the Ansible offline closure — a materially bigger vendoring burden than pinning `tofu`, plus Python-on-target as an acknowledged per-host dependency).
- The aggregate greenfield suite (bundled ArgoCD + OpenTofu + two runners) is a de facto turnkey deploy stack; each piece stays opt-in and allowlist-anchored so the *combination* remains a sanctioned filler, not the product.
- Verdict-as-graph-data adds schema/policy surface (the per-(class, layer, domain) property, its default, the auto-revocation flip) that must be built and federated before the strategy is fully enforceable in the engine.

## Alternatives considered

1. **Per-tool verdicts** (own/coordinate decided per system, not per class-layer-domain) — rejected: one service legitimately mixes strategies across layers (the agentkit mapping carries five verdicts on one Service node); a per-tool answer forces the whole stack into one mode and cannot express "coordinate the cluster, manage the cron unit."
2. **Tenant-authored playbooks/scripts in the managed tier** — rejected unconditionally: tenant playbooks are shell, and shell with fleet SSH credentials is arbitrary RCE — it dissolves Principle 1's spirit even while nominally holding "scoped vaulted creds." The closed, signed, parameterized catalog is the load-bearing line.
3. **A general runner platform** (grow the managed tier into SCP-native CI/automation) — rejected: an explicit charter non-goal ("not a Terraform replacement, not an ArgoCD replacement"), blocked structurally by the anti-CI corollary and the charter-anchored class allowlist.
4. **Separate ADRs per mode** — rejected: the tests are interlocking (gate 1 routes Q1, bundling flips gate 1, the corollary caps Q3); split across documents they would drift, and drift here means the boundary erodes silently. The proposals remain the exploratory record; this ADR is the single normative statement.
