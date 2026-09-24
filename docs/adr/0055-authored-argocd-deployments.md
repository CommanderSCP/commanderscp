# ADR-0055: SCP creates Argo CD Applications and authors their Rollouts through the trigger it already has — and still only reads the Rollout

**Status:** Accepted (2026-09-23). The design choice is D3 of BUILD_AND_TEST.md §M28 ("SCP authors the Rollout manifest, and still only observes its steps"), taken 2026-09-23. This ADR records how it is delivered, the one premise of D3 that measurement refuted, the owner's three rulings of 2026-09-23 (D-a/D-b/D-c below), and the fix round forced by adversarial review of PR #413 (D9–D12).
**Relates to:** [ADR-0008](0008-observe-enrichment-signals.md) §3 (rollout state is observed, never driven — unamended, and now a standing test), [ADR-0002](0002-execution-strategy.md) (Mode A/B), [ADR-0003](0003-internal-egress-for-execution-systems.md) (the egress grant the test path uses), [ADR-0007](0007-executor-binding-type-taxonomy.md) (Argo CD is `configuration`), [ADR-0028](0028-stage-scoped-component-coupling.md) §2.2 (why a step index is not comparable across Rollouts today), [ADR-0052](0052-server-derived-run-material-wins-for-host-reaching.md) (server-derived material), [ADR-0053](0053-build-destination-by-artifact-class.md) §4a (build destination keys, folded into D9), ADR-0054 (M28.2's Argo ops keys register into D9's table), [ADR-0032](0032-dependency-subscriptions.md) §8 (the one repository-write SCP holds), `docs/proposals/import-existing-executors.md` (the import half), `docs/proposals/team-pipeline-iac.md` D12 (rollout authority split), PROJECT_CHARTER.md principle 1.

**Numbering note (claimed 2026-09-23):** `origin/main` holds 0053 (M28.1); 0054 is M28.2's (#414). Per ADR-0044's note, re-check against `main` at merge.

## Context

The owner's 2026-09-22 ask: *"in our case we'll need to create."* SCP could import and coordinate an existing Argo CD Application (Mode A: `argocd-discovery`, `executor_bindings.external_ref`), but had no way to deploy a component nobody had written an Application for. Nothing produced a Rollout either: `argocd/src/index.ts` reads the Rollout node out of `status.resources[]`, and ADR-0008 §3 forbids driving it.

**D3's premise was measured, and it is false.** D3 reads *"writing the manifest as part of the deployment config SCP already emits does not [drive rollout state]."* A census (`grep -rna`, every tracked file, no filter) for any producer of `kind: Application` or `kind: Rollout` finds only the vendored upstream `install.yaml`s and the argocd plugin's readers. **SCP emitted no Kubernetes deployment config.** Two things *are* emitted toward an executor:

- **Server-derived trigger material:** `buildLaneTriggerParameters`, and `opsLaneTriggerParameters` per ADR-0052.
- **Repository writes.** The only one SCP holds is `scp-managed-dep`'s charter-enumerated class (ADR-0032 §8). It edits the version of a dependency a manifest *already declares*; it never adds a file.

D3's *conclusion* still stands, because authoring is not driving. Its *door* had to be chosen.

## Decision

### D1 — The door is the executor trigger, carrying server-derived material. There is no new verb and no git write.

A third lane, `deployLaneTriggerParameters` (`apps/server/src/coordination/deploy-lane-trigger-parameters.ts`), is called from `reconcile.ts` beside the build and ops lanes. It applies when a component declares `properties.deployment` and its binding resolves to the `argocd` module. It derives a complete Argo CD `Application`. The Application's only source is the carrier chart (D2); the SCP-authored manifests sit in `spec.source.helm.valuesObject.manifests`.

`@scp/plugin-argocd`'s existing `trigger` then:

1. Validates the document against the operator's declaration (D9's second layer).
2. GETs the Application.
3. Creates it (`POST /api/v1/applications`), or updates it (`?upsert=true`) only under D5's identity rule.
4. Syncs it, as it syncs an imported one.

