# Proposal — Managed Execution Tier (beyond IaC)

> **Status: Exploration — pending owner decision.** Not approved, not scheduled. This note captures a
> multi-lens design exploration (2026-07-12) so the owner can make a go/no-go and shape direction. If
> approved, it becomes concrete edits to `PROJECT_CHARTER.md` + `docs/DESIGN.md §12` and two ADRs
> (see [Required doc changes](#required-doc-changes)). Where anything here conflicts with the charter,
> the charter governs.

## The steer

Owner intent (verbatim): *"I don't mind us owning CI for some things that are not highly complex.
We're not trying to replace those solutions. Though we are trying to make things easier for people."*
Plus: teams should have **options**, and since standing up GitHub Actions / GitLab runners is itself
manual per-team toil, CommanderSCP could offer **pre-created, ready-to-integrate execution options**.

So the target is a **mix**: coordinate the mature systems (ArgoCD, real CI, existing Terraform
pipelines) — never reinvent them — and *execute* only the **long tail** of small operational changes
where no executor exists and a per-team pipeline is wasteful.

## The concept

CommanderSCP stays **coordination-primary**. The managed-execution tier is a **scoped filler** for the
long tail. This is **not a new capability** — it is the existing charter *Managed Execution Exception*
(already worded generally, "a class of change … for example, small IaC deployments") realized as a
**second runner image behind the same, unchanged `ExecutorPlugin` interface** (`observe/trigger/
status/abort` — no `execute()`/`deploy()` verb ever). Every managed run flows through the **identical**
gate / approval / wave / rollback / Decision / audit path as any coordinated change. The tier is
**always optional** (Postgres stays the only required stateful dependency).

The single structural line that keeps this from degenerating into a signed remote-shell (the
AWX/Rundeck/Salt failure mode) is a **closed, signed task catalog**: the managed tier runs only vetted,
parameterized operations — **never tenant-supplied shell**.

## The boundary test (anti-scope-creep)

A class of change is **MANAGED-EXECUTED only if ALL six gates hold**; otherwise it is **COORDINATED**.
Default is always coordinate.

1. **No existing executor** — the domain has no execution system for this class (the charter's own trigger condition). If any pipeline/control-plane exists, coordinate through it.
2. **Declarative + idempotent** — desired-state; re-running converges; no imperative side-effect ordering.
3. **Plannable** — a dry-run/diff exists and **is** the reviewable evidence attached to the Change (`tofu plan`; `ansible --check --diff`).
4. **Reversible** — a captured prior-state snapshot enables rollback expressed as the **same** trigger verb with different intent (`rollback` kind + `priorStateRef`). *(See guardian caveat — for host classes this is best-effort, not guaranteed.)*
5. **Single-shot ephemeral runner** — one short-lived container, pinned toolchain + minimal shim. No build farm, no compilation, no multi-stage pipeline, no persistent environment.
6. **Narrowly-scoped short-lived creds** — per-run, per-org, per-target vaulted credentials only. Never broad standing creds or persistent infra access.

**Corollary (anti-CI ceiling):** if a class needs artifact build/compile, test orchestration, standing
credentials, or bespoke persistent pipeline logic, it is **CI/CD by definition — coordinate, never manage.**

| Verdict | Classes |
|---|---|
| **Execute-eligible** | small IaC · package/RPM install-upgrade-pin · config/template render+push · cron/systemd unit changes |
| **Coordinate by default** | secret rotation (fails 6) · DB/schema migration (fails 4) · cert renewal (fails 1+6) · service restart (fails 2+3+4) · one-off runbook ops (fails 2/3/4) |

`service restart` is the instructive negative example: *"can SCP technically run it"* is **not** the test.

**Make the answer graph data:** coordinate-vs-execute is a property per `(class-of-change, domain)`,
defaulting to coordinate, flipped only when gate 1 holds — so federation carries the right answer per
domain (Principle 2), and enabling a class is a governed decision, not an ad-hoc plugin drop.

## Engine model

**Two runner images**, both behind the unchanged interface, both single-shot ephemeral (k8s Job in prod,
`docker run` under compose/VM), both shipped in the same **signed air-gap bundle** at the same tag as
`scpd`, pulled only by opt-in domains:

- **`scp-runner-iac`** — unchanged (Terraform/OpenTofu, closed `plan|apply|rollback` shim).
- **`scp-runner-ops`** — **new**, one general host-ops runner built on **Ansible** (agentless; declarative
  idempotent modules; `--check --diff` is a native plan-as-evidence analog). One image covers
  package/RPM + config/template + cron/systemd, favoring **Simplicity** over per-class image sprawl.

The decisive constraint (resolving *general-Ansible convenience* vs *anti-RCE*): `scp-runner-ops` runs
**only a curated, versioned, cosign-signed catalog** of parameterized roles (`install-package@version`,
`set-config-key`, `apply-file-from-template`, `ensure-service-state`, `manage-unit`). Tenants supply
**only schema-validated parameters** (`configSchema`, `additionalProperties:false`); no `shell/command/
raw` module is present or reachable; the entrypoint rejects unknown actions non-zero, exactly like the
IaC runner does today. Catalog changes go through the same PR/review/signing path; the runner verifies
the signature at start. The `scp-managed-ops` plugin is a **thin sibling of `scp-managed-iac`** inside
`scpd` — the coordination core is reused wholesale, with **no privileged SCP-executed side-path**.

## Credential / inventory / network / blast-radius model

Five controls — four port directly from the IaC posture; the fifth (network) is the genuinely new surface.

1. **Inventory is DERIVED, never declared.** The runner receives an ephemeral inventory the engine
   compiled server-side from the change's `wave_targets` (host coordinates from the target object's
   `properties`, RLS-scoped), copied in like the IaC workspace — never a tenant `hosts` field, never a
   bind mount. Blast radius is bounded by construction to the compiled plan.
2. **Credentials reuse the existing store** (AES-256-GCM at rest, org-scoped RLS, decrypted only at
   provisioning, injected via env into the ephemeral runner, redacted from evidence, `scpd`'s own env
   stripped). But host login is login-grade → prefer **SCP as an SSH CA issuing minutes-TTL certs**
   scoped per-target/per-run + a **restricted sudoers** (exactly the catalog's commands, never
   `NOPASSWD:ALL`). *(See guardian caveat — the CA key is itself a fleet crown-jewel.)*
3. **Network is the structural difference.** IaC runs `--network none`; a host runner must reach
   private IPs. Replace the blanket deny with a **per-run positive allowlist = exactly the resolved
   wave-target IPs**, enforced at the **NetworkPolicy / nftables layer** (not app-level). Always-block
   link-local/metadata (`169.254.169.254`, …) moves to the network layer. A **domain-local runner per
   segment** (federation already puts a child per domain); a runner reaches only its own segment,
   cross-segment rides the signed journal — never a runner bridging trust boundaries.
4. **Anti-RCE catalog is the credential-containment story.** SCP holding SSH creds is safe *only*
   because the operations it can perform are a bounded, reviewed, auditable vocabulary.
5. **Blast-radius:** canary/rolling waves with per-wave gates, mandatory check-mode diff evidence gated
   before apply, canary-health auto-rollback, durable idempotency dedup, `rm -f` after each run, no
   `docker.sock`, no host bind mount.

## Hard problems that MUST be solved before any build (charter-guardian findings)

The adversarial guardian returned **verdict: `needs-amendment`** (not "within-charter"). The core
instinct is sound; the host-reach details are where invariants actually bend. These are gating:

- **[MAJOR] Real charter amendment — the credential-asymmetry invariant bends.** DESIGN §12 enforces the
  boundary *twice*; the second is *"SCP holds credentials to execution systems' APIs, never to the
  infrastructure those systems manage."* The IaC exception honored this (a cloud API token in
  `--network none`). `scp-runner-ops` holds **SSH login + sudo to the hosts themselves** and opens a real
  NIC into internal segments — SCP holding creds to the *managed infrastructure itself*. This is a
  separate non-negotiable from the exception's four written constraints, and needs a **genuine charter
  amendment with explicit owner sign-off** that *enumerates the admissible class set* — not a downgraded
  "risk note," not folded into the 2026-07-08 decision.
- **[BLOCKER] Anti-RCE hole — Ansible/Jinja2 templating is itself a code-execution surface.** "No
  `shell/command/raw` reachable" + schema-validated params is **not sufficient**: Jinja2 lookups
  (`{{ lookup('pipe','…') }}`) execute commands during render, so any tenant param that reaches a
  template context is SSTI → RCE. Required, machine-checked, before this verdict holds: (1) tenant params
  are **data-only, never rendered as Jinja2**; (2) dangerous lookups disabled, lockdown `ansible.cfg`,
  CI test asserting `pipe/command/shell/raw/script/uri` fail closed **inside the image**; (3) permanent
  **SSTI-fuzz** CI gate over catalog roles with adversarial params.
- **[MAJOR] The SSH CA is a new fleet-wide crown-jewel.** Analyzed only for *runner* compromise. A CA
  signing key trusted fleet-wide, if compromised, mints valid host certs for the **entire fleet until
  rotation** — a *larger* worst-case than the static keys it replaces. Requires: explicit CA-compromise
  blast-radius analysis; CA-key protection commensurate with a fleet root of trust (HSM/KMS or offline
  signing); short CA lifetimes; **air-gap-workable rotation + revocation**. Also: pre-seeded per-host
  trust + sudoers is a **standing fleet footprint** trending toward the AWX/Salt shape we claim to
  reject — justify it or offer a lower-standing-trust alternative.
- **[MINOR] Air-gap costs are heavier than IaC.** Ansible's collection/Python closure is large and many
  modules make outbound calls; vendoring + CVE-patching it offline is a materially bigger burden than
  pinning `tofu`. And **Ansible needs a Python interpreter on every target host** — an unacknowledged
  per-host standing dependency that complicates "agentless." State both explicitly; add an offline-build
  CI gate.
- **[MINOR] "Reversible" (gate 4) is over-claimed for host classes.** Package downgrades trigger
  post-install scripts / dependency cascades; a re-rendered config doesn't restore prior *process* state.
  Weaken to **"best-effort convergent rollback with captured prior-state evidence,"** and make
  canary-health auto-rollback + per-wave gates the real blast-radius control.

**Scope-creep watch:** Ansible *is* a general-purpose automation engine; "long tail only" is currently
held by **process** (a closed catalog + a judgment-based six-gate test), not by structure. Without a
**charter-anchored hard allowlist of admissible classes + an explicit cap**, the catalog can grow
class-by-class and erode "long tail only" silently. The enumerated class set must live in the charter.

## Principles verdict (honest)

| Principle | Verdict |
|---|---|
| 1. Coordination, not execution | **Held but widened — tightest call.** Within the scoped exception by containment, but host reach + login creds bend the credential-asymmetry invariant → needs explicit owner sign-off (above). |
| 2. Graph-native | Held — coordinate-vs-execute is per-`(class,domain)` graph data; inventory derived; classes arrive as catalog+data. |
| 3. API-first parity | Held — verb set unchanged; managed-ops is a sibling behind the same interface; UI/CLI still consume only the SDK. |
| 4. Postgres only required dep | Held — tier is optional; **no standing runner/agent** (enforce as machine-checked CI invariant). |
| 5. Air-gap & self-host | Held **with diligence** — everything vendored in the signed bundle; but Ansible closure + Python-on-target add real burden (above). |
| 6. Explainability & audit | Held — check-mode diff is mandatory evidence; resolved task+params persist as a Decision on the hash-chained log in the same tx. |
| 7. Simplicity first | Held — one general `scp-runner-ops` + the closed catalog is the simplest shape that covers the long tail without CI/RCE creep. |

## Incremental path (docs-first, lowest-risk-first)

0. **Codify the boundary test + eligibility gate (docs-only).** Land the boundary-test ADR + DESIGN §12
   generalization + the per-`(class,domain)` coordinate-vs-execute graph property (default: coordinate).
   Zero runtime risk; makes every subsequent class a governed decision.
1. **Prove the generalization with the smallest host-reaching class.** Refactor `managed-iac`'s
   orchestrator into a shared managed-executor core; ship `config-file/template render+push to a single
   canary host` via the closed catalog — network scoped to **one** host, check-diff as evidence.
   Exercises SSH-CA, server-compiled inventory, and the network allowlist on the smallest footprint.
2. **Add package/RPM + cron/systemd catalog roles.** Each a signed catalog release reviewed like the IaC
   shim — never tenant-authored. Still single-host/tiny-wave.
3. **Turn on wave topology + auto-rollback for the ops tier.** Canary→subset→fleet with per-wave gates
   and canary-health auto-rollback. Blast radius scales but stays bounded by the compiled plan.
4. **Harden + make guarantees machine-checked.** CI gates: offline Ansible-closure build, catalog
   signature verified at start, no `shell/command/raw`/dangerous-lookup reachable, no standing runner
   Deployment, creds only in ephemeral Job specs, NetworkPolicy egress = target IPs. Gate the whole tier
   behind an explicit per-domain enable.

## Pivotal owner decisions

1. **Go/no-go on host-reaching managed execution at all** (the widened surface: internal network +
   SSH/sudo login creds vs IaC's cloud-token-in-`--network none`).
   *Recommendation:* **Yes, with containment as non-negotiable preconditions** (closed signed catalog +
   SSH-CA short-lived certs + scoped NetworkPolicy) **and a real charter amendment recording your
   sign-off.** The long tail you're targeting (package/config/systemd) is inherently host-reaching, so
   an API-only tier guts the value; containment is the honest way to deliver it.
2. **Execution vocabulary: closed signed catalog vs tenant-authored playbooks.**
   *Recommendation:* **Closed catalog, unconditionally.** Tenant playbooks = shell = arbitrary RCE with
   fleet SSH creds; that dissolves Principle 1's spirit even while nominally holding "scoped vaulted creds."
3. **Runner granularity: one general `scp-runner-ops` vs one image per class.**
   *Recommendation:* **One general runner** (Simplicity #1); the catalog, not image count, is the guard.
4. **SCP running an SSH CA** (a new credential-issuance capability).
   *Recommendation:* **SSH CA with minutes-TTL certs** over static keys — *but only* with the
   CA-compromise analysis + HSM/KMS-grade key protection + air-gap revocation the guardian requires.
5. **Where "no existing executor" (gate 1) is sourced + how federation reconciles it.**
   *Recommendation:* **Infer from connected `executor_bindings` to propose, require operator confirmation
   per `(class,domain)` to flip to managed**, carry the answer as graph data.

## Required doc changes (if approved)

- **`PROJECT_CHARTER.md` → Managed Execution Exception:** a **real amendment** (not a risk note) stating
  managed execution may hold host login-grade creds + reach internal networks **for a bounded, enumerated
  class set**, with owner sign-off in the decision log; amend the **DESIGN §12 credential-asymmetry
  invariant** accordingly.
- **`docs/adr/NNNN-managed-execution-boundary-test.md`** — the six-gate boundary test as the mandatory
  admission gate + the canonical "why not" negative examples.
- **`docs/adr/NNNN-scp-runner-ops-host-execution.md`** — closed signed catalog vocabulary; SSH-CA +
  scoped sudoers; positive-network-allowlist; domain-local-runner-per-segment; the SSTI-closure DoD; the
  CA-compromise blast-radius analysis. **Owner sign-off required.**
- **`docs/DESIGN.md §12`** — generalize "Mode 2 — SCP-managed IaC" into a **Managed Execution** subsection
  (shared pattern) + add `scp-runner-ops` as the second runner; document the anti-RCE ceiling + network/
  inventory/credential controls.
- **`docs/BUILD_AND_TEST.md`** — a milestone with machine-checked DoD (catalog signature verify; no
  shell/command/raw/dangerous-lookup reachable; server-compiled inventory; NetworkPolicy egress = target
  IPs; offline air-gap build; SSTI-fuzz; no standing runner).
- **`packages/plugins/managed-ops` manifest `configSchema`** — per-class parameter schema
  (`additionalProperties:false`) as the registration-path eligibility gate.
