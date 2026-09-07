# plugins

Long-form reference for the **plugins** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 559 of 559 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/plugins/argo-workflows/src/argo-workflows.conformance.test.ts`](#packages-plugins-argo-workflows-src-argo-workflows-conformance-test-ts) — §1–§1
- [`packages/plugins/argo-workflows/src/index.test.ts`](#packages-plugins-argo-workflows-src-index-test-ts) — §2–§2
- [`packages/plugins/argo-workflows/src/index.ts`](#packages-plugins-argo-workflows-src-index-ts) — §3–§8
- [`packages/plugins/argo-workflows/src/test-node-http-client.ts`](#packages-plugins-argo-workflows-src-test-node-http-client-ts) — §9–§9
- [`packages/plugins/argo-workflows/vitest.config.ts`](#packages-plugins-argo-workflows-vitest-config-ts) — §10–§10
- [`packages/plugins/argocd/src/argocd.conformance.test.ts`](#packages-plugins-argocd-src-argocd-conformance-test-ts) — §11–§11
- [`packages/plugins/argocd/src/index.test.ts`](#packages-plugins-argocd-src-index-test-ts) — §12–§20
- [`packages/plugins/argocd/src/index.ts`](#packages-plugins-argocd-src-index-ts) — §21–§31
- [`packages/plugins/argocd/src/test-node-http-client.ts`](#packages-plugins-argocd-src-test-node-http-client-ts) — §32–§32
- [`packages/plugins/argocd/vitest.config.ts`](#packages-plugins-argocd-vitest-config-ts) — §33–§34
- [`packages/plugins/dependency-index-oci/src/index.test.ts`](#packages-plugins-dependency-index-oci-src-index-test-ts) — §35–§35
- [`packages/plugins/dependency-index-oci/src/index.ts`](#packages-plugins-dependency-index-oci-src-index-ts) — §36–§39
- [`packages/plugins/dependency-index-oci/vitest.config.ts`](#packages-plugins-dependency-index-oci-vitest-config-ts) — §40–§41
- [`packages/plugins/dependency-index-registries/src/common.ts`](#packages-plugins-dependency-index-registries-src-common-ts) — §42–§45
- [`packages/plugins/dependency-index-registries/src/index.test.ts`](#packages-plugins-dependency-index-registries-src-index-test-ts) — §46–§46
- [`packages/plugins/dependency-index-registries/src/index.ts`](#packages-plugins-dependency-index-registries-src-index-ts) — §47–§53
- [`packages/plugins/dependency-index-registries/src/test-support.ts`](#packages-plugins-dependency-index-registries-src-test-support-ts) — §54–§54
- [`packages/plugins/dependency-index-registries/vitest.config.ts`](#packages-plugins-dependency-index-registries-vitest-config-ts) — §55–§56
- [`packages/plugins/fake-executor/src/config-schema-parity.test.ts`](#packages-plugins-fake-executor-src-config-schema-parity-test-ts) — §57–§58
- [`packages/plugins/fake-executor/src/fake-executor.conformance.test.ts`](#packages-plugins-fake-executor-src-fake-executor-conformance-test-ts) — §59–§59
- [`packages/plugins/fake-executor/src/index.test.ts`](#packages-plugins-fake-executor-src-index-test-ts) — §60–§61
- [`packages/plugins/fake-executor/src/index.ts`](#packages-plugins-fake-executor-src-index-ts) — §62–§70
- [`packages/plugins/fake-executor/vitest.config.ts`](#packages-plugins-fake-executor-vitest-config-ts) — §71–§72
- [`packages/plugins/federation-https/src/index.ts`](#packages-plugins-federation-https-src-index-ts) — §73–§75
- [`packages/plugins/federation-https/vitest.config.ts`](#packages-plugins-federation-https-vitest-config-ts) — §76–§77
- [`packages/plugins/git-provider-core/src/index.test.ts`](#packages-plugins-git-provider-core-src-index-test-ts) — §78–§80
- [`packages/plugins/git-provider-core/src/index.ts`](#packages-plugins-git-provider-core-src-index-ts) — §81–§92
- [`packages/plugins/git-provider-core/src/read-file.test.ts`](#packages-plugins-git-provider-core-src-read-file-test-ts) — §93–§96
- [`packages/plugins/git-provider-core/src/read-file.ts`](#packages-plugins-git-provider-core-src-read-file-ts) — §97–§119
- [`packages/plugins/git-provider-core/src/read-tree.test.ts`](#packages-plugins-git-provider-core-src-read-tree-test-ts) — §120–§120
- [`packages/plugins/git-provider-core/src/read-tree.ts`](#packages-plugins-git-provider-core-src-read-tree-ts) — §121–§127
- [`packages/plugins/git-provider-core/vitest.config.ts`](#packages-plugins-git-provider-core-vitest-config-ts) — §128–§129
- [`packages/plugins/gitea/src/gitea-test-support.ts`](#packages-plugins-gitea-src-gitea-test-support-ts) — §130–§131
- [`packages/plugins/gitea/src/gitea.conformance.test.ts`](#packages-plugins-gitea-src-gitea-conformance-test-ts) — §132–§132
- [`packages/plugins/gitea/src/index.test.ts`](#packages-plugins-gitea-src-index-test-ts) — §133–§144
- [`packages/plugins/gitea/src/index.ts`](#packages-plugins-gitea-src-index-ts) — §145–§158
- [`packages/plugins/gitea/vitest.config.ts`](#packages-plugins-gitea-vitest-config-ts) — §159–§160
- [`packages/plugins/github-check/src/github-check.conformance.test.ts`](#packages-plugins-github-check-src-github-check-conformance-test-ts) — §161–§161
- [`packages/plugins/github-check/src/index.ts`](#packages-plugins-github-check-src-index-ts) — §162–§162
- [`packages/plugins/github-check/vitest.config.ts`](#packages-plugins-github-check-vitest-config-ts) — §163–§164
- [`packages/plugins/github/src/github-test-support.ts`](#packages-plugins-github-src-github-test-support-ts) — §165–§168
- [`packages/plugins/github/src/github.conformance.test.ts`](#packages-plugins-github-src-github-conformance-test-ts) — §169–§169
- [`packages/plugins/github/src/index.test.ts`](#packages-plugins-github-src-index-test-ts) — §170–§190
- [`packages/plugins/github/src/index.ts`](#packages-plugins-github-src-index-ts) — §191–§211
- [`packages/plugins/github/vitest.config.ts`](#packages-plugins-github-vitest-config-ts) — §212–§213
- [`packages/plugins/gitlab/src/gitlab-test-support.ts`](#packages-plugins-gitlab-src-gitlab-test-support-ts) — §214–§215
- [`packages/plugins/gitlab/src/gitlab.conformance.test.ts`](#packages-plugins-gitlab-src-gitlab-conformance-test-ts) — §216–§216
- [`packages/plugins/gitlab/src/index.test.ts`](#packages-plugins-gitlab-src-index-test-ts) — §217–§226
- [`packages/plugins/gitlab/src/index.ts`](#packages-plugins-gitlab-src-index-ts) — §227–§238
- [`packages/plugins/gitlab/vitest.config.ts`](#packages-plugins-gitlab-vitest-config-ts) — §239–§240
- [`packages/plugins/harbor/src/index.test.ts`](#packages-plugins-harbor-src-index-test-ts) — §241–§241
- [`packages/plugins/harbor/src/index.ts`](#packages-plugins-harbor-src-index-ts) — §242–§244
- [`packages/plugins/harbor/vitest.config.ts`](#packages-plugins-harbor-vitest-config-ts) — §245–§246
- [`packages/plugins/local-auth/src/index.ts`](#packages-plugins-local-auth-src-index-ts) — §247–§247
- [`packages/plugins/local-auth/src/stub.test.ts`](#packages-plugins-local-auth-src-stub-test-ts) — §248–§248
- [`packages/plugins/local-auth/vitest.config.ts`](#packages-plugins-local-auth-vitest-config-ts) — §249–§250
- [`packages/plugins/managed-dep/src/bump-edit.test.ts`](#packages-plugins-managed-dep-src-bump-edit-test-ts) — §251–§254
- [`packages/plugins/managed-dep/src/bump-edit.ts`](#packages-plugins-managed-dep-src-bump-edit-ts) — §255–§265
- [`packages/plugins/managed-dep/src/detail-bound.test.ts`](#packages-plugins-managed-dep-src-detail-bound-test-ts) — §266–§268
- [`packages/plugins/managed-dep/src/index.test.ts`](#packages-plugins-managed-dep-src-index-test-ts) — §269–§272
- [`packages/plugins/managed-dep/src/index.ts`](#packages-plugins-managed-dep-src-index-ts) — §273–§304
- [`packages/plugins/managed-dep/src/launch-argv.golden.test.ts`](#packages-plugins-managed-dep-src-launch-argv-golden-test-ts) — §305–§312
- [`packages/plugins/managed-dep/src/launcher-seam.test.ts`](#packages-plugins-managed-dep-src-launcher-seam-test-ts) — §313–§315
- [`packages/plugins/managed-dep/src/repo-write.matrix.test.ts`](#packages-plugins-managed-dep-src-repo-write-matrix-test-ts) — §316–§318
- [`packages/plugins/managed-dep/src/repo-write.test.ts`](#packages-plugins-managed-dep-src-repo-write-test-ts) — §319–§322
- [`packages/plugins/managed-dep/src/repo-write.ts`](#packages-plugins-managed-dep-src-repo-write-ts) — §323–§339
- [`packages/plugins/managed-dep/src/runner-containment.test.ts`](#packages-plugins-managed-dep-src-runner-containment-test-ts) — §340–§346
- [`packages/plugins/managed-dep/src/runner-image.integration.test.ts`](#packages-plugins-managed-dep-src-runner-image-integration-test-ts) — §347–§355
- [`packages/plugins/managed-dep/src/runner-image.test.ts`](#packages-plugins-managed-dep-src-runner-image-test-ts) — §356–§358
- [`packages/plugins/managed-dep/src/runner-launcher-selection.test.ts`](#packages-plugins-managed-dep-src-runner-launcher-selection-test-ts) — §359–§363
- [`packages/plugins/managed-dep/src/runner-shim.test.ts`](#packages-plugins-managed-dep-src-runner-shim-test-ts) — §364–§367
- [`packages/plugins/managed-dep/src/write-guard.test.ts`](#packages-plugins-managed-dep-src-write-guard-test-ts) — §368–§377
- [`packages/plugins/managed-dep/src/write-guard.ts`](#packages-plugins-managed-dep-src-write-guard-ts) — §378–§399
- [`packages/plugins/managed-dep/src/write-test-support.ts`](#packages-plugins-managed-dep-src-write-test-support-ts) — §400–§403
- [`packages/plugins/managed-dep/vitest.config.ts`](#packages-plugins-managed-dep-vitest-config-ts) — §404–§404
- [`packages/plugins/managed-dep/vitest.integration.config.ts`](#packages-plugins-managed-dep-vitest-integration-config-ts) — §405–§405
- [`packages/plugins/managed-iac/src/detail-bound.test.ts`](#packages-plugins-managed-iac-src-detail-bound-test-ts) — §406–§409
- [`packages/plugins/managed-iac/src/index.test.ts`](#packages-plugins-managed-iac-src-index-test-ts) — §410–§415
- [`packages/plugins/managed-iac/src/index.ts`](#packages-plugins-managed-iac-src-index-ts) — §416–§436
- [`packages/plugins/managed-iac/src/launch-argv.golden.test.ts`](#packages-plugins-managed-iac-src-launch-argv-golden-test-ts) — §437–§446
- [`packages/plugins/managed-iac/src/launcher-seam.test.ts`](#packages-plugins-managed-iac-src-launcher-seam-test-ts) — §447–§450
- [`packages/plugins/managed-iac/src/managed-iac.integration.test.ts`](#packages-plugins-managed-iac-src-managed-iac-integration-test-ts) — §451–§453
- [`packages/plugins/managed-iac/src/runner-launcher-selection.test.ts`](#packages-plugins-managed-iac-src-runner-launcher-selection-test-ts) — §454–§458
- [`packages/plugins/managed-iac/vitest.config.ts`](#packages-plugins-managed-iac-vitest-config-ts) — §459–§460
- [`packages/plugins/managed-iac/vitest.integration.config.ts`](#packages-plugins-managed-iac-vitest-integration-config-ts) — §461–§461
- [`packages/plugins/managed-scan/src/detail-bound.test.ts`](#packages-plugins-managed-scan-src-detail-bound-test-ts) — §462–§464
- [`packages/plugins/managed-scan/src/index.test.ts`](#packages-plugins-managed-scan-src-index-test-ts) — §465–§466
- [`packages/plugins/managed-scan/src/index.ts`](#packages-plugins-managed-scan-src-index-ts) — §467–§483
- [`packages/plugins/managed-scan/src/launch-argv.golden.test.ts`](#packages-plugins-managed-scan-src-launch-argv-golden-test-ts) — §484–§488
- [`packages/plugins/managed-scan/src/launcher-seam.test.ts`](#packages-plugins-managed-scan-src-launcher-seam-test-ts) — §489–§492
- [`packages/plugins/managed-scan/src/managed-scan.integration.test.ts`](#packages-plugins-managed-scan-src-managed-scan-integration-test-ts) — §493–§493
- [`packages/plugins/managed-scan/src/pin.test.ts`](#packages-plugins-managed-scan-src-pin-test-ts) — §494–§494
- [`packages/plugins/managed-scan/src/runner-launcher-selection.test.ts`](#packages-plugins-managed-scan-src-runner-launcher-selection-test-ts) — §495–§500
- [`packages/plugins/managed-scan/src/scanner-containment.test.ts`](#packages-plugins-managed-scan-src-scanner-containment-test-ts) — §501–§507
- [`packages/plugins/managed-scan/vitest.config.ts`](#packages-plugins-managed-scan-vitest-config-ts) — §508–§509
- [`packages/plugins/managed-scan/vitest.integration.config.ts`](#packages-plugins-managed-scan-vitest-integration-config-ts) — §510–§510
- [`packages/plugins/pipeline-generic/src/index.test.ts`](#packages-plugins-pipeline-generic-src-index-test-ts) — §511–§512
- [`packages/plugins/pipeline-generic/src/index.ts`](#packages-plugins-pipeline-generic-src-index-ts) — §513–§515
- [`packages/plugins/pipeline-generic/src/pipeline-generic.conformance.test.ts`](#packages-plugins-pipeline-generic-src-pipeline-generic-conformance-test-ts) — §516–§516
- [`packages/plugins/pipeline-generic/src/test-support/real-http-client.ts`](#packages-plugins-pipeline-generic-src-test-support-real-http-client-ts) — §517–§518
- [`packages/plugins/pipeline-generic/vitest.config.ts`](#packages-plugins-pipeline-generic-vitest-config-ts) — §519–§520
- [`packages/plugins/scan-result-control/src/index.test.ts`](#packages-plugins-scan-result-control-src-index-test-ts) — §521–§522
- [`packages/plugins/scan-result-control/src/index.ts`](#packages-plugins-scan-result-control-src-index-ts) — §523–§529
- [`packages/plugins/scan-result-control/src/scan-result-control.conformance.test.ts`](#packages-plugins-scan-result-control-src-scan-result-control-conformance-test-ts) — §530–§530
- [`packages/plugins/scan-result-control/vitest.config.ts`](#packages-plugins-scan-result-control-vitest-config-ts) — §531–§532
- [`packages/plugins/smtp-notify/src/egress.ts`](#packages-plugins-smtp-notify-src-egress-ts) — §533–§534
- [`packages/plugins/smtp-notify/src/index.test.ts`](#packages-plugins-smtp-notify-src-index-test-ts) — §535–§535
- [`packages/plugins/smtp-notify/src/index.ts`](#packages-plugins-smtp-notify-src-index-ts) — §536–§539
- [`packages/plugins/smtp-notify/src/test-support/fake-smtp-server.ts`](#packages-plugins-smtp-notify-src-test-support-fake-smtp-server-ts) — §540–§540
- [`packages/plugins/smtp-notify/vitest.config.ts`](#packages-plugins-smtp-notify-vitest-config-ts) — §541–§542
- [`packages/plugins/terraform/src/index.test.ts`](#packages-plugins-terraform-src-index-test-ts) — §543–§544
- [`packages/plugins/terraform/src/index.ts`](#packages-plugins-terraform-src-index-ts) — §545–§545
- [`packages/plugins/terraform/src/terraform.conformance.test.ts`](#packages-plugins-terraform-src-terraform-conformance-test-ts) — §546–§546
- [`packages/plugins/terraform/src/test-support/real-http-client.ts`](#packages-plugins-terraform-src-test-support-real-http-client-ts) — §547–§548
- [`packages/plugins/terraform/vitest.config.ts`](#packages-plugins-terraform-vitest-config-ts) — §549–§550
- [`packages/plugins/webhook-control/src/index.ts`](#packages-plugins-webhook-control-src-index-ts) — §551–§552
- [`packages/plugins/webhook-control/src/webhook-control.conformance.test.ts`](#packages-plugins-webhook-control-src-webhook-control-conformance-test-ts) — §553–§553
- [`packages/plugins/webhook-control/vitest.config.ts`](#packages-plugins-webhook-control-vitest-config-ts) — §554–§555
- [`packages/plugins/webhook-notify/src/index.ts`](#packages-plugins-webhook-notify-src-index-ts) — §556–§556
- [`packages/plugins/webhook-notify/src/test-node-http-client.ts`](#packages-plugins-webhook-notify-src-test-node-http-client-ts) — §557–§557
- [`packages/plugins/webhook-notify/vitest.config.ts`](#packages-plugins-webhook-notify-vitest-config-ts) — §558–§559

## `packages/plugins/argo-workflows/src/argo-workflows.conformance.test.ts`

### §1. Wires this plugin into the generic executor conformance suite

Wires `@scp/plugin-argo-workflows` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests"). Mirrors `packages/plugins/argocd/src/argocd.conformance.test.ts` exactly, including the `restart` hook — the suite's idempotency-across-a-simulated-subprocess-restart assertion needs a FRESH plugin instance + ctx sharing only the durable (on-disk) `statePath`, never the first instance's in-process memory.

Like the ArgoCD fixture (and unlike fake-executor/webhook-control's in-memory stubs), this wires a REAL `ScopedHttpClient` (`./test-node-http-client.ts`) so the suite's calls travel through `index.ts`'s actual `apiRequest()` HTTP path and get intercepted by `nock`, exercising the real wire format rather than only in-process logic.

Every interceptor matches by path REGEX (any workflow/template name the suite happens to use) and is `.persist()`-ed, since the suite calls trigger/status/abort/observe with varying target names across its own `it()`s without this fixture knowing which name a given test will use ahead of time.

## `packages/plugins/argo-workflows/src/index.test.ts`

### §2. `@scp/plugin-argo-workflows` behavioral test suite

`@scp/plugin-argo-workflows` behavioral test suite — nock-fixtures every HTTP call so these tests are deterministic and never touch the real network (CLAUDE.md: "Tests never touch the internet").

Every `PluginContext` here is built with a REAL `ScopedHttpClient` (`./test-node-http-client.ts` — node:http/https, not `fetch`; see that file's doc comment for why `fetch` doesn't work against `nock@13.5.x`, the version pinned in this package's package.json). That means these tests exercise `index.ts`'s actual `apiRequest()` wire path — method, URL, JSON body, `Authorization` header, JSON response parsing — not just its in-process return values.

`nock.disableNetConnect()` is on for the whole file so a request this suite forgot to fixture fails loudly instead of hanging on a real DNS lookup.

## `packages/plugins/argo-workflows/src/index.ts`

### §3. The Argo Workflows executor plugin

`@scp/plugin-argo-workflows` — the Argo Workflows `ExecutorPlugin` (team-pipeline-iac increment 8, sibling of `@scp/plugin-argocd`). Argo Workflows runs TESTS on behalf of a coordinated pipeline; it never performs a rollout, so `describeCapabilities()` deliberately OMITS the `rollout` field (see that function below) rather than declaring an authority this plugin does not have.

MODELED ON `@scp/plugin-argocd`, deliberately, not on `pipeline-generic`/`terraform`: Argo Workflows is a typed REST API problem (typed request/response shapes, a real list endpoint, a file-backed idempotency cache), exactly like ArgoCD, not a URL-template escape hatch. Every call goes through `ctx.http` (the host-mediated, egress-controlled client), never a raw fetch.

HONEST COVERAGE NOTE — every shape below is ASSUMED, not verified against a live Argo Workflows instance. This is a known, named risk (the Gitea lesson: an assumed webhook-signature scheme that differed from GitHub's cost a full round to discover and fix). So every assumed shape is typed in ONE place (the "Argo Workflows REST shapes" section below) and every assumption is listed here as a single checklist a live-verification pass can work from:

1. Submit from a template — `POST /api/v1/workflows/{namespace}/submit`, body `{ resourceKind: "WorkflowTemplate", resourceName, submitOptions?: { parameters?: string[] } }` → response `{ metadata: { name, uid }, status?: {...} }`. Used by `trigger()`. 2. Get one — `GET /api/v1/workflows/{namespace}/{name}` → `{ metadata: { name, uid, creationTimestamp, labels? }, status?: { phase?, startedAt?, finishedAt?, message?, progress? } }`. Used by `status()` and `abort()`. 3. List — `GET /api/v1/workflows/{namespace}` (optionally `?listOptions.labelSelector=`) → `{ items: Workflow[] }`, same per-item shape as #2. Used by `observe()`. 4. Terminate — `PUT /api/v1/workflows/{namespace}/{name}/terminate`, no body, success = 2xx. Used by `abort()`. IMPORTANT SUB-ASSUMPTION: the real API has NO distinct terminal phase for "explicitly terminated" — a terminated workflow settles into `Failed`/`Error` exactly like a genuine failure, distinguished (if at all) only by free-form `status.message` text this plugin does not want to pin its behavior on. So this plugin tracks "did *this plugin instance* call terminate on this workflow" itself, in the SAME file-backed state the idempotency cache uses (see `DedupState.abortedNames` below), and `status()` reads that local record — not any Argo-reported phase — to report `aborted` rather than `failed`. That is honest for aborts THIS plugin issued; a workflow terminated by some other actor (`argo terminate` from the CLI, a different SCP instance with a different `statePath`) still reports `failed`, which is a narrower guarantee than a phase-based signal would give, stated rather than assumed away. 5. Workflow `status.phase` — `Pending | Running | Succeeded | Failed | Error` (assumed enum). Mapped to `ExecutionPhase`: `Pending`→`pending`, `Running`→`running`, `Succeeded`→`succeeded`, `Failed`/`Error`→`failed` (or `aborted` per #4 above when locally tracked), an UNKNOWN string →`running` (never silently promoted to a terminal success) with a `ctx.logger.warn`, and an absent/empty phase (freshly submitted, controller hasn't reconciled it yet) → `pending` — this last mapping is this plugin's own inference, since the assumed enum names no "not yet set" value explicitly. 6. `status.progress` — assumed to be a human string of the form `"N/M"` (steps completed / total), parsed into a `0..1` fraction when it matches; falls back to a phase-based estimate (pending=0, running=0.5, terminal=1) when absent or unparsable. NOT verified against a live instance. 7. Auth — `Authorization: Bearer <token>` from `ctx.secrets` (or `config.token` for tests/fixtures only, mirroring `@scp/plugin-argocd`'s `ArgoCdConfig.token`). 8. `commitSha` convention (`observe()` only) — read from the workflow's own `metadata.labels["commanderscp.io/commit-sha"]` label, ONLY when present. Argo Workflows has no native notion of "the commit this run is for"; this is a convention a submitting caller (e.g. a pipeline that sets `submitOptions.labels` on its own trigger) may choose to follow. Never fabricated — omitted entirely when the label is absent. 9. Cron workflows — `GET /api/v1/cron-workflows/{namespace}` → `{ items: [{ metadata, status?: { lastScheduledTime? } }] }`. Typed below (`ArgoCronWorkflow`/`ArgoCronWorkflowList`) for a live-verification pass to have the shape ready, but DELIBERATELY UNUSED by every verb in this increment — none of observe/trigger/ status/abort's specified behavior calls for it. Reserved for a possible future increment (a CronWorkflow can spawn, complete, and be pruned by TTL GC between two `observe()` polls, which the current Workflow-list-only `observe()` would miss entirely) — do not wire it up without re-confirming this shape against a live instance first.

IDEMPOTENCY (mirrors `@scp/plugin-argocd` exactly): `TriggerIntent.idempotencyKey` must dedup to the SAME `ExternalRunRef` without re-submitting the workflow, and the mapping must survive a subprocess-host restart — so it is kept in a small file-backed cache, write-to-temp-then-rename for crash safety, identical in shape to `@scp/plugin-argocd`'s and `@scp/plugin-fake-executor`'s.

EGRESS / IN-CLUSTER REACH: this plugin is a TENANT-CONFIGURABLE executor, not an operator-plane module — it is deliberately absent from `subprocess-entry.ts`'s `OPERATOR_PLANE_MODULES`. An operator who needs to coordinate an in-cluster (private ClusterIP) Argo Workflows server reaches it through ADR-0003's two-layer model instead: the execution-system object's own `allowInternalEgress` declaration, gated by the deployment-wide `SCP_INTERNAL_EGRESS_HOSTS` allowlist — see `docs/adr/0003-internal-egress-for-execution-systems.md`. Adding this module to `OPERATOR_PLANE_MODULES` instead would be a security regression (ADR-0003 alternative 4, rejected): it grants internal egress to the whole module class regardless of a tenant's declared intent.

### §4. Dedup + abort-tracking cache

Dedup + abort-tracking cache — see module doc assumptions #4/#7. Same write-to-temp+rename persistence shape as `@scp/plugin-argocd`/`@scp/plugin-fake-executor`, for the identical reason: a subprocess-host restart mid-wave must not lose the mapping. `normalize` backfills `abortedNames` for a state file written before that field existed.

### §5. Assumption #5 — the phase-mapping table

Assumption #5 — the phase-mapping table. An UNKNOWN phase string must NEVER silently become `succeeded`: it maps to `running` (still in flight, as far as this plugin honestly knows) and is logged so an operator can see a real API drift rather than a silently-wrong verdict. An absent phase (a workflow this plugin's own `trigger()` just submitted, before Argo's controller has reconciled it) maps to `pending` — this plugin's own inference, not part of the assumed enum.

### §6. `stateRef` = `${uid}${REF_DELIMITER}${phase}`

`stateRef` = `${uid}${REF_DELIMITER}${phase}` — the workflow's own identity plus its CURRENT phase (assumption #5). This is what lets an idle re-list of an unchanged workflow (same uid, same phase, polled again with the object's `startedAt`/`finishedAt` unchanged) collapse to one event downstream instead of minting a new row every poll — the exact property `@scp/plugin-argocd`'s `syncStateRef` documents (measured 26k spurious rows/day without it on a 61-application ArgoCD instance). A workflow whose phase genuinely changes (Running -> Succeeded) gets a DIFFERENT `stateRef`, so a genuine transition still produces a distinguishable event.

### §7. D12's `rollout` capability field is DELIBERATELY OMITTED here

D12's `rollout` capability field is DELIBERATELY OMITTED here — never set it, even to `{ authority: "verified", targetClasses: [] }`. Argo Workflows runs TESTS on behalf of a coordinated pipeline; it has no notion of a progressive rollout at all, so declaring ANY `RolloutCapability` (even a nominally empty one) would misrepresent this executor as having an opinion on rollout authority it structurally cannot have. `ExecutorCapabilities.rollout`'s own doc comment in `@scp/plugin-api` is explicit: absent means "declares no rollout authority" and must never read as a claim. If a future increment adds progressive-delivery awareness to Argo Workflows itself, that is a deliberate, reviewed addition — not a default this field should ever silently acquire by someone "completing" the capability list.

### §8. ASSUMPTION #10 — CronWorkflow WRITE

ASSUMPTION #10 — CronWorkflow WRITE. `POST /api/v1/cron-workflows/{namespace}` creates and `PUT /api/v1/cron-workflows/{namespace}/{name}` updates, body `{ cronWorkflow: {...} }`; `DELETE .../{name}` removes. Cadence is a cron EXPRESSION (`spec.schedule`), so a seconds cadence is rendered to the coarsest expression that fits.

WIRED AGAINST AN ASSUMED SHAPE, KNOWINGLY. Assumption #9 above says not to wire the cron endpoints without re-confirming against a live instance; that check has not been possible here (this suite never touches the network) and the owner accepted the risk deliberately, so it is recorded rather than implied. The mitigation is that the assumed request shape is PINNED BY TESTS: a real API drift fails them loudly instead of silently declaring a probe nobody runs. Re-confirm against a live instance before trusting this in an estate that matters.

## `packages/plugins/argo-workflows/src/test-node-http-client.ts`

### §9. Test-only HTTP client backed by Node's core modules

Test-only `ScopedHttpClient` backed by `node:http`/`node:https`'s core `request()` API — deliberately NOT `fetch`, even though production (`unscopedFetchHttpClient` in apps/server/src/plugin-host/subprocess-entry.ts) uses `fetch`. Copied from `@scp/plugin-argocd`'s file of the same name — see its doc comment for the full explanation, restated here because it is exactly as true for this package: Node's global `fetch` is implemented on `undici`'s own connection pooling, which bypasses the `http`/`https` core modules that `nock` patches, so with the `nock@13.5.x` line pinned in this repo's package.json (fetch interception is only in the still-experimental `nock@beta` line — see nock's README "Notice"), a `fetch()` call sails past every nock interceptor and attempts (and fails) a real DNS lookup instead of matching a fixture. Routing through `http.request`/`https.request` is what actually lets `nock(serverUrl)...` intercept these calls, while still exercising `index.ts`'s real `apiRequest()` wire path (method, URL, headers, JSON body/response) exactly as production does — only the transport differs.

## `packages/plugins/argo-workflows/vitest.config.ts`

### §10. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6) — copied verbatim from `packages/plugins/argocd/vitest.config.ts`. `@scp/source-census`'s `test-budget-census.test.ts` requires every vitest package to declare an explicit `testTimeout`/`hookTimeout` rather than inherit vitest's implicit defaults (5,000ms / 10,000ms) — the incomplete-call-site-census property CLAUDE.md names, closed once for `@scp/plugin-argocd` and now for this sibling package too, rather than left for the census to catch later.

## `packages/plugins/argocd/src/argocd.conformance.test.ts`

### §11. Wires this plugin into the generic executor conformance suite

Wires `@scp/plugin-argocd` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing about ArgoCD specifics — this file is only the fixture factory.

Unlike the other conformance fixtures in this repo (fake-executor, webhook-control), which stub `ctx.http` directly with an in-memory function, this fixture wires a REAL `ScopedHttpClient` (`./test-node-http-client.ts` — node:http/https, not `fetch`; see that file's doc comment for why) so the suite's calls travel through `index.ts`'s actual `apiRequest()` HTTP path and get intercepted by `nock`, exercising the real wire format rather than only in-process logic.

The conformance suite calls trigger/status/abort/observe in varying combinations, and with varying target names per `it()` (e.g. "conformance-target" for most assertions, "conformance-idempotency-target" for the idempotencyKey test), without this fixture knowing ahead of time which name a given test will use. Every interceptor below therefore matches by path REGEX (any application name) and is `.persist()`-ed rather than tied to one literal name or a fixed call count — the equivalent of webhook-control's conformance fixture always returning the same well-formed response regardless of how many times `evaluate()` is called.

## `packages/plugins/argocd/src/index.test.ts`

### §12. `@scp/plugin-argocd` behavioral test suite

`@scp/plugin-argocd` behavioral test suite — nock-fixtures every HTTP call so these tests are deterministic and never touch the real network (CLAUDE.md: "Tests never touch the internet").

Every `PluginContext` here is built with a REAL `ScopedHttpClient` (`./test-node-http-client.ts` — node:http/https, not `fetch`; see that file's doc comment for why `fetch` doesn't work against `nock@13.5.x`, the version pinned in this package's package.json). That means these tests exercise `index.ts`'s actual `apiRequest()` wire path — method, URL, JSON body, `Authorization` header, JSON response parsing — not just its in-process return values.

`nock.disableNetConnect()` is on for the whole file (see `beforeAll` below) so a request this suite forgot to fixture fails loudly (a clear "Nock: Disallowed net connect" rejection) instead of hanging on a real DNS lookup. Every test that cares whether the plugin called the network (or called it only once) asserts `scope.isDone()` explicitly, per this PR's constraint that a test must not pass by accident from a stale/unused interceptor.

### §13. Unlike the fake, this plugin exports a stateless factory

NOTE: unlike @scp/plugin-fake-executor's `FakeExecutorPlugin` class, this plugin exports a stateless singleton object (`createArgoCdExecutorPlugin()` always returns the same `argoCdExecutorPlugin` — see index.ts), so there is no separate "instance" to construct. The property under test is the same one fake-executor's restart-recovery test proves — that the dedup mapping lives in the state FILE, not in any in-process object — so a fresh `PluginContext` (standing in for a respawned subprocess getting a fresh ctx from the host) sharing the same `statePath` must still see the first call's write. Because `loadState()` always re-reads the file from disk on every call regardless of object identity, reusing the singleton here is actually a slightly stronger proof than a fresh object would be: it shows the plugin holds no hidden in-process cache that a "new instance" might have simply not populated yet.

### §14. ADR-0028 decision 3 / docs/proposals/rollout-step-coupling.md §2.5

ADR-0028 decision 3 / docs/proposals/rollout-step-coupling.md §2.5 — EXHAUSTIVE pin of the health -> phase mapping a FINISHED sync uses (`phaseAfterFinishedSync` in index.ts). It had no test for `Suspended` at all, and the stage-coupling gate now reads its consequence: a `succeeded` phase terminalizes the wave target, reconcile stops polling it, and its observed canary weight is frozen at whatever the last poll saw. Every row here is therefore a behavioural contract with that gate, not an implementation detail — including the ones that stay NON-terminal, because those are what keep a dependency's weight refreshing.

### §15. The hazard of §2.5 in ONE fixture

The hazard of §2.5 in ONE fixture: an Application aggregating to `Suspended` while the Rollout underneath it is PAUSED at 10%. status() reports the target DONE (`succeeded`, progress 1) and carries weight 10 in the same response. reconcile.ts then skips this target on every later tick (`if (target.status === "succeeded") continue;`), so 10 is the LAST weight ever persisted for it — it stays 10 even after somebody promotes the Rollout to 100%. This is a pin of what SCP does GIVEN that input; whether Argo really aggregates a paused Rollout to `Suspended` cannot be established from this tree and must be checked against a live instance (§2.5).

### §16. ADR-0008 P4D (rollout, OBSERVE-ONLY)

ADR-0008 P4D (rollout, OBSERVE-ONLY): when the app manages an Argo Rollout, status() surfaces the rollout's phase/step/weight/message on ExecutionStatus.observed.rollout. Near-free phase/message come off the Rollout node in `status.resources[]` (SAME Application body); structured step/weight (+ authoritative phase/message) come from the LIVE Rollout manifest fetched via GET .../resource. EVERY field here is parsed from the mocked ArgoCD responses — never hardcoded.

### §17. `reconciledAt` advances whether or not anything changed

`reconciledAt` advances on every Argo CD reconcile whether or not anything changed, so without the revision an event keyed on (app, reconciledAt) is a new row every ~3 minutes per app — measured at ~26k rows and ~150 MB a day on a 61-app instance, all describing nothing happening. The revision is what lets `observedEventIdentity` collapse them onto one row per deployed revision. Asserted on the VALUE, not merely that the field is set: the whole mechanism depends on it being the revision and not, say, the resourceVersion.

### §18. The case the first attempt at this fix missed entirely

The case the first attempt at this fix missed entirely. Argo CD reports a multi-source app's revisions in `status.sync.revisions` (an array, one per source) and leaves `revision` unset — it sets exactly one of the two. On the estate that surfaced this, 36 of 59 applications were multi-source, so reading only the singular field left the majority still churning.

`commitSha` stays undefined because a tuple of revisions is not a commit SHA; the dedupe identity rides `stateRef` instead.

### §19. No retry backoff for rate limiting yet, and why

TODO(M7 follow-up): observe()/trigger()/status() in index.ts have no retry-with-backoff for 429/503 — a single non-2xx (including a transient rate-limit) throws immediately, relying entirely on whatever outer retry/backoff the coordination engine itself provides (if any). This test documents that as CURRENT behavior; adding real backoff would be a behavior change out of scope for this test-only PR.

### §20. Per-path routing: the matcher returns exactly one component

PER-PATH ROUTING. `matchComponentForSource` returns exactly ONE component, so every app of a repo carrying an identical bare-repo mapping meant ONE of them won every push and the rest were unreachable. Measured on the live homelab 2026-08-03: 19 components across 4 repo patterns, one routable per repo. The 43 components that had path patterns routed correctly — the control.

| Mutation | Result |
| emit no `pathPattern` (the old behaviour) | the per-source and dedupe assertions FAIL | | iterate only `primarySource` instead of every source | the multi-source test FAILS — the second repo gets no mapping at all | | drop the `seen` dedupe | the same-repo-twice case emits 2 identical mappings |

## `packages/plugins/argocd/src/index.ts`

### §21. `@scp/plugin-argocd` — the ArgoCD `ExecutorPlugin`

`@scp/plugin-argocd` — the ArgoCD `ExecutorPlugin` (DESIGN.md §12, BUILD_AND_TEST.md §8 M7 item 2): "Observe: Application get/watch — health + sync status is the actual-state input to reconciliation. Trigger: sync of an Application the org already defined (optionally setting target revision). Abort: terminate operation. Rollback: sync to previous known-good revision."

Modeled against ArgoCD's documented REST API (`/api/v1/applications/{name}`, `.../sync`, `.../operation`) — every call goes through `ctx.http` (the host-mediated, egress-controlled client; DESIGN §11), never a raw fetch. HONEST COVERAGE NOTE (mirrors this PR's "deterministic vs. live-sandbox" split): the request/response shapes below are exercised deterministically against `nock` fixtures built from ArgoCD's published API docs, NOT against a live server — the golden-path E2E's "ArgoCD-in-kind" variant and the opt-in nightly live-sandbox job are what actually prove wire-format fidelity against a real ArgoCD instance.

Idempotency (coordination/reconcile.ts's crash-safe trigger contract — `idempotencyKey` must dedup to the SAME `ExternalRunRef` without re-firing `sync`): ArgoCD's sync API has no native idempotency-key concept, so this plugin keeps its own small dedup cache, file-backed when `ctx.config.statePath` is set (same write-to-temp+rename pattern `@scp/plugin-fake-executor` uses, for the identical reason: a subprocess-host restart mid-wave must not lose the mapping). HONEST LIMITATION: unlike fake-executor's cache (the only system of record), a REAL ArgoCD sync is itself close to idempotent — syncing an Application already at the target revision is a fast no-op — which bounds the damage if this cache is ever lost (e.g. `statePath` unset, or the state file itself is lost) and a retry re-issues `sync`. Tracked as a documented, narrower guarantee than fake-executor's, not silently assumed equivalent.

### §22. A rollback with no prior good revision must never sync

CRITICAL #2: a rollback with no prior known-good revision must NEVER be turned into a sync (an empty-revision sync re-applies the CURRENT — i.e. the bad — revision, then reports success). It fails closed instead: `trigger()` mints a ref with this prefix and does NOT call ArgoCD; `status()`/`abort()` recognize it and report a terminal `failed`, so the wave target fails cleanly rather than silently re-deploying the broken revision as a "successful rollback".

### §23. One managed-resource entry in the application's status

A single managed-resource entry in the Application's `status.resources[]`. For an app-managed Argo Rollout there is one entry with kind=Rollout, group=argoproj.io, whose `health.status` is Argo CD's built-in Lua assessment (Healthy|Progressing|Degraded|Suspended|Missing|Unknown) and `health.message` often carries human rollout detail ("Rollout is paused ..."). This gives a phase-ish + message signal near-free — no extra API call (it rides the SAME Application body).

### §24. MAJOR #3 — health -> phase AFTER a sync operation has finished

MAJOR #3 — health -> phase AFTER a sync operation has finished (`operationState.phase` is "Succeeded", or absent-but-"Synced"). The bug this fixes: ArgoCD does NOT clear `operationState` after a sync, so if the app degrades post-sync the old code returned "running" FOREVER and the reconciler waited on a dead deployment indefinitely. A finished sync that left the app Degraded/Missing is a TERMINAL failure. Progressing is still legitimately rolling out (keep polling); Unknown is genuinely ambiguous (keep polling — the stuck-change watchdog is the backstop, not perpetual silence here); Suspended is a valid stable state (succeeded).

SECOND CONSUMER — the stage-coupling gate (docs/adr/0028-stage-scoped-component-coupling.md decision 3, docs/proposals/rollout-step-coupling.md §2.5). "succeeded" here is TERMINAL downstream: `reconcile.ts` skips a wave target whose status is `succeeded` (`if (target.status === "succeeded") continue;`), so that target is never polled again and the canary weight in its last `observed_state` snapshot is frozen for good. The `Suspended` arm is where that bites — IF a paused Argo Rollout aggregates to Application health `Suspended` (unverified against a live Argo from this tree; the vendored install.yaml carries no Rollout health Lua), a dependency paused at 10% reads as DONE to the gate and its stored weight stays 10 even after somebody promotes it to 100%. Any gate reading that weight — the `minWeight` qualifier — must therefore treat a TERMINAL target's snapshot as potentially STALE, never as live truth. Every arm below is pinned in `index.test.ts` ("a FINISHED sync with health ..."); changing one is a behaviour change for that gate, not a refactor.

### §25. Parse the observe-only rollout fields off a live manifest

Parse the OBSERVE-ONLY structured rollout fields off a LIVE Argo Rollout manifest (the JSON STRING GET /api/v1/applications/{name}/resource returns). Surfaces only fields Argo actually provides: `phase` (RolloutPhase), `message`, `currentStepIndex` → step, and canary weight (Rollouts ≳ v1.1). Any field the manifest omits is omitted here — never invented. Returns undefined on parse failure or an empty result.

### §26. The synced revisions as one deterministic dedupe identity

The revision(s) an Application is synced to, as ONE deterministic string — the dedupe identity of its current state. `undefined` when Argo CD reports neither shape (an app that has never synced), which lets the identity fall back to the reconcile timestamp rather than to a fabricated value that would collapse different applications onto one key.

Positional order is preserved for the multi-source case: `revisions` is one entry per declared source, so re-ordering would make two different deployments look identical.

### §27. The synced revision, which is what makes this dedupable

The SYNCED REVISION, and it is what makes this event deduplicable.

`reconciledAt` advances on EVERY Argo CD reconcile — roughly every three minutes per application, whether or not anything changed — so an event keyed only on the app name and that timestamp is a new row per reconcile forever. Measured on a 61-application instance: ~20 events per app per 30 minutes, with ONE distinct revision between them. About 26k rows and ~150 MB a day describing nothing happening.

With the revision here, `observedEventIdentity` (`coordination/observe.ts`) keys the event as `<app>|<revision>` instead of `<app>|<reconciledAt>`, so repeated reconciles of an unchanged application collapse onto one row and a genuine redeploy still creates a new one. The plugin still EMITS per reconcile — it is stateless between polls and cannot know the previous revision — but the server now rejects the repeats as duplicates, which is exactly what dedupe is for and costs one no-op insert per application per poll.

Deliberate consequence: a health flap at the SAME revision (Healthy → Degraded → Healthy) no longer produces an event. That is correct for this path — `observe` exists to detect NEW WORK, and a status change on an already-deployed revision is not new work; live status reaches the engine through `status()` on the changes it is already tracking.

MULTI-SOURCE is the case that makes this two fields instead of one. Argo CD reports a single-source app's revision in `status.sync.revision` and a multi-source app's in `status.sync.revisions` — an array, one entry per source, and it sets exactly one of the two. Reading only the singular field sees NOTHING on a multi-source app: on this estate that was 36 of 59 applications, all of which kept churning after the first attempt at this fix. So `commitSha` carries the revision only when there genuinely is one, and `stateRef` carries the dedupe identity in both shapes — a joined tuple is not a commit SHA, and putting one in a field named for a commit would lie to every consumer.

### §28. Only terminate when there is an in-flight operation

MINOR — only terminate if there IS an in-flight operation, and don't blindly DELETE an operation that may be a NEWER one than the run this ref was minted for. ArgoCD's terminate endpoint targets "the current operation" (there is no per-operation id to scope to), so the best available guard is: GET the app first, and only issue the terminate when an operation is actually Running/Terminating. A settled/absent operation → nothing to abort (avoids terminating a subsequent, unrelated sync).

### §29. Discovery: import an existing Argo CD estate

DiscoveryPlugin (M12 P3, docs/proposals/import-existing-executors.md) — "import my existing Argo CD": enumerate its Applications (the SAME `GET /api/v1/applications` observe() already uses) and PROPOSE one `component` per Application, recording the Application NAME on `properties.argocdApplication` so a subsequent execution-system binding's `externalRef` (M12 P2) coordinates the right app. NEVER auto-commits — `POST /discovery/accept` materializes the proposal. Same one-npm-package-two-plugins shape as @scp/plugin-github (executor + discovery).

### §30. Extracts an `owner/repo` slug from a GitHub repo URL

Extracts an `owner/repo` slug from a GitHub repo URL — https OR ssh (`git@`/`ssh://`), with or without a trailing `.git`. This is the form the github executor's events carry (`${config.owner}/${config.repo}`) and correlation glob-matches against; an Argo CD `spec.source.repoURL` gives the FULL URL, which would never match (M12 P5 fix — the auto-created source_mappings were unreachable). Returns undefined for a non-GitHub host, so no github mapping is proposed for it (correlation is github-shaped; the operator maps a non-GitHub source by hand).

### §31. M12 P5 (owner Q3, github-webhook path)

M12 P5 (owner Q3, github-webhook path): a source_mapping per git source, so pushes to it correlate to this component. `source_kind:'github'`, `repoPattern` = the `owner/repo` SLUG (github events carry that, not the full URL). Skipped for a non-GitHub repoURL.

`pathPattern` — WHY IT IS EMITTED NOW, WHEN THE ORIGINAL M12 P5 COMMENT SAID IT COULD NOT BE
That comment read: "No `pathPattern`: a github push event carries no per-app path, so a path-set mapping would never match ... per-path precision is a follow-up that needs the github plugin to emit changed paths." True when written. THE FOLLOW-UP SHIPPED — the github plugin emits changed paths and `correlation.ts`'s `matchesAnyPath` consumes them (`hint.paths`) — and nobody came back here. A comment naming a pending follow-up is a signal to sweep, not evidence it was handled (CLAUDE.md).

The cost of leaving it, measured on the live homelab 2026-08-03: `matchComponentForSource` returns exactly ONE component, so with every app of a repo carrying an identical bare-repo mapping, ONE of them won every push and the rest were unreachable — 19 components sharing 4 repo patterns, of which one per repo could ever be routed to. The 43 components that DID have path patterns (added by hand for homelab-gitops) routed correctly, which is the control.

ALL sources, not just `primarySource`: 32 of the homelab's 51 apps are multi-source, and every source is an input that should correlate. The object metadata above still describes the PRIMARY source only — deliberately unchanged, since that is descriptive and rewriting it would churn every imported component's properties for no routing benefit.

`path` becomes `path/**` — the form the working mappings already use, and the one that matches the files UNDER a chart directory rather than the directory entry itself. A source with a repoURL but no `path` (a Helm-repo-only source, or a kustomize root) still emits a repo-only mapping, which is exactly right: there is nothing narrower to say about it.

## `packages/plugins/argocd/src/test-node-http-client.ts`

### §32. Test-only HTTP client backed by Node's core modules

Test-only `ScopedHttpClient` backed by `node:http`/`node:https`'s core `request()` API — deliberately NOT `fetch`, even though production (`unscopedFetchHttpClient` in apps/server/src/plugin-host/subprocess-entry.ts) uses `fetch`. Verified empirically while writing this suite: Node's global `fetch` is implemented on `undici`'s own connection pooling, which bypasses the `http`/`https` core modules that `nock` patches, so with the `nock@13.5.x` line pinned in this repo's package.json (fetch interception is only in the still-experimental `nock@beta` line — see nock's README "Notice"), a `fetch()` call sails past every nock interceptor and attempts (and fails) a real DNS lookup instead of matching a fixture. Routing through `http.request`/`https.request` is what actually lets `nock(serverUrl)...` intercept these calls, while still exercising `index.ts`'s real `apiRequest()` wire path (method, URL, headers, JSON body/response) exactly as production does — only the transport differs.

## `packages/plugins/argocd/vitest.config.ts`

### §33. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §34. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/dependency-index-oci/src/index.test.ts`

### §35. The transport is the vendored binary, not HTTP

The image index's transport is the vendored `skopeo` BINARY, not HTTP, so its fixtures are a fake skopeo on disk rather than `nock` interceptors — but the documents it prints are the REAL ones: `skopeo list-tags`'s `{"Repository":…,"Tags":[…]}` and `skopeo inspect`'s top-level `Digest`. Nothing here reaches a network of any kind.

## `packages/plugins/dependency-index-oci/src/index.ts`

### §36. The container-image version index

`@scp/plugin-dependency-index-oci` — the CONTAINER-IMAGE version index (ADR-0032 §7).

THE ONE ECOSYSTEM WITH NO AIR-GAP GAP, and the reason it is built differently from its four siblings: "in an air-gapped domain the org's OWN registry is the index" (ADR-0032 §7, Consequences). There is no upstream feed to load, no public index to allowlist, and nothing to degrade — the registry the org already runs answers `list-tags` for the images the org already deploys. A disconnected commander therefore has FULL image detection while `go`/`npm`/`python`/ `maven` report `not_configured`, which is exactly the asymmetry `dependency-index-airgap.test.ts` pins.

REACH: THE EXISTING VENDORED-SKOPEO CHANNEL, NOT A SECOND MECHANISM. This repo already talks to registries in exactly one way — the pinned, vendored `skopeo` resolved by `@scp/cosign`'s `resolveSkopeo()` and guarded by the `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist (ADR-0019 §4). That is what `governance/scan-db.ts`'s connected refresh uses (`skopeo copy`), what `federation/promotion-scan-step.ts` pulls artifact bytes with, and what `federation/retrans-relay.ts` relays through. Adding a registry-v2 HTTP client here would create a SECOND registry reach with its own auth handling, its own TLS trust decisions and its own allowlist — one more place for a boundary to be enforced differently. So this plugin shells the same binary, and the binary path plus the host allowlist are SERVER-INJECTED, never tenant config — the same split `@scp/plugin-managed-scan` uses for `dockerBinary`/`runnerImage`/`networkMode` (its "adversarial-review CRITICAL #1" shape).

A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7). `listVersions` reports tags — labels a publisher can repoint at any time — so `resolveDigest` exists and is implemented here alone among the five indexes: what a subscription records for an image line is the DIGEST the tag resolved to, with the tag beside it as a label.

IT STILL DOES NOT RANK. Image tags are conspicuously not semver — `latest`, `1.2`, `1.2.3-alpine` and date stamps coexist in one repository — and that is precisely why the ordering rule lives in one server-side place over `@scp/dependency-manifests`'s `parseImageTagVersion`, which refuses a single-component tag by default so a date stamp can never be compared against a major line. This plugin returns the registry's tag list verbatim, `latest` included; nothing here decides.

### §37. The host an OCI repository coordinate names, or null

The `host[:port]` an OCI repository coordinate names, or `null` when it names none.

Identical rule to `governance/scan-db.ts`'s `ociHostOf`: the first path segment is a registry host only if it is `localhost` or contains a `.` or a `:`. `alpine` and `library/alpine` name Docker Hub IMPLICITLY, and this returns `null` for them — which fails closed, because an implicit host cannot be checked against an allowlist. A coordinate must be registry-qualified (`docker.io/library/alpine`), which is exactly how `DependencyCoordinateSchema` documents the `oci` spelling.

### §38. `skopeo list-tags docker://<repo>`

`skopeo list-tags docker://<repo>` — the real document is exactly:

```text
  { "Repository": "docker.io/library/alpine",
    "Tags": ["3.18", "3.18.4", "3.19", "3.19-alpine", "latest", "20240115"] }
```

Returned VERBATIM, `latest` and date stamps included. Filtering here would move the skip-never-guess rule (ADR-0032 §7) out of the single server-side ranking place and into a plugin, where the next ecosystem would need its own copy of it.

### §39. `skopeo inspect docker://<repo>:<tag>`

`skopeo inspect docker://<repo>:<tag>` — the real document carries `Digest` at top level:

{ "Name": "docker.io/library/alpine", "Digest": "sha256:beef...", "Tag": "3.19", ... }

A digest that is not a well-formed `sha256:<64 hex>` is REFUSED as `malformed_response` rather than stored: `latest_digest` is what makes "the line is on 3.19" a statement about bytes, and a malformed one would make it a statement about nothing while still looking answered.

## `packages/plugins/dependency-index-oci/vitest.config.ts`

### §40. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §41. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/dependency-index-registries/src/common.ts`

### §42. What the four LANGUAGE index plugins in this package share

What the four LANGUAGE index plugins in this package share: one config shape, one HTTP call, and — the part that carries the weight — one classifier turning a `ScopedHttpClient` failure into an operator-legible `DependencyIndexUnavailableReason`.

The classifier exists because of two hazards MEASURED IN THIS REPO, each of which otherwise surfaces as an indistinguishable "the fetch blew up":

1. REDIRECTS ARE HARD-DISABLED on the plugin HTTP client. `plugin-host/subprocess-entry.ts` passes `redirect: "error"` on the one fetch every plugin request goes through, with the reason stated inline: "a 3xx could re-point the request at an internal host AFTER the pre-flight egress check". Public package registries redirect ROUTINELY — `registry.npmjs.org` and `pypi.org` both serve some paths through a CDN 301, and `repo1.maven.org` redirects bare-directory paths. So a perfectly reachable index fails, and it must not be reported as "unreachable": the remedy is "configure the FINAL url", which is an entirely different action from "open the firewall". Hence its own reason, `DependencyIndexUnavailableReason` `redirected`. 2. THE HELM CHART'S EGRESS IS DEFAULT-DENY. `deploy/helm/templates/networkpolicy.yaml` installs a `policyTypes: [Ingress, Egress]` policy with no egress list (the default-deny base) and `values.yaml`'s `networkPolicy.executorEgress` is `[]` by default, so a chart-deployed instance reaches NOTHING but DNS and Postgres. A registry poll from such a pod fails at connect time — i.e. it arrives here as a PLUGIN HTTP ERROR, not as a configuration error, and an operator reading the Decision would otherwise conclude the registry is down. The `unreachable` detail below names the NetworkPolicy explicitly, because that is where the operator has to go.

Everything here is pure except `fetchIndexDocument`, and that one takes its transport from `ctx.http` — so the whole module is testable with `nock` fixtures over a real `node:https`-backed `ScopedHttpClient` (nock@13 does NOT intercept `fetch`; see this package's tests).

### §43. Every language index plugin's config

Every language index plugin's config. `baseUrl` is OPERATOR-supplied, never tenant-supplied: the server resolves it from its own env (`apps/server/src/dependencies/version-index.ts`) and passes it as the plugin instance's config, alongside an `allowedHosts` entry derived from that same URL.

THERE IS NO DEFAULT URL, ON PURPOSE. An unset `baseUrl` makes this ecosystem report `not_configured`, which is the AIR-GAP DEFAULT (charter principle 5: "no runtime network calls to the outside world" — a shipped default of `proxy.golang.org` would make every fresh install phone home on its first daily tick). An operator opts a public index in explicitly.

### §44. Does this thrown value

Does this thrown value — or anything in its `cause` chain — say "redirect"?

The chain walk is the whole point. Node's `fetch` with `redirect: "error"` rejects with a bland `TypeError: fetch failed` and puts the real diagnosis (`unexpected redirect`) in `err.cause`; undici's own `fetch` nests it one deeper again. Matching only `err.message` therefore classifies every redirect as `unreachable` and hands the operator the wrong remedy — which is precisely the silent failure hazard 1 above describes.

### §45. One guarded GET, with every failure mode mapped

One GET through the host-mediated, egress-guarded `ctx.http`, with every failure mode mapped.

A 3xx STATUS IS CHECKED EXPLICITLY as well as caught. `redirect: "error"` turns a redirect WITH a `Location` into a throw, but a 3xx without one (a bare 304, a 300 with no Location) is delivered as an ordinary response — and treating that as a document would hand a parser an empty body and report `malformed_response`, sending the operator to the wrong place. Both routes converge on `redirected`.

## `packages/plugins/dependency-index-registries/src/index.test.ts`

### §46. Every call is fixtured against recorded real responses

Every HTTP call here is fixtured with `nock` against RECORDED, REAL response shapes — a Go module proxy `@v/list` text body, an abbreviated npm packument, PyPI's JSON API with a yanked release, and a real `maven-metadata.xml`. `nock.disableNetConnect()` is active for the whole file, so any call a fixture does not cover fails loudly instead of reaching the internet (CLAUDE.md: "Tests never touch the internet").

The shapes are not invented. Each fixture below carries a comment naming the field it exercises and why that field matters — a fixture built from a guess would prove the parser reads the fixture, which is the vacuous-test shape this repo has already been bitten by.

## `packages/plugins/dependency-index-registries/src/index.ts`

### §47. The four language-ecosystem version indexes

`@scp/plugin-dependency-index-registries` — the FOUR LANGUAGE-ECOSYSTEM version indexes behind ADR-0032 §7's third-party detection: the Go module proxy, the npm registry, PyPI, and a Maven repository. The fifth ecosystem, container images, is `@scp/plugin-dependency-index-oci`: it reaches a registry through the EXISTING vendored-skopeo channel rather than over `ctx.http`, so it shares no transport with these and lives in its own package.

FOUR PLUGINS, ONE PACKAGE — the `github`/`github-discovery` shape exactly. One subprocess-hosted instance loads exactly one plugin, so each ecosystem gets its own `PluginModule` name (`dependency-index-go`, `-npm`, `-pypi`, `-maven`) resolving to its own factory in this package. The alternative — four packages differing only in a URL template and a body parser — would be four copies of `common.ts`'s failure classifier, which is the one part that must not drift.

WHAT THESE PLUGINS DO NOT DO, and it is the load-bearing half (ADR-0032 §7, "NEVER GUESS A VERSION"): they do not rank, do not pick a "latest", do not filter to the major line, and do not skip anything they do not understand. They return the index's own list, verbatim, in the index's own spelling. Line membership and ordering are computed in ONE server-side place (`apps/server/src/dependencies/version-index.ts`) over `@scp/dependency-manifests`'s single `parseComparableVersion`/`compareVersions` pair. Four plugins each deciding what "newest" means is four places for `"9" > "10"` to come back.

AIR-GAP (charter principle 5): none of these has a default URL. Unconfigured, every one reports `not_configured` — an explicit UNAVAILABLE, never an empty version list, because "nothing answered" and "nothing newer exists" are opposite facts that produce identical bumps (none) and would make a disconnected estate look permanently up to date.

### §48. The module proxy's case encoding, which is not optional

The module proxy's CASE-ENCODING, which is not optional and not cosmetic.

The proxy protocol requires every uppercase letter in a module path to be written as `!` followed by its lowercase form, "to avoid ambiguity when serving from case-insensitive file systems". `github.com/Masterminds/semver/v3` is fetched as `github.com/!masterminds/semver/v3`; sending the raw path gets a 404 from `proxy.golang.org`, which this plugin would faithfully report as `unknown_coordinate` — a correct-looking answer to a question we asked wrong, and one that would silently exclude every capitalised module (a large share of real go.mod files) from detection.

The coordinate itself is stored and compared VERBATIM everywhere else (ADR-0032 Context 2); this encoding exists only inside the URL and never travels back out.

### §49. The list endpoint returns plain text, one version a line

`GET {base}/{escaped-module}/@v/list` — the real response is `text/plain`, one version per line, UNORDERED, and legitimately EMPTY for a module with no tagged releases:

```text
  v1.0.0
  v1.1.0
  v1.2.0
```

An empty body is therefore `available` with zero versions, NOT `malformed_response`: the module exists and has no tagged version, which is a true fact about the line.

### §50. The body is undefined for an empty response, not null

`ScopedHttpResponse.body` is JSON-parsed when it parses and is `undefined` for an EMPTY body — and an empty body is exactly what the proxy returns for a module with no tagged release, so it must reach the `available, zero versions` branch rather than being reported as a broken index. (Caught by "an EMPTY list body is 'available with zero versions'"; the first cut of this check treated it as `malformed_response`.)

### §51. `GET {base}/{name}` with the ABBREVIATED packument `Accept`

`GET {base}/{name}` with the ABBREVIATED packument `Accept`. The real full document embeds every version's complete `package.json` and reaches tens of megabytes for a long-lived package; `application/vnd.npm.install-v1+json` is the registry's own documented, much smaller projection and carries the only field this needs:

```text
  { "name": "lodash",
    "dist-tags": { "latest": "4.17.21" },
    "versions": { "4.17.20": { "dist": {...} }, "4.17.21": { "dist": {...} } } }
```

`dist-tags.latest` is deliberately IGNORED. It is a mutable pointer the publisher controls and it is frequently NOT on the subscribed major line at all (a package on v5 publishes `latest: 5.x` while a component subscribes to the v4 line); reading it would put an off-line version forward as this line's head, which is exactly the wrong-version-is-worse-than-none failure of ADR-0032 §7.

### §52. `GET {base}/pypi/{name}/json` — the real shape

`GET {base}/pypi/{name}/json` — the real shape:

```text
  { "info": { "name": "requests", "version": "2.31.0" },
    "releases": { "2.30.0": [ { "filename": "...", "yanked": false } ],
                  "2.31.0": [ { "filename": "...", "yanked": false } ],
                  "0.0.1":  [] } }
```

TWO KINDS OF ENTRY ARE EXCLUDED, and both are exclusions the INDEX ITSELF states rather than inferences this plugin draws:

- a release whose files are ALL `yanked: true` — PEP 592's own "this release must not be selected by a resolver". Reporting it would let a subscription bump onto a version the publisher formally withdrew. - a release with NO files at all (`[]`) — PyPI keeps these as registered-but-unpublished versions; there is nothing to install, so it is not a version anything can move to.

`info.version` is ignored for the same reason npm's `dist-tags.latest` is: it is the publisher's newest overall, not this line's head.

### §53. Pull the version texts out of a real Maven metadata file

Pull `<version>` texts out of the `<versions>` block of a real `maven-metadata.xml`:

```text
  <metadata>
    <groupId>org.springframework</groupId>
    <artifactId>spring-core</artifactId>
    <versioning>
      <latest>6.1.4</latest>
      <release>6.1.4</release>
      <versions><version>5.3.31</version><version>6.1.4</version></versions>
      <lastUpdated>20240215120000</lastUpdated>
    </versioning>
  </metadata>
```

SCOPED TO THE `<versions>` BLOCK, not the whole document — `<latest>`/`<release>` are siblings carrying version text too, and a document-wide scan would fold the publisher's "newest overall" into the line's candidate set (the same mistake npm's `dist-tags` invites).

Hand-rolled rather than pulling an XML library, for the reason `@scp/dependency-manifests`'s `pom-xml.ts` states for itself: charter principle 5 wants these paths dependency-free and offline, and the document is a fixed, tiny, machine-generated shape. Returns `null` — not an empty list — when there is no `<versions>` block at all, so "this is not maven-metadata.xml" stays distinguishable from "this artifact has no versions".

## `packages/plugins/dependency-index-registries/src/test-support.ts`

### §54. Test-only support, deliberately not re-exported

Test-only support. NOT re-exported from `index.ts`.

`nock@13.5.6` (the version this repo pins) does NOT intercept the global `fetch`/undici — proven empirically by the github plugin's own spike and documented in `packages/plugins/github/src/ github-test-support.ts`. It patches Node's `http`/`https` core modules only. So the `ScopedHttpClient` fixtures run against is built on `node:http`/`node:https` directly; a fetch-based one would sail past every fixture in this package and hit the real network.

## `packages/plugins/dependency-index-registries/vitest.config.ts`

### §55. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §56. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/fake-executor/src/config-schema-parity.test.ts`

### §57. THE `detailByTarget` GAP, MADE A GATE

THE `detailByTarget` GAP, MADE A GATE (M23.0 verification pass 8 finding #3)
`detailByTarget` was added to `FakeExecutorConfig` and to `status()` but NOT to `manifest.configSchema`, which is `additionalProperties: false`. Nothing was red: the test harness injects boot-time config directly and bypasses `validatePluginConfig` entirely, so the gap was invisible to every test that exercises this plugin — only a real tenant `PUT /executors/{id}/binding` naming the key would have 400'd, contradicting this module's own doc comment, which calls the schema's keys "the tenant-facing surface".

THE PROPERTY, CENSUSED RATHER THAN RESTATED BY HAND: every top-level `FakeExecutorConfig` field EXCEPT `statePath` (server-governed — see the doc above `manifest`, "DELIBERATELY ABSENT") must appear in `configSchema.properties`. Reading the INTERFACE'S OWN SOURCE (not a second hand-typed list here) is what makes this a gate and not just a differently-shaped restatement of the bug: a hand-typed list would have missed `detailByTarget` exactly the way the schema did.

PROVEN BY DELETING THE WIRING: comment out `detailByTarget` in `configSchema.properties` (leaving it in the interface) and this test fails, naming the field. Comment it out of the INTERFACE instead and the test still passes (schema is a superset of nothing to cover) — which is correct: an unused schema key is a different, lesser defect this test does not claim to catch.

### §58. Field names read from the interface's own source

Top-level `FakeExecutorConfig` field names, read from the interface's own source — never a hand-typed restatement (that would have the same blind spot the bug did). A field is a line indented EXACTLY two spaces inside the interface body ending `name?:` or `name:`; a nested type literal's own fields (e.g. inside `rolloutByTarget`'s `Record<string, {...}>`) sit at four spaces or more, or share a line with the declaration, so they never match this pattern.

## `packages/plugins/fake-executor/src/fake-executor.conformance.test.ts`

### §59. Wires this plugin into the generic executor conformance suite

Wires `@scp/plugin-fake-executor` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/ plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing about fake-executor specifics — this file is only the fixture factory.

The factory sets a per-call `statePath` (a fresh temp file) and provides `restart` (MAJOR #4) so the suite's cross-restart dedup test genuinely reads durable on-disk state rather than the first instance's in-process memory.

## `packages/plugins/fake-executor/src/index.test.ts`

### §60. THE STRING SEAM INTO `observed_state`

THE STRING SEAM INTO `observed_state` (M23.0 verification pass 10).

`observedStateFrom` maps `status().stateRef` onto `observed_state.revision`. Until this hook existed the value was hardcoded to `v${target.version}`, so `imagesByTarget` — an ARRAY — was the ONLY free-form field an integration test could vary in that column, and every string-shaped defect in `@scp/runner-launcher`'s persisted-JSON bound was unreachable end to end by construction. Three verification rounds shipped one behind that gap.

DELETE-THE-WIRING: drop the `cfg.stateRefByTarget?.[targetRef] ??` in `status()` and the first assertion fails; the second is the one that keeps the default — and every existing `v0`/`v1` assertion in this file — from being collateral of adding it.

### §61. Simulates the subprocess-host scenario

Simulates the subprocess-host scenario: process A (plugin instance 1) triggers a run, then gets killed; a freshly spawned process B (plugin instance 2, same statePath) must answer status() for that exact ref correctly. Two SEPARATE `FakeExecutorPlugin` instances stand in for "two separate OS processes" here — the class holds no state itself once statePath is set (see module doc), so this is a faithful proxy for the real subprocess-kill scenario, which is additionally exercised end-to-end in apps/server/src/plugin-host/*.integration.test.ts. Deterministic clock (fake Date only): the "running" read happens at elapsed 0 and the "succeeded" read after a controlled +40ms jump — no dependence on wall-clock timing, which previously flaked when I/O between trigger() and status() outran the 20ms auto-succeed window.

## `packages/plugins/fake-executor/src/index.ts`

### §62. The in-repo executor with controllable, deterministic outcomes

@scp/plugin-fake-executor — the in-repo `ExecutorPlugin` with controllable, deterministic outcomes (BUILD_AND_TEST.md §4.2: "a fake-executor plugin (in-repo, controllable outcomes) used for full coordination-loop tests without any external system"; §8 M3 item 7). Never shipped to a real org — its only job is letting the reconciliation loop, the subprocess plugin host, and their integration tests drive a realistic multi-wave rollout AND a rollback, deterministically, with no network or external system involved.

State-persistence design (documented per the M3 build brief, since it's the thing that makes the plugin-host isolation DoD scenario — "kill the fake-executor SUBPROCESS mid-wave... the wave resumes" — actually true): state is keyed by `TriggerIntent.targetRef` and, when `ctx.config.statePath` is set, persisted to that JSON file after every mutation (write-to-temp + rename, so a concurrent reader never observes a half-written file). A subprocess plugin host (apps/server/src/plugin-host/host.ts) passes a stable `statePath` per instance, so when it kills and respawns the child mid-wave, the NEW process's `FakeExecutorPlugin` re-reads exactly the state the old one left behind and `status()` keeps answering correctly for in-flight refs — this mirrors how a REAL executor's state lives external to the plugin process (GitHub/ArgoCD don't forget a workflow run because SCP's plugin subprocess restarted).

When `statePath` is unset (typical for fast in-process unit tests), state lives in a plain in-memory `Map` scoped to the `FakeExecutorPlugin` instance — a "restart" in that mode really would lose state, which is why the subprocess-host path always sets `statePath`.

### §63. Per-target deterministic `status().detail`

Per-target deterministic `status().detail`. Mirrors `forcePhase`, and exists for one reason `imagesByTarget` and `rolloutByTarget` do not cover: `ExecutionStatus.detail` is free-form `string` from ANY executor plugin, and `reconcile.ts` writes it into a `Decision`'s `inputContext` — permanent governed state, one row per failing poll. Proving that write is BOUNDED needs a plugin that returns an unbounded detail, and no in-repo plugin does: the three managed ones bound their own at composition (`@scp/runner-launcher`'s `boundDetail`, enforced by their stores' types), which is exactly why they cannot be the witness. A THIRD-PARTY plugin is the case the bound is for, and this is the only stand-in for one.

### §64. A generated per-target detail, too large to cross argv

A GENERATED per-target `detail`, for values too large to cross a spawn argv.

`detailByTarget` carries its string literally, and the plugin host passes plugin config on the subprocess ARGV (`host.ts` `spawnInstance`). Linux caps a single argument at MAX_ARG_STRLEN (128 KiB) and answers `spawn E2BIG` past it; macOS does not, so a 432 KB literal passed locally and failed only on CI. The bound belongs to the transport, not to this plugin — so a test that needs a large detail sends the RECIPE and the plugin expands it here, in-process.

### §65. Per-target deterministic `status().stateRef`

Per-target deterministic `status().stateRef` — the synced revision. Mirrors `imagesByTarget` and `rolloutByTarget`, and exists because of what their SHAPES could not reach.

THE HARNESS HAD NO STRING SEAM INTO `observed_state`, and four consecutive verification rounds shipped a regression behind that gap (M23.0 pass 10). `observedStateFrom` builds `{revision, images, rollout}`: `revision` comes from `status().stateRef`, which this plugin HARDCODED to `v${target.version}`, and `detail` never enters `observed_state` at all. So the only free-form field an integration test could vary in that column was `imagesByTarget` — an ARRAY. `@scp/runner-launcher`'s persisted-JSON bound treats arrays and strings by different rules (an array is cut by dropping ENTRIES, a string by the per-string width bound), and every string-shaped defect in that allocator was therefore unreachable end to end BY CONSTRUCTION: a per-string bound that discarded half of every share was invisible to a green integration suite for three rounds.

The DEFAULT is unchanged — absent this key, `status()` still reports `v${target.version}` and `coercePriorStateRef` still round-trips it — so this adds a seam without moving any existing assertion.

### §66. Per-target extra fields the returned run ref carries

Per-target extra fields the returned `ExternalRunRef` carries ALONGSIDE `externalId`, emitted BEFORE it — the seam `executor_ref` had none of (M23.0 verification pass 12).

WHY THE COLUMN NEEDED ONE. `trigger()`'s whole return value is written to `change_wave_targets.executor_ref` by `markWaveTargetTriggered`, through the same `boundPluginJson` as `observed_state` — and EVERY end-to-end fixture in this repository drives `observed_state`. `PluginHost.executor()` types the JSON-RPC response with a BARE CAST, so at runtime the ref is whatever the plugin serialised: a real executor returns its own vendor fields beside the two this interface names, and their ORDER is whatever its serialiser chose. This plugin returned exactly `{externalId, url}`, both short, so no test could reach the branch that decides whether `externalId` survives the bound.

WHY `externalId` IS THE WORST LEAF IN THE PRODUCT (pass 9's census, "Instance 3"). All nine executor plugins read it out of the persisted ref to address the run: `status()` here does `parseTargetRef(ref.externalId)` and compares `target.externalId !== ref.externalId`. A ref the executor can no longer interpret is not an error anywhere — this plugin answers `pending`, Argo CD answers 404 — so reconcile writes `observing` and POLLS THE TARGET AS AN UNKNOWN RUN FOREVER, behind a green health check.

EMITTED FIRST, DELIBERATELY. The bound seats an object's keys in insertion order, so a ref whose vendor fields come first is the shape in which `externalId` is the one that does not fit. `externalId` and `url` are spread AFTER these, so a config that names either cannot break the plugin's own contract with itself.

### §67. Parses a prior `status()` call's `stateRef`

Parses a prior `status()` call's `stateRef` (e.g. `"v2"`) back into a version number for a `rollback` trigger; defensively falls back to 0 for anything else (unset, malformed, uninterpretable — `priorStateRef` is typed `unknown` on the wire).

A STRUCTURED PRIOR STATE IS READ TOO, and that is not a convenience — it is what makes `change_wave_targets.prior_state_ref` drivable end to end (M23.0 verification pass 12). `ExecutionStatus.stateRef` is `unknown` precisely so an executor whose state is not one string can return an object (a Terraform state serial and lineage, an Argo CD revision per source), and that is the shape whose LOAD-BEARING LEAF the persisted-JSON bound can drop while leaving the column populated and plausible. With only the string form here, the harness could put nothing in that column that a wrong answer would be visible in: `String({...})` is `"[object Object]"`, so a damaged object and an intact one coerce identically to 0 and a rollback restores version 0 either way — indistinguishable from a rollback that worked on a never-triggered target.

### §68. Idempotency dedup (PR #7 review, CRITICAL #2)

Idempotency dedup (PR #7 review, CRITICAL #2): the engine re-calls trigger() with the SAME idempotencyKey when it can't tell whether a prior attempt's call actually reached us before the caller crashed/retried. Recognizing a repeat is what makes that safe to do — no second real run, no version bump, just the same answer as last time. Only engages when the caller actually sent a key (falsy `intent.idempotencyKey` never matches `undefined === undefined`... it would, so the truthiness check below is required — an intent that never sets idempotencyKey must always mint a fresh run, exactly like before this field existed).

### §69. Unknown / superseded ref

Unknown / superseded ref — e.g. an in-memory (no statePath) instance that lost state across a restart, or a stale ref from before a later trigger on the same target. Reporting "pending" rather than throwing is what keeps a killed-and-respawned subprocess (which, with a shared statePath, would NOT hit this branch — see module doc) from ever looking like a hard failure to the reconciliation loop.

### §70. Manifest — added because "never shipped to a real org"

Manifest — added because "never shipped to a real org" (module doc, above) is a statement about INTENT, not about reach: `fake-executor` is on `executor-bindings-repo.ts`'s `KNOWN_EXECUTOR_MODULES` **and** is `DEFAULT_EXECUTOR_MODULE`, so a tenant `PUT /executors/{id}/ binding` naming it is accepted on any deployment. While this package had no manifest, `validatePluginConfig` had no schema to gate on and returned early — every key of that binding's config was stored unread.

`additionalProperties: false` with `statePath` DELIBERATELY ABSENT, the `managed-iac` shape: the server injects `statePath` itself for every executor instance (`resolveExecutorPluginInstance`, spread LAST), so it is server-governed here exactly as `runnerImage` is there — a binding that sets it is refused rather than silently overridden. The remaining keys are this plugin's deterministic test hooks, which ARE the tenant-facing surface.

## `packages/plugins/fake-executor/vitest.config.ts`

### §71. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §72. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/federation-https/src/index.ts`

### §73. The connected and intermittent federation transport

`@scp/plugin-federation-https` — the connected/intermittent transport (DESIGN.md §13): "the outpost dials the commander over mTLS HTTPS to PULL config-journal segments and to PUSH its own status/audit segments; the commander NEVER initiates a connection to an outpost." Both `pull()` and `push()` are always called FROM the outpost's own scheduled sync job (apps/server's federation sync scheduler) dialing OUT to the commander's public `/v1/federation/*` API — there is no server (listening) half of this plugin, structurally: nothing in this package ever binds a port or accepts an inbound connection. That is what makes "outpost-initiated-only" true by CONSTRUCTION, not merely by convention — a commander has no code path here that could reach INTO an outpost.

All network I/O goes through the host-mediated `ctx.http` (`ScopedHttpClient`) — DESIGN.md §11: "egress-controlled, instrumented HTTP — the only network path a plugin is given." This plugin never opens a raw socket or TLS connection itself. Concretely, that means the mTLS client certificate presentation for a given peer is a HOST-level concern: the subprocess plugin host (apps/server/src/plugin-host/) resolves the target peer's vaulted client certificate (by matching the request URL against the peer's registered `baseUrl` — federation/peers-repo.ts) and configures the underlying HTTPS agent before dispatching the request. DEFERRED, FLAGGED IN THE M6 PR BODY: wiring the subprocess host to actually inject per-peer mTLS certs into its `ScopedHttpClient` implementation is real remaining work this milestone does not complete — the plugin-side contract (this file) is what DOES land, structurally ready for that host wiring to slot in behind it without another interface change. The FILE transport (`scp federation export/import`, apps/server/src/routes/federation.ts + packages/cli) is fully implemented, tested, and is what the two-domain E2E and every "SECURITY-SENSITIVE" DoD integration test actually exercises — this plugin adds the LIVE/scheduled path on top of the identical verified import logic, never a separate one.

`pull`/`push` adapt between this package's stable `JournalSegment`/`BundleRef` wire shapes (kept intentionally free of any `@scp/schemas` dependency — packages/plugins/* may import ONLY `@scp/plugin-api`, BUILD_AND_TEST.md §7 import-boundary rule) and the actual `.scpbundle` JSON the server's `/federation/exports`/`/federation/imports` endpoints speak: `entries`/the bundle body are carried as opaque `unknown` payloads here, parsed and cryptographically verified SERVER-SIDE (federation/import-repo.ts) exactly as a file-transport import is — this plugin never itself trusts or interprets bundle contents, it only moves bytes.

### §74. Pulls the commander's config-journal since `cursor.sequence`

Pulls the commander's config-journal since `cursor.sequence` — a single HTTP round trip to the commander's `POST /federation/exports`, dialed by the outpost. Returns the ENTIRE `.scpbundle` body as one `JournalSegment` (its `entries` field is the bundle's own entries array; `contentHash`/`signature` carry the bundle-level checksum/signature — the caller applies it via the same `importSyncBundle` the file transport uses, which re-verifies everything independently).

### §75. Pushes this domain's own status/audit segment TO the commander

Pushes this domain's own status/audit segment TO the commander — a `POST /federation/imports` dialed by the outpost, carrying THIS domain's own signed bundle (the commander applies it through the exact same fail-closed `importSyncBundle` path any import goes through — an outpost's push is not a trusted shortcut). `segment` here is expected to already be a full `.scpbundle` JSON payload (reconstructed by the caller from a real `exportSyncBundle` call against this domain's OWN journal) stashed across `entries`/`contentHash`/`signature` — see this module's doc for why the exact bundle envelope fields don't map 1:1 onto `JournalSegment`'s minimal shape; the caller is responsible for supplying a segment whose `entries` is literally the bundle body.

## `packages/plugins/federation-https/vitest.config.ts`

### §76. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §77. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/git-provider-core/src/index.test.ts`

### §78. `@scp/git-provider-core` unit tests

`@scp/git-provider-core` unit tests — the provider-neutral machinery, exercised with a FAKE adapter (no HTTP, no real provider). These cover the shared logic the GitHub plugin's own `nock` suite would otherwise be the only proof of, so the core is independently covered before a second provider (Gitea, M15.1b) rides on it: the dedup/idempotency cache (in-memory + file-backed), the dispatch-then-persist trigger dance, the observe cursor protocol + event concatenation, and correlation-hint normalization.

### §79. NEGATIVE CONTROL, and the point of the whole assertion

NEGATIVE CONTROL, and the point of the whole assertion: `readFileAtRef` must NOT appear on the assembled `ExecutorPlugin`. ADR-0032 §9 and charter principle 1 hold that the four verbs ARE the structural enforcement of "coordination, not execution"; a fifth key here becomes a fifth verb in every consumer of an `ExecutorPlugin`. The positive half (the hook exists and is reachable on the ADAPTER) is asserted alongside so this cannot pass by the hook simply not existing.

### §80. The adapter is read-only, and a write hook may not return

`GitProviderAdapter` IS READ-ONLY, AND A WRITE HOOK MAY NOT REAPPEAR ON IT (owner decision 2026-08-15; ADR-0032 §9)
§9 justifies this adapter's existence as an escape hatch on TWO things: the `ExecutorPlugin` object is unchanged, AND — in its own words — "It also only READS." M21.5 briefly grew `createBranch`/`putFileOnBranch`/`openPullRequest` here, which contradicts the second half of that argument: extending the same mechanism to writes leaves the verb set intact while moving repository-write authority into a package every git-provider plugin loads and that is not one of the charter's enumerated managed classes. The write authority therefore lives inside `scp-managed-dep` (`packages/plugins/managed-dep`), where the charter's containment preconditions actually bind, and this interface reads.

The absence is pinned TWO ways, because they fail at different times and catch different edits:

- the TYPE-LEVEL pin fails `tsc` the moment a write hook is DECLARED on the interface, which is the edit that would reopen this. A runtime `in` check cannot see an interface at all; - the key-set assertion in the test above already fails if such a hook were also surfaced as a fifth verb.

The read hook is asserted PRESENT in the same breath, so this cannot go green by the whole capability quietly disappearing — the vacuous-pass shape this repository has been bitten by.

## `packages/plugins/git-provider-core/src/index.ts`

### §81. The provider-neutral machinery every git adapter shares

`@scp/git-provider-core` — the **provider-neutral** machinery shared by every git-provider `ExecutorPlugin` (GitHub today, Gitea next — M15.1a, ADR-0014). This is an internal library, NOT a loadable plugin module: it exposes the `GitProviderAdapter` interface plus a factory that assembles a full `ExecutorPlugin` (observe/trigger/status/abort/describeCapabilities) from a given adapter. Everything wire-format-specific to a provider (auth, base URL + REST wrapper, the CI-trigger calls, webhook signature verification, event-name→hint mapping, the status/conclusion →phase map, the `source_kind` literal) lives in the per-provider adapter; everything provider- neutral (the idempotency/dedup cache, correlation-hint normalization, the observe cursor protocol, the dispatch-then-persist trigger dance, the ExecutorPlugin assembly) lives here.

The idempotency design this core owns is the one the GitHub plugin documented and `coordination/reconcile.ts`'s crash-safe retry depends on: `trigger()` dedups on the `idempotencyKey` FIRST, against its own persisted cache — so a retry of the SAME logical attempt never fires the provider automation twice — and only a genuinely NEW key delegates to the adapter's `triggerCI` (which does the provider's own dispatch + any provider-specific run correlation). The cache is file-backed when `adapter.resolveStatePath(ctx)` returns a path (same write-to-temp+rename pattern as the fake/argocd executors) and process-in-memory otherwise.

### §82. Correlation-hint normalization — a git provider observes activity

Correlation-hint normalization — a git provider observes activity (push/PR/run/deploy/release) and emits a small, uniform `hint`; this turns that hint into the `ExecutorEventCorrelation` the host matches against `source_mappings` (DESIGN §9.2). Provider-neutral: the hint SHAPE is shared; only how each provider POPULATES it (event-name mapping) is provider-specific (adapter.mapEvent).

### §83. The fully-qualified git ref this event is on

The fully-qualified git REF this event is on (`refs/heads/dev`) — what a `refPattern` source mapping matches against (ADR-0030 §1), and the field that makes "the dev branch drives the dev pipeline" expressible.

Carried EXPLICITLY rather than parsed back out of `correlationKey`, even though a push event's correlation key is usually the ref today. The key is a grouping identity whose composition is the host's business — a package push folds the artifact digest into it, so reading a ref out of it would be right for some events and quietly wrong for others. An adapter that knows the ref sets this; one that doesn't leaves it undefined and no ref-scoped mapping can match its events.

### §84. The SOURCE branch of a pull/merge request, fully qualified

The SOURCE branch of a pull/merge request, fully qualified (`refs/heads/scp/dep-bump/<id>`) — deliberately SEPARATE from `ref` and deliberately not used for source-mapping routing.

A pull request is an event about a PROPOSAL to move code between two branches; the ref the routing question is about is its BASE, and the field a `refPattern` mapping matches is `ref`, which a pull-request event correctly leaves unset. But "which branch is this pull request FROM?" is a real fact the payload carries, and one consumer needs it: M21.5's provenance loop, which recognises a bump CommanderSCP authored by the branch it is on and then requires SCP's own record to name that same branch and repository (ADR-0032 §9).

Without it, a `pull_request` action=opened delivery processed BEFORE the authored push (the ordering is the provider's, not ours) named no branch and no yet-recorded commit, matched the component's ordinary source mapping, and minted the second unrelated change §9 exists to prevent.

Adding it to `ref` instead would have been the smaller diff and the wrong one: every ref-scoped source mapping in every existing deployment would have started matching pull-request events by their head branch, silently re-routing releases.

### §85. Base-URL resolution, and its provider-neutral precedence

Base-URL resolution — provider-neutral precedence for an adapter's REST base URL (M15.3b). A git-provider adapter's base URL can come from three places, in order: (1) the adapter's OWN explicit config field (github's `apiBaseUrl`, gitea's `baseUrl`) — a deliberate per-binding override; (2) the execution-system's injected `config.serverUrl` — how a Mode-A "import an EXISTING provider" binding tells the adapter where that provider lives (executor-bindings-repo injects it; discovery/run injects it too); (3) a provider default (github's `api.github.com`; gitea has none). This helper owns ONLY the precedence + trailing-slash trim; each adapter keeps its own field names and its own "neither was set" error message (gitea throws, github defaults), so the provider-neutral core gains no provider-specific knowledge.

### §86. Idempotency / run-correlation dedup cache

Idempotency / run-correlation dedup cache — see module doc. File-backed (crash-safe) when a state path is given, otherwise a single process-wide in-memory map (identical scoping to what the GitHub plugin had before this extraction: one map per Node process = per subprocess plugin instance).

### §87. GitProviderAdapter — the per-provider seam

GitProviderAdapter — the per-provider seam. Everything below is provider-SPECIFIC and supplied by the adapter; the factory (createExecutorPluginFromAdapter) supplies everything provider-NEUTRAL.

Which hooks the executor factory itself calls: `resolveStatePath`, `triggerCI`, `pollCommits`, `pollRuns`, `getStatus`, `abortRun`, `capabilities`. The remaining hooks (`sourceKind`, `authorize`, `baseUrl`, `verifyWebhook`, `mapEvent`, `mapStatusToPhase`, `readFileAtRef`) are the rest of the provider contract: `authorize`/`baseUrl` back the adapter's own REST calls; `verifyWebhook`/`mapEvent` back the server-side webhook ingest path; `mapStatusToPhase` backs `getStatus`; `sourceKind` is the provider identity used in discovery/source-mapping; `readFileAtRef` backs ADR-0032's manifest ingestion. They live on one cohesive adapter object so a new provider (Gitea) is a single, self-contained implementation.

### §88. Read one file's text at a ref, plus the resolved commit

Read ONE file's decoded text at a git ref, plus the commit sha that ref resolved to (M21.2, ADR-0032 §4 / proposal §4.3(a) — the declared-manifest ingress the dependency inventory is built from). Returns a `not_found` result for a missing file/ref (routine — most components declare only one or two of the five ecosystems' manifests) and a `refused` result for a file that exists but will not be decoded (too large, not a blob, not text). Genuine failures — auth, 5xx, a refused redirect, an egress-guard denial — THROW, already classified by `read-file.ts`'s `wrapProviderRequestError`/`assertNoRedirect`.

An adversarial `repo`/`path`/`ref` also THROWS, before any HTTP happens: every implementer MUST call `assertSafeRepo`/`assertSafeRepoPath`/`assertSafeRef` first. That is a hard requirement, not a suggestion — all three are spliced into a REST route, and percent-encoding does not close a `..` segment (`encodeURIComponent("..") === ".."`), so without the asserts a caller re-targets the request at a different endpoint using the binding's own credentials (M21.2 review). A THROW rather than a `refused` result is deliberate: that is a caller bug, not a fact about the repo.

REQUIRED, not optional, on purpose: every implementer lives in this monorepo (github, gitea, gitlab, plus the core's own test fake), so a required hook makes a fourth provider's omission a compile error instead of a silently empty dependency inventory for that provider's components.

NOT AN EXECUTOR VERB (ADR-0032 §9, charter principle 1). `createExecutorPluginFromAdapter` does not surface it: `ExecutorPlugin` stays exactly observe/trigger/status/abort, which is what structurally enforces "coordination, not execution". This hook reads; it can never write.

### §89. Bounded multi-file/tree read (team-pipeline-iac proposal §12)

Bounded multi-file/tree read (team-pipeline-iac proposal §12): given a repo, a ref and one or more path globs, lists matching paths and reads them, bounded on every axis (`read-tree.ts`'s module doc). Same NOT-AN-EXECUTOR-VERB posture as `readFileAtRef` — read-only, never surfaced by `createExecutorPluginFromAdapter`.

REQUIRED, not optional, for the same reason `readFileAtRef` is required: every implementer lives in this monorepo, so a required hook makes a fourth provider's omission a compile error instead of a silently-unavailable capability for that provider.

### §90. Observe cursor protocol

Observe cursor protocol: an ISO-8601 watermark PER EVENT KIND, JSON-encoded in `since.token` (a bare ISO string is the legacy form and applies to every kind). The core owns the protocol; the adapter interprets the watermark for each resource it polls.

The two resources below MUST resume from separate watermarks. They have different time bases — a commit is stamped with its author date, a workflow run with its creation time — and a CI run is always created AFTER the commit that triggered it. Sharing one watermark therefore let a run drag the cursor past its own commit, and the next `?since=` query skipped that commit for good. See `apps/server/src/coordination/observe.ts` for the measured case.

### §91. Own-key lookups, so a prototype name cannot answer

Own-key lookups. `marks[kind]` for a `kind` of `"__proto__"`, `"constructor"`, `"toString"`, … reads an INHERITED member of `Object.prototype` rather than a watermark. Today the `typeof === "string"` guards below happen to reject every such member, so this is hardening rather than a live bug — but the guard is what makes it safe, not the lookup, and the twin of this function in `apps/server/src/coordination/observe.ts` had no such guard and WAS broken (a `__proto__`-kind event froze its cursor permanently). Same property, so same fix.

### §92. Assembles the four-verb `ExecutorPlugin` around an adapter

Assembles the four-verb `ExecutorPlugin` around an adapter.

`adapter.readFileAtRef` is deliberately NOT surfaced here (ADR-0032 §9): the four verbs are the structural enforcement of charter principle 1, and a fifth entry on this object would be a fifth verb in everything downstream that consumes an `ExecutorPlugin`. Callers that need to read a manifest hold the ADAPTER — the same way `apps/server/src/coordination/webhook-adapters.ts` already holds `githubAdapter`/`giteaAdapter`/`gitlabAdapter` for `verifyWebhook`/`mapEvent`.

## `packages/plugins/git-provider-core/src/read-file.test.ts`

### §93. `read-file.ts` unit tests

`read-file.ts` unit tests — the provider-neutral half of `readFileAtRef` (M21.2, ADR-0032 §4). Pure functions only: no HTTP, no nock, no provider. Each adapter's wire shapes are proven in that package's own nock suite; what is proven HERE is the behavior all three share, so a refusal is tested once instead of three times.

Every assertion below is mutation-proven: the bound checks fail if either size gate is removed, the UTF-8 round-trip test fails if the round-trip check is dropped OR if the decode is changed to latin1, and the whitespace-stripping test fails if `base64DecodedByteLength` stops stripping.

### §94. THE ONLY EVIDENCE OF TRUNCATION THERE IS

THE ONLY EVIDENCE OF TRUNCATION THERE IS. Every one of ADR-0032's six manifest formats is line-oriented or brace-balanced, and the first N bytes of a `requirements.txt` are still a valid `requirements.txt` — so no parser and no consumer can see this from the content. Its one consumer PRUNES a manifest's declarations down to what it just parsed, so a body missing its second half deletes the declarations that never arrived.

Gates 2 and 3 each compare ONE size against the decode bound; this is the only place the two sizes are compared with each other.

### §95. The load-bearing half of the fix, and why it lives here

This is the load-bearing half of the M21.2 repo fix, and it lives here rather than in the adapters because it is a property of THIS charset. github's and gitea's `readFileAtRef` put the validated `repo` into their routes unencoded (see the comment at each `const repoPath = repo`), which is only safe while `REPO_SEGMENT` admits nothing that a URL would treat structurally or that would need an escape. They previously wrapped it in `encodePathSegments`, but that call was a provable identity under this same charset — a no-op indistinguishable from its own deletion, so no test could hold it (CLAUDE.md: a well-written comment naming a hazard is a signal to sweep, not evidence it was handled). Relaxing the charset — a space, `~`, `%`, `/`, or "any non-slash character" — fails HERE instead of silently re-opening the injection two packages away.

The sweep is over every ASCII code point plus a sample of non-ASCII (an exhaustive Unicode sweep is not runnable; these catch the realistic relaxation, e.g. to a negated class).

### §96. The sweep must also be shown to have ACCEPTED something

The sweep must also be shown to have ACCEPTED something: an assert that refused every candidate would satisfy the check above vacuously (this repo's second recurring bug class — green for the wrong reason). Pinning the exact accepted set rather than a count also makes the charset itself readable here, and makes any change to it — tightening included — arrive as a deliberate edit to this line.

## `packages/plugins/git-provider-core/src/read-file.ts`

### §97. The provider-neutral half of reading one file at a ref

`readFileAtRef` — the provider-neutral half of the "read ONE file out of a repo at a ref" capability (M21.2, ADR-0032 §4 / proposal §4.3(a)). Until this file existed **SCP could not read a file body from a user repo at all**: the three git adapters' discovery walks call the contents API but read only `entry.name`/`entry.type` from a DIRECTORY LISTING (`packages/plugins/github/src/index.ts:741-753`, and the gitea/gitlab ports of the same walk) — they never fetch or decode a blob. ADR-0032's inventory is built from what a component's own manifests *declare* (`package.json`, `go.mod`, `pom.xml`, `requirements.txt`/`pyproject.toml`, `Dockerfile`), so the missing primitive is exactly this one.

WHAT THIS IS NOT (ADR-0032 §9, charter principle 1): `readFileAtRef` is a **`GitProviderAdapter` hook, never a fifth `ExecutorPlugin` verb**. `createExecutorPluginFromAdapter` deliberately does not surface it — the four-verb set (observe/trigger/status/abort) *is* the structural enforcement of "coordination, not execution", and adding a verb would remove the enforcement mechanism rather than extend it. This hook only READS; nothing here can write a branch, a commit or a PR.

WHAT LIVES HERE vs IN AN ADAPTER: this file owns the request/result vocabulary, the decode bound, the base64→UTF-8 decode with its refusals, the `repo`/`path`/`ref` URL-safety asserts, and the two failure classifiers (redirect, transport/egress). Each adapter owns only its own wire calls — which endpoint, which field carries the commit sha, how a directory comes back — because those genuinely differ: Gitea's contents API is GitHub-compatible, **GitLab's is not** (different endpoint, different path encoding, and it returns the resolved commit id in the same response).

### §98. Repository to read from, as the provider's own `owner/repo`

Repository to read from, as the provider's own `owner/repo` (GitLab: a full project path, e.g. `group/subgroup/repo`). OPTIONAL: when omitted the adapter reads the repo its binding is already configured for — the same repo every other hook on that adapter addresses. It is accepted at all because ADR-0032's ingestion work-list is per COMPONENT and one binding legitimately covers several components in one org (the monorepo case discovery already proposes), so pinning the hook to exactly one repo per binding would force a binding per component.

Validated by `assertSafeRepo` before it reaches a URL — it is caller-supplied and every adapter splices it into a REST route.

### §99. The commit `requestedRef` resolved to

The commit `requestedRef` resolved to. This is the whole point of returning it: a branch name is not an identity (the same lesson ADR-0032 §7 states for a mutable image tag — "we are on 1.2.3" must be a statement about bytes, not about a label), so an inventory row records the commit it was derived from, not the branch it was derived through.

### §100. The file (or the ref) is not there

The file (or the ref) is not there. This is a ROUTINE answer, not an error: "this component has no `go.mod`" is the expected response for four of the five ecosystems on any given component, so it must not throw.

`missing` says WHICH lookup came back empty, and `"unknown"` is a real member rather than a defaulted guess: GitHub/Gitea resolve the ref in a separate call, so a 404 there is attributable; GitLab answers both in ONE call and distinguishes them only in a human-readable `message` string, which is exactly the kind of thing that goes false the moment the wording changes (the provenance-label lesson). So the GitLab adapter reports `"unknown"` and puts the provider's own message in `detail` rather than inferring a label from it.

### §101. Why a file that EXISTS was deliberately not decoded

Why a file that EXISTS was deliberately not decoded. Distinct from `not_found` because the caller must be able to tell "no manifest here" (skip, silently) from "there is a manifest and we refused it" (report it — a component whose `package.json` is 40 MB is a fact worth surfacing, not one to bury).

### §102. Default decode ceiling

Default decode ceiling: 1 MiB. Sized against what this capability is FOR — a declared-dependency manifest. The largest of the five ADR-0032 ecosystems' manifests in practice is a `pom.xml` with a long `<dependencyManagement>` block, still tens of KB; `Dockerfile`/`go.mod`/`requirements.txt` are smaller again. Lockfiles are the only routinely-megabyte files in this family and ADR-0032 §8 puts them explicitly out of scope ("Manifest-only edits. No lockfile resolution."), so nothing this capability serves needs a larger default.

1 MiB also happens to be where GitHub's contents API stops returning inline content at all, so the default and the provider's own limit agree rather than fighting.

### §103. An absolute ceiling, applied to caller-supplied bounds too

Absolute ceiling, applied to a CALLER-SUPPLIED `maxBytes` as well as the default. The bound has to be structural, not advisory: `readFileAtRef` takes an arbitrary repo path, and a caller that asked for `maxBytes: 2 ** 31` would otherwise turn one call into an out-of-memory. 4 MiB leaves headroom for a genuinely large manifest without letting the hook become a general file-transfer primitive.

### §104. The effective decode bound for one call

The effective decode bound for one call: the caller's request clamped into `(0, HARD_MAX_FILE_BYTES]`, defaulting to `DEFAULT_MAX_FILE_BYTES`. A zero/negative/NaN request is treated as "not a bound the caller meant" and falls back to the default rather than refusing every file — an accidental `maxBytes: 0` should not silently make the whole inventory empty.

### §105. The TRANSPORT bound

The TRANSPORT bound — M21.2 review MAJOR 5, closed. Everything above bounds what this file DECODES; everything below bounds what a `ScopedHttpClient` is allowed to BUFFER on the way to this file, via `ScopedHttpRequest.maxResponseBytes` (`@scp/plugin-api`). The two bounds serve different jobs and are deliberately set to different NUMBERS: the decode bound protects the dependency inventory from an oversized-but-legitimate manifest (routine, refused as `too_large`); the transport bound protects THIS PROCESS's memory from a hostile or misconfigured host that ignores every polite signal (`declaredSizeBytes`, `encoding: "none"`) and just keeps sending bytes — measured concretely as the gap: Gitea and GitLab serve arbitrarily large blobs inline as base64 with no analogue of GitHub's `encoding: "none"` cutoff, so `ctx.http.request()` used to buffer the WHOLE body (`apps/server/src/plugin-host/ subprocess-entry.ts`'s pre-fix `await res.text()`) before `decodeBoundedBase64`'s gates ever ran.

### §106. Headroom over the decode bound, for the transport ceiling

Headroom added on top of the base64-inflated decode bound when sizing the TRANSPORT ceiling for a contents fetch. Base64 inflates by 4/3; on top of that, every provider wraps the blob in a small JSON envelope (path, sha, encoding, links, …) — a few KB at most across all three providers' shapes (`GithubContentFile`/`GiteaContentFile`/`GitlabRepositoryFile`). 64 KiB is generous relative to that envelope and cheap relative to `maxBytes`, so it never becomes the binding constraint — a legitimate response for a file within the decode bound is never rejected at the transport layer for a reason `decodeBoundedBase64`'s own gates never get to explain.

### §107. The response ceiling a contents fetch should pass

The `ScopedHttpRequest.maxResponseBytes` an adapter's contents-fetch call should pass, derived from the (already-clamped, via `resolveMaxBytes`) decode bound for this call. Deliberately a FUNCTION of `maxBytes` rather than a second flat constant: the transport ceiling must always be strictly above the decode bound it is protecting (otherwise a legitimately-sized file would be refused at the transport layer with a message that never mentions `decodeBoundedBase64`'s own, more specific gates), and coupling it structurally to `maxBytes` is what keeps that true if `HARD_MAX_FILE_BYTES` or a caller's `request.maxBytes` ever changes.

When THIS bound trips (rather than one of `decodeBoundedBase64`'s), it means the response was far past what any legitimate manifest could be — a multi-gigabyte blob, not an oversized `pom.xml` — and the read is refused before the bytes finish arriving, which is the entire point.

### §108. The default response ceiling for every other call here

Default `ScopedHttpRequest.maxResponseBytes` for every OTHER git-provider REST call this package's adapters make (trigger/poll/status/abort/discover) — not just `readFileAtRef`'s contents fetch. Same property, per CLAUDE.md's census discipline: every one of those calls also went through `ctx.http.request()` unbounded before this fix, and a hostile or misconfigured host answering a runs-list or a commits-list with gigabytes of JSON is the identical OOM shape, just on a different endpoint. Sized generously for a legitimate list response (thousands of runs or commits, each a few hundred bytes of JSON) while still bounding memory against a host that does not behave.

### §109. Decoded byte length, computed without allocating

Decoded byte length of a base64 payload, computed from its length WITHOUT allocating the decode. This is what lets the size refusal happen before the memory is spent.

Whitespace is stripped first and that is load-bearing, not tidiness: **GitHub's contents API returns base64 wrapped at 60 characters with embedded `\n`**, so a naive `b64.length` over-counts a GitHub payload by ~1.7% and, worse, `Buffer.from` would silently ignore those bytes — the two numbers would disagree. Padding (`=`) is subtracted because each `=` stands for a byte that is not there.

### §110. base64 → bounded, verified UTF-8 text

base64 → bounded, verified UTF-8 text. Every adapter funnels its contents response through this one function so all three refuse identically; only the extraction of `base64`/`encoding`/`size` from the provider's own JSON differs.

Five gates, in cost order — the cheapest refusal happens first, so an oversize file is refused having allocated nothing:

1. **Encoding.** Anything that is not `base64` is refused. GitHub's `"none"` is special-cased to `too_large`, because that is what it documents: for a blob between 1 MB and 100 MB GitHub returns the metadata with an EMPTY `content` and `encoding: "none"`. Reporting that as "unsupported encoding" would be technically true and practically misleading. 2. **Declared size.** Refuse on the provider's own `size` before touching the payload. 3. **Computed size.** Refuse on `base64DecodedByteLength` — deliberately NOT trusting gate 2, which is a number the provider asserts about a payload it also sends. This gate is the one that actually holds when the two disagree. 3b. **Completeness.** Gates 2 and 3 each compare ONE size against the bound; neither compares the two with each other. That comparison is the ONLY evidence in the system that a body is partial — a truncated line-oriented manifest is still a syntactically valid one — so a payload SHORTER than the provider's declared size is refused as `incomplete_body` rather than handed on as content. Short only; see the reason's own doc for why over-long is not refused. 4. **Text.** A NUL byte anywhere, or bytes that do not survive a UTF-8 round trip, is refused as `not_text`. NUL-scanning is git's own binary heuristic; the round trip catches the rest, because `Buffer.toString("utf8")` NEVER fails — it substitutes U+FFFD — so without it a binary manifest would come back as plausible-looking mojibake and be *parsed*.

There is no post-decode size check: `base64DecodedByteLength` is an exact upper bound on what `Buffer.from(…, "base64")` can produce (it ignores characters it cannot decode), so gate 3 already bounds the allocation.

CLOSED — M21.2 review MAJOR 5. These gates bound what SCP DECODES; the TRANSPORT bound (a SEPARATE, larger number — `resolveMaxResponseBytes`) now bounds what a `ScopedHttpClient` is allowed to BUFFER on the way here, enforced DURING accumulation by every conforming `ScopedHttpClient` (`apps/server/src/plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient` in production; each package's own `node:http`-backed test client in tests — see `ScopedHttpRequest.maxResponseBytes` in `@scp/plugin-api`).

What was measured, per provider, before the fix:

- **GitHub was incidentally bounded**, by the provider and not by us: its contents API stops returning inline content above 1 MB and answers with `encoding: "none"` instead (gate 1's `too_large` case), so a GitHub blob response could not exceed ~1.4 MB whatever the file's size. Still given the same explicit transport bound as the other two now, for defense in depth — nothing in this package's contract should depend on a provider's incidental behavior. - **Gitea and GitLab were NOT bounded.** Both serve arbitrarily large blobs inline as base64, so any file a binding could reach buffered in full — `ctx.http.request()` did `await res.text()` over the WHOLE response with no cap, no content-length pre-check and no `Range` header, so the body sat fully in the plugin subprocess's memory — roughly 1.37x the file's size, base64 — *before* gate 1 ran. This was a real exposure, not a theoretical one.

It is fixed HOST-SIDE (covers every plugin, not just these three) rather than per-adapter with a pre-check: GitLab's metadata-only view of a blob is `HEAD .../repository/files/:path` (`X-Gitlab-Size`), and `ScopedHttpRequest.method` is `GET|POST|PUT|PATCH|DELETE` — a plugin cannot issue a HEAD at all; Gitea's is the parent DIRECTORY listing, a second round trip per read whose own response grows with the sibling count, which would have reduced the exposure rather than removed it and left GitLab untouched. Fixing one of three providers with a half-measure is the shape of fix this repo's census discipline exists to prevent (CLAUDE.md) — the transport bound closes the class for all three (and every other `ScopedHttpClient` caller that opts in) in one place instead.

### §111. Gate 3b — THE BYTES THAT ARRIVED ARE NOT THE FILE

Gate 3b — THE BYTES THAT ARRIVED ARE NOT THE FILE. Gates 2 and 3 each compare ONE size against the bound; neither compares the two sizes with EACH OTHER, and that comparison is the only evidence anywhere in the system that a body is partial. See `incomplete_body`.

SHORT ONLY, deliberately. A payload that decodes to MORE than the provider declared is not the truncation hazard and is not worth failing a read over: `size` is provider metadata and a provider that under-reports (a stale index entry, a size computed pre-filter) would otherwise make every manifest in that repo unreadable. The direction that deletes an inventory is the short one, and it is the only one refused.

### §112. Rejects a repo path that must never reach a URL

Rejects a repo path that must never reach a URL. This is not defensive decoration: every adapter below interpolates `path` into a REST route, so a `..` segment does not merely name a file outside the repo — it walks the API route itself (`/repos/o/r/contents/../../user` is a *different endpoint*, reached with the binding's credentials). Refused rather than normalized, because silently rewriting a caller's path would make the request differ from what the caller can see.

A backslash is refused too: it is a legal character in a POSIX path but is the path separator on the other side of several providers' storage layers, so allowing it means the same string names two things.

### §113. Characters a git ref may never contain

Characters a git ref may never contain, as `git check-ref-format` defines them: ASCII control characters and DEL, space, and the seven metacharacters git reserves for its own revision syntax (`~ ^ : ? * [` and `\`). Three of those are also the ones that would change a REST request rather than name a ref — `?` starts a query string, `[`/`\` are provider-storage hazards — so the git rule and the URL rule want the same refusal here and there is no need for two lists.

### §114. Rejects a ref that must never reach a URL, refusing not fixing

Rejects a `ref` that must never reach a URL, and REFUSES rather than sanitises.

Why per-segment encoding is not enough — measured, not assumed: `encodeURIComponent("..")` is `".."`, so `encodePathSegments` passes a `..` segment through untouched. A ref of `../../../../user` therefore turned `GET /repos/{o}/{r}/commits/../../../../user` into `GET https://api.github.com/user` — a DIFFERENT endpoint, reached with the binding's installation credentials. Encoding protects the *contents* of a segment; only a validator can refuse a segment that is structural.

Refused rather than rewritten, for the same reason `assertSafeRepoPath` refuses: silently turning the caller's `../../user` into something else makes the request differ from what the caller asked for and can see, which is its own hazard.

The rule set is git's own (`git check-ref-format`), not an invented allowlist, so everything a provider can legitimately be asked for still works: a 40-hex commit sha, `main`, a `feature/x` branch, a `v1.2.3` tag, and a fully-qualified `refs/heads/x`.

### §115. The characters a repo or owner segment may contain

The characters a repo/owner/group/project segment may contain across all three providers. GitHub owner and repo names, Gitea's, and GitLab group/project paths are each drawn from exactly `[A-Za-z0-9._-]`, so this is the providers' own rule rather than a guess — and it is what makes the subsequent `encodePathSegments` call provably an identity function (every character here is URL-unreserved), which is why encoding alone was never going to be the control.

### §116. Rejects a caller-supplied `repo` that must never reach a URL

Rejects a caller-supplied `repo` that must never reach a URL. Third of the three asserts, and the one that was missing longest: `request.repo` is spliced into the route by every adapter, and two of the three spliced it **raw** — neither validated nor encoded. Both halves of that were exploitable, and each needs its own refusal:

- a `..` segment re-targets the route exactly as it does for `path`/`ref` — `acme/widgets/../../..` turned `GET /repos/{repo}/commits/main` into `GET https://api.github.com/commits/main`, and the gitea adapter into `.../repos/acme/widgets/../../../commits?sha=main`; - a `?` TERMINATES the route early — `acme/widgets?x=` made `/repos/acme/widgets?x=/commits/main` a request for the repo itself with the rest of the intended route folded into a query parameter.

The gitlab adapter was the one that already encoded (its `:id` is a single whole-encoded route parameter, so `%2F`/`%3F` made it inert) — that is why this is a shared assert rather than a per-adapter patch: the class was understood for one provider and missed for two, which is the signature of a fix applied to an instance instead of to the property (CLAUDE.md, census).

`exactSegments` is the provider's own shape, not a style preference: GitHub and Gitea address a repo as exactly `owner/repo`, while a GitLab project path legitimately nests (`group/subgroup/repo`), so only the first two can assert a count.

### §117. Percent-encodes per segment, keeping the separator literal

Percent-encodes a path/ref PER SEGMENT, keeping `/` as a literal separator. This is the encoding GitHub's and Gitea's contents routes want (the path is part of the route), and it is what makes a ref like `release/1.x` or a path like `svc a/go.mod` survive.

NOTE the divergence, which is the reason this is a named export rather than an inline expression: **GitLab is the opposite** — its files endpoint wants the file path encoded WHOLE, slashes turned into `%2F`, because there the path is a single route parameter. The gitlab adapter therefore does NOT use this function, and says so at its call site.

### §118. Refuses a redirect that arrived as a status, not a throw

Refuses a 3xx that arrived as a STATUS rather than as a thrown error, with a message that says what actually happened.

Why this exists at all, measured: the plugin host's HTTP client hard-disables redirect following — `redirect: "error"` on both branches of `scopedFetchHttpClient` (`apps/server/src/plugin-host/subprocess-entry.ts:285,295`), because a 3xx could re-point a request at an internal host AFTER the pre-flight egress check has already passed. Under THAT client a redirect never reaches a plugin as a status; `fetch` rejects and the plugin sees a transport failure (handled by `wrapProviderRequestError`).

But `ScopedHttpClient` is an interface, and the client a plugin actually gets is whatever the host injected. The suites in this repo inject a `node:http`/`node:https`-backed client so `nock` can intercept — and Node's core `http` does not follow redirects *or* error on them, it hands the 3xx straight back as a status. So a 3xx IS reachable as a status, and without this check it would fall through the adapter's `status < 200 || status >= 300` arm as an anonymous "HTTP 302", which tells an operator nothing about why their `https://gitea.example.com` (which redirects to `https://gitea.example.com/`) never worked. Making the failure legible is the requirement; both shapes of the same failure now name the redirect.

### §119. Turns whatever the client threw into an actionable error

Turns whatever `ctx.http.request` threw into an error an operator can act on, without changing any policy. Four cases, all deliberately non-swallowing:

- **Already ours** (`assertNoRedirect`'s product) — passed through untouched, so the redirect explanation is not buried under a generic transport message. - **Response too large** (`ScopedHttpResponseTooLargeError`, `@scp/plugin-api` — `ScopedHttpRequest.maxResponseBytes` was exceeded and the read was aborted mid-stream, M21.2 review MAJOR 5) — re-stated naming the limit and that this is a REFUSAL, not a truncation: the caller never receives partial bytes to mistake for the whole file. - **Egress-guard refusal** (`egressBlocked: true`, `apps/server/src/plugin-host/egress-guard.ts:83`) — re-stated with the self-hosted case named, because that is the failure a self-hosted Gitea or GitLab actually hits: the guard blocks loopback/private addresses for every TENANT-configurable plugin, and `github`/`gitea`/`gitlab` are all deliberately absent from `OPERATOR_PLANE_MODULES` (subprocess-entry.ts:210-215). **Nothing here weakens that**, and it must not: the guard is the SSRF control. The only honest thing this layer can do is stop the operator from reading "fetch failed" and guessing. The underlying error is preserved as `cause`. - **Anything else** — a transport failure, which under the production client is ALSO what a refused redirect looks like (undici rejects rather than returning the 3xx), so the message names that possibility instead of leaving it invisible.

## `packages/plugins/git-provider-core/src/read-tree.test.ts`

### §120. `read-tree.ts` unit tests

`read-tree.ts` unit tests — the provider-neutral half of `readFilesAtRef` (team-pipeline-iac proposal §12: bounded multi-file/tree reads). Pure functions and accumulators only: no HTTP, no nock, no provider — each adapter's wire shapes (tree-listing endpoint, pagination) are proven in that package's own nock suite; what is proven HERE is the bound machinery all three share.

## `packages/plugins/git-provider-core/src/read-tree.ts`

### §121. `readFilesAtRef` — bounded multi-file / tree reads

`readFilesAtRef` — bounded multi-file / tree reads (team-pipeline-iac proposal §12: "extend `git-provider-core` with bounded multi-file/tree reads … before leaning harder on `readFileAtRef`"). Given a repo, a ref, and one or more path globs, lists matching paths and reads them — bounded on FOUR axes, every one enforced DURING accumulation and never silently:

1. **Per-file bytes** (`maxFileBytes`) — identical machinery to `readFileAtRef`'s `maxBytes` (`resolveMaxBytes`/`decodeBoundedBase64`/the transport ceiling from `resolveMaxResponseBytes` — M21.2 review MAJOR 5). A single oversized file is a ROUTINE `refused` entry, same as `readFileAtRef` alone. 2. **File count** (`maxFiles`) — a cap on how many MATCHED paths this call will read. 3. **Total bytes** (`maxTotalBytes`) — a cap on the cumulative DECODED bytes across every file read in the batch. 4. **Entries scanned** (`maxEntriesScanned`) — a cap on the raw tree entries enumerated while LISTING and matching, independent of how many (if any) globs match — the "N+1 fetches without a ceiling" hazard: a monorepo with hundreds of thousands of paths must not be walked to completion just because the caller's globs happen to match nothing.

Axes 2-4 are STRUCTURAL: exceeding any of them throws a `GitProviderTreeBoundError` naming which bound was hit, as soon as that becomes provably true — never a "here is what fit" partial result. Axis 1 stays the existing `readFileAtRef` per-file `refused` shape, because a single oversized manifest is a fact about ONE file, not a reason to fail the whole batch (the same reasoning `read-file.ts` already documents for why `too_large` is a result, not a throw).

NOT AN EXECUTOR VERB, same as `readFileAtRef` (ADR-0032 §9, charter principle 1): this is a `GitProviderAdapter` hook, never surfaced by `createExecutorPluginFromAdapter`. It only reads.

Identity: `ADR-0030`'s `(repo, path, ref)` tuple is what any new file-identifying API must key on — every entry in `ReadTreeAtRefFound.files` carries its own `path`, and the request carries `repo`/`ref` once for the whole batch (all matched files share one resolved commit).

### §122. Repo-relative globs; a path matching any of them is included

One or more repo-relative glob patterns; a path matching ANY of them is included. Grammar: `*` matches within one path segment, `**` matches across `/` — the SAME two-token grammar `apps/server/src/coordination/glob-match.ts` uses for `source_mappings.pathPattern`, so a caller already holding one of those patterns can reuse it here unchanged. At least one glob is required — an empty list matches nothing, which is almost certainly a caller bug, so it is refused rather than silently returning zero files (see `assertNonEmptyGlobs`).

### §123. One matched file's read outcome

One matched file's read outcome — reuses `ReadFileAtRefResult`'s found/not_found/refused shape so a batch member is indistinguishable from a standalone `readFileAtRef` call on the same path. `not_found` is possible in principle (a path present in the tree listing disappearing before the content fetch — a genuine TOCTOU, not expected in practice) but never `missing: "ref"`, since the ref was already resolved once for the whole batch.

### §124. Transport ceiling for a TREE-LISTING call

Transport ceiling for a TREE-LISTING call — the same principle as `read-file.ts`'s `resolveMaxResponseBytes`, applied to a listing response instead of a blob response. A tree listing can legitimately run to many thousands of small JSON entries, so this is sized larger than the generic `DEFAULT_API_RESPONSE_MAX_BYTES` — but it is still a NUMBER, not unbounded: a provider that ignores `recursive`/pagination and tries to hand back an entire enormous monorepo's tree in one response is refused here, at the transport layer, before this package's own `maxEntriesScanned` gate even gets to run.

### §125. Glob matching, starting from the server's own grammar

Glob matching — starts from `apps/server/src/coordination/glob-match.ts`'s grammar (`*` within a segment, `**` across `/`), duplicated rather than imported (packages under `packages/plugins` must never depend on `apps/server` — the host depends on plugins, never the reverse; this is a dozen lines of pure string/regex logic, not machinery worth a shared package of its own), PLUS one deliberate divergence: a leading `**/` also matches zero leading segments (see `globMatchesPath`'s own doc for why).

### §126. A leading `**/` means zero or more leading segments

A LEADING `**/` means "zero or more leading path segments" in standard glob semantics — the literal translation above (`.*` followed by a literal `/`) requires AT LEAST one character before that `/`, which wrongly rejects a repo-ROOT match: `**/go.mod` must match a root-level `go.mod`, not only `services/go.mod`, since this capability's whole point is finding a manifest anywhere INCLUDING the root. Made optional only at the START of the pattern, where this ambiguity actually arises for this consumer — `apps/server/src/coordination/ glob-match.ts`'s own patterns never start with `**` (every `source_mappings.pathPattern` in this codebase is `${componentPath}/**`, a SUFFIX use), so this is a genuine divergence from that mirror, not a silent behavior change to code it shares with.

### §127. Scan accumulator — axes 2 and 4, enforced DURING listing

Scan accumulator — axes 2 and 4, enforced DURING listing. An adapter feeds it one page of raw tree entries at a time (a single-shot provider like github/gitea's recursive tree API feeds it exactly once; a paginating provider like gitlab's feeds it once per page), and it throws the moment either bound is provably exceeded — never after the whole tree has been walked.

## `packages/plugins/git-provider-core/vitest.config.ts`

### §128. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §129. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/gitea/src/gitea-test-support.ts`

### §130. Test-only support, not part of this package's surface

Test-only support shared by `gitea.conformance.test.ts` and `index.test.ts`. NOT part of this package's public surface. Mirrors `@scp/plugin-github`'s `github-test-support.ts` — the same empirically-verified reason applies: `nock@13` does NOT intercept the global `fetch`/undici client, only Node's `http`/`https` core modules, so the `ScopedHttpClient` built here uses `node:https`/`node:http` directly (never `fetch`) — otherwise every `nock` fixture in this package's suite would be silently defeated (CLAUDE.md: "Tests never touch the internet").

### §131. An HTTP client backed by Node's core modules

Builds a `ScopedHttpClient` backed by Node's `http`/`https` core modules — see module doc for why this, and not `fetch`, is what makes `nock` fixtures actually apply.

Honors `ScopedHttpRequest.maxResponseBytes` the SAME way the production client (`apps/server/src/plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient`) does — bound checked DURING accumulation, in the `data` handler itself, not after `end` — so this package's own bound tests exercise the real transport-level enforcement over a real (loopback) HTTP connection, not a mock of it. `res.destroy()` on the incoming message aborts the read at the socket the moment the bound trips, mirroring the production client's `reader.cancel()`.

## `packages/plugins/gitea/src/gitea.conformance.test.ts`

### §132. Wires this plugin into the generic executor conformance suite

Wires `@scp/plugin-gitea` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant plugin-testkit suite"). Same thin-fixture shape as `github.conformance.test.ts`: this plugin makes REAL outbound HTTP calls (`ctx.http` is not a stub), so `gitea-test-support.ts`'s `createRealHttpClient()` + `nock` fixtures stand in for a Gitea instance. Fixtures are `persist()`ed (the suite calls each verb an unpredictable number of times) and this file deliberately does NOT assert `nock.isDone()` — that precise single-call proof lives in `index.test.ts`.

## `packages/plugins/gitea/src/index.test.ts`

### §133. `@scp/plugin-gitea` behavioral test suite

`@scp/plugin-gitea` behavioral test suite (M15.1b). Every HTTP call is fixtured deterministically with `nock` against Node's `http`/`https` core modules (see `gitea-test-support.ts`'s module doc for why the `ScopedHttpClient` uses `node:https` directly, not `fetch`). `nock.disableNetConnect()` is active file-wide so any unanticipated call fails loudly rather than reaching the real network (CLAUDE.md: "Tests never touch the internet"). Each test's interceptors are checked for full consumption by the file-wide `afterEach` (`nock.pendingMocks()` must be empty).

These assert REAL Gitea wire shapes (documented Swagger + the bare-hex X-Gitea-Signature), not tautologies: the auth header is `token <PAT>` (NOT github's Bearer), the base is `/api/v1`, the run status is a single Gitea enum, and the webhook signature is bare hex with NO `sha256=` prefix.

### §134. Same census class as readFileAtRef's `repo`/`ref`

Same census class as readFileAtRef's `repo`/`ref` (M21.2 review BLOCKERS 1-2) and github's `postCommitStatus` sha: a non-literal string spliced into a REST route. `externalId` is stored correlation state and numeric in practice, so this encoding is an IDENTITY today and its removal would change no observed behaviour — which is exactly why it is pinned. An unpinned member of a censused class is indistinguishable from an untouched one on the next refactor (CLAUDE.md, "census by property, not by symptom"). Unencoded, `../../../user` re-targets this GET at `<base>/user` because `new URL()` collapses literal `..` segments; encoded it is `..%2F..%2F..%2Fuser`, ONE segment a URL does not normalize away. The interceptor matches only the encoded form, and `disableNetConnect()` plus the file-wide pending-mocks check make the unencoded form fail loudly rather than pass quietly.

### §135. Base-URL resolution (M15.3b)

Base-URL resolution (M15.3b) — explicit `baseUrl` → injected `serverUrl` (Mode A: import an EXISTING Gitea, the execution-system's serverUrl injected as config.serverUrl). Gitea has NO provider default (unlike github's api.github.com), so neither being set is a hard, clear error.

### §136. discover() (DiscoveryPlugin) — Gitea contents-API topology walk

discover() (DiscoveryPlugin) — Gitea contents-API topology walk. The `sourceKind: 'gitea'` on the proposed component's sourceMapping is the load-bearing assertion (matches the executor's source_kind so imported components correlate observed gitea events). Gitea's contents API is GitHub-compatible; the fixtures below are REAL Gitea contents-API entry shapes.

### §137. Endpoints asserted by reference to the proposed objects

The endpoints must be the ALIASES the proposed objects declare, asserted BY REFERENCE to those objects rather than as a third copy of the literal. Restating the strings would let a plugin change its URN scheme in one of the two places and stay green — and an endpoint that names no proposed object is exactly the 404 (`object '...' not found`) that made this edge unimportable even once its type was right.

### §138. The first file-body read in this package

readFileAtRef (M21.2, ADR-0032 §4) — the first file-body read in this package. Gitea's contents API is deliberately GITHUB-COMPATIBLE, so the fixtures below carry Gitea's documented `ContentsResponse` fields (`type`/`encoding`/`size`/`content`/`sha`, with `sha` being the BLOB sha) and a directory comes back from the same route as an array — the same shapes github's suite asserts. What is NOT github-shaped, and is asserted here, is the ref resolution: Gitea's contents response has no commit sha, so the commit comes from `GET /repos/{o}/{r}/commits?sha=<ref>&limit=1` (the same documented list-commits endpoint `pollCommits` already uses).

### §139. `#` is where both encodings become load-bearing

`#` is where these two encodings are load-bearing rather than decorative: `git check-ref-format` permits it in a ref and it is legal in a filename, so neither `assertSafeRef` nor `assertSafeRepoPath` refuses it — but unencoded it ends the URL, so step 1's `?sha=release/#42` would query `sha=release/` (resolving the WRONG commit) and step 2 would request the `docs/` directory listing. Both are wrong answers, not errors, which is why they are pinned rather than left to the not-found paths.

### §140. THE TRANSPORT bound (M21.2 review MAJOR 5, closed)

THE TRANSPORT bound (M21.2 review MAJOR 5, closed) — a SEPARATE, larger ceiling from the decode-bound `too_large` refusals above. Those two tests prove `decodeBoundedBase64`'s gates; this one proves the response never gets there in the first place when it is far past what any legitimate manifest could be. Gitea is the provider where this mattered most: unlike GitHub, it has no `encoding: "none"` cutoff and serves arbitrarily large blobs inline.

### §141. The failure an in-cluster Gitea on a private address gives

This is the failure an in-cluster Gitea on a private address produces: the guard blocks loopback/private egress for every tenant-configurable plugin (subprocess-entry.ts:210-215, egress-guard.ts:83) and `gitea` is deliberately not an operator-plane module. The adapter's job is to make that legible, never to bypass it — so this test injects a ctx whose http client throws exactly what the guard throws, and asserts only on the message.

### §142. ADVERSARIAL `ref` and `repo`

ADVERSARIAL `ref` and `repo` (M21.2 review, BLOCKERS 1 and 2). `repo` was spliced into this adapter's routes RAW — proven to build `.../repos/acme/widgets/../../../commits?sha=main` — and `ref` was only `encodeURIComponent`d, which leaves `..` intact. Each test registers NO interceptor, so with the assert removed the call escapes as a nock no-match; asserting the MESSAGE (not merely that it threw) is what keeps these from passing for the wrong reason.

### §143. readFilesAtRef (team-pipeline-iac proposal §12)

readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. Gitea's recursive tree listing is GITHUB-COMPATIBLE (`GET .../git/trees/{sha}?recursive=true`, one response, `truncated: true` when it hit Gitea's own ceiling).

### §144. THIS ADAPTER WRITES NOTHING

THIS ADAPTER WRITES NOTHING (owner decision 2026-08-15; ADR-0032 §9)
ADR-0032 §9 admits `GitProviderAdapter` as an escape hatch on two grounds — the `ExecutorPlugin` object is unchanged, and "It also only READS." M21.5 briefly grew branch/commit/pull-request hooks on all three providers, which contradicts the second ground. The repository-write authority now lives inside the enumerated `scp-managed-dep` class (`packages/plugins/managed-dep`), where the charter's containment preconditions bind.

`@scp/git-provider-core`'s own suite pins the INTERFACE at the type level. This pins the OBJECT, here, because the interface is structural: an adapter carrying extra write methods still satisfies it, so the type-level pin alone would not notice a hook re-added to this file. Asserted per provider rather than once, because the hooks existed on all three — the census is the point (CLAUDE.md: fix the property, then find every place with it).

## `packages/plugins/gitea/src/index.ts`

### §145. `@scp/plugin-gitea` — the Gitea `ExecutorPlugin`

`@scp/plugin-gitea` — the Gitea `ExecutorPlugin` (M15.1b, ADR-0014 follow-on to M15.1a's `@scp/git-provider-core` extraction). This package is a **thin Gitea ADAPTER** over the same provider-neutral core the github plugin is built on: everything provider-neutral (the idempotency/dedup cache, the observe cursor protocol, correlation-hint normalization, the dispatch-then-persist trigger dance, the `ExecutorPlugin` assembly) lives in `@scp/git-provider-core`; everything Gitea-wire-specific lives here as a `GitProviderAdapter`. The github adapter (`@scp/plugin-github`'s `githubAdapter`) is the reference implementation.

GITEA-SPECIFIC WIRE FACTS (how this differs from github — the whole reason a separate adapter exists rather than reusing githubAdapter): - AUTH is a Personal Access Token, sent `Authorization: token <PAT>` — NOT github's App-JWT → installation-token exchange. There is no JWT flow at all here. - BASE REST URL is `<instanceUrl>/api/v1` (a self-hosted instance host, not a fixed api.github.com). - Gitea Actions is deliberately GitHub-Actions-COMPATIBLE (`.gitea/workflows/*.yml`, `workflow_dispatch`), so the trigger(dispatch) → observe(runs) → status-phase logic MIRRORS github and REUSES the core; only the endpoint paths + auth header differ. See the LOAD-BEARING ASSUMPTION note below. - Webhook signatures are a BARE-HEX HMAC-SHA256 in `X-Gitea-Signature` (NO `sha256=` prefix — the one place neither github's verifier nor the server's generic `sha256=<hex>` verifier works), so this package ships its own verifier (`verifyGiteaWebhookSignature`). - Gitea run status is a SINGLE enum (`success`/`failure`/`cancelled`/…) that already encodes the conclusion, unlike github's split `status` + `conclusion` — so `mapGiteaStatusToPhase` switches on one field (passing `conclusion = null` through the core's two-arg hook shape). - observe() additionally surfaces PACKAGE/OCI pushes (Gitea's package registry), emitting `ExecutorEvent.correlation.artifactDigest` for image pushes — the registry-promotion correlation key (ADR-0013). github never populated `artifactDigest`; this is new here.

LOAD-BEARING ASSUMPTION — CONFIRM WITH A LIVE DRILL (honest coverage note, mirrors the github package's own "nightly live-sandbox proves wire fidelity" split): every request/response shape below is exercised deterministically against `nock` fixtures built from Gitea's PUBLISHED REST API docs (Swagger) — this package never talks to a real Gitea instance in its own suite. The shapes marked `ASSUMED (Gitea Actions)` inline are the ones whose exact field names/paths are version-dependent in Gitea and MUST be confirmed against a real running Gitea before this executor is trusted in production: specifically (1) the workflow-dispatch path returning 204, (2) the runs-list response carrying a `workflow_runs[]` array, and (3) the single-run status GET. The auth header, `/api/v1` base, packages-list shape, and bare-hex webhook signature are NOT assumptions — those are documented and stable. Nothing here is fabricated; where a shape is uncertain it is flagged as an assumption rather than invented.

### §146. The response ceiling defaults so every call is bounded

`maxResponseBytes` defaults to `DEFAULT_API_RESPONSE_MAX_BYTES` — bounding EVERY call through this function, not just `readFileAtRef`'s (M21.2 review MAJOR 5's fix, applied to the one funnel every Gitea REST call in this adapter goes through). `readGet`'s contents fetch overrides it with the tighter, decode-bound-derived ceiling from `resolveMaxResponseBytes`.

### §147. Gitea signs deliveries as a bare hex HMAC of the raw body

Gitea signs webhook deliveries as an HMAC-SHA256 of the RAW request body, emitted as a **bare hex string** in `X-Gitea-Signature` — with NO `sha256=` prefix (this is the concrete reason the github verifier and the server's generic `sha256=<hex>` verifier both fail against Gitea, and why this dedicated verifier exists). Verification MUST run against the raw bytes, never a re-serialized JSON round-trip (whitespace/key-order differences break the HMAC). `timingSafeEqual` throws on a length mismatch, which we treat as "signature mismatch" — fail-closed either way.

### §148. Maps a Gitea webhook event name + payload to a correlation hint

Maps a Gitea webhook event name + payload to a correlation hint (null = ignore). Gitea's webhook payloads are largely GitHub-shaped for the git events (`push`/`pull_request`/`release`), with its own `package` event for registry pushes. Only the events a `source_mappings` correlation cares about are recognized; anything else yields `null` (ignored, not an error).

`package` (Gitea's registry publish event) carries `package.name`/`package.version`/`package.type`; for a container package a `sha256:`-shaped version IS the artifact digest (see `pollPackages`).

### §149. ASSUMED (Gitea Actions)

ASSUMED (Gitea Actions) — a Gitea Actions run as returned by the runs-list / single-run endpoints. Gitea aims for GitHub-Actions compatibility, but the EXACT field set is version- dependent; the load-bearing fields this adapter reads are `id`, `status`, `head_sha`, `html_url`, `created_at`. Gitea's run `status` is a SINGLE enum (no separate `conclusion`).

### §150. Page size and per-poll page ceiling for the polls

Page size and per-poll page ceiling for the list resources `observe()` polls, mirroring the github adapter's constants of the same name (the defect and its bound are identical; each adapter keeps its own copy because the query parameter NAMES differ per provider).

POLL_PAGE_SIZE is what we ASK for, never what we get: Gitea clamps every list to `[api] MAX_RESPONSE_ITEMS` (default 50) in `ListOptions.SetDefaultValues`, so a stock server answers `limit=100` with 50. Ending the walk on a page shorter than the REQUESTED size therefore stops on page 1 against every default install — the exact defect pagination was added to close — so each loop learns the SERVED page size from page 1 and ends on a page shorter than that (or empty, or at the budget). Same reasoning for any instance-configured ceiling on the sibling adapters.

### §151. ASSUMED shape is minimal here

ASSUMED shape is minimal here — a Gitea package (registry) list item. `GET /packages/{owner}` is documented + stable; the fields read (`name`, `version`, `type`, `created_at`, `repository`) are from the published Package model. For a container package a `sha256:`-shaped `version` IS the OCI manifest digest — that (and ONLY that) is surfaced as `artifactDigest`; a tag-shaped version is surfaced as a `correlationKey` and `artifactDigest` is left undefined (never fabricated).

### §152. readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a))

readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a)) — reading a file BODY, which neither this package nor github's could do before. `discover()` below hits the same contents route but reads only `entry.name`/`entry.type` off a directory listing; it never decodes a blob.

GITEA WIRE FACTS: Gitea's contents API is deliberately GITHUB-COMPATIBLE, which is why this mirrors the github adapter's two-step shape rather than inventing one — - `GET /api/v1/repos/{owner}/{repo}/contents/{filepath}?ref={ref}` returns, for a blob, a `ContentsResponse` with `type: "file"`, `encoding: "base64"`, `size`, `content`, and `sha` (the BLOB sha, same as github — NOT a commit sha). A directory returns an ARRAY. - The commit a ref resolves to comes from `GET /api/v1/repos/{owner}/{repo}/commits?sha={ref} &limit=1`, the SAME documented, stable list-commits endpoint `pollCommits` above already uses — the first element's `sha`. This is preferred over the contents response's `last_commit_sha` field on two grounds: `last_commit_sha` means "last commit that TOUCHED THIS FILE", which is a different fact from "what the ref resolved to" (so using it would make gitea's `commitSha` mean something else than github's and gitlab's), and it is a comparatively recent addition whose presence varies by Gitea version.

Everything else — the decode bound, the base64/UTF-8 gates, the redirect and egress-guard classifiers — comes from `@scp/git-provider-core`, so all three providers refuse identically.

### §153. A single authenticated GET on the read path

A single authenticated GET on the read path. Same two folded-in failure modes as the github adapter's `readGet`: a 3xx arriving as a STATUS is refused with an explanation by `assertNoRedirect`, and anything thrown by `ctx.http.request` is re-thrown by `wrapProviderRequestError` naming whether it was a refused redirect (`redirect: "error"`, subprocess-entry.ts:285,295) or an egress-guard denial. The egress case matters MORE here than for github: a Gitea instance is self-hosted by definition, and `gitea` is deliberately not in `OPERATOR_PLANE_MODULES` (subprocess-entry.ts:210-215), so an in-cluster Gitea on a private address is blocked. That control is not weakened here — only explained.

### §154. What resolving a ref costs a caller

What resolving a ref costs a caller: either a commit sha, or a minimal not_found shape — deliberately NARROWER than `ReadFileAtRefNotFound`/`ReadTreeAtRefNotFound` (`missing` is always `"ref"` here, never `"path"`/`"unknown"`, since resolving a ref cannot fail any other way) so each caller can widen it into its OWN result shape (one carries `path`, the batch does not) without a cast. Shared between `readFileAtRef` (one file) and `readFilesAtRef` (a whole batch reads ONE resolution and re-uses it — ADR-0030's `(repo, path, ref)` identity is per FILE, but the commit a batch is read AT is one shared fact, the same way `ReadTreeAtRefFound.commitSha` says).

### §155. `repo` reaches the routes below UNENCODED, deliberately

`repo` reaches the routes below UNENCODED, deliberately — same call as the github adapter makes, for the same reason. `encodePathSegments(repo)` was a provable IDENTITY given `assertSafeRepo`'s `[A-Za-z0-9._-]` charset (all URL-unreserved): a call that READ as the control while the assert above was the entire control, and that no test could tell apart from its own deletion. The coupling it claimed to defend (a later relaxation of `REPO_SEGMENT` letting an un-encoded repo reach a URL) is pinned where that charset lives — git-provider-core read-file.test.ts's "every character assertSafeRepo accepts is URL-identity" test. `path` and `ref` below still encode for real; their charsets do contain characters needing an escape.

### §156. readFilesAtRef (team-pipeline-iac proposal §12)

readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. Gitea's own tree listing is GITHUB-COMPATIBLE: `GET /repos/{o}/{r}/git/trees/{sha}?recursive=true` returns EVERY entry in ONE response (no page/per_page for the recursive form), capped by Gitea's own internal ceiling and flagged `truncated: true` if it hit that ceiling — there is no follow-up page to ask for, so a truncated response is refused here as `maxEntriesScanned` rather than silently matching only what arrived.

### §157. Layers package pushes on top of the core commits and runs

observe() for gitea layers package/OCI pushes on top of the core's commits+runs poll — the core factory's built-in observe only calls `pollCommits`+`pollRuns`, so we assemble the plugin from the adapter and then WRAP `observe` to also fold in `pollPackages`. Everything else (trigger/ status/abort/describeCapabilities) is the core's assembly untouched. `readFileAtRef` is an adapter-only hook (ADR-0032 §9) — the factory never turns it into a fifth executor verb.

### §158. Discovery: a port of the GitHub adapter's scan

DiscoveryPlugin (M15.3a — port of github's discover(); DESIGN §11/§12 — "repo/topology scan proposing Service/Component objects and source_mappings"; NEVER auto-commits, only proposes). Reuses this package's own `GiteaConfig`/`api()` — Gitea's contents API is GitHub-COMPATIBLE at `<baseUrl>/api/v1/repos/{owner}/{repo}/contents/{path}` (same response entry shape), so the marker-file topology walk is identical to github's; only the `sourceKind` differs. The discovered `sourceMapping.sourceKind` is `'gitea'` — matching the gitea EXECUTOR's `source_kind` (the `giteaAdapter.sourceKind` above) so an accepted component's `source_mappings` row actually correlates observed gitea events (push/run/package). This closes the observe-correlation gap for gitea: without a gitea-kinded source_mapping, pulled gitea events correlate against nothing.

NOTE (follow-up): github's discover omits `sourceMapping.type`, so it defaults to `'configuration'` server-side; this increment keeps that same default for gitea rather than inferring `'image'` for container-registry-backed components. Inferring type from the marker set (e.g. a Dockerfile → an image source) is a deliberate LATER increment. Generalizing this walk into `@scp/git-provider-core` (a `discover` hook on `GitProviderAdapter`) is also deferred until a second git provider needs it — two impls (github + gitea) now exist, so that extraction is the natural next step, but it is NOT this PR's scope.

## `packages/plugins/gitea/vitest.config.ts`

### §159. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §160. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/github-check/src/github-check.conformance.test.ts`

### §161. Wires this plugin into the generic control conformance suite

Wires `@scp/plugin-github-check` into `@scp/plugin-testkit`'s generic `ControlPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing about github-check specifics — this file is only the fixture factory, pointed at a `ctx.http` stub that always returns a well-formed green check run.

## `packages/plugins/github-check/src/index.ts`

### §162. The CI-green-for-this-digest wave-gate control

@scp/plugin-github-check — M10.4's concrete "CI green for digest X" wave-gate control (BUILD_AND_TEST.md §8 M10.4: "a concrete 'CI green for digest X' control (a `github-check`/ `webhook-control` binding) evaluable at `evaluateWaveGate`, so CI evidence can gate the infra→app boundary — the composition model's signature move"). A third sibling of `@scp/plugin-webhook-control`/`@scp/plugin-scan-result-control`: same `ControlPlugin` contract, same subprocess plugin host, same PULL intake pattern (GET a verdict via the host-mediated `ctx.http`, map it into a `ControlOutcome`). Bound to a `control` graph object via a `control_binding`, exactly like the other two — no execution-system involved.

CHARTER — coordinate, NOT execute (principle 1): this plugin NEVER runs CI. It only *reads* GitHub's own Check Runs API (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`) for whatever CI system (GitHub Actions or any third party posting Check Runs) already ran against the change's commit.

COMMIT BINDING ("nothing slipped in", same discipline as scan-result-control's ADR-0013 digest binding): the target commit comes from `req.context.commitSha` — the change's OWN tracked source commit (`governance/gate-orchestrator.ts`'s `resolveChangeCommitSha`), never an operator-typed value alone — falling back to `config.expectedRef` only when the change tracks none. A verdict is always for THIS change's commit, never a substituted one.

AUTH — a plain bearer token (`config.tokenSecretKey`, resolved via the host-mediated `ctx.secrets`), deliberately simpler than `@scp/plugin-github`'s full GitHub App JWT → installation-token flow. A read-only "is CI green" check warrants a narrowly-scoped token (fine-grained PAT with Checks: Read-only), not the App's broader installation credential a trigger/dispatch executor needs — least privilege — and it keeps this package self-contained (no dependency on `@scp/plugin-github`).

EGRESS — `apiBaseUrl` may legitimately point at a self-hosted GitHub Enterprise Server on a private address, the same on-prem case `scan-result-control`'s own module doc names for its scan source; `github-check` is therefore in `subprocess-entry.ts`'s `OPERATOR_PLANE_MODULES` (loopback/private egress permitted), same `policy:write`-gated control-binding trust tier as `webhook-control`/`scan-result-control`.

STILL-RUNNING CI → `"expired"`, NOT `"fail"`: a wave gate is frequently asked before CI on the target commit has even started or concluded. Returning `"fail"` for an in-flight check would be WRONG — `governance/control-runner.ts`'s `ensureControlRun` treats a produced outcome as a cached, permanent historical fact ("a control result is a historical fact, not continuously re-polled"), so an early `"fail"` would PERMANENTLY deadlock the wave the instant this control was ever asked before CI concluded. `"expired"` is the `ControlOutcomeStatus` reserved for exactly this — `control-runner.ts` re-polls a cached `"expired"` outcome after `EXPIRED_RECHECK_INTERVAL_MS`, so an in-flight check gets re-checked (bounded, never every reconcile tick) until it concludes one way or the other.

FAIL-CLOSED: missing config, no target ref, no auth token, an unreachable/unparseable API response, a non-2xx response (other than the "nothing reported yet" 404), or a timeout ALL yield `fail`/`timed_out` — a broken or absent CI signal can never authorize a boundary crossing.

## `packages/plugins/github-check/vitest.config.ts`

### §163. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §164. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/github/src/github-test-support.ts`

### §165. Test-only support, not part of this package's surface

Test-only support code shared by `github.conformance.test.ts` and `index.test.ts`. NOT part of this package's public surface (never re-exported from `index.ts`) — exists purely so this package's own tests can fixture every HTTP call with `nock` and prove the GitHub App auth flow (JWT -> installation token -> API call) works end to end, deterministically, without ever touching a real network (CLAUDE.md: "Tests never touch the internet").

IMPORTANT, EMPIRICALLY VERIFIED: `nock@13.5.6` (the version pinned in this repo's `package.json` — NOT the `nock@beta` channel) does **not** intercept the global `fetch` (undici) client. A quick spike (`fetch()` against a `nock`-mocked URL) proved the request sailed straight past `nock` to the real network. `nock` only patches Node's `http`/`https` core modules. So the `ScopedHttpClient` built here uses `node:https`/`node:http` directly (never `fetch`) — that's the mechanism that actually makes `nock` fixtures effective; a fetch-based client would silently defeat every fixture in this package's test suite.

### §166. An HTTP client backed by Node's core modules

Builds a `ScopedHttpClient` backed by Node's `http`/`https` core modules — see module doc for why this, and not `fetch`, is what makes `nock` fixtures actually apply.

Honors `ScopedHttpRequest.maxResponseBytes` the SAME way the production client (`apps/server/src/plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient`) does — bound checked DURING accumulation, in the `data` handler itself, not after `end` — so this package's own bound tests exercise the real transport-level enforcement over a real (loopback) HTTP connection, not a mock of it. `res.destroy()` on the incoming message aborts the read at the socket the moment the bound trips, mirroring the production client's `reader.cancel()`.

### §167. Fresh appId/installationId by default (unless overridden)

Fresh appId/installationId by default (unless overridden) — index.ts's installation-token cache is keyed module-wide by `appId:installationId`, so reusing the SAME identity across tests in one file would silently serve a cached token and skip the token-exchange HTTP call the test wants to assert on. Callers that WANT to reuse a cached token across two calls (none of this package's tests currently do) can pass explicit `appId`/`installationId` overrides.

`defaultWorkflowId` uses `"defaultWorkflowId" in overrides` (property-presence), NOT `??` — a caller that explicitly passes `{ defaultWorkflowId: undefined }` (to test the "no workflowId at all" error path) means it, and `??` would silently paper over that with the "ci.yml" fallback, defeating the whole point of the override.

### §168. Fixtures the installation access-token exchange

Nock-fixtures `POST {apiBaseUrl}/app/installations/{installationId}/access_tokens`, asserting the request carries a validly-signed App JWT (see `isValidTestAppJwt`) — the concrete proof that `signAppJwt`/`getInstallationToken` in index.ts are exercised for real. Returns the scope so callers that want strict single-call assertions can `.done()`/check `isDone()` themselves; `persist` (default false) allows repeat matches for suites that trigger multiple times against the SAME identity (e.g. the conformance suite, which calls `factory()` fresh per `it()` but reuses one fixed config for the whole file).

## `packages/plugins/github/src/github.conformance.test.ts`

### §169. Wires this plugin into the executor and discovery suites

Wires `@scp/plugin-github` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` and `DiscoveryPlugin` conformance suites (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests"). The suites themselves live in plugin-testkit and know nothing about GitHub specifics — this file is only the fixture factory, same thin-wiring shape as `fake-executor.conformance.test.ts` / `webhook-control.conformance.test.ts`.

Unlike those two, this plugin makes REAL outbound HTTP calls (`ctx.http` is not a stub), so `github-test-support.ts`'s `createRealHttpClient()` + `nock` fixtures stand in for github.com. The conformance suites call `factory()` fresh per `it()` but exercise trigger/status/abort/ observe/discover in an order this file doesn't control — so the fixtures below are `persist()`ed (reusable across an unpredictable number of matching calls) rather than one-shot, and this file intentionally does NOT assert `nock.isDone()`/exact call counts (that precise, single-call-proof testing lives in `index.test.ts`, matching the repo's "thin conformance fixture" convention — see fake-executor's/webhook-control's own conformance files, neither of which makes assertions beyond wiring the factory).

## `packages/plugins/github/src/index.test.ts`

### §170. `@scp/plugin-github` behavioral test suite

`@scp/plugin-github` behavioral test suite (BUILD_AND_TEST.md §8 M7 item 1's Definition of Done). Every HTTP call is fixtured deterministically with `nock` against Node's `http`/`https` core modules — see `github-test-support.ts`'s module doc for why the `ScopedHttpClient` built for these tests uses `node:https` directly rather than `fetch` (nock@13.5.6, the version this repo pins, does not intercept the global fetch/undici client — verified empirically, not asserted from memory). `nock.disableNetConnect()` is active for the whole file so any call this suite didn't anticipate fails loudly (a rejected promise) instead of silently reaching the real network (CLAUDE.md: "Tests never touch the internet").

Every test that registers a nock interceptor is checked for full consumption by the file-wide `afterEach` below (`nock.pendingMocks()` must be empty) — an unconsumed interceptor means the plugin either didn't make a call it should have, or (for interceptors deliberately NOT registered, e.g. the pagination test's absent "page 2") an accidental extra call would instead surface as a thrown "no match" error from the rejected HTTP promise, not a silently-passing test.

### §171. Shared per-test fixture builder

Shared per-test fixture builder — mirrors `fake-executor`'s/`webhook-control`'s file-local `testCtx()` helper, just extended with the installation-token nock (needed by EVERY test in this file, since every plugin call goes through `getInstallationToken` first) and a ready-made `Bearer <token>` string for asserting downstream API calls carry it. Fresh appId/installationId per call (via `buildGithubConfig`) so the module-level token cache in index.ts never lets one test's cached token silently skip another test's token-exchange assertion.

### §172. Correlation makes three attempts with a real backoff

correlateDispatchedRun makes up to 3 attempts with a real 500ms backoff between them when no match is found — .times(3) so every attempt gets a real (empty) response instead of hitting an unmocked URL. This test genuinely takes ~1s of wall-clock time (two 500ms backoffs); that real-timer cost is accepted here rather than faking timers, since faking setTimeout globally risks interfering with the underlying nock/https socket machinery this test also depends on.

### §173. Deliberately not using setup()'s tokenScope here

Deliberately not using setup()'s tokenScope here: index.ts's trigger() checks `workflowId` BEFORE ever calling api()/getInstallationToken, so no HTTP call (not even the token exchange) should happen. Registering a token-exchange interceptor here would leave it unconsumed and fail via the file-wide afterEach — which is itself a useful check: it would catch a regression that started resolving a token before validating workflowId.

### §174. Two DISTINCT one-shot interceptors per path

Two DISTINCT one-shot interceptors per path (not .times(2) with one shared body): each must resolve on its FIRST poll attempt (a matching run in the very first response) so neither call falls into correlateDispatchedRun's real 500ms-backoff retry loop, AND each must correlate to a DIFFERENT run id so "first.externalId !== second.externalId" is actually proving independence rather than two calls coincidentally matching the same fixture body. nock matches same-path interceptors in registration order, one consumption each.

### §175. These verbs are plain functions closing over module state

@scp/plugin-github's trigger()/status()/abort() are plain functions closing over the module- level `githubExecutorPlugin` object (see index.ts) — there is no per-instance class to `new` up a separate "process B" from, unlike @scp/plugin-fake-executor's FakeExecutorPlugin class. What actually proves restart-safety here is that trigger() calls loadState(statePath) fresh from disk on EVERY invocation (never caching DedupState in memory once statePath is set — see index.ts's loadState/saveState), so two trigger() calls through the SAME plugin reference still faithfully exercise the write-then-re-read-from-disk path a real process restart would take. This test additionally reads the state file directly to prove it's genuinely persisted.

### §176. Base-URL resolution (M15.3b)

Base-URL resolution (M15.3b) — apiBaseUrl → serverUrl (Mode A: import an EXISTING GitHub / GitHub Enterprise, injected as config.serverUrl) → the github.com default. Every request in this block is fixtured ONLY on the host the resolution SHOULD pick; net-connect is disabled, so a request that landed on the wrong host would reject with "no match" rather than pass silently.

### §177. Same census class as `postCommitStatus`'s sha

Same census class as `postCommitStatus`'s sha (see that test) and readFileAtRef's `repo`/`ref` (M21.2 review BLOCKERS 1-2): a non-literal string spliced into a REST route. `externalId` is stored correlation state and numeric in practice, so this encoding is an IDENTITY today and its removal would change no observed behaviour — which is exactly why it is pinned. An unpinned member of a censused class is indistinguishable from an untouched one on the next refactor (CLAUDE.md, "census by property, not by symptom"). Unencoded, `../../../user` re-targets this GET at `https://api.github.com/user` with the binding's installation token, because `new URL()` collapses literal `..` segments; encoded it is `..%2F..%2F..%2Fuser`, ONE segment a URL does not normalize away. The interceptor matches only the encoded form, and `disableNetConnect()` plus the file-wide pending-mocks check make the unencoded form fail loudly rather than pass quietly.

### §178. No retry or backoff in these verbs yet, and why

TODO(M7 follow-up): trigger()/status()/observe()/abort() in index.ts implement NO retry or backoff of their own — every non-2xx response (including 403-with-rate-limit-headers and 429) throws (or, for observe(), is silently skipped for that one resource — see observe()'s `if (status >= 200 && status < 300)` guards, which is a DIFFERENT, more lenient behavior than trigger()/status()'s hard throw). That's a defensible, documented M7 posture: index.ts's module doc explains coordination/reconcile.ts's own retry loop is what re-attempts a failed trigger() on a LATER reconcile tick, so a single call failing fast (rather than blocking on an internal retry/backoff loop) is intentional, not an oversight. These tests assert exactly that documented behavior instead of inventing retry logic index.ts doesn't have.

### §179. Endpoints asserted by reference to the proposed objects

The endpoints must be the ALIASES the proposed objects declare, asserted BY REFERENCE to those objects rather than as a third copy of the literal. Restating the strings would let a plugin change its URN scheme in one of the two places and stay green — and an endpoint that names no proposed object is exactly the 404 (`object '...' not found`) that made this edge unimportable even once its type was right.

### §180. Censused out of the M21.2 review BLOCKERS 1-2

Censused out of the M21.2 review BLOCKERS 1-2 (a caller-supplied string spliced raw into a REST route), not reported against this function: `postCommitStatus` is the only other place in this package that did it. Unencoded, `../../..` here would have re-targeted the POST; the interceptor below only matches the ENCODED single segment, and `nock.disableNetConnect()` plus the file-wide pending-mocks check make the unencoded form fail rather than pass quietly.

### §181. The changed-file set is what routes one repo per directory

`correlation.paths` — the changed-file set, which is what lets ONE repository route to per-directory components. Without it every mapping on a monorepo is necessarily repo-only, they all rank equally, and the oldest wins every event forever (see `correlation.ts`).

The webhook and poll paths obtain it very differently — the push payload carries it inline, while the commits LIST response does not, so polling must fetch each commit individually — which is exactly why both are pinned here.

### §182. The API call throws on a transport failure, not returns

Regression. `api()` THROWS on a transport failure rather than returning a status, so an unguarded fetch aborted `pollCommits` mid-loop and lost the push events entirely — turning a best-effort enrichment into data loss, where the release would never be coordinated at all instead of merely routing by repository. Caught by this suite's `disableNetConnect` when the single-commit interceptor below was first left unregistered.

### §183. The first file-body read in this package

readFileAtRef (M21.2, ADR-0032 §4) — the FIRST file-body read in this package. Every fixture below is GitHub's real documented contents/commits response shape: the contents response for a blob carries `type: "file"`, `encoding: "base64"`, `size`, `content` (base64 WRAPPED AT 60 CHARS WITH NEWLINES — the fixtures wrap it, because that is what GitHub actually sends and an implementation that measured the unstripped string would mis-size every real payload) and `sha` (the BLOB sha); a directory comes back from the SAME route as a JSON array.

Note the two-call shape being asserted: resolve `ref` -> commit sha, then read the blob AT THAT SHA. The second interceptor matching on `?ref=<the sha from the first response>` is what proves the pin actually happens — if the adapter read at the branch name instead, that interceptor never matches and the file-wide `afterEach` fails on the unconsumed mock.

### §184. Both strings above are already safe; this one is not

The nested-path test above pins per-segment vs whole encoding, but both of its strings are already URL-identity, so deleting the encoding entirely leaves it green (measured). `#` is the case where the encoding is load-bearing rather than decorative: `git check-ref-format` permits it in a ref and it is legal in a filename, so neither `assertSafeRef` nor `assertSafeRepoPath` refuses it — but unencoded it ends the URL, so step 1 would request `/commits/release/` and step 2 `/contents/docs/` (each a DIRECTORY listing, i.e. a wrong answer rather than an error). Both interpolations of this call are therefore pinned here.

### §185. THE TRANSPORT bound (M21.2 review MAJOR 5, closed)

THE TRANSPORT bound (M21.2 review MAJOR 5, closed) — a SEPARATE, larger ceiling from the decode-bound `too_large` refusals above. GitHub is incidentally bounded by its OWN `encoding: "none"` cutoff above 1MB (the very next test), but this adapter now sends an explicit transport ceiling on every call regardless — defense in depth, not a dependency on that provider behavior.

### §186. The detail assertion is what makes this about the array

The `detail` assertion is what makes this test about the ARRAY branch. `reason` alone does not: with the `Array.isArray` branch deleted the same input still yields not_a_file via the type gate, because `[].type` is undefined — so both gates were individually mutation- survivable and this one test covered neither (verified by mutation, M21.2 review MAJOR 4). The entry COUNT is asserted for the same reason: it can only come from the array branch.

### §187. ADVERSARIAL `ref` and `repo`

ADVERSARIAL `ref` and `repo` (M21.2 review, BLOCKERS 1 and 2). Both were REACHABLE: `ref` was only percent-encoded per segment, and `encodeURIComponent("..") === ".."`; `repo` was spliced in raw — neither validated nor encoded. Each test below is a NEGATIVE CONTROL in the strongest available sense: `nock.disableNetConnect()` is on for the whole file and NO interceptor is registered, so if the refusal ever stops happening pre-flight the adapter's request escapes as a "no match for request" rejection with a URL in it — which is exactly what these assert against, since the message is asserted, not merely the fact of a throw.

### §188. The two `not_a_file` gates, pinned INDEPENDENTLY

The two `not_a_file` gates, pinned INDEPENDENTLY (M21.2 review, MAJORS 3 and 4). They are separate branches over the same route: a directory arrives as an ARRAY, a symlink/submodule as an OBJECT with a non-`file` `type`. Asserting only `reason: "not_a_file"` covers neither — deleting the array branch still yields not_a_file via the type gate (`[].type` is undefined), and deleting the type gate leaves a symlink decoding to `content: ""`, i.e. a silently EMPTY manifest that downstream reads as "this component declares no dependencies". The `detail` string is the only thing that separates them, so both tests assert it — the same technique the `encoding: "none"` test above already uses.

### §189. readFilesAtRef (team-pipeline-iac proposal §12)

readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. GitHub's recursive tree listing (`GET .../git/trees/{sha}?recursive=1`) is one response, `truncated: true` when it hit GitHub's own ceiling.

### §190. THIS ADAPTER WRITES NOTHING

THIS ADAPTER WRITES NOTHING (owner decision 2026-08-15; ADR-0032 §9)
ADR-0032 §9 admits `GitProviderAdapter` as an escape hatch on two grounds — the `ExecutorPlugin` object is unchanged, and "It also only READS." M21.5 briefly grew branch/commit/pull-request hooks on all three providers, which contradicts the second ground. The repository-write authority now lives inside the enumerated `scp-managed-dep` class (`packages/plugins/managed-dep`), where the charter's containment preconditions bind.

`@scp/git-provider-core`'s own suite pins the INTERFACE at the type level. This pins the OBJECT, here, because the interface is structural: an adapter carrying extra write methods still satisfies it, so the type-level pin alone would not notice a hook re-added to this file. Asserted per provider rather than once, because the hooks existed on all three — the census is the point (CLAUDE.md: fix the property, then find every place with it).

## `packages/plugins/github/src/index.ts`

### §191. The GitHub App executor and discovery plugin

`@scp/plugin-github` — the GitHub App `ExecutorPlugin` + `DiscoveryPlugin` (DESIGN.md §12, BUILD_AND_TEST.md §8 M7 item 1): "the primary Discovery source... Auth: GitHub App, org- installable, fine-grained permissions. Observe (push): webhooks. Observe (pull): polling fallback. Trigger: workflow_dispatch/repository_dispatch of the org's OWN workflows. Status: check runs + workflow conclusions. Discovery: repo/topology scan."

ARCHITECTURE (M15.1a, ADR-0014): this package is a **thin GitHub ADAPTER** over the provider- neutral `@scp/git-provider-core`. Everything provider-neutral (the idempotency/dedup cache, the observe cursor protocol, correlation-hint normalization, the dispatch-then-persist trigger dance, the `ExecutorPlugin` assembly) lives in the core; everything GitHub-specific (App-JWT→installation -token auth, the base URL + REST wrapper, workflow_dispatch/repository_dispatch, X-Hub-Signature- 256 webhook verification, GitHub event→hint mapping, the status/conclusion→phase map, the `"github"` source_kind) lives here as a `GitProviderAdapter`. This package's EXTERNAL contract is unchanged by the extraction: same `github`/`github-discovery` modules, same config schema, same verbs, same observable behavior — proven by this package's unchanged `nock` suite.

HONEST COVERAGE NOTE: every request/response shape below is exercised deterministically against `nock` fixtures built from GitHub's published REST API docs — this package never talks to a real github.com in its own test suite. The opt-in nightly live-sandbox job (a real GitHub App installed against a real org) is what proves wire-format fidelity end to end; this PR's body states that split explicitly.

GITHUB API LIMITATION, DOCUMENTED (shapes this file's idempotency design): `workflow_dispatch`/`repository_dispatch` return **204 No Content** — GitHub's API gives no run id back synchronously, and a dispatched run carries no server-assigned field this plugin could later use to prove "this run came from THIS dispatch call" (the workflow's own `client_payload`/ `inputs` aren't queryable via the runs-list API). This plugin's `trigger()` therefore: (1) dedups on `idempotencyKey` FIRST, against its own persisted cache — so a retry never even calls GitHub twice; (2) only for a genuinely NEW key, dispatches, then polls the workflow-runs list for the newest run created after the dispatch call and adopts it as the correlated run. Under concurrent dispatches of the SAME workflow this correlation step has a real, small race window — a known, honest limitation of GitHub's public API surface, not something this plugin can close unilaterally. The idempotency cache (file-backed when `ctx.config.statePath` is set, same write-to-temp+rename pattern as `@scp/plugin-fake-executor`/`@scp/plugin-argocd`) is what makes step (1) — the part `coordination/reconcile.ts`'s crash-safe retry actually depends on — solid regardless.

### §192. The response ceiling defaults so every call is bounded

`maxResponseBytes` defaults to `DEFAULT_API_RESPONSE_MAX_BYTES` — bounding EVERY call through this function, not just `readFileAtRef`'s (M21.2 review MAJOR 5's fix, applied to the one funnel every GitHub REST call in this adapter goes through). `readGet`'s contents fetch overrides it with the tighter, decode-bound-derived ceiling from `resolveMaxResponseBytes`.

### §193. Webhook signature verification

Webhook signature verification (fail-closed) + push/poll-equivalent event mapping — exported so apps/server's change-sources webhook route can verify+parse GitHub deliveries with this exact package, and so `observe()`'s polling fallback produces STRUCTURALLY equivalent ExecutorEvents to what the webhook path produces for the same underlying activity (BUILD_AND_TEST.md §8 M7 DoD: "poll-vs-push equivalence").

### §194. GitHub signs deliveries as a prefixed hex HMAC

GitHub signs webhook deliveries as `sha256=<hex hmac>` over the RAW request body (`X-Hub-Signature-256`). Verification MUST run against the raw bytes, not a re-serialized JSON.parse/stringify round trip (whitespace/key-order differences would break the HMAC) — the caller (routes/change-sources.ts) is responsible for capturing the raw body before Fastify's JSON parser touches it. `timingSafeEqual` throws if the two buffers differ in length, which we treat the same as "signature mismatch" rather than letting it escape as an unhandled error — fail-closed either way.

### §195. THE SOURCE BRANCH, under its own name

THE SOURCE BRANCH, under its own name — NOT `ref`. GitHub spells a pull request's head branch unqualified (`scp/dep-bump/<id>`), so it is qualified here to the one spelling every consumer of a ref in this tree uses. It is deliberately not `ref`: a `refPattern` source mapping matches `ref`, and populating it here would start routing pull-request events by their head branch in every existing deployment. See `GitProviderEventHint.headRef` for the one consumer and the duplicate change its absence produced.

### §196. The commits LIST response carries no `files`

The commits LIST response carries no `files` (GitHub only returns them on the single-commit resource), so poll-vs-push equivalence for `paths` costs one extra GET per commit. Budgeted rather than unbounded: a repo that lands a large backlog between polls must not turn one observe tick into hundreds of API calls. Commits past the budget still produce an event — just without `paths`, so they route by the repo-only mappings exactly as before.

### §197. Page size and per-poll page ceiling for the two lists

Page size and per-poll page ceiling for the two LIST resources `observe()` polls.

Both used to read whatever GitHub's default page held (30, newest-first) and stop. Anything older than that page — a release train that lands 40 commits between two observe ticks, a busy monorepo's workflow runs — was not "deferred to the next poll", it was gone: the cursor advances to the newest entry seen, so the events beneath the page boundary were never correlated at all.

Bounded rather than "follow rel=next to the end", in the same spirit as `MAX_COMMIT_FILE_FETCHES_PER_POLL`: paginating an active repo without a ceiling turns one observe tick into an unbounded API spend and a rate-limit outage. Five pages of 100 covers ~16x the old window; past it the same truncation as before applies, which is the accepted (and now substantially rarer) risk.

A COLD START (no watermark) deliberately reads ONE page. There is no window to catch up on then — only "how much history do we invent events for" — and inventing 500 is not better than 100.

POLL_PAGE_SIZE is what we ASK for, never what we get: a list endpoint may serve fewer per page than requested (github.com honours 100, but a self-hosted/proxied instance need not — Gitea's `MAX_RESPONSE_ITEMS` clamp is the concrete case, see that adapter). Ending on a page shorter than the REQUESTED size would then stop on page 1 and silently drop the rest, so each loop learns the SERVED page size from page 1 and ends on a page shorter than that (or empty, or at the budget).

### §198. The changed-file set of one commit, via a single resource

The changed-file set of ONE commit, via the single-commit resource (the only GitHub endpoint that returns `files`). Best-effort by design: a non-2xx or unexpected shape yields `undefined` rather than throwing, matching `pollCommits`' documented lenient observe posture.

**Known limit, and it is a silent one.** GitHub caps this response at 300 files and does not paginate them here, so a commit touching more than 300 files yields a TRUNCATED set. A path-scoped mapping whose directory fell outside the truncation will not match, and the event then routes by whatever repo-only mapping wins — i.e. it degrades to the pre-existing behaviour rather than failing loudly. Acceptable because such commits are rare in a GitOps repo (the case this exists for), but it is a real hole and should not be discovered later as a surprise.

### §199. Must swallow: the API call throws on a transport failure

MUST swallow. `api()` THROWS on a transport failure (blocked host, DNS, connection reset) — only a non-2xx comes back as a status. Letting that escape would abort `pollCommits` mid-loop and lose the push events themselves, turning a best-effort enrichment into data loss: the release would never be coordinated at all, rather than merely routing by repo instead of by directory. Degrading to `undefined` is the whole point of this being an enrichment.

### §200. Polls for the newest run created at or after dispatch

Polls the runs list for the newest run of `workflowId` created at/after `dispatchedAtMs` — the correlation step the module doc's GitHub API limitation note describes. Bounded retries (not an unbounded poll loop): GitHub typically materializes a run within a couple seconds of dispatch, and `coordination/reconcile.ts`'s own `status()` polling will keep checking on later reconcile ticks regardless — this only needs to succeed EVENTUALLY, not synchronously within `trigger()`'s own call budget, so a modest bounded attempt count here is a latency optimization, not a correctness requirement (a `trigger()` that returns with `externalId` still "pending correlation" is handled by returning a synthetic ref keyed on the idempotencyKey itself when correlation hasn't resolved yet — `status()` then re-attempts correlation on the next poll).

### §201. Adapter `triggerCI` hook

Adapter `triggerCI` hook — fires GitHub's own automation and returns a run ref, INCLUDING the GitHub-specific correlation step (dispatch returns 204 with no run id, so poll the runs list for the newest matching run). The idempotency dedup + persistence that wraps this call lives in `@scp/git-provider-core`; this hook is only ever called for a genuinely new key, so it never reads/writes the dedup cache itself. `markerKey` is the opaque suffix for an uncorrelated ref (repository_dispatch, or a workflow_dispatch whose run hasn't materialized yet) — derived from the same `idempotencyKey` the core dedups on when one is present.

### §202. readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a))

readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a)) — the FIRST time this package reads a file BODY out of a repo. `discover()` below calls the same contents endpoint but reads only `entry.name`/`entry.type` off a DIRECTORY LISTING (see line ~758 and the marker-file test); it never fetches or decodes a blob. This is that missing capability, and nothing more: it reads.

GITHUB WIRE FACTS THIS DEPENDS ON (all from GitHub's published REST docs; like every other shape in this file they are proven here only against `nock` fixtures — the nightly live-sandbox job is what proves wire fidelity end to end): - `GET /repos/{owner}/{repo}/commits/{ref}` accepts a branch, tag or sha as `{ref}` and returns the commit object whose `sha` is what that ref RESOLVES TO. - `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` returns, for a blob, an object with `type: "file"`, `encoding: "base64"`, `size`, `content` (base64 WRAPPED AT 60 CHARS WITH EMBEDDED NEWLINES — `base64DecodedByteLength` strips whitespace for exactly this reason) and `sha` (the BLOB sha, NOT a commit sha — hence the separate resolve call above). For a DIRECTORY the same route returns a JSON ARRAY, which is how `not_a_file` is detected. - For a blob between 1 MB and 100 MB the same object comes back with `content: ""` and `encoding: "none"`; `decodeBoundedBase64` maps that to a `too_large` refusal because that is what GitHub means by it.

### §203. One authenticated GET, with both failure modes folded in

A single authenticated GET on the read path, with the two failure modes the plugin HTTP client makes non-obvious folded in:

- a 3xx that arrives as a STATUS is refused by `assertNoRedirect` with an explanation, rather than falling through as an anonymous "HTTP 302"; - anything thrown by `ctx.http.request` — including a refused redirect under the production client (`redirect: "error"`, subprocess-entry.ts:285,295) and an egress-guard denial (`egressBlocked`, egress-guard.ts:83) — is re-thrown by `wrapProviderRequestError` naming which of those it was. Neither weakens any control; both make the failure legible.

### §204. The TRANSPORT ceiling passed to every HTTP call this flow makes

The TRANSPORT ceiling passed to every HTTP call this flow makes (M21.2 review MAJOR 5) — see `resolveMaxResponseBytes`'s doc for why it is derived from `maxBytes` rather than a flat constant. Applied to the ref-resolution call too, not just the contents fetch: harmless (that response is tiny) and simpler than threading two different bounds through one flow. GitHub's contents API is incidentally bounded already (`encoding: "none"` above 1MB) but this makes the bound explicit rather than relying on that provider behavior.

### §205. All three caller-supplied strings are asserted before HTTP

All THREE caller-supplied strings that reach a route are asserted before any HTTP happens. `repo` and `ref` are not decoration: `encodeURIComponent("..")` is `".."`, so encoding alone let a ref of `../../../../user` reach `GET https://api.github.com/user` with this binding's installation token, and a raw `repo` of `acme/widgets?x=` terminated the route at the query string. See `assertSafeRef`/`assertSafeRepo` in `@scp/git-provider-core` for the full case.

### §206. `repo` reaches the routes below UNENCODED, deliberately

`repo` reaches the routes below UNENCODED, deliberately. It used to be wrapped in `encodePathSegments`, which `assertSafeRepo`'s charset makes a provable IDENTITY (`REPO_SEGMENT` is `[A-Za-z0-9._-]`, every character URL-unreserved) — a call that READ as the control while the assert above was the entire control, and that no test could tell apart from its own deletion. The coupling it claimed to defend (a later relaxation of `REPO_SEGMENT` letting an un-encoded repo reach a URL) is now pinned where that charset actually lives: git-provider-core's read-file.test.ts "every character assertSafeRepo accepts is URL-identity" test FAILS the moment the charset admits anything needing an escape. `path` and `ref` below still encode for real — their charsets legitimately contain characters that must be escaped (a space in a path, for instance).

### §207. Resolve the ref to a sha, then read at that sha

STEP 1 resolves the ref to a commit sha; STEP 2 reads at that SHA rather than at the ref again — the two-call shape is forced (GitHub's contents response carries a blob sha, never a commit sha), but reading at the resolved sha is a deliberate choice on top of it: a branch can move between the two calls, and an inventory row that says "read at commit X" must be true of the bytes actually parsed.

### §208. readFilesAtRef (team-pipeline-iac proposal §12)

readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. GitHub's Trees API returns EVERY entry in ONE response (`recursive=1`, no page/per_page for that mode), capped at GitHub's own internal ceiling (100,000 entries / 7MB) and flagged `truncated: true` if it hit that ceiling — there is no follow-up page to ask for, so a truncated response is refused here as `maxEntriesScanned` rather than silently matching only what arrived.

### §209. The GitHub `GitProviderAdapter`

The GitHub `GitProviderAdapter` — every GitHub-wire-specific hook the provider-neutral `@scp/git-provider-core` needs. The executor factory consumes `resolveStatePath`/`triggerCI`/ `pollCommits`/`pollRuns`/`getStatus`/`abortRun`/`capabilities`; `authorize`/`baseUrl` back this adapter's own REST calls (`api()`), `verifyWebhook`/`mapEvent` back the server webhook path, `mapStatusToPhase` backs `getStatus`, and `readFileAtRef` backs ADR-0032's manifest ingestion (adapter-only — the factory never turns it into a fifth executor verb).

### §210. Status reporting, so a repo can gate on our coordination

Status reporting (DESIGN §12: "SCP posts a commit status/check so repos can make SCP coordination a branch-protection gate"). Not part of the ExecutorPlugin verb set (there is no generic "report back" verb — DESIGN §11's four verbs are it) — exposed as a plain function any server-side caller with a github plugin instance's `ctx` can invoke directly. NOT YET WIRED into `governance/gate-orchestrator.ts`'s decision path in this milestone (flagged, same "deferred but present and tested" posture as federation-https's mTLS cert injection in M6) — the function itself is implemented and unit-tested against nock fixtures; threading it into every gate verdict generically (across every executor, not just github) is left as documented follow-up.

### §211. Discovery: a repo scan proposing service and component objects

DiscoveryPlugin (DESIGN §11/§12 — "repo/topology scan proposing Service/Component objects and source_mappings"; NEVER auto-commits, only proposes). `DiscoveryProposal` (plugin-api) carries objects+relationships; a `component` object's `properties.sourceMapping` carries the {repoPattern, pathPattern} the server-side "discovery accept" route turns into a real `source_mappings` row ONLY on explicit operator acceptance (routes/discovery.ts, server-side).

## `packages/plugins/github/vitest.config.ts`

### §212. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §213. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/gitlab/src/gitlab-test-support.ts`

### §214. Test-only support, not part of this package's surface

Test-only support shared by `gitlab.conformance.test.ts` and `index.test.ts`. NOT part of this package's public surface. Mirrors `@scp/plugin-gitea`'s `gitea-test-support.ts` — the same empirically-verified reason applies: `nock@13` does NOT intercept the global `fetch`/undici client, only Node's `http`/`https` core modules, so the `ScopedHttpClient` built here uses `node:https`/`node:http` directly (never `fetch`) — otherwise every `nock` fixture in this package's suite would be silently defeated (CLAUDE.md: "Tests never touch the internet").

### §215. An HTTP client backed by Node's core modules

Builds a `ScopedHttpClient` backed by Node's `http`/`https` core modules — see module doc for why this, and not `fetch`, is what makes `nock` fixtures actually apply.

Honors `ScopedHttpRequest.maxResponseBytes` the SAME way the production client (`apps/server/src/plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient`) does — bound checked DURING accumulation, in the `data` handler itself, not after `end` — so this package's own bound tests exercise the real transport-level enforcement over a real (loopback) HTTP connection, not a mock of it. `res.destroy()` on the incoming message aborts the read at the socket the moment the bound trips, mirroring the production client's `reader.cancel()`.

## `packages/plugins/gitlab/src/gitlab.conformance.test.ts`

### §216. Wires this plugin into the executor and discovery suites

Wires `@scp/plugin-gitlab` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` + `DiscoveryPlugin` conformance suites (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant plugin-testkit suite"). Same thin-fixture shape as `gitea.conformance.test.ts`: this plugin makes REAL outbound HTTP calls (`ctx.http` is not a stub), so `gitlab-test-support.ts`'s `createRealHttpClient()` + `nock` fixtures stand in for a GitLab instance. Fixtures are `persist()`ed (the suite calls each verb an unpredictable number of times) and this file deliberately does NOT assert `nock.isDone()` — that precise single-call proof lives in `index.test.ts`.

## `packages/plugins/gitlab/src/index.test.ts`

### §217. `@scp/plugin-gitlab` behavioral test suite

`@scp/plugin-gitlab` behavioral test suite (M15.3b). Every HTTP call is fixtured deterministically with `nock` against Node's `http`/`https` core modules (see `gitlab-test-support.ts`'s module doc for why the `ScopedHttpClient` uses `node:https` directly, not `fetch`). `nock.disableNetConnect()` is active file-wide so any unanticipated call fails loudly rather than reaching the real network (CLAUDE.md: "Tests never touch the internet"). Each test's interceptors are checked for full consumption by the file-wide `afterEach` (`nock.pendingMocks()` must be empty).

These assert REAL GitLab wire shapes, not tautologies: the auth header is `PRIVATE-TOKEN: <PAT>` (NOT github's Bearer, NOT gitea's `token`), the base is `/api/v4`, the project id is the URL-encoded `owner%2Frepo`, create-pipeline returns the pipeline object (with its id) SYNCHRONOUSLY (no dispatch-then-poll dance), status is a single GitLab enum, and the webhook is authenticated by a PLAINTEXT `X-Gitlab-Token` shared secret (NOT an HMAC signature).

### §218. Same census class as readFileAtRef's `repo`/`ref`

Same census class as readFileAtRef's `repo`/`ref` (M21.2 review BLOCKERS 1-2) and github's `postCommitStatus` sha: a non-literal string spliced into a REST route. `externalId` is stored correlation state and numeric in practice, so this encoding is an IDENTITY today and its removal would change no observed behaviour — which is exactly why it is pinned. An unpinned member of a censused class is indistinguishable from an untouched one on the next refactor (CLAUDE.md, "census by property, not by symptom"). Unencoded, `../../../user` re-targets this GET at `<base>/user` because `new URL()` collapses literal `..` segments; encoded it is `..%2F..%2F..%2Fuser`, ONE segment a URL does not normalize away. The interceptor matches only the encoded form, and `disableNetConnect()` plus the file-wide pending-mocks check make the unencoded form fail loudly rather than pass quietly.

### §219. discover() (DiscoveryPlugin) — GitLab repository-tree topology walk

discover() (DiscoveryPlugin) — GitLab repository-tree topology walk. The `sourceKind: 'gitlab'` on the proposed component's sourceMapping is the load-bearing assertion (matches the executor's source_kind so imported components correlate observed gitlab events).

### §220. Endpoints asserted by reference to the proposed objects

The endpoints must be the ALIASES the proposed objects declare, asserted BY REFERENCE to those objects rather than as a third copy of the literal. Restating the strings would let a plugin change its URN scheme in one of the two places and stay green — and an endpoint that names no proposed object is exactly the 404 (`object '...' not found`) that made this edge unimportable even once its type was right.

### §221. The first file-body read in this package

readFileAtRef (M21.2, ADR-0032 §4) — the first file-body read in this package, and the one place where GitLab is genuinely NOT github/gitea-compatible. Three differences are asserted directly:

```text
1. a different endpoint — `GET /projects/:id/repository/files/:file_path?ref=`, not `contents/`;
2. WHOLE-string path encoding (`services%2Fapi%2Fgo.mod`), not per-segment — a per-segment
   encoding produces a different (non-existent) route, so the nested-path test below is the
   proof, not decoration;
3. ONE call, not two — `commit_id` in the same response IS the resolved commit, so no separate
   ref-resolution request is made (asserted by nock consuming exactly one interceptor).
```

Field names are GitLab's documented repository-file response.

### §222. The interpolations are pinned above; this adds the rest

The `repo` and `path` interpolations are already pinned by the two tests above (a `%2F` in either changes the route). `ref` is the third, and it needed a character where the encoding is load-bearing rather than identity: `git check-ref-format` permits `#` in a ref name, so `assertSafeRef` does not refuse it, but unencoded it ends the URL — `?ref=release/#42` would reach GitLab as `ref=release/` and resolve a DIFFERENT commit (a wrong answer, not an error).

### §223. THE TRANSPORT bound (M21.2 review MAJOR 5, closed)

THE TRANSPORT bound (M21.2 review MAJOR 5, closed) — a SEPARATE, larger ceiling from the decode-bound `too_large` refusals above. GitLab was the provider with the CLEAREST exposure: no `encoding: "none"` cutoff of any kind, arbitrarily large blobs served inline as base64.

### §224. ADVERSARIAL `ref` and `repo`

ADVERSARIAL `ref` and `repo` (M21.2 review, BLOCKERS 1 and 2). This adapter is the one that already ENCODED both — into a single whole-encoded route parameter and a query value — so neither was exploitable here, which is precisely why it needs the tests: the refusal is now a shared rule across all three providers, and "gitlab happened to encode" is an implementation detail a later refactor (e.g. adopting the two-call resolve shape) would silently take away. These pin the RULE, not the encoding.

### §225. readFilesAtRef (team-pipeline-iac proposal §12)

readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads. GitLab is the one provider that genuinely PAGINATES its tree listing (`repository/tree?recursive=true`, standard `per_page`/`page`) and carries no commit identity in that listing, so this resolves `ref` to a commit sha FIRST via `repository/commits/:sha_or_ref`.

### §226. THIS ADAPTER WRITES NOTHING

THIS ADAPTER WRITES NOTHING (owner decision 2026-08-15; ADR-0032 §9)
ADR-0032 §9 admits `GitProviderAdapter` as an escape hatch on two grounds — the `ExecutorPlugin` object is unchanged, and "It also only READS." M21.5 briefly grew branch/commit/pull-request hooks on all three providers, which contradicts the second ground. The repository-write authority now lives inside the enumerated `scp-managed-dep` class (`packages/plugins/managed-dep`), where the charter's containment preconditions bind.

`@scp/git-provider-core`'s own suite pins the INTERFACE at the type level. This pins the OBJECT, here, because the interface is structural: an adapter carrying extra write methods still satisfies it, so the type-level pin alone would not notice a hook re-added to this file. Asserted per provider rather than once, because the hooks existed on all three — the census is the point (CLAUDE.md: fix the property, then find every place with it).

## `packages/plugins/gitlab/src/index.ts`

### §227. The GitLab executor and discovery plugin

`@scp/plugin-gitlab` — the GitLab `ExecutorPlugin` + `DiscoveryPlugin` (M15.3b, the third git provider after github and gitea). Like both, this is a **thin GitLab ADAPTER** over the same provider-neutral `@scp/git-provider-core`: everything provider-neutral (idempotency/dedup cache, observe cursor protocol, correlation-hint normalization, the `ExecutorPlugin` assembly) lives in the core; everything GitLab-wire-specific lives here as a `GitProviderAdapter`. The gitea adapter (`@scp/plugin-gitea`) is the closest reference — GitLab, like Gitea, is commonly SELF-HOSTED, so it reuses the shared `serverUrl` base-URL fallback so a Mode-A "import an EXISTING GitLab" binding reaches it.

GITLAB-SPECIFIC WIRE FACTS (how this differs from github/gitea — the reason a separate adapter exists rather than reusing either): - AUTH is a Personal Access Token sent `PRIVATE-TOKEN: <PAT>` — NOT github's App-JWT, NOT a `Bearer`/`token` scheme. (GitLab's own documented header for PAT auth.) The token is resolved via `ctx.secrets.get(tokenSecretKey)`. - BASE REST URL is `<instance>/api/v4` (a self-hosted instance host; GitLab.com is just one such host, `https://gitlab.com`). No fixed default — same as gitea, unlike github. - PROJECT ADDRESSING keys on a project id: the GitLab REST API accepts the URL-ENCODED project path (`owner%2Frepo`) as the `:id` path segment. Config accepts either an explicit `projectPath` or `owner`+`repo` (joined to `owner/repo`); `encodeURIComponent` produces the `:id`. - triggerCI CREATES A PIPELINE via `POST /projects/:id/pipeline` and — UNLIKE github/gitea's dispatch-204-then-poll-the-runs-list-to-correlate dance — GitLab returns the created pipeline object (with its `id`) SYNCHRONOUSLY, so `triggerCI` returns the `ExternalRunRef` DIRECTLY off that response. The core lets the adapter OWN `triggerCI`, so this simply skips the poll. - STATUS is a single pipeline `status` enum (`created|waiting_for_resource|preparing|pending| running|success|failed|canceled|skipped|manual|scheduled`) — `mapGitlabStatusToPhase` folds it to an `ExecutionPhase`. abort is `POST /projects/:id/pipelines/:pipeline_id/cancel`. - WEBHOOKS carry `X-Gitlab-Token: <secret>` as a PLAINTEXT shared-secret token — NOT an HMAC signature (github's `sha256=<hex>`, gitea's bare-hex). So `verifyGitlabWebhookToken` does a TIMING-SAFE PLAINTEXT EQUALITY compare of the header against the configured secret; it never hashes the body. The event name arrives in `X-Gitlab-Event` (`Push Hook`|`Merge Request Hook`| `Pipeline Hook`|`Tag Push Hook`|…) and GitLab payload field paths differ (`object_kind`, `project.path_with_namespace`, `checkout_sha`, `object_attributes.*`).

LOAD-BEARING ASSUMPTIONS — CONFIRM WITH A LIVE DRILL (honest coverage note, same split gitea's package documents): every request/response shape below is exercised deterministically against `nock` fixtures built from GitLab's PUBLISHED REST API docs — this package never talks to a real GitLab in its own suite. The auth header (`PRIVATE-TOKEN`), `/api/v4` base, the URL-encoded `owner%2Frepo` project id, the create-pipeline synchronous-object return, the single pipeline `status` enum, the `X-Gitlab-Token` PLAINTEXT-token webhook scheme, and the `repository/tree` + `repository/commits` + `pipelines` list shapes are all from GitLab's documented, stable API. The shapes marked `ASSUMED (GitLab)` inline are the ones whose exact field NAMES are the most version/edition-dependent and MUST be confirmed against a real running GitLab before this executor is trusted in production — specifically the pipeline-webhook `object_attributes` field names and the merge-request webhook `last_commit`/`iid` paths. Nothing here is fabricated; where a shape is uncertain it is flagged as an assumption rather than invented.

### §228. The response ceiling defaults so every call is bounded

`maxResponseBytes` defaults to `DEFAULT_API_RESPONSE_MAX_BYTES` — bounding EVERY call through this function, not just `readFileAtRef`'s (M21.2 review MAJOR 5's fix, applied to the one funnel every GitLab REST call in this adapter goes through). `readGet`'s file fetch overrides it with the tighter, decode-bound-derived ceiling from `resolveMaxResponseBytes`.

### §229. GitLab authenticates with a plaintext shared-secret token

GitLab authenticates webhook deliveries with a PLAINTEXT shared-secret TOKEN carried verbatim in the `X-Gitlab-Token` header — NOT an HMAC signature over the body (github's `sha256=<hex>`, gitea's bare-hex). So verification is a TIMING-SAFE PLAINTEXT EQUALITY compare of the header against the configured secret; the raw body is NOT hashed and plays no part (it is accepted only to satisfy the shared `verifyWebhook(rawBody, header, secret)` adapter shape). `timingSafeEqual` throws on a length mismatch, which we guard against and treat as "no match" — fail-closed either way. A missing header is rejected.

### §230. Maps a GitLab webhook event name

Maps a GitLab webhook event name (the `X-Gitlab-Event` header value) + payload to a correlation hint (null = ignore). GitLab payload paths differ from github/gitea: the project's full path is `project.path_with_namespace`, a push carries `checkout_sha` + `ref`, and MR/pipeline events nest their fields under `object_attributes`. Only the events a `source_mappings` correlation cares about are recognized; anything else yields `null` (ignored, not an error).

### §231. A GitLab pipeline, as the three endpoints return it

A GitLab pipeline as returned by create-pipeline / single-pipeline / pipelines-list. The load-bearing fields this adapter reads are `id`, `status`, `sha`, `ref`, `web_url`, and a timestamp (`created_at`/`updated_at`). GitLab's pipeline `status` is a SINGLE enum (no separate conclusion), documented + stable.

### §232. Page size and per-poll page ceiling for the polls

Page size and per-poll page ceiling for the list resources `observe()` polls, mirroring the github adapter's constants of the same name (the defect and its bound are identical; each adapter keeps its own copy because the query parameter NAMES differ per provider).

POLL_PAGE_SIZE is what we ASK for, never what we get: GitLab clamps every list to the instance's `max_page_size` application setting, so a hardened instance answers `per_page=100` with fewer. Ending on a page shorter than the REQUESTED size would then stop on page 1 and silently drop the rest — the defect pagination was added to close — so each loop learns the SERVED page size from page 1 and ends on a page shorter than that (or empty, or at the budget).

### §233. readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a))

readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a)) — reading a file BODY. `discover()` below walks `repository/tree` and reads only `name`/`type`; it never fetches a blob.

GITLAB IS THE ONE THAT IS *NOT* GITHUB-COMPATIBLE HERE. Three concrete differences, each of which would be a bug if this had been copied from the github/gitea adapters:

1. DIFFERENT ENDPOINT. There is no `contents/` route. The file lives at `GET /api/v4/projects/:id/repository/files/:file_path?ref=:ref`, returning `{ file_name, file_path, size, encoding: "base64", content, content_sha256, ref, blob_id, commit_id, last_commit_id, execute_filemode }`. 2. DIFFERENT PATH ENCODING. `:file_path` is a SINGLE route parameter, so it must be encoded WHOLE with slashes turned into `%2F` (`encodeURIComponent`) — NOT per-segment like github's and gitea's routes. This is why the core's `encodePathSegments` is deliberately unused here; using it would produce `repository/files/svc/api/go.mod`, which GitLab reads as a different (non-existent) route rather than as a nested file. 3. ONE CALL, NOT TWO. `commit_id` in that same response IS the commit the ref resolved to, so GitLab needs no separate resolve step — and, unlike the two-call providers, there is no branch-moves-between-calls window to close at all.

One consequence of (3) is that a 404 covers both "no such file" and "no such ref/project", and GitLab distinguishes them ONLY in a human-readable `message` ("404 File Not Found" vs "404 Commit Not Found"). That message is not a structured discriminator, and a label derived from prose goes false the moment the prose changes — the provenance-label lesson — so this reports `missing: "unknown"` and carries GitLab's own message through in `detail` rather than inferring.

### §234. One authenticated GET, with the same two failure modes

A single authenticated GET on the read path, with the same two folded-in failure modes as the github/gitea adapters: a 3xx arriving as a STATUS is refused with an explanation by `assertNoRedirect`, and anything thrown by `ctx.http.request` is re-thrown by `wrapProviderRequestError` naming whether it was a refused redirect (`redirect: "error"`, subprocess-entry.ts:285,295) or an egress-guard denial. As with gitea, the egress case is the live one — a self-hosted GitLab at a private address is blocked for every tenant-configurable plugin (subprocess-entry.ts:210-215) and this only explains that, never relaxes it.

### §235. The single-call read shared by `readFileAtRef`

The single-call read shared by `readFileAtRef` (`refQuery` = the caller's own `ref`) and `readFilesAtRef` (`refQuery` = an already-resolved commit sha, `requestedRef` = the ORIGINAL `ref` the caller asked for — see `resolveGitlabRefToCommit` for why the batch path resolves once and pins every file read to that one commit, the same discipline github/gitea's two-step flow already has and gitlab's own single-call `readFileAtRef` does not need for ONE file).

### §236. readFilesAtRef (team-pipeline-iac proposal §12)

readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads.

GITLAB IS THE ONE PROVIDER THAT GENUINELY PAGINATES HERE. Unlike github/gitea's recursive tree call (one response, `truncated: true` past an internal ceiling, no `page` parameter for that mode), GitLab's `repository/tree?recursive=true` is standard GitLab REST pagination (`per_page`/`page`, a short/empty page means "done") — so this is the one adapter whose `maxEntriesScanned` bound is enforced across MULTIPLE round trips, not inside one already- arrived response. Each page is still transport-bounded (`DEFAULT_TREE_RESPONSE_MAX_BYTES`), and `createTreeScanAccumulator.addPage` is called once per page — a repo whose match set is decided long before its last page is never walked to completion, because `addPage` throws the instant either bound is exceeded and the loop below never issues the next page's request.

GitLab's tree listing also carries no commit identity (unlike a single `readFileAtRef` call, whose ONE response includes `commit_id`), so this resolves `ref` to a commit sha FIRST (the same two-step shape github/gitea already have) and reads every matched file at that pinned commit sha — ADR-0030's "read at commit X" discipline, extended to the one provider whose single-file path did not previously need it.

### §237. Discovery: a port of the Gitea adapter's scan

DiscoveryPlugin (M15.3b — port of gitea's discover(); DESIGN §11/§12 — "repo/topology scan proposing Service/Component objects and source_mappings"; NEVER auto-commits, only proposes). GitLab's repo tree API is `GET /projects/:id/repository/tree?path=&per_page=` (entries carry `name`/`path`/`type` where type is `tree` (dir) | `blob` (file)) — the marker-file topology walk is the same shape as github/gitea, only the endpoint + the tree/blob type literals differ. The discovered `sourceMapping.sourceKind` is `'gitlab'` — matching the gitlab EXECUTOR's `source_kind` (the `gitlabAdapter.sourceKind` above) so an accepted component's `source_mappings` row actually correlates observed gitlab events (push/pipeline). Without a gitlab-kinded source_mapping, pulled gitlab events correlate against nothing.

NOTE (follow-up): like github/gitea, `sourceMapping.type` is omitted → defaults to `'configuration'` server-side; inferring `'image'` from a Dockerfile marker is a deliberate LATER increment.

### §238. `baseUrl` is intentionally NOT in `required` (M15.3b)

`baseUrl` is intentionally NOT in `required` (M15.3b): a Mode-A `kind=gitlab` execution-system binding supplies the base URL as the injected `serverUrl` fallback instead. Neither `projectPath` nor `owner`/`repo` is individually required in the schema (either addressing form is valid); the "at least one addressing form + at least one of baseUrl/serverUrl" invariants are enforced at resolve time in `asConfig` (a JSON-Schema `anyOf`-of-required is more than a config form should have to render).

## `packages/plugins/gitlab/vitest.config.ts`

### §239. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §240. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/harbor/src/index.test.ts`

### §241. `@scp/plugin-harbor` unit suite

`@scp/plugin-harbor` unit suite (M15.3c). Pure-function tests over Harbor's DOCUMENTED `PUSH_ARTIFACT` webhook payload shape — no DB, no Docker, no network (CLAUDE.md: "Tests never touch the internet"). Proves the one thing this webhook-source package owns: a Harbor image push becomes a `{ repo, artifactDigest }` correlation hint, and every other event type is ignored cleanly (null, never a throw, never a mis-map).

## `packages/plugins/harbor/src/index.ts`

### §242. Harbor as a webhook change-source, not an executor

`@scp/plugin-harbor` — Harbor as a **webhook CHANGE-SOURCE**, NOT an executor (M15.3c, WEBHOOK-SOURCE shape). A container registry is a passive artifact STORE that SCP observes; it is never triggered, never deployed to, never held as an execution-system credential. So — unlike the git providers (`@scp/plugin-github`/`-gitea`/`-gitlab`), which are full `ExecutorPlugin`s built on `@scp/git-provider-core` — this package is DELIBERATELY tiny: a single pure event-mapper and a webhook-source descriptor. There is no `ExecutorPlugin`, no `GitProviderAdapter` (no trigger/observe/status/abort/verify), no manifest, no `KNOWN_EXECUTOR_MODULES` entry. A registry webhook-source only needs to turn a pushed image event into a correlation hint; everything else on the inbound path (auth, persist-then-process, `source_mappings` correlation, Change proposal) is the SAME server machinery every other webhook source already flows through — Harbor is just a new open `sourceKind` string, not a new object type (charter principle 2, graph-native).

COORDINATE-NOT-EXECUTE (charter principle 1): SCP RECEIVES Harbor's push and correlates it; it never calls Harbor. This is exactly like a git webhook, one artifact-shaped event further along.

CONNECTED registries only. Harbor PUSHES `PUSH_ARTIFACT` events to SCP's webhook ingress. The air-gap PULL direction (SCP POLLING a registry that cannot reach out) is a DEFERRED, non-binding poll-driver follow-on — out of scope here (see docs/BUILD_AND_TEST.md §8 M15.3c).

OPERATOR SETUP (why there is no `verify`): Harbor's webhook policy exposes a single **Auth Header** field — the full `Authorization` header value it sends on every delivery. The operator sets it to `Bearer <a scoped SCP PAT>`, so the platform's existing `requireAuth` authenticates the push. Harbor cannot send a SEPARATE HMAC-signature header, so an HMAC verifier would be moot — do NOT configure a change-source webhook secret for `harbor`. This adapter therefore has NO `verify` function; it is `mapEvent`-only.

EVENT NAME IN THE BODY (why there is no `eventHeaderName`): Harbor carries its event type in the BODY (`payload.type`), not an HTTP header — unlike github/gitea/gitlab, which name their event in a header (`X-GitHub-Event` etc.). The server's `extractHint` (webhook-processor.ts) derives the event name from `payload.type` for any adapter that declares no `eventHeaderName`.

### §243. Maps a Harbor event to a provider-neutral hint

Maps a Harbor webhook event NAME + payload to a provider-neutral correlation hint (null = ignore), reusing the SAME `GitProviderEventHint` shape the git providers emit — which already carries `artifactDigest` (ADR-0013), the field a registry push is fundamentally about.

ONLY `PUSH_ARTIFACT` (a new image landed in the registry) maps to a hint for THIS slice — that is the event that represents a releasable artifact. Every other Harbor event type is IGNORED CLEANLY (returns `null`, never throws, never a silent mis-map): `SCANNING_COMPLETED` (which carries `event_data.scan_overview`) is RECOGNIZED as a known type but its scan-gate feed is a NOTED FOLLOW-ON (M17.1), and `DELETE_ARTIFACT`/replication/quota events are simply not release signals.

Correlation is on REPO, via the existing `source_mappings` globs — the digest is threaded through as `artifactDigest` (→ the change's `sourceRef.artifact_digest`) and folded into `correlationKey` for grouping, exactly as the gitea package-push path does; it is NOT a new correlation DIMENSION.

### §244. The webhook-source descriptor the registry consumes

The Harbor WEBHOOK-SOURCE descriptor consumed by the server's per-`sourceKind` adapter registry (`apps/server/src/coordination/webhook-adapters.ts`). Intentionally NOT a `GitProviderAdapter`: a registry webhook-source has NO signature header (`Bearer`-PAT authed, no HMAC), NO event header (event name is in `payload.type`), and NO trigger/observe/verify verbs — only `sourceKind` + `mapEvent`. The server treats a missing `verify`/`eventHeaderName` accordingly (generic-verifier fallback — never exercised, since harbor configures no secret — and body-derived event name).

## `packages/plugins/harbor/vitest.config.ts`

### §245. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §246. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/local-auth/src/index.ts`

### §247. @scp/plugin-local-auth — stub scaffold

@scp/plugin-local-auth — stub scaffold (M0 walking skeleton).

Empty-but-compiling per BUILD_AND_TEST.md §2 / §8 M0. Real implementation lands in M3+ (local-auth as an isolated subprocess plugin; the M0 bootstrap-admin/argon2 login lives directly in apps/server until the plugin host exists) (see docs/BUILD_AND_TEST.md §8 for the milestone plan, docs/DESIGN.md §3 for this package's role in the repo layout).

## `packages/plugins/local-auth/src/stub.test.ts`

### §248. This package is a walking-skeleton scaffold with no behaviour

THIS PACKAGE IS AN M0 WALKING-SKELETON SCAFFOLD and has no behaviour: `src/index.ts` is a doc comment and `export const STUB = true`. The real local-auth implementation is scheduled for M3+; the M0 bootstrap-admin/argon2 login lives in `apps/server` until the plugin host exists.

THIS TEST IS EXACTLY AS STRONG AS THE PACKAGE IS, AND NO STRONGER. It asserts the scaffold's only contract — that the package builds and its marker export is reachable — so that `vitest run` (now WITHOUT `--passWithNoTests`) has something to run rather than reporting success having run nothing. It proves no behaviour, because there is none to prove.

WHEN THIS PACKAGE GETS REAL BEHAVIOUR, DELETE THIS FILE rather than adding beside it: a scaffold marker left asserted next to real tests is a green that means nothing.

## `packages/plugins/local-auth/vitest.config.ts`

### §249. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §250. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/managed-dep/src/bump-edit.test.ts`

### §251. The charter prohibitions, one assertion each

These tests are the charter's `scp-managed-dep` prohibitions, one assertion each. They are written against BYTES rather than against the editor's intentions on purpose: the verifier exists because the thing that produces the edit lives in a separate image that this repository does not build, so every test here supplies a hostile "runner output" directly and asserts the verdict.

### §252. The two tests that are the reason the structural half exists

THE TWO TESTS BELOW ARE THE REASON THE STRUCTURAL HALF EXISTS, and they are not hypothetical: `toVersion` is derived from a THIRD-PARTY VERSION INDEX (ADR-0032 §7), so it is the one field in the descriptor that an outside party influences. A version string that carries JSON syntax passes the textual reconstruction BY CONSTRUCTION — the reconstruction's whole rule is "the to-version token replaced the from-version token", and it did.

### §253. M21.7 — THE ANCHORED BRANCH

M21.7 — THE ANCHORED BRANCH: split-shape Helm images, and the veto that keeps it honest
Every fixture here is a values file whose coordinate and version are on DIFFERENT lines, which is the shape both implementations refused outright before this round. The rule under test is:

```text
the target is the anchor line, refused unless (a) the file's line at that index equals the
anchor text byte-for-byte, (b) it carries `fromVersion`, and (c) the set of lines naming BOTH
the coordinate and `fromVersion` is EMPTY or exactly {the anchor line}.
```

The anchors below are written as literals rather than derived, on purpose: this module is the REFUSAL, and it must be provable against a hostile descriptor as well as against a correct one. `write-guard.test.ts` is where the derivation that produces them is tested, and `runner-shim.test.ts` is where the real `run.sh` is required to agree with these same verdicts.

### §254. THE ADVERSARIAL VALUES FILE

THE ADVERSARIAL VALUES FILE (`split-shape-image-bumps.md` §7). `1.2.3` appears FIVE times and only ONE of them is the version of `acme/api`:

```text
line  3  `imageTag`     — not an `image` key, so the parser never reads it
line  7  `api.image.tag`      <- THE TARGET
line 11  `worker.image.tag`   — a different image, pinned at the same version
line 12  `appVersion`   — the chart's own version
line 14  a pod LABEL
```

Under the coordinate rule this file has ZERO candidates (no line names both `acme/api` and `1.2.3`), which is why it was safe-but-useless before. Under the anchored rule the other five occurrences are not disambiguated — they are never examined, because there are no candidates, only an address.

## `packages/plugins/managed-dep/src/bump-edit.ts`

### §255. THE MANIFEST-ONLY INVARIANT, AS CODE

THE MANIFEST-ONLY INVARIANT, AS CODE (charter `scp-managed-dep` amendment 2026-08-13, ADR-0032 §8).

The charter defines this managed class by four prohibitions, not by a feature:

```text
1. it edits "the declared version of an already-declared dependency in a manifest the component
   already contains";
2. it "never authors any other content, never adds or removes a dependency, and never edits a
   file that declares no dependency";
3. it "never runs a package manager, never resolves or regenerates a lockfile, and never builds,
   compiles, or tests";
4. "a class that requires lockfile resolution is CI by definition and is coordinated, never
   managed".
```

Prohibitions 3 and 4 are enforced by what the runner image CONTAINS (no package manager exists in it) and by `--network none`. Prohibitions 1 and 2 are enforced HERE, and they have to be, because they are properties of the BYTES rather than of the toolchain: a runner image that was rebuilt wrong, replaced, or simply given a manifest whose grammar its editor mis-parses can produce a diff that is not the edit the charter permits, and every layer above would have no way to tell.

SO THIS MODULE IS A REFUSAL, NOT A HELPER. `verifyManifestBump` is run by the orchestrator on the bytes the runner returned, BEFORE anything is pushed anywhere. A verdict other than `ok` means nothing is written to the repository at all. It is deliberately ecosystem-agnostic and deliberately textual: a per-ecosystem rewriter that "knew" what a valid edit looked like would be a second implementation of the editor, and the two would drift — the point of a verifier is that it agrees with the charter's sentence, not with the editor's intentions.

WHY IT IS EXPRESSED AS "EXACTLY ONE LINE, AND ONLY ITS VERSION TOKEN". Every manifest this class touches declares a dependency's version on ONE line — `"@acme/lib": "^1.2.3"` in a package.json, `require github.com/acme/lib v1.2.3` in a go.mod, `FROM alpine:3.18` in a Dockerfile, `acme-lib==1.4.0` in a requirements.txt. So "changed the declared version and nothing else" is decidable without parsing any of them:

```text
* the file has the SAME number of lines           -> nothing was added or removed;
* exactly ONE line differs                        -> no other declaration was touched;
* that line names the coordinate, OR is the line the descriptor ANCHORS to and the coordinate
  rule does not disagree                          -> the right declaration was touched;
* replacing the from-version token with the to-version token in the BEFORE line reproduces the
  AFTER line EXACTLY                              -> only the version token changed.
```

THE THIRD CLAUSE'S SECOND HALF IS M21.7'S SPLIT-SHAPE WIDENING, and it is worth stating why it is not a loosening. Helm's commonest image spelling puts the coordinate and the version on DIFFERENT lines (`repository: acme/api` above `tag: 1.2.3`), and for `{registry, repository, tag}` the coordinate is a CONSTRUCTION that appears nowhere in the file contiguously — so clause 3 as first written could never be satisfied, and the charter's own sentence ("the declared version of an already-declared dependency in a manifest the component already contains") permits the edit that clause refused. What replaces it, when and only when an anchor is supplied:

```text
(a) the file's line at the anchor index equals the anchor text BYTE FOR BYTE;
(b) that line contains `fromVersion` (the existing `from_version_not_on_line` clause, unchanged,
    now measured on the anchor line because the changed line IS the anchor line);
(c) the set of lines naming BOTH the coordinate and `fromVersion` is EMPTY, or is exactly the
    anchor line.
```

(c) is the load-bearing one: **the anchored mode widens only where the textual rule was silent.** Wherever any line does name both, the anchor must BE that line, so every refusal the coordinate rule fires today still fires and nothing that works today gets weaker. (a) makes the anchor COMPARED, NEVER EMITTED — the output line is rebuilt from the file's own bytes, so a wrong descriptor can only cause a refusal, never a smuggled byte.

WHAT IS GIVEN UP, NAMED. For a declaration where NO line names the coordinate — exactly the shapes refused outright before this — the line→coordinate binding is no longer parser-independent: it rests on `parseKubernetesImages` associating a `tag` scalar with its sibling `repository`. A wrong SELECTION is still caught (write-guard gate 6 re-parses the RETURNED bytes and refuses unless the declaration whose version moved is the subscribed coordinate); a wrong ASSOCIATION is common-mode with that gate's own parser and is NOT. The comparison is "refused" versus "bumped under a parser associativity assumption", never "strong guarantee" versus "weak one", and the residual is stated in `docs/proposals/split-shape-image-bumps.md` §4 as an accepted risk with its own differential tests.

The last clause is the load-bearing one and it is why this is a reconstruction rather than a set of `includes()` assertions: `includes(toVersion)` is satisfied by a line that ALSO gained a `--allow-scripts` flag, a changed package name, or a second dependency appended after a `;`. Only rebuilding the expected line and comparing it byte-for-byte rules those out.

STRUCTURAL CHECK WHERE THE FORMAT ALLOWS ONE. For `npm` the manifest is JSON, so the textual test is followed by a parse-and-compare of the dependency KEY SETS (`verifyJsonDeclarationSets`). That is not redundancy for its own sake: it is the one ecosystem where a single line can carry several declarations, and a key-set comparison answers "was a dependency added or removed?" as a fact about the document rather than about its formatting.

NOT A PARSER, AND NEVER A WRITER OF ANYTHING ELSE. Nothing in this file constructs repository content. `applyManifestBump` exists as the REFERENCE edit — it is what the `scp-runner-dep` image's editor must agree with, and it is what the orchestrator's own tests use as a stand-in runner so the seam is testable without a container. The orchestrator never uses it to author what it pushes; it pushes what the isolated runner produced, after this module has agreed with it.

### §256. The five ecosystems, in the order the ADR sequences them

The five ecosystems ADR-0032 §10 enumerates, in the order that ADR sequences them.

The TYPE is re-exported from `@scp/dependency-manifests` rather than declared again here. This file used to declare its own identical union, which was a second definition of one vocabulary — and `types.ts` in that package already carries the warning that the set "MUST stay identical to `DependencyEcosystemSchema`". Two copies is where a sixth ecosystem gets added to one of them. Since `write-guard.ts` now needs that package's parsers anyway, the dependency is already here and there is nothing left to pay for using its type.

### §257. WHAT the bump is — a DESCRIPTOR, never content

WHAT the bump is — a DESCRIPTOR, never content. Every field names something that already exists in the component's repository (the manifest, the coordinate, the version it currently declares) plus the one token that is to replace another. There is no field here that can carry a file body, a patch, or a command, and that is the whole design: see `index.ts`'s "THE DESCRIPTOR IS NOT CONTENT" for why that distinction is the one ADR-0032 §9 actually draws.

### §258. Which line, when the coordinate is not written on it

WHICH LINE, when the coordinate is not written on it (M21.7 split shapes).

PLUGIN-INTERNAL AND DERIVED — never transported. `ManifestBumpSpec` is built inside the orchestrator by `parseBumpDescriptor`, and this field is added by `index.ts` from `write-guard.ts`'s `import("./write-guard.js").locateVersionLine` run over the manifest bytes it has just read at the base branch. There is no wire schema for it, no `pnpm gen`, no oasdiff exposure and no column: a line number captured at ingestion and spent at actuation would be a number derived from a read at one ref and applied to a read at another.

Its ABSENCE is not an error and never becomes one — with no anchor, the coordinate rule runs exactly as it always has.

WHICH ECOSYSTEMS ACTUALLY GET ONE, because the answer is not "only the new shape" and a comment that said so would be a claim the code does not have. `locateVersionLine` derives an anchor from whatever the registered parser reports, so THREE of the ecosystems that already worked are anchored in practice: `go` (go.mod), `python`'s `requirements*.txt`, and `oci`'s Dockerfile. The other three yield none — `npm` and `python`'s `pyproject.toml` because their parsers report no `line` at all, `maven` because `pom-xml.ts` reports the `<dependency>` OPEN TAG line and step 4 refuses a line that does not carry the version.

WHAT THE ANCHORED BRANCH MEANS FOR THOSE THREE, stated as the property rather than as a hope: their parsers take the coordinate VERBATIM off the same line as the version, so the anchor line always names both — which makes it a candidate of the coordinate rule itself. Clause (c) then admits it only when it is the SOLE candidate, which is exactly the unanchored rule's own condition, and refuses when there are several, which is exactly the unanchored rule's own refusal. So the anchored and unanchored paths select the same line and emit the same bytes there (`runner-shim.test.ts` runs both and requires byte equality), and the anchor can never move the edit somewhere else: for a line that names the coordinate, the coordinate rule is never silent, and silence is the only gap an anchor fills.

`text` is COMPARED, NEVER EMITTED. Nothing here is ever written into a file; it is an equality test against the file's own bytes, so a stale or wrong descriptor can only cause a refusal.

### §259. Replace the FIRST occurrence of `from` with `to`

Replace the FIRST occurrence of `from` with `to`. Plain index/slice rather than `String.replace`, because a `from` containing `$&`/`$1` would be interpreted as a replacement pattern — and a declared version is arbitrary tenant text (`^1.2.3`, `~=1.4`, `3.18-alpine`), not a literal this code gets to assume anything about. Same reasoning as managed-iac's split/join redaction.

### §260. THE COORDINATE RULE, as one function

THE COORDINATE RULE, as one function — every line index naming BOTH the coordinate and the version the manifest declares today.

It is the selector `applyManifestBump` has always used and the one `run.sh`'s awk implements in `index()` terms. It is factored out because the anchored mode needs the same set for its VETO — "the anchor must agree with the coordinate rule wherever that rule speaks" is only checkable against the identical set, and a second, subtly different scan is how a veto comes to permit what the selector refuses.

Exported so the orchestrator can ask whether this rule has an answer at all, WITHOUT ever using it to author bytes (`index.ts` uses it for one refusal and for one delivery downgrade). Measuring is not authoring: the runner remains the only thing that produces content.

### §261. The refusal: given both byte sets, decide if it is legal

THE REFUSAL. Given the bytes the manifest had and the bytes the isolated runner produced, decide whether the difference is EXACTLY "the declared version of this already-declared dependency changed from `fromVersion` to `toVersion`" — and nothing else.

Every negative verdict names the reason and states the measured specifics, because this is the one place a caller learns that a runner produced something the charter does not permit; "verification failed" with no numbers would leave an operator with a refused bump and no way to tell a broken runner image from a stale inventory row.

### §262. The file-level clause is replaced, not supplemented

THE FILE-LEVEL CLAUSE IS REPLACED IN THE ANCHORED BRANCH, NOT SUPPLEMENTED. For a `{registry, repository, tag}` image the coordinate is a CONSTRUCTION (`ghcr.io/acme/api` from a `registry:` line and a `repository:` line), so it is legitimately absent from the text and this clause would refuse every such bump as `coordinate_not_declared`. The question it asks — does this file declare this coordinate? — is answered instead by the anchor's own derivation (which found a PARSED declaration carrying exactly this coordinate) and re-answered independently on the RETURNED bytes by `verifyManifestOnlyEdit` gate 6, which refuses unless the base parse declares it and unless the declaration whose version moved IS it.

### §263. The npm-only structural half

The npm-only structural half: parse both documents and prove the DECLARED DEPENDENCY KEY SETS are identical across every dependency block a `package.json` can carry.

npm is the one ecosystem here whose manifest can legitimately hold several declarations on one line (`{"a":"1","b":"2"}` is valid JSON), so the textual single-line test alone would admit an edit that swapped one declaration for another inside the same line. Comparing key sets answers "was a dependency added or removed?" as a fact about the document rather than about its formatting.

Returns a refusal, or `undefined` when the document agrees. An unparseable AFTER is a refusal: pushing a package.json that does not parse would break the component's build, which is a change far beyond "the declared version".

### §264. THE REFERENCE EDIT

THE REFERENCE EDIT — what the `scp-runner-dep` image's editor must agree with, byte for byte.

It lives here, beside the verifier, so the two are read together and so this package's tests can stand in for the runner container (`index.test.ts` drives the orchestrator with a fake docker that applies exactly this). THE ORCHESTRATOR NEVER CALLS IT to produce what it pushes: pushing this function's output would make the ephemeral runner decorative, and the runner's isolation is a charter precondition, not an implementation detail.

Returns `undefined` when the declaration cannot be located unambiguously — a caller that gets `undefined` has learned the manifest does not say what the inventory says it says, which is a refusal, never a licence to guess.

### §265. The anchored rule, in the same order the runner applies it

THE ANCHORED RULE, IN THE SAME ORDER `run.sh` APPLIES IT: (a) the anchor text still matches the file's own bytes, (b) that line carries the version to replace, (c) the coordinate rule does not disagree. Any one failing is a refusal, never a fallback to the other rule — falling back would mean two selectors could each choose a different line and the shim and this function would silently disagree about which.

## `packages/plugins/managed-dep/src/detail-bound.test.ts`

### §266. HIGH (M23.0 verification pass 7)

HIGH (M23.0 verification pass 7) — THE THIRD PLUGIN, AND THE GAP WAS MEASURED RATHER THAN ASSUMED. When `output.slice(-FAILURE_OUTPUT_TAIL_CHARS)` -> `output.slice(0, …)` was applied to `@scp/runner-launcher` and rebuilt through `dist`, the suites answered:

```text
  runner-launcher   2 failed | 135 passed     managed-iac    3 failed | 26 passed
  managed-scan      3 failed |  39 passed     managed-dep  242 passed   <- this file's reason
```

managed-dep front-sliced `runnerOutcomeDetail(run)` at 2000 characters exactly as managed-scan did, so it carried the same defect at every output size — and its whole 242-test suite was indifferent to the mechanism being inverted. A green that a mutation cannot move is not coverage.

THIS PLUGIN HAS A SECOND, DISTINCT WRITE OF THE SAME CLASS and it is the more interesting one. The other two compose `detail` only from strings they authored plus the runner's output. This one also quotes MANIFEST TEXT — `verdict.detail` embeds the changed line of the file the tenant's own repository supplied and the runner returned. That is the one `detail` in the three plugins whose length is chosen by a HOSTILE INPUT rather than by an unlucky tool, and it does not pass through `classifyRunnerFailure` at all, so the port's bound is not what protects it. Its arm is below.

### §267. LOW (verification pass 7, finding L2)

LOW (verification pass 7, finding L2): this arm used to make exactly the claim in its own title while reading the value THROUGH `status()`, and its own comment admitted that reading it that way cannot distinguish "the stored entry is bounded" from "`status()` bounds it on the way out". It was true only because the `.slice` in `status()` had been removed — re-adding one would have made the test green and the title false. Now it reads the Map.

### §268. MEDIUM (M23.0 verification pass 7, finding M1)

MEDIUM (M23.0 verification pass 7, finding M1) — BOUNDING ONE ENTRY DID NOT BOUND THE MAP. `outcomes` is a module-level `Map` that nothing pruned, so a long-lived plugin instance held one ~4 KB entry per bump for the life of the process. Driven through the bad-`action` refusal, which records a real outcome without launching anything.

## `packages/plugins/managed-dep/src/index.test.ts`

### §269. The orchestrator's REFUSALS, unit-tested

The orchestrator's REFUSALS, unit-tested. Everything here is reachable without Docker and without a network, which is deliberate: these are the checks that decide whether a container is launched or a repository is touched at all, so they must be provable in the layer that always runs.

(The trigger()-through-a-container path needs the `scp-runner-dep` image, which this repository does not build yet — see `index.ts`'s "WHAT THIS INCREMENT DOES NOT SHIP". The verifier that stands between that container and the repository is fully covered in `bump-edit.test.ts`.)

### §270. These used to pin this file's own helpers, and now do not

These three used to pin the prose of this file's OWN `isSafeManifestPath`/`isSafeRepo`/ `isSafeBranch` predicates. Those are gone: the descriptor is now validated with the SHARED asserts (`write-guard.ts` → `@scp/git-provider-core`), the same ones the write itself re-applies at the splice site. So the assertion moved to the structured REASON, which is both stronger than a message match and no longer this file's wording to own. The inputs are unchanged, so a refusal that stopped covering one of them still fails here.

### §271. The number is the ADDRESS of the merge

The number is the ADDRESS of the merge. Without it the only way to proceed is to list open pull requests on the head branch and take one, which is how provider ordering — or a second pull request somebody with write access opened from SCP's branch to a protected base — decides what gets merged. A merge intent that carries none did not come from the server's gate, so it is refused rather than completed by a search.

### §272. `trigger()` ACTUALLY REACHES THE MERGE

`trigger()` ACTUALLY REACHES THE MERGE — the parser being right proves nothing about the verb
`parseBumpMergeDescriptor` and `mergeAuthoredBranch` could both be perfect while `trigger()` never dispatched to them, which is M21's standing failure exactly. So this drives the REAL exported verb with the REAL parameter object the server builds, against the recording http fixture — no Docker, no workspace, no network — and asserts the provider call that came out the other end.

That it needs no container is itself the property: a merge is not an edit, so the isolated runner is not involved and `trigger()` must not touch the workspace on this path.

## `packages/plugins/managed-dep/src/index.ts`

### §273. `@scp/plugin-managed-dep` — the `scp-managed-dep` executor

`@scp/plugin-managed-dep` — the `scp-managed-dep` executor (charter Managed Execution Exception, amendment approved 2026-08-13; ADR-0032 §8/§9; BUILD_AND_TEST.md M21.5). The THIRD managed executor, and the first thing CommanderSCP has ever built that writes to a user's repository.

It mirrors `@scp/plugin-managed-iac` and `@scp/plugin-managed-scan` in shape because the charter names their shape: the standard four-verb executor interface, server-injected never-tenant runner settings, a single-shot ephemeral runner from a separate pinned image, scoped vaulted credentials.

WHAT THE CLASS IS, IN ONE SENTENCE, AND WHAT ENFORCES EACH HALF OF IT
"Editing the declared version of an already-declared dependency in a manifest the component already contains" — and the enforcement is deliberately spread across three layers that fail in different places, because a single layer is a single thing to get wrong:

```text
* WHAT CAN BE RUN AT ALL — the runner image contains no package manager and no build toolchain,
  so "never runs a package manager, never resolves or regenerates a lockfile, and never builds,
  compiles, or tests" is a property of the image rather than of this code's restraint. The
  container is launched `--network none`, with no docker socket and no bind mount, so it can
  neither fetch a dependency graph nor reach a host.
* WHAT MAY BE ASKED FOR — `parseBumpDescriptor` refuses an intent carrying anything that
  could be file content, and refuses a manifest path that is not a plain repo-relative path.
* WHAT MAY BE PUSHED — `verifyManifestBump` (see `bump-edit.ts`) re-reads the runner's OUTPUT
  against its INPUT and refuses anything that is not exactly one declaration's version token
  changing. Nothing is written to the repository until that verdict is `ok`.
```

THE VERB SET DOES NOT CHANGE (ADR-0032 §9, charter principle 1)
observe/trigger/status/abort, and no fifth verb. That set IS the structural enforcement of "coordination, not execution": a `write()` verb would remove the enforcement mechanism rather than extend it. What makes a repository write expressible without one is that a bump is an ordinary `trigger()` — the same way an `apply` is for managed-iac and a scan is for managed-scan.

THE DESCRIPTOR IS NOT CONTENT — WHICH IS THE DISTINCTION §9 ACTUALLY DRAWS
ADR-0032 §9 says: "Authored content is NOT threaded through `TriggerIntent.parameters` — `managed-iac`'s `intent.parameters.sourceFiles` is not a precedent (nothing ever populates it, and it writes to an ephemeral workspace, never a repo)."

`intent.parameters` here carries a BUMP DESCRIPTOR and nothing else: which repository, which manifest, which coordinate, what it declares today, what it should declare instead. Every one of those names something that ALREADY EXISTS in the component's repository — they are a reference to a declaration, not a body to write. `managed-scan`'s shipped `intent.parameters` is the same kind of thing (method, inputDir, outputDir: all server-controlled descriptors of a job), and it is the precedent this follows.

That distinction is not left to good intentions. `CONTENT_BEARING_KEYS` is a fail-closed refusal: an intent carrying `sourceFiles`, `content`, `patch`, `diff`, `files` or `body` is REJECTED before anything is launched, so the channel §9 forbids cannot be opened later by a caller that finds it convenient. The manifest's actual bytes never travel through the intent at all — this plugin READS them from the repository itself, with the run's own credential.

AUTO-MERGE IS NOT DECIDED HERE — BUT IT IS CONDITIONED HERE
"Automatic merge is permitted only where a governed control evidences that the component's own checks passed" (charter; ADR-0032 §8: "expressed as a governed control so the existing gate machinery decides, not new code").

So this plugin does not look at CI. It receives `delivery` already resolved, and the server's actuator seam is what refuses to pass `auto_merge` without a passing `control_runs` row for the bump change (`apps/server/src/dependencies/bump-actuator.ts`). Putting the check here would be the second gate ADR-0032 §8 forbids, and it would be the WEAKER of the two — a plugin cannot read `control_runs`, so it would have had to re-ask the provider, which is a different question asked of a different system at a different time than the one the gate machinery answered.

What this plugin DOES enforce is the binding between that decision and a TREE. Every merge it performs carries `expectedHeadCommit` as the provider's merge precondition, so the commit that merges is the commit the control passed and no other. The decision is the server's; the guarantee that it was actuated against what it was about is this file's.

TWO ACTIONS, AND THE SECOND ONE IS WHAT MAKES AUTO-MERGE REACHABLE (M21.5, ADR-0032 §8c)
`action: "bump"` (the default) authors the edit and opens the pull request. `action: "merge"` merges a pull request THIS class already authored, and nothing else — it never edits, never pushes, and never opens a pull request that a human has since closed.

They are separate because evidence names a commit and the authoring run CREATES that commit: at the moment a bump is authored there is no commit for a control to have passed, so an authoring run can only ever merge on evidence about something else. The server's gate job re-runs the governed gate once the component's checks conclude on the authored commit and then dispatches the merge action against exactly that commit.

SYNCHRONOUS TRIGGER, exactly as both siblings
`trigger()` runs the container and completes the delivery before returning, so `status()` reports a finished run from the outcome cache and `abort()` honestly reports that there is nothing left to abort. Idempotency is the `idempotencyKey` cache PLUS the branch name: the branch carries the originating change's id, so a retry that gets past the cache still converges on the same branch and the same pull request rather than opening a second one.

WHAT THIS INCREMENT DOES NOT SHIP
The `scp-runner-dep` IMAGE (`apps/runner-dep`) is not built here. This is the orchestrator half, and it fails closed without the image exactly as `managed-iac` does without `SCP_MANAGED_IAC_RUNNER_IMAGE`: with the setting unset, `resolveExecutorPluginInstance` throws before a dispatch is possible. `applyManifestBump` in `bump-edit.ts` is the reference edit the image's editor must agree with, and it is what this package's own tests use as a stand-in runner.

### §274. The container CLI to spawn

The container CLI to spawn. Defaults to `"docker"`, resolved on the subprocess's PATH, and SERVER-INJECTED IN PRODUCTION from `SCP_MANAGED_RUNNER_DOCKER_BINARY` — the operator-governed knob that lets a deployment run rootless podman instead, which is the sanctioned runtime on the RHEL/air-gapped estates this class ships into (docs/container-runtimes.md).

THE HISTORY IS WORTH KEEPING, because it is the shape of the bug rather than a war story. This comment previously said "NOTHING SETS IT IN PRODUCTION — a test/fixture seam", and that was accurate: `managedDepServerSettings` injected `runnerImage` and `workspaceRoot` and nothing else, on BOTH of this class's construction paths, while its two sibling managed classes injected the binary correctly. The gap had been NOTICED — an earlier edit corrected this comment from "Server-injected in production" to describe the hole — but the comment was corrected to match the broken behaviour instead of the behaviour being fixed, which left an operator's `podman` silently applying to two managed classes out of three, and left the defence-in-depth argument in `managedRunnerDockerBinary`'s doc ("the two defences now fail independently") untrue for this one. Wired 2026-08-16; both paths are pinned by tests (`routes/executors.integration.test.ts` for the hand-made binding, `dependencies/bump-dispatch.integration.test.ts` for the ordinary binding-free dispatch).

A TENANT still cannot set it: the manifest at the bottom of this file is `additionalProperties: false` with `dockerBinary` absent, so a binding carrying it is rejected at create/update by `routes/executors.ts` (`plugin-manifests-managed-dep.test.ts` pins that refusal by name). The write door refuses it and the server overwrites it — two independent defences, which is the point.

### §275. SERVER-INJECTED (never tenant)

SERVER-INJECTED (never tenant) — WHICH LAUNCHER ADAPTER RUNS THIS PLUGIN'S RUNNER (M23.2).

Absent, or anything other than `"kubernetes"`, means the Docker adapter — so a deployment that does not opt in behaves byte-identically, which is what makes a second adapter safe to merge. The same TWO INDEPENDENT DEFENCES `dockerBinary` has apply here from day one: this plugin's manifest is `additionalProperties: false` with these keys absent, so a binding carrying either is rejected at the write door (`plugin-manifests-runner-launcher.test.ts` pins the refusal by name), and the server injects them LAST so a regression in the write door downgrades from a launcher swap to an accepted-but-overwritten key.

### §276. `docker create --network <this>`

`docker create --network <this>` — A LITERAL, NOT A DEFAULT, AND THE DIFFERENCE IS THE CHARTER.

The 2026-08-15 amendment says, of this class and without qualification: "Runner network egress is `--network none`; the runner holds no credential, contains no package manager, and edits only the bytes handed to it." Compare `scp-managed-scan`, whose otherwise-identical clause the 2026-07-23 amendment DOES qualify ("excepting operator-allowlisted registry pulls for the subject artifact's bytes") — which is why that class reads an operator setting and this one must not.

This was briefly built as a server-injected `networkMode` with a `"none"` default, read from `SCP_MANAGED_DEP_NETWORK_MODE`. A default is a value an operator may change, and an operator-settable knob is an operator-facing way to contradict an unqualified charter clause — "the runner reaches no hosts" would have been true of the shipped default and false of a deployment. There is nothing to configure here, so there is no configuration for it: the setting is gone from the plugin manifest, from `ManagedDepConfig`, and from `coordination/executor-bindings-repo.ts`'s `managedDepServerSettings`.

Exported so `runner-containment.test.ts` can assert the launched argv rather than this constant.

### §277. The branch prefix is part of the provenance contract

THE BRANCH PREFIX IS PART OF THE PROVENANCE CONTRACT, not cosmetics.

The server's correlation half (`apps/server/src/coordination/correlation.ts`'s `matchAuthoredBumpChange`) recognises a returning push by this prefix plus the change id that follows it, and then REQUIRES the named change to claim that same repo and ref before it will attach anything. Both halves read this constant, so the two cannot drift into disagreeing about what an authored branch looks like.

### §278. Keys an intent may NOT carry

Keys an intent may NOT carry. This is the enforcement of ADR-0032 §9's "authored content is not threaded through `TriggerIntent.parameters`": the channel is refused rather than merely unused, so a later caller cannot open it by populating a field nobody removed.

`sourceFiles` is named explicitly because it is the exact field §9 calls out as NOT a precedent.

### §279. NOTE ON WHAT IS *NOT* HERE

NOTE ON WHAT IS *NOT* HERE. This file used to carry its own `isSafeRepo`/`isSafeManifestPath`/ `isSafeBranch` predicates. They are gone, and the descriptor is validated with the SHARED asserts (`write-guard.ts`, delegating to `@scp/git-provider-core`'s `assertSafeRepo`/`assertSafeRepoPath`/ `assertSafeRef`) instead.

That is not tidying. A second, subtly-different validator for the same property is precisely the mistake that produced M21.2's two proven holes — the fix was applied to one instance instead of to the class — and the local predicates were already drifting: `isSafeBranch` allowed `HEAD` and a `refs/heads/…` prefix, and `isSafeRepo` accepted a repo the shared assert's charset would have refused nothing about but whose segment-count rule it states explicitly. One rule, one place, and the same one the write itself re-applies at the splice site.

### §280. Which act this intent asks for

Which act this intent asks for. `undefined` is `bump` (every intent built before the merge action existed), and anything else is REFUSED — an unrecognised action must never fall through to the one that writes a commit.

### §281. Turn an intent into a descriptor, or throw

Turn an intent into a descriptor, or throw. Every refusal below is a REFUSAL rather than a fallback: a bump whose target cannot be stated precisely is a bump that must not happen, because the alternative is guessing which declaration in somebody else's repository to rewrite.

### §282. WHICH MANIFESTS THIS COMPONENT ACTUALLY DECLARES

WHICH MANIFESTS THIS COMPONENT ACTUALLY DECLARES (ADR-0032 §3 projection rows), sent by the server's actuator seam. It is a list of REFERENCES to files that already exist, not content — the same category as `manifestPath` itself.

It is REQUIRED rather than defaulted, and that is the whole point of it: `verifyManifestOnlyEdit` refuses a target the component does not declare, and a default of `[manifestPath]` would make that gate agree with itself and pass vacuously. Absence is never permission.

### §283. A version token never spans lines or carries control bytes

A version TOKEN never spans lines and never carries control characters. This matters because `toVersion` is the one descriptor field derived from a THIRD-PARTY VERSION INDEX (ADR-0032 §7): a newline in it would turn a one-line edit into a multi-line one, which is a shape the class does not have. This is the cheap half of the defence — `verifyManifestBump`'s reconstruction and JSON key-set comparison are what actually catch a token carrying manifest SYNTAX, and `bump-edit.test.ts` pins both injections.

### §284. A grant without a commit is refused at the descriptor

A GRANT WITHOUT A COMMIT IS REFUSED AT THE DESCRIPTOR, before a credential is minted. The server only ever resolves `auto_merge` from a control run whose evidence names the bump's own head commit, so an `auto_merge` intent that carries no commit did not come from that resolution — and merging on it would merge whatever the branch is at, which is the fail-open the whole evidence chain exists to close.

### §285. Turns a merge intent into a descriptor, or throws

Turn a `action: "merge"` intent into a merge descriptor, or throw.

WHAT IS DELIBERATELY NOT READABLE FROM THIS INTENT: a head branch. It is COMPOSED from `changeObjectId` by `bumpBranchFor` — the same function the authoring run used — so the only branch this action can ever merge is the branch a bump of that change authored. A caller-supplied branch name would turn the narrowest write in the tree into "merge whatever you are told to", which is precisely the widening the charter amendment does not grant.

`expectedHeadCommit` is required and full-length. It is the merge precondition, and the server takes it from `dependency_bump_authorships.head_commit` — SERVER-OWNED storage of what SCP's own branch is at, written when the authored push came back through the two-sided branch check — never from `changes.source_ref`, which any authenticated principal can write, and never from anything the payload of this intent asserts about the world.

`pullRequestNumber` is required for the same reason and closes a wider hole: without it this action LISTED open pull requests on the head branch and merged the first one, so provider ordering chose what got merged and no base was ever compared. The server records the number when SCP's own authoring run reports the pull request it opened; the write path then re-reads that pull request and refuses unless its state, head and base all still match the grant.

### §286. The runner container

The runner container — COPY the one manifest in, COPY the edited manifest out. Never a bind mount, never a docker socket, always `--network none`. Identical in shape to managed-iac/managed-scan's launch, for the identical reason (a host-path escape is structurally impossible when nothing is mounted) — and since M23.1 that shape is literally the same code: `@scp/runner-launcher`, the one port all three managed executors launch through.

WHAT DID NOT MOVE INTO THE PORT, AND MUST NOT: the network mode. It is passed from here as the LITERAL `RUNNER_NETWORK_MODE`, so the charter clause and the value it fixes stay in the same file. A port that read `config.networkMode` uniformly for all three callers would turn an unqualified charter clause into an operator-settable default; the golden's third case names a different mode in the context and still requires `none` on the command line.

### §287. The edit is described ENTIRELY on argv

The edit is described ENTIRELY on argv — five strings that name a declaration and a version, plus (M21.7, split shapes only) the two that name WHICH LINE carries it. Nothing here can be a file body, a path outside the container, or a command: the anchor text is one line the container already has in the file it was handed, and the shim only ever COMPARES it.

THE PAIR IS APPENDED ONLY WHEN THERE IS AN ANCHOR, which is what makes version skew fail-closed in both directions (`run.sh`'s argv contract): a five-operand invocation is byte-for-byte the one every previously-shipped image understands, and an image that predates the anchor ignores the extra two and refuses the split shape it could not have edited anyway.

### §288. Only on success

Only on success — there is nothing to salvage from a runner that did not finish the edit, and copying out a partial manifest would put unverified bytes where the verifiers read from. Not guarded either: `trigger()`'s outer catch is what turns a failed copy-out into a `failed` run (managed-scan's escapes its `trigger()`; managed-iac's is swallowed — three answers to one Docker failure, all three pinned by goldens).

### §289. {@link BoundedDetail}, NOT `string`

`BoundedDetail`, NOT `string` — see `@scp/runner-launcher`'s `RUNNER_DETAIL_MAX_CHARS`. Most of the writes below record a THROWN `Error`'s freeform `.message`, or a verifier verdict derived from manifest TEXT; neither has a length this plugin chose, and `status().detail` is copied into a `Decision`'s `inputContext`. The type is what makes every one of those sites prove it bounded the string.

### §290. WHAT THE CODE BELOW COMPOSES

WHAT THE CODE BELOW COMPOSES — a `detail` that is a plain `string`, because a composition site is the wrong place to remember to bound one (MEDIUM, M23.0 verification pass 7 finding M3).

THE 26-CALL-SITE PROBLEM, AND WHY THE BRAND DID NOT SOLVE IT. `RunOutcome.detail` is `BoundedDetail`, which makes "you cannot store an unbounded reason" a compile error — good, and it is why every site here HAD a bound. But a brand on a FIELD forces a conversion at every literal that constructs the record, so this file alone carried FOURTEEN `boundDetail(...)` calls, of which a delete-the-wiring sweep found most pinned by no failing test. This repository's own rule is that three sites of one concept means the boundary is in the wrong place, and 15 is not a reason to write 15 tests.

SO THE BOUND MOVED TO THE STORE. The brand stays exactly where it was — a READER of `RunOutcome` still cannot be handed a megabyte — and `recordOutcome` below is the only thing that can mint one. Composition sites deal in `string`, which is what they actually have, and there is now ONE place in this file where an unbounded value becomes a bounded one instead of fifteen.

### §291. THE ONLY WAY AN OUTCOME ENTERS THE CACHE

THE ONLY WAY AN OUTCOME ENTERS THE CACHE. Bounds the detail (finding M3) and bounds the number of entries (finding M1) — the two halves of "bounding one entry did not bound the map".

A LOOSER ENTRY CAP THAN managed-iac's, deliberately: that plugin re-parses its whole durable ledger on every `status()` poll, so its size is CPU per tick, while this is a `Map.get` — O(1) whatever the size — that is lost on restart anyway. What an entry has to outlive is short and knowable: `trigger()` runs the job synchronously to completion BEFORE recording, so the only reader left is reconcile's next poll about a second later, plus a crash-and-retry window in which reconcile re-issues the same `idempotencyKey`. `RUN_OUTCOME_CACHE_MAX_IN_MEMORY` is orders of magnitude above anything that can be in flight, not the smallest number that would work.

### §292. Exported for tests only

Exported for tests only — READ THE STORE, not what `status()` chose to return.

LOW (M23.0 verification pass 7, finding L2): a test claiming "THE OUTCOME MAP ENTRY IS BOUNDED, not just the value `status()` returns" read the value THROUGH `status()`, and its own comment admitted that reading it that way twice cannot distinguish the two. It was true only because the `.slice` in `status()` had been removed; re-adding one would have made the test green and the claim false. A claim about the store has to be measured at the store.

### §293. The merge half of `trigger()`

The merge half of `trigger()`. Separate because it has NO workspace, NO container, and NO edit: it mints the run credential, merges the pull request the bump already opened, and revokes it.

The runner is not involved at all, and that is correct rather than an omission — the runner exists to perform an offline text edit, and there is no text here.

### §294. LOW-6: `scratch` DECLARED OUTSIDE, INITIALISED INSIDE THE `try`

LOW-6: `scratch` DECLARED OUTSIDE, INITIALISED INSIDE THE `try` — `mkdir`/`mkdtemp` used to run BEFORE this `try` began, so a disk error here (permissions, ENOSPC) rejected `trigger()` UNRECORDED: no `outcomes.set(externalId, …)`, and the caller's `status()` would report `pending` forever. Moving them inside closes it the same way the descriptor/writer refusals above already are; the `finally` below is `undefined`-safe for the case where `mkdtemp` itself is what failed.

### §295. Locate the version line from the bytes just read

1b. LOCATE THE VERSION LINE, from the bytes just read (M21.7, split shapes).

```text
  Derived HERE and spent immediately, against the very same string: an anchor captured at
  ingestion and spent at actuation would be a line number taken from a read at one ref and
  applied to a read at another, which is a confidently wrong edit rather than a refused
  one. `locateVersionLine` never throws and returns `undefined` freely — its ABSENCE is
  not an error, it just means the coordinate rule runs exactly as it always has.
```

```text
  AN ANCHOR IS DERIVED HERE FOR MORE THAN THE NEW SHAPE, and saying otherwise would be a
  comment asserting a property this code does not have: `go`, `python`'s
  `requirements*.txt` and `oci`'s Dockerfile all anchor, because their parsers report the
  line that carries the version. What keeps them unchanged is not the absence of an
  anchor but clause (c) of `verifyManifestBump` — those parsers read the coordinate off
  that same line, so the anchor is itself a coordinate-rule candidate and the veto admits
  it only where the unanchored rule would have chosen it anyway. The ecosystems that
  genuinely yield NO anchor are `npm` and `pyproject.toml` (their parsers report no line
  at all) and `maven` (`pom-xml.ts` reports the `<dependency>` open-tag line, which does
  not carry the version, so step 4 refuses it).
```

### §296. The residue, named: no anchor and no qualifying line

1c. THE RESIDUE, NAMED. With no anchor AND no line naming both the coordinate and the declared version, neither selector has an answer and the runner would exit 3 — a container round trip whose only product is "the runner failed", which reads as a broken image rather than as a stale inventory row or a declaration pinned identically twice. Refused here instead, with its own name (ADR-0032 §7b clause 6: a reason names its own cause). This MEASURES the coordinate rule, it does not author with it — the runner is still the only thing that produces bytes.

### §297. Verify before anything is written anywhere

3. VERIFY before anything is written anywhere. This is the charter's "never authors any other content, never adds or removes a dependency" as an executable refusal.

```text
 TWO verifiers, and they are not redundant. `verifyManifestBump` is TEXTUAL and anchored
 on the descriptor: does replacing `fromVersion` with `toVersion` on the one changed line
 reproduce the runner's output exactly? `verifyManifestOnlyEdit` (write-guard.ts) is a
 PARSE anchored on the document: is the declared dependency SET identical, did exactly one
 already-declared version move, and is the textual change confined to that version's own
 text? Each catches what the other structurally cannot — the second is what survives a
 minified `package.json`, where "bump react AND add a postinstall script" is one line's
 worth of change and the textual test alone would pass it.
```

### §298. ...and only the second one MINTS

```text
 ...and only the second one MINTS. The proof is an HMAC over these exact bytes at this
 exact path, under a key no other module holds, and `publishBump` re-checks it before any
 request. That is what makes the guarantee structural rather than procedural: bytes that
 did not pass verification cannot reach a repository, because there is no way to call the
 write without a proof and no way to obtain a proof except by passing.
```

### §299. 4. PUBLISH. Branch, commit, pull request

4. PUBLISH. Branch, commit, pull request — and merge only when the server already decided.

```text
 D2 (`split-shape-image-bumps.md` §9): A SPLIT-SHAPE BUMP IS PULL-REQUEST-ONLY THIS ROUND,
 whatever the subscription resolved to. "Split shape" is not a guess about the format — it
 is exactly the condition under which the widening did any work: an anchor was used AND no
 line of the file named both the coordinate and the declared version, so the binding
 between the edited line and the coordinate came from the parser's association of a `tag`
 scalar with its sibling `repository` rather than from the bytes. Write-guard gate 6
 catches a wrong SELECTION; a wrong ASSOCIATION is common-mode with that gate's own parser
 and is not caught, so a human on the diff is the control for it (§4, residual risk).
```

```text
 This only ever DOWNGRADES. The plugin never upgrades a delivery — that decision is the
 server's governed one — and a downgrade cannot make an unauthorised write reachable.
```

### §300. trigger() runs synchronously to completion

trigger() runs synchronously to completion — by the time a caller holds a ref, the container has exited and the pull request either exists or does not. Honestly reported, never silently ignored. Note what abort deliberately does NOT do: it does not close or revert a pull request SCP opened. That is a repository write nobody asked for, and undoing a proposal is a human's call.

### §301. THE LAUNCHER SEAM

THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose: adapter selection is not tenant-facing, and any new config field would have to join the server-injected, never-tenant-settable class in all three enforcement layers (this manifest's `configSchema`, the four `validatePluginConfig` write doors, and the LAST-wins injection sites) on day one. Note what the seam does NOT carry: the network mode, which this class fixes as a literal rather than a setting (ADR-0032 §8d).

### §302. THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE

THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE — M23.2, AND THIS LINE IS THE WIRING. `subprocess-entry.ts` constructs this plugin with NO argument, so whatever stands here is what every production run uses. While it was `resolveDockerRunnerLauncher`, an operator could set `runnerLauncher: "kubernetes"` through every layer of the chart and every managed run would still shell out to a `docker` binary the `scpd` image does not ship — a feature correctly built and installed nowhere, which is this repository's dominant defect class (CLAUDE.md). Delete this and `runner-launcher-selection.test.ts`'s named case for this plugin dies.

### §303. Manifest `configSchema` is the TENANT-facing surface ONLY

Manifest `configSchema` is the TENANT-facing surface ONLY. `additionalProperties: false`, and the server-governed `runnerImage`/`networkMode`/`workspaceRoot` are absent from it — so a binding that tries to set what image runs, on what network, or against what directory is REJECTED at create/update by `routes/executors.ts`'s config validation. The server injects those three itself (`coordination/executor-bindings-repo.ts`'s `managedDepServerSettings`, spread LAST so they win).

What a tenant DOES configure is the git-provider identity — the App their team installed on their own repository — plus a timeout. That is the same trust split `@scp/plugin-github` already has.

### §304. BOUNDED AT BOTH ENDS

BOUNDED AT BOTH ENDS (M23.1c). The `maximum` is the half that was missing: with only a floor, a tenant could set 2^31 and make the runner unkillable by its own timeout AND unbound the plugin-host RPC budget derived from it. Enforced at every write door by `validatePluginConfig` (Ajv honours `maximum`), and clamped again host-side for rows stored before the ceiling existed.

## `packages/plugins/managed-dep/src/launch-argv.golden.test.ts`

### §305. The golden Docker argv, recorded before anything moves

M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-dep`, RECORDED BEFORE ANYTHING MOVES

WHY THIS FILE EXISTS, AND WHY M23.1 DID NOT RETIRE IT. M23 extracts a `RunnerLauncher` port so the three managed executors can also launch their runners as Kubernetes Jobs. That refactor's central promise is that **the Docker path is byte-for-byte unchanged**. A promise like that is only checkable if the current bytes were written down FIRST, by a test that existed BEFORE the refactor — otherwise the "unchanged" baseline is whatever the refactor happens to emit, and the assertion is a tautology.

THE PARAGRAPH THAT USED TO SIT HERE WAS WRONG, AND THIS ONE REPLACES IT. It said that until M23.1 landed the port this file was the definition of "unchanged", and that when the port landed these tests were "to be **deleted or superseded** by the port's own conformance suite". M23.1 HAS LANDED. It did NOT retire this file, and that standing instruction is withdrawn — because the port's conformance suite (`packages/runner-launcher/src/docker-adapter.test.ts`) and this file prove DIFFERENT things, and neither implies the other: - THE CONFORMANCE SUITE drives `createDockerRunnerLauncher` DIRECTLY. Its subject is what the adapter emits FOR A GIVEN `RunnerSpec` — argv, per-call `timeout`/`maxBuffer`, both copy-out axes, the failure paths. A `RunnerSpec` is its INPUT. - THIS FILE drives `plugin.trigger()`. Its subject is THE OTHER HALF, which the conformance suite structurally cannot reach: that this plugin still hands the port THE SAME SPEC it used to build by hand. A spec field changed here — `networkMode` switched from this plugin's charter literal `"none"` to a read of `config.networkMode` — produces a perfectly CONFORMANT launch of the WRONG container, and the conformance suite is blind to it, because that spec is what it is handed rather than what it checks. Deleting this file on the strength of the old sentence would take the plugin→port boundary to ZERO coverage while every task stayed green — the vacuous-green class BUILD_AND_TEST.md §4.4 names, and the same reason `@scp/runner-launcher` no longer runs with `--passWithNoTests`. RETIRE THIS FILE ONLY ALONGSIDE SOMETHING THAT COVERS THAT BOUNDARY, never merely alongside something that covers the adapter.

HOW THIS DIFFERS FROM `runner-containment.test.ts`, WHICH IT SITS BESIDE. That file asserts a CHARTER PROPERTY — no network, no credential, no host — and is meant to survive forever, in whatever launcher the plugin grows. It says "the argv contains no `-e`". This file says "the argv is exactly THESE strings in THIS order, with THESE options", which is a much stronger and much more perishable claim. They use the same recording seam and are deliberately separate — but "perishable" means it must be CONSCIOUSLY re-recorded when the launch legitimately changes, NOT that M23 consumes it. M23.1 came and went and both are still here.

WHAT IS PINNED, AND WHY EACH PART IS PART OF THE PROMISE. 1. THE FULL argv ARRAY of every `execFile`, in order — `create`, `cp` in, `start`, `cp` out, `rm` — including BOTH operand shapes: the **5-operand** contiguous form and the **7-operand** anchored form M21.7 added for split declarations. 2. THE OPTIONS OBJECT alongside each argv. managed-dep runs **5 min / 8 MiB** — the shortest and smallest of the three (managed-iac 10 min / 16 MiB, managed-scan 10 min / 32 MiB), because this runner edits one manifest and prints nothing. `rm` alone carries a 30 s timeout AND NO `maxBuffer` AT ALL. `toStrictEqual` is what makes those absences part of the record rather than merely untested — a port that unified the three into one shared default would be a behaviour change wearing a refactor's clothes. 3. THE NETWORK MODE IS A LITERAL, NOT A CONFIG READ, in this plugin alone (the 2026-08-15 charter amendment carries no operator qualifier, unlike managed-scan's). A context naming another mode must still produce `--network none`, and a port that plumbs `config.networkMode` through uniformly for all three must fail here. 4. THE FAILURE PATH: on a rejected `start` there is **no copy-out at all** — like managed-scan, unlike managed-iac, which copies out unconditionally. This plugin's copy-out is also not catch-guarded, but its `trigger()` has an outer `try/catch`, so a failed copy-out lands as a FAILED run rather than a rejection (managed-scan's escapes `trigger()`; managed-iac's is swallowed entirely). Three call sites, three different answers — all three are measured.

THE RECORDING SEAM is the one this package already uses in `runner-containment.test.ts` — `vi.mock("node:child_process")` with a hand-written `execFile` and a stand-in runner that writes real edited bytes on the copy-out, so the run reaches a real `succeeded` and no assertion above can pass by nothing having happened. The only widening is that the options object (which that file discards as `_opts`) is now recorded too, because point 2 is half the promise. No Docker is required, so these run on every PR under `pnpm test`.

### §306. M23.1 PHASE 4 — the reaper

M23.1 PHASE 4 — the reaper. `reap()` now runs at the top of every `run()`, issuing a `docker ps -a --filter label=...` before `create` and stamping two more `--label` pairs onto every `create` it issues. Neither is this file's subject (its own dedicated coverage is `@scp/runner-launcher`'s `docker-adapter.test.ts` and `reaper.integration.test.ts`), so both are kept out of the golden entirely: the `ps` call is answered with an empty listing and never recorded, and the two labels are stripped off `create`'s argv before it reaches `calls`.

### §307. The options: the buffer as a literal, the timeout as a bound

THE OPTIONS — `maxBuffer` AS A LITERAL, `timeout` AS THE BOUND IT MUST NOW LIE IN (M23.1e)
Deliberately NOT imported from `index.ts`: a golden that re-derives its expectation from the code it is guarding cannot detect a change to that code. 8 MiB is written here because that is what the plugin does TODAY.

WHY `timeout` STOPPED BEING AN EQUALITY. `RunnerSpec.timeoutMs` is the WHOLE-RUN budget since M23.1e, so each step is issued with what is LEFT of it (`deadline - now`, off one clock read at the top of `run()`). Handing every step the full `timeoutMs` was the defect this golden used to pin: four sequential calls, each individually under the bound, made a run of four x timeoutMs, which the host's own budget — sized `timeoutMs + grace` — then SIGKILLed, orphaning the container and leaving the idempotency ledger unwritten.

So the assertion is the PROPERTY: never ABOVE the caller's budget (that is the old behaviour back), and never more than `BUDGET_SLACK_MS` below it in this seam, where every step settles on the next tick — which is what stops a degenerate "always 1ms" from passing. The strict decrease across a run and the refusal once nothing is left are proven where they can be measured: `@scp/runner-launcher`'s `whole-run-budget.test.ts`.

`toStrictEqual` KEEPS ITS TEETH — the matcher stands in for the `timeout` VALUE only, so the ABSENCE of `maxBuffer` on `rm` and of every other key everywhere is still pinned exactly.

### §308. THE KEYS ARE FIXED NOW, AND THEY HAVE TO BE

THE KEYS ARE FIXED NOW, AND THEY HAVE TO BE. They used to be `golden-npm-${Math.random()}` — free, because nothing on the command line depended on them. Since the run's `--name` is derived from the idempotency key, a random key would put a random string in the argv this file exists to record literally. `__resetManagedDepOutcomes()` in `beforeEach` is what makes fixed keys safe: the outcome cache that dedup reads is cleared between cases, so a repeated key is a fresh run.

### §309. The two host paths are a per-run temporary directory

The two host paths on this plugin's command line are a PER-RUN `mkdtemp` under the server-given `workspaceRoot`, so they cannot be written as literals the way managed-iac's derived workspace or managed-scan's server-supplied dirs can. Their SHAPE is asserted here — a `scp-dep-*` run directory immediately under `workspaceRoot`, with `in`/`out` inside it — and only then are they substituted, so every other byte of the argv stays a literal in the goldens below.

### §310. THE ASYMMETRY, MEASURED

THE ASYMMETRY, MEASURED. managed-iac copies its workspace out even after a failed `start`; managed-dep does not, because there is nothing to salvage from a runner that did not finish the edit — and copying out a partial manifest would put unverified bytes where the verifiers read from. A refactor that gives all three launchers one shared sequence must break either this test or managed-iac's mirror of it.

### §311. The third of three answers to the same Docker failure

The third of three answers to the same Docker failure. managed-iac's copy-out is `.catch(() => undefined)`, so the run stays succeeded. managed-scan's is unguarded and its `trigger()` has no outer catch, so the error escapes `trigger()`. managed-dep's is unguarded too, but `trigger()` wraps everything, so the error becomes a failed outcome. Recorded as behaviour, without judgement — but it must not change silently while the refactor is called byte-for-byte identical.

### §312. MEDIUM (verification pass 5)

MEDIUM (verification pass 5) — A RUNNER THAT SAYS NOTHING STILL PRODUCES A RECORDED REASON

The arm above passes on `run.stderr` alone, because that fixture's runner PRINTS. This plugin's detail used to be `— ${run.stderr.slice(0, 2000)}`, and `promisify(execFile)` always attaches `stderr` as a string — so a runner we killed on the budget, and a `docker` that never spawned, both recorded `the runner failed to edit 'package.json' — ` and stopped. managed-dep's failure detail is what a human reads when a dependency bump does not appear, and an em dash is not a reason.

A SEPARATE ARM RATHER THAN A CHANGE TO THE ONE ABOVE: that one's subject is that the runner's OWN words survive, and this one's is that something survives when there are none. Merging them would leave neither pinned.

## `packages/plugins/managed-dep/src/launcher-seam.test.ts`

### §313. The standing gate that the port is installed, not present

M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.

See `@scp/plugin-managed-iac`'s file of the same name for why this is separate from `launch-argv.golden.test.ts`. The golden proves the Docker bytes are unchanged; it would keep passing if this plugin kept a private copy of the launch sequence and `@scp/runner-launcher` were dead code beside it. Deleting the wiring — here, by injecting a launcher that throws — is the only check that tells the two apart.

WHERE THE FAILURE LANDS IS THIS PLUGIN'S OWN ANSWER, and pinning it is half the point: managed-dep wraps the whole run in a try/catch, so a launcher failure becomes a FAILED outcome rather than a rejection (managed-iac rejects out of `trigger()`; managed-scan rejects and leaves the run stuck `pending`). Three call sites, three answers, all three preserved by the port.

IT ALSO PINS THAT NO WRITE HAPPENED. A launch that never ran must not leave a commit or a pull request behind, and the run credential must still be revoked.

### §314. `toStrictEqual` on the WHOLE object

`toStrictEqual` on the WHOLE object: the absence of any further adapter-selection key is the assertion, because every key here joins the server-injected, never-tenant-settable class. The value is `"docker"` rather than `undefined` because `asConfig` already applied this package's own unit-test fallback before the resolver ever sees it — in production the server injects `SCP_MANAGED_RUNNER_DOCKER_BINARY` and the fallback is never reached. M23.2 UPDATED THIS LINE, AND IT WAS SUPPOSED TO. The comment above says "M23.2 is where that happens; M23.1 must not smuggle one in early" — so this assertion is the placeholder that makes the adapter-selection field arrive DELIBERATELY rather than by accident, and updating it is the act of arriving. It stays `toStrictEqual` on the WHOLE object for the reason it always was: every key here joins the server-injected, never-tenant-settable class and must move through all three enforcement layers in the same change. A FOURTH key appearing here still fails, which is the property being kept.

### §315. `occupied` is a FILE, not a directory

`occupied` is a FILE, not a directory — `mkdir(join(occupied, "nested"), { recursive: true })` therefore fails with ENOTDIR, reproducing the disk-error shape LOW-6 names (permissions, ENOSPC, or — as here — a path component that is not a directory at all). This used to run BEFORE `trigger()`'s own `try`, so the failure escaped as an unrecorded rejection and `status()` reported `pending` forever.

## `packages/plugins/managed-dep/src/repo-write.matrix.test.ts`

### §316. The traversal census, on the one surviving write path

THE TRAVERSAL CENSUS, ON THE ONE SURVIVING WRITE PATH
THE PROPERTY, stated once so the enumeration below is obviously an instance of it: **a caller-supplied string spliced into a REST route re-targets the ROUTE, not just the resource**, and `encodeURIComponent("..") === ".."` — so encoding is not the control, a validator is. M21.2 proved both halves the hard way: a `ref` of `../../../../user` turned `GET /repos/{o}/{r}/commits/{ref}` into `GET https://api.github.com/user`, reached with the binding's credentials; and a raw `repo` of `acme/widgets?x=` terminated the route at a query string, giving both re-targeting and query injection.

IT HAS ALREADY BEEN GOT WRONG TWICE ON THIS FEATURE. The read path's fix was applied to one provider and left open in the other two. The rival M21.5 branch then proved its own coverage with a hand-picked set of interesting cases, and FOUR mutants survived it — deleting a single assert from a single call site left every suite green. Both failures are the same failure: a fix applied to an INSTANCE rather than to the class.

SO THIS IS A MATRIX, NOT A LIST. Every caller-supplied string × every operation of the write path that splices one. Enumerating it exhaustively is what makes a MISSING assert fail a test rather than depend on a reviewer noticing it is missing.

"ZERO HTTP" IS MEASURED, NOT INFERRED. Every case counts the requests the recording client actually saw. For the operations that run inside a credentialled session, the assertion is on the DELTA across the refusing call — the session's own mint and revoke are requests, and folding them into the count would be measuring the wrong thing. For `withRunCredential` itself the count is an absolute zero, which additionally proves the refusal precedes AUTH: the App-JWT → installation-token exchange is the first request of any run, so an assert that ran late would show up here as a 1.

### §317. THE POSITIVE CONTROL

THE POSITIVE CONTROL. Without it every case above could pass by the write path being broken for all inputs — the vacuous-green shape this repository has been bitten by repeatedly. The same fixture, unpoisoned, must reach the wire and produce a pull request.

### §318. The parser validates the same strings with the same asserts

`parseBumpDescriptor` validates the SAME strings with the SAME asserts before a provider arm is even resolved. That is not belt-and-braces duplication: the descriptor arrives from the server and is the earliest point at which a bad target can be named, while the session asserts guard the actual splice — and only the second of those would still hold if some future caller reached the writer without going through a descriptor. Both are enumerated so neither can quietly go missing.

## `packages/plugins/managed-dep/src/repo-write.test.ts`

### §319. The credential clause, against a recording fake

The credential clause, exercised against a recording fake of `ctx.http`.

"Repository-write credentials are issued per run, scoped to the single repository under change, and are never standing credentials" is a sentence about REQUESTS — which endpoint is called, what body it carries, and whether the token is revoked — so it is testable exactly here and nowhere else in the tree.

The fixtures and the recording client are shared with `repo-write.matrix.test.ts`, so the wire behaviour proven here and the refusals proven there are demonstrably about the same request.

### §320. THE SAME PROPERTY AS THE MERGE PATH'S, AT THE OTHER CALL SITE

THE SAME PROPERTY AS THE MERGE PATH'S, AT THE OTHER CALL SITE. `findOpenPullRequest` used to filter on the head branch alone and return `list.body[0]`, so the "duplicate" this run adopts as its own could be a pull request somebody else opened from the same branch to a different base — and for an `auto_merge` delivery this run would then merge it. One branch can legitimately have several open pull requests against several bases; the one this run is a retry of is the one into OUR base.

### §321. The repository-write authority, and every condition on it

`mergeAuthoredBranch` — THE NEW REPOSITORY-WRITE AUTHORITY, AND EVERY CONDITION ON IT
Until M21.5's auto-merge link the only merge reachable in the tree was the tail of a publish, so this is a genuine widening: SCP can now change a repository's default branch without a human clicking anything. Each test below pins one of the conditions that make that permissible, and each asserts the MECHANISM (a request, a refusal reason) rather than only the outcome — a test that asserted "it did not merge" would stay green with the precondition deleted.

### §322. THE BASE BRANCH IS COMPARED, NOT MERELY CARRIED

THE BASE BRANCH IS COMPARED, NOT MERELY CARRIED — the blocker this block exists for
`target.baseBranch` was asserted safe and then DISCARDED: never sent, never compared. Combined with "merge whichever open pull request the listing returns first", that meant an open pull request from SCP's branch to `production`, while the governed grant was about `main`, MERGED — and the server recorded a `merged` Decision naming `main`. Anyone with write or triage on the repository can retarget a pull request or open a second one from a branch they can see, so this is a reachable widening of the grant, not a hypothetical.

## `packages/plugins/managed-dep/src/repo-write.ts`

### §323. The one place we write to somebody else's repository

THE ONE PLACE COMMANDERSCP WRITES TO SOMEBODY ELSE'S REPOSITORY, AND THE CREDENTIAL CLASS THAT MAKES IT POSSIBLE (charter `scp-managed-dep` amendment 2026-08-13, qualified 2026-08-15).

THE ONE PLACE, LITERALLY. M21.5 was briefly built twice — once as write hooks on `GitProviderAdapter`, once here — and the owner's 2026-08-15 decision settled it on this side: repository-write authority belongs inside the charter's enumerated managed class, where its containment preconditions bind, not in a library every git-provider plugin loads. See `write-guard.ts`'s header for the ADR-0032 §9 argument that decided it. `GitProviderAdapter` is read-only and pinned so by a type-level assertion in `@scp/git-provider-core`'s own suite.

WHO REACHES THE GIT HOST — THE ORCHESTRATOR, NEVER THE RUNNER
The 2026-08-13 amendment said two things that could not both be true of one process:

```text
"`scp-managed-dep` holds scoped, per-run, short-lived repository-write credentials"
"... runs in isolated single-shot ephemeral runners from a separate `scp-runner-dep` image,
 and reaches no hosts."
```

A repository-write credential is only meaningful against a host, so a component that reaches no hosts cannot use one. The charter was amended on 2026-08-15 to qualify the network clause exactly as the 2026-07-23 amendment already qualifies it for `scp-managed-scan`, and THIS FILE IMPLEMENTS THAT SPLIT rather than working around it:

```text
* the RUNNER (`scp-runner-dep`, a separate pinned image) is single-shot, ephemeral, and
  `--network none`. It receives manifest bytes by `docker cp`, applies the declared-version edit
  offline, and returns bytes by `docker cp`. It reaches no hosts, holds no credential, and
  contains no package manager — which is how "never runs a package manager, never resolves or
  regenerates a lockfile" becomes true by construction rather than by discipline. See
  `index.ts`'s `runEditorContainer`: the container is launched with no environment, no mount and
  no socket, and everything it is told is five argv strings that name a declaration — seven when
  the version is written on a different line from the coordinate and the orchestrator supplies
  the anchor saying which line (M21.7). The anchor is a line number and that line's own bytes:
  still a reference to what the file already holds, never content.
* the ORCHESTRATOR (this plugin, in the plugin host) holds the repository-write credential and
  performs the write. It is the component the credential clause is about.
```

The precedent is shipped, not invented: `federation/promotion-scan-step.ts` records that the managed-scan plugin "does NOT pull the subject's bytes (the SERVER does that, by digest, over the allowlisted skopeo channel — the runner has NO network)".

PER-RUN, SINGLE-REPOSITORY, SHORT-LIVED — AND EXPLICITLY REVOKED
"Repository-write credentials are issued per run, scoped to the single repository under change, and are never standing credentials." Every clause of that is a line of code below:

```text
ISSUED PER RUN      — `mintScopedRepoToken` runs inside `RepoWriter.withRunCredential`,
                      once per run, and the token never leaves that scope. It deliberately does
                      NOT reuse `@scp/plugin-github`'s module-level `installationTokenCache`:
                      that cache is correct for a read-mostly coordination plugin and exactly
                      wrong here, because a cached token is a token that outlives its run.
SCOPED TO ONE REPO  — the mint body pins `repositories: [<repo>]`. Without it the mint returns a
                      token valid for EVERY repository the App is installed on, which is the
                      standing-credential shape wearing a short-lived name.
NARROW PERMISSIONS  — `contents: write` + `pull_requests: write`, and nothing else. No
                      `workflows`, no `administration`, no `checks`.
SHORT-LIVED         — GitHub caps an installation token at one hour; nothing here extends one.
NEVER STANDING      — `revokeScopedRepoToken` deletes it in the `finally`, so the
                      credential is dead when the run ends rather than merely expiring later.
```

The STANDING secret remains the App private key, which is NOT a repository-write credential and is the same secret `@scp/plugin-github` already holds behind the same vaulted AES-256-GCM `SecretsAccessor`. That is why the GitHub App flow is the only arm implemented: a personal access token cannot be minted per run or scoped to one repository, so wiring one would deliver the FEATURE by removing the CREDENTIAL CLAUSE that authorises the feature to exist. See `resolveRepoWriter` for the refusal that says so by name.

### §324. The operations available WHILE the run's credential is alive

The operations available WHILE the run's credential is alive. There is no general-purpose repository write behind this interface: one read of one path, one publish of one edited file as one pull request, and one merge of a pull request this same class authored.

### §325. MERGING IS A SECOND, NARROWER AUTHORITY

MERGING IS A SECOND, NARROWER AUTHORITY — AND IT IS EXPRESSED AS ITS OWN INPUT SHAPE
Until M21.5's auto-merge link, the only merge in the tree was the tail of `PublishBumpInput` — reachable only by a run that had just authored the commit it was about to merge. That is the wrong shape for the charter clause it has to satisfy: "automatic merge is permitted only where a governed control evidences that the component's OWN checks passed". Evidence names a COMMIT, and a commit a run just created cannot have been evidenced before the run started.

So the merge exists separately, and every field here is a narrowing rather than a parameter:

* `target.headBranch` is NOT free text. The caller composes it from the originating change's id (`index.ts`'s `bumpBranchFor`), and the server takes that id from the SERVER-OWNED `dependency_bump_authorships` row for that change. A branch name arriving from anywhere else is how this authority would become "merge whatever you are told to". * `pullRequestNumber` IS THE ADDRESS, and it replaced a search. This action used to LIST open pull requests filtered on `head=owner:<branch>` and merge `list.body[0]`: WHICH pull request got merged was therefore provider list ordering, and nothing ever read its base. Anyone with write or triage on the repository could retarget SCP's pull request, or open a second one from SCP's branch against a protected branch, and this would merge a tree the governed grant never authorised. So the merge is addressed to the pull request SCP ITSELF OPENED, by the number SCP recorded when it opened it — a fact SCP asserted, not one read back out of the provider. * `target.baseBranch` is COMPARED, not merely carried. It used to be asserted and then discarded: never sent, never checked. The pull request's OWN `base.ref` must equal the base the governed grant was about, or the merge refuses. Same for its `head.ref` and its open state — a pull request a human has closed is a human's decision about this bump. * `expectedHeadCommit` is the PRECONDITION, not a label. It is sent as the provider's merge `sha` parameter, which refuses the merge unless the pull request's head is exactly that commit — so "the tree that merged is the tree the control passed" is enforced by the provider rather than by this process's belief about what the branch is at. A push that landed on the branch between the evidence and this call therefore REFUSES the merge instead of merging an unevidenced tree.

The four together are one rule: EVERY INPUT TO A MERGE IS A FACT THE SERVER RECORDED, and the only thing taken from the provider is a yes/no about whether its own state still matches them.

### §326. What one publish needs

What one publish needs — and note what it CANNOT express: content without a proof.

`proof` is not documentation. It is an HMAC minted only by `write-guard.ts`'s `verifyManifestOnlyEdit`, over a key no other module holds, bound to the exact bytes in `content` and to `spec.manifestPath`. `createGithubAppRepoWriter` re-checks it before any request, so content that did not pass verification is STRUCTURALLY unable to reach a repository — the difference between "the actuator is supposed to check" and "it cannot not have checked".

### §327. Required when delivery is auto-merge, per the charter

REQUIRED when `delivery === "auto_merge"`, and the requirement is the charter clause.

The server grants `auto_merge` on a governed control's evidence, and that evidence names one commit — the one the bump's branch was at when the control ran. This publish may itself move the branch (a redelivered dispatch re-PUTs the manifest), and a merge of a commit the control never saw is precisely "green somewhere else used as proof that here is green". Passing it through as the provider's merge precondition means such a run REFUSES the merge and leaves the pull request open, rather than merging an unevidenced tree.

### §328. The provider arm

The provider arm. `withRunCredential` is the ONLY entry point, and its shape is the credential clause made structural: the token is minted on entry, is reachable only through the session handed to `fn`, and is revoked on exit whether `fn` succeeded or threw. There is no way to obtain a session — and therefore no way to write — outside one bounded run.

### §329. GitHub App JWT

GitHub App JWT — lifted in SHAPE from `@scp/plugin-github`, deliberately not imported from it. A plugin package depending on another plugin package would have the subprocess host load two modules for one instance; `managed-scan` carries its own copy of what it needs for the same reason and says so.

### §330. Mint the run's credential

Mint the run's credential. NOT cached, by construction and by comment: a cache here would be the "never standing" clause failing silently, and a reader who saw a cache lookup would have no way to know it was the thing the charter forbids.

### §331. The commit subject and pull-request body are derived

The commit subject and pull-request body are DERIVED, not passed in.

That is a deliberate narrowing rather than a convenience. If the server — and through it a tenant policy document — could supply the message, this seam would carry caller-controlled text into a repository write, and "never authors any other content" would depend on whoever populated that field. Deriving them means the only tenant-derived strings reaching the repository are the coordinate and the two versions, all three of which already appear in the manifest being edited.

### §332. The open pull request from head into base, or undefined

The OPEN pull request from `headBranch` INTO `baseBranch`, or `undefined`.

BOTH REFS ARE COMPARED, not just the one the query filters on. `head=owner:<branch>` is a provider filter and `list.body[0]` is provider ORDERING; taking the first entry and using it means whichever pull request the provider happened to list first decides what this class acts on, and its base was never looked at. One branch can legitimately have several open pull requests against several bases, and anyone with write or triage on the repository can create the second one.

Only the publish path's duplicate-detection uses this. The MERGE addresses a pull request by the number the server recorded — see `MergeAuthoredBranchInput`.

### §333. THE ONE MERGE CALL IN THE TREE

THE ONE MERGE CALL IN THE TREE. Both the publish tail and the standalone merge action reach the provider through here, deliberately: a second merge implementation is the same class of mistake `write-guard.ts`'s header records for the URL validators — a fix applied to an instance rather than to the property — and the property here is "a merge is conditioned on the evidenced commit".

`sha` is what makes that structural. GitHub's merge endpoint documents it as the SHA the pull request's head must match for the merge to be allowed, so a branch that moved between the control run and this call yields a 409 and an OPEN pull request instead of a merged one. The precondition is asserted full-length (`assertWriteCommit`) because an empty or abbreviated value would be dropped or never match, and either way stops being a precondition.

A provider refusal — branch protection, a required review, a check that went red since the gate — is REPORTED, never retried into a force-merge and never reported as if it had merged.

### §334. BEFORE THE MINT, not merely before the write

BEFORE THE MINT, not merely before the write. `repo` is spliced into the mint body and into every route below, so validating it here is what makes an adversarial repo cost ZERO HTTP requests — including the App-JWT → installation-token exchange, which is itself a request that would otherwise happen first. Exactly two segments: this arm addresses `owner/repo`, and a third segment is a different route.

### §335. EVERY REFUSAL, BEFORE THE FIRST REQUEST OF THE PUBLISH

EVERY REFUSAL, BEFORE THE FIRST REQUEST OF THE PUBLISH. Order is the enforcement: nothing partial can be left behind by a refusal, because a refusal happens before a branch exists. The matrix in `repo-write.matrix.test.ts` MEASURES the zero with a counting client rather than inferring it from an absent interceptor.

### §336. The prose alongside the edit is derived, never passed in

The prose SCP writes alongside the edit is DERIVED here, never passed in (see `bumpCommitMessage`/`bumpPullRequestBody` for why that is a narrowing rather than a convenience) — but derived is not the same as bounded: it is composed from a coordinate and two version tokens, all tenant-controlled, so its LENGTH is not something this module gets to assume. The one string serves as BOTH commit subject and pull-request title, so both bounds are asserted over it and the tighter of the two governs.

### §337. Auto-merge, which means a control already evidenced it

6. AUTO-MERGE. Reaching here already means a governed control evidenced this component's own checks passed — the SERVER decided that, with the existing gate machinery, before this plugin was dispatched (see `index.ts`, "AUTO-MERGE IS NOT DECIDED HERE"). This call actuates that decision; it is never a second judgement of it. It IS conditioned on the evidenced commit, so a publish that moved the branch away from it refuses.

### §338. MERGE AN ALREADY-AUTHORED BUMP

MERGE AN ALREADY-AUTHORED BUMP. The narrowest write this class has, and the only one that is reachable without an edit.

Everything it touches is re-asserted at the splice site, exactly as `publishBump` does and for the same reason `write-guard.ts`'s header gives: `repo` and the branch names are part of REST routes, `encodeURIComponent("..") === ".."`, and validation — not encoding — is the control. `assertBranchIsNotBase` is not defence in depth here either: a caller that managed to name the base branch as the head would ask the provider to merge `main` into `main`, and the refusal names that rather than letting the provider return something ambiguous.

THE PULL REQUEST IS ADDRESSED, AND THEN ITS OWN BASE IS CHECKED
This used to LIST open pull requests filtered on `head=owner:<branch>` and merge `list.body[0]`. Two things were wrong with that and they are the same thing twice: WHICH pull request got merged was provider list ordering, and its BASE was never read — the `baseBranch` the caller passed was asserted and then discarded, never sent and never compared. So an open pull request from SCP's branch to `production`, while the governed grant was about `main`, merged; and it recorded a `merged` Decision naming `main`. Anyone with write or triage on the repository can retarget a pull request or open a second one from a branch they can see.

Now: the merge is addressed to the number the SERVER recorded when SCP opened the pull request, and the provider's description of that pull request must agree with every fact the grant was about — it is OPEN, its head is the branch this change authored, and its base is the base the grant named. Each disagreement is its own refusal with its own sentence, because "it did not merge" is not an operator-actionable answer.

NO OPEN PULL REQUEST IS A REFUSAL, NOT AN INVITATION TO OPEN ONE. This action never authors: if the pull request the bump opened has been closed by a human, that is a human's decision about this bump and the merge stops there.

### §339. Choose the provider arm, or REFUSE BY NAME

Choose the provider arm, or REFUSE BY NAME.

Gitea and GitLab are absent deliberately. Both can be written to with a token — which is exactly the problem: the tokens either provider offers today are STANDING credentials scoped to a user or a group, and the amendment authorising this class says repository-write credentials are "issued per run, scoped to the single repository under change, and are never standing credentials". Shipping a Gitea arm on a standing token would deliver the feature by removing the condition under which the feature is permitted to exist. So the refusal names the MISSING THING rather than the missing provider.

## `packages/plugins/managed-dep/src/runner-containment.test.ts`

### §340. THE CHARTER'S RUNNER/ORCHESTRATOR SPLIT, MEASURED

THE CHARTER'S RUNNER/ORCHESTRATOR SPLIT, MEASURED (charter `scp-managed-dep`, amended 2026-08-15)
The 2026-08-15 amendment states the split in two sentences:

```text
"Runner network egress is `--network none`; the runner holds no credential, contains no package
 manager, and edits only the bytes handed to it."
"The orchestrator holds the per-run, repository-scoped, short-lived credential and reaches the
 git provider on the runner's behalf."
```

Both halves were previously only DOCUMENTED here. A comment describing a containment property is not the property; this file drives a real `trigger()` with every `docker` invocation mocked (so it runs on every PR under `pnpm test`, no Docker required) and asserts what the container was actually launched with — the same shape, and the same reason, as `@scp/plugin-managed-scan`'s shipped `index.test.ts` containment block.

WHAT EACH ASSERTION IS FOR, since a list of `expect`s is not self-explaining: - `--network none`      — the runner reaches no hosts. Without it, "never resolves a lockfile" stops being a property of the image and becomes a hope. - no `-v`/`--mount`, no docker.sock — nothing of the host is reachable from inside, so a path-escape in the editor has nowhere to escape TO. Bytes go in and out by `docker cp`. - no `-e`/`--env`, and the token appears in NO argv — the credential does not cross into the runner. This is the half the amendment had to be qualified for, so it is the half most worth measuring. - argv is exactly the five descriptor strings — seven for a split shape, where the last two are the M21.7 anchor (a line number and that line's own bytes). Nothing on that command line can be a file body, a host path, or a command; the anchor text is one line the container already holds in the file it was handed, and the shim only ever COMPARES it. - the ORCHESTRATOR made the provider calls — the credential is used, but on this side of the boundary. Asserted positively so "no network in the runner" cannot be satisfied by there being no network anywhere.

### §341. The argv-driven stand-in runner for the split-shape block

THE ARGV-DRIVEN STAND-IN RUNNER, used by the split-shape block below.

With `editedOutput` set, the mock writes a fixed string and the docker argv is decorative — which is fine for the hostile-output cases, and useless for proving the orchestrator SENT something. With it `undefined`, the mock instead reconstructs the bump spec FROM THE `docker create` ARGV, reads the bytes that were copied in, and applies the reference edit. That is what makes the anchor's wiring load-bearing: delete the two operands from `runEditorContainer`, or delete the `locateVersionLine` call that produces them, and the reference edit has no anchor, refuses the split shape, and a NAMED test below goes red.

### §342. M23.1 PHASE 4 — the reaper

M23.1 PHASE 4 — the reaper. `reap()` now runs at the top of every `run()`, issuing a `docker ps -a --filter label=...` before `create` and stamping two more `--label` pairs onto every `create` it issues. Neither is this file's subject, so both are kept out of `dockerCalls` entirely: the `ps` call is answered with an empty listing and never recorded, and the two labels are stripped off `create`'s argv before it is recorded — the "EVERY container it launches is NAMED AND LABELLED" test below still needs to see the PLUGIN's own two labels untouched.

### §343. THE SWEEP THAT CATCHES A FOURTH MANAGED PLUGIN FOR FREE

THE SWEEP THAT CATCHES A FOURTH MANAGED PLUGIN FOR FREE.
This used to check `-e`/`--env` and the joined command line. Since the port grew a `secretEnv` that Docker delivers through `--env-file`, "no `-e`" is no longer the whole of "no credential reaches the runner": a plugin could pass a credential with no `-e` anywhere in sight. Both delivery mechanisms are named here, and the value sweep runs over every ELEMENT of every argv rather than over the joined line — a joined line cannot say WHICH argument carried the secret, and its failure message is a wall of text nobody reads.

IT IS ALSO THE ONLY ASSERTION HERE THAT DOES NOT NEED UPDATING WHEN A NEW SECRET APPEARS: it iterates the credentials this test knows the orchestrator actually resolved.

### §344. This assertion is the inverse of what it was, per the charter

THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, and the reversal is the charter rather than a change of mind. It previously mirrored `managed-scan`'s "honours the server-injected networkMode" — correct THERE, because the 2026-07-23 amendment QUALIFIES that class's network clause ("excepting operator-allowlisted registry pulls for the subject artifact's bytes"), so an operator setting is exactly what the charter contemplates for it.

The `scp-managed-dep` clause carries no such qualifier: "Runner network egress is `--network none`; the runner holds no credential, contains no package manager, and edits only the bytes handed to it" (2026-08-15). An operator-settable knob with a `none` default is an operator-facing way to contradict an unqualified clause, so the value is a LITERAL (`RUNNER_NETWORK_MODE`) and `SCP_MANAGED_DEP_NETWORK_MODE` is now read by nothing.

### §345. The first verifier is load-bearing, proven by one case

THE FIRST VERIFIER IS LOAD-BEARING, proven by a case only IT can catch.

The runner returns a perfectly well-formed manifest that bumps the right dependency to the WRONG version. `verifyManifestOnlyEdit` accepts it — and is right to: every one of its gates holds (the dependency set is identical, exactly one already-declared version moved, the change is confined to that version's own text). It has no idea which version was ASKED for; that fact lives in the descriptor, which is what `verifyManifestBump` anchors on.

This case exists because a mutation run found the gap: deleting the runner-output verdict check left the earlier "added a dependency" case green, since the second verifier caught that one anyway. A refusal that another layer would have caught is not evidence that this layer works.

### §346. The split shape end to end, and the wiring gate on the anchor

M21.7 — THE SPLIT SHAPE, END TO END, AND THE WIRING GATE ON THE ANCHOR
Everything below drives the REAL `trigger()` against a chart's `values.yaml` whose coordinate and version are on different lines. The stand-in runner is argv-driven here (`editedOutput = undefined`), so it can only produce bytes if the orchestrator actually SENT an anchor — which is the delete-the- wiring gate this milestone's standing rule asks for:

```text
* delete the two operands from `runEditorContainer`'s `docker create` argv → the stand-in runner
  has no anchor, the reference edit refuses, and "authors the bump" below goes red;
* delete the `locateVersionLine` call in `trigger()` → the spec carries no anchor, the operands
  are not appended, and the same test goes red;
* delete `verifyManifestBump`'s anchored branch → the runner's bytes are refused and the same
  test goes red with `wrong_declaration_changed`.
```

A component built and never installed is this repository's dominant failure, and a suite that reached `applyManifestBump` directly would be green with all three of those deletions in place.

## `packages/plugins/managed-dep/src/runner-image.integration.test.ts`

### §347. The four charter clauses, asked of the built artifact

M21.5 — THE FOUR CHARTER CLAUSES, ASKED OF THE BUILT ARTIFACT
The `scp-managed-dep` amendment (2026-08-13, qualified 2026-08-15) says of the runner:

```text
"never runs a package manager" / "never resolves or regenerates a lockfile" /
"never builds, compiles, or tests" / "the runner contains no package manager"
```

Every one of those is a statement about what the image CONTAINS. `runner-image.test.ts` reads the Dockerfile and the shim, which is the right cheap gate and is structurally blind to the base: it can say what this build ADDS and never what it INHERITED. That blindness was measured, not imagined — the base used to be a build ARG holding a mutable tag, so `docker build --build-arg RUNNER_DEP_BASE_IMAGE=node:22 apps/runner-dep` produced an image tagged as the vetted runner with a full Node toolchain inside it, and the "is pinned" assertion passed on the unchanged text.

So this file BUILDS the image (or pulls the pre-built one in CI) and interrogates the artifact: every forbidden tool is looked for on the container's PATH and across its filesystem, and the shim is exercised as the orchestrator actually launches it — `--network none`, argv only, bytes in and out by `docker cp`. A future edit that adds a toolchain "just for one ecosystem" fails here even if it never touches the Dockerfile's text, because the base changed underneath it.

Needs a reachable Docker daemon — excluded from `pnpm test` (vitest.config.ts), run via `pnpm test:integration` in the CI integration-shard job (which pre-pulls `SCP_RUNNER_DEP_IMAGE_REF`, built once per content change by ci.yml's `runner-images` job). SKIPS CLEANLY, and loudly, when no daemon is present — the same shape `tools/helm-verify` uses, so a laptop without Docker does not red the suite.

### §348. Runs a command inside the image with no network

Run a shell command INSIDE the runner image, `--network none`, and return its stdout.

A SENTINEL is appended and asserted, and that is not belt-and-braces: this image deliberately contains only seven applets, so a script reaching for an eighth (`ls`, `find`, `grep`) does not fail the test — the missing command writes to stderr, the pipeline yields nothing, and an assertion of the form "nothing forbidden was found" passes for the wrong reason. The first draft of the filesystem scan below did exactly that. Requiring the last line to arrive means a script that died half way through is a failure rather than a clean bill of health.

### §349. Paths the Docker daemon injects into every container

Paths the docker DAEMON injects into every container it creates, whatever the image holds. They are not image content and are subtracted below.

Enumerated rather than pattern-matched, so a NEW injected path fails the exact-set assertion and gets looked at — an `/etc/**` filter would swallow a real addition just as happily.

### §350. Every path the runtime IMAGE contributes

Every path the runtime IMAGE contributes: the container filesystem exported to the HOST, minus `DAEMON_INJECTED`. Files only — directories are structure, not content.

Nothing inside the image is used to answer this, which matters more here than usual: the image deliberately contains no `find`, `ls` or `grep`, so an in-container scan does not fail loudly, it produces NO OUTPUT — and "nothing forbidden was found" then passes for the wrong reason. The first draft of the scan below did exactly that.

### §351. Every executable name that would mean a toolchain

Every executable name that would mean a package manager, a build tool or a language runtime is IN the image. Two of these are worth naming: `go` is both a language runtime and the resolver for one of the five ecosystems, and `node` is what the ARG-override defect actually put here.

### §352. The strong form the others are a convenience over

THE STRONG FORM, and the one the others are a convenience over: the ENTIRE contents of the runtime image, read by exporting the container filesystem to the HOST. Nothing inside the image answers this question, which matters here more than usual — the image contains seven applets, so an in-container `find` does not exist, and the first draft of this test scanned with one and passed by producing no output at all.

Asserted as an exact set rather than as a denylist. A denylist can only refuse what somebody thought of, and the two package managers this image actually shipped (`dpkg` and `rpm`, applets of a stock BusyBox) were ones nobody had.

### §353. THE RESIDUAL, PINNED RATHER THAN LEFT AS PROSE

THE RESIDUAL, PINNED RATHER THAN LEFT AS PROSE. BusyBox is a MULTI-CALL binary: the code behind `dpkg` and `rpm` is still inside `/bin/busybox`, and `busybox dpkg` still dispatches to it even though no such NAME exists in the image. Removing that needs a custom-compiled BusyBox — a C toolchain in the build of the one image whose whole argument is that it has no toolchain — which is a strictly worse trade.

The bound is asserted so nobody reads the exact-tree test above as more than it is, and so the day BusyBox drops those applets (or the base is swapped for one without them) this comment is updated deliberately rather than silently becoming false.

### §354. THE SHIM, AS THE ORCHESTRATOR ACTUALLY LAUNCHES IT

THE SHIM, AS THE ORCHESTRATOR ACTUALLY LAUNCHES IT. `runner-shim.test.ts` runs `run.sh` with the host's `sh`, which proves the AWK program and is blind to whether the image can host it (a BusyBox `awk` is not GNU awk). This runs the real ENTRYPOINT in the real image, with the real `--network none`, and moves bytes the only way the orchestrator does: `docker cp` in and out.

### §355. M21.7 — THE ANCHORED PATH, IN THE REAL IMAGE'S OWN awk

M21.7 — THE ANCHORED PATH, IN THE REAL IMAGE'S OWN awk.

`runner-shim.test.ts` proves the anchored program against the HOST's awk (BWK awk on a Mac, GNU awk in CI). BusyBox awk is a third implementation, and the two things this rule leans on that the unanchored one did not are exactly where implementations differ: an integer compared against `NR`, and a NUMERIC value used as an array subscript (`lines[anchor_nr]`, which converts through CONVFMT in some awks and as `%d` in others). If BusyBox rendered `5` as `5.00000`, the anchor would address nothing, every split-shape bump would refuse in production, and every unit test would stay green. So the claim is measured against the artifact rather than reasoned about.

## `packages/plugins/managed-dep/src/runner-image.test.ts`

### §356. The charter clauses that are properties of the image

M21.5 — THE FOUR CHARTER CLAUSES THAT ARE PROPERTIES OF THE `scp-runner-dep` IMAGE.

WHAT THIS IS FOR
Four clauses of the `scp-managed-dep` amendment were, until the image existed, asserted in code comments and delegated to an artifact that was not built:

```text
"never runs a package manager" / "never resolves or regenerates a lockfile" /
"never builds, compiles, or tests" / "the runner contains no package manager" (2026-08-15)
```

None of them is enforceable by the orchestrator's restraint — they are true only if the image genuinely has no toolchain in it. So the assertions below read the Dockerfile and the run shim and fail on the presence of one, which is the closest a unit test can get to the property without a docker daemon. `apps/runner-scan`'s `pin.test.ts` is the precedent for this shape.

WHAT THIS FILE STRUCTURALLY CANNOT SEE, AND WHERE THAT IS COVERED
A source-text test can say what this Dockerfile ADDS. It cannot say what the BASE brought in — and the clauses are about what the image CONTAINS. That gap was not theoretical: the base used to be a build ARG carrying a mutable TAG, so `docker build --build-arg RUNNER_DEP_BASE_IMAGE=node:22 apps/runner-dep` yielded an image tagged as the vetted runner with a full Node toolchain in it, and the assertion below that "pins the base" passed on the unchanged text.

Both halves of that are now closed, and neither closes the other: the base is a LITERAL digest-pinned `FROM` (no ARG to override, no tag to move), and `runner-image.integration.test.ts` BUILDS the image and asks the artifact whether a package manager, compiler or language runtime is present. This file keeps the drift gate against `tools/busybox/pin.env` — the cheap check that runs on every machine — and stops claiming to be the proof.

The remaining complement — that the shim produces the SAME bytes the orchestrator's verifiers were written against — is `runner-shim.test.ts`, which runs it.

### §357. Commands are scanned, so three things are stripped first

What is scanned is COMMANDS, so three things are stripped first and each for a stated reason: comments (prose about what is NOT here would trip every assertion), double-quoted strings (the refusal message names the five ecosystems, one of which is literally `npm`), and `case` arm LABELS (`go|oci|npm|python|maven)` is the ecosystem validation, not an invocation). What remains is what the shell would actually execute.

### §358. `manifestPath` names a path in somebody's REPOSITORY

`manifestPath` names a path in somebody's REPOSITORY. This container has no repository, so a path there could only address the container's own filesystem; refusing to treat it as a path is what keeps that true. ANCHORED, and the reason this file is in the M21.7 sweep at all: these two were the last raw-text PRESENCE assertions here, so commenting out `IN=in/manifest` in run.sh left this file green at 22/22 — measured — while its own comment above correctly named the property and its Dockerfile reads handled it. A well-written note naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md).

## `packages/plugins/managed-dep/src/runner-launcher-selection.test.ts`

### §359. The standing gate that adapter selection is installed

M23.2 — THE STANDING GATE THAT ADAPTER SELECTION IS *INSTALLED*, NOT MERELY BUILT.

`launcher-seam.test.ts` proves this plugin launches through the injected `RunnerLauncher`, and every one of its cases injects a resolver. That is precisely why it CANNOT prove this: production injects nothing. `apps/server/src/plugin-host/subprocess-entry.ts` constructs this plugin as `createManagedDepExecutorPlugin()` — no argument — so the DEFAULT PARAMETER is the whole of the production wiring, and a test that always passes its own resolver never touches it.

That is this repository's dominant defect class, named in CLAUDE.md: a component built, tested through a seam that bypasses the wiring, and installed nowhere. It has happened six times in one session, including a live RCE on main. The only check that works is to delete the wiring and watch a NAMED test die — so this file constructs the plugin with NO ARGUMENT and requires the Kubernetes adapter to be reached. Revert the default parameter to `resolveDockerRunnerLauncher` and this dies; nothing else in the repository does.

### §360. No process is spawned on the Kubernetes path

M23.6 CLAUSE 1 — NO PROCESS IS SPAWNED ON THE KUBERNETES PATH
The clause asks for the recorded SPAWN, not a mock's call count, "so a renamed binary cannot pass it". `runnerSpawns()` records the binary as it was handed to `execFile` and nothing else in the package can start a process — `no-docker-on-kubernetes.test.ts` censuses that. Measured before the ledger existed: a real `execFile(dockerBinary, ["version", …])` in `resolveRunnerLauncher`'s KUBERNETES branch left the whole workspace green.

### §361. Never constructed, which is stronger than never called

M23.6 CLAUSE 7 — NEVER *CONSTRUCTED*, WHICH IS STRONGER THAN NEVER CALLED
The `io is NEVER touched` case above is a statement about CALLS. Measured: making the Docker branch of `resolveRunnerLauncher` build `createFetchKubernetesIo(...)` AND `createKubernetesRunnerLauncher(...)`, discard both and return the Docker launcher left `pnpm -w test` green (72/72). This arm is what that mutation now fails.

### §362. M23.6 CLAUSE 1, BEHAVIOURALLY

M23.6 CLAUSE 1, BEHAVIOURALLY — THE SPAWN IS OBSERVED FROM OUTSIDE THIS PROCESS

WHY THE LEDGER ARM ABOVE IS NOT ENOUGH, MEASURED. `runnerSpawns()` records what goes THROUGH `spawnRunnerProcess`. A real `child_process.execFile(dockerBinary, …)` on the Kubernetes path goes nowhere near it: planted in `resolveRunnerLauncher`'s Kubernetes branch it left this file, its two siblings and the whole workspace GREEN while fourteen processes were actually created. What caught it was a source census — and a census proves the presence of TEXT, never the absence of an EXECUTION, which is this repository's most expensive standing confusion.

SO THIS CASE RUNS THE PLUGIN IN A CHILD `node` whose `node:child_process` was wrapped before the plugin loaded, and asserts over the processes that were actually created. It carries its OWN control in the same child, in order: the Kubernetes trigger first (nothing may be created), then a Docker trigger (something must be), so an observer that had silently stopped observing fails the second half rather than passing the first.

THIS PLUGIN IS THE ONE THAT WRITES TO A USER'S REPOSITORY, so its context is the real recording one from `write-test-support.ts` — imported as built `dist` alongside the plugin — rather than a stub that would let the run terminate before it ever reached a launcher.

### §363. M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT

M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT: the `io` THIS SUITE ALWAYS INJECTS

Every case above hands the plugin a `kubernetes.io`. `resolveRunnerLauncher` reads it as `k8s.io ?? createDefaultKubernetesIo(…)`, and the right-hand side of a `??` is not evaluated when the left is present — so the transport the resolver builds FOR ITSELF, which is the only one production ever gets, was evaluated by no test in this repository.

MEASURED, NOT SUSPECTED. A `spawnSync(config.dockerBinary ?? "docker", ["version"])` planted on that right-hand side, in a NEW module so that no `node:child_process` string appears in `kubernetes-adapter.ts` for the source census to find, executed a REAL `docker version` while `@scp/runner-launcher` reported 427/427 and the three managed plugins reported 38 + 50 + 255 — every suite green, including the observed case above. A marker file proved the probe was reached rather than merely present.

So this case injects NOTHING: no `io`, and NO `dockerBinary` either. The Kubernetes adapter is not given a container binary in production and must not need one, so with the field absent the only name a probe can reach for is `DEFAULT_DOCKER_BINARY` — and the assertion is simply that this child created no process at all, with no binary name guessed in advance.

TWO THINGS MAKE THE EMPTY LIST MEAN SOMETHING, because a green negative arm was already worthless once: `kubernetesConstructionCount()` must move by TWO (the launcher AND the transport the resolver built — an injected `io` makes it one, which is what every case above produces), and the run must fail naming the projected service-account token path, which is proof the resolver's own `readToken` closure actually executed. The observer's own liveness is then proven in the SAME child by a deliberate spawn at the end.

## `packages/plugins/managed-dep/src/runner-shim.test.ts`

### §364. The shim and the reference edit produce the same bytes

M21.5 — THE RUNNER SHIM AND THE REFERENCE EDIT PRODUCE THE SAME BYTES.

WHY THIS IS NOT OPTIONAL
`bump-edit.ts`'s `applyManifestBump` is the REFERENCE edit, and it is what every other test in this package uses as a stand-in runner. That makes the whole orchestrator suite conditional on a claim nothing checked: that `apps/runner-dep/run.sh` — the thing that actually runs in production — agrees with it. If it does not, every bump is REFUSED by `verifyManifestBump` at run time while the suite stays green, which is the "vacuous test" shape this repository has shipped before.

So this runs the real shim, over the real fixtures, and requires BYTE-IDENTICAL output. It uses `/bin/sh` and the host's `awk`; the production image is BusyBox and the script is POSIX throughout, with no GNU-only constructs (no `sub()`/regex matching, no `-v`, no `sed -i`).

The trailing-newline case is the one worth naming: awk always terminates its last record with a newline, so a manifest that had none would come back one line longer and be refused by `verifyManifestBump` with `line_count_changed` — a refusal an operator could do nothing about. The shim restores the input's own byte shape, and the fixture below is what proves it.

### §365. Run the shim exactly as `runEditorContainer` does

Run the shim exactly as `runEditorContainer` does: five argv strings and the file at /work/in — plus the anchor pair when, and ONLY when, the spec carries one. The conditional append is the production shape, not a test convenience: it is what makes an image that predates the anchor receive a byte-identical five-operand command line (`run.sh`'s "VERSION SKEW" table).

### §366. M21.7 — the ANCHORED cases

M21.7 — the ANCHORED cases. Both implementations changed for these, so both must be compared, and the REFUSALS are compared too: agreement on the happy path is the half a fixture list gets for free, and a shim that "helpfully" edited where the reference refuses would be a wrong edit in somebody's repository that no test noticed.

### §367. A LINE NUMBER PAST EVERY AWK'S INTEGER RANGE

A LINE NUMBER PAST EVERY AWK'S INTEGER RANGE — the ONE input where the three implementations do not compute the same number. The shell validator accepts it (digits only, no leading zero), so it reaches awk, where `anchor_line + 0` is a float that `%d` clamps: at 2^63-1 under the host's awk, at 2147483647 under the BusyBox awk the image actually runs (both measured), while the reference simply indexes `beforeLines[1e20 - 1]` and gets `undefined`. All three must refuse.

WHAT THIS PINS, STATED HONESTLY: a PLATFORM property, not a code branch. No mutation of ours kills it — the case above is the one that kills the wrap mutation — and it is here because `run.sh` carried an explicit `anchor_nr > NR` guard that no mutation killed either, and it was deleted as dead code. Deleting a guard obliges someone to have checked the value range it nominally covered on every awk in play; this case is that check, kept permanently rather than done once and written into a comment.

## `packages/plugins/managed-dep/src/write-guard.test.ts`

### §368. `write-guard.ts` unit tests

`write-guard.ts` unit tests — the refusals that stand between a dependency subscription and a commit in somebody else's repository (M21.5, ADR-0032 §8, PROJECT_CHARTER `scp-managed-dep`).

RELOCATED, NOT REWRITTEN. These were built against the rival M21.5 branch's write hooks on `GitProviderAdapter`. The owner's 2026-08-15 decision kept the guard layer and moved it beside its one consumer, because where the HTTP happens is orthogonal to what may be written — so this file moved with it, whole. What did NOT move is the composed-path section: `proposeManifestBump` sequenced the three adapter hooks that no longer exist, and its property ("every refusal happens before anything leaves the process") is now proven where the requests actually are, with a counting client, in `repo-write.matrix.test.ts`.

Every test here asserts the structured `RepoWriteRefusalReason`, never the message prose. That is deliberate and it is what makes these mutation-proofs rather than wording pins: several refusals overlap on the same input (a `go.sum` target is BOTH a lockfile and not-a-known-manifest; a two-line edit is BOTH multiple-lines-changed and, usually, dependency-set-changed), so a test that only asserted "it threw" would stay green with the specific control deleted. The reason code is what distinguishes "the gate I am testing fired" from "some later gate caught it for me".

### §369. The DESTINATION every fixture below is verified for

The DESTINATION every fixture below is verified for. It is a shared constant rather than a per-test literal because `repo` and `headBranch` are now bound INTO the proof (a proof states that specific bytes may be written to a specific file on a specific branch of a specific repository), and the tests here are about the CONTENT gates — the destination binding gets its own block at the bottom.

### §370. The happy path first

The happy path first — every refusal below is only meaningful against a case that is ALLOWED. A suite of refusals with no negative control cannot tell "correctly strict" from "refuses everything", which is the vacuous-test shape.

### §371. A real bump in every ecosystem, since manifests differ

A real bump in EVERY ecosystem M21 parses, because the gates are shared but the manifests are not: `package.json` reports no `line` at all, `pom.xml` reports the line of the `<dependency>` OPEN TAG (several lines above the version it carries), and `Dockerfile` splits one literal `name:tag@digest` into two parsed fields. A gate tuned to one of those shapes and wrong for another would refuse a legitimate bump for a whole language — which is why the accept side is enumerated per ecosystem rather than sampled once.

### §372. The reason codes are what keep these two cases distinct

Distinct from the case above, and the reason codes are what keep them distinct: there the subscribed coordinate IS declared and something else moved (`coordinate_not_expected`); here the subscribed coordinate is absent from the manifest entirely, so there is nothing to bump. Both must be reachable — an ordering that made either unreachable would be dead code masquerading as a control.

### §373. The edit that is structurally perfect and a no-op

ADR-0032 §8i — THE EDIT THAT IS STRUCTURALLY PERFECT AND OPERATIONALLY A NO-OP.

Every other refusal in this file is about an edit that would change TOO MUCH. This one is about an edit that changes nothing that runs: where a declaration is pinned by a tag AND a digest, the runtime resolves by the digest, so moving the tag alone leaves the deployed bytes exactly where they were. Nothing errors, every gate above agrees, the pull request merges, and the image never moves — which is worse than a refusal, because a refusal is legible.

The condition is "the digest did not move", never "a digest exists": the accept case directly above moves both and must stay green, and it is what keeps this from being a rule that refuses every digest-bearing manifest.

### §374. The proof binds the destination, not just the content

THE PROOF BINDS THE DESTINATION, NOT JUST THE CONTENT
The stated guarantee is "content that did not pass verification cannot reach a repository". Bound to path + content alone, it was one field short of that: a proof minted for `acme/widgets`'s bump branch verified cleanly against a publish of the same bytes at the same path to a DIFFERENT repository, or to the BASE branch — the two destinations that matter, since one is somebody else's repo and the other is the branch the pull request was supposed to target.

### §375. The refusal reasons that had no test

THE REFUSAL REASONS THAT HAD NO TEST
`RepoWriteRefusalReason`'s own doc says each reason is "stated as its own reason with its own test rather than folded into a generic 'invalid request'". A census of the enum against the suites found three with no assertion anywhere: `multiple_versions_changed`, `unbumpable_constraint` and `message_too_large`. A reason nothing asserts is indistinguishable from a branch that cannot fire, which is the difference between a control and a comment — so the doc is now true rather than narrowed.

### §376. A git specifier names a location, not a version line

A `git+https://` npm specifier NAMES A LOCATION, not a registry version line, so its constraint is `unresolved` on BOTH sides — the ref inside it moved, which makes it the one changed declaration, and there is still no declared VERSION to bump. Reaching this reason needs exactly that shape: the subscribed coordinate must be the one that CHANGED (or `coordinate_not_expected` fires first) and its constraint KIND must be unchanged (or `constraint_kind_changed` does). That narrowness is why it had no test.

### §377. THE PER-ECOSYSTEM MAP, AS A FACT RATHER THAN AS PROSE

THE PER-ECOSYSTEM MAP, AS A FACT RATHER THAN AS PROSE.

`bump-edit.ts` and `index.ts` both carried "…which keeps the four working ecosystems untouched BY CONSTRUCTION", and it was false of three of them: `go`, `requirements*.txt` and Dockerfile all take the anchored branch. The claim was in a comment, so nothing could contradict it — and this milestone has already paid twice for a comment asserting a property the code lacks.

Enumerated here so the map is CHECKED. It goes red if a parser starts or stops reporting the line its version is written on, which is exactly the change that would silently move an ecosystem from one column to the other.

## `packages/plugins/managed-dep/src/write-guard.ts`

### §378. The refusals that are the condition of being allowed at all

`write-guard.ts` — **the refusals that are the condition of `scp-managed-dep` being allowed to write to somebody else's repository at all**, and the HMAC proof that makes them structural rather than advisory.

WHY IT LIVES HERE AND NOT IN `@scp/git-provider-core` (owner decision 2026-08-15)
M21.5 was built twice by two agents: once as write HOOKS on `GitProviderAdapter`, once as this managed executor. Two independent implementations of one authority is the hazard, so there is now one write path and it is this package's.

`GitProviderAdapter` went back to READ-ONLY, and the reason is ADR-0032 §9's own argument. §9 admits the adapter as an escape hatch on two grounds: the `ExecutorPlugin` object is unchanged, AND "It also only READS." Extending that same mechanism to writes contradicts half of its stated justification — it would put repository-write authority into a library every git-provider plugin loads, outside the charter's enumerated managed classes, where none of the containment preconditions bind. Inside `scp-managed-dep` they do: an isolated single-shot runner, a per-run single-repository credential, an enumerated class, an owner-approved amendment.

The GUARD LAYER built on that other path was the best thing in it and is orthogonal to where the HTTP happens, so it was kept whole and moved here, beside its one consumer (`repo-write.ts`).

WHAT AUTHORISES THE WRITE, AND WHAT IT COSTS
PROJECT_CHARTER.md's `scp-managed-dep` amendment (2026-08-13) admits ONE new managed class to the enumerated allowlist, narrowly defined as *editing the declared version of an already-declared dependency in a manifest the component already contains*. Every clause of that amendment is a precondition, not an aspiration, so every clause that can be enforced in code is enforced here:

- **never adds or removes a dependency** → `verifyManifestOnlyEdit` re-parses both sides with M21.2's parsers and refuses unless the dependency SET is identical element-for-element. - **never edits a file that declares no dependency** → the target must be a known manifest basename for its ecosystem AND a path the component's own inventory already declares. - **never resolves or regenerates a lockfile** → an independent lockfile refusal that does not depend on the manifest allowlist agreeing with it. - **never runs a package manager, never builds/compiles/tests** → structurally impossible from here: this module's only reach is `@scp/dependency-manifests`, whose every export is a pure function of a string with no I/O of any kind.

ADR-0002 §3 gate 5 ("single-shot ephemeral runner… no build farm, no compilation") and the anti-CI corollary are what make the lockfile line the boundary rather than a limitation: a class that needs lockfile resolution is CI by definition and is coordinated, never managed.

THE VERB SET DOES NOT CHANGE (ADR-0032 §9, charter principle 1)
A bump is an ordinary `trigger()`, exactly as an apply is for managed-iac and a scan is for managed-scan. `ExecutorPlugin` remains observe/trigger/status/abort — the four verbs ARE the structural enforcement of "coordination, not execution", so a fifth would remove the mechanism rather than extend it.

THE SAME URL-SAFETY PROPERTY AS THE READ PATH, WITH A WORSE BLAST RADIUS
M21.2's read path was hardened after two proven holes, both of the same property: a caller-supplied string spliced into a REST route re-targets the ROUTE, not just the resource, and `encodeURIComponent("..") === ".."` so encoding is not the control — a validator is. A `ref` of `../../../../user` reached `GET https://api.github.com/user` with the binding's credentials, and a raw `repo` of `acme/widgets?x=` terminated the route at a query string.

The write path splices the same three strings into routes, plus a fourth (the BRANCH NAME) and a body. It therefore inherits `assertSafeRepo`/`assertSafeRepoPath`/`assertSafeRef` VERBATIM from `@scp/git-provider-core` — those shipped with the read path, are shared with it, and the point of a census is to fix the property, not to write a second, subtly different validator. The wrappers below (`assertWriteRepo` and friends) exist only so the refusal carries a structured `RepoWriteRefusalReason` instead of a message that says "readFileAtRef", never to soften one. `assertWriteBranch` adds the three rules a BRANCH NAME needs on top of a ref's.

### §379. Why a proposed repository write was refused

Why a proposed repository write was refused. Every one of these is a REFUSAL, not a validation failure: the fallthrough of a bug here is a commit on a user's branch, so each is stated as its own reason with its own test rather than folded into a generic "invalid request".

The reason exists so tests can assert the refusal that actually fired instead of matching on prose. That is load-bearing for mutation-proving: `lockfile` and `not_a_known_manifest` both refuse `go.sum`, so a test that asserted only "it threw" would stay green with the lockfile check deleted — green for the wrong reason. Asserting the reason code fails the moment the specific control is removed.

### §380. Runs the read path's own assert, with a write-path reason

Runs the read path's own `assertSafeRepo` and re-throws its refusal with a write-path reason code.

The delegation is the point. `assertSafeRepo` is where the `..`-segment and `?`-termination refusals were proven and where the `[A-Za-z0-9._-]` charset lives; a second validator written for the write path would be the same class of mistake that produced those holes in the first place — a fix applied to an instance rather than to the property (CLAUDE.md, census-by-property). Only the message is restated, because `assertSafeRepo`'s says "readFileAtRef" and this is not a read.

### §381. Everything a ref refuses, plus three branch-name rules

Everything `assertSafeRef` refuses, plus the three rules a BRANCH NAME needs that a ref in general does not. Returns the reason prose, or `undefined` when the name is a plain branch name.

1. **No `refs/` prefix.** The create-branch call takes a plain branch name and composes `refs/heads/<name>` itself (GitHub's `POST git/refs` wants the fully-qualified ref in the body). A caller passing `refs/heads/x` would otherwise produce `refs/heads/refs/heads/x`. 2. **Not `HEAD`.** `HEAD` is a symbolic ref, not a branch; writing "the branch HEAD" is a request whose meaning depends on the server's current checkout. 3. **No leading `-`.** A branch name is echoed into git plumbing and CLI arguments downstream of SCP (the org's own CI, a maintainer's `git fetch`), where a leading dash is read as a flag. Refused here rather than escaped at each future consumer.

Factored out rather than inlined because BOTH branch names this class handles need it — the bump branch and the base branch — while carrying different reason codes. Two copies of these three rules is how one of them acquires a fourth.

### §382. The base BRANCH

The base BRANCH: what the bump is cut from and what the pull request targets.

Stricter than `assertWriteBaseRef` on purpose, and this distinction is the one place the relocation could have quietly lost a refusal. `assertSafeRef` is a rule about REFS IN GENERAL, so it permits `--force` (a legal, if unwise, ref name) — the leading-dash refusal is a BRANCH rule. The base of a bump is always a branch: it is looked up as `heads/<name>` and sent as a pull request's `base`. So it gets the branch rules, while keeping its own reason code, because "the base you named is not usable" and "the branch we would author is not usable" are different operator problems.

`assertWriteBaseRef` remains for the general ref position (reading a file at a ref), where a tag or a commit sha is a legitimate answer and a branch rule would be wrong.

### §383. The bump branch may never BE the base ref

The bump branch may never BE the base ref. Checked wherever both names are known, because it is the refusal that keeps the class "propose" rather than "apply": delivery is a pull request (PROJECT_CHARTER `scp-managed-dep`; ADR-0032 §8), and a commit written straight to the branch the pull request would have targeted is the default-branch write this whole design exists to avoid. Auto-merge is a separate, governed control over an OPEN pull request; it never becomes a direct write.

### §384. The commit id a MERGE is conditioned on. This is not URL safety

The commit id a MERGE is conditioned on.

This is not URL safety — the value is a request-body field, never a route segment. It is a PRECONDITION guard, and its shape is the control: GitHub's merge endpoint refuses the merge when its `sha` parameter does not equal the pull request's current head, which is the mechanism that turns "a governed control evidenced commit X" into "the tree that merged IS commit X". A shortened sha would not match that head and would fail the merge for the wrong reason (looking like a provider refusal rather than a malformed request), and an empty string would be dropped from the body and silently remove the precondition altogether — the fail-OPEN this exists to prevent.

Full-length hex only, both cases accepted (providers spell object ids either way), 40 for SHA-1 and 64 for SHA-256 repositories.

### §385. Lockfile basenames, refused outright

Lockfile basenames, refused outright.

This list is deliberately WIDER than the five ecosystems M21 parses. A denylist that only refuses has no cost for being generous, and the failure it prevents — SCP rewriting a resolved dependency graph it did not resolve — is the same failure in an ecosystem M21 has not reached yet.

The check is INDEPENDENT of the manifest allowlist rather than derived from it, which matters for a reason that is easy to talk yourself out of: today no lockfile could pass the manifest allowlist anyway (`go.sum` is not `go.mod`), so this looks redundant. It is not — the allowlist is about "is this the file we edit", the lockfile rule is about "is this a file we may never touch", and they answer to different clauses of the charter. Collapsing them would mean a future relaxation of the allowlist silently relaxes the lockfile boundary too.

### §386. The manifest basenames per ecosystem, and their parsers

The manifest basenames each ecosystem is edited THROUGH, and the parser that reads each one.

Two ecosystems need a per-basename decision rather than a per-ecosystem one, which is why this is keyed on the pair: `python` is `pyproject.toml` OR a `requirements*.txt` and those are different parsers with different contracts (`parseRequirementsTxt` is the one export in the package that never throws), and `oci` is spelled FIVE ways by TWO parsers — four Dockerfile spellings read by `parseDockerfile`, and a chart's `values.yaml` read by `parseKubernetesImages`. That second one is the reason the table is keyed on (ecosystem, basename) rather than on ecosystem alone: an image pinned in Helm values and an image pinned in a `FROM` are the same `dependency_lines` row, and only the file they were read out of differs.

Being an ALLOWLIST is the charter clause "never edits a file that declares no dependency" made structural. It is checked in addition to the component's own declared-manifest set, not instead of it: the declared set comes from the inventory projection tables, which are derived and high-churn, so a bug or a stale row there must not be able to widen what kind of file SCP writes. (They were also described as "per-domain" here, quoting ADR-0032 §3; §7d reverses that — they are derived on the commander only. It changes nothing about this allowlist's reason for existing, which is that a DERIVED set must not decide what SCP writes.)

### §387. M21.7 SPLIT-SHAPE ROUND

M21.7 SPLIT-SHAPE ROUND. A chart's `values.yaml` was inventoried but deliberately NOT writable, because `verifyManifestBump`'s clause 3 required the changed line to name the coordinate and in `image: {repository, tag}` it names it on the line above. That clause now has an anchored alternative (`locateVersionLine`, `bump-edit.ts`'s anchored branch), so the allowlist opens — and it opens on EXACTLY the basename the ingestion side registers (`inventory-ingestion.ts`'s manifest-candidate map: `["values.yaml", parseKubernetesImages]`). Not `values.yml`, not `*-values.yaml`: a path this allowlist admits and the inventory never reads is a file SCP would write into without ever having declared a dependency in it.

### §388. The parser for a (ecosystem, path) pair, or a refusal

The parser for a (ecosystem, path) pair, or a refusal.

Refuses BEFORE anything else looks at the content, and in this order — lockfile first, then the manifest allowlist — so the reason an operator is handed names the strongest rule the path broke.

### §389. The line a bump must edit: derived, never transported

The line a bump must edit, when the coordinate is not written on it.

DERIVED, NEVER TRANSPORTED. Nothing puts this on the wire, in `intent.parameters`, or in a database column: it is computed by `locateVersionLine` from the manifest bytes the orchestrator has just read at the base branch, and spent immediately against those same bytes. A line number captured at INGESTION and spent at ACTUATION would be a number derived from a read at one ref and applied to a read at another — a confidently wrong edit, which is the failure this module exists to prevent (`split-shape-image-bumps.md` §2.2).

`text` is what makes it safe to carry a number at all: it is COMPARED, never emitted. The edited line is always rebuilt from the file's own bytes, so a wrong or stale descriptor can only cause a REFUSAL, never a smuggled byte.

### §390. WHERE IS THIS DECLARATION'S VERSION WRITTEN?

WHERE IS THIS DECLARATION'S VERSION WRITTEN? — or `undefined`, which is never an error.

WHY THIS IS HERE AND NOT IN `bump-edit.ts`
`bump-edit.ts` is a refusal, and its header's central warning is that a per-ecosystem rewriter "that knew what a valid edit looked like would be a second implementation of the editor". A LOCATOR is exactly that: it chooses the edit target, and a bug in it makes a wrong edit ACCEPTED rather than a right one refused. So the structural knowledge stays in this file, which already owns `MANIFEST_MATCHERS` and already parses both sides of every edit — one parser table, one place, nothing to drift. What crosses into `bump-edit.ts` is DATA (a line number and its text) and one branch, not a format.

THE FIVE STEPS, AND WHY STEP 4 IS THE ONE THAT MAKES IT HONEST
1. The parser for this (ecosystem, path) — the SAME allowlist entry the verifier will use, so an unlisted basename or a lockfile never reaches step 2. Its refusal is swallowed here (this function never throws) because `verifyManifestOnlyEdit` re-asks and refuses properly; a derivation that threw would turn a missing anchor into a failure mode of its own. 2. The declarations whose coordinate AND declared version are exactly what the descriptor names. 3. Exactly one, or NO anchor. Zero means the manifest disagrees with the inventory; more than one means the target is ambiguous, and choosing would be a guess about which the subscriber meant. 4. It reports a line, and THE FILE'S OWN BYTES ON THAT LINE CONTAIN the declared version — else no anchor. This is what makes the derivation self-selecting rather than a per-format allowlist: `pom-xml.ts` records the line of the `<dependency>` OPEN TAG while the version sits several lines below it (the same fact this file's gate-5 comment already turns on), so a Maven declaration yields NO anchor and Maven's path cannot change. The anchor exists exactly where it is honest, by construction rather than by intention.

WHERE THAT LEAVES EACH ECOSYSTEM, enumerated because the useful claim is a map and not a slogan — "the working ecosystems are untouched BY CONSTRUCTION" was written here once and was false of four of them. AN ANCHOR IS DERIVED for `go` (go.mod), `python`'s `requirements*.txt` and `oci`'s Dockerfile: their parsers report the line the version is written on. NO ANCHOR is derived for `npm` and `python`'s `pyproject.toml` (steps 3–4: those parsers report no `line` at all) or for `maven` (step 4, above). What keeps the first three unchanged is therefore clause (c) of `verifyManifestBump` rather than the absence of an anchor: those parsers take the coordinate VERBATIM off the same line, so the anchor line names the coordinate too and is a candidate of the coordinate rule itself — the veto then admits it only when it is the sole candidate, which is the unanchored rule's own condition. The anchor cannot move the edit for them, because a line naming the coordinate is never a line the coordinate rule is silent about, and silence is the only gap an anchor fills. 5. It is not a MERGED multi-site entry (`DeclaredDependency.occurrences > 1`). One values file can pin `acme/api:1.2.3` in a Deployment and in a CronJob; the parser merges them because the inventory row merges, and editing one line would leave the other behind. Refused here rather than downstream because it costs no container run and yields a legible reason — gate 5 would catch it anyway (one declaration before becomes two after → `dependency_set_changed`), which is fail-closed but illegible.

ABSENCE IS NOT AN ERROR. A caller that gets `undefined` proceeds with the coordinate rule unchanged; that is why every ecosystem that works today keeps working without a special case.

### §391. The target must be a manifest the inventory already records

The target must be a manifest the component's own inventory ALREADY records — "a manifest the component already contains", in the charter's words.

Compared verbatim, with no normalisation: the inventory stores `manifest_path` exactly as the ingestion read it, and a comparison that trimmed, case-folded or resolved `./` here would accept a path the inventory does not actually hold. An empty declared set refuses everything, which is the correct answer for a component with no ingested manifests — absence is never permission.

### §392. Per-process HMAC key for {@link ManifestEditProof}

Per-process HMAC key for `ManifestEditProof`. Minted at import, never exported, never persisted.

This is what makes the proof a control rather than a label. A plain object — even a branded one — can be constructed by any caller with an `as` cast, so a `proof` field would document an intent without enforcing it. Signed with a key only this module holds, a proof can be minted ONLY by `verifyManifestOnlyEdit`, and `assertManifestEditProof` — which the write path calls before it issues the commit — refuses anything else. That is the difference between "the actuator is supposed to check" and "content that did not pass the check cannot reach a repo".

The key is per-process, so verifier and writer must run in the same process. They do: both are this package, loaded once into one plugin subprocess. If that ever stops being true the signature fails to verify and the write is REFUSED — the failure mode is closed, not open.

### §393. Evidence that an edited manifest passed verification

Evidence that a specific edited manifest passed `verifyManifestOnlyEdit`. Carried into the write and re-checked there.

It names the FACTS the verifier established, so a Decision can quote them (charter principle 6): which coordinate moved, from what to what, in which file. `contentSha256` is over the exact bytes that may be written — the proof does not travel with the content, it BINDS to it.

### §394. Which repository and branch these bytes were verified for

WHICH REPOSITORY AND WHICH BRANCH these bytes were verified FOR.

They are in the proof because the guarantee it states is "these bytes may be written", and a write has a destination. Without them the proof bound path + content and said nothing about where they were going, so a proof minted for `acme/widget@scp/dep-bump/<id>` verified cleanly against a publish to a different repository, or to the BASE branch, at the same path — the guarantee was one field short of what it claimed. `publishBump` re-checks both against the target it is about to send to, which is the only place the pairing is observable.

### §395. Re-checks a proof against what is about to be sent

Re-checks a proof against the content and path the write path is about to send. Called before any request that carries content.

Three independent checks, because each catches a different mistake: the path check catches a proof minted for a different file in the same run; the content hash catches content mutated after verification (the whole point of binding rather than trusting); the signature catches a proof that never came from `verifyManifestOnlyEdit` at all. `timingSafeEqual` is used for the signature because it is a MAC comparison, and its length-mismatch throw is caught and treated as a refusal — fail-closed either way.

### §396. Proves the edit is a version-only change, or refuses

Proves an edit is a version-string-only change to one already-declared dependency, or refuses.

WHY IT RE-PARSES INSTEAD OF TRUSTING THE AUTHOR
Whoever authored `newContent` is not the subject of this check; the BYTES are. Re-parsing both sides with M21.2's own parsers and comparing the declaration sets means the guarantee holds for any authoring strategy — including the isolated runner being rebuilt wrong, replaced, or simply handed a manifest whose grammar its editor mis-parses — and it holds against a BUG in the author rather than only against a malicious one.

This is the SECOND of the two verifiers this package runs, and they are not redundant: `bump-edit`'s `verifyManifestBump` is a TEXTUAL reconstruction anchored on the descriptor (does replacing `fromVersion` with `toVersion` on the changed line reproduce it exactly?), while this one is a PARSE anchored on the document (is the declared dependency set identical, and did exactly one already-declared version move?). Each catches what the other structurally cannot: the textual one catches a runner that edited the right line wrongly; this one catches a runner that produced a document declaring something different while passing the line test. Only this one mints the proof, so this one is the gate.

THE SEVEN GATES, AND WHY EACH IS SEPARATELY NECESSARY
1. **Path**: not a lockfile, a known manifest for the ecosystem, and one the component declares. 2. **Content bounds**: non-empty, within the shared byte ceiling, text (no NUL), and actually different from the base — a no-op write would open a PR that proposes nothing. 3. **One line**: exactly one line of the file differs. A version-string edit never spans lines, and this is the gate that refuses the "bump a version AND add a `postinstall` script" shape with a message that names what happened. 4. **Both sides parse**: an unparseable side is refused rather than treated as "declares nothing" — the collapse `@scp/dependency-manifests` exists to prevent. 5. **The dependency set is identical**: same count, and element-for-element equal on coordinate, scope, declaredIn and line. This is the charter's "never adds or removes a dependency", and comparing positionally also refuses a REORDER, which is not a version edit either. 6. **Exactly one version differs, and it is the subscribed one**: with an unchanged constraint KIND, from a constraint that has a version to change, and — where the declaration is pinned TWICE — with its digest moved alongside its tag. Refusing a constraint-kind change is not fussiness: `>=2.0` → `==2.31.0` rewrites a range as a pin, which `types.ts` names as the thing an actuator must not do, and `unpinned` → `pinned` would be ADDING a version the author never wrote. The digest clause is the one refusal here that catches an edit which is structurally perfect and OPERATIONALLY A NO-OP: `alpine:3.19@sha256:…` and a chart's `{tag, digest}` are both resolved BY DIGEST, so moving the tag alone changes the file and not the running image (`digest_pin_not_moved`). 7. **The change is confined to the version text**: the one differing region, measured as the span between the common prefix and the common suffix, must lie inside the dependency's own declared version text on each side. Gate 3 already refuses two changes on two lines; this refuses two changes on ONE line, which is the whole attack surface a minified `package.json` presents.

WHAT IS DELIBERATELY *NOT* CHECKED, AND WHY
The changed LINE NUMBER is not required to equal the changed dependency's `line`. It looks like a free extra binding and it is not: `pom-xml.ts` records the line of the `<dependency>` OPEN TAG (`current = { line: tagLine }`), while the version sits several lines below it, so that check would refuse every legitimate Maven bump. A rule that is right for four ecosystems and wrong for the fifth is the provenance-label failure — a label named after the branch that happened to match. Gates 5 and 7 already bind the textual change to the parsed entry without it.

### §397. A TAG MOVED WHILE ITS DIGEST STAYED

A TAG MOVED WHILE ITS DIGEST STAYED — the bump that silently changes nothing (ADR-0032 §8i).

Both `oci` spellings can pin twice: `FROM alpine:3.19@sha256:…` in a Dockerfile, and `{repository, tag, digest}` in a chart's values. Where both are present the digest WINS — containerd and Docker resolve by digest and the tag becomes a label — so moving the tag alone leaves the deployed bytes exactly where they were, while the pull request reads as an upgrade and the manifest now says two different things about which release it wants.

Refused rather than half-applied, and refused rather than guessed at: the digest for the new version IS available upstream (`dependency_lines.latest_digest`, resolved by the same poll that moved `latest_version`), but moving both is a TWO-LINE edit in the split shape, and clause 2 of `verifyManifestBump` — "exactly ONE line differs" — is a charter-enforcing refusal that does not get widened to a pair as a side effect of this one. So the tag-only edit is refused with its own name, which is the "skipped rather than guessed" rule (ADR-0032 §7) applied to an actuation instead of to a reading. `split-shape-image-bumps.md` §11 carries the follow-up.

The condition is deliberately "the digest did not move", not "a digest exists": an edit that moves the tag AND its digest together is a correct bump and is accepted (a named test drives exactly that literal), and so is a digest-only move.

### §398. The version text of a declaration AS IT APPEARS IN THE FILE

The version text of a declaration AS IT APPEARS IN THE FILE.

For every ecosystem but `oci` that is just `declared`. For `oci` the parser splits one literal `alpine:3.19@sha256:…` into `declared: "3.19"` and `digest: "sha256:…"`, and a tag bump legitimately moves BOTH — so the text a change may occupy is the two rejoined by the `@` the file itself uses. This is reconstruction of a literal, not invention: it is exactly the substring the Dockerfile contains.

### §399. Refuses any change reaching outside the version text

Refuses any textual change that reaches outside the dependency's own version text.

The differing region is measured, not guessed: the longest common prefix and the longest non-overlapping common suffix bracket a single contiguous span, and everything that changed is inside it. If that span is a substring of the base's version text, and its counterpart a substring of the edit's, then no byte outside a version string moved.

This is the gate that survives a minified manifest. Gate 3 (one line changed) is defeated by a `package.json` written on a single line, where "bump react AND add a `postinstall` script" is one line's worth of change; this one is not, because the resulting span contains the injected script and no version string does.

## `packages/plugins/managed-dep/src/write-test-support.ts`

### §400. Shared fixtures for the write path's suites

Shared fixtures for the write path's suites — the same convention `@scp/plugin-github` uses (`github-test-support.ts`), for the same reason: the traversal MATRIX and the wire suite must exercise the identical fixture, or a refusal proven in one could be absent from the other and both would still be green.

Nothing here fakes a refusal or hand-builds a proof. `realProof` runs the REAL verifier, so a test that needs a valid proof cannot get one for content the verifier would refuse.

### §401. A chart's `values.yaml` in the SPLIT shape

A chart's `values.yaml` in the SPLIT shape — the coordinate on one line, the version on the next, and the same version text present three more times where it means something else. M21.7's anchored path is the only way this file is editable at all.

### §402. A plugin context whose client records every request

A `PluginContext` whose http client RECORDS every request and answers from `handler`.

`calls.length` is what the adversarial suites assert on, and that is deliberate: "zero HTTP" is MEASURED, never inferred from an absent interceptor — a request can satisfy an absent interceptor by failing for an unrelated reason, and on this provider the very first request of a run is the App-JWT → installation-token exchange, so a counted zero also proves the refusal precedes AUTH.

### §403. WHAT THE PROVIDER SAYS THE PULL REQUEST IS

WHAT THE PROVIDER SAYS THE PULL REQUEST IS. Defaults to a pull request that agrees with `WRITE_TARGET` on every axis the merge path compares — open, from SCP's branch, into the granted base — so a suite states only the axis it is contradicting. It is a PARAMETER rather than a constant because the head branch is derived from the change id, and different suites merge different changes.

## `packages/plugins/managed-dep/vitest.config.ts`

### §404. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/managed-dep/vitest.integration.config.ts`

### §405. Docker-requiring integration layer

Docker-requiring integration layer. Mirrors managed-iac/managed-scan's integration config — no Postgres/globalSetup; the only external dependency is a reachable Docker daemon.

STALE CLAIM CORRECTED (M23.0 verification pass 8): this comment used to say the `scp-runner-dep` image was "NOT built in this repository yet ... so nothing is included here today". M21.5 built `apps/runner-dep` and added `runner-image.integration.test.ts` (the four-charter-clause proof against the real built image, `RUNNER_NETWORK_MODE`, base-image pin drift) — this config has matched a real file since then, and `test-script-census.test.ts` already treats this package as a normal single-file integration suite, not a debt. A comment claiming absence is not evidence of it; this one was checked against the tracked source, not trusted.

## `packages/plugins/managed-iac/src/detail-bound.test.ts`

### §406. HIGH (M23.0 verification pass 7)

HIGH (M23.0 verification pass 7) — THE DIAGNOSIS MUST SURVIVE ALL THE WAY TO `status().detail`, AND THE DURABLE LEDGER MUST NOT GROW WITHOUT BOUND. This is the END-TO-END half of the fix; the mechanism itself is pinned in `@scp/runner-launcher`'s `failure-detail-bound.test.ts`.

WHAT WAS MEASURED BEFORE THE FIX, through this exact path with 200 KB of runner stderr:

```text
  stderr written : 200068      ledger file on disk : 211985
  status().detail length : 4000
  detail contains the tail marker : false
  detail contains the REAL CAUSE  : false
  last 90 chars of detail : "line, repeated\nnoise line, repeated\nnoise line, repeated\n..."
```

Two defects in one measurement and they had to be fixed together. (1) The port appended the runner's last 2000 characters AFTER an UNCAPPED `err.message`, so this plugin's `.slice(0, 4000)` on READ returned 4000 characters of the noise the tool printed on its way to the error. (2) The ledger — a durable, replicated JSON file keyed by `idempotencyKey`, in a `Record` that is never pruned — was written UNSLICED; the 4000 was applied on read only. This repository has a production incident in exactly that family (unbounded `Decision` growth at 1.44 GB/day), so per-key growth of an on-disk ledger is treated as the same class.

THE SUCCESS PATH WAS WORSE AND THE ORIGINAL MEASUREMENT DID NOT REACH IT: `runnerOutcomeDetail` returned a successful run's `stdout` verbatim, up to the 16 MiB `maxBuffer`, and that too went to disk per key, forever, to serve 4000 characters. Its arm is below.

### §407. THE ARM THE SURVIVING MUTATION MUST REDDEN

THE ARM THE SURVIVING MUTATION MUST REDDEN. `output.slice(-FAILURE_OUTPUT_TAIL_CHARS)` -> `output.slice(0, ...)` in `@scp/runner-launcher` survived 1542 tests; measured through this plugin it means an operator reading a failed `tofu apply` is shown the noise the tool printed FIRST and never the error it ended on.

### §408. The plugin's own bound, and why it is not belt-and-braces

THE PLUGIN'S OWN BOUND, and it exists for a reason that is not belt-and-braces: this plugin applies a SECOND, independent redaction over `failure.detail` (its own knowledge of which values are secret, which it may not assume the adapter already stripped), and redaction is NOT LENGTH-PRESERVING — a secret value shorter than `***` makes the string grow. So the re-bind after redacting is load-bearing, and `RunnerFailure.detail`'s branded type is what makes the compiler insist on it.

WHAT THIS ARM MEASURES is that the plugin does not depend on its input already being bounded: an injected launcher hands it a 200 KB `detail` that the port's return type forbids (hence the cast), and the durable, never-pruned JSON file still receives a bounded string.

### §409. MEDIUM (M23.0 verification pass 7, finding M1)

MEDIUM (M23.0 verification pass 7, finding M1) — BOUNDING ONE ENTRY DID NOT BOUND THE LEDGER, AND THIS PLUGIN IS THE ONE WHERE THAT COSTS CPU AS WELL AS DISK.

`state.keys` is a `Record` keyed by `idempotencyKey` and nothing pruned it, ever. Measured at 500 keys: `bytes=2074290  bytesPerKey=4149` — the per-entry bound the previous round added working exactly as designed while the map grew without limit, because the map is a different quantity. And `loadState` `JSON.parse`s the WHOLE file on every `status()` poll while `saveState` rewrites it whole on every `trigger()`, so the ledger's size is O(total history ever) of parsing on a loop that ticks once a second — the 1.44 GB/day family properly stated.

THE ASSERTION IS ON THE FILE, not on the plugin's in-memory view, for the same reason the arm above is: the defect the previous round fixed was precisely the two disagreeing.

## `packages/plugins/managed-iac/src/index.test.ts`

### §410. Unit tests with every Docker invocation mocked

Unit tests (no Docker — every `docker` invocation is mocked, so these run on every PR under `pnpm test`). They assert the SECURITY-critical properties the review demanded be guarded: the container always launches with `--network none`, NO bind mount, and NO docker.sock; the workspace is copied in/out rather than mounted; a rollback with no valid prior state ref fails CLOSED without touching docker; the dedup cache prevents a second real run; and resolved secret values are redacted out of returned evidence.

### §411. `code` and `takesMs` ADDED FOR MEDIUM

`code` and `takesMs` ADDED FOR MEDIUM (verification pass 5). Without them this seam could produce exactly one kind of `start` failure, so the two shapes an operator most needs told apart — our own budget killing the runner, and the runner exiting quietly — were not expressible here at all. - `code`: what Node puts on the rejection. A NUMBER is an exit status; `null` with `killed` is a signal. `classifyRunnerFailure` branches on it. - `takesMs`: how long `start` runs before answering, so the adapter's own `timeout` (derived from the whole-run deadline) can actually FIRE. The mock honours it the way Node does — see the `start` arm below — which is what makes `deadlineExceeded` a real derivation here rather than a value the fixture asserts about itself.

### §412. The one seam that lets a test fail the final rename

LOW-6: the one seam that lets a test make `saveState`'s final `rename` fail AFTER a run has already happened, while `loadState` (an earlier `readFile`) succeeds normally — a pure-fs fixture (an occupied directory, a garbled file) cannot produce that combination, because `saveState`'s `rename` and `loadState`'s `readFile` share the same path and therefore the same filesystem-shaped failure. Delegates to the real implementation for everything except `rename`, which is undefined (real) unless a test opts in.

### §413. Node's own timeout rule, modelled only for start

NODE'S OWN RULE FOR `timeout`, modelled only for `start` because that is the only step whose failure this file needs to shape. A positive `timeout` shorter than the run's duration means Node SIGTERMs the child and rejects with `killed: true, signal: "SIGTERM", code: null` — the shape `@scp/runner-launcher`'s NODE_FAILURE_SHAPES table pins against a real child process.

### §414. This assertion is inverted, and the reversal is the fix

THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, AND THE REVERSAL IS THE FIX.
It read:

```text
  // The secret WAS injected into the container env (as -e PROVIDER_TOKEN=...), just
  // redacted from evidence.
  expect(createArgs).toContain("PROVIDER_TOKEN=super-secret-value");
```

— an accurate record of M23.0's defect 3, and a test that PINNED it. The credential was on the `create` argv, readable in the host process table by any local process, and reproduced verbatim inside `err.message` on every failed `create` (`Command failed: docker create … -e PROVIDER_TOKEN=super-secret-value …`), which `subprocess-entry.ts` serialises across the plugin-host RPC boundary and into a server log. "Redacted from the evidence" was true and was never the channel that mattered.

The credential now travels as `secretEnv` — a mode-0600 `--env-file` the adapter unlinks the instant `create` returns. THE POSITIVE HALF (that it still reaches the runner at all) is pinned in `launch-argv.golden.test.ts`, which snapshots the file's contents while `create` is in flight; here the claim is only the negative, over EVERY element of EVERY call.

### §415. MEDIUM (verification pass 5)

MEDIUM (verification pass 5) — THE DURABLE LEDGER MUST NOT RECORD TWO FAILURES AS ONE

`@scp/runner-launcher`'s port-level arms prove the classification; THIS file is the only place the whole chain can be driven, because managed-iac is the one managed plugin with a DURABLE outcome store. The chain is: real Docker adapter (over the mocked `child_process` above) -> `runRunnerContainer` -> `trigger()`'s outcome -> `saveState` to a real JSON file on disk -> a fresh `loadState` inside `status()`. Everything a `Decision`'s `inputContext` will carry (`reconcile.ts` copies `status.detail` into it verbatim) has gone through a file by the time it is asserted, which is what "through the durable ledger, not just at the port" means.

WHAT IT USED TO RECORD. `trigger()` built its detail as `result.succeeded ? result.stdout : result.stderr`, and `promisify(execFile)` always attaches `stderr` as a string — so a `tofu apply` that WE SIGTERMed mid-flight and a runner that exited quietly both wrote `detail: ""`. For managed-iac specifically that is the difference between "your infrastructure may be half-applied, re-running at this timeout will do it again" and "the runner failed, look at the runner", recorded identically, forever, in a replicated and backed-up file.

## `packages/plugins/managed-iac/src/index.ts`

### §416. `@scp/plugin-managed-iac` — the `scp-managed-iac` executor

`@scp/plugin-managed-iac` — the `scp-managed-iac` executor (DESIGN.md §12 Mode 2, charter's Managed Execution Exception, BUILD_AND_TEST.md §8 M7 item 3): "a thin orchestrator inside scpd; each run launches an ephemeral runner container from [the `scp-runner-iac`] image... Org- supplied credentials are held scoped and encrypted in SCP's secret store and injected only into the ephemeral runner for the duration of the run. The plan output is persisted as the change's evidence; apply proceeds only when the change's gates pass."

SECURITY MODEL (adversarial-review CRITICAL #1 — the reason this file's config shape is what it is): the fields that decide WHAT image runs, on WHICH network, and against WHICH host directory are **operator/server-governed, NEVER tenant-suppliable**. A tenant (any org member with plain `object:write` on a Component) configures ONLY `infraCredsSecretKeys` + `timeoutMs` (the manifest's `configSchema` below is `additionalProperties: false` and does NOT list runnerImage/ networkMode/workspace — so a binding that tries to set them is rejected at create/update by `routes/executors.ts`'s config validation). The server injects `runnerImage`/`networkMode`/ `workspaceRoot`/`statePath` into this plugin's config when it provisions the instance (`coordination/executor-bindings-repo.ts`'s `resolveExecutorPluginInstance`), so by the time this code reads `ctx.config`, those values are the vetted server settings, not anything a tenant chose. Two further hardening measures below: (1) the runner workspace is **copied into the container** (`docker cp`), never bind-mounted — there is no tenant- OR server-path that becomes a host mount, so `workspaceDir: "/"`-style host-root escapes are structurally impossible; the host workspace directory itself is derived server-side from `orgId`+`targetRef` under the operator's `workspaceRoot`, so it can't be steered outside that root. (2) the container is launched with NO docker socket mount and the server-fixed `--network` (default `none`).

COORDINATION-NOT-EXECUTION, PRESERVED AT THE TYPE LEVEL EVEN HERE: this is the one scoped exception where `trigger()`'s body performs real infrastructure work — but it still does so behind the unchanged `ExecutorPlugin` verb (no new `execute()`/`deploy()` method), and it holds credentials ONLY for THIS org's infrastructure, ONLY for the duration of one ephemeral container, injected via `docker create -e`, redacted out of any returned evidence, and never reachable from this plugin's own subprocess environment.

SYNCHRONOUS TRIGGER (deliberate v1 simplification — "trivial-to-moderate IaC deployments" is DESIGN's own scoping for Mode 2): `trigger()` runs the container to completion. Idempotency is enforced BEFORE any container ever launches (the dedup cache below, backed by a server-provided durable `statePath` — the strongest idempotency guarantee of any M7 executor, because double-applying live infrastructure is the highest-stakes failure mode).

### §417. SERVER-INJECTED (never tenant)

SERVER-INJECTED (never tenant) — WHICH LAUNCHER ADAPTER RUNS THIS PLUGIN'S RUNNER (M23.2).

Absent, or anything other than `"kubernetes"`, means the Docker adapter — so a deployment that does not opt in behaves byte-identically, which is what makes a second adapter safe to merge. The same TWO INDEPENDENT DEFENCES `dockerBinary` has apply here from day one: this plugin's manifest is `additionalProperties: false` with these keys absent, so a binding carrying either is rejected at the write door (`plugin-manifests-runner-launcher.test.ts` pins the refusal by name), and the server injects them LAST so a regression in the write door downgrades from a launcher swap to an accepted-but-overwritten key.

### §418. WHERE THE TRANSIENT `--env-file` IS STAGED

WHERE THE TRANSIENT `--env-file` IS STAGED — the plugin's OWN server-governed state dir, which is `dirname(statePath)`: `resolveExecutorPluginInstance` always injects a durable per-instance `statePath` under `pluginStateDir()` (executor-bindings-repo.ts, "always set"), so in production this is the same directory the dedup cache already lives in.

NOT the workspace: the workspace is `docker cp`'d INTO the container, and a credential file must never be a candidate for that. NOT `os.tmpdir()` either — the port refuses to choose, precisely because a shared temp dir is not a place a credential belongs. The fallback is for this package's own unit tests, which are the only callers that leave `statePath` unset.

### §419. A bounded detail rather than a string, which is the fix

`BoundedDetail`, NOT `string`, and that is the fix rather than a decoration: this record is written to a DURABLE, replicated, never-pruned JSON file keyed by `idempotencyKey`, and `reconcile.ts` copies it from there into a `Decision`'s `inputContext`. The type is what makes "you cannot store an unbounded reason here" a compile error at all fourteen write sites in this file instead of a comment on one of them. See `@scp/runner-launcher`'s `RUNNER_DETAIL_MAX_CHARS`.

### §420. BOUNDING ONE ENTRY DID NOT BOUND THE LEDGER

BOUNDING ONE ENTRY DID NOT BOUND THE LEDGER (MEDIUM, M23.0 verification pass 7 finding M1). The previous round capped each `detail` and left `state.keys` — a `Record` keyed by `idempotencyKey` with no pruning anywhere — to grow forever. Measured at 500 keys: `bytes=2074290`, `bytesPerKey=4149`. The per-entry cap was working; the map was a different quantity.

AND THE SIZE IS A PER-POLL COST HERE, not just a disk cost, which is what makes this the worse of the three: `loadState` `JSON.parse`s the WHOLE file on every `status()` call and `saveState` rewrites it whole on every `trigger()`, so an unbounded ledger is O(total history ever) of parsing on a loop that ticks once a second. That is the 1.44 GB/day family properly stated — an unbounded write per key, re-read forever.

THE RULE: keep the most recent `RUN_OUTCOME_CACHE_MAX_DURABLE` outcomes, drop the oldest. What an entry must outlive is `trigger()` (which runs the container synchronously to completion BEFORE writing the entry) plus reconcile's next `status()` poll a second later, plus a crash-and-retry window in which reconcile re-issues the same `idempotencyKey`. Dropping an entry a retry then asks for would mean re-running an `apply` that already ran — the one hazard worth naming — so 200 is set far above anything that can be in flight rather than at the smallest workable number. Ceiling on the file: 200 x ~4.2 KB, about 840 KB, and that is the WORST case; a typical `detail` is a few hundred bytes.

### §421. WHAT THIS FILE COMPOSES

WHAT THIS FILE COMPOSES — a `detail` that is a plain `string` (MEDIUM, M23.0 verification pass 7 finding M3). `RunOutcome.detail` is still `BoundedDetail`, so no READER of the ledger can be handed a megabyte; what changed is WHERE the conversion happens. A brand on a FIELD forces one at every literal that constructs the record, which is how one concept came to have 26 manual call sites across four packages — most of them, on a delete-the-wiring sweep, pinned by no failing test. Three sites of one concept means the boundary is wrong; the answer is not 23 more tests.

### §422. Runner container launch

Runner container launch — COPY the workspace in/out (never bind-mount; CRITICAL #1 + fixes the dind CI failure where a bind-mounted host /tmp path isn't shared with the dind daemon). The ONE place credentials are materialized as env vars, on the CHILD `docker` invocations only.

M23.1: the five-step create/copy-in/start/copy-out/remove sequence itself now lives in `@scp/runner-launcher`, shared with `@scp/plugin-managed-scan` and `@scp/plugin-managed-dep` — three hand-rolled copies of one mechanism were three places a fix had to be remembered. What stays HERE is everything that is this plugin's own: which operands, which env, and the copy-out policy (`always` + `swallow`) that no other caller shares.

### §423. RESOLVED ONCE, by the caller

RESOLVED ONCE, by the caller — `trigger()` resolves these before this function is called (M23.1 phase 2), rather than this function resolving them itself, because `trigger()` also needs the secret VALUES to build the `redact` closure `withRecordedOutcome` uses on the FAILURE path, and resolving twice would mean the credential fetch and the credential the failure-path redactor knows about could, in principle, diverge.

### §424. Derived from the idempotency key, so a retry addresses one

DERIVED FROM THE IDEMPOTENCY KEY, so a retry of the same run addresses the same container name. That is the whole reason `runId` is caller-supplied rather than adapter-minted: no adapter could know that two launches are the same run, and this plugin's dedup cache is exactly the thing that does. `toRunnerRunId` is injective, so two DIFFERENT keys can never collapse onto one name (which would make one run tear down the other's container).

### §425. THE CREDENTIALS, AND THE ONE PLACE THEY ARE MATERIALIZED

THE CREDENTIALS, AND THE ONE PLACE THEY ARE MATERIALIZED. M23.0 recorded that these rode the `create` argv, readable from the host process table by any local process; they now travel as `secretEnv`, which the Docker adapter delivers through a mode-0600 `--env-file` it unlinks the instant `create` returns. STILL PARTIAL, and named as such at `RunnerSpec.secretEnv`: the value is in `docker inspect` for the container's life and on a disk for one `create`. The split's real payoff is M23.2 — Kubernetes maps `secretEnv` to a per-run Secret, where an undifferentiated list would have become `env[].value` and put the credential in etcd.

THE ORDER IS THE CONFIG'S OWN KEY ORDER, unchanged, and `extraEnv` is no longer merged in ahead of it — the two lists are now disjoint by construction rather than by spelling.

### §426. The asymmetry that is this plugin's alone, on both axes

THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, and it is load-bearing on both axes: the evidence comes back out even after a FAILED run (a failed apply may still have produced a partial plan.json worth persisting), and a copy-out that itself fails is SWALLOWED (the run stays succeeded). managed-scan and managed-dep do the opposite on both. Pinned by the goldens; a port that normalised the three into one sequence must break them.

### §427. THE SECOND, INDEPENDENT REDACTION

THE SECOND, INDEPENDENT REDACTION — this plugin's own knowledge of which values are secret, applied on top of whatever the adapter already stripped (see `withRecordedOutcome`'s `redact` for why the plugin may not depend on that having happened). `failure.detail` joins the set it covers: it embeds `err.message`, which on a `create` failure is where an unredacted `-e AWS_SECRET_ACCESS_KEY=…` would appear, and it is now the string that reaches the DURABLE ledger — the highest-value channel this plugin has.

### §428. State load and save now sit inside the guarded region

LOW-6: `loadState`/`saveState` used to sit OUTSIDE `withRecordedOutcome`'s guarded region, so a corrupt state file (`JSON.parse` throwing non-ENOENT) made `trigger()` reject UNRECORDED — no outcome, no externalId the caller could later poll `status()` with. FAIL CLOSED rather than treating the read failure as "no prior run": this cache is exactly what tells a retry apart from a run that already applied, so an unreadable cache must refuse to launch, not guess. Recorded as this run's own outcome — a fresh single-key state is safe to write precisely because the OLD file was unreadable: nothing recoverable from it is lost by overwriting what could not be read anyway.

### §429. THE REDACTION SET FOR THE FAILURE PATH

THE REDACTION SET FOR THE FAILURE PATH (M23.1 phase 2), populated the moment credentials are actually resolved inside the guarded body below. Starts empty, so a throw BEFORE that point redacts against nothing (safe: no credential has been fetched yet) and a throw AFTER it redacts against exactly what THIS run fetched. NOT the identity function, unlike managed-scan's: a raw `docker create` rejection's message carries `-e KEY=<value>` before `RunnerLaunchError`'s own redaction ever runs, and this catch must not assume that redaction already happened — an injected test launcher, or a future adapter, can throw something `RunnerLaunchError` never touched. THE STAKES ARE HIGHER HERE THAN IN managed-scan: this plugin's `record` writes to a durable, replicated, backed-up JSON file (`saveState`), and `reconcile.ts` copies that `detail` into an `insertDecision` `inputContext` from there — an identity redactor would turn one ephemeral log line into a permanent database row carrying a credential.

### §430. EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME

EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME. Before this, `trigger()` had no outer catch at all — a `create`/`copy-in` failure, a `writeSourceFiles` refusal, or a `mkdir` error propagated straight out as a rejection, `state.keys[cacheKey]` was never written, and `status()` reported `pending` forever (indistinguishable from "still running"): the SAME property managed-scan had, fixed here with the SAME helper but a genuinely redacting closure.

### §431. LOW-6: THE RUN ALREADY HAPPENED

LOW-6: THE RUN ALREADY HAPPENED (succeeded or failed) by this point — for `apply`/`rollback` that may be a LIVE infrastructure mutation. Rejecting here would tell the caller "nothing happened" when something did, and a caller that reacts to a rejection by retrying could double-apply — the exact failure mode this cache exists to prevent. So this is BEST EFFORT and LOUD, never a rejection: the caller still gets its real `externalId`, and the failure to persist is logged at error level rather than swallowed silently.

### §432. No slice: the evidence is bounded where it is composed

NO SLICE. The evidence is bounded WHERE IT IS COMPOSED (`@scp/runner-launcher`'s `boundDetail`, enforced by `RunOutcome.detail`'s type) and it is bounded KEEPING BOTH ENDS. The `.slice(0, 4000)` that used to be here was the third of three consumers each front-slicing a string none of them built, and it discarded the runner's last words — the diagnosis — for any run that printed more than ~1.8 KB. It also bounded nothing that mattered: the durable ledger behind `loadState` had already been written unsliced.

### §433. THE LAUNCHER SEAM

THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose: adapter selection is not tenant-facing, and adding a config field would mean adding it to the server-injected/never-tenant-settable class in all three enforcement layers for no behaviour a caller can yet ask for. Tests pass a substitute here, which is what makes "the plugin really goes through the port" falsifiable rather than a claim about the source text.

### §434. THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE

THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE — M23.2, AND THIS LINE IS THE WIRING. `subprocess-entry.ts` constructs this plugin with NO argument, so whatever stands here is what every production run uses. While it was `resolveDockerRunnerLauncher`, an operator could set `runnerLauncher: "kubernetes"` through every layer of the chart and every managed run would still shell out to a `docker` binary the `scpd` image does not ship — a feature correctly built and installed nowhere, which is this repository's dominant defect class (CLAUDE.md). Delete this and `runner-launcher-selection.test.ts`'s named case for this plugin dies.

### §435. Manifest `configSchema` is the TENANT-facing surface only

Manifest `configSchema` is the TENANT-facing surface only — `additionalProperties: false` so a binding that tries to set the server-governed runnerImage/networkMode/workspace* fields is REJECTED at create/update (routes/executors.ts's config validation). The server injects those fields into this plugin's runtime config itself (executor-bindings-repo.ts).

### §436. BOUNDED AT BOTH ENDS

BOUNDED AT BOTH ENDS (M23.1c). The `maximum` is the half that was missing: with only a floor, a tenant could set 2^31 and make the runner unkillable by its own timeout AND unbound the plugin-host RPC budget derived from it. Enforced at every write door by `validatePluginConfig` (Ajv honours `maximum`), and clamped again host-side for rows stored before the ceiling existed.

## `packages/plugins/managed-iac/src/launch-argv.golden.test.ts`

### §437. The golden Docker argv, recorded before anything moves

M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-iac`, RECORDED BEFORE ANYTHING MOVES

WHY THIS FILE EXISTS, AND WHY M23.1 DID NOT RETIRE IT. M23 extracts a `RunnerLauncher` port so the three managed executors can also launch their runners as Kubernetes Jobs. That refactor's central promise is that **the Docker path is byte-for-byte unchanged**. A promise like that is only checkable if the current bytes were written down FIRST, by a test that existed BEFORE the refactor — otherwise the "unchanged" baseline is whatever the refactor happens to emit, and the assertion is a tautology.

THE PARAGRAPH THAT USED TO SIT HERE WAS WRONG, AND THIS ONE REPLACES IT. It said that until M23.1 landed the port this file was the definition of "unchanged", and that when the port landed these tests were "to be **deleted or superseded** by the port's own conformance suite". M23.1 HAS LANDED. It did NOT retire this file, and that standing instruction is withdrawn — because the port's conformance suite (`packages/runner-launcher/src/docker-adapter.test.ts`) and this file prove DIFFERENT things, and neither implies the other: - THE CONFORMANCE SUITE drives `createDockerRunnerLauncher` DIRECTLY. Its subject is what the adapter emits FOR A GIVEN `RunnerSpec` — argv, per-call `timeout`/`maxBuffer`, both copy-out axes, the failure paths. A `RunnerSpec` is its INPUT. - THIS FILE drives `plugin.trigger()`. Its subject is THE OTHER HALF, which the conformance suite structurally cannot reach: that this plugin still hands the port THE SAME SPEC it used to build by hand. A spec field changed here — a `when: "always"` that became `"on-success"`, or a `maxBuffer` that picked up a neighbour's 32 MiB — produces a perfectly CONFORMANT launch of the WRONG container, and the conformance suite is blind to it, because that spec is what it is handed rather than what it checks. Deleting this file on the strength of the old sentence would take the plugin→port boundary to ZERO coverage while every task stayed green — the vacuous-green class BUILD_AND_TEST.md §4.4 names, and the same reason `@scp/runner-launcher` no longer runs with `--passWithNoTests`. RETIRE THIS FILE ONLY ALONGSIDE SOMETHING THAT COVERS THAT BOUNDARY, never merely alongside something that covers the adapter.

WHAT IS PINNED, AND WHY EACH PART IS PART OF THE PROMISE. 1. THE FULL argv ARRAY of every `execFile`, in order — `create`, `cp` in, `start`, `cp` out, `rm`. Asserted as an array against a literal, never as "contains" or as a call count: a renamed binary, a reordered flag or a dropped operand must fail, and must fail by PRINTING the actual argv next to the expected one. 2. THE OPTIONS OBJECT alongside each argv. These differ per plugin (managed-iac: 10 min / 16 MiB; managed-scan: 10 min / 32 MiB; managed-dep: 5 min / 8 MiB) and `rm` alone carries a 30 s timeout AND NO `maxBuffer` AT ALL. A port that unified those into one shared default would be a behaviour change wearing a refactor's clothes, and nothing else in the build would notice. `toStrictEqual` is what makes the ABSENCE of `maxBuffer` on `rm` — and the absence of any `cwd`/`env` anywhere — part of the record rather than merely untested. 3. THE ASYMMETRY THAT IS SPECIFIC TO THIS PLUGIN: managed-iac copies the workspace back OUT **unconditionally** (even after a failed `start`) and **catch-guarded** (a failed copy-out does not fail the run). managed-scan and managed-dep do the opposite on BOTH axes — copy out only on success, and let a failed copy-out propagate. That difference is real, load-bearing (a failed `apply` may still have produced a partial plan worth persisting) and exactly the kind of thing a "unify the three launchers" refactor normalises away by accident. It is pinned here as behaviour, not left as a comment. 4. THE FAILURE PATH: what the argv and the cleanup look like when `start` rejects.

THE RECORDING SEAM is the one this package already uses — `vi.mock("node:child_process")` with a hand-written `execFile`, the same shape as `index.test.ts` here and `runner-containment.test.ts` in `@scp/plugin-managed-dep`. The only widening is that the options object (which those files discard as `_opts`) is now recorded too, because point 2 above is half the promise. No Docker is required, so these run on every PR under `pnpm test`.

### §438. What the transient env file held while create was in flight

WHAT THE TRANSIENT `--env-file` HELD WHILE `create` WAS IN FLIGHT, read by the seam because that is the only moment it can be read — the adapter unlinks it as soon as `create` returns.

WITHOUT THIS THE GOLDEN WOULD BE SATISFIED BY A PLUGIN THAT STOPPED PASSING CREDENTIALS AT ALL. "No `-e AWS_*` on the command line" is exactly what a plugin that dropped `infraCredsSecretKeys` on the floor also produces, and every assertion here would go green while `tofu apply` silently lost its provider auth. The positive half — these two values, in this order, actually reached the runner — has to be measured somewhere, and this is the only place standing at the right moment.

### §439. The only failure-injection arms for the create step

`create` outcome — the two tests below are the ONLY failure-injection arms for this step; every other test in this file leaves it `true`.

IT IS AN ERROR OBJECT AND NOT A BOOLEAN SINCE M23.1e, and the change is the point. The fixture used to reject with `name already in use` — a NAME CONFLICT — while asserting that the run then tears the name down, which is the one create failure for which tearing down is WRONG: by definition of the conflict, the container behind that name belongs to somebody else and is still running. Reachable here for two concurrent triggers of one `idempotencyKey`, whose container names are equal by design. The default is therefore an ORDINARY create failure, and the conflict is its own arm with the opposite expectation.

### §440. M23.1 PHASE 4 — the reaper

M23.1 PHASE 4 — the reaper. `reap()` now runs at the top of every `run()`, issuing a `docker ps -a --filter label=...` before `create` and stamping two more `--label` pairs onto every `create` it issues. Neither is this file's subject (its own dedicated coverage is `@scp/runner-launcher`'s `docker-adapter.test.ts` and `reaper.integration.test.ts`), so both are kept out of the golden entirely: the `ps` call is answered with an empty listing and never recorded, and the two labels are stripped off `create`'s argv before it reaches `calls` — the same "divert what this file isn't about" technique already used for the transient `--env-file` path.

### §441. The options: the buffer as a literal, the timeout as a bound

THE OPTIONS — `maxBuffer` AS A LITERAL, `timeout` AS THE BOUND IT MUST NOW LIE IN (M23.1e)
Deliberately NOT imported from `index.ts`: a golden that re-derives its expectation from the code it is guarding cannot detect a change to that code. 16 MiB is written here because that is what the plugin does TODAY.

WHY `timeout` STOPPED BEING AN EQUALITY. `RunnerSpec.timeoutMs` is the WHOLE-RUN budget since M23.1e, so each step is issued with what is LEFT of it (`deadline - now`, off one clock read at the top of `run()`). Handing every step the full `timeoutMs` was the defect this golden used to pin: four sequential calls, each individually under the bound, made a run of four x timeoutMs, which the host's own budget — sized `timeoutMs + grace` — then SIGKILLed, orphaning the container and leaving the idempotency ledger unwritten.

So the assertion is the PROPERTY: never ABOVE the caller's budget (that is the old behaviour back), and never more than `BUDGET_SLACK_MS` below it in this seam, where every step settles on the next tick — which is what stops a degenerate "always 1ms" from passing. The strict decrease across a run and the refusal once nothing is left are proven where they can be measured: `@scp/runner-launcher`'s `whole-run-budget.test.ts`.

`toStrictEqual` KEEPS ITS TEETH — the matcher stands in for the `timeout` VALUE only, so the ABSENCE of `maxBuffer` on `rm` and of every other key everywhere is still pinned exactly.

### §442. The ONE argv element here that cannot be a literal

The ONE argv element here that cannot be a literal: the transient `--env-file` carries a fresh UUID per run. Its SHAPE is asserted — inside the plugin's own state dir (`dirname(statePath)`, which is `workspaceRoot` for these contexts), named for the run — and only then is it substituted, so every other byte of the argv stays a literal. Same technique, and the same reason, as `@scp/plugin-managed-dep`'s `normalise()` for its per-run `mkdtemp`.

### §443. The maximal shape

The maximal shape: a server-injected `dockerBinary` and `networkMode`, a tenant `timeoutMs`, two resolved infra credentials, and the `PRIOR_STATE_FILE` a rollback appends.

THE TWO `-e AWS_*` PAIRS THIS GOLDEN USED TO RECORD ARE GONE, AND THAT IS THE POINT. M23.0 recorded them as defect 3: resolved credentials on the `create` argv, readable from the host process table by any local process, and — worse, because it crosses a machine boundary — reproduced verbatim in `err.message` when `create` fails, which `subprocess-entry.ts` ships across the plugin-host RPC boundary into a server log. They now travel as `secretEnv`, which the Docker adapter delivers through a mode-0600 `--env-file` unlinked the instant `create` returns.

`PRIOR_STATE_FILE` STAYS ON THE COMMAND LINE, and the difference is the whole design: it is a path inside the container, not a secret. The split is along the SECRECY axis because that is the axis the Kubernetes adapter must branch on (Secret + `envFrom` vs `env[].value`) — not a reflex to hide every environment variable.

WHAT IS STILL PINNED: the env-file's CONTENTS and their ORDER (the config's own key order), asserted below from a snapshot the seam takes while `create` is in flight. Without that, this test would be equally green for a plugin that stopped resolving credentials altogether.

### §444. The second half of the asymmetry

The second half of the asymmetry: managed-iac's copy-out is `.catch(() => undefined)`, so a `docker cp` that cannot read the container's workspace is not a failed run. (managed-scan and managed-dep leave theirs unguarded, so the same failure escapes their `trigger()`.) Pinned here because "best-effort" is a property of the call site, and a port that awaits all five steps uniformly would change a succeeded apply into a failed one.

### §445. A NEW TEST, not an edit of an existing one

A NEW TEST, not an edit of an existing one — none of the four cases above inject a `create` failure, only a `start` failure, so there is no existing golden line for this arm to move.

BEFORE M23.1 PHASE 2, this would have been unobservable through `status()` at all: `create` rejecting propagated straight out of `trigger()` as a rejection (managed-iac's `trigger()` had no outer catch), nothing was ever written to the dedup cache, and `status()` reported "pending" forever — indistinguishable from "still running". `trigger()` now RESOLVES and the failure is recorded via `withRecordedOutcome`.

### §446. The other arm, and why that one's fixture had to change

THE OTHER ARM OF THE TEST ABOVE, AND THE REASON THAT ONE'S FIXTURE HAD TO CHANGE. Teardown is unconditional and addresses the NAME, so for the one create failure that MEANS the name is somebody else's, the teardown destroys a container this run did not create and is not supervising. For managed-iac that is two concurrent triggers of a single `idempotencyKey` — `toRunnerRunId(intent.idempotencyKey)` makes their container names equal ON PURPOSE, because retry-stable naming is what makes a retry address the same container instead of starting a second `tofu apply`. The name is the feature; the unconditional teardown was the bug.

BOTH ARMS OR NOTHING: without the test above, "skip teardown on any create failure" passes here and re-opens M23.0 defect 1 (a `create` that timed out leaves a committed container with nothing addressing it). Without this one, the old unconditional teardown passes there.

## `packages/plugins/managed-iac/src/launcher-seam.test.ts`

### §447. The standing gate that the port is installed, not present

M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.

WHY THIS FILE EXISTS SEPARATELY FROM THE GOLDEN. `launch-argv.golden.test.ts` proves the Docker BYTES are unchanged; it would go on passing if this plugin kept its own private copy of the launch sequence and `@scp/runner-launcher` were dead code nobody called. The recurring failure that costs the most here is a component that is built, wired nowhere, and covered by tests that reach it directly (CLAUDE.md; six instances in one M21 session, one of them a live RCE on main). The only check that catches it is to REMOVE the wiring and watch a named test die — so this file removes it deliberately, by injecting a launcher that throws, and requires the failure to surface through `trigger()`.

A grep for `resolveLauncher(` would not do: a commented-out call still matches the raw text, and a call inside dead code still matches the stripped text.

M23.1 PHASE 2 CHANGED WHERE THE FAILURE LANDS. The paragraph that used to sit here said managed-iac's `trigger()` had no outer catch, so a launcher failure REJECTED out of `trigger()` and nothing was cached — `status()` then reported `pending`, not `failed`. That was true and is now the defect phase 2 fixes: `trigger()` RESOLVES, the failure is recorded via `@scp/runner-launcher`'s `withRecordedOutcome`, and `status()` reports `failed` with the injected launcher's own message. The first test below was rewritten to that stricter shape — a plugin that kept a second, private launch path would still resolve, but would report `succeeded` — rather than deleted, because deleting it would take this file's whole reason for existing to zero along with it. The second new test below (credential redaction) exists BECAUSE this plugin's failure path now writes to a durable store: see its own comment for why an identity redactor here is not merely a missed nicety.

### §448. THE COUPLING PHASE 2 NAMED

THE COUPLING PHASE 2 NAMED: this plugin's failure path now writes `detail` to a durable JSON file (`saveState`), and `reconcile.ts` copies it from there into a persisted `Decision`'s `inputContext`. A raw `docker create` rejection's real message is `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=<value> …` — this test does not go through the real Docker adapter (whose own `RunnerLaunchError` already redacts what IT knows to redact); it injects a launcher that throws that shape DIRECTLY, so the assertion is on `trigger()`'s OWN redaction, independent of whatever the adapter would have already done. Replacing that redactor with the identity function is exactly the mutation this test exists to catch — see @scp/runner-launcher's `withRecordedOutcome` doc for why `redact` is a required, load-bearing parameter rather than decoration.

### §449. The whole spec compared strictly, which is the point

THE WHOLE SPEC, `toStrictEqual`, AND THAT IS THE POINT OF THIS ASSERTION.

This test used to capture the entire `RunnerSpec` and then assert only `image` and `operands`, with a comment declining the rest as "the golden's job". It was measured and it was not true: `git rm` the three `launch-argv.golden.test.ts` files AND flip three load-bearing fields in `runRunnerContainer` at once — `when: "always"` -> `"on-success"`, `onFailure: "swallow"` -> `"propagate"`, `maxBuffer: 16 MiB` -> `32 MiB` — and the repo ran "Tasks: 14 successful, 14 total". A file that carries a deletion hazard in its header cannot be the only thing asserting a field; this file carries no such instruction and is named for the wiring it guards, so the fields live here TOO. The goldens are not redundant — they pin the Docker BYTES for four managed-scan preload combinations and the rollback arm, which nothing here reaches — but no single deletion can now take these six fields to zero.

EVERY FIELD IS A LITERAL, not re-derived from `index.ts`. The workspace path is the one deterministic thing about this run and is spelled out rather than read back from the spec: `workspaceDirFor` sanitises orgId and targetRef into `<workspaceRoot>/<org>/<target>`, and a change to that layout must fail here.

### §450. THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, on both axes

THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, on both axes. A failed `apply` may still have produced a partial plan.json worth persisting (`when: "always"`), and a copy-out that itself fails does NOT fail the run (`onFailure: "swallow"`). managed-scan and managed-dep are the opposite on both. This is the pair a "unify the three launchers" refactor normalises away by accident.

## `packages/plugins/managed-iac/src/managed-iac.integration.test.ts`

### §451. REAL-DOCKER integration test (BUILD_AND_TEST.md §8 M7 DoD)

REAL-DOCKER integration test (BUILD_AND_TEST.md §8 M7 DoD): "launches a REAL scp-runner-iac container against a local-state tofu fixture end-to-end: plan evidence → gate block → approve → apply → rollback via the prior state ref." Needs a reachable Docker daemon — excluded from `pnpm test` (vitest.config.ts), run via `pnpm test:integration` in the CI integration-shard job (GitHub-hosted `ubuntu-latest`, native Docker daemon; formerly the homelab `homelab-commanderscp-linux-docker-build` ARC runner and its DinD sidecar), or locally per CLAUDE.md's ENVIRONMENT.

COPY-NOT-BIND-MOUNT (adversarial-review CRITICAL #1 fix, also fixes the dind CI failure): the plugin `docker cp`s the workspace INTO the container and back OUT — it never bind-mounts a host path. `docker cp` streams over the daemon API, so it works regardless of whether the host path is shared with the (colima/dind) VM — this is why the previous "TMPDIR must be $HOME-rooted under colima" / "the dind runner's /tmp isn't shared" constraints are GONE. `os.tmpdir()` is used freely for both the workspace root and the dedup statePath.

SERVER-GOVERNED CONFIG: `runnerImage`/`networkMode`/`workspaceRoot`/`statePath` are the fields the SERVER injects in production (`executor-bindings-repo.ts`) and a tenant can never set. This test provides them directly (it calls the plugin, not the server), standing in for that injection — with `networkMode: "none"` asserting isolation, not just assuming it.

FIXTURE, DELIBERATELY NETWORK-FREE: `terraform_data` (built into OpenTofu's CORE provider — zero provider download at `tofu init`), so a real plan/apply/state lifecycle runs with no network.

### §452. LEVER 1: the image the tests actually run

LEVER 1: the image the tests actually run. `resolveRunnerImage` (beforeAll) sets this to the pre-pulled GHCR ref in CI (`SCP_RUNNER_IAC_IMAGE_REF`), or to `RUNNER_IMAGE_TAG` after a local legacy-builder build when that env is unset (local dev). `buildCtx` injects it as the server-governed `runnerImage`.

### §453. LEVER 1: PULL the pre-built image in CI

LEVER 1: PULL the pre-built image in CI (SCP_RUNNER_IAC_IMAGE_REF, set by the integration job after `docker pull`ing the content-hash-tagged GHCR image), else legacy-builder BUILD it locally (dev fallback). The DOCKER_BUILDKIT=0 legacy-builder reasoning (the single-daemon net=none session wedge, PR #126 — now scoped to the local fallback only) lives in resolveRunnerImage — same build, just no longer per-run in CI.

## `packages/plugins/managed-iac/src/runner-launcher-selection.test.ts`

### §454. The standing gate that adapter selection is installed

M23.2 — THE STANDING GATE THAT ADAPTER SELECTION IS *INSTALLED*, NOT MERELY BUILT.

`launcher-seam.test.ts` proves this plugin launches through the injected `RunnerLauncher`, and every one of its cases injects a resolver. That is precisely why it CANNOT prove this: production injects nothing. `apps/server/src/plugin-host/subprocess-entry.ts` constructs this plugin as `createManagedIacExecutorPlugin()` — no argument — so the DEFAULT PARAMETER is the whole of the production wiring, and a test that always passes its own resolver never touches it.

That is this repository's dominant defect class, named in CLAUDE.md: a component built, tested through a seam that bypasses the wiring, and installed nowhere. It has happened six times in one session, including a live RCE on main. The only check that works is to delete the wiring and watch a NAMED test die — so this file constructs the plugin with NO ARGUMENT and requires the Kubernetes adapter to be reached. Revert the default parameter to `resolveDockerRunnerLauncher` and this dies; nothing else in the repository does.

### §455. No process is spawned on the Kubernetes path

M23.6 CLAUSE 1 — NO PROCESS IS SPAWNED ON THE KUBERNETES PATH
The clause asks for the recorded SPAWN, not a mock's call count, "so a renamed binary cannot pass it". `runnerSpawns()` records the binary as it was handed to `execFile` and nothing else in the package can start a process — `no-docker-on-kubernetes.test.ts` censuses that. Measured before the ledger existed: a real `execFile(dockerBinary, ["version", …])` in `resolveRunnerLauncher`'s KUBERNETES branch left the whole workspace green.

### §456. Never constructed, which is stronger than never called

M23.6 CLAUSE 7 — NEVER *CONSTRUCTED*, WHICH IS STRONGER THAN NEVER CALLED
The `io is NEVER touched` case above is a statement about CALLS. Measured: making the Docker branch of `resolveRunnerLauncher` build `createFetchKubernetesIo(...)` AND `createKubernetesRunnerLauncher(...)`, discard both and return the Docker launcher left `pnpm -w test` green (72/72). This arm is what that mutation now fails.

### §457. M23.6 CLAUSE 1, BEHAVIOURALLY

M23.6 CLAUSE 1, BEHAVIOURALLY — THE SPAWN IS OBSERVED FROM OUTSIDE THIS PROCESS

WHY THE LEDGER ARM ABOVE IS NOT ENOUGH, MEASURED. `runnerSpawns()` records what goes THROUGH `spawnRunnerProcess`. A real `child_process.execFile(dockerBinary, …)` on the Kubernetes path goes nowhere near it: planted in `resolveRunnerLauncher`'s Kubernetes branch it left this file, its two siblings and the whole workspace GREEN while fourteen processes were actually created. What caught it was a source census — and a census proves the presence of TEXT, never the absence of an EXECUTION, which is this repository's most expensive standing confusion.

SO THIS CASE RUNS THE PLUGIN IN A CHILD `node` whose `node:child_process` was wrapped before the plugin loaded, and asserts over the processes that were actually created. It carries its OWN control in the same child, in order: the Kubernetes trigger first (nothing may be created), then a Docker trigger (something must be), so an observer that had silently stopped observing fails the second half rather than passing the first.

### §458. M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT

M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT: the `io` THIS SUITE ALWAYS INJECTS

Every case above hands the plugin a `kubernetes.io`. `resolveRunnerLauncher` reads it as `k8s.io ?? createDefaultKubernetesIo(…)`, and the right-hand side of a `??` is not evaluated when the left is present — so the transport the resolver builds FOR ITSELF, which is the only one production ever gets, was evaluated by no test in this repository.

MEASURED, NOT SUSPECTED. A `spawnSync(config.dockerBinary ?? "docker", ["version"])` planted on that right-hand side, in a NEW module so that no `node:child_process` string appears in `kubernetes-adapter.ts` for the source census to find, executed a REAL `docker version` while `@scp/runner-launcher` reported 427/427 and the three managed plugins reported 38 + 50 + 255 — every suite green, including the observed case above. A marker file proved the probe was reached rather than merely present.

So this case injects NOTHING: no `io`, and NO `dockerBinary` either. The Kubernetes adapter is not given a container binary in production and must not need one, so with the field absent the only name a probe can reach for is `DEFAULT_DOCKER_BINARY` — and the assertion is simply that this child created no process at all, with no binary name guessed in advance.

TWO THINGS MAKE THE EMPTY LIST MEAN SOMETHING, because a green negative arm was already worthless once: `kubernetesConstructionCount()` must move by TWO (the launcher AND the transport the resolver built — an injected `io` makes it one, which is what every case above produces), and the run must fail naming the projected service-account token path, which is proof the resolver's own `readToken` closure actually executed. The observer's own liveness is then proven in the SAME child by a deliberate spawn at the end.

## `packages/plugins/managed-iac/vitest.config.ts`

### §459. Unit layer (BUILD_AND_TEST.md §4.1)

Unit layer (BUILD_AND_TEST.md §4.1) — mirrors apps/server/vitest.config.ts's exact pattern: excludes `*.integration.test.ts` (the real-Docker `scp-runner-iac` container test, managed-iac.integration.test.ts) so `pnpm test` never depends on Docker being available.

### §460. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/managed-iac/vitest.integration.config.ts`

### §461. Docker-requiring integration layer

Docker-requiring integration layer (BUILD_AND_TEST.md §8 M7 DoD: "an integration test that launches a REAL scp-runner-iac container against a local-state tofu fixture"). Mirrors apps/server/vitest.integration.config.ts's shape but has no Postgres/globalSetup dependency — this suite's only external dependency is a reachable Docker daemon (`DOCKER_HOST`, colima locally / native Docker in CI — see the test file's own module doc). Generous timeouts: pulling the base OpenTofu image (first run only) and three separate `docker run` invocations each pay real container-startup overhead.

## `packages/plugins/managed-scan/src/detail-bound.test.ts`

### §462. HIGH (M23.0 verification pass 7)

HIGH (M23.0 verification pass 7) — FOR THIS PLUGIN THE FAILURE TAIL WAS UNREACHABLE AT EVERY OUTPUT SIZE, and that is the sharpest form of the defect.

The port appended the runner's last 2000 characters only when the output EXCEEDED 2000 (below that it is already inside Node's `Command failed: <cmd>\n<stderr>` message and the append was skipped as a duplicate) — and it appended them AFTER that message. This plugin then sliced `runnerOutcomeDetail(result)` to 2000 characters FROM THE FRONT at capture. So the append existed exactly when the message ahead of it was already longer than the slice: below 2000 there was no append, above 2000 the append was past the cut. There was no size at which a Trivy failure's own last words reached `status().detail`.

Trivy is the worst case in the fleet — this plugin uses the largest `maxBuffer` of the three (32 MiB) because a report is the biggest thing any managed runner prints — and an operator reading a failed scan got 2000 characters of Node's preamble.

### §463. LOW (M23.0 verification pass 7, finding L2)

LOW (M23.0 verification pass 7, finding L2): this arm made exactly the claim in its own title while reading the value THROUGH `status()`, and its own comment admitted that "reading through `status()` twice cannot distinguish the two". It was true only because the `.slice` in `status()` had been removed — re-adding one would have made the test green and the title false. Now it reads the Map.

### §464. MEDIUM (M23.0 verification pass 7, finding M1)

MEDIUM (M23.0 verification pass 7, finding M1) — the same property in RAM. `outcomes` is a module-level `Map` that nothing pruned, so a long-lived plugin instance accumulated one ~4 KB entry per scan for the life of the process.

DRIVEN THROUGH THE UNSUPPORTED-METHOD REFUSAL, which records a real outcome without launching anything — so this is 1 000+ genuine cache writes rather than a stub poking the Map, and it runs in milliseconds. It is also the one refusal in that file whose length a tenant chooses.

## `packages/plugins/managed-scan/src/index.test.ts`

### §465. Unit tests with every Docker invocation mocked

Unit tests (no Docker — every `docker` invocation is mocked, so these run on every PR under `pnpm test`). They assert the SECURITY-critical properties the ADR-0020 / managed-iac model demands: the container always launches with `--network none`, NO bind mount, NO docker.sock; the scan subject is copied IN and evidence copied OUT rather than mounted; an unsupported method or missing server-controlled dirs fail CLOSED WITHOUT touching docker; and a non-zero scanner run is reported failed (so a broken scan never masquerades as clean).

### §466. MEDIUM (verification pass 5)

MEDIUM (verification pass 5) — A FAILED SCAN'S RECORDED REASON IS NEVER THE EMPTY STRING

This plugin built its failure detail as `managed-scan: <method> scan FAILED — ${result.stderr}`. `promisify(execFile)` always attaches `stderr` as a string, so for a scan WE killed on the budget and for a `docker` that never spawned that expression produced the literal `scan FAILED — ` and stopped — and `status().detail` is what `reconcile.ts` copies into a `block` Decision's `inputContext`, and what E6 quotes when it refuses a promotion for want of evidence. An operator chasing a blocked release got a sentence that ends in an em dash.

`runnerOutcomeDetail` is the wiring; these are the arms that die when it is removed.

## `packages/plugins/managed-scan/src/index.ts`

### §467. The managed-scan executor, a thin orchestrator

`@scp/plugin-managed-scan` — the `scp-managed-scan` executor, the thin orchestrator behind the commander's **promotion scan step** (ADR-0020 §1, proposal §13.3, charter's Managed Execution Exception 2026-07-23 amendment). It MIRRORS `@scp/plugin-managed-iac` exactly in shape: a thin orchestrator that launches an ephemeral single-shot runner container from a SEPARATE image (`scp-runner-scan`, `apps/runner-scan`) and copies evidence out — it contains no scanner itself (the scanner exists ONLY in the runner image, exactly as `tofu` exists only in `scp-runner-iac`).

WHAT THIS PLUGIN DOES (and does NOT): it runs one scan container per `trigger()` — `docker create --network none` (server-injected, default `none`), `docker cp` the SERVER-pulled OCI image layout IN, `start -a`, `docker cp` the runner's `/work/out` evidence back OUT to a server-controlled directory, `rm -f`. It does NOT pull the subject's bytes (the SERVER does that, by digest, over the allowlisted skopeo channel — the runner has NO network) and it does NOT parse the Trivy result into `ScanEvidence` (the COMMANDER does that, where `ScanEvidenceSchema` and the M17.5 threshold resolution live — same split as scp-runner-iac, where the orchestrator persists evidence the ephemeral container produced). So this plugin adds NO new verb (charter principle 1): `observe()` returns `[]`, `trigger()` runs the container, `status()`/`abort()` report it.

SECURITY MODEL (mirrors managed-iac's adversarial-review CRITICAL #1): `dockerBinary` decides WHAT EXECUTABLE runs, and `runnerImage`/`networkMode`/`workspaceRoot` decide what image runs and on which network — they are **operator/server-governed, NEVER tenant-suppliable**. The manifest `configSchema` below is `additionalProperties: false` and lists ONLY `timeoutMs`, so a binding that tries to set any of them is rejected at create/update; the server injects them into this plugin's config when it provisions the instance (`coordination/executor-bindings-repo.ts`'s `resolveExecutorPluginInstance`, spread LAST so they win). The runner is launched with NO docker socket mount, NO bind mount (the workspace is `docker cp`'d in/out, never mounted — a host-path escape is structurally impossible), and the server-fixed `--network` (default `none` — the runner reaches no hosts).

THAT SCHEMA IS ONLY A GATE IF THE SERVER RUNS IT. It did not, for this module: `managed-scan` was on `KNOWN_EXECUTOR_MODULES` but absent from `apps/server`'s `MANIFEST_BY_MODULE`, and `validatePluginConfig` returned early for a module it had no manifest for — so a tenant binding could set `dockerBinary` to any host path and this plugin would `execFile` it. The paragraph above described a protection that was never wired up. Both halves are now pinned by tests (`plugin-manifests-fail-closed.test.ts`): the schema refuses the governed keys, AND every allowlisted executor module is asserted to HAVE a manifest.

SYNCHRONOUS TRIGGER (deliberate v1 simplification, exactly as managed-iac): `trigger()` runs the container to completion; a scan is a short, read-only analysis of an artifact already materialized locally, so there is nothing to poll or abort by the time a ref exists.

### §468. SERVER-INJECTED (never tenant)

SERVER-INJECTED (never tenant) — WHICH LAUNCHER ADAPTER RUNS THIS PLUGIN'S RUNNER (M23.2).

Absent, or anything other than `"kubernetes"`, means the Docker adapter — so a deployment that does not opt in behaves byte-identically, which is what makes a second adapter safe to merge. The same TWO INDEPENDENT DEFENCES `dockerBinary` has apply here from day one: this plugin's manifest is `additionalProperties: false` with these keys absent, so a binding carrying either is rejected at the write door (`plugin-manifests-runner-launcher.test.ts` pins the refusal by name), and the server injects them LAST so a regression in the write door downgrades from a launcher swap to an accepted-but-overwritten key.

### §469. The methods this runner image ships

The methods this runner image ships — `trivy` (container images), `openscap` (compliance), and `trivy-vm` (the 13.3a MACHINE-IMAGE arm: the runner resolves the disk image carried by the pulled OCI layout and `trivy vm`s it). A `trigger()` naming any other method fails closed here rather than launching a container that would `exit 2`.

Deliberately mirrors — and must stay in step with — the server's `RUNNER_SUPPORTED_METHODS` (`promotion-scan-step.ts`). The duplication is structural, not laziness: this package does not depend on `@scp/schemas` (a plugin runs behind the subprocess isolation host and carries the minimum surface), so the set is exported instead and the SERVER-side test pins the containment that actually matters — every method the server dispatches must be one this plugin will run.

### §470. HOST path to the OCI image layout the SERVER pulled by digest

HOST path to the OCI image layout the SERVER pulled by digest (copied INTO the container's `/work/image`). The runner has no network and pulls nothing. For `trivy-vm` this layout carries the MACHINE IMAGE (a disk-image layer, or a tar layer containing one — run.sh's packaging convention); the copy-in seam itself is identical, so the machine-image arm adds no new ingress and no new egress.

### §471. A server-provided host path to a preloaded scanner cache

M13.3b-ii — SERVER-provided HOST path to a pre-loaded Trivy DB cache dir (a Trivy `--cache-dir` layout: `<dir>/db/{trivy.db,metadata.json}`). When set, it is `docker cp`'d into the runner at `/work/db` and `SCP_SCAN_DB_DIR=/work/db` is set, so run.sh points Trivy at the pre-loaded DB INSTEAD of the image-baked default. Unset ⇒ the runner uses the baked DB (fail-closed fallback). Server-governed like inputDir; a tenant cannot supply it (the promotion scan step resolves it).

### §472. Launch the single-shot scan container

Launch the single-shot scan container. COPY the pulled layout in / evidence out (never bind-mount; mirrors managed-iac's CRITICAL #1 fix + the dind-share fix). The ONE place the runner image is executed — with the server-fixed `--network` (default `none`), no docker.sock, no `-v`.

M23.1: the create/copy-in/start/copy-out/remove sequence itself lives in `@scp/runner-launcher`, shared with `@scp/plugin-managed-iac` and `@scp/plugin-managed-dep`. What stays HERE is what is this plugin's own — the one-to-three copy-in shape, the two conditional `-e` pairs that pair with them, the 32 MiB buffer, and a copy-out that is `on-success` + `propagate`.

### §473. When the server provides a pre-loaded DB / SCAP dir

When the server provides a pre-loaded DB / SCAP dir (M13.3b-ii) we set the env that steers run.sh to it — still `--network none`, still copied IN and not mounted, so a host-path escape stays structurally impossible. THE `-e` PAIRS AND THE COPIES ARE INDEPENDENTLY CONDITIONAL and in a FIXED order (DB then SCAP for the env, subject/DB/SCAP for the copies); the golden's "middle case" exists because a launcher that emitted both whenever EITHER was present would otherwise pass.

### §474. Both are container paths, not secrets, so they stay in argv

BOTH `SCP_SCAN_*_DIR` ARE CONTAINER PATHS, NOT SECRETS, so they stay on the command line as `-e` and this plugin's five golden `create` lines do not move by a byte beyond the name and labels. The secrecy split is not a "hide the environment" reflex; it is the axis the Kubernetes adapter must branch on, and mislabelling a path as a secret would cost a Secret object per run for nothing.

### §475. ONLY ON SUCCESS, AND NOT GUARDED

ONLY ON SUCCESS, AND NOT GUARDED — the opposite of managed-iac on both axes. A failed scan must produce NO evidence (fail-closed: the commander writes none and E6 then refuses), and a failed copy-out propagates as a rejection rather than being swallowed by the launcher. M23.0 recorded that the rejection then left the run reporting `pending` forever, and this comment claimed the defect was deliberately preserved. IT IS NOT, AND THAT IS MEASURED: M23.1 phase 2's `withRecordedOutcome` (below) catches the rejection and records `failed` — `launch-argv.golden.test.ts`'s "A FAILED COPY-OUT IS NOT SWALLOWED" case fails the second `docker cp` and asserts `status()` reports `failed`.

### §476. BOUNDING ONE ENTRY DID NOT BOUND THE MAP

BOUNDING ONE ENTRY DID NOT BOUND THE MAP (MEDIUM, M23.0 verification pass 7 finding M1). Same property managed-iac's durable ledger had, in RAM: nothing here pruned anything, ever, so a long-lived plugin instance accumulated one ~4 KB entry per scan for the life of the process.

A LOOSER CAP THAN THE DURABLE ONE, deliberately. managed-iac re-parses its whole ledger on every poll, so its size is CPU per tick; this is a `Map.get`, O(1) whatever the size, and it is lost on restart anyway. The cost here is memory alone: `RUN_OUTCOME_CACHE_MAX_IN_MEMORY` x ~4.2 KB, about 4 MB worst case. Treating the two caches as one problem would either waste memory here or re-introduce the parse cost there.

WHAT AN ENTRY MUST OUTLIVE: `trigger()` runs the scan synchronously to completion before writing the entry, so the only reader left is reconcile's next `status()` poll.

### §477. A PLAIN `string`, not {@link BoundedDetail}

A PLAIN `string`, not `BoundedDetail` — the M3 boundary move. The brand stays on what is STORED (`outcomes`' value type, so no reader can be handed a megabyte) and this is the only thing that mints one. A brand on a FIELD forces a conversion at every literal that builds the record, which is how one concept came to have 26 manual call sites across four packages, most of them pinned by no failing test.

### §478. EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME

EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME (M23.1 phase 2). Before this, nothing below caught a rejection: a launcher failure escaped `trigger()` as a rejection, no outcome was ever cached, and `status()` reported `pending` forever — indistinguishable from "still running". `redact` is the identity function because this plugin holds no credential — a scan reads bytes the server already pulled, `secretEnv` is always `[]` — so there is nothing for it to strip; that absence is a fact about managed-scan, not a shortcut taken here.

### §479. THE SUCCESS ARM IS NOT `runnerOutcomeDetail`, DELIBERATELY

THE SUCCESS ARM IS NOT `runnerOutcomeDetail`, DELIBERATELY: on success this plugin records where the EVIDENCE landed rather than a Trivy report that can run to 32 MiB. The FAILURE arm is, because `result.stderr` was the empty string for a budget-killed scan and for a `docker` that never spawned alike — see `classifyRunnerFailure`. NOT `.slice(0, 2000)`. That front-slice was unreachable-by-construction for this plugin: the port appends the runner's last words AFTER `err.message`, which carries the whole of stderr, so at EVERY output size the 2000 characters kept here were Node's `Command failed:` preamble and the diagnosis was thrown away. The bound now lives where the string is composed and keeps the END.

### §480. THE LAUNCHER SEAM

THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose. Adapter selection is not tenant-facing, and a new config field would have to join the server-injected, never-tenant-settable class in all three enforcement layers (this manifest's `configSchema`, `validatePluginConfig` at the four write doors, and the LAST-wins injection sites) for behaviour no caller can yet ask for. THIS PLUGIN IS THE REASON THAT RULE IS WRITTEN DOWN: it shipped a live RCE by sitting on `KNOWN_EXECUTOR_MODULES` with no manifest, so `dockerBinary` was tenant-settable and `execFile`d.

### §481. THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE

THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE — M23.2, AND THIS LINE IS THE WIRING. `subprocess-entry.ts` constructs this plugin with NO argument, so whatever stands here is what every production run uses. While it was `resolveDockerRunnerLauncher`, an operator could set `runnerLauncher: "kubernetes"` through every layer of the chart and every managed run would still shell out to a `docker` binary the `scpd` image does not ship — a feature correctly built and installed nowhere, which is this repository's dominant defect class (CLAUDE.md). Delete this and `runner-launcher-selection.test.ts`'s named case for this plugin dies.

### §482. Manifest `configSchema` is the TENANT-facing surface only

Manifest `configSchema` is the TENANT-facing surface only — `additionalProperties: false` so a binding that tries to set the server-governed `dockerBinary`/`runnerImage`/`networkMode`/ `workspaceRoot` fields is REJECTED at create/update. The server injects those fields into this plugin's runtime config itself (executor-bindings-repo.ts's `managedScanServerSettings`).

### §483. BOUNDED AT BOTH ENDS

BOUNDED AT BOTH ENDS (M23.1c). The `maximum` is the half that was missing: with only a floor, a tenant could set 2^31 and make the runner unkillable by its own timeout AND unbound the plugin-host RPC budget derived from it. Enforced at every write door by `validatePluginConfig` (Ajv honours `maximum`), and clamped again host-side for rows stored before the ceiling existed.

## `packages/plugins/managed-scan/src/launch-argv.golden.test.ts`

### §484. The golden Docker argv, recorded before anything moves

M23.0 — THE GOLDEN DOCKER ARGV FOR `scp-managed-scan`, RECORDED BEFORE ANYTHING MOVES

WHY THIS FILE EXISTS, AND WHY M23.1 DID NOT RETIRE IT. M23 extracts a `RunnerLauncher` port so the three managed executors can also launch their runners as Kubernetes Jobs. That refactor's central promise is that **the Docker path is byte-for-byte unchanged**. A promise like that is only checkable if the current bytes were written down FIRST, by a test that existed BEFORE the refactor — otherwise the "unchanged" baseline is whatever the refactor happens to emit, and the assertion is a tautology.

THE PARAGRAPH THAT USED TO SIT HERE WAS WRONG, AND THIS ONE REPLACES IT. It said that until M23.1 landed the port this file was the definition of "unchanged", and that when the port landed these tests were "to be **deleted or superseded** by the port's own conformance suite". M23.1 HAS LANDED. It did NOT retire this file, and that standing instruction is withdrawn — because the port's conformance suite (`packages/runner-launcher/src/docker-adapter.test.ts`) and this file prove DIFFERENT things, and neither implies the other: - THE CONFORMANCE SUITE drives `createDockerRunnerLauncher` DIRECTLY. Its subject is what the adapter emits FOR A GIVEN `RunnerSpec` — argv, per-call `timeout`/`maxBuffer`, both copy-out axes, the failure paths. A `RunnerSpec` is its INPUT. - THIS FILE drives `plugin.trigger()`. Its subject is THE OTHER HALF, which the conformance suite structurally cannot reach: that this plugin still hands the port THE SAME SPEC it used to build by hand. A spec field changed here — a copy-IN that stopped being conditional, or an `onFailure: "propagate"` relaxed to `"swallow"` — produces a perfectly CONFORMANT launch of the WRONG container, and the conformance suite is blind to it, because that spec is what it is handed rather than what it checks. Deleting this file on the strength of the old sentence would take the plugin→port boundary to ZERO coverage while every task stayed green — the vacuous-green class BUILD_AND_TEST.md §4.4 names, and the same reason `@scp/runner-launcher` no longer runs with `--passWithNoTests`. RETIRE THIS FILE ONLY ALONGSIDE SOMETHING THAT COVERS THAT BOUNDARY, never merely alongside something that covers the adapter.

WHAT IS PINNED, AND WHY EACH PART IS PART OF THE PROMISE. 1. THE FULL argv ARRAY of every `execFile`, in order. Asserted as an array against a literal, never as "contains" or as a call count: a renamed binary, a reordered flag or a dropped operand must fail, and must fail by PRINTING the actual argv next to the expected one. 2. THE OPTIONS OBJECT alongside each argv. managed-scan runs 10 min / **32 MiB** — the largest of the three, because a Trivy report is the biggest thing any of these runners writes to stdout — while managed-iac is 16 MiB and managed-dep 8 MiB. `rm` alone carries a 30 s timeout AND NO `maxBuffer` AT ALL. A port that unified those into one shared default would be a behaviour change wearing a refactor's clothes. `toStrictEqual` is what makes the ABSENCE of `maxBuffer` on `rm` — and the absence of any `cwd`/`env` anywhere — part of the record. 3. THE CONDITIONALITY THAT IS SPECIFIC TO THIS PLUGIN: managed-scan issues **one to three** copy-IN calls. The subject layout always; `/work/db` only when the server resolved a pre-loaded Trivy DB; `/work/scap` only when it resolved SSG content (M13.3b-ii). Each optional copy is paired with its own `-e` on the `create` line, and the `-e` pairs come in a fixed order that is not the same order as the copies would need to be discovered in. All of that is pinned, not normalised. 4. THE FAILURE PATH: on a rejected `start` there is **no copy-out at all** — the opposite of managed-iac, which copies out unconditionally. And this plugin's copy-out is **not** catch-guarded, so a failed copy-out fails the RUN rather than being swallowed (M23.1 phase 2: it is recorded as `failed` via `withRecordedOutcome`, not left to escape `trigger()` as a rejection with nothing cached). Both halves of that asymmetry are measured below. 5. THAT THE SECRECY SPLIT DID NOT TOUCH THIS PLUGIN'S ENVIRONMENT. When `RunnerSpec.env` was split into `env` and `secretEnv`, the five `create` lines below moved by EXACTLY the `--name` and the two `--label` pairs and by nothing else: `SCP_SCAN_DB_DIR` and `SCP_SCAN_SCAP_DIR` are container PATHS, not credentials, so they stay `-e` and NO `--env-file` is written for a scan at all. Asserted rather than assumed — a reflex to route "the environment" through an env-file would have cost a Kubernetes Secret per scan for nothing, and all four preload combinations below would have had to be re-recorded. 6. THE PER-RUN NAME AND LABELS (M23.0 defect 1). `--name scp-runner-<idempotencyKey>` and the two `scp.*` labels, immediately after `--network` and before any `-e`; and teardown addressing that NAME rather than the id `create` printed, because the name is the only identity that also exists on the path where `create` itself is what failed.

THE RECORDING SEAM is the one this package already uses — `vi.mock("node:child_process")` with a hand-written `execFile`, the same shape as `index.test.ts` here and `runner-containment.test.ts` in `@scp/plugin-managed-dep`. The only widening is that the options object (which those files discard as `_opts`) is now recorded too, because point 2 above is half the promise. No Docker is required, so these run on every PR under `pnpm test`.

### §485. M23.1 PHASE 4 — the reaper

M23.1 PHASE 4 — the reaper. `reap()` now runs at the top of every `run()`, issuing a `docker ps -a --filter label=...` before `create` and stamping two more `--label` pairs onto every `create` it issues. Neither is this file's subject (its own dedicated coverage is `@scp/runner-launcher`'s `docker-adapter.test.ts` and `reaper.integration.test.ts`), so both are kept out of the golden entirely: the `ps` call is answered with an empty listing and never recorded, and the two labels are stripped off `create`'s argv before it reaches `calls`.

### §486. The options: the buffer as a literal, the timeout as a bound

THE OPTIONS — `maxBuffer` AS A LITERAL, `timeout` AS THE BOUND IT MUST NOW LIE IN (M23.1e)
Deliberately NOT imported from `index.ts`: a golden that re-derives its expectation from the code it is guarding cannot detect a change to that code. 32 MiB is written here because that is what the plugin does TODAY.

WHY `timeout` STOPPED BEING AN EQUALITY. `RunnerSpec.timeoutMs` is the WHOLE-RUN budget since M23.1e, so each step is issued with what is LEFT of it (`deadline - now`, off one clock read at the top of `run()`). Handing every step the full `timeoutMs` was the defect this golden used to pin: six sequential calls, each individually under the bound, made a run of six x timeoutMs, which the host's own budget — sized `timeoutMs + grace` — then SIGKILLed, orphaning the container and leaving the idempotency ledger unwritten.

So the assertion is the PROPERTY: never ABOVE the caller's budget (that is the old behaviour back), and never more than `BUDGET_SLACK_MS` below it in this seam, where every step settles on the next tick — which is what stops a degenerate "always 1ms" from passing. The strict decrease across a run and the refusal once nothing is left are proven where they can be measured: `@scp/runner-launcher`'s `whole-run-budget.test.ts`.

`toStrictEqual` KEEPS ITS TEETH — the matcher stands in for the `timeout` VALUE only, so the ABSENCE of `maxBuffer` on `rm` and of every other key everywhere is still pinned exactly.

### §487. The env pairs and copy-ins are independently conditional

The `-e` pairs and the copy-INs are INDEPENDENTLY conditional, so the two preload flags span four combinations: neither (test 1), both (test 2), DB-only (test 3) — and this one, which was the only one left unpinned. Without it, a launcher that emitted `SCP_SCAN_DB_DIR` whenever ANY preload was present, or that copied `/work/db` from `scanScapDir`, passes all three others: no test above ever exercises `scanScapDir` WITHOUT `scanDbDir`, so the second condition is only ever observed while the first is also true. Rare in production (SSG has no OCI upstream to refresh, §13.3b's documented asymmetry) but reachable — an air-gapped site that seeded SSG content by hand and lets Trivy use the image's own bundled DB is exactly this shape.

It also pins the `""` positional arm: openscap with neither `profile` nor `datastream` puts TWO EMPTY STRING OPERANDS on the command line, which is what lets run.sh's `${2:-default}` form apply its own defaults. A launcher that dropped empty operands instead of passing them would shift `datastream` into `profile`'s position.

CORRECTION TO THIS FILE'S OWN RECORD (and to commit 53bf2f4d's message, which cannot be rewritten because it is published). Both claimed that dropping empty operands would happen with "nothing else" noticing, and 53bf2f4d's message claimed the sharper form: that of the four mutations it measured, "the new one ALONE fails". THAT IS TRUE OF THREE OF THEM AND FALSE OF THE FOURTH. Re-measured, each mutation applied to `src/index.ts` in turn:

```text
the DB `-e` fires whenever EITHER preload is present   -> only this case fails
the /work/db copy-IN takes whichever dir it can find    -> only this case fails
the SCAP copy-IN needs a DB preload too                 -> only this case fails
empty positional operands are DROPPED, not passed       -> TWO tests fail: this case AND
  `src/index.test.ts` > "openscap dispatch (M13.3b) > passes empty positional args when
  profile/datastream are unset (run.sh applies defaults)", which already covered that arm.
```

The SUBSTANTIVE claim of 53bf2f4d survives intact and is the one that mattered: the three PRE-EXISTING preload combinations survive all four mutations, so the fourth combination was genuinely unpinned. Only the "alone" wording was wrong — an overstatement of novelty, in the direction that flatters the new test. Recorded here rather than quietly dropped, because a measurement claim that nobody re-ran is indistinguishable from one that was never made.

### §488. The second half of the asymmetry

The second half of the asymmetry: managed-iac wraps its copy-out in `.catch(() => undefined)`; managed-scan does not, so the same Docker failure that leaves an iac run "succeeded" makes a scan run fail. M23.1 PHASE 2 CHANGED WHAT HAPPENS TO THAT FAILURE, not the argv: it used to escape `trigger()` as a rejection with no outcome cached (`status()` reported `pending` forever); `trigger()` now RESOLVES and the failure is recorded via `withRecordedOutcome`, so `status()` reports `failed` with the launcher's own message. The argv/opts assertions below are UNCHANGED — this is the same five-call sequence as before, only what `trigger()` does with the outcome moved.

## `packages/plugins/managed-scan/src/launcher-seam.test.ts`

### §489. The standing gate that the port is installed, not present

M23.1 — THE STANDING GATE THAT THE PORT IS INSTALLED, not merely present.

See `@scp/plugin-managed-iac`'s file of the same name for why this is separate from `launch-argv.golden.test.ts`: the golden proves the Docker bytes are unchanged and would keep passing if this plugin retained a private copy of the launch sequence with `@scp/runner-launcher` dead beside it. The only check that distinguishes the two is to delete the wiring — here, by injecting a launcher that throws — and require a named test to die.

M23.1 PHASE 2 CHANGED WHAT "DIES" LOOKS LIKE. Before phase 2, `trigger()` had no outer catch, so an injected launcher's throw escaped as a REJECTION and this test asserted that. It no longer does — `trigger()` now resolves, and the failure is recorded via `withRecordedOutcome` instead — so the first test below was rewritten rather than deleted, to the STRICTER shape managed-dep's own seam test already used: a plugin that kept a private, second launch path would report `succeeded`, and one that recorded a generic failure without the injected launcher's own message would fail the `detail` match. Editing this in place (rather than deleting it) is itself the gate for phase 2's fix — a bare deletion here would make phase 2's whole "every path records" property untestable in this plugin the same way it is meant to prove installed.

THIS PLUGIN IS THE ONE WHERE THE SEAM'S CONFIG SURFACE HAS TEETH. `dockerBinary` decides which executable runs, and managed-scan shipped a live RCE because it sat on `KNOWN_EXECUTOR_MODULES` with no manifest, so `validatePluginConfig` returned early and a tenant binding could set it. The second test below pins that the resolver is handed exactly that one field and nothing else has been invented alongside it — M23.1 adds NO new key to the server-injected class.

### §490. `toStrictEqual` on the WHOLE object, not a property check

`toStrictEqual` on the WHOLE object, not a property check: the point is the ABSENCE of any further adapter-selection key, because every key here joins the server-injected, never-tenant-settable class and must be added to all three enforcement layers in the same change. M23.2 is where that happens; M23.1 must not smuggle one in early. M23.2 UPDATED THIS LINE, AND IT WAS SUPPOSED TO. The comment above says "M23.2 is where that happens; M23.1 must not smuggle one in early" — so this assertion is the placeholder that makes the adapter-selection field arrive DELIBERATELY rather than by accident, and updating it is the act of arriving. It stays `toStrictEqual` on the WHOLE object for the reason it always was: every key here joins the server-injected, never-tenant-settable class and must move through all three enforcement layers in the same change. A FOURTH key appearing here still fails, which is the property being kept.

### §491. THE WHOLE SPEC, `toStrictEqual`

THE WHOLE SPEC, `toStrictEqual`. See `@scp/plugin-managed-iac`'s file of the same name for the measurement that forced it: with the three goldens deleted, three load-bearing fields could be flipped at once and the whole repo stayed green. The goldens still own the Docker BYTES and the four preload combinations; these six fields now also live in a file that carries no deletion hazard in its header.

### §492. No preload dirs in this intent, so NEITHER `-e` pair fires

No preload dirs in this intent, so NEITHER `-e` pair fires. The two are INDEPENDENTLY conditional; that independence is the golden's four-combination matrix. They stay in `env` even when they DO fire: `SCP_SCAN_DB_DIR`/`SCP_SCAN_SCAP_DIR` are container PATHS, not secrets, which is why this plugin's five golden `create` lines did not move when the secrecy split landed.

## `packages/plugins/managed-scan/src/managed-scan.integration.test.ts`

### §493. REAL-DOCKER PLUGIN-LEVEL INTEGRATION TEST

REAL-DOCKER PLUGIN-LEVEL INTEGRATION TEST — closes the M13.3 DEBT named in `@scp/source-census`'s `test-script-census.test.ts` (`INTEGRATION_FLAG_ALLOWLIST` / `KNOWN_EMPTY_INTEGRATION_SUITES`, both entries for `@scp/plugin-managed-scan`): this package had a `vitest.integration.config.ts` and a `test:integration` script with ZERO `*.integration.test.ts` files, so `pnpm test:integration` reported SUCCESS for this package having run nothing, in every shard. Delete both of those source-census entries when this file merges.

SCOPE SPLIT FROM `apps/server/src/federation/promotion-scan-step.integration.test.ts` — READ THAT FILE'S HEADER FIRST. That suite is the M13.3a/b DoD's real end-to-end proof: the SERVER pulls a real subject by digest, launches this same plugin's REAL container for trivy/openscap/trivy-vm, and the UNMODIFIED E6 gate consumes the evidence — exhaustively, calibrated clean/dirty per method. This file does NOT re-run that; scan-correctness-by-method is already proven there against the same container. What is NOT proven there is the PLUGIN'S OWN CONTRACT IN ISOLATION FROM THE SERVER — the launcher wiring actually runs a REAL container end to end (create -> copy-in -> start -> copy-out -> rm) and returns real evidence at the path this plugin promises, and an unsupported method fails closed WITHOUT touching docker at all.

NO DEDUP LEVER HERE, UNLIKE MANAGED-IAC — VERIFIED, NOT ASSUMED. This file's first draft carried over managed-iac's "broken dockerBinary on a same-key retry still returns the cached success" lever by pattern-matching its shape without reading THIS plugin's `trigger()`. Running it against a real container red-lit immediately: managed-scan's `outcomes` map (module doc, `index.ts`) is explicitly "no cross-restart idempotency to preserve" — every `trigger()` call re-runs the container regardless of `idempotencyKey`, because a scan is a fresh, stateless, read-only analysis with no dangerous side effect a dedup would be protecting against (unlike an `apply`). The retry test below asserts the ACTUAL contract instead: a same-key retry is SAFE and produces a stable `externalId`, but it is a REAL second invocation — a broken `dockerBinary` on the retry surfaces as a real failure, not a cache hit.

Trivy is exercised (not openscap/trivy-vm — those methods' correctness is the server suite's job; this file's job is the launcher contract, and trivy is the cheapest real method to prove it with).

SUBJECT, DELIBERATELY VIA `SCP_TEST_SUBJECT_REGISTRY` (mirrors `promotion-scan-step.integration.test.ts` and `scan-db-preload.integration.test.ts`): a literal `docker.io/library` here would be a live, unauthenticated Docker Hub pull on the required integration gate — the exact failure mode documented in those two files' headers. Unset (local dev) this is upstream Docker Hub; in CI it is the GHCR mirror `scripts/ci-mirror.sh seed` exports, already covering `alpine:3.20` for the two scan suites above.

NO REGISTRY CONTAINER NEEDED. The server-side test pushes subjects into a local `registry:2` and pulls them back because it is proving the SERVER's own `docker://` pull-by-digest channel. This plugin never talks to a registry — `trigger()`'s `inputDir` is already a pulled OCI layout on disk — so this file produces that layout directly with one `skopeo copy … oci:<dir>:scan`, the exact command `promotion-scan-step.ts`'s server-side pull runs.

## `packages/plugins/managed-scan/src/pin.test.ts`

### §494. SCANNER PIN DRIFT GATE

SCANNER PIN DRIFT GATE (mirrors deploy/airgap/src/cosign-bin.test.ts's role for cosign): the single sources of truth are `tools/trivy/pin.env` and `tools/openscap/pin.env`; `apps/runner-scan/Dockerfile`'s `ARG TRIVY_IMAGE` / `ARG OPENSCAP_IMAGE` defaults carry copies. This test fails the build if a copy drifts — so the runner image can never be built FROM anything but the vetted, human-verified pins. Pure text parsing — no Docker, runs in the fast `pnpm test` layer. It is also a FAIL-CLOSED VERSION check: an unset/blank pin (the old stub state) fails the suite.

WHY THE DOCKERFILE IS READ THROUGH `@scp/source-census` AND NOT `readFileSync`
MEASURED 2026-08-17: commenting out `ARG TRIVY_IMAGE=` and `ARG OPENSCAP_IMAGE=` in `apps/runner-scan/Dockerfile` left this file green at 7/7. `readPin` below was already immune (it skips `#` lines), but every Dockerfile assertion read raw text, so a drift gate over the pins that decide WHICH SCANNER BINARY RUNS could be satisfied by a comment.

The oscap-version case was worse than a hypothetical: `apps/runner-scan/Dockerfile` carries TWO prose comments (lines 42 and 85) that quote the assertion — ``oscap --version | grep -qF "(oscap) ${OPENSCAP_PINNED_VERSION}"`` — verbatim, to explain it. The unanchored search below matched those comments, so the RUN step doing the actual fail-closed check could have been deleted outright with this suite still green. That is the "well-written comment naming a hazard" trap from CLAUDE.md, live: the documentation of a control was standing in for the control.

Two readers, because the shapes differ: `atLineStart` for the `ARG …=` lines (which begin their line, so a `#` cannot precede them), and `readHashStripped` for the `RUN` block, whose live lines are CONTINUATIONS starting `&& oscap …` / `\` and therefore cannot be anchored at all.

AND THE LIMIT: this fixes the comment case and no more. It still cannot see a `FROM` stage the final image never draws from, a `RUN` behind a shell condition that is never true, or the same text inside a heredoc. What the pin CANNOT be talked out of is the build itself — the `oscap --version | grep -qF` step fails the image build on drift, and `scanner-containment.test.ts` proves the scanners exist nowhere else.

THAT BACKSTOP CLAIM, VERIFIED RATHER THAN ASSERTED (2026-08-17)
"The build itself is the real gate" is exactly the shape of claim that turns out to be false — a signal that is read while no actuator exists. So it was checked, and it holds. Both halves:

```text
THE STEP IS REAL. `apps/runner-scan/Dockerfile` names the version assertion three times: lines
42 and 85 are the PROSE COMMENTS described above, and line 90 is the live `RUN` continuation
that pipes a `--version` call into `grep -qF` against `${OPENSCAP_PINNED_VERSION}`.
`readHashStripped` removes whole-line `#` comments, so 42 and 85 are gone by the time the
assertion below runs and only line 90 can satisfy it. That is the M21.7 fix doing its job,
confirmed by reading the stripped text rather than by trusting the change.
```

```text
THE QUOTE THAT USED TO BE HERE WAS ITSELF A CONTAINMENT VIOLATION, which is worth leaving a
note about rather than silently rewording. This paragraph originally reproduced line 90
verbatim, `&&` and all — and `scanner-containment.test.ts` failed it, because a scanner name in
shell COMMAND POSITION inside a `packages/**` file is exactly what that gate forbids, and its
invocation detector reads RAW on purpose so a comment cannot hide one. The gate was right: a
file explaining a control had started to look like the control. Describe the step; do not
re-type it. (`packages/source-census`'s own fixture was fixed for the same reason in fb3e1a2,
by renaming its sample binary to a neutral placeholder.)
```

```text
THE BUILD ACTUALLY RUNS, ON EVERY PR. CI job 4c ("Prebuild + publish runner images to GHCR")
builds `apps/runner-scan` with no main-only guard — its own comment: "Runs on every push/PR …
so a PR that touches a runner Dockerfile or a scanner pin rebuilds + republishes before the
integration job pulls it." A version drift therefore fails a PR check, not just a release.
```

The one thing neither half covers: DELETING the `RUN` step. The build would then succeed with no assertion at all, and only the census below would notice — which is precisely why it is anchored to the code rather than reading raw text, and why it is worth keeping now that the prose comments can no longer satisfy it.

## `packages/plugins/managed-scan/src/runner-launcher-selection.test.ts`

### §495. The standing gate that adapter selection is installed

M23.2 — THE STANDING GATE THAT ADAPTER SELECTION IS *INSTALLED*, NOT MERELY BUILT.

`launcher-seam.test.ts` proves this plugin launches through the injected `RunnerLauncher`, and every one of its cases injects a resolver. That is precisely why it CANNOT prove this: production injects nothing. `apps/server/src/plugin-host/subprocess-entry.ts` constructs this plugin as `createManagedScanExecutorPlugin()` — no argument — so the DEFAULT PARAMETER is the whole of the production wiring, and a test that always passes its own resolver never touches it.

That is this repository's dominant defect class, named in CLAUDE.md: a component built, tested through a seam that bypasses the wiring, and installed nowhere. It has happened six times in one session, including a live RCE on main. The only check that works is to delete the wiring and watch a NAMED test die — so this file constructs the plugin with NO ARGUMENT and requires the Kubernetes adapter to be reached. Revert the default parameter to `resolveDockerRunnerLauncher` and this dies; nothing else in the repository does.

### §496. A second production construction path, easiest to miss

AND THIS PLUGIN HAS A SECOND PRODUCTION CONSTRUCTION PATH, which is the one easiest to miss: `apps/server/src/federation/promotion-scan-step.ts` calls `createManagedScanExecutorPlugin()` IN-PROCESS, bypassing the plugin-host boundary entirely (recorded as STILL OPEN at BUILD_AND_TEST.md M23.1d). Both paths call the zero-argument factory, so this case covers both — and `apps/server`'s own `managed-runner-selection.test.ts` pins that the commander's promotion scan context carries the selection at all, which is the half this package cannot see.

### §497. No process is spawned on the Kubernetes path

M23.6 CLAUSE 1 — NO PROCESS IS SPAWNED ON THE KUBERNETES PATH
The clause asks for the recorded SPAWN, not a mock's call count, "so a renamed binary cannot pass it". `runnerSpawns()` records the binary as it was handed to `execFile` and nothing else in the package can start a process — `no-docker-on-kubernetes.test.ts` censuses that. Measured before the ledger existed: a real `execFile(dockerBinary, ["version", …])` in `resolveRunnerLauncher`'s KUBERNETES branch left the whole workspace green.

### §498. Never constructed, which is stronger than never called

M23.6 CLAUSE 7 — NEVER *CONSTRUCTED*, WHICH IS STRONGER THAN NEVER CALLED
The `io is NEVER touched` case above is a statement about CALLS. Measured: making the Docker branch of `resolveRunnerLauncher` build `createFetchKubernetesIo(...)` AND `createKubernetesRunnerLauncher(...)`, discard both and return the Docker launcher left `pnpm -w test` green (72/72). This arm is what that mutation now fails.

### §499. M23.6 CLAUSE 1, BEHAVIOURALLY

M23.6 CLAUSE 1, BEHAVIOURALLY — THE SPAWN IS OBSERVED FROM OUTSIDE THIS PROCESS

WHY THE LEDGER ARM ABOVE IS NOT ENOUGH, MEASURED. `runnerSpawns()` records what goes THROUGH `spawnRunnerProcess`. A real `child_process.execFile(dockerBinary, …)` on the Kubernetes path goes nowhere near it: planted in `resolveRunnerLauncher`'s Kubernetes branch it left this file, its two siblings and the whole workspace GREEN while fourteen processes were actually created. What caught it was a source census — and a census proves the presence of TEXT, never the absence of an EXECUTION, which is this repository's most expensive standing confusion.

SO THIS CASE RUNS THE PLUGIN IN A CHILD `node` whose `node:child_process` was wrapped before the plugin loaded, and asserts over the processes that were actually created. It carries its OWN control in the same child, in order: the Kubernetes trigger first (nothing may be created), then a Docker trigger (something must be), so an observer that had silently stopped observing fails the second half rather than passing the first.

### §500. M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT

M23.6 CLAUSE 1, THE HOLE EVERY CASE ABOVE LEFT: the `io` THIS SUITE ALWAYS INJECTS

Every case above hands the plugin a `kubernetes.io`. `resolveRunnerLauncher` reads it as `k8s.io ?? createDefaultKubernetesIo(…)`, and the right-hand side of a `??` is not evaluated when the left is present — so the transport the resolver builds FOR ITSELF, which is the only one production ever gets, was evaluated by no test in this repository.

MEASURED, NOT SUSPECTED. A `spawnSync(config.dockerBinary ?? "docker", ["version"])` planted on that right-hand side, in a NEW module so that no `node:child_process` string appears in `kubernetes-adapter.ts` for the source census to find, executed a REAL `docker version` while `@scp/runner-launcher` reported 427/427 and the three managed plugins reported 38 + 50 + 255 — every suite green, including the observed case above. A marker file proved the probe was reached rather than merely present.

So this case injects NOTHING: no `io`, and NO `dockerBinary` either. The Kubernetes adapter is not given a container binary in production and must not need one, so with the field absent the only name a probe can reach for is `DEFAULT_DOCKER_BINARY` — and the assertion is simply that this child created no process at all, with no binary name guessed in advance.

TWO THINGS MAKE THE EMPTY LIST MEAN SOMETHING, because a green negative arm was already worthless once: `kubernetesConstructionCount()` must move by TWO (the launcher AND the transport the resolver built — an injected `io` makes it one, which is what every case above produces), and the run must fail naming the projected service-account token path, which is proof the resolver's own `readToken` closure actually executed. The observer's own liveness is then proven in the SAME child by a deliberate spawn at the end.

## `packages/plugins/managed-scan/src/scanner-containment.test.ts`

### §501. Scanner containment: they exist only in the runner image

SCANNER CONTAINMENT — the 13.3a DoD's "grep-level proof the scanners exist only in the runner image" (proposal §13.3, ADR-0020 §1, DESIGN.md §3).

THE INVARIANT. `trivy` and `oscap` live in EXACTLY ONE place: `apps/runner-scan`, the separate image the `scp-managed-scan` orchestrator launches as an ephemeral, single-shot, `--network none` container — exactly as `tofu` lives only in `scp-runner-iac`. The `scpd` runtime image carries no scanner at all, and no SCP process ever executes one directly.

WHY IT IS A TEST AND NOT A CONVENTION. The containment is what makes the Managed Execution Exception's blast radius argument true: a scanner is a large, fast-moving, untrusted-input-parsing binary, and the reason it may run at all is that it runs isolated, offline, and disposably. A `RUN dnf install openscap-scanner` added to the root Dockerfile "to make a diagnostic easier", or an `execFile("trivy", …)` added to a server route, would quietly move the scanner INTO the long-lived, network-reachable, credential-holding process — the exact thing the design forbids — and nothing else in the build would notice.

WHY `git ls-files` AND NOT A DIRECTORY WALK. A walk would sweep in `node_modules`, build output, and untracked scratch files. Some of those (a vendored Go module, a downloaded binary) contain scanner tokens, so a walk-based gate would either be permanently red or — far worse — be "fixed" with exclusions until it passed vacuously. Tracked files are exactly the set this repo is accountable for.

NON-VACUITY. Both detectors are exercised against synthetic POSITIVE samples below. If either is ever weakened into a regex that matches nothing, the negative-control tests fail — so a green run of this file always means "the detectors work AND found nothing", never "the detectors are dead".

### §502. Directories whose files are checked for scanner INVOCATION

Directories whose files are checked for scanner INVOCATION. Deliberately the product surface — the code that ships in an image or runs on a commander. `.github/` is out of scope on purpose: CI is a build-time concern, not the runtime image, and a CI job legitimately may run a scanner over this repo's own artifacts. That is a different question from "does the SCP runtime carry a scanner", which is what this file is about.

### §503. A file this gate SWEEPS, read tolerantly

A file this gate SWEEPS, read tolerantly. `git ls-files` lists the INDEX, and the index and the WORKTREE disagree routinely — a file `rm`'d but not yet `git rm`'d, a half-applied patch, an interrupted rebase. Feeding that straight into `read` made this file die with a bare `ENOENT ... launch-argv.golden.test.ts` at the "NO product code outside apps/runner-scan EXECUTES a scanner binary" test — a repo-wide SECURITY gate going red with a message about a test file and nothing about scanners. The cheap fix under time pressure is the one this file's header warns against: narrowing the sweep until it passes. So the candidate set is UNCHANGED and unreadable candidates are skipped instead — and every caller then asserts its non-vacuity floor over the files ACTUALLY READ, so a worktree full of missing files cannot masquerade as a clean sweep either.

### §504. DETECTOR 2 — code that EXECUTES a scanner. Command position only

DETECTOR 2 — code that EXECUTES a scanner. Command position only: `trivy` appearing as a method name, a string literal, a pin variable or a comment is not an invocation, and flagging those would make the gate unmaintainable (and therefore, eventually, disabled).

### §505. RAW for the ABSENCE half

RAW for the ABSENCE half: `invocationHits` finding nothing is the assertion, and stripping could only shrink what it searches. THE SWEEP NOW COVERS THE PORT TOO — M23.1 moved the create/copy/start/remove sequence into `@scp/runner-launcher`, and a containment gate that still looked only at the plugin would have stopped covering the file that actually spawns processes.

### §506. …and it really does launch containers

…and it really does launch containers (so the assertions above are about a live code path). STRIPPED for the PRESENCE half: this is the non-vacuity guard, and a guard satisfiable by a comment describing the launch would let the launch itself be deleted with the containment assertion above passing trivially.

IT TAKES BOTH HALVES NOW, and that is the point of asserting them separately: the plugin must still hand a runner spec to the port (`.run({`, reached through the injected resolver), and the port must still exec the container CLI. Either one going missing would leave "no scanner is executed here" true for the uninteresting reason that nothing is executed at all.

### §507. `spawnRunnerProcess`, NOT `execFileAsync`, SINCE M23.6 CLAUSE 1

`spawnRunnerProcess`, NOT `execFileAsync`, SINCE M23.6 CLAUSE 1. Every spawn in the package now goes through one recorded function so that "nothing was spawned on the Kubernetes path" can be an assertion rather than a hope; `no-docker-on-kubernetes.test.ts` censuses that `execFileAsync` is referenced exactly once, inside it. The claim this line makes is unchanged: the port still hands the container CLI an argv.

## `packages/plugins/managed-scan/vitest.config.ts`

### §508. Unit layer (BUILD_AND_TEST.md §4.1)

Unit layer (BUILD_AND_TEST.md §4.1) — mirrors managed-iac's exact pattern: excludes `*.integration.test.ts` (the real-Docker `scp-runner-scan` container test) so `pnpm test` never depends on Docker being available. `pin.test.ts` is a pure drift check (no Docker) and stays in.

### §509. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/managed-scan/vitest.integration.config.ts`

### §510. Docker-requiring integration layer

Docker-requiring integration layer (proposal §13.3 DoD: "an ephemeral runner at the commander scans a subject artifact pulled by digest ... `--network none` otherwise"). Mirrors managed-iac's integration config — no Postgres/globalSetup; the only external dependency is a reachable Docker daemon (`DOCKER_HOST`, colima locally / native Docker in CI). Generous timeouts: building the `scp-runner-scan` image (first run — trivy DB download) plus real container startup pay real cost.

## `packages/plugins/pipeline-generic/src/index.test.ts`

### §511. Behavioral test suite for `@scp/plugin-pipeline-generic`

Behavioral test suite for `@scp/plugin-pipeline-generic` (extracted verbatim from `@scp/plugin-terraform`'s Mode-1 implementation, M10.6 — see index.ts's module doc for the full DESIGN.md §12 context). Unlike most plugin unit tests in this repo (webhook-control, fake-executor, federation-https), which stub `ctx.http.request` with a hand-written function, these tests run the plugin against a REAL `node:http`-based `ScopedHttpClient` (test-support/real-http-client.ts) fixtured with `nock` — see that file's module doc for why `node:http` and not the global `fetch()`. That buys genuine coverage of the plugin's URL templating, header construction, and response-body parsing, not just "did we call ctx.http.request with the object we expected."

The trigger()-idempotency dedup cache is a MODULE-LEVEL variable (index.ts's `inMemoryState`), not per plugin-instance state like fake-executor's — so every test in this file that doesn't care about dedup uses a UNIQUE (or absent) `idempotencyKey` to avoid cross-test contamination via that shared cache; only the tests that explicitly exercise dedup reuse a key on purpose.

### §512. A second independently obtained handle and context

A second, independently-obtained plugin handle + a second PluginContext object, sharing only `statePath` on disk — the same shape as a respawned subprocess plugin host instance (index.ts's module doc references @scp/plugin-argocd's identical dedup design). trigger() must read the dedup entry from the FILE, not from any in-process cache, and therefore never re-POST.

## `packages/plugins/pipeline-generic/src/index.ts`

### §513. The generic pipeline executor plugin

`@scp/plugin-pipeline-generic` — M10.6's generic pipeline executor (BUILD_AND_TEST.md §8 M10.6: "extract `@scp/plugin-pipeline-generic` from the terraform Mode-1 shape (Mode 1 becomes a preset)"), extracted verbatim from `@scp/plugin-terraform`'s Mode-1 implementation (DESIGN.md §12's "the org's pipeline remains the executor... Trigger: kick the org's pipeline"). Covers the entire CI/CD/IaC long tail — any pipeline that can POST a JSON body and answer a JSON status — at zero marginal engineering per system, air-gap-friendly via the pull-side CLI/webhook report path (`POST /change-sources/{sourceKind}/report`, ADR-0002 §7).

`@scp/plugin-terraform` is now a PRESET of this package (same defaults, own manifest `id`) — see that package's module doc. A future GitLab-CI-generic/Jenkins-generic preset follows the exact same pattern: a thin config-defaults wrapper around `createPipelineGenericExecutorPlugin`.

`trigger()`/`status()`/`abort()` are configured URL templates (the same escape-hatch shape `@scp/plugin-webhook-control` established for "POST somewhere, interpret the response") rather than hardcoded against one vendor's API. The default `statusField`/`succeededValues`/ `failedValues` vocabulary matches Terraform Cloud's own `Run` status enum (the most structured of Mode 1's three original targets — TFC, Atlantis, a GitHub Actions workflow wrapping tofu); a preset for a pipeline with a different vocabulary overrides those fields in its own config.

`observe()` is intentionally a no-op ([]): this executor's actual observe path is INBOUND, not polled — either `scp change report --plan-json` (packages/cli) or a native webhook, both landing through the SAME `POST /change-sources/{sourceKind}/report`/webhook ingress every other source kind uses (routes/change-sources.ts). The DISCIPLINE that separates this from a "call any URL" bus is that inbound path's REQUIRED structured-evidence schema (`ChangeReportRequestSchema`/`SbomRefSchema`, `additionalProperties:false` as of M10.6) — see `packages/schemas/src/executors.ts` — never this plugin, which has no evidence-shape opinion of its own.

### §514. THE LEDGER IS BOUNDED

THE LEDGER IS BOUNDED. `state.keys` is keyed by `idempotencyKey`, and `reconcile.ts` sets that to the wave-target id — a fresh value per (change x wave target) — so with a persistent `statePath` this map grew by one permanent entry per target ever triggered, forever. That is not only disk: `loadState` `JSON.parse`s the WHOLE file on every `trigger()`/`status()`, so the cost is O(total history ever) paid on every poll. `@scp/plugin-managed-iac` found and fixed exactly this in its own structurally identical cache (measured there at 500 keys: 2 MB); the fix never travelled to this package, which `@scp/plugin-terraform` is a preset of and so inherits.

Oldest-first eviction, keeping the most recent `DEDUP_CACHE_MAX_KEYS`. What an entry must outlive is the reconcile poll that follows its own `trigger()` plus a crash-and-retry window in which the same key is re-issued; dropping an entry a retry then asks for re-triggers a pipeline that already ran, so the bound is set far above anything that can be in flight.

REPLICATED, NOT IMPORTED: `@scp/runner-launcher`'s `pruneOutcomeRecord` is the same six lines, but a plugin package depends only on `@scp/plugin-api` — pulling in the container-launching package for a helper would be a far worse trade. Noted as a candidate for a shared extraction.

### §515. The tenant-facing config surface, shared by every preset

The tenant-facing config surface for this plugin AND for every preset built on it (`@scp/plugin-terraform` today). `additionalProperties: false` is load-bearing rather than tidiness, and it is what a permissive schema had been costing:

- `statePath` is SERVER-GOVERNED — `resolveExecutorPluginInstance` injects it for every executor instance and spreads it LAST — so it is deliberately absent here, the same shape by which `managed-iac`'s schema refuses `runnerImage`/`networkMode`/`workspaceRoot`. Without `additionalProperties: false` the absence achieved nothing: an unlisted key was simply stored. - the general property: a config key no schema names is a key no reviewer has ever had to reason about. `PipelineGenericConfig` is the whole contract this plugin reads; anything else in a binding is either a typo (silently inert — the `runIdField` typo that makes every run report the wrong external id) or an attempt at a field the plugin does not offer.

## `packages/plugins/pipeline-generic/src/pipeline-generic.conformance.test.ts`

### §516. Wires this plugin into the generic executor conformance suite

Wires `@scp/plugin-pipeline-generic` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/ plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing about this package's specifics — this file is only the fixture factory.

Unlike the fake-executor/webhook-control conformance fixtures (which stub `ctx.http.request` directly), this fixture backs `ctx.http` with `test-support/real-http-client.ts`'s REAL `node:http`-based client and fixtures the wire with `nock` — this is genuinely an HTTP-calling plugin, so this is the conformance fixture that proves the plugin's ACTUAL network path (URL templating, response parsing) satisfies the generic contract, not a hand-rolled stub standing in for it.

The generic suite calls trigger/status/abort/observe in an order and cadence this file doesn't control (and shouldn't need to know — that's the whole point of a shared conformance suite). Every interceptor below is `.persist()`ed so it answers an unbounded number of times with one deterministic, contract-satisfying response, rather than trying to predict exact call counts — that precision belongs in index.test.ts, which asserts exact request shapes and exact call counts for the dedup/idempotency behavior this suite only smoke-tests.

## `packages/plugins/pipeline-generic/src/test-support/real-http-client.ts`

### §517. A real, non-stubbed HTTP client for this package's tests

A REAL (non-stubbed) `ScopedHttpClient` for `@scp/plugin-pipeline-generic`'s tests — unlike most plugin unit tests in this repo (webhook-control, fake-executor, federation-https), which stub `ctx.http.request` directly with a hand-written function, THIS package's tests exist specifically to exercise the plugin's ACTUAL network code (URL templating incl. `encodeURIComponent`, header construction, response-body JSON parsing) against `nock`-fixtured HTTP, since this is a genuinely HTTP-calling plugin.

Deliberately built on `node:http`/`node:https` `request()`, NOT the global `fetch()`: Node's built-in `fetch` is implemented on top of `undici`, which does its own socket handling and bypasses the `http`/`https` core modules entirely. `nock` (installed here at 13.5.6, see package.json) patches exactly those core modules and has no undici/fetch interception support — empirically confirmed while building this suite (in `@scp/plugin-terraform`, before the M10.6 extraction): a bare `nock(url).reply(...)` interceptor plus a `fetch()` call against that same URL throws `TypeError: fetch failed`, never reaching the interceptor. This client is the `node:http`-based sibling of apps/server/src/plugin-host/subprocess-entry.ts's `unscopedFetchHttpClient` — same request/response shape and the same "JSON-parse with raw-text fallback" behavior — swapped only for the transport `nock` can actually see.

### §518. A context whose client is the real Node-backed one above

Builds a `PluginContext` whose `http` is the real `node:http`-backed client above, so calls the plugin makes actually hit the wire (and therefore whatever `nock` interceptors the test set up) rather than a hand-rolled stub. `secretsGet` defaults to "no secret configured", matching every other plugin's test fixture in this repo (fake-executor, webhook-control, federation-https).

## `packages/plugins/pipeline-generic/vitest.config.ts`

### §519. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §520. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/scan-result-control/src/index.test.ts`

### §521. The gate-resolved, most-restrictive-wins scoped threshold

M17.5 (ADR-0016) — the gate-resolved, most-restrictive-wins scoped threshold on the request context, preferred over the flat per-binding `config.threshold` exactly as `artifactDigest` is preferred over `config.expectedDigest`.

### §522. Exclusion before counting, applied at this process

M22.2 (ADR-0033 §2) — EXCLUSION BEFORE COUNTING, applied HERE because this is the process that holds the findings. The gate resolves WHICH clauses are in force (a plugin has no database and no lookup ability) and threads them on `context.scanExclusions`; this control applies them to its own parse, before the threshold comparison.

MUTATIONS RUN (2026-08-17), each reverted by an exact inverse edit. MEASURED results; baseline 22 passed. P-1  compare the threshold against `counts` instead of `effectiveCounts` -> 1 failed ("a HIGH with no fix is EXCLUDED before counting"). P-2  write `severityCounts: effectiveCounts` — i.e. REDEFINE the field operators author their CEL conditions against -> 1 failed (same test, on its `severityCounts.high === 1` arm). That arm exists for exactly this mutation: without it the redefinition is invisible, because every OTHER assertion in the suite is happy with the post-exclusion number. P-3  emit `effectiveSeverityCounts`/`exclusions` unconditionally -> 3 failed, including "WITH NOTHING THREADED the evidence document gains no new keys". P-4  attach findings without the excluded ordinals -> 1 failed ("the EXCLUDED ordinals ride the transport").

## `packages/plugins/scan-result-control/src/index.ts`

### §523. Turns a coordinated scan verdict into gate evidence

@scp/plugin-scan-result-control — turns a coordinated **Trivy scan verdict** into GATE EVIDENCE (DESIGN §10.2 ControlPlugin, ADR-0013 "scan as a boundary-authorization gate", BUILD_AND_TEST.md §8 M17). A sibling of `@scp/plugin-webhook-control`: same `ControlPlugin` contract, same subprocess plugin host, same PULL intake pattern (fetch a result from a per-binding operator-configured `url` via the host-mediated `ctx.http`, map it into a `ControlOutcome`). Bound to a `control` graph object via a `control_binding`, exactly like webhook-control — no execution-system involved.

CHARTER — coordinate, NOT execute (principle 1): this plugin NEVER runs Trivy. Trivy runs inside an execution system SCP merely coordinates (the Argo Workflows Trivy step, ADR-0012); this plugin only *consumes* the resulting verdict JSON as evidence. It holds no scanner credentials and launches no scan. (Since ADR-0020, the commander's separate `scp-managed-scan` promotion scan step is a genuine, charter-enumerated exception that DOES execute scans — this plugin remains the org-pipeline evidence ingress and is unaffected: it still runs no scanner of any kind.)

SCOPE (ADR-0013) — this is a BOUNDARY-CROSSING AUTHORIZATION gate, not a universal code-quality gate. It fires ONLY where an operator binds a scan control into a policy's `requireControls` (or a raw `gate_binding`) for a commander-tracked, boundary-crossing artifact — never unconditionally on every change. The engine wiring (governance/control-runner.ts, coordination/gates.ts) already enforces "runs only where bound"; nothing here fires on its own.

FAIL-CLOSED: an unreachable/unparseable source, a non-2xx response, a timeout, a digest mismatch, or a verdict over the configured severity threshold ALL yield `fail` (never a silent pass) — a broken or absent scan can never authorize a boundary crossing.

DIGEST BINDING ("nothing slipped in", ADR-0013): the verdict is bound to the digest Trivy actually scanned AND to the digest the change is promoting. A verdict for a DIFFERENT digest — a stale or substituted scan — returns `fail` (mismatch), so it can never authorize a different artifact.

### §524. The wrapper that derived counts from the shape, and its fate

M22.1a introduced a `countSeverities(raw)` wrapper here that derived the counts from the shared `parseTrivyFindings`. M22.1b inlines it at the call site, because the plugin now needs the FINDINGS themselves (to hand to the server) as well as the counts, and a wrapper that parses and throws the findings away would have meant parsing the same document twice — the second parse being exactly the place the two could drift apart again.

The counts are still numerically unchanged from pre-M22.1: `parseTrivyFindings` retains exactly the entries the original hand-written loop counted (per-entry, no de-duplication, `UNKNOWN` folded away, malformed input yielding zero).

### §525. Hand the findings to the server, which alone can persist

M22.1b (ADR-0033 §7) — HAND THE FINDINGS TO THE SERVER, because this plugin cannot persist them.

A ControlPlugin runs in the subprocess plugin host with no `DATABASE_URL`; its only channel back is `ControlOutcome.evidence`. So the capped findings ride out on that record under a transport key that `control-runner.ts` STRIPS as it reads (`takeScanFindingsFromTransport`) — they must not survive onto the persisted `control_runs.evidence`, which federation copies VERBATIM into a promotion bundle. ADR-0033 §8 keeps findings commander-local; the bundle keeps counts.

Attached AFTER `ScanEvidenceSchema.parse`, because that parse strips unknown keys.

ATTACHED ON EVERY OUTCOME, including the digest-mismatch fail. The findings belong to the scan that produced them and the very same evidence document records which digest that was, so nothing is misattributed; and a FAILING verdict is precisely the one an exclusion would later act on, so dropping them there would make the mechanism inert exactly where it is meant to work.

### §526. The gate-resolved ceiling across the scan requirements

M17.5 (ADR-0016) — the GATE-RESOLVED, most-restrictive-wins ceiling across the six scan- requirement tiers (platform -> trust domain (partition) -> org -> containment domain -> service -> component), threaded onto the request context by `gate-orchestrator.ts`'s `buildControlContext` — the exact same conditional-context mechanism that already carries `artifactDigest`.

Returns `undefined` when the gate threaded nothing (no tier set any ceiling — the unchanged M17.1 path). A PRESENT-BUT-MALFORMED value is a distinct, louder case: it means the gate produced something this control cannot interpret, and silently ignoring it would apply a LOOSER threshold than governance resolved. That is exactly the "silent pass" this plugin exists to prevent, so the caller fails closed on it (`"malformed"`).

### §527. The gate-resolved exclusion clauses, threaded on the context

M22.2 (ADR-0033) — the GATE-RESOLVED exclusion clauses, threaded on the request context by the same `buildControlContext` mechanism that carries `artifactDigest` and `scanThreshold`.

A plugin has no database and no lookup ability, so every exclusion FACT — which classes each tier admitted, which clauses survived the monotone AND, for which targets — is resolved SERVER-SIDE and serialized here. This function only reads what the gate decided.

ABSENT is the shipped default (nothing admitted anywhere) and means "no exclusions" — NOT an error. A PRESENT-BUT-MALFORMED value is treated the same way, and the asymmetry with `resolveContextThreshold` is deliberate rather than an oversight: a threshold this control cannot interpret means it would judge against a LOOSER ceiling than governance resolved, so it fails closed; an exclusion set it cannot interpret means it would count MORE findings than governance intended, which is strictly stricter. Failing the control closed on a malformed loosening would convert an authoring mistake into a blocked promotion — the wrong sign for this dimension.

### §528. The threshold this verdict is judged against

The threshold this verdict is judged against.

PREFERS the gate-resolved scoped ceiling over the flat per-binding `config.threshold` — mirroring exactly how `resolveExpectedDigest` prefers `context.artifactDigest` over `config.expectedDigest`. Where BOTH set a ceiling for a severity the tighter one wins (per-severity MIN), because most-restrictive-wins is the whole model: a per-binding config value must never be able to LOOSEN what the platform/trust-domain/org/containment-domain/service/component chain resolved. A severity neither source constrains keeps its historical default — `maxCritical`/`maxHigh` = 0 (fail-closed: any Critical or High fails), `maxMedium`/`maxLow` unbounded — so a binding with no scoped floor behaves precisely as it did in M17.1.

THE REPORTED SOURCE IS THE DECIDING SOURCE, PER SEVERITY. Because the merge is a per-severity MIN over TWO sources, "a scoped floor was threaded" is a different claim from "the scoped floor set the ceiling that blocked this change" — with `config.maxHigh = 0` against `scoped.maxHigh = 50` the applied 0 came from the CONFIG. Labelling that `"scoped"` would make the Decision misdescribe its own inputs (charter principle 6), so every severity carries the source that actually supplied its applied value, and the summary label is `"mixed"` when both sources decided something and `"default"` when NEITHER did (the applied 0/0 is the historical fail-closed default, not a config value — claiming `"config"` there would misdescribe the inputs just as badly).

### §529. M22.2 — EXCLUDE BEFORE COUNTING

M22.2 — EXCLUDE BEFORE COUNTING (ADR-0033 §2), never as a waiver on the verdict.

Capped ONCE here and reused, because the ordinals in `exclusions.applied` must index the rows the server will actually persist. `scanFindingsRecordFor` is the same pure function the server uses to stamp `evidence.findingsRecord`, so a TRUNCATED set refuses every exclusion on both sides of the transport rather than only on one ("you cannot except what you did not record").

## `packages/plugins/scan-result-control/src/scan-result-control.conformance.test.ts`

### §530. Wires this plugin into the generic control conformance suite

Wires `@scp/plugin-scan-result-control` into `@scp/plugin-testkit`'s generic `ControlPlugin` conformance suite (BUILD_AND_TEST.md §4.2). Like the webhook-control fixture, this file knows nothing the suite doesn't — it points `ctx.http` at a stub returning a well-formed, clean, digest-matching Trivy result so the shape-only conformance assertions (well-formed `ControlOutcome`, always-present evidence) hold.

## `packages/plugins/scan-result-control/vitest.config.ts`

### §531. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §532. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/smtp-notify/src/egress.ts`

### §533. SSRF internal-range deny-list for `@scp/plugin-smtp-notify`

SSRF internal-range deny-list for `@scp/plugin-smtp-notify` (adversarial-review MAJOR #6 residual (d)). smtp-notify dials a raw SMTP socket and so can't inherit `apps/server`'s `ctx.http` egress-guard; this is the same defense applied to its own connect path. It is ALWAYS a tenant-configurable plugin (never an operator-plane escape hatch), so it blocks EVERY non-public target — metadata/link-local/unspecified AND loopback/private — enforced AFTER DNS resolution. The classifier is duplicated from `apps/server/src/plugin-host/egress-guard.ts` because a plugin may import only `@scp/plugin-api` (no shared server code).

Kept in its own file so `index.test.ts`'s SMTP-protocol tests (which must reach a loopback fake server) can `vi.mock` it away, while `egress.test.ts` / `index.egress.test.ts` prove the guard itself blocks internal targets.

### §534. Throws if `host`

Throws if `host` (a literal IP or a name that DNS-resolves) reaches any non-public address; returns the EXACT addresses it verified.

The caller MUST dial one of the returned addresses. Handing the NAME back to `net.connect` makes this check worthless: that call performs its own `getaddrinfo`, so a hostname whose DNS an attacker controls answers here with a public IP and answers the connect, milliseconds later, with `127.0.0.1` / `10.x` / `169.254.169.254` — classic DNS rebinding, straight through the deny-list above. See `index.ts`'s `connectSocket`, which keeps the name only for TLS SNI/identity.

## `packages/plugins/smtp-notify/src/index.test.ts`

### §535. These SMTP-PROTOCOL tests reach a loopback fake server

These SMTP-PROTOCOL tests reach a loopback fake server (127.0.0.1), which the real internal-IP egress guard (egress.ts, MAJOR #6) would block — so bypass the guard HERE. The guard itself is tested directly in egress.test.ts, and its wiring into send() in index.egress.test.ts (no mock). The stand-in returns the address send() must dial: the guard's answer is the ONLY thing that chooses the socket's peer now (DNS-rebinding pin — see egress.ts), which the pinning test below exercises with a hostname no resolver can answer.

## `packages/plugins/smtp-notify/src/index.ts`

### §536. `@scp/plugin-smtp-notify` — the SMTP `NotificationPlugin`

`@scp/plugin-smtp-notify` — the SMTP `NotificationPlugin` (M7, BUILD_AND_TEST.md §8 M7 item 4).

DEVIATION, DELIBERATE AND FLAGGED (DESIGN.md §11 describes `PluginContext.http` as "the only network path a plugin is given" — that is true for every OTHER M7 plugin, which are all HTTP APIs): SMTP is not HTTP-shaped (`ScopedHttpClient`'s request/response contract has no place for a stateful, multi-command, possibly-STARTTLS-upgraded protocol session), so this plugin is the one place in the M7 surface that opens its own `node:net`/`node:tls` socket rather than going through `ctx.http`. To keep the SAME egress-control spirit `ctx.http`'s host allowlist gives every other plugin (SSRF mitigation), this plugin enforces its OWN allowlist check against `ctx.config.allowedHosts` (mirroring `plugin-host/host.ts`'s `SCP_PLUGIN_ALLOWED_HOSTS_JSON`, which this plugin also reads via `config.allowedHosts` — the host wires the SAME `executor_bindings`/`notification_bindings.allowed_hosts` column value into both places) before ever dialing out — a misconfigured or attacker-influenced `config.host` that isn't on the allowlist fails closed with no connection attempt at all.

Deliberately minimal (v1, "good enough for a common relay"): implicit TLS (port 465) or STARTTLS (587/25) upgrade, `AUTH LOGIN` or `AUTH PLAIN`, single-message send with one or more recipients, no connection pooling/retry — this is a notification escape hatch, not a mail transfer agent. No `nodemailer`/external mail dependency: the whole point of hand-rolling this against the documented, tiny subset of RFC 5321/4954 real relays actually need is to avoid a new air-gap-relevant dependency for what is, after STARTTLS, about a dozen plaintext command/response lines.

### §537. `allowedHosts` allowlist enforcement

`allowedHosts` allowlist enforcement — this plugin dials a raw SMTP socket and can't go through `apps/server`'s `ctx.http` egress guard, so it enforces its own allowlist AND (see `egress.ts`, MAJOR #6) its own internal-range deny-list. smtp-notify is a tenant-configurable plugin, never an operator-plane escape hatch, so `assertHostNotInternal` blocks EVERY non-public target (metadata/link-local/loopback/private) — same class of hole as the webhook-notify one.

### §538. Dials the address the guard just verified, not the name

Dials `address` — which MUST be an address `assertHostNotInternal` just verified — rather than `config.host`. Passing the name would let this connect re-resolve it independently of the guard, which is the DNS-rebinding window described in `egress.ts`. The name is still what TLS checks: `servername` carries SNI and drives the certificate identity check (Node uses `servername || host`), so pinning the address weakens no part of the handshake. It is omitted for an IP-literal `config.host`, where an SNI value would be meaningless (RFC 6066).

### §539. Read the encryption state off the socket, not our intent

Read the ENCRYPTION STATE OFF THE SOCKET, never off our intent to upgrade. The STARTTLS branch above is opportunistic and driven by an EHLO capability list the server sent before any encryption exists: an on-path attacker (or a hostile relay) that withholds the word STARTTLS silently skips the upgrade, and `authenticate()` used to run anyway — base64 AUTH LOGIN credentials over cleartext TCP, with no error and `delivered: true`. That is STARTTLS stripping, and refusing is the only correct answer to it.

## `packages/plugins/smtp-notify/src/test-support/fake-smtp-server.ts`

### §540. A minimal, plaintext

A minimal, plaintext (non-TLS) fake SMTP server for `@scp/plugin-smtp-notify`'s test suite — just enough of RFC 5321/4954's command/response shape to exercise this package's real `send()` implementation end to end over a real `node:net` socket (not a mock of `send()` itself). HONEST GAP: this fixture does NOT implement STARTTLS's actual TLS handshake (would need a self-signed cert generated at test time — no such helper exists in this repo, and pulling one in for a single test fixture wasn't judged worth a new dependency this milestone) — `index.ts`'s STARTTLS branch is therefore exercised only up to "the server didn't advertise STARTTLS, so the plaintext path continues" and "the server advertised it and STARTTLS was issued", not the TLS upgrade itself. Flagged here, not silently skipped.

## `packages/plugins/smtp-notify/vitest.config.ts`

### §541. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §542. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/terraform/src/index.test.ts`

### §543. Behavioral test suite for `@scp/plugin-terraform`

Behavioral test suite for `@scp/plugin-terraform` (Mode 1, pipeline-mediated — see index.ts's module doc for the full DESIGN.md §12 context). Unlike most plugin unit tests in this repo (webhook-control, fake-executor, federation-https), which stub `ctx.http.request` with a hand-written function, these tests run the plugin against a REAL `node:http`-based `ScopedHttpClient` (test-support/real-http-client.ts) fixtured with `nock` — see that file's module doc for why `node:http` and not the global `fetch()` (short version: nock 13.5.6 cannot intercept undici-backed `fetch`, verified empirically while building this suite). That buys genuine coverage of the plugin's URL templating, header construction, and response-body parsing, not just "did we call ctx.http.request with the object we expected."

`@scp/plugin-terraform`'s trigger()-idempotency dedup cache is a MODULE-LEVEL variable (index.ts's `inMemoryState`), not per plugin-instance state like fake-executor's — so every test in this file that doesn't care about dedup uses a UNIQUE (or absent) `idempotencyKey` to avoid cross-test contamination via that shared cache; only the tests that explicitly exercise dedup reuse a key on purpose.

### §544. A second independently obtained handle and context

A second, independently-obtained plugin handle + a second PluginContext object, sharing only `statePath` on disk — the same shape as a respawned subprocess plugin host instance (index.ts's module doc references @scp/plugin-argocd's identical dedup design). trigger() must read the dedup entry from the FILE, not from any in-process cache, and therefore never re-POST.

## `packages/plugins/terraform/src/index.ts`

### §545. Terraform and OpenTofu, pipeline-mediated

`@scp/plugin-terraform` — Terraform/OpenTofu MODE 1, pipeline-mediated (DESIGN.md §12, BUILD_AND_TEST.md §8 M7 item 3): "the org's pipeline remains the executor... Trigger: kick the org's pipeline (TFC run API, Atlantis, or a GitHub workflow wrapping tofu)." Mode 2 (`scp-managed-iac`, SCP performs release management itself) is a SEPARATE package, `@scp/plugin-managed-iac` — the two modes share nothing but the `ExecutorPlugin` interface, exactly as DESIGN §12 frames them as alternatives for orgs with vs. without an existing pipeline.

M10.6 (BUILD_AND_TEST.md §8 M10.6): Mode 1 is now a PRESET of the generic pipeline executor, `@scp/plugin-pipeline-generic` — everything that was generic here (URL-templated trigger/status/abort, the idempotency dedup cache, the inbound-only `observe()`) was extracted verbatim into that package (see its module doc for the full behavior). This package supplies only the TFC-flavored defaults `@scp/plugin-pipeline-generic` already ships (`succeededValues`/ `failedValues` matching Terraform Cloud's own `Run` status enum — the most structured of Mode 1's three original targets: TFC, Atlantis, a GitHub Actions workflow wrapping tofu) and its own manifest identity (`id: "terraform"`). Behavior is byte-identical to pre-M10.6 — this package's own test suite (`index.test.ts`, unchanged) proves it.

`observe()` is intentionally a no-op ([]): Mode 1's actual observe path is INBOUND, not polled — either `scp change report --plan-json` (packages/cli) or a TFC/TFE/Atlantis webhook, both of which land through the SAME `POST /change-sources/terraform/webhook` ingress every other source kind uses (routes/change-sources.ts), never through this plugin's `observe()`. The GATE-VERDICT endpoint the org's apply step consults before applying (DESIGN §12 "the pipeline's apply step asks SCP for a gate verdict... SCP evaluates policies/controls and answers with a Decision") is likewise server-side (`GET /changes/{id}/gate-verdict`, routes/change-sources.ts), reusing M4's existing pure policy-evaluation machinery rather than new engine logic — see that route's doc comment.

## `packages/plugins/terraform/src/terraform.conformance.test.ts`

### §546. Wires this plugin into the generic executor conformance suite

Wires `@scp/plugin-terraform` into `@scp/plugin-testkit`'s generic `ExecutorPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/ plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing about terraform specifics — this file is only the fixture factory.

Unlike the fake-executor/webhook-control conformance fixtures (which stub `ctx.http.request` directly), this fixture backs `ctx.http` with `test-support/real-http-client.ts`'s REAL `node:http`-based client and fixtures the wire with `nock` — Mode 1 (DESIGN.md §12) is genuinely an HTTP-calling plugin, so this is the conformance fixture that proves the plugin's ACTUAL network path (URL templating, response parsing) satisfies the generic contract, not a hand-rolled stub standing in for it.

The generic suite calls trigger/status/abort/observe in an order and cadence this file doesn't control (and shouldn't need to know — that's the whole point of a shared conformance suite). Every interceptor below is `.persist()`ed so it answers an unbounded number of times with one deterministic, contract-satisfying response, rather than trying to predict exact call counts — that precision belongs in index.test.ts, which asserts exact request shapes and exact call counts for the dedup/idempotency behavior this suite only smoke-tests (see plugin-testkit's own idempotencyKey conformance assertion, which this fixture also satisfies: the SAME idempotencyKey reuses the module-level dedup cache and never re-POSTs).

## `packages/plugins/terraform/src/test-support/real-http-client.ts`

### §547. A real, non-stubbed HTTP client for this package's tests

A REAL (non-stubbed) `ScopedHttpClient` for `@scp/plugin-terraform`'s tests — unlike every other plugin's unit tests in this repo (webhook-control, fake-executor, federation-https), which stub `ctx.http.request` directly with a hand-written function, THIS package's tests exist specifically to exercise the plugin's ACTUAL network code (URL templating incl. `encodeURIComponent`, header construction, response-body JSON parsing) against `nock`-fixtured HTTP, since Mode 1 (DESIGN.md §12) is a genuinely HTTP-calling plugin.

Deliberately built on `node:http`/`node:https` `request()`, NOT the global `fetch()`: Node's built-in `fetch` is implemented on top of `undici`, which does its own socket handling and bypasses the `http`/`https` core modules entirely. `nock` (installed here at 13.5.6, see package.json) patches exactly those core modules and has no undici/fetch interception support — empirically confirmed while building this suite: a bare `nock(url).reply(...)` interceptor plus a `fetch()` call against that same URL throws `TypeError: fetch failed`, never reaching the interceptor. This client is the `node:http`-based sibling of apps/server/src/plugin-host/subprocess-entry.ts's `unscopedFetchHttpClient` — same request/response shape and the same "JSON-parse with raw-text fallback" behavior — swapped only for the transport `nock` can actually see. (If a future `nock`/undici upgrade adds native `fetch` support, this file plus `unscopedFetchHttpClient` could converge on one implementation; until then they must stay separate for tests to be able to intercept anything at all.)

### §548. A context whose client is the real Node-backed one above

Builds a `PluginContext` whose `http` is the real `node:http`-backed client above, so calls the plugin makes actually hit the wire (and therefore whatever `nock` interceptors the test set up) rather than a hand-rolled stub. `secretsGet` defaults to "no secret configured", matching every other plugin's test fixture in this repo (fake-executor, webhook-control, federation-https).

## `packages/plugins/terraform/vitest.config.ts`

### §549. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §550. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/webhook-control/src/index.ts`

### §551. @scp/plugin-webhook-control — the webhook-control escape hatch

@scp/plugin-webhook-control — the webhook-control escape hatch (DESIGN.md §10.2: "a generic webhook ControlPlugin (POST evaluation context → receive outcome, timeout → `timed_out`) gives orgs custom controls on day 1 without writing a plugin"; BUILD_AND_TEST.md §8 M4 item 2).

One `ControlPlugin` implementation, configured per `control_bindings` row (apps/server/src/db/schema.ts) with a target `url` — every binding is a SEPARATE subprocess plugin-host instance (apps/server/src/plugin-host/host.ts), so one org can point different controls at different webhook endpoints just by creating different bindings, no code change.

Runs under the exact same subprocess plugin host as ExecutorPlugin instances (plugin-host/subprocess-entry.ts) — `ctx.http` is therefore already the host-mediated, scoped HTTP client (DESIGN §11's `PluginContext.http`), not a raw `fetch` this plugin owns.

### §552. Wall-clock budget for the remote endpoint to respond

Wall-clock budget for the remote endpoint to respond. Default 10s. Enforced HERE (a `Promise.race` against the outbound call) rather than relying solely on the plugin host's own call-level timeout (`PluginHostOptions.callTimeoutMs`, default 10s): this plugin's own timeout produces the DESIGN-specified `timed_out` OUTCOME (evidence-bearing, persisted as a normal control_run) instead of the host's timeout, which would instead surface as an RPC failure the caller has to translate — racing here keeps that translation in exactly one place, this file, closest to the actual HTTP call.

## `packages/plugins/webhook-control/src/webhook-control.conformance.test.ts`

### §553. Wires this plugin into the generic control conformance suite

Wires `@scp/plugin-webhook-control` into `@scp/plugin-testkit`'s generic `ControlPlugin` conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and knows nothing about webhook-control specifics — this file is only the fixture factory, pointed at a `ctx.http` stub that always returns a well-formed pass response.

## `packages/plugins/webhook-control/vitest.config.ts`

### §554. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §555. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/plugins/webhook-notify/src/index.ts`

### §556. The generic notification escape hatch

`@scp/plugin-webhook-notify` — the generic `NotificationPlugin` escape hatch (M7, BUILD_AND_TEST.md §8 M7 item 4), the notification-side sibling of `@scp/plugin-webhook-control` (M4's generic `ControlPlugin` escape hatch — same shape, same reasoning): POST the message to a configured URL, treat any non-2xx or a timeout as a failed delivery, never throw for a downstream failure (a bad webhook target must never crash the caller — the watchdog sweep and governance gate-block seams that call `send()` treat notification delivery as best-effort).

## `packages/plugins/webhook-notify/src/test-node-http-client.ts`

### §557. Test-only `ScopedHttpClient` backed by `node:http`/`node:https`

Test-only `ScopedHttpClient` backed by `node:http`/`node:https` — NOT `fetch`. Same reasoning as `@scp/plugin-argocd`'s/`@scp/plugin-terraform`'s identical helper (verified empirically while writing those suites: `nock@13.5.x`, pinned here too, does not intercept Node's native `fetch`/undici — only the `http`/`https` core modules it patches). Exercises this package's real `ctx.http.request()` wire path exactly as production does; only the transport differs.

## `packages/plugins/webhook-notify/vitest.config.ts`

### §558. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §559. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
