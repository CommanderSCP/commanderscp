# ADR-0055: SCP creates Argo CD Applications and authors their Rollouts through the trigger it already has — and still only reads the Rollout

**Status:** Accepted (2026-09-23). The design choice is D3 of BUILD_AND_TEST.md §M28 ("SCP authors the Rollout manifest, and still only observes its steps"), taken 2026-09-23; this ADR records how it is delivered and the one premise of D3 that measurement refuted.
**Relates to:** [ADR-0008](0008-observe-enrichment-signals.md) §3 (rollout state is observed, never driven — unamended, and now a standing test), [ADR-0002](0002-execution-strategy.md) (Mode A/B), [ADR-0003](0003-internal-egress-for-execution-systems.md) (the egress grant the test path uses), [ADR-0007](0007-executor-binding-type-taxonomy.md) (Argo CD is `configuration`), [ADR-0028](0028-stage-scoped-component-coupling.md) §2.2 (why a step index is not comparable across Rollouts today), [ADR-0052](0052-server-derived-run-material-wins-for-host-reaching.md) (server-derived material, spread last), [ADR-0032](0032-dependency-subscriptions.md) §8 (the one repository-write SCP holds), `docs/proposals/import-existing-executors.md` (the import half), `docs/proposals/team-pipeline-iac.md` D12 (rollout authority split), PROJECT_CHARTER.md principle 1.

**Numbering note (claimed 2026-09-23):** `origin/main` ends at 0052; the concurrent M28.1 and M28.2 branches claim 0053 and 0054. Per ADR-0044's note, re-check against `main` at merge.

## Context

The owner's 2026-09-22 ask: *"in our case we'll need to create."* SCP could import and coordinate an existing Argo CD Application (Mode A: `argocd-discovery`, `executor_bindings.external_ref`), but had no way to deploy a component nobody had written an Application for. Nothing produced a Rollout either: `argocd/src/index.ts` reads the Rollout node out of `status.resources[]`, and ADR-0008 §3 forbids driving it.

**D3's premise was measured, and it is false.** D3 reads *"writing the manifest as part of the deployment config SCP already emits does not [drive rollout state]."* A census (`grep -rna`, every tracked file, no filter) for any producer of `kind: Application` or `kind: Rollout` finds four files. Two are the vendored upstream `install.yaml`s and two are the argocd plugin and its tests, which only read. **SCP emits no Kubernetes deployment config today.** Two things *are* emitted toward an executor. One is server-derived trigger material: `buildLaneTriggerParameters`, and `opsLaneTriggerParameters` per ADR-0052. The other is repository writes, and the only one SCP holds is `scp-managed-dep`'s charter-enumerated class (ADR-0032 §8). That class edits the version of a dependency a manifest *already declares*. It never adds a file. D3's *conclusion* still stands, because authoring is not driving. Its *door* had to be chosen, and that choice is the decision recorded here.

## Decision

### D1 — The door is the executor trigger, carrying server-derived material. There is no new verb and no git write.

A third lane joins the two above: `deployLaneTriggerParameters` (`apps/server/src/coordination/deploy-lane-trigger-parameters.ts`). It is called from `reconcile.ts` beside the build and ops lanes. When a component declares `properties.deployment` and its binding resolves to the `argocd` module, it derives a complete Argo CD `Application`. The Application's only source is the carrier chart (D2), with the SCP-authored Rollout in `spec.source.helm.valuesObject.manifests`. `@scp/plugin-argocd`'s existing `trigger` then does four things. It GETs the Application. It creates it (`POST /api/v1/applications`) if it is absent. It updates it (`POST /api/v1/applications?upsert=true`) only if it carries SCP's authorship label (D5). Then it syncs it, exactly as it syncs an imported one. The material is spread **last** onto the trigger parameters, so a recipe cannot restate it. That is ADR-0052's rule, for ADR-0052's reason: this material is the bound on what gets deployed.

**Why this is inside principle 1:**

