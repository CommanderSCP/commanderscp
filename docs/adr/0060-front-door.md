# ADR-0060: The front door — `scp install`, the bootstrap credential Secret, and an empty org's home route

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
5. **Blank the bootstrap-admin Secret's `password` key** (never delete it — §2 below), now that a
   real login has proven the password worked.
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

**#422 adversarial review, BLOCKING 1 — `--mode compose` never actually reached compose.** The
`docker compose up` call built an isolated `env` (the same values steps 2/3 need) but never passed
it to the process (`run(shell, "docker", [...])` with no `{ env }`), so every compose install
launched a default eval commander with its OWN bootstrap password, and the installer's step 4 login
(against ITS `opts.password`, never the container's actual one) failed every time. Fixed by passing
`{ env }`; mutation-proven (reverted the fix, confirmed the compose-mode test fails for exactly this
reason, restored).

**#422 adversarial review, SHOULD-FIX 6 — re-running `scp install` was claimed idempotent but
threw.** Step 3's password read-back (`readBootstrapAdminPassword`) throws once step 5 has already
blanked the Secret on a prior run, and step 2's `helm upgrade` still re-passed
`instanceOperator.grantBootstrapAdmin=true` on every re-run regardless. Fixed: the read now uses a
short retry (5 attempts, 400ms apart) then treats a blank/absent password as "already installed" and
returns an idle `InstallSummary` early, skipping the grant and the rest of credential surfacing
rather than throwing. (A separate, NOT independently fixed here: the eval-profile `helm upgrade`
can itself fail on the postgres-eval hook's PVC/Service under helm v3.20.2 — BUILD_AND_TEST.md
~L2292 already tracks this; a re-run's idempotency claim depends on it and is only as good as that
known issue allows today.)

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
the installer **blanks the Secret's `password` key** (`kubectl patch --type=merge`) **after** it has
confirmed the password actually logs in (step 5 above) — not before, so a failed login leaves it for
a retry — which is the closest a chart-rendered object gets to "consumed." `scpd`'s own
ServiceAccounts gain **no** new Kubernetes RBAC to do this — the patch is the installer's own
`kubectl`, run with the cluster access `helm install` already needed.

**This started as an outright `kubectl delete secret`, and that was wrong** — found by actually
running the installer against a real kind cluster, not by inspection. `api.replicaCount` defaults to
2, and ANY later pod start for that Deployment (a rollout restart, a node reschedule, a future `helm
upgrade`'s rolling update) failed outright once the Secret object was gone:
`CreateContainerConfigError: secret "…-bootstrap-admin" not found`. `secretKeyRef` resolution is a
kubelet-level, container-START-TIME check on the **Secret object**, not a value-time check — deleting
the object breaks every future pod for that Deployment, not just the one that already read it.
Blanking the **value** under a still-**present key** has none of that failure mode (Kubernetes only
refuses a missing Secret or a missing key, never an empty value) and is sufficient: the plaintext is
gone from the cluster, and no code path ever reads this env var again once the admin row exists
(`ensureBootstrapAdmin`'s `existingAdmin` check), whatever it now contains. Verified with a real
`kubectl rollout restart deployment/…-api` against the blanked Secret.

Leaving the Secret (blanked or not) in place after a failed or skipped install is harmless: a later
`helm upgrade`'s `lookup` reuses the same password if it is still there (never rotates one out from
under a mid-install operator), and if the admin row already exists (a re-run), a stray unconsumed
password is simply never read back by anything.

**#422 adversarial review, SHOULD-FIX 3/4 — blanking the Secret is not enough on its own.** The
plaintext still sits in **Helm's own release history** (`helm get hooks`/`helm history`, retained
regardless of what happens to the live Secret object), and — the sharper problem — nothing stopped
the printed password from working forever: a second login with it kept succeeding indefinitely, so
"shown once" was a claim about where the password started, never about how long it kept working.
Fixed with a real one-time-use property, independent of the chart entirely: a new
`users.must_change_password` column (migration 0128), set unconditionally whenever
`ensureBootstrapAdmin` creates an admin from a handed-in password (`local-auth.ts`). `requireAuth`
gates every route but `POST /auth/password`, `GET /auth/me` and `POST /auth/logout` behind it
(`require-auth.ts`) — a 403 whose `detail` is prefixed `password change required:` (Fastify's
schema-based response serialization strips unknown fields from `ProblemSchema`, so a bespoke
`extensions.code` never reaches the wire on a route that doesn't declare it; `GET /auth/me`'s
`mustChangePassword: boolean` is the field a client should actually poll). `POST /auth/password`
(`changeLocalPassword`, SDK `client.auth.changePassword`, CLI `scp passwd`, web
`/change-password` — `RequireAuth.tsx` redirects there whenever `mustChangePassword` is true) clears
the flag. `scp install`'s own login (step 4) and `seed.ts`'s demo-data login both call
`changePassword(oneTimePassword, oneTimePassword)` immediately after — same value in and out, which
clears the flag without changing what the password actually IS, so the operator's printed password
keeps working for their own first login while automation isn't blocked by a gate meant for a human.
The Helm-release-history exposure is unchanged by this fix (still real, still lower severity — a
`helm get hooks` reader already has `get secrets` in the namespace, the same population §2 above
already accepts) and is not separately closed here.

### 3. `stackd.enabled` stays off at the chart's OWN default; `scp install` turns it on

**Reversed from this ADR's first version**, which flipped the chart's bare-`helm install` default to
`true` per proposal D3. The #422 adversarial review's orchestrator decision (2026-09-25, consistent
with the charter's "on by default for new installs") is **option (a): the chart default stays
`false`; `scp install` sets it explicitly `true`** (for every role but `retrans` — unchanged, still
never on for a retrans: "a retrans runs the controller with an empty stack, or not at all",
proposal §3a). Why: "on by default for new installs" describes what a person running `scp install`
gets, not what a bare `helm install`/`helm template` renders — and the LIVE risk (§2a below) makes a
default-on chart actively dangerous under GitOps, where nothing runs `scp install` at all. New
installs still go through the installer and are unaffected; an **existing** bare-`helm-install`
deployment tracking `main` is never surprised by a stack controller it never asked for showing up on
its next sync.

`scp install` now always sets `stackd.enabled` explicitly (`true` for `commander`/`outpost`, `false`
for `retrans`) rather than only setting it when turning the controller ON — an install must be able
to state "off" as loudly as "on", the same lesson the diff-test baseline below is fixed for.

Flipping the chart's own default (this ADR's first version) had broken three `tools/helm-verify`
renders that assumed "off unless asked" as their baseline; those fixes stay, now as defense for the
"off, unless `scp install` asks" behavior instead:

- the "kitchen sink" render, which turns on `federation.serverMtls.enabled` — a real, ADR-0058
  guard (`stackd.enabled` with `serverMtls.enabled` refuses to render: the controller dials scpd
  in-cluster over plain HTTP) now unrelated to what that render tests, so it turns stackd off;
- the M23.6 socket-invariant matrix (162 value combinations, asserting the managed runner is the
  ONLY identity holding a grant) — stackd's own reviewed ClusterRole was tripping an assertion it
  was never meant to be evaluated against; every point in the matrix now turns stackd off;
- the M29.4 "enabling the stack controller must add exactly its own objects" diff test, which now
  states its "off" baseline explicitly (`--set stackd.enabled=false`) rather than relying on
  whatever the chart default happens to be — the exact shape CLAUDE.md's grep-blind-spot warning
  describes: a test that silently stops testing anything and stays green if the default under it
  ever moves again.

### 2a. GitOps/Argo CD: `existingSecret` overrides for every chart-generated credential (#422 LIVE RISK)

`lookup` (used by §2's Secret and by `postgres`/`appSecrets`/the stackd credential) queries the
**live cluster**; `helm template` — which is ALL Argo CD's repo-server ever runs — has no live
cluster context, so `lookup` always returns nothing there. A `stackd.enabled: true` release tracked
by Argo CD with `selfHeal` therefore regenerates the stack controller's credential AND
`scp_operator`'s database password on **every sync**. The credential mostly self-heals (ADR-0058's
rotation path revokes the old id), but the password does not: `apps/server/src/db/provision.ts`
refuses to reset `scp_operator`'s live password when it no longer matches the connection string
("refusing to reset the password for role scp_operator") — so the very next migrations Job PreSync
hook fails, and every sync after it, until an operator intervenes by hand. Measured as a real risk
to the owner's homelab cluster, which tracks `main` under Argo CD with `selfHeal` and will pick up
`stackd.enabled` the moment a chart change turns it on for that release.