**Why this is inside principle 1:**

1. **The verb set is unchanged.** `ExecutorPlugin` is still `observe`/`trigger`/`status`/`abort`/`describeCapabilities`, and `TriggerIntent.kind` is unchanged.
2. **The write goes to the execution system's input, never to the infrastructure.** An Application is the desired state Argo CD is asked to sync. That is the same class as the WorkflowTemplate submission `@scp/plugin-argo-workflows` makes to trigger a build. The manifests reach Kubernetes only when Argo CD's own controller applies them, with Argo CD's own credentials. SCP holds a scoped Argo CD API token, as it already did. It holds no kubeconfig, ServiceAccount token or cloud credential.
3. **The token is bounded by a dedicated project, not only by RBAC (D10).** Argo CD's controller is cluster-admin. What bounds SCP's token is therefore what the *project* lets an Application contain.

**Rejected — GitOps (commit the manifests to a config repo).** D3 assumed this door existed, and it does not. Building it would give SCP a repository-write class the charter does not enumerate: authoring new files, not editing a declared version. That needs a charter amendment, plus a git credential per tenant repo.

**Rejected — a new executor verb (`ensureApplication`).** It is a sixth verb on an interface the charter enumerates at four. Creating an executor-side object as part of triggering it already has precedent in Argo Workflows `submit`.

### D2 — The carrier chart is a pass-through the operator installs once

`deploy/helm-bundled/authoring/scp-authored-manifests` renders `.Values.manifests` verbatim and nothing else. Every byte that lands in the cluster is therefore authored by the server, where it is asserted exactly. The chart rides the air-gap bundle, and is `.helmignore`d out of the bundled release.

The operator names the carrier on the Argo CD execution-system as:

```
properties.authoring = { repoURL, path | chart, targetRevision, project, namespaces[] }
```

| Field | Rule |
|---|---|
| `targetRevision` | Required. A carrier that floats with HEAD is a carrier nobody reviewed. |
| `project` | Required, and never `default`. |
| `namespaces` | Required. `default` and `kube-*` are refused by the schema. |

**The only authored kinds are `Rollout`, and the two `Service`s a blue-green Rollout switches between.** They are ClusterIP only. A blue-green Rollout rewrites those Services' selectors, so they must exist; nothing else is needed for canary or rolling. `AUTHORED_MANIFEST_KINDS` is written three times — in `@scp/schemas`, in the plugin, and in the AppProject's whitelist. Tests pin the copies equal.

### D3 — Where the Rollout's steps come from (owner ruling D-a, 2026-09-23)

In order of precedence:

1. **The component's own D12 declaration wins.** That is `component_rollouts`, target class `cluster`, written by the `CanaryRollout` / `RollingRollout` / `BlueGreenRollout` constructs.
2. **The release topology's wave `rollout` applies only where the component declares none.**
3. **Absent both,** the Rollout is a canary with no steps, which Argo runs as a rolling update.

The source used is stamped on the Application (`commanderscp.io/rollout-source: component | wave:<name> | none`), so the choice is never a silent contradiction.

The wave is found by **place membership** in the plan's **snapshotted** `topology_document`, not the compiled wave index. A sequential wave splits into several compiled waves, so the index would not line up. If two waves name one place with different rollouts, the authoring is refused. That component-level declaration is also what the plugin's D12 capability, `rollout: {authority: "triggerParams"}`, now carries. Review finding 8 had noted that the capability named a declaration nothing ever sent.

The strategy mapping:

| Declared | Authored `spec.strategy` |
|---|---|
| `canary` steps | `canary.steps`: `setWeight: w`, then `pause: {duration: "<n>s"}` when `pauseSeconds > 0` |
| `rolling`, no pause | `canary: {maxSurge: "<b>%", maxUnavailable: 0}` |
| `rolling` + `pauseBetweenSeconds` | the same, with steps climbing by `b` and a timed pause between |
| `blueGreen` | `blueGreen: {activeService, previewService, autoPromotionEnabled: true, autoPromotionSeconds}`, plus the two Services |
| nothing | `canary: {}` |

