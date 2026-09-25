# ADR-0061: The stack controller wires every backend it installs into SCP — token, trust, both egress layers and registration — from its own render, in the same reconcile

**Status:** Accepted (2026-09-25) — implements M29.2 (docs/BUILD_AND_TEST.md §M29); the calls marked *this increment's* below are the owner's to overrule
**Relates to:** ADR-0058 (the stack controller; its `afterReady` seam); ADR-0003 (the two-layer internal-egress model); ADR-0056 addendum 3 (the execution-system routing door); ADR-0002 (Mode B); ADR-0008 §3 (Argo Rollouts is observed, never driven); PROJECT_CHARTER.md "Managed Standard Stack", "CommanderSCP Is the Surface", "Automatic by Default"; drizzle/0128

## Context

M29.4 made the stack controller install the bundled backends. Wiring them into SCP was still the
old install-time path: two Helm post-install hook Jobs (`bundled-{argocd,gitea}-autowire-bin.ts`)
minted a token, stored it in the bootstrap org's secret store, and printed an
`scp executor bind …` command to their pod log. Nothing registered the `execution-system`. Argo
Workflows had no auto-wire at all, and its TLS trust (`executorTls`) was a Secret an operator made
from a hint the script printed. Egress was declared in three places — the execution system's
`allowInternalEgress`, the operator's `SCP_INTERNAL_EGRESS_HOSTS`, and three `allow-<backend>`
NetworkPolicies switched on by main-chart `bundledExecutor.*` flags — and any one missing failed
quietly.

## Decision

1. **Wiring is the controller's `afterReady` step** (`apps/stackd/src/wiring.ts`), run in the same
   reconcile that brings a backend to ready, and again (idempotently) on every ready tick. For each
   backend SCP calls, in order:
   1. **the endpoint comes from the controller's own render** — the Service the chart rendered, its
      port, its selector and container port (`backendEndpoint`); never from the API;
   2. **the network half of egress** — one NetworkPolicy, `scp-stack-egress-<backend>`, in SCP's
      namespace, letting scpd's pods (the chart's selector labels, passed as
      `SCP_STACKD_SCP_POD_LABELS`) reach exactly that backend's pods on the CONTAINER port (the
      post-DNAT destination); applied *before* the hand-off;
   3. **the scoped token, minted on the backend** — Argo CD: an apiKey token for `scp-coordinator`
      via the admin session (initial-admin secret); Gitea: a `write:repository` + `write:package`
      token **for the Gitea site-admin account** (`gitea-admin-secret`) — scope-limited, but the
      identity is the site admin's, so it reaches every repository on the instance (see §7); Argo
      Workflows: the `scp-coordinator` ServiceAccount's bound token (argo-server runs
      `--auth-mode=client`);
   4. **the CA** the endpoint's certificate chains to (argo-server's controller-minted certificate;
      Argo CD and Gitea are plain in-cluster HTTP behind their NetworkPolicies);
   5. **the hand-off**, `PUT /instance/stack/backends/{b}/wiring`, a door ONLY the controller's
      `stack-controller`-scoped credential opens (not a full operator credential, not a session);
   6. only then **every older token of that account is revoked** (Argo CD by token id; Gitea every
      `scp-stack-` token but the new one), so there is never a window without a valid token.

   Argo Events is registered with no endpoint, account or token: SCP never calls it. Argo Rollouts
   is not wired at all (ADR-0008 §3).

2. **The token's life in the controller**: minted into a local, sent in the hand-off body, dropped
   when the function returns. It is never written to the controller's state, a Secret, a log line
   or a status report. What the controller compares next tick is `factsSha256` — a hash over the
   endpoint, namespace, CA, account and the backend instance's identity (argocd-secret's uid, the
   Gitea volume's uid, the token Secret's uid) — which scpd hands back in the spec
   (`StackSpecDocument.wiring`, a sha256 and a counter per backend; the spec census still holds:
   no free string reaches the controller). Equal facts and no rotation request mint nothing; a
   reinstalled backend (new identity), a changed endpoint or CA, or a rotation re-wires. The
   hand-off travels controller → scpd over in-cluster HTTP, like the controller's credential
   already does (ADR-0058: `stackd.enabled` refuses `federation.serverMtls`).

