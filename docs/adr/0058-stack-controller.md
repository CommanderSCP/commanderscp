# ADR-0058: The Standard Stack is installed and operated by a separate controller, scp-stackd, from typed operator-written desired state

**Status:** Accepted (2026-09-24) — implements M29 decisions E1–E4 (docs/BUILD_AND_TEST.md §M29) for M29.4; the calls marked *this increment's* below are the owner's to overrule
**Relates to:** PROJECT_CHARTER.md "Managed Standard Stack" (2026-09-25); docs/proposals/zero-to-running.md §3, §3a, §9.2; ADR-0002 (Mode B bundled backends); drizzle/0035 + 0076 (the tenant-read / operator-write precedent); drizzle/0104 (instance operator credentials); drizzle/0126 (this ADR's tables)

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
     change it (`PUT …/backends/{b}`, `PUT …/settings`, `POST …/upgrade`, `GET …/diagnostics`) with a
     session *and* an operator credential. The controller, a member of no org, uses exactly two
     doors with its operator credential alone: `GET /instance/stack/spec` and
     `PUT /instance/stack/status`. A status write touches only status columns.

3. **The controller's credential is minted at install, and scpd never holds it.** The main chart
   generates `scp_op_<id>.<secret>` once into a pre-install hook Secret (the secrets-generated.yaml
   pattern, `lookup`-preserved). It is mounted into exactly two pods: the stack controller, which
   presents it, and the migrations Job, which records its argon2 hash with the admin connection
   (`provisionInstallTimePrincipals`). No api/worker pod mounts it (helm-verify asserts this), no
   route returns it, and a replaced Secret revokes the previous row. An operator's revocation
   survives every upgrade. The same step gives `scp_operator` its LOGIN from a chart-generated
   password — the follow-up drizzle/0076's header names as owed — so the operator doors work on a
   default install with no `ALTER ROLE` typed by hand.

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
   - **Memory lives in the backend's own namespace**: the inventory and the last good rendered set
     (gzipped, split across Secrets — Argo Workflows' render is ~11 MB). No Helm release, so no
     1 MB release limit.
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

7. **The Stack page takes an operator credential in the page** (*this increment's call*). Admin ›
   Access says the browser never holds the deployment credential; the Stack page is the owner's
   "capabilities are switches in SCP" surface, so it accepts the credential into component state
   for the life of the page — never storage — and sends it only as the header of the change calls.
   Read-only use needs nothing.

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
- Instance-tier writes are not in the per-org hash-chained audit log — the same, inherited gap as
  every other instance-tier door (freezes, scan floors); an instance audit chain is its own work.
- `stackd.enabled` with `federation.serverMtls.enabled` refuses to render: serverMtls turns scpd's
  whole listener into HTTPS and the controller dials it over plain in-cluster HTTP.
- Disabling a backend removes its workloads and data (its PVC); CRDs and the namespace remain.
- **Seam for M29.2**: `ControllerDeps.afterReady(backend, objects)` runs once a backend's set is
  healthy and returns `needs`; registration, tokens and both egress layers belong there.
- **Not in M29.4**: checking a release feed and self-upgrading SCP (§9.2.1/§9.2.5) — upgrades
  arrive with a new controller image; the credential passthrough (M29.5); role default stacks
  (M29.6).
