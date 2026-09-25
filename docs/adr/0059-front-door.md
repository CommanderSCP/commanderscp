# ADR-0059: The front door — `scp install`, the bootstrap credential Secret, and an empty org's home route

**Status:** Accepted (2026-09-25) — implements M29.1 (docs/BUILD_AND_TEST.md §M29 "the front door")
of the zero-to-running plan (docs/proposals/zero-to-running.md §4, §8)
**Relates to:** PROJECT_CHARTER.md "Managed Standard Stack" / "CommanderSCP Is the Surface" /
"Automatic by Default" (2026-09-25); ADR-0058 (the stack controller, whose `stackd.enabled` default
this ADR flips and whose `instanceOperator.grantBootstrapAdmin` seam this ADR's installer is the
first caller of); docs/adr/0012-registry-choice.md (Gitea default); M16.2 (outpost config objects,
`federation outpost declare`)

## Context

Before this milestone there was no single entry point into CommanderSCP. Measured 2026-09-25
(proposal §2): no root README, no quickstart, no `scp init`/`scp setup`; three unrelated install
paths (`deploy/helm` by hand, `deploy/airgap/assets/install.sh`, `deploy/compose`) with no role or
profile guidance; the bootstrap admin's one-time password printed exactly once to the **api pod
log** (`local-auth.ts`), so the first thing a new operator had to do to use a coordination platform
was leave it for `kubectl logs`; the useful `/setup` checklist existed but was linked from nowhere
and the home route was always the ordinary (empty) dashboard; and the HQ outpost — required for a
commander's own targets — was never declared automatically.

## Decision

### 1. `scp install` (`packages/cli/src/install-cli.ts`)

One command, three substrates, wrapping the existing install paths rather than re-implementing
them: `deploy/helm` via `helm` (connected Kubernetes), `deploy/airgap/assets/install.sh` (a signed
air-gap bundle), `deploy/compose` (`docker compose`, for a VM). `--role commander|outpost|retrans`,
`--profile eval|production`, `--bundle <dir>` (+ `--registry`/`--pubkey`/`--insecure-registry` for
that mode), `--kube-context`, `--namespace`, `--release-name`, `--mode kube|compose`,
`--with`/`--without <backend>` (repeatable, non-interactive backend selection),
`--yes` (skip the interactive checklist), `--org-name`/`--admin-username`, `--base-url` (skip the
installer's own port-forward), `--timeout`/`--stack-timeout`, `--bootstrap-k3s`, `--set <k=v>`
(a raw `helm --set` escape hatch for a value this command has no dedicated flag for — also how a
test run points at a locally built/loaded image instead of the published one), `--dry-run`.

One run does, in order:

1. **Resolve the role's default Standard Stack** (proposal §5: commander gets all five backends —
   it is its own HQ outpost; outpost gets Argo CD + Argo Rollouts + Gitea; retrans gets none, and
   the controller is not even turned on for it), pre-selected and shown as an interactive checklist
   when a TTY is attached and `--yes` was not given; `--with`/`--without` are the non-interactive
   form. `resolveDesiredBackends` is parsed against `StackBackendSchema`, never a copied list.
2. **Install** — `helm upgrade --install … --wait --timeout` with
   `federationRole`, `deploymentMode` (from `--profile`), `instanceOperator.grantBootstrapAdmin=true`
   (ADR-0058 §7's seam — this is its first and, before this ADR, only intended caller),
   `bootstrap.orgName`/`bootstrap.adminUsername`, and (eval only) `postgres.evalInCluster.enabled`.
   For `--bundle`, the same values ride `install.sh`'s `SCP_EXTRA_HELM_SET`, plus
   `--skip-bundled-backends` (§4 below). For `--mode compose`, `docker compose up` with the same
   values as shell-environment overrides.
3. **Read and print the bootstrap admin's one-time password** (§2 below) — never a `kubectl logs`
   call.
4. **Log in** with it (`ScpClient.login`), confirming a real round trip, and store the session the
   same way `scp login` does (`saveCredentials`) — a normal `scp whoami` afterward just works.
5. **Delete the bootstrap-admin Secret**, now that a real login has proven the password worked.
6. **Declare this instance's federation identity** (`POST /federation/init`) with the chosen role.
   Measured against a real kind cluster while building this command: `SCP_FEDERATION_ROLE` (a chart
   value, `config.federationRole`) does **not** set the org's federation-identity row — that row is
   always created `role: 'unset'` (`ensureFederationSelf`) and only `federation init` changes it —
   so without this call, step 7 for a commander 400s with "this instance's federation role is
   'unset', not 'commander'". Idempotent (a plain `UPDATE`).
7. **Enable each backend in the resolved set** (`PUT /instance/stack/backends/{b}`, no operator
   token needed — the bootstrap admin already holds the instance-operator role from step 2's chart
   value) and **poll `GET /instance/stack`** until every enabled backend has reported *some* status
   — `ready` **or** `needs` — or `--stack-timeout` elapses. Accepting `needs` deliberately: it is
   the controller's own honest "not yet, and here is why" (ADR-0058's Stack page draws the same
   line), and a fresh install commonly needs one thing a human still has to provide (a build image,
   a state backend) before every backend goes fully green.
