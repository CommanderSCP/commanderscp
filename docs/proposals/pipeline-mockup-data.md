# Proposal: the API fields the 2026-09-11 pipeline mockups need

**Status:** Accepted — owner, 2026-09-16 (decisions in §9). Docs only; nothing here is implemented yet.
**Sources:** `docs/design/mockups/2026-09-11/` on `origin/docs/recovered-mockups-2026-09-11`
(`microservice.html`, `pipeline.html`, `target-redesign.html`). The owner has put everything in the
mockups in scope, including the per-target checks rail he first dropped only because its data did
not reach the UI.
**Out of scope:** anything whose data is **already on the wire**. A parallel UI build covers that:
outline status, subtitles, source-kind text, scan on the connector, approval state from
`GET /approvals`. This document covers only the fields that are missing.

Every "today" claim below was measured on `main` at `1f7dd8f0`, with its file:line. Line numbers
drift. Re-read them before you build.

## 0. Rules this proposal keeps

- **Additive only within `/v1`.** Every new response property is `.optional()`. No required field
  becomes optional, and no response `z.enum` gains a value. Any set of states that may grow is a
  `z.discriminatedUnion`: vendored oasdiff 1.23.0 does not flag new `oneOf` members, but it does flag
  new enum values (memory `scp-oasdiff-oneof-vs-enum`). So `ComponentPipelineCheckSchema.status`
  (`packages/schemas/src/components.ts:174-190`, a response enum) **must not** be reused or extended
  for hooks.
- **Absent ≠ unknown ≠ not declared ≠ pass.** Each field distinguishes three cases: absent (an older
  server), a value that says "not known here", and a real verdict.
- **The commander never contacts an execution system.** Anything observed at an outpost reaches the
  commander in a journal. If it has not arrived, the commander says so.
- **The SDK is two things.** Every field here arrives through `explain` or `components.pipeline`,
  which `ScpClient` already wraps (`packages/sdk/src/client.ts:1117`, `:1546`). So no increment adds a
  wrapper method. If a new route appears during the build, it needs its `ScpClient` method in the
  same PR.

## 1. Measured state, per mockup feature