1. **The verb set is unchanged.** `ExecutorPlugin` is still `observe`/`trigger`/`status`/`abort`/`describeCapabilities`. No `create`, `deploy` or `apply` was added. `TriggerIntent.kind` is unchanged.
2. **The write is to the execution system's input, never to the infrastructure.** An Application is the desired state Argo CD is asked to sync, in the same class as the WorkflowTemplate submission `@scp/plugin-argo-workflows` makes when it triggers a build. The Rollout reaches Kubernetes only when Argo CD's own controller applies it, with Argo CD's own cluster credentials. SCP holds a scoped Argo CD API token, as it already did. It holds no kubeconfig, no ServiceAccount token and no cloud credential.
3. **The credential widening is bounded and asserted.** In the bundled Argo CD (Mode B), the SCP account keeps `get` and `sync` on `*/*`. It gains `create` and `update` on applications in **one** project (`bundledExecutor.argocd.scpAuthoringProject`, default `default`; empty disables authoring). `tools/helm-verify` pins the exact grant set, so any grant beyond those four fails the render. In a BYO Argo CD (Mode A), the operator grants the same two rights in their own RBAC, or does not. Without them the create is refused by Argo CD with a 403, loudly.

**Rejected — GitOps (commit the manifests to a config repo).** D3 assumed this door existed. It does not, and building it would give SCP a repository-write class the charter does not enumerate: authoring new files, not editing a declared version. That needs a charter amendment, and the owner has not been asked for one. It would also add a git credential per tenant repo, which is more credential surface than a scoped Argo CD token.
**Rejected — a new executor verb (`ensureApplication`).** It is a sixth verb on an interface the charter enumerates at four. Creating an executor-side object as part of triggering it already has precedent (Argo Workflows `submit`). A new verb would widen the contract for no capability `trigger` lacks.

### D2 — The carrier chart is a pass-through the operator installs once

`deploy/helm-bundled/authoring/scp-authored-manifests` renders `.Values.manifests` verbatim and nothing else. Every byte that lands in the cluster was therefore authored by the server, where it is asserted. A template that computed anything would be a second author nobody tests. The operator puts the chart where their Argo CD can read it and names that place on the Argo CD execution-system as `properties.authoring = { repoURL, path | chart, targetRevision, project? }`. `targetRevision` is required: a carrier that floats with HEAD is a carrier nobody reviewed. SCP writes no git. The chart rides the air-gap bundle because the build copies all of `deploy/helm-bundled`. It is `.helmignore`d out of the bundled release, whose 1 MB Secret budget it has no business in.

### D3 — The Rollout's steps are the wave plan's

A release-topology wave may carry `rollout`, in the existing D12 vocabulary (`RolloutStrategySchema`: `canary` steps of `{weightPercent, pauseSeconds?}`, or `rolling` `{batchPercent, pauseBetweenSeconds?}`). `parseTopologyWaves` validates it at propose time. The deploy lane reads it back off the plan's **snapshotted** `topology_document`, never the topology's current revision. It uses the wave that names the target's **place**, never the compiled wave index: a sequential wave splits into several compiled waves. If a place is named by several waves with different rollouts, the authoring is refused. The mapping:

| Wave plan | Authored `spec.strategy` |
|---|---|
| `canary` steps | `canary.steps`: `setWeight: w`, followed by `pause: {duration: "<n>s"}` when `pauseSeconds > 0` |
| `rolling`, no pause | `canary: {maxSurge: "<b>%", maxUnavailable: 0}`, with no steps (Argo's rolling update) |
| `rolling` with `pauseBetweenSeconds` | the same, with steps climbing by `b` and a timed pause between each |
| absent | `canary: {}`, a plain rolling update |

**Why the wave plan rather than a per-component declaration.** Every component released through one wave is written with one step list. That makes a step index comparable across components for the first time: ADR-0028 §2.2 refused `step` as a coupling axis because nothing made two Rollouts' step lists agree. D12's per-component `component_rollouts` (the `CanaryRollout` construct) is **not read** by this lane. Whether it should override or fall back is open, and listed below.

### D4 — SCP never authors a step only `promote` can release

A pause with no duration waits for `kubectl argo rollouts promote`. ADR-0008 §3 forbids SCP that verb, so an authored indefinite pause would be a Rollout nobody is permitted to finish. Every authored pause is timed by construction, and `rolloutStepsFor` has a test over every strategy shape. Blue-green is not in the D12 vocabulary and is not authored. Its non-timed promotion lever is exactly the one SCP may not pull.

### D5 — Authorship is a label, and it is the only licence to overwrite

Every authored Application and Rollout carries `commanderscp.io/authored=true`. The plugin **refuses to update an Application that lacks it**: the name belongs to someone else. A component that was imported (`properties.argocdApplication`) *and* declares `deployment` is refused server-side before any call. SCP creates or imports an Application, never both.

### D6 — After creation, SCP only reads the Rollout: ADR-0008 §3 as a standing test

It is enforced in three places, each mutation-proved:

- **Behavioural, one implementation.** `@scp/plugin-testkit`'s `startArgoCdStandIn` is a recording Argo CD. It allows exactly four write shapes: create, upsert, sync and abort-operation. Every other write is recorded as a violation and refused. That covers `resource/actions` (promote/abort/retry/restart/pause/resume), PATCH/POST/DELETE on `/resource`, deleting the Application (which cascades to its Rollout), any PUT, and any Kubernetes-API path. The argocd unit suite drives every plugin verb against an authored Rollout. The server integration suite drives the real plugin through the reconcile loop. Both assert `violations` empty, and adding a promote call to `status()` turns both red.
- **At the credential.** helm-verify's exact grant set (D1.3) means the bundled SCP token cannot run a resource action.
- **Reachability.** `packages/source-census/src/deployment-authoring-reachability.test.ts` fails if `deployLaneTriggerParameters` loses its `reconcile.ts` caller.

### D7 — Refusals are terminal, audited and pre-trigger; a rollback of an authored target is refused

A declaration that cannot be authored terminalises the wave target as `deployment_authoring_refused` with a `block` Decision naming the cause, before `trigger()`. It joins `REFUSED_WAVE_TARGET_STATUSES`. The causes are: unreadable `deployment`, no carrier, bad namespace, more than one OCI digest, an imported component, and an ambiguous wave. **A rollback of an authored target is refused the same way.** No prior authored manifest is recorded, and re-syncing the Application would re-apply the release being undone: the no-op-reported-as-rollback hazard the plugin's `ROLLBACK_UNAVAILABLE_PREFIX` already closes one layer down. The remedy is to re-propose the prior version as a forward change.

### D8 — The plugin declares D12 authority `triggerParams`

`describeCapabilities().rollout = { authority: "triggerParams", targetClasses: ["cluster"] }`. Argo Rollouts runs the canary and takes SCP's declaration as trigger parameters. The value is never `authoritative`.

## Consequences

- **Parity.** API/SDK/ScpClient: no new route; the three declarations are properties on existing object types, written through the generic object doors, so there is nothing to regenerate. CLI: `scp connect argocd --authoring-{repo,path,chart,revision,project}`, validated with the server's schema before anything is written. Coordination as Code: `Component({ deployment })`, `ReleaseTopology` / wave-item `rollout`, and the estate export round-trips `rollout`. UI: the Connect Argo CD wizard's optional carrier fieldset. A Helm-repository carrier is CLI-only there, which the wizard says. A refused target renders through the existing generic wave-target status.
- **What changed for existing estates: nothing** unless a component declares `properties.deployment`. With no declaration the trigger is byte-identical to the import path.

## What this did NOT prove

- **No live Argo CD ran.** The real-counterparty check was a disposable kind cluster (kindest/node v1.32.2, own kubeconfig, deleted afterwards; the homelab cluster was not touched). The vendored, sha256-pinned CRDs were applied to it: Argo Rollouts v1.10.0 and Argo CD v3.4.5's `applications.argoproj.io`. The production renderer's output then passed `kubectl apply --dry-run=server --validate=strict` for all four strategy shapes, as Rollouts rendered through the carrier chart and as Applications. A negative control (`setWeight: ten`) was refused by the API server. Argo CD's repo-server rendering the carrier from a real repo, its RBAC evaluation, and a Rollouts controller walking the steps were **not** exercised, because no argocd or argo-rollouts image is cached locally.
- **Argo CD 3.x fine-grained RBAC** is taken from upstream's v3.0 upgrade notes and was not measured here. Those notes say `applications, update` no longer implies `update/*` on managed resources, so granting `update` does not grant patching a Rollout.

## Open questions for the owner

1. Should D12's per-component `component_rollouts` (`CanaryRollout`) override the wave plan's `rollout`, fill in where the wave declares none, or be retired for coordinated executors?
2. Blue-green: add it to the D12 vocabulary with `autoPromotionSeconds` required, so no step waits on `promote`? Or leave it unsupported for authored Rollouts?
3. Rollback of an authored target. One option is Argo CD's native history rollback (`POST /applications/{name}/rollback {id}`), which restores a prior synced source, values included. It would need the history id recorded as `stateRef` and the `sync` permission to cover it. Until then, D7 refuses.