8. **Declare the HQ outpost, for a commander only** (`federation outpost declare` — literally
   `client.federation.createOutpost({peerDomainId: self.domainId})`, the same API path M16.2 built,
   with `--peer` set to this instance's own domain id), idempotently: a 409 (already declared, e.g.
   a re-run) is treated as success.
9. Print a summary and exit.

**No cluster? `--bootstrap-k3s`** installs a single-node k3s
(`curl -sfL https://get.k3s.io | sh -`, proposal §3a option 1) — small, and connected-only by
construction (the official installer is a network fetch). Air-gapped with no cluster: refused with
the exact reason and what to run instead (`docs.k3s.io/installation/airgap`) rather than a
half-built air-gapped k3s bootstrap. **This is a deliberate scope cut**, not a silent omission — see
Consequences.

### 2. The bootstrap admin credential Secret (never a pod log)

Before: `ensureBootstrapAdmin` (`local-auth.ts`) always generated its own one-time password and
logged it at `warn`, the **only** copy. Now: the chart pre-generates it (a new Secret,
`<fullname>-bootstrap-admin`, `secrets-generated.yaml` — the same `lookup`/hook pattern as the
postgres and app-secrets Secrets it sits beside), mounted **only into the api pod**
(`deployment-api.yaml`, `SCP_BOOTSTRAP_ADMIN_PASSWORD` — never the worker, never the migrations
Job) as `config.bootstrapAdminPassword`. `ensureBootstrapAdmin` accepts it as `opts.password`: when
given, it is what gets hashed and stored, and it is **never logged** — the whole point of moving it
here is that a pod log stops being a second, uncontrolled copy of the credential. Compose has no
Kubernetes Secret store, so under `--mode compose` the installer generates the password itself and
hands it to the container as a plain env var: no read-back step is needed at all, because the
installer is already its own only reader.

**Who else can read it (the M28-class question):** anyone holding `get secrets` in the release
namespace — exactly the population that can already read the postgres admin password and
`SCP_SECRETS_MASTER_KEY` beside it. No new reader tier is created; the plaintext's transport is a
Kubernetes Secret (as every generated credential in this chart already is), never an SCP table, and
it is hashed (argon2) the moment it lands in `users.passwordHash`.

**"Shown once, not stored in plaintext"** despite a Kubernetes Secret not being a single-read store:
the installer deletes the Secret **after** it has confirmed the password actually logs in (step 5
above) — not before, so a failed login leaves it for a retry — which is the closest a chart-rendered
object gets to "consumed." `scpd`'s own ServiceAccounts gain **no** new Kubernetes RBAC to do
this — the delete is the installer's own `kubectl`, run with the cluster access `helm install`
already needed. Leaving the Secret in place after a failed or skipped install is harmless: a later
`helm upgrade`'s `lookup` reuses the same password (never rotates one out from under a mid-install
operator), and if the admin row already exists (a re-run), a stray unconsumed password is simply
never read back by anything.

### 3. `stackd.enabled` flips to the chart's own default (`true`)

