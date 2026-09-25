# ADR-0062: Canary out of the box — the stack controller sets up ADR-0055's authoring, Rollouts reaches every target cluster, and an unauthored rollout is refused

**Status:** Accepted (2026-09-25) — implements M29.3 (docs/BUILD_AND_TEST.md §M29); the calls marked *this increment's* below are the owner's to overrule
**Relates to:** ADR-0055 (SCP-authored Applications and Rollouts: the carrier, the project, `authoring`, the typed refusal channel); ADR-0058 (the stack controller); ADR-0061 (auto-wire; a registration's routing is the wiring's, §5); ADR-0008 §3 (Rollouts is observed, never driven); docs/proposals/zero-to-running.md §3a "Target clusters", §6; drizzle/0130

## Context

After M29.2, a Standard Stack install registered its Argo CD, but canary still needed four human
steps (proposal §2): host ADR-0055's carrier chart in a repository the customer controls, create an
AppProject of D10's exact shape, grant the SCP account create/update in it, and set the execution
system's `authoring` — and `authoring` had to be set on an object whose properties, for a
registration, decide nothing (ADR-0061 §5). Argo Rollouts was installed only in the cluster SCP
runs in. And a component that asked for a canary where nothing could author one was deployed as
whatever its executor does by default: a canary asked for, a plain rolling update delivered, and
nothing said.

## Decision

1. **When Argo Rollouts, Argo CD and Gitea are all enabled, the controller sets authoring up end to
   end, as a stack-level step after every backend of the tick** (`apps/stackd/src/authoring.ts`,
   `ControllerDeps.afterStack`). It waits until all three are ready and Argo CD and Gitea are wired,
   then:
   1. **carrier** — pushes `deploy/helm-bundled/authoring/scp-authored-manifests` (from its own
      image) and the Rollouts install for other clusters into `scp-stack/scp-authored-manifests` in
      the bundled Gitea, a PUBLIC repository of an organization only the controller writes (through
      Gitea's multi-file contents API, idempotent by git blob id; anything else in the tree is
      removed), and pins everything to the resulting COMMIT;
   2. **projects** — applies the authoring AppProject `scp-authored` (ADR-0055 D10's shape: the
      carrier as the only source, the one authoring namespace on every target cluster, Rollout and
      Service only, nothing cluster-scoped) and its own project `scp-stack` for the Rollouts
      installs (other clusters only; exactly the kinds that render contains);
   3. **Rollouts on every target** — see 3;
   4. **hand-off** — `PUT /instance/stack/authoring` (its credential only; audited), carrying only
      the commit and the clusters whose Rollouts install is Synced and Healthy at that commit.
   The SCP account's create/update grant on `scp-authored` is rendered with Argo CD's RBAC
   (`values.ts`: `authoring: {project, grantOnly: true}` whenever the three are enabled — a typed
   boolean from the spec), so every resync re-asserts it and no other writer is needed. The chart's
   own project render is skipped under `grantOnly` (a render cannot know the registered clusters);
   the `default`-project refusal applies either way (helm-verify).

2. **scpd derives the registered Argo CD's `authoring` from the hand-off and release constants,
   never from the object's properties** (`apps/server/src/stack/authoring.ts`, `STACK_AUTHORING` in
   `@scp/schemas`): the repository URL is the Gitea WIRING's endpoint (already pinned to Gitea's own
   Service) plus the fixed path; the project, the carrier path and the one namespace (`scp-apps`,
   created by the main chart) are constants; `clusters` is the hand-off's list. The deploy lane
   reads it through `registeredArgoCdAuthoring`, the plugin through `stackWiredRouting`'s config —
   the same rule as the endpoint and token (ADR-0061 §5). *This increment's call:* the
   registration's properties do NOT mirror `authoring`, because the source allowlists fingerprint
   the whole properties object (ADR-0056 addendum 3) and toggling Rollouts would void them; the
   Stack view and `scp stack status` show it instead. With exactly one allowed namespace, a
   deployment that declares none lands in it (the out-of-the-box case declares nothing).

3. **Argo Rollouts reaches every registered target cluster.** For every cluster registered with
   Argo CD besides in-cluster, the controller applies an Application (`scp-rollouts-<name>-<hash>`,
   project `scp-stack`, automated sync, server-side apply) whose source is the carrier repository at
   the pinned commit, path `argo-rollouts/`: the controller's OWN render of the `argo-rollouts`
   backend — the vendored, pinned manifest with the air-gap image retargets — its stack labels
   removed, plus the authoring namespace. A cluster is handed to scpd only once that Application is
   Synced and Healthy at the commit; a place naming any other cluster is refused
   (`cluster_not_allowed`), never deployed where no Rollouts controller runs. A deregistered
   cluster's Application is deleted — with no cascade finalizer: the CRDs, and every Rollout with
   them, are never deleted (ADR-0058). **In-cluster is a target too, and its Rollouts controller is
   this stack's own `argo-rollouts` backend** (*this increment's call*): an Application there would
   run a second controller against the same Rollouts. The in-cluster destination is in the
   authoring project and always allowed while authoring is on.