### D4 — SCP never authors a step only `promote` can release (owner ruling D-b, 2026-09-23)

A pause with no duration waits for `promote`, and ADR-0008 §3 forbids SCP that verb. Every authored pause is therefore timed.

**Blue-green is supported, with `autoPromotionSeconds` REQUIRED** (`RolloutStrategySchema`): the controller promotes itself. The requirement is enforced three times:

1. The schema refuses a declaration without it at propose or apply time.
2. The deploy lane refuses, with a Decision, a stored declaration that lacks it — for example one written by an older writer.
3. The plugin refuses any blue-green that does not auto-promote.

### D5 — Authorship and identity are labels, and together they are the only licence to overwrite

Every authored Application carries these labels:

- `commanderscp.io/authored=true`
- `commanderscp.io/org`
- `commanderscp.io/component`
- `commanderscp.io/target`

The plugin refuses to update an Application that lacks the first label, or whose identity labels differ. Names are collision-free by construction: the folded display name plus 8 hex of a hash over the component and target ids (review finding 6). Before this, `ca-eu`@`west` and `ca`@`eu-west` folded to the same Application. A component that was imported (`properties.argocdApplication`) *and* declares `deployment` is refused server-side.

### D6 — After creation, SCP only reads the Rollout: ADR-0008 §3 as a standing test

Each of the following is mutation-proved.

- **A behavioural stand-in, content-aware.** `@scp/plugin-testkit`'s `startArgoCdStandIn` allows exactly four write shapes: create, upsert, sync and abort-operation. Any other write is recorded as a violation — `resource/actions`, `/resource` writes, Application delete, PUT, any kube-API path. The allowed shapes are also content-checked (review finding 4). A create or upsert carrying any of the following is a violation:
  - `spec.paused`
  - an indefinite pause
  - an empty step list
  - a `status`
  - a blue-green that does not auto-promote
  - a kind other than Rollout or Service

  This is a second implementation, independent of the plugin's own guard.
- **Exact equality.** Both the plugin suite and the integration suite compare what reached Argo CD with the document the server derived, using `toEqual` rather than `toMatchObject`.
- **The server renderer is pinned** document-for-document.
- **At the credential:** see D10.

### D7 — Refusals are terminal, audited and pre-trigger

Every refusal goes through M28.1's typed channel (`TriggerParameterRefusal` → `blockWaveTarget`): a terminal status, a `block` Decision naming the `cause`, and a hash-chained audit event, before `trigger()`.

The deploy lane's causes:

| Cause | Meaning |
|---|---|
| `no_authoring` | the bound Argo CD declares no `authoring` |
| `authoring_unreadable` | the `authoring` declaration does not parse (e.g. project `default`) |
| `deployment_unreadable` | `properties.deployment` does not parse |
| `imported_and_declared` | the component was imported and also declares a deployment |
| `namespace_invalid` | the place's namespace is not an RFC 1123 label |
| `namespace_not_allowed` | the namespace is outside the allowlist |
| `multiple_digests` | the change carries more than one OCI digest |
| `application_name_invalid` | the binding names an invalid Application |
| `wave_plan_unreadable` | the snapshotted wave plan cannot be read |
| `ambiguous_wave_rollout` | two waves name the place with different rollouts |
| `component_rollout_unreadable` | the component's D12 declaration cannot be read |
| `blue_green_needs_port` | blue-green, with no `containerPort` for its Services |
| `rollback_without_prior` | see D8 |
| `rollback_prior_foreign` | see D8 |

### D8 — A rollback re-authors the prior manifest (owner ruling D-c, 2026-09-23)

An authored Application's `status()` reports `stateRef = { revision, scpAuthoredApplicationJson }`. That is its own live manifest, with Argo CD's bookkeeping stripped. The next forward trigger records it as the target's `priorStateRef`, as it already did for any executor.

A rollback re-authors that prior manifest through the same door and the same checks, then syncs with no revision.