| # | Mockup element | What reaches the wire today | Gap |
|---|---|---|---|
| 1 | Connector chip **"fan-in satisfied · N of M"** | `ChangeWaveSchema.requiresFanIn` is a static boolean (`changes.ts:246`), set at compile time to `i > 0` (`plan-compiler.ts:131`; overridable in `topology-waves.ts:60-61,85`). The engine never reads it as a condition. Admission is structural: one active wave at a time (`activeWaveOf`, `plan-service.ts:308-310`). Nothing persists an N-of-M count. `ComponentPipelineWaveSchema` is only `{index, name}` (`components.ts:58-61`). The web derives arrows from wave status alone (`apps/web/.../wave-status.ts:48-62`). | No server-stated count. "Fan-in" has **two meanings** that the mockups conflate (§4, D1). |
| 2 | Connector chip **"approval required · N of M"** | Approval is **per change**, at the `validating→accepted` edge (`governance/gates.ts:74`). Tables: `approval_requests` (`db/schema.ts:725-752`) and `approval_votes` (`:755-774`). `ApprovalRequestSchema` carries `requiredCount` and `voteCount` (`governance.ts:88-101`), so for one change N of M **is** on the wire through `GET /approvals?changeId=` (already formatted at `change-pipeline.tsx:120`). The component pipeline carries only the static requirement, `gate.policies[].requireApprovals[].count` (`components.ts:206-208`), with no live votes. | Live counts are missing from the **component pipeline** stage gate. The mockups also put the chip *between two waves of one change*, a gate the engine does not have (D2). |
| 3 | Pip-stepper **"Canary · step 3/5 · 40%"** | The argocd plugin fetches the live Rollout manifest (`packages/plugins/argocd/src/index.ts:208-240`) but parses only `status.{phase, message, currentStepIndex, canary.weights.canary.weight}` (`:126-131`, `:190-206`). It never reads `spec.strategy.canary.steps`, so it **does not know M**. The value is persisted in `change_wave_targets.observed_state`, with truncation and `observedAt` (`wave-targets-repo.ts:187-223`), and exposed as `observed.rollout {phase, step, weight, message}` (`changes.ts:170-176`). It is rendered read-only as "phase · step N · weight N%" (`PipelineWaveCard.tsx:173-180, 612-633`). The only freshness rule is `OBSERVED_WEIGHT_FRESHNESS_MS` = 10 min (`stage-dependency-hold.ts:15`), and it is not on the wire. **Federation:** no journal kind carries wave targets or `observed_state` (`federation.ts:21-35`); `change_status` is coarse lifecycle only. The commander skips outpost-origin changes (`changes-repo.ts:475-497`, `reconcile.ts:164`), so it has no wave-target rows or observations for them. | M (`stepCount`) is missing. No freshness verdict. No upward path. |
| 4a | Dashed chip **"bake 10 m — not started"** | `bakeAlarms {hookId, quietWindowSeconds, stage?}` is declared in `pipeline-behaviors.ts` and stored in `pipeline_hooks`, keyed by component (`db/schema.ts:1917-1954`). The gate is `pipeline-hook-gate.ts:341-396` plus `evaluateBakeGate` (`pipeline-hook-verdicts.ts:117-168`), with verdicts `quiet / alarm_firing / window_not_covered / no_source`. "Declared but not started" is `deployedAt === null` → `bakeEntry` returns `null` (`pipeline-hook-gate.ts:360`). No record is written, and nothing reaches the wire. | The whole state is missing. |
| 4b | Checks rail: post-merge / post-deploy / continuous / bake | Declarations live in `pipeline_hooks`. Runs live in `pipeline_hook_runs` (`db/schema.ts:2057-2119`), identified by **`(change, hookId, waveIndex)`**, with `targetObjectId` nullable (null for `postMerge`), status `pending/running/succeeded/failed/aborted`, and `externalUrl`. They are written by `pipeline-hook-runs.ts`. The continuous verdict (`no_evidence/failed/stale`) is at `pipeline-hook-verdicts.ts:34-68`. **The only thing on the wire** is `ChangeWaveTargetSchema.hold.continuousTests` (`changes.ts:226-231`, projected at `plan-service.ts:227-268`), and only while it is holding. No route reads hooks or runs; `POST /pipelines/evidence` is write-only. | The rail is missing. Run grain is **per wave**, not per target (§3.4). |
| 5 | Target subtitle **"`<Type>` · `<provider>`"** | `type` and `category` are on the wave target. `executorPluginId` (`changes.ts:208`) is a plugin **instance** id and stays null until trigger (first written at `reconcile.ts:1633`). The provider is `executor_bindings.plugin_module` (`db/schema.ts:1259`; values `argocd`, `github`, `managed-iac`, `argo-workflows`, …), which is on no response. `ComponentPipelineBindingSchema` (`components.ts:66-83`) has `executionSystemName`. The projection computes `systemKind` for URLs (`component-pipeline.ts:683`) but never emits it. The client keeps display-name maps (`connect.tsx:92-96`, `component-pipeline.tsx:2745`). | The provider is missing on both responses. |
| 6a | Infra chip **"plan 7c1e · 2 add / 0 destroy"** | Missing. `managed-iac` / `pipeline-generic` `status()` returns `{phase, detail}` (tofu stdout), and `observedStateFrom` (`wave-targets-repo.ts:226-252`) drops `detail` on success. | New observed field. |
| 6b | Commit chip **"9f2a1c4"** | Present only as untyped `ChangeSchema.sourceRef.commit` (`changes.ts:47`, written at `webhook-processor.ts:251`). | A typed projection is missing. |
| 6c | Header **"commercial-gamma-then-prod"** (topology name) | Only on the component pipeline response (`pipeline`). `ChangePlanSchema` has `topologyObjectId` only (`changes.ts:257-265`). | Missing on `explain`. |
| 6d | "13 targets · 3 waves", per-wave "N / M built", "3 without a canary", "held" | Derivable from `explain.plan.waves[].targets[]` plus `heldTargetCount`. "Without a canary" becomes derivable once §3.4 ships. | No new field (client arithmetic over server-stated per-target facts). |
| 6e | Hold line **"X must land first"** on a target | On `explain` (`ChangeStageDependencyStatusSchema`, `changes.ts:350-385`) and `ComponentPipelineHold`. Not on `ChangeWaveTargetSchema`. | UI join on the same response. No new field. |
| 6f | "attempt 3", "never observed", "images truncated", artifact / registry chips, scan panel (scanner, counts, per-severity max, `digestMatch`) | All already on the wire (`attempt`, `lastObservedAt`, `observed.truncation`, `components.ts:320-360`, `supply-chain.ts:214-220`). | None. These belong to the other agent. |

