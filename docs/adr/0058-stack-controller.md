# ADR-0058: The Standard Stack is installed and operated by a separate controller, scp-stackd, from typed operator-written desired state

**Status:** Accepted (2026-09-24; revised 2026-09-25 after the #421 adversarial review and the owner's decision on §7) — implements M29 decisions E1–E4 (docs/BUILD_AND_TEST.md §M29) for M29.4; the calls marked *this increment's* below are the owner's to overrule
**Relates to:** PROJECT_CHARTER.md "Managed Standard Stack" (2026-09-25); docs/proposals/zero-to-running.md §3, §3a, §9.2; ADR-0002 (Mode B bundled backends); drizzle/0035 + 0076 (the tenant-read / operator-write precedent); drizzle/0104 (instance operator credentials); drizzle/0126 + 0127 (this ADR's tables)

## Context

The charter now says CommanderSCP installs, wires, upgrades and operates the backends it bundles,
through a controller kept apart from the coordination server. Until M29.4 the bundled backends were
installed by `scripts/scp-bundled.sh`, run once by hand: `helm template` of `deploy/helm-bundled`,
`kubectl apply --server-side`, a rollout wait. Nothing kept them in a desired state, nothing
upgraded them with SCP, and nothing reported their health to SCP.

## Decision

1. **A separate component and image (E1).** `apps/stackd` (TypeScript, Node 22), image `scp-stackd`,
   one Deployment in the main chart under its own ServiceAccount. It is never a role of `scpd`.

2. **Desired state is instance-tier operator configuration (E2).** Two tables (drizzle/0126),
   `stack_backends` (one row per backend: `enabled`, `size_tier`, and the controller's status
   columns) and `stack_settings` (update policy, upgrade generation, controller heartbeat). No
   `org_id`. `scp_app` holds SELECT only; `scp_operator` holds the writes; FORCE RLS with a
   `tenant_read` and an `operator_write` policy — `scanner_assignments`' two barriers exactly.
   - **The spec is enumerated values only**: a backend name, a boolean, a tier, an update policy
     and an integer. `stack-spec-census.test.ts` walks the JSON schema of the controller's input
     and fails on any free string, so the next "just a URL" field is a red build, not a review note.
   - **Two audiences, two kinds of door.** People read `GET /instance/stack` with a session and
     change it (`PUT …/backends/{b}`, `POST …/backends/{b}/purge`, `PUT …/settings`,
     `POST …/upgrade`, `GET …/diagnostics`) with INSTANCE AUTHORITY (§7): a session holding the
     instance-operator role, or — for a machine — a full-scope operator credential. The controller,
     a member of no org, uses exactly two doors with its own credential alone:
     `GET /instance/stack/spec` and `PUT /instance/stack/status`. A status write touches only
     status columns, and ONLY the controller's credential may make one (review N1): no other
     credential and no session, whatever it holds, can write what the Stack page reports.

3. **The controller's credential is minted at install, scoped, and scpd never holds it.** The main
   chart generates `scp_op_<id>.<secret>` once into a pre-install hook Secret in the controller's
   OWN namespace (§6; the secrets-generated.yaml pattern, `lookup`-preserved), mounted into exactly
   one pod, the controller. The migrations Job never sees it: a second hook Secret in the release
   namespace carries only its id and the sha256 of its secret, which the Job records with the
   admin connection (`provisionInstallTimePrincipals`; a 256-bit random secret needs no argon2,
   and the Job cannot present what it records). The row is **`scope = 'stack-controller'`**
   (drizzle/0127, review N1): it opens the spec read and the status write and nothing else — every
   other instance door requires `scope = 'full'`. No api/worker pod mounts either Secret's
   credential material (helm-verify asserts this), no route returns it. **Rotation** is replace
   the Secret, then `helm upgrade`: the render reads the new credential back, the Job records it
   and revokes the previous one **by the credential id recorded at provisioning**
   (`stack_settings.controller_credential_id`, review N2 — never by a name match a lookalike could
   satisfy), and a salted checksum of the credential on the pod template rolls the controller onto
   it (review S2). An operator's revocation survives every upgrade. The same step gives
   `scp_operator` its LOGIN from a chart-generated password — the follow-up drizzle/0076's header
   names as owed — so the operator doors work on a default install with no `ALTER ROLE` by hand.

4. **Rendering reuses `deploy/helm-bundled`, in-process (E3).** A vendored, pinned `helm`
   (`tools/helm/pin.env`, sha256-verified tarball; the controller refuses any other version) runs
   `helm template` with a values FILE derived only from the typed spec, the release the image
   carries, the controller's own deployment facts and secrets it read back from the backend's
   namespace. Apply is server-side apply under field manager `scp-stackd` with `force`. CRDs are
   applied first, as their own step, and must be Established before anything else is sent.
   - **Pruning**: objects the controller applied are recorded in an inventory; a new healthy set
     deletes what it no longer contains, and only objects carrying this backend's
     `stack.commanderscp.io/*` labels. **CRDs are never deleted** (deleting one deletes every custom
     resource of its kind, cluster-wide — Helm's own rule), and namespaces are the main chart's.
   - **Memory lives in the controller's own namespace** (review S1): the inventory, the retained
     data refs and the last good rendered set (gzipped, split across Secrets — Argo Workflows'
     render is ~11 MB). No Helm release, so no 1 MB release limit. Its first home, the backend's
     namespace, is writable by the backend's own ServiceAccounts, which would have let a backend
     rewrite the set the controller falls back to or the list it prunes from.
   - **What is read back is verified before it is acted on** (review S1). Every report carries
     the sha256 of the stored last good set and of the inventory; scpd keeps them on the status
     row and hands them back in the spec (`integrity`). A stored state that does not match is not
     used: an unrecognised last good set is dropped, never applied (the backend proceeds as if it
     had nothing to fall back to), and an unrecognised inventory is replaced by the current render
     for pruning; the report says so (`state-integrity`) and hands scpd back ITS record, never the
     mismatched digest. Independently, every render, every stored set before a fall back and every
     ref before a prune is held to `STACK_KINDS` — the kinds the controller's RBAC grants, held
     together with `stackd-rbac.yaml` by `manifests.test.ts` — and to the backend's own namespace,
     and a stored set is re-stamped with the backend's labels before it is applied. Nothing
     recorded yet (a first report) is trusted on first use; the kind and namespace checks still
     apply.
   - **Data is kept** (review S3): disabling a backend removes its workloads and config and KEEPS
     its PersistentVolumeClaims and generate-once Secrets (Gitea's admin password, `SECRET_KEY`,
     `INTERNAL_TOKEN` — losing one locks the data out), recorded as `retained`; enabling it again
     resumes on them. A release that stops rendering one keeps it retained rather than pruning it.
     Only an explicit purge deletes data: `POST /instance/stack/backends/{b}/purge` (409 while the
     backend is enabled; audited; the Stack page asks for the backend's name to be retyped, the CLI
     for `--i-understand-data-loss`) bumps `purge_generation`, and the controller deletes the
     retained refs once. A purge overtaken by an enable is spent, not deferred.
   - **Two chart changes the controller needed**: Gitea's generate-once `SECRET_KEY` /
     `INTERNAL_TOKEN` became values (`helm template` never sees `lookup`; the controller passes the
     live values back), and Gitea rolls out with `Recreate` (measured on kind: a surged pod can
     never take its RWO volume's level-db lock, so every change would have been rolled back).

5. **Versions are the release's (E4).** The image carries the chart; its tag defaults to scpd's.
   Upgrading SCP replaces the image, and the controller rolls each enabled backend onto what it
   carries, **one backend at a time, health-checked** (`kubectl rollout status`'s rules — not the
   looser rule the kind run caught, which called a stalled rollout over a still-available old pod
   healthy). A set that does not become healthy within `readyTimeoutSeconds` is replaced by the
   last good set, what only the failed set added is pruned, and the attempt is remembered: it is
   not retried until the desired set changes or an operator requests an upgrade. Under
   `updatePolicy: manual` a new release waits for `POST /instance/stack/upgrade`
   (charter "Automatic by Default": automatic is the default). The only deploy-time input beyond
   the image is an image-retarget map (`stackd.imageOverrides`, what the air-gap `install.sh`
   writes), restricted to image fields.

6. **Its rights are near cluster-admin, and the mitigation is separation, not scoping (E1).**
   Upstream Argo installs create CRDs, ClusterRoles and ClusterRoleBindings; creating a role that
   grants what you do not hold needs `escalate`, binding it needs `bind`. There is no smaller grant
   that installs Argo CD. So:
   - **it runs in a namespace of its own** (`stackd.namespace`, default `scp-stackd`, created by
     the chart; review B1). Anything that can create a pod in a ServiceAccount's namespace can run
     a pod AS that ServiceAccount — and in the release namespace the runner Role's `jobs create`
     could do exactly that. Its namespace holds its pod, its credential and its state, and no
     other identity the chart renders has a right there: the render FAILS if `stackd.namespace` is
     the release, the runner or a backend namespace; `tools/helm-verify` evaluates every Role,
     ClusterRole and binding across a value matrix (docker/kubernetes launcher, runner namespace
     empty/set, per-run secrets on/off, every managed class and both bundled backends on) and fails
     on any subject but the controller able to create pods/Jobs/workloads, exec, mint a token,
     impersonate, bind roles or read Secrets there — an unreadable built-in ClusterRole counts as
     granting everything; and the kind suite proves the runner's own token is refused a Job that
     runs as the controller (a SelfSubjectAccessReview says yes to the same Job in the runner's
     namespace, so the refusal is not vacuous). Its NetworkPolicy allows DNS, the API server (the
     `default/kubernetes` endpoints, read at install; `networkPolicy.kubeApi.cidrs` when set; the
     private ranges only on an offline render) and scpd's api pods in the release namespace, by
     namespace AND labels (review N3);
   - the cluster half (`…-stackd-cluster`: CRDs get/create/patch — no delete — ClusterRoles with
     escalate/bind, ClusterRoleBindings, PriorityClasses, and the five backend Namespaces by name)
     is bound once, to the controller's ServiceAccount alone;
   - the namespaced half (`…-stackd-namespaced`) is bound nowhere cluster-wide — only by a
     RoleBinding in each of the five backend namespaces, which the main chart creates
     (`helm.sh/resource-policy: keep`: they hold the backends' data). The controller can read no
     Secret in SCP's own namespace, where scpd's database credentials live;
   - no scpd pod runs as the controller, mounts its token or its credential, and enabling it
     changes no grant any other identity holds — `tools/helm-verify/src/stackd.ts` asserts all of
     that against the render, plus SUFFICIENCY: every kind every backend renders through the
     controller's own values derivation is granted, in backend namespaces only;
   - nothing a tenant writes reaches it: the census above, the operator-only write doors, and
     `controller-inputs.test.ts`, which holds the controller's source to one API client and two
     operations.

7. **Instance-operator authority is a ROLE granted to a user** (owner decision 2026-09-25, asked
   directly; it replaces this increment's first call, a credential typed into the page). The
   server checks it against the caller's normal login session; no credential is pasted into, held
   by or sent from the browser, and the Stack page has no credential field.
   - **Its shape: an instance-tier grant table, not an org role.** `instance_operator_grants`
     (drizzle/0127): `(org_id, user_id)`, who granted it and how, `granted_at`, `revoked_at`; one
     live grant per user (partial unique index). Written only by `scp_operator` (FORCE RLS,
     `operator_write`); `scp_app` reads it, and a tenant session sees only its own org's rows. Not
     a `role_bindings` row, because an org role is administered BY the org: an OrgAdmin can bind
     roles in their own org, so an org-scoped "instance operator" role would let any org's admin
     make themselves operator of every org on the deployment — the M28 shape again (a value
     deciding cluster-wide effects, writable by someone who cannot otherwise grant them). The grant
     lives where only instance authority can write it.
   - **Its doors**: `GET /instance/operators/self` (does my session hold it — what the page asks),
     `GET /instance/operators`, `POST /instance/operators` (201; 409 on a live grant) and
     `DELETE /instance/operators/{grantId}` (stamps `revoked_at`; the history stays). Granting and
     revoking need instance authority themselves — a role holder can grant another user. **The
     first grant** needs a full operator credential (`scp instance-operator grant --org --user
     --operator-token …`) or the M29.1 installer's seam: `instanceOperator.grantBootstrapAdmin`
     (env `SCP_BOOTSTRAP_INSTANCE_OPERATOR=1`) makes scpd grant it to the bootstrap admin once,
     while no live grant exists, audited as `install` — no SQL typed by hand either way. **M29.1
     sets that value**; this increment ships it off.
   - **Every instance-level stack write is audited** (principle 6): enable, disable, size, purge,
     settings, upgrade request, the diagnostics read, and every grant and revoke append to
     `instance_audit_events` IN THE SAME TRANSACTION as the change — hash-chained (sha256 over the
     previous row's hash and the canonical row; an advisory lock serialises appends), append-only
     (`scp_operator` holds SELECT and INSERT, `scp_app` nothing), with the actor (session user and
     org, or the credential id) and the before/after. `GET /instance/audit-events` (and
     `scp instance-operator audit`) re-verifies the chain on every read and names the first broken
     link.

8. **IaC parity: not applicable, deliberately.** A coordination-as-code program is an ORG's estate,
   applied with that org's authority. The stack is instance-tier; putting it in an org's program
   would make it writable by whoever can apply that org's program — exactly the M28 hole (a value
   deciding what runs with cluster rights, writable by someone who cannot grant them). The
   precedent instance-tier surfaces (scanner assignments, instance freezes) have no IaC either.

## Consequences

- **Off by default in M29.4; the flip is planned, not assumed.** `stackd.enabled: false` in the
  chart until M29.1's installer (`scp install`) turns it on for every new install, at which point
  the chart default flips to `true` in the same change (charter: the Standard Stack is on by
  default). Until then a Helm install turns it on with `--set stackd.enabled=true` and nothing else.
- The instance audit chain covers the stack and the operator role only. The older instance-tier
  doors (freezes, scan floors) still write no instance audit rows — the inherited gap, now with a
  chain to join when they are brought in.
- `stackd.enabled` with `federation.serverMtls.enabled` refuses to render: serverMtls turns scpd's
  whole listener into HTTPS and the controller dials it over plain in-cluster HTTP.
- Disabling a backend removes its workloads and config; its data, CRDs and namespace remain until
  a purge (data) or never (CRDs, namespace).
- The controller's image pull secrets must exist in its own namespace (`stackd.imagePullSecrets`,
  else `imagePullSecrets`' names) — pull secrets are namespaced.
- **Seam for M29.2**: `ControllerDeps.afterReady(backend, objects)` runs once a backend's set is
  healthy and returns `needs`; registration, tokens and both egress layers belong there.
- **Not in M29.4**: checking a release feed and self-upgrading SCP (§9.2.1/§9.2.5) — upgrades
  arrive with a new controller image; the credential passthrough (M29.5); role default stacks
  (M29.6).