Per proposal D3 ("the Standard Stack is on by default for a new install") and ADR-0058's own
"Consequences" ("the flip is planned, not assumed… at which point the chart default flips in the
same change"): a **bare** `helm install`, with no `scp install` involved at all, now gets the stack
controller. `scp install` no longer needs to turn it on — it sets `instanceOperator.grantBootstrapAdmin`
explicitly (a one-shot seam that stays opt-in) and, for `--role retrans`, turns `stackd.enabled` back
**off** (nothing to install; the near-cluster-admin controller is a grant to refuse, not a default to
accept — proposal §3a "Per role": "a retrans runs the controller with an empty stack, or not at
all").

Flipping a chart default that far downstream broke three `tools/helm-verify` renders that had
assumed "off unless asked" as their baseline (all fixed in this PR, not deferred):

- the "kitchen sink" render, which turns on `federation.serverMtls.enabled` — a real, ADR-0058
  guard (`stackd.enabled` with `serverMtls.enabled` refuses to render: the controller dials scpd
  in-cluster over plain HTTP) now unrelated to what that render tests, so it turns stackd off;
- the M23.6 socket-invariant matrix (162 value combinations, asserting the managed runner is the
  ONLY identity holding a grant) — stackd's own reviewed ClusterRole was tripping an assertion it
  was never meant to be evaluated against; every point in the matrix now turns stackd off;
- the M29.4 "enabling the stack controller must add exactly its own objects" diff test, whose "off"
  baseline no longer said so explicitly — the diff silently became `added: []` against the new
  default-on baseline instead of failing. This is the exact shape CLAUDE.md's grep-blind-spot
  warning describes: a test that stops testing anything and stays green. Fixed by stating the
  baseline (`--set stackd.enabled=false`) rather than relying on an implicit one.

### 4. `install.sh` grows three flags, and stops double-installing backends

`--kube-context` (forwarded to `helm`), `--timeout` (added `--wait --timeout` to the helm
invocation — **it had none before this ADR**, so an air-gapped install previously reported success
the instant the API server accepted the release, not once pods were actually Ready), and
`--skip-bundled-backends`. The third exists because of the stackd default flip: `install.sh`'s
helm branch already ran a **second**, older mechanism for the Argo/Gitea backends
(`scp-bundled.sh enable <backend>`, `kubectl apply --server-side` under a different field manager)
that pre-dates the stack controller. With `stackd.enabled` now on by default, an air-gapped
`scp install` would apply the same backend through **both** mechanisms — real risk of two field
managers fighting over the same objects, not merely wasted work. `scp install --bundle` passes
`--skip-bundled-backends` and drives backend-enable through the Standard Stack API instead (the
same step as the connected path); a bare `install.sh` invocation (no `scp install`) is unaffected
— it still enables backends the old way, exactly as before.

### 5. An empty org's home route

`apps/web/src/routes/setup.tsx`: `isOrgEmpty` (pure) + `useOrgIsEmpty` (three `limit: 1` queries —
execution systems, deployment targets, components) define "nothing configured" precisely as **all
three empty**; `undefined` ("still loading") is never treated as empty, so a slow network cannot
flash the setup flow at a returning user with a populated org. `router.tsx`'s `HomePage` renders
`SetupPage` in that case instead of `DashboardPage`/`OutpostDashboardPage` — no URL redirect, `/`
itself renders differently. `/setup` was **already** linked from navigation
(`AppShell.tsx`, both the commander and outpost nav trees existed before this ADR) — nothing to
add there.

## Consequences

- **Air-gapped k3s bootstrap is explicitly not delivered.** `scp install --bundle` with no reachable
  cluster refuses with the reason and a pointer to `docs.k3s.io/installation/airgap`, rather than a
  half-built offline bootstrap. This is the scope cut BUILD_AND_TEST.md's M29 rules require be
  stated, not silently footnoted: a genuinely air-gapped single-node Kubernetes bootstrap (vendoring
  k3s's binary + images into the bundle, or documenting an Ansible-driven RKE2/k3s play) is real
  future work, tracked here rather than assumed done.
- **`scp install --mode compose` never installs the Standard Stack.** The Argo family is
  Kubernetes-native (proposal §3a); a compose/VM install gets SCP itself and (if enabled) Gitea, and
  is told to re-run with `--mode kube`/`--bootstrap-k3s` for the rest. This is the documented
  trade-off, not a defect.
- **`federation init`'s role/name become whatever the LAST `scp install` (or manual `federation
  init`) call set them to.** Re-running `scp install --role X` on an already-installed instance
  re-declares the federation identity as role X — harmless for the install flow itself (idempotent,
  same org), but an operator scripting repeated installs against the same release with different
  roles would see the identity move each time. Not guarded against here; the existing
  `federation init` door already has this property independent of this ADR.
- **The bootstrap-admin Secret can accumulate a stray, never-consumed generation** across repeated
  `helm upgrade`s once the installer has deleted the original (§2) — cosmetically present, never
  read by any code path once the admin user row exists. Left as-is: purging it is an ordinary
  `kubectl delete secret`, and adding chart machinery to prevent regeneration would need a state
  Helm itself does not track (whether the admin was ever consumed).
- **`--set` is a real escape hatch, not only a test convenience.** It is what let this ADR's own
  kind proof point `scp install` at a locally built, unpublished image
  (`--set image.repository=… --set image.tag=… --set image.pullPolicy=Never`, and the matching
  `stackd.image.*` for the controller's own image) — the same lever an operator would reach for on
  a chart value this command has no dedicated flag for yet.
- **M29.2 (complete auto-wire) still owns backend REGISTRATION** — the stack controller's
  `afterReady(backend, objects)` seam (ADR-0058 Consequences) that mints the scoped account/token,
  publishes TLS trust and opens both egress layers, registering each enabled backend as an
  `execution-system`. This milestone only proves the backend **installs and reports status**
  through `scp install`; a freshly `scp install`ed commander does not yet have Argo CD wired as a
  coordinated execution system. Not started here deliberately — it is the concurrent M29.2 lane's
  scope (`apps/stackd` + the auto-wire seam were out of bounds for this branch).