**Two defects found while measuring.** Both are included as increment 0:

- **Bake evidence is not federated.** `recordAlarmEvidence` (`pipeline-hooks-repo.ts:352`) writes
  `alarmState` evidence without appending to the journal, unlike `testRun`
  (`pipeline_evidence_upsert`). An outpost's bake alarms therefore never reach the commander.
- **Schema source drift.** Drizzle's `pipeline_evidence_source_check` (`db/schema.ts:2049-2052`)
  still lists three sources. Migration `0107_pipeline_evidence_peer_reported.sql:20` added
  `peer_reported`, so the next `drizzle-kit generate` would emit a migration that drops it.

## 2. Target subtitle provider, commit, topology name (low risk)

```ts
// ChangeWaveTargetSchema (changes.ts) — additive
executor: z.discriminatedUnion("basis", [
  /** The binding the trigger actually used: executor_plugin_id joined to its binding row. */
  z.object({ basis: z.literal("triggered"), pluginModule: z.string() }),
  /** Not triggered yet: the binding the resolution ladder selects NOW for (target, type). May change before trigger. */
  z.object({ basis: z.literal("bound"), pluginModule: z.string() }),
  /** No binding resolves: renders "no executor", never a guessed provider. */
  z.object({ basis: z.literal("unbound") })
]).optional(),

// ComponentPipelineBindingSchema (components.ts) — additive
pluginModule: z.string().optional(),     // executor_bindings.plugin_module
systemKind: z.string().nullable().optional(), // already computed at component-pipeline.ts:683

// ChangeSchema — additive; typed read of sourceRef.commit, null when absent or not a string
commitSha: z.string().nullable().optional(),
// ChangePlanSchema — additive; objects.name of topologyObjectId, null if dangling
topologyName: z.string().nullable().optional(),
```

- **Projection.** Batch one `executor_bindings` read per plan, keyed by `plugin_instance_id` and by
  `(target_object_id, type)`, reusing the binding resolution ladder the reconciler uses (one
  definition, not a copy). Add one `objects` read for the topology name. There are no new tables.
- **UI.** Map `pluginModule` to a label with the client maps that already exist. Unknown modules
  render verbatim. The mockups' "terraform" is really `managed-iac` or a pipeline plugin; the label
  map decides the text and the wire never does.
- **Federation.** Bindings and changes already travel as objects. On a commander viewing an
  outpost-origin change there is no plan (§1 row 3), so there are no targets to label.
- **oasdiff.** Optional properties and a `oneOf` only. None.

## 3. Checks rail and bake (the largest item; Opus)

### 3.1 Shape

```ts
/** One hook's state for one target. A UNION so new states stay additive. */
export const PipelineHookStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_applicable"), hookId, reason: z.string() }), // e.g. stage-scoped to another stage
  z.object({ state: z.literal("not_run"), hookId }),                            // bound; this target/wave not reached
  z.object({ state: z.literal("running"), hookId, startedAt, externalUrl: z.string().nullable() }),
  z.object({ state: z.literal("passed"), hookId, concludedAt, externalUrl: z.string().nullable() }),
  z.object({ state: z.literal("failed"), hookId, concludedAt, externalUrl: z.string().nullable() }), // incl. aborted
  z.object({ state: z.literal("no_evidence"), hookId, maxAgeSeconds: z.number().int(),
             newestEvidenceAt: z.string().datetime().nullable() }),             // continuous: ABSENT, not pass/fail
  z.object({ state: z.literal("bake_not_started"), hookId, quietWindowSeconds: z.number().int() }),
  z.object({ state: z.literal("baking"), hookId, windowEndsAt: z.string().datetime() }),
  z.object({ state: z.literal("alarm_firing"), hookId, since: z.string().datetime() }),
  z.object({ state: z.literal("not_reported"), hookId })  // outpost-run; this instance holds no record
]);

/** ChangeWaveTargetSchema — additive. A server that emits it ALWAYS emits all four kinds,
 *  in pipeline order. `hooks: []` = NOT DECLARED (the grey em-dash). Absent = older server. */
checks: z.array(z.object({
  kind: z.string(),   // "postMerge" | "postDeploy" | "continuous" | "bakeAlarms" — z.string, NOT PipelineHookKindSchema (a response enum would freeze the set)
  hooks: z.array(PipelineHookStateSchema)
})).optional(),
```