Fixed with three `existingSecret`-style overrides — set, the chart takes the value verbatim and
never generates or reads its own copy, so nothing about it can drift between syncs:
`operatorApi.databaseUrlSecret`/`operatorApi.databaseUrlSecretKey` (pre-existing, M22.9),
`stackd.existingCredentialSecret`/`stackd.existingCredentialSecretKey` (new,
`stackd.namespace`-scoped), `bootstrap.existingAdminPasswordSecret`/
`bootstrap.existingAdminPasswordSecretKey` (new, release-namespace-scoped). Exact keys, shapes and
the one-time bootstrap sequence a GitOps operator needs before first turning `stackd.enabled` on:
`deploy/helm/README.md` § "GitOps / Argo CD". `tools/helm-verify`'s
`verifyExistingSecretOverrides` renders twice with all three set and asserts (a) neither generated
Secret renders, (b) every referencing `secretKeyRef.name`/`.key` names the pre-provisioned Secret
literally, not just "is stable across renders" — an earlier version of this check compared
`secretKeyRef` objects for byte-identical output across two renders and did NOT catch a mutation
pointing the reference at the wrong secret, because a `secretKeyRef` is a K8s-native reference
resolved at pod-start, not template time, so it is byte-identical regardless of what it points at.

### 4. `install.sh` grows three flags, and stops double-installing backends

`--kube-context` (forwarded to `helm`), `--timeout` (added `--wait --timeout` to the helm
invocation — **it had none before this ADR**, so an air-gapped install previously reported success
the instant the API server accepted the release, not once pods were actually Ready), and
`--skip-bundled-backends`. The third exists because `scp install` turns `stackd.enabled` on
explicitly (§3): `install.sh`'s helm branch already ran a **second**, older mechanism for the
Argo/Gitea backends (`scp-bundled.sh enable <backend>`, `kubectl apply --server-side` under a
different field manager) that pre-dates the stack controller. With the controller enabled, an
air-gapped `scp install` would apply the same backend through **both** mechanisms — real risk of two
field managers fighting over the same objects, not merely wasted work. `scp install --bundle` passes
`--skip-bundled-backends` and drives backend-enable through the Standard Stack API instead (the
same step as the connected path); a bare `install.sh` invocation (no `scp install`) is unaffected
— it still enables backends the old way, exactly as before.

**#422 adversarial review, SHOULD-FIX 7 — `--kube-context` was resolved more than once.** Every
`kubectl`/`helm` call re-read `$KUBECONFIG`'s current-context independently, so nothing pinned them
all to the SAME cluster if the ambient current-context changed mid-run, and `scp-bundled.sh` (called
from `install.sh`) had no `--kube-context` of its own at all — a split-brain where `install.sh`'s own
`helm` calls targeted one context and its `scp-bundled.sh enable` calls silently targeted whatever
was ambient. Fixed by resolving the context ONCE, building an isolated `KUBECONFIG` from it
(`kubectl config view --minify --context=… --flatten`, the same technique
`scp-install-kind-drill.sh` already used) immediately after arg parsing in both `install.sh` and
`scp-bundled.sh` (which gained the flag), and printing the resolved target cluster before acting —
even under `--yes` — in `install-cli.ts` (`target: kube context '…', namespace '…', release '…'`).

### 5. An empty org's home route