4. **THE M28 CLASS.** Nothing tenant-writable chooses the carrier repository (a release constant on
   Gitea's pinned endpoint; the commit pins content, so a push by anyone holding a Gitea token —
   including the site-admin token M29.2 wires — changes nothing Argo CD renders, and the controller
   restores the tree on its next tick and hands over only its own commit), the AppProject (a
   constant, applied by the controller), the target cluster set (Argo CD's own registry, read with
   its admin session — registering a cluster is an Argo CD administrator's act, and SCP's account
   holds no `clusters` grant) or the namespaces (a constant; the main chart creates it). The
   controller's input still carries no free string: the spec gains one sha256 (`authoring.
   factsSha256`), compared with the hash of what it derives itself (`stack-spec-census`). A tenant
   `authoring` written onto the registration by raw SQL is never read
   (`stack-authoring.integration.test.ts`).

5. **Withdrawal is immediate and in scpd.** Disabling Argo CD, Gitea or Argo Rollouts
   (`PUT /instance/stack/backends/{b}`) and unwiring Argo CD or Gitea (`dropWiring`) clear authoring
   in the same transaction, audited (`stack.authoring.withdraw`); the controller's `DELETE
   /instance/stack/authoring` and its removal of the Rollouts-to-target Applications follow on its
   tick. The two projects are kept: Applications already authored into `scp-authored` keep running.
   From the moment of withdrawal, a component asking for a canary is refused `no_authoring`.

6. **Refusal, not silent degradation** (`refuseUnauthoredRollout`,
   `deploy-lane-trigger-parameters.ts`). At a DEPLOY (`configuration`) trigger, a rollout is
   REQUESTED when the component declares a D12 rollout (`component_rollouts`, any target class) or
   the release topology's wave plan declares a `rollout` naming the target, its place or its
   component. Only the authoring lane honours one — `@scp/plugin-argocd` alone declares a rollout
   capability. **The census** (`deployLaneTriggerParameters`, every `return undefined`, no filter)
   found two paths that fell back silently: the module is not `argocd`, and the component declares
   no `properties.deployment` (an imported Application synced as-is). Both now refuse with a Decision
   and an audit event through M28.1's typed channel, cause `rollout_not_authored`, reason
   `executor_cannot_author` / `no_deployment_declared`. The target-shape returns (not a component or
   placement; a vanished object) request nothing; the argocd-with-deployment path refuses its own
   way (`no_authoring`, `cluster_not_allowed`, …). A rollback requests no rollout and is never
   refused on this ground. Outside the deploy lane, `docs/plugin-api.md` §14's "an executor bound to
   a target whose class it does not list is loud-unbound" was never enforced by the resolver
   (`targetClasses` has no server reader); the refusal above is what now closes that case for
   rollouts.

## Consequences

- **Parity:** API (`PUT`/`DELETE /instance/stack/authoring`, `StackView.authoring`, the spec's
  `authoring` hash) → SDK (`ScpClient.stack.putAuthoring / deleteAuthoring`, controller-only) → CLI
  (`scp stack status` prints the authoring line) → UI (Admin › Stack's authoring line). IaC: not
  applicable, as ADR-0058 §8 — instance-tier operator configuration; the component side
  (`Component({ deployment })`, `CanaryRollout`) was already IaC (ADR-0055).
- **New rights, stated plainly:** a Role in Argo CD's namespace, argoproj.io `applications` and
  `appprojects` get/list/create/patch/delete, bound to the controller alone (helm-verify pins it
  exactly and its binding namespace); the `scp-apps` Namespace (kept on uninstall). The controller
  now also calls Argo CD's `GET /api/v1/clusters` with the admin session it already used for the
  token mint.
- **Migration** drizzle/0130: four columns on `stack_settings` (table-level grants and FORCE RLS
  already cover them).
- **One served org** still (ADR-0061 §7): the authoring project and namespace are shared by the
  one org the stack serves; per-org projects and namespaces are M29.6's per-org isolation.
- **What the DoD does not prove:** the kind suite (`stack-canary.kind.test.ts`) has ONE cluster, so
  a Rollouts-to-target Application is proved to be authored, admitted by the stack project and NOT
  handed over while unhealthy — against a registered but unreachable cluster — and not proved to
  install Rollouts on a real second cluster; `authoring.test.ts` proves the handed-over-once-healthy
  path against Argo CD's reported status. Argo CD reads the carrier as an anonymous clone of a
  public repository: an install that sets Gitea's `REQUIRE_SIGNIN_VIEW` would need a repository
  credential, which is not built.