The mockups' distinctions map onto this shape one to one:

| Mockup | State |
|---|---|
| "—", grey | `hooks: []` |
| "not run", grey | `not_run` |
| "no evidence", amber | `no_evidence` |
| "running" / "pass" / "failed" | `running` / `passed` / `failed` |
| continuous "40 s" | `passed`. The UI derives the age from `concludedAt`, and the server has already judged it inside `maxAgeSeconds`. |
| bake "clear" / dashed "not started" | `passed` (quiet window covered) / `bake_not_started` |

### 3.2 Projection (no new tables)

- **Declarations.** Batch `listHooksForComponents` over the plan's components, resolved exactly as
  `evaluateContinuousHolds` does it (`continuous-hold.ts:50-89`). Stage-scoped `postDeploy` and
  `bakeAlarms` whose `stage` differs from the target's stage become `not_applicable`.
- **Runs.** One read of `pipeline_hook_runs` by `change_object_id` (index `pipeline_hook_runs_by_change`).
- **Continuous.** Use `pipeline-hook-verdicts.ts:34-68` as the single verdict source, generalised from
  "only the holding ones" to "every declared one". The hold projection and the rail must call the same
  function, or they will disagree.
- **Bake.** Use `evaluateBakeGate` for deployed targets. `deployedAt === null` becomes
  `bake_not_started`, stated explicitly instead of dropped.
- **Decisions.** None. This is a read projection. Persist-on-change still governs the gate's own
  Decisions (memory `scp-unbounded-decision-growth`).

### 3.3 Federation and honesty

| Hook kind | Where it runs | Commander on an outpost-origin change |
|---|---|---|
| `continuous` | Evidence travels up as `pipeline_evidence_upsert` (receiver stamps `peer_reported`) | Real verdict, from peer evidence |
| `bakeAlarms` | Evidence does **not** travel up today (defect, §1) | `not_reported` until increment 0 lands |
| `postMerge`, `postDeploy` | `pipeline_hook_runs` is not journaled | `not_reported` (see D3) |

A commander with no plan for an outpost change (§1 row 3) shows the component pipeline's view, not a
rail. The rail is an `explain` feature of the coordinating instance.

### 3.4 Grain (read this before building)

`pipeline_hook_runs` is identified by `(change, hookId, waveIndex)`, **not by target**.

- `postMerge` has no target at all, so every target of the change shows the same run.
- A `postDeploy` run gates promotion *out of a wave*, so every target in that wave shows the wave's run.

A per-target rail therefore repeats wave-level facts. That is true, but the mockup reads as if each
target had its own canary run. Only `continuous` and bake evidence are really per `(component, target)`.
The UI copy must not say "this target's post-deploy test".

**Size.** 4 slots × targets × usually 0–2 hooks is well under 10 KB for the mockup's 13 targets.
Cost: three batched reads per `explain`, all indexed.

## 4. Gate chips on the connector

**Fan-in.** The mockups use the term for two different things:
- **(a) Build-arm fan-in**: the correlated image and chart changes of one push, joined by
  `correlation_key` / `requires` (`ChangeWaitStatusSchema.requirements[].satisfied`). This is
  microservice.html's "2 of 2" and pipeline.html's "9 of 9".
- **(b) Previous-wave completion**: `requiresFanIn` wave admission.

```ts
// ChangeWaveSchema — additive. What must hold before THIS wave is admitted. A union so approval,
// policy and future entry gates add members, not enum values.
entry: z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("previous_wave"), satisfiedCount: z.number().int(), requiredCount: z.number().int() }),
  z.object({ kind: z.literal("coupled_changes"), satisfiedCount: z.number().int(), requiredCount: z.number().int() })
])).optional(),
```

