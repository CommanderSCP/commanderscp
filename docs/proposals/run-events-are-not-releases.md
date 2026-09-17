# A CI run is not a release — diagnosis and the decision it needs

**Status:** DECIDED and BUILT, 2026-09-16 — see §6. (The diagnosis below stopped for an owner decision. §5's options are kept as written.)
**Relates to:** [component-journey-view.md](component-journey-view.md) §3 Segment 2, §7 (`observedRun`), §8.12, §8.16;
[promotion-and-execution-model.md](promotion-and-execution-model.md) §3; [ADR-0032](../adr/0032-dependency-subscriptions.md) §9;
`docs/coordination.md` §385 (the CI-conclusion route); DESIGN.md §12.

---

## 1. The symptom, measured on the homelab commander (read-only, 2026-09-16 ~01:45Z DB clock)

Image `ghcr.io/commanderscp/scpd:sha-1f7dd8f0` (= origin/main). One org.

| changes | `source_ref.kind` | key | state |
|---|---|---|---|
| 87 | `workflow_run` (all `_observed: true`) | `run-<id>` | **all** `executing` |
| 34 | `push` | NULL / `refs/heads/*` | `validating` |
| 8  | `push` | | `executing` |

The 87 run-born changes are exactly two workflows:

| workflow | trigger (`raw.event`) | repo | changes | a push change for the same commit? |
|---|---|---|---|---|
| Validate GitOps Config (`.github/workflows/validate.yaml`) | `push` | jag8765-personal/homelab-gitops | 40 | **40 of 40** — every one duplicates a push release |
| Canary (synthetic health) (`.github/workflows/canary.yml`) | `schedule` | AgentKitProject/agentkit-hosting | 47 | **0 of 47** — all at the unchanged commit `ff3fd8a3`; a release of nothing |

`change_source_events`: 87 `workflow_run` rows, **every one** has a `resulting_change_object_id` (0 processed
without a change). Each run change also minted a `Coordinated: run-<id>` group object (87) with its
`correlates` edge (87). 0 approvals on any of them.

**This is not cosmetic. SCP drove real executor work for CI runs.** Wave 0 of the 40 Validate-born changes
is `succeeded` with a real Argo CD `executor_ref`
(`agentkit-auto::<uuid>` at `http://argocd-server.argocd.svc.cluster.local/applications/agentkit-auto`):
**40 Argo CD syncs of `agentkit-auto@gamma`**, one per validation run. Only 6 of the push changes on that
repo target `agentkit-auto@gamma`; the rest target 14 other homelab components. The run was routed to a
component its commit never touched (§2.3).

## 2. Why a workflow_run becomes a change

### 2.1 The processor is blind to event kind

`apps/server/src/coordination/webhook-processor.ts:305-559` (`processChangeSourceEvents`). For every unprocessed
row it (1) tries the M21.5 bump attach route (`:318`), (2) the config-source trigger (`:359`), then (3)
`matchComponentsForSource` (`:382`) and, on any match, **`proposeChange` (`:466`)**. Nothing between
`extractHint` (`:315`) and `proposeChange` reads the event's kind. `ExtractedHint` (`:70-110`) has no kind
field at all. So *any* event that yields a repo matching a mapping becomes a release.

### 2.2 Both ingress paths carry a run to that point

- **Poll (the live path).** `packages/plugins/git-provider-core/src/index.ts:173-182` `observe()` returns
  `[...pollCommits, ...pollRuns]`. GitHub `pollRuns` (`packages/plugins/github/src/index.ts:442-481`) emits
  `kind: "workflow_run"`, `correlation: {repo, commitSha: head_sha, correlationKey: "run-<id>"}`.
  `apps/server/src/coordination/observe.ts:112-164` persists it with `kind`, `_observed: true`, `raw`, and
  **`headers: {}`** — so `extractHint` (`webhook-processor.ts:183-186`) finds no `x-github-event` header and
  falls back to the flat generic hint. The kind is persisted and never read again.
- **Webhook.** `mapGithubWebhookEventToHint` `case "workflow_run"` (`github/src/index.ts:308-315`) returns
  `{repo, commitSha, correlationKey}`. Non-null, so it is treated exactly like a push.

### 2.3 Why the whole-repo mapping wins

A run event carries **no paths**. `correlation.ts:152-157`: with no paths, "only a mapping that constrains no
path can own the event" — the highest-ranked **whole-repo** mapping. homelab-gitops has 7 whole-repo
mappings; the top-ranked one is agentkit-auto's. So every CI run on that repo releases the same unrelated
component, regardless of what the commit changed.

### 2.4 Is it designed? No — it was never tested, and the docs name it as a defect

- No test drives a non-bump `workflow_run`/`Pipeline Hook` through `processChangeSourceEvents` and asserts a
  change. The only ingress test with a run event is the bump attach route
  (`apps/server/src/dependencies/bump-dispatch.integration.test.ts`).
- `docs/coordination.md` §385, on exactly this event: *"without it, a `workflow_run` for the bump's own commit
  matches the component's ordinary source mapping and **mints a SECOND, unrelated change for a release that
  already has one** — the exact duplication ADR-0032 §9 exists to prevent."* The fall-through is described as
  the failure the attach route exists to avoid — and it is what happens for every run that is not a bump.
- `promotion-and-execution-model.md` §3 step 2: build + test run on the execution system and *"SCP consumes
  pass/fail as **gate evidence**."* A CI result is evidence about a release, not a release.
- GLOSSARY: *"A change is also a release … the versioned unit of change."* A scheduled canary at an unchanged
  commit is not a unit of change.
- component-journey-view §8.12: *"Path A is two SCP changes, correlated. The `image` change ends at the
  registry; the `configuration` change deploys it."* Neither is a CI run.
- The one ambiguous sentence is DESIGN.md §12: `workflow_run` webhooks *"feed change detection and
  correlation"* — which covers "attach to" as well as "propose".

Also documented, and the reason this stops (§3): harbor's adapter states the contract the other adapters
never wrote down — *"For THIS slice only image pushes become a Change. Recognize other types as
known-but-ignored (clean `null`)"* (`packages/plugins/harbor/src/index.ts:34-35`). GitHub cannot simply return
`null` for `workflow_run`: the bump route (`webhook-processor.ts:318-327`) needs the run's `commitSha`.

## 3. Why they never leave `executing`, and why pushes sit in `validating`

**Neither is wedged. Both are parked by design, fail-closed.** The reconcile loop is alive: 127 of the 129 changes
have `reconcile_cursor_at` within ~6 s of the measurement (round-robin bumps); the other 2 are the
`reconcile_blocked_at` pair below, last touched 2026-09-11.

- **87 run changes, `executing`.** Plan = wave 0 `gamma`, wave 1 `prod`. Wave 0 is `succeeded` (40, a real
  sync) or `skipped` (47 — the canary's target `agentkit-db-bootstrap-prod@prod` has no gamma placement).
  Wave 1 is `pending` on all 87. Each has **exactly one** `gate|block` Decision: *"blocked by 2 required
  policies: prod-gate, prod-gate-agentkit-db-bootstrap-prod"*, both `requireApprovals` from role `Owner`,
  0 approvals. `reconcile.ts:600-620` evaluates the gate every tick, persists on change only
  (`insertDecisionIfChanged`), and returns `blocked` with the wave left `pending` — the documented
  post-#153 shape (no per-tick Decision growth: 87 rows for 87 changes). One `watchdog|warn` each
  (`watchdog_flagged_at` set) after the 1800 s executing SLA. They are waiting for an Owner approval that
  should never be given — approving one would sync prod for a CI run.
- **34 push changes, `validating`.** Every wave `succeeded`; `completeExecution` (`reconcile.ts:1705-1725`)
  moved them to `validating`, where a forward change *"waits for a human `scp change accept`"*.
  `advanceValidatingChanges` (`reconcile.ts:397-431`) only pre-warms governance there. Watchdog warned at the
  86400 s validating SLA (32). By design.
- **8 push changes, `executing`.** 6 are the same prod-gate approval park. 2 have a `failed` wave with target
  status `target_deleted` and `reconcile_blocked_at` set — `wave_target|block` *"the wave target itself …
  is soft-deleted (tombstoned)"* (`reconcile.ts:523`). Parked fail-closed.

## 4. Census — the property is "an observed event kind that is not a source change reaches `proposeChange`"

Because §2.1 is kind-blind, the property is a property of **every event kind any producer emits**, not of
GitHub. All `ExecutorEvent` producers and all webhook `mapEvent` cases, no filter:

**Instances — run/pipeline conclusions (8.16's `run-`/`pipeline-` keys are fine as keys; the event is not a release):**

| # | site | live? |
|---|---|---|
| 1 | github `pollRuns` → `workflow_run` (`github/src/index.ts:463`) | **yes — 87 changes** |
| 2 | github webhook `case "workflow_run"` (`github/src/index.ts:308`) | reachable |
| 3 | gitea `pollRuns` → `workflow_run` (`gitea/src/index.ts:323`) | reachable |
| 4 | gitlab `pollRuns` → `workflow_run` (`gitlab/src/index.ts:443`) | reachable |
| 5 | gitlab webhook `case "Pipeline Hook"` (`gitlab/src/index.ts:223`) | reachable |
| 6 | argo-workflows `observe` → `workflow_run` (`argo-workflows/src/index.ts:381`) | reachable (no repo ⇒ only a repo-less mapping) |

**Instances — execution-system state reports:**

| # | site | live? |
|---|---|---|
| 7 | argocd `observe` → `sync` (`argocd/src/index.ts:314`) | 11,044 ingested on the estate; 0 changes only because no mapping names its source kind |
| 8 | github webhook `case "deployment"` (`github/src/index.ts:316`) | reachable |

**Needs the owner's reading (source-adjacent, not merged work):** github `pull_request` (`:294`), gitea
`pull_request` (`gitea/src/index.ts:202`), gitlab `Merge Request Hook` (`gitlab/src/index.ts:213`). Each
opened/synchronised PR today proposes a release through any mapping with no `ref_pattern`. The bump attach
route uses these legitimately.

**Designed change sources (not instances):** push (github/gitea/gitlab, webhook and poll), gitlab
`Tag Push Hook`, github/gitea `release`, gitea `package` webhook and `pollPackages` `custom`, harbor
`PUSH_ARTIFACT`, and the first-party flat report (`scp change-source report`, no adapter). `fake-executor`
emits whatever a test configures; `managed-*` and `pipeline-generic` observe nothing.

**8 confirmed instances + 3 for the owner.**

## 5. The decision — what a run event SHOULD do

Every reading of §2.4 agrees a run must not **propose** a release. What the docs do not settle is what it does
instead — and one owner-decided surface depends on the defect:

`observedRun` (journey-view §7; Q1 DECIDED 2026-08-10: *"one without shows 'built upstream' plus the CI run
observed in `changes.source_ref`"*) is built in `apps/server/src/coordination/observed-run-facts.ts`, which
reads run identity **off a change's `source_ref`** (`:62-78`: `sourceRef.kind === "workflow_run"` +
`_observed`, or `sourceRef.workflow_run`). A push-born change never carries run identity. **On this estate
every `observedRun` the UI has ever shown came from a run-born change.** Stopping the minting alone blanks it.

### Options

- **(A) Drop.** At ingress, a non-source event kind never reaches `matchComponentsForSource`; after the bump
  attach route it is marked processed with no change. Smallest change. **Cost:** `observedRun` goes
  permanently null on every estate that has no bump — an owner-decided surface silently regressed.
- **(B) Attach as evidence to the release for the same commit (write side).** After the bump route, look up
  the org's change whose `source_ref` names the same repo + commit (a push/report release) and stamp the run's
  identity onto it under a new server-owned key; mark the event processed with that
  `resulting_change_object_id`. No match (the canary) ⇒ processed, no change. `observedRun` reads the stamp.
  **Cost:** an ordering hazard — a webhook `workflow_run` can be processed before its push, so it needs either
  a re-check window or a read-side join anyway; a server-owned key added to `withoutServerOwnedSourceRefKeys`;
  and a mutation of an existing change's `source_ref`.
- **(C) Attach at READ time (recommended).** Ingress as in (A) — but the event row, already persisted
  verbatim with `kind`, `repo`, `commitSha` and `raw`, stays the record. `observedRun` resolves the run for a
  change by joining `change_source_events` on (org, source kind, repo, commit) with kind `workflow_run` /
  `Pipeline Hook`, instead of reading the change's own `source_ref`. No ordering hazard (whichever arrives
  first, the join is answered at read time), no mutation of a change, and it names the run **for that
  release's commit** rather than "the newest run-shaped change on the component" — more truthful than today.
  **Cost:** `observedRun` changes its source table (it needs an index on the join, likely a migration), and
  `change_source_events` has no retention (ADR-0024) — acceptable, it already grows at this rate.
- **(D) Opt-in.** Keep the current behaviour only for mappings that explicitly declare runs as a release
  source. No evidence anything wants this; listed so it is rejected deliberately.

**Recommendation: (C)**, with the ingress gate expressed once, server-side, as an allow-list of **source**
event kinds (push, tag push, release, package/artifact push, first-party report) so an unknown or new kind
fails closed to "not a release" — the argocd `sync` and `deployment` instances close in the same line, and
the plugins' run/poll code is untouched. The three PR-event sites (§4) need a yes/no from the owner before
they are put on either side of that list.

**Queued behind the decision:** the ingress gate, the `observedRun` re-sourcing, tests through the real
poll path (`observeOrgTick` → `ingestObservedEvents` → `processChangeSourceEvents`, sourceKind `github`,
a real `workflow_run` run object — not a hand-built `source_ref` through `POST /changes`, which is how the
existing `component-pipeline-observed-run.integration.test.ts` reaches the reader and exactly why it cannot
see this).

## 6. DECIDED (owner, 2026-09-16) and BUILT

1. **Option (C).** Only an allowlist of SOURCE event kinds may propose a change: push, tag push, release,
   package push, and first-party report. `workflow_run`, pipeline, deployment and sync events never do.
2. **Pull-request events never create a change.**
3. **Cleanup** runs after deploy through the audited cancel API, with a count guard and a `pg_dump`
   first. It is recorded in the PR and run by the main session.

**The gate.** `apps/server/src/coordination/source-event-kinds.ts#classifySourceEvent` is the one allowlist. It
is called once in `processChangeSourceEvents`, after the M21.5 provenance attach route (which still consumes
PR and run events for bump changes) and before the config-source trigger and correlation. All 11 §4 sites are
refused. A non-source event is still ingested and stored, with dedupe and watermarks untouched, and it is
marked processed with no change. No per-event Decision is written, for the reason `docs/coordination.md`
§1107a gives.

**The "built upstream" line.** `observed-run-facts.ts` now finds the run by the release's own commit, through
`change_source_events.commit_sha` (migration 0113). The repo must match, which is the fork rule. The honesty
rules are unchanged. The first attempt used an expression index and was measured unusable under forced RLS
(jsonb `->>` is not leakproof), so the commit is a generated column.

**Proved at the outermost layer** (`run-events-are-not-releases.integration.test.ts`):
- The REAL github plugin's `observe()` runs against a provider stand-in, goes through `ingestObservedEvents`
  as sourceKind `github`, then through the real processor: the run is stored and proposes nothing, the push
  for the same commit proposes one change, and the line names that run.
- A run ingested before its push is still found, and another commit's run or a fork's run is never named.
- A `pull_request` webhook proposes nothing. A push webhook to the same repo, the positive control, proposes one.
- A `workflow_run` webhook proposes nothing.
- One sync from the REAL argocd plugin proposes nothing.
- The EXPLAIN shows the commit as an index condition.

Seven mutations were each killed: gate removed; observed `workflow_run` allowed; github `pull_request`
allowed; github `workflow_run` allowed; observed `sync` allowed; repo check dropped; expression predicate
instead of column.