`apps/web/src/routes/setup.tsx`: `isOrgEmpty` (pure) + `useOrgIsEmpty` (three `limit: 1` queries —
execution systems, deployment targets, components) define "nothing configured" precisely as **all
three empty**; `undefined` ("still loading") is never treated as empty, so a slow network cannot
flash the setup flow at a returning user with a populated org. `router.tsx`'s `HomePage` renders
`SetupPage` in that case instead of `DashboardPage`/`OutpostDashboardPage` — no URL redirect, `/`
itself renders differently. `/setup` was **already** linked from navigation
(`AppShell.tsx`, both the commander and outpost nav trees existed before this ADR) — nothing to
add there.

**#422 adversarial review, SHOULD-FIX 8 — two more states `isOrgEmpty` had conflated with
"loading".** First, a permanent lookup **error** (not merely slow) also returned `undefined`
forever, so `HomePage` rendered the empty-org skeleton indefinitely instead of ever showing anything
— fixed by threading `isError` from all three queries into a new `anyErrored` field; an error now
resolves `isOrgEmpty` to `false` (render the dashboard, which then shows its own error state, rather
than hang). Second, the three `limit: 1` queries are scoped to what the CALLER can read, not to the
org as a whole — a user narrowly scoped to a team with nothing configured yet, in an otherwise
populated org, satisfied "all three empty" and got routed into setup as if the ORG were new. Fixed
by requiring the caller also hold an org-representative role (`ORG_REPRESENTATIVE_ROLE_NAMES =
["Owner", "OrgAdmin"]`, read from `GET /auth/me`'s `roleBindings` — already-available data, avoiding
a new org-wide-count endpoint) before "all three empty" is treated as "the org is new"; a narrowly
scoped non-admin caller in a populated org now always sees the dashboard.

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
- **The bootstrap-admin Secret is permanent, blanked but never removed** (§2's redact-not-delete
  fix). It sits beside the postgres/app-secrets Secrets for the life of the release — cosmetically
  present, never read by any code path once the admin user row exists (blanked or not). An operator
  who wants it gone entirely can `kubectl delete secret <fullname>-bootstrap-admin`; a subsequent
  `helm upgrade` then regenerates a fresh (also-unused) one, which is harmless for the same reason.
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
- **`$SCP_API_URL` only overrides a STORED session's base URL when it names the SAME host** (#422
  SHOULD-FIX 5, an M28-class hole: `clientFromStoredCredentials`, `packages/cli/src/client-factory.ts`
  — an ambient env var previously decided, unconditionally, where the stored session TOKEN got
  re-sent). A same-host, different-port override (the `scp install`/drill port-forward reopening on
  a new ephemeral port — the reason this existed at all) still works; a different-HOST value now
  refuses and asks for an explicit `--base-url` instead, since a flag on the same command line is
  consent and an inherited env var is not. `scp login`'s OWN `resolveLoginBaseUrl` is unchanged —
  a separate, pre-existing door (no stored token to leak yet at that point) out of scope here.
- **`redactSecretKey`'s `kubectl patch` failure is loud, not swallowed** (#422 SHOULD-FIX 9). It
  previously ignored the patch's exit code; a failed blank (RBAC denied, object recreated
  mid-install, …) silently left the plaintext live in the Secret while the installer reported
  success. It now throws with the exact remediation `kubectl patch` command on failure — caught at
  the call site so the rest of the install still completes (the login already succeeded; the
  operator can re-run the redaction command by hand), but printed as a WARNING that cannot be
  missed rather than swallowed.
- **Every release still gets FIVE fixed-name backend namespaces** (`argocd`, `argo-workflows`,
  `argo-rollouts`, `argo-events`, `gitea` by default — ADR-0058 §4) when the stack controller is
  enabled, whichever release turned it on first. Two `stackd.enabled: true` releases cannot
  currently share one cluster: the second install's controller would collide with the first's
  namespaces/RBAC. Not fixed here (a real multi-release-per-cluster story is namespace-prefixing or
  scoping work of its own, out of this ADR's scope) — documented per the #422 review's NIT so it
  is a known limitation, not a silent trap.