- **Projection.** `previous_wave` counts wave `i-1` targets in `succeeded`/`skipped`, and the server
  computes it (the `heldTargetCount` precedent). `coupled_changes` counts the change's
  `waitStatus.requirements`, which reuses the `explain` computation. It attaches to wave 0.
- **Federation.** Correlated arms are separate changes. If one arm is outpost-origin, its satisfaction
  arrives as `change_status`, which is already how `requirements` resolves.

**Approval.**

```ts
// ComponentPipelineGateSchema — additive: the live request for the stage's current change
approvals: z.array(z.object({
  requestId: z.string().uuid(), changeId: z.string().uuid(), fromRole: z.string(),
  requiredCount: z.number().int(), voteCount: z.number().int(),
  status: z.string() // "pending"|"satisfied" — z.string: ApprovalRequestStatusSchema is a response enum
})).optional(),
```

- **Projection.** `approval_requests` joined to a vote count, for each stage's `currents[].changeId`.
  There is no change for `explain`: the UI already has `GET /approvals?changeId=`.
- **Federation.** `approval_evidence` is already a journal kind. Before building, verify that a
  commander sees the request row and not only the evidence for an outpost change.
- **oasdiff.** Unions and optional properties only. None.

## 5. Rollout pip-stepper

### 5.1 Fields

```ts
// WaveTargetObservedSchema.rollout (changes.ts:170) + plugin-api ObservedRollout (plugin-api/src/index.ts:143) — additive
stepCount: z.number().int().nonnegative().optional(),  // len(spec.strategy.canary.steps) from the SAME manifest GET

// ChangeWaveTargetSchema — additive. ONE definition shared with stage-dependency-hold's OBSERVED_WEIGHT_FRESHNESS_MS.
observedFreshness: z.discriminatedUnion("state", [
  z.object({ state: z.literal("never") }),
  z.object({ state: z.literal("fresh"), ageSeconds: z.number().int() }),
  z.object({ state: z.literal("stale"), ageSeconds: z.number().int(), staleAfterSeconds: z.number().int() }),
  z.object({ state: z.literal("not_reported") })   // executes in another domain; no observation federated
]).optional(),
```

- **Plugin.** The change is a few lines in `rolloutFromManifest`. It reads `spec` from the manifest the
  plugin already fetches. There is no new call and no new verb (ADR-0008: SCP observes and never
  drives). `currentStepIndex` is 0-based and equals `steps.length` when the rollout completes, so the
  UI shows `min(step+1, stepCount)` of `stepCount`. **Steps include pause and analysis steps**, so
  "3/5" counts Argo's steps, not weight changes. The tooltip must say so, and
  `rollout-step-coupling.md` §2.2 explains why step is not comparable across rollouts. Other
  executors omit the field.
- **Why not the declaration.** Don't take M from `component_rollouts`. It is a declaration whose
  `authority` may be `triggerParams`, not the live CR. Showing it as "step 3 of 5" would present a
  declaration as an observation.

### 5.2 What the UI says

| Condition | Render |
|---|---|
| `observed.rollout` absent, fresh | Nothing (no progressive rollout reported) |
| `stepCount` absent | Today's text, "step N · 40%", with no pips (Argo blue-green, old Rollouts) |
| `stale` | Last pips greyed, "last seen step 3 · 40% · 14 min ago", amber-dashed `unknown` badge |
| `not_reported` | "Rolling out at `<outpost>` — not reported to this commander", with no pips |
| `truncation.rollout` | The existing "rollout truncated" pill (`observed-truncation-ui.md`) |

### 5.3 Federation (D4)

The commander has no plan rows for outpost-origin changes. For it to show pips at all, the outpost
must send wave-target observations upward.

- **Payload.** A compact `{changeId, targetObjectId, type, status, attempt, rollout, observedAt}`,
  emitted **on change only** (status transition or step/weight change). Never per poll.
- **Commander storage.** A new projection of peer-reported observations, keyed by
  `(change, target, type)`, on existing Postgres. It is not a new stateful dependency.
- **Stale is always possible.** An air-gapped outpost delivers by bundle, so the commander's
  `observedFreshness` reads `stale` whenever `observedAt` is older than the freshness bound.

## 6. IaC plan summary