3. **scpd keeps the token at the instance tier, not in an org's secret store**
   (`stack_backend_tokens`, the `secrets` table's AES-256-GCM envelope and master key). THE M28
   CLASS, found in the design it replaces: an org's secret store is addressed BY KEY from
   execution-system properties, so a token the old hook stored as `bundled-argocd-token` could be
   named by any system a tenant with `object:write` + the key's name registered, and sent wherever
   that system pointed. `stack_backend_tokens` is readable by a tenant transaction only from an org
   the stack serves (RLS), written only through `scp_operator`, and never addressed by a key from
   the graph.

4. **Registration**: scpd registers one `execution-system` per wired backend in every organization
   the stack serves (`reconcileStackRegistrations`). The object's id is allocated FIRST, in
   `stack_backend_registrations` (operator-written, tenant-read of the caller's own org), so no
   object a tenant made can become a registration by name. The object is `domainLocal` (this
   instance's backend; a peer could not reach it) and carries `kind`, `serverUrl`,
   `allowInternalEgress`, `namespace` and `stack.backend` — descriptively, and deliberately stable
   across a disable/enable of the same endpoint so the source allowlists that fingerprint the whole
   properties object (ADR-0056 addendum 3) are not voided.

5. **Routing a registration is the wiring's, and only the wiring's**
   (`stack/wired-routing.ts` `stackWiredRouting`, used by the executor resolver and the discovery
   door). For a registration, the endpoint, the token, the CA (`PluginHostInstanceConfig
   .trustedCaPem` → its own env var, for that instance only, never inside `config`) and an
   internal-egress allowance pinned to the endpoint's own host all come from the controller's
   hand-off; the object's properties decide nothing. **The ADR-0003 layer-1 ceiling for a bundled
   endpoint is the controller's knowledge of it**: no `SCP_INTERNAL_EGRESS_HOSTS` entry is needed,
   and — the point — none is added: a TENANT's own execution system aimed at a bundled Service gets
   neither the allowance nor the token. A discovery run against a registration also drops every
   caller key that could name an endpoint or credential (`baseUrl` outranks `serverUrl` in the
   Gitea plugin); the egress pin to the wiring's host is the barrier underneath.

6. **The routing door refuses every other writer of a registration** —
   `assertStackRegistrationWrite` at the object write choke point (create, update, delete) and the
   publish verb (a registration never federates: publishing would journal this instance's
   in-cluster endpoint and internal-egress allowance to peers; the stack itself never publishes),
   whatever the caller holds, `secret:write` included: a tenant attempt to re-point or re-trust a
   wired system is a 409 with the reason. Only `stack/wiring.ts` passes `stackManagedWrite`
   (`stack-registration-door.test.ts`), and routing does not rest on the refusal: a property
   rewritten by any path still routes where the wiring says (asserted with raw SQL).

7. **Which organizations the stack serves — ONE, until M29.6 (owner decision 2026-09-25).** The
   stack is instance-level (ADR-0058 E2) but execution systems are per-org, and every served org
   would drive the SAME backend identities: a served org's tenants can sync any Application the
   bundled Argo CD knows, read and write any repository the Gitea site admin can (the Gitea token is
   the site admin's, §1.3 — not a per-org or non-admin identity), and submit any WorkflowTemplate in
   its namespace. Per-org isolation on the shared backends — an Argo CD AppProject and account, and
   a non-admin Gitea user and organization, per served org — is built in **M29.6**. Until it lands:
   - **a second served organization is refused** (`PUT /instance/stack/orgs/{orgId}` → 409 naming
     the served org, the shared identities and M29.6; `stack-wiring.integration.test.ts`). The
     operator can MOVE the stack (detach, then attach), never widen it;
   - **the Gitea identity stays the site admin's in M29.2**, said plainly: a dedicated non-admin
     SCP user sees no repository it is not a member of, so it is useful only with the per-org Gitea
     organization M29.6 builds — replacing it earlier would make discovery list nothing. With one
     served org, the site-admin reach is that one org's;
   - **the deployment's bootstrap organization is served by default**, on the first wiring — the
     single-org install is wired end to end with no step (charter "Automatic by Default");
   - **any other organization is served only by an instance operator** (`PUT
     /instance/stack/orgs/{orgId}`, `scp stack attach`, Admin › Stack), audited — and, until M29.6,
     only in place of the one served now;
   - **an org cannot serve itself.** An org-admin opt-in (the first-run flow was considered) would
     let an org grant itself reach into every other served org's backend state — the M28 shape.
   - The default fires once (`stack_settings.served_orgs_initialized`); an operator who later stops
     serving the bootstrap org is not overruled. Stopping serving an org keeps its registrations and
     bindings (they refuse to resolve) and removes its tenant transactions' read of any stack token.

8. **Rotation and unwiring go through the controller.** `POST /instance/stack/backends/{b}/rotate`
   (`scp stack rotate`, the Stack page's Rotate) bumps `rotate_generation`; the controller re-mints
   and revokes the old token, and for Argo Workflows also re-mints argo-server's certificate and
   rolls argo-server onto it (a pod-template annotation under its own field manager) — the CA scpd
   trusts follows in the same hand-off. Disabling a backend UNWIRES FIRST — scpd drops the token and
   wiring (`DELETE …/wiring`, controller-only), the egress policy is deleted, and (bounded, best
   effort, while it still runs) the backend's tokens are revoked — then removes it. A registration
   stays, with its bindings, and refuses to resolve until the backend is wired again.

9. **The legacy path is retired.** The main chart's `bundledExecutor` block, the two hook Jobs and
   bins, the three `allow-<backend>` policies and `allow-kube-api-autowire` are deleted
   (helm-verify now fails any render that brings them back); `scripts/scp-bundled.sh` is render-only
   and its `enable` refuses, naming `scp stack enable`; the air-gap `install.sh` turns the controller
   on (and the bootstrap admin's one-shot instance-operator grant, ADR-0058 §7) instead of applying
   backends by hand; the bundled-Argo-CD drill is deleted with the mechanism it drilled. The stale
   Argo Workflows comment ("`server` auth mode, no scpAccount") went with the block.

10. **The controller's new rights, stated plainly.** In SCP's own namespace it may now write
    NetworkPolicies and nothing else (a Role there: `get`/`patch`/`delete` held to the three policy
    names; `create` cannot be limited by name in RBAC, so it could add further allow-only policies
    — bounded by the near-cluster-admin it already holds, ADR-0058 E1). It still reads no Secret in
    SCP's namespace. Its own NetworkPolicy gains egress to the Argo CD and Gitea APIs (8080, 3000)
    in the backend namespaces only. helm-verify holds both.

11. **Two images became retargetable**, because the kind proof could not run without them and an
    air-gapped install could not either: Argo CD's Dex (`argocd.dexImage` — argocd-dex-server sat in
    ImagePullBackOff) and Argo Workflows' `argoexec` (`argoWorkflows.executorImage`, passed as
    `--executor-image` — no workflow pod could start). Both are in the air-gap bundle and
    `install.sh`.

12. **`scp connect gitea`** registers an EXISTING Gitea (Mode A import) exactly as `scp connect
    argocd` does — the token into the org's secret store first, then the system that names it; the
    web wizard (`/connect/gitea`, manifest-driven) already did, and `/setup` now links it.

## Consequences

- Parity: API (the wiring, rotate and served-org doors) → SDK (`ScpClient.stack.putWiring /
  deleteWiring / rotate / orgs / attachOrg / detachOrg`) → CLI (`scp stack rotate|orgs|attach|
  detach`, `scp connect gitea`) → UI (Admin › Stack). IaC: not applicable, as ADR-0058 §8 — this is
  instance-tier operator configuration.
- The kind proof (`stack-wiring.kind.test.ts`, CI job 4e) runs the server's kind suites INSIDE the
  kind node's network namespace (`scripts/kind-runner-harness.sh in-cluster-net`), because the
  plugin dials in-cluster Service names. **kindnet enforces NetworkPolicy** (measured: every call to
  argo-server hung until a fixture admitted the node) — the harness's and job 4e's "kind does not
  enforce NetworkPolicy" comments predate kind v0.24 and are corrected. The suite's scpd is not a
  pod, so the bundle's "only scpd's pods in SCP's namespace" ingress rule is exercised structurally
  (helm-verify) and the node is admitted beside it by a fixture; the controller's egress policy is
  asserted as an object there and against the real render in helm-verify.
- **Registration is per org and never fails a committed write.** The reconcile runs each
  (org, backend) in its own tenant transaction and reports what did not converge instead of
  throwing; the hand-off and attach doors answer for their own commit. The controller revokes a
  backend's old tokens only once the new one is stored — and, if a hand-off's response failed after
  scpd stored it, on the next tick that finds scpd holding exactly that hand-off.
- **Endpoints are pinned twice.** The wiring URL must be the backend's own Service in its own
  namespace (`STACK_BACKEND_SERVICES` in `@scp/schemas`, which the controller derives from too), and
  a discovery against a registration runs that backend's own module with an allowlist of caller
  keys under a server-namespaced plugin instance id (`discovery:<org>:<id>`).
- **Open (owner): Argo Events' inbound wiring.** SCP never calls Argo Events; its sensors would call
  SCP's change-source webhook, which needs an org-scoped reporter credential held in the shared
  backend namespace. Which principal, which permission, and for which served org are the owner's to
  decide; this increment registers it and wires nothing inbound.
- Not in M29.2: authoring (the carrier and AppProject, M29.3); credentials entered in SCP and
  written to a backend (M29.5); imported backends' configuration takeover (M29.6).