- **Why JSON text, not an object:** `priorStateRef` is depth-bounded (8) before it is stored, and an Application is deeper. A prior cut by the byte bound fails to parse and is refused.
- **No prior** (the change was this target's first authored deployment): refused with `rollback_without_prior`.
- **A prior authored for another target:** refused with `rollback_prior_foreign`.

### D9 — Server-reserved trigger parameters: one table, one choke point (review finding 1)

**The property.** Every lane derives some parameters as a *bound*. A bound a lane *omits* was filled in by a campaign recipe. The instance review found: a recipe carrying `scpAuthoredApplication` for a component with no `deployment` passed straight through. The plugin then created an Application with a foreign repo, `kube-system` and a cluster-admin ClusterRoleBinding.

`reserved-trigger-parameters.ts` holds the table. `recipeReservedParameterRefusal` is called at the one place a recipe's parameters enter a trigger — `reconcile.ts`, right after they are read, before any lane runs. A recipe naming a reserved key is refused.

| Lane | Keys | Reserved when | Refused as |
|---|---|---|---|
| deploy (ADR-0055) | `scpAuthoredApplication` | always | `recipe_reserved_parameter` |
| managed ops (ADR-0052) | `opsRole`, `opsInventory`, `opsEgressAllowlist`, `opsPrincipals`, `opsCredentialSecretKey` | always | `recipe_reserved_parameter` |
| build destination (ADR-0053 §4a, `BUILD_DESTINATION_PARAMETER_KEYS`) | `registryUrl`, `registryName`, `imageRepository`, `imageDestination`, `packageRepository`, `rpmUploadUrl`, `rpmRepositoryUrl` | the Type has a destination class | `destination_refused`, gate `build_destination_recipe` (ADR-0053's contract, unchanged) |
| build identity | `changeObjectId` | always | `recipe_reserved_parameter` |
| *(may restate)* | `sourceRepo`, `sourceRef`, `sourceCommit`, `dockerfile`, `rpmSpec` | never | recipe wins |

**Registration point:** a new lane that derives a bound adds one entry to `RESERVED_BY_LANE`. M28.2's Argo ops keys (ADR-0054) register there. A census test fails on any lane key that is in neither half of the table. The build lane keeps ADR-0053's own destination check as a second layer for direct callers.

**The plugin's second layer** (`packages/plugins/argocd/src/authored-guard.ts`) assumes the server failed. It refuses, before any write, a document that is not exactly a carrier render the operator declared:

- **Source:** `repoURL`/`path`/`chart`/`targetRevision` equal to the registered carrier.
- **Project:** the authoring project.
- **Destination:** an allowlisted namespace.
- **Manifests:** only Rollout and Service, each in that namespace.
- **Shape:** a key allowlist at every level. That rules out `spec.paused`, `status`, analysis steps, pod-spec fields beyond one container's name/image/ports, `helm.values` text, finalizers, `syncPolicy` options, and non-ClusterIP Services.

A binding carries the execution-system's `authoring` into the plugin because the plugin's manifest now declares it; `executionSystemPluginConfig` copies only declared keys. An Argo CD with no usable `authoring` is import-and-coordinate only: every authored Application is refused.

### D10 — The authoring project (review finding 2)

In the bundled Argo CD, authoring is **off by default**. Setting `bundledExecutor.argocd.authoring.{project, carrierRepoURL, namespaces}` renders a dedicated AppProject:

| Field | Value |
|---|---|
| `sourceRepos` | the carrier only |
| `destinations` | the allowlisted namespaces on the in-cluster server |
| `clusterResourceWhitelist` | `[]` — nothing cluster-scoped: no Namespace, no ClusterRoleBinding |
| `namespaceResourceWhitelist` | Rollout and Service only |

`create`/`update` are granted to the SCP account on that project only.

The chart **refuses at render**:

- project `default`
- a missing carrier
- empty namespaces
- `default` or `kube-*`
- Argo CD's, SCP's or any bundled backend's namespace

`CreateNamespace=true` is dropped. A destination namespace is one the operator created and allowlisted, and creating one would need the cluster-scoped grant the project deliberately withholds.

**For a customer-run Argo CD (Mode A),** the operator must create an AppProject of exactly that shape and name it in `authoring.project`. The plugin refuses to author into any other project.

### D11 — helm-verify parses Argo CD RBAC the way Argo CD does (review finding 3)

The old pin kept only lines beginning with the literal `"p, scp-coordinator,"`. Three bypasses passed it: `g, scp-coordinator, role:admin`, an unspaced `p,scp-coordinator,applications,action/*,…`, and `policy.default: role:admin`.

`scpArgoCdPolicy` now reads every `policy*.csv` key, splits on commas and trims, and drops comments. helm-verify then asserts:

- the **exact** grant set: `get`/`sync` on `*/*`, plus `create`/`update` on `<project>/*` when authoring is on;
- **no** `g` binding of the account;
- an empty `policy.default`.

Known-positive controls run on every invocation. The authoring AppProject is pinned exactly.

### D12 — A Rollout that is not fully promoted is not a finished deploy (review finding 5)

Argo CD aggregates a canary paused between steps to health `Suspended`, which `phaseAfterFinishedSync` mapped to `succeeded`. SCP therefore advanced waves and finished changes mid-canary: the `docs/plugins.md` §15 hazard, previously *pinned* by a test.

For an Application that manages a Rollout:

| Rollout state | Reported phase |
|---|---|
| Healthy and past its last step | `succeeded` |
| Paused or Progressing | `running` |
| Healthy but short of the last step | `running` |
| Degraded (which includes aborted) | `failed` |

**A forward re-author waits while the prior canary is in flight.** The plugin refuses the trigger, and reconcile retries with backoff, rather than overwrite a live canary — a promote-by-overwrite. **A rollback does not wait:** undoing the in-flight release is its purpose.

## Consequences

- **Parity:**
  - *API/SDK/ScpClient* — no new route; the declarations are properties on existing object types. `pnpm gen` picks up `blueGreen` in `RolloutStrategySchema`: a request-side `oneOf` addition, which is additive.
  - *CLI* — `scp connect argocd --authoring-{repo,path,chart,revision,project,namespace…}`, validated with the server's schema before any write.
  - *Coordination as Code* — `Component({ deployment })`, wave `rollout`, and `BlueGreenRollout`. The estate export round-trips `rollout`.
  - *UI* — the Connect Argo CD wizard's carrier fieldset, including project and namespaces.
- **What changed for existing estates:**
  - Nothing, unless a component declares `properties.deployment` or a recipe names a reserved key.
  - D12 changes one thing for everyone: an imported Application whose Rollout is paused now stays `running` instead of `succeeded`.

## What this did NOT prove

- **No live Argo CD ran.** The real-counterparty check was a disposable kind cluster (`kindest/node` v1.32.2, own kubeconfig, deleted afterwards; the homelab was not touched). It had the vendored, sha256-pinned CRDs: Argo Rollouts v1.10.0, and Argo CD v3.4.5's `applications`/`appprojects`. `kubectl apply --dry-run=server --validate=strict` accepted:
  - the bundled chart's rendered AppProject;
  - five strategy shapes rendered through the carrier chart, blue-green's two Services included;
  - their five Applications.

  A negative control was refused. Not exercised: Argo CD's repo-server rendering the carrier from a real repo, Argo CD evaluating the AppProject and RBAC, and a Rollouts controller walking the steps. No argocd or argo-rollouts image is cached locally.
- **Argo CD 3.x fine-grained RBAC** is taken from upstream's v3.0 upgrade notes and was not measured. Those notes say `applications, update` no longer implies `update/*` on managed resources. D10's project whitelist is the bound that does not depend on it.
- **The in-flight wait** is refuse-and-retry, so a canary that stays paused for longer than reconcile's retry backoff ceiling holds the next release until it settles. That is intended, and not separately bounded.