```ts
// WaveTargetObservedSchema + plugin-api observed — additive
plan: z.object({
  ref: z.string().optional(),               // plan file hash / run id, short-displayed
  add: z.number().int().nonnegative().optional(),
  change: z.number().int().nonnegative().optional(),
  destroy: z.number().int().nonnegative().optional()
}).optional(),
```

- **Source.** Count `tofu show -json` `resource_changes[].change.actions` in the managed-iac runner.
  Pipeline-plugin executors report it only if their status carries it. **Never** parse human stdout.
- **Honesty.** Absent means "not reported", not "0 add / 0 destroy". The value goes through the
  existing persistence bound, with truncation signalling.
- **Charter.** This stays inside the Managed Execution Exception: an observation of a run SCP already
  executes. The census of delete candidates remains `plan-diff.ts` (NUL-bearing file: use `grep -rna`).

## 7. Build increments, ordered by value and risk

| Inc | Contents | Model | Risk |
|---|---|---|---|
| **0** | Defects: `recordAlarmEvidence` journal append (mirroring `testRun`, receiver stamps `peer_reported`); drizzle `pipeline_evidence_source_check` adds `peer_reported`, with a check that `drizzle-kit generate` yields an empty diff | Sonnet | Low. The journal half needs an import-path integration test. |
| **1** | §2: `executor` union, `pluginModule` / `systemKind` on bindings, `commitSha`, `topologyName`, and the UI subtitle and commit and header chips | Sonnet | Low |
| **2** | §5 local half: `rollout.stepCount` (argocd), `observedFreshness` (`never/fresh/stale`, sharing the freshness constant with `stage-dependency-hold.ts`), and the pip-stepper | Sonnet | Low. Add a mutation test that the hold and the wire use one constant. |
| **3** | §3: the `checks` rail and bake states on `explain`, sharing verdict functions with the gate and hold, plus the rail UI | **Opus** | Medium. Grain (§3.4), stage scoping, and hold/rail agreement all need care. |
| **4** | §4: `ChangeWaveSchema.entry` with BOTH members (`coupled_changes` on wave 0, `previous_wave` on waves ≥1), rendered as two separate chips (D1); `ComponentPipelineGateSchema.approvals`, with the change view's approval chip placed before wave 0 (D2) | Sonnet (`previous_wave`), **Opus** (`coupled_changes`) | Low–medium |
| **5** | §6: `observed.plan` from managed-iac JSON plan | Sonnet | Low |
| **6** | §5.3 + §9 D3/D4: new `JournalEntryKind` `wave_target_observed` (one-time oasdiff exception, accepted) emitted on change only; FULL hook-run progress journaled upward (every status transition of `postMerge`/`postDeploy` runs); the commander projection; `not_reported` → real states | **Opus** | High. Federation, signing, volume (sized in §9 D3). Add the `OASDIFF-EXCEPTIONS.md` entry and label the PR before pushing its first commit. |

Increments 0–5 need no oasdiff exception. Their migration count is zero (increment 0 fixes source
drift only). Increment 6 carries the one accepted exception (D4) and needs a migration for the
commander-side observation projection; renumber it at merge time.

## 8. Owner decisions (as proposed; resolved in §9)

**D1 — What "fan-in N of M" counts.**
- (a) Build arms of one push (`coupled_changes`).
- (b) Previous-wave completion (`previous_wave`).
- (c) Both, as separate `entry` members.

*Recommendation: (c).* They are different facts and the union costs nothing. The mockup's "2 of 2"
after the build wave is (a).

**D2 — Where the approval chip sits.** The engine approves a whole change before wave 0. The mockups
draw it between staging and production.
- (a) Draw it where the engine gates: before the first wave in the change view, and between stages
  in the component pipeline, where stages are reached by separate changes.
- (b) Add a real per-wave approval gate to the engine (a design change: DESIGN.md first).

*Recommendation: (a) now.* Drawing (b) before it exists would be a false claim.

**D3 — Federating hook runs (post-merge/post-deploy) upward.**
- (a) Don't: the commander shows `not_reported`.
- (b) Journal run conclusions only (terminal state + `externalUrl`) inside increment 6.

*Recommendation: (b), bundled with D4.* It is the same channel and the same volume discipline.

**D4 — The channel for upward wave-target observations** (rollout, status, run conclusions).
- (a) A new `JournalEntryKind` `wave_target_observed`. It needs a one-time oasdiff exception
  (precedent: `OASDIFF-EXCEPTIONS.md:12-18`, 2026-08-28), but the semantics are clean.
- (b) Piggyback on `change_status`, whose payload is `z.record`, so there is no API break. It
  overloads a lifecycle entry, and `scope-filter.ts:19-25` and the unattached-status store would treat
  observations as transitions.
- (c) Don't federate: the commander shows `not_reported` permanently.

*Recommendation: (a),* emitted on change only.

**D5 — Can the status word next to the outline be dropped?** Left open by the 2026-09-11 session.
*Recommendation: keep it.* Colour must not be the only signal. This is not an API item, but it blocks
the final row copy.

## 9. Decisions (owner, 2026-09-16)

| # | Decision | Effect on this proposal |
|---|---|---|
| D1 | **Both** fan-in facts, as **separate chips**: build arms of one push (`coupled_changes`) and previous-wave completion (`previous_wave`). | §4 `entry` ships both members; increment 4. |
| D2 | The approval chip goes **where the engine gates: before wave 0**. **No per-wave approval gates.** | §4 approval; the mockups' between-waves placement is not built. Increment 4. |
| D3 | **Full run progress journaled upward:** every status transition of `postMerge`/`postDeploy` runs, not only terminal ones. Part of increment 6. (Departs from the recommendation, which was terminal-only.) | Sizing and mitigations below; increment 6. |
| D4 | A **new journal entry kind** for wave-target observations, **emitted on change only**; a **one-time oasdiff exception is accepted** for it. | §5.3; increment 6. |
| D5 | **Keep** the small status word beside the coloured outline. (Recommendation adopted by default; the owner delegated unasked decisions to the recommendations.) | UI copy only. |

### D3 sizing: journal volume of full run progress

`pipeline_hook_runs.status` has five values (`pending/running/succeeded/failed/aborted`,
`db/schema.ts` check `pipeline_hook_runs_status_check`). A run moves forward only, so it makes **at
most 3 distinct transitions** (`pending → running → terminal`). Terminal-only would be 1.

| Per change | Runs | Entries, terminal-only | Entries, full progress (D3) |
|---|---|---|---|
| 1 `postMerge` + 1 `postDeploy` × 3 waves (typical) | 4 | 4 | ≤ 12 |
| 1 `postMerge` + 3 `postDeploy` × 5 waves (heavy) | 16 | 16 | ≤ 48 |

The cost is a bounded **≤3×** the terminal-only volume. It stays proportional to runs, and never to
poll ticks or elapsed time. Each entry is small (target the same order as `pipeline_evidence_upsert`,
well under 1 KB), so even the heavy case adds under ~50 KB per change to the journal and bundles.
The volume that must **not** occur is one entry per `status()` poll or per trigger retry. That would
scale with run duration and could reproduce the 1.44 GB/day class of incident (memory
`scp-unbounded-decision-growth`).

**Mitigations. All of them preserve the owner's choice: every real transition still travels.**

1. **Emit on status change only.** Append in the same transaction that changes
   `pipeline_hook_runs.status`, and never from the poll path when the status is unchanged.
   `lastObservedAt` and `attempt` bumps emit nothing.
2. **Coalesce identical consecutive states.** Key the run by `(change, hookId, waveIndex)` and emit
   only when the new status differs from the last one journaled. A re-poll that re-reads `running`
   is a no-op.
3. **Bounded payload.** Send `{changeId, hookId, kind, waveIndex, targetObjectId?, status, attempt,
   externalUrl?, startedAt, observedAt}`. `externalUrl` goes through the existing persistence bound.
   Never send logs, `capturedWorkflow` bodies or executor output.
4. **Monotone receiver.** The commander applies an entry only if its status is later in the forward
   order than the one stored, or its `observedAt` is newer for the same status. Out-of-order bundle
   delivery (air-gap) therefore cannot move a run backwards, and duplicates are idempotent.
5. **Batching is the transport's job.** Air-gapped bundles already carry many entries per file, so
   the added entries raise the count per bundle, not the number of bundles.
6. **Same channel as D4.** Run transitions and wave-target observations share the one new kind
   (a union discriminated on the subject, `run` vs `target`), so they need a single oasdiff exception,
   a single signing path and a single receiver.
