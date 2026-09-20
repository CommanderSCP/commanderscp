import { z } from "zod";
import {
  ChangeRequirementSchema,
  CursorPageQuerySchema,
  StageDependencySchema,
  cursorPageResponseSchema
} from "./common.js";
import { ControlRunSchema } from "./governance.js";
import { ContinuousTestHoldSchema } from "./pipeline-behaviors.js";
import {
  ExecutorTypeSchema,
  ExecutorCategorySchema,
  PipelineClassificationSchema,
  SourceMappingScopeSchema,
  JourneyKindSchema
} from "./executors.js";

/** M3 Change Coordination Engine wire contract. See docs/schemas.md §55. */
export const ChangeStateSchema = z.enum([
  "proposed",
  "evaluated",
  "coordinated",
  // M12 P4B: a change with unsatisfied cross-change prerequisites (`properties.requires`) parks HERE
  // instead of entering `executing`, and is released to `executing` the moment every prerequisite is
  // satisfied. A change with no `requires` never enters this state (goes coordinated -> executing as
  // before), so this is additive and behaviour-preserving.
  "waiting",
  "executing",
  "validating",
  // ADR-0021 D5: this value was spelled `promoted` before 2026-07-25. The change-lifecycle
  // APPROVAL GATE is an `accept` — a human decision ABOUT A CHANGE, not an artifact advancing.
  // "Promotion" keeps its genus meaning everywhere else (Promotion Bundle, the `scp federation
  // promote` export verb, cross-domain promotion); see docs/GLOSSARY.md.
  "accepted",
  "cancelled",
  "rolled_back"
]);
export type ChangeState = z.infer<typeof ChangeStateSchema>;

export const ChangeSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  urn: z.string(),
  name: z.string(),
  state: ChangeStateSchema,
  sourceKind: z.string().nullable(),
  sourceRef: z.record(z.string(), z.unknown()).nullable(),
  correlationKey: z.string().nullable(),
  emergency: z.boolean(),
  importedFromDomain: z.string().uuid().nullable(),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  rollbackOfObjectId: z.string().uuid().nullable(),
  rollbackTriggerReason: z.string().nullable(),
  /** WHO cancelled this change. See docs/schemas.md §56. */
  cancellationKind: z.enum(["system", "user"]).nullable().optional(),
  stateEnteredAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
  watchdogFlaggedAt: z.string().datetime().nullable(),
  properties: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  /** When this change's own row last CHANGED. See docs/schemas.md §57. */
  updatedAt: z.string().datetime(),
  /** The underlying graph object's origin domain, additive. See docs/schemas.md §58. */
  originDomainId: z.string().uuid().optional(),
  /** Mirrors the graph object's locality flag. See docs/schemas.md §59. */
  domainLocal: z.boolean(),
  /** A typed read of `sourceRef.commit` (webhook-processor.ts's `canonicalizeSourceRef`) — the
   *  same value, projected as its own field so a client renders the commit chip without reaching
   *  into the untyped bag. `null` when the source ref carries no `commit` (or it is not a string).
   *  Additive: `sourceRef` itself is unchanged. */
  commitSha: z.string().nullable().optional()
});
export type Change = z.infer<typeof ChangeSchema>;

/** `POST /changes` ("propose"). See docs/schemas.md §60. */
// M12 P4B: `ChangeRequirementSchema` (one coupled-pipeline prerequisite `{key, at}`, see
// `CreateChangeRequestSchema.requires`) moved to common.ts so executors.ts's
// `ChangeReportRequestSchema` reuses the EXACT same shape without an import cycle — it is still
// exported from `@scp/schemas` unchanged.

export const CreateChangeRequestSchema = z.object({
  name: z.string().min(1).max(200),
  id: z.string().uuid().optional(),
  urn: z.string().optional(),
  domainId: z.string().uuid().nullable().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
  sourceKind: z.string().optional(),
  sourceRef: z.record(z.string(), z.unknown()).optional(),
  correlationKey: z.string().optional(),
  emergency: z.boolean().optional(),
  /** Release-topology object id or URN to compile against (optional — falls back to pure toposort). */
  topology: z.string().optional(),
  /** WHICH pipeline this change rolls (M12 P4A) — the routing Type (ADR-0007), selecting each
   *  target's executor binding. Webhook-born changes inherit this from the matched `source_mappings`
   *  row and never set it here; this field is for a change proposed DIRECTLY against the API, which
   *  has no mapping to inherit from. Omitted means 'configuration' (the server default). */
  type: ExecutorTypeSchema.optional(),
  /** Coupled-pipeline keys this release MAKES TRUE at its own targets when it succeeds (M12 P4B).
   *  Opaque strings; a waiting change is released when some OTHER change provides every key it
   *  requires. Omitted/empty ⇒ this release is a prerequisite for nothing. */
  provides: z.array(z.string().min(1)).optional(),
  /** Cross-change prerequisites (M12 P4B): this release WAITS until, for each entry, some other
   *  change with state validating|accepted `provides` that `key` at that `at` object. `at` is an id
   *  or URN resolved at propose time (a bad ref is a 404, never a silent forever-wait). Omitted/empty
   *  ⇒ no wait; the change goes coordinated→executing as before. */
  requires: z.array(ChangeRequirementSchema).optional(),
  /** Stage-scoped component couplings (ADR-0028). See docs/schemas.md §61. */
  stageDependencies: z.array(StageDependencySchema).optional(),
  /** Object ids or URNs this change targets — plan compiler input. */
  targets: z.array(z.string().min(1)).min(1)
});
export type CreateChangeRequest = z.infer<typeof CreateChangeRequestSchema>;

export const ChangeListQuerySchema = CursorPageQuerySchema.extend({
  state: ChangeStateSchema.optional()
});
export type ChangeListQuery = z.infer<typeof ChangeListQuerySchema>;

export const ChangeListResponseSchema = cursorPageResponseSchema(ChangeSchema);
export type ChangeListResponse = z.infer<typeof ChangeListResponseSchema>;

export const ChangeIdParamSchema = z.object({ id: z.string().uuid() });

/** `POST /changes/{id}:cancel` and other reason-carrying transition triggers. `overrideFreeze`
 *  (DESIGN §10.3, M4): attempts to override an active freeze blocking this transition — requires
 *  `freeze:override` permission AND a non-empty `reason` (the same field, doing double duty as
 *  the freeze override's mandatory reason). */
export const ChangeTransitionRequestSchema = z.object({
  reason: z.string().optional(),
  overrideFreeze: z.boolean().optional()
});
export type ChangeTransitionRequest = z.infer<typeof ChangeTransitionRequestSchema>;

/** `POST /changes/{id}:rollback` — DESIGN §9.4: "every rollback writes a Decision naming its trigger". */
export const RollbackChangeRequestSchema = z.object({
  reason: z.string().min(1)
});
export type RollbackChangeRequest = z.infer<typeof RollbackChangeRequestSchema>;

// Decision records (DESIGN §10.4)

export const DecisionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: z.string(),
  subjectId: z.string().uuid(),
  verdict: z.string(),
  inputContext: z.record(z.string(), z.unknown()),
  reasonTree: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime()
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DecisionIdParamSchema = z.object({ id: z.string().uuid() });
export const DecisionListQuerySchema = CursorPageQuerySchema.extend({
  subjectId: z.string().uuid().optional(),
  /** Exact-match filter on `kind` (ADR-0028 increment 4). See docs/schemas.md §62. */
  kind: z.string().min(1).max(128).optional()
});
export type DecisionListQuery = z.infer<typeof DecisionListQuerySchema>;
export const DecisionListResponseSchema = cursorPageResponseSchema(DecisionSchema);
export type DecisionListResponse = z.infer<typeof DecisionListResponseSchema>;

// -------------------------------------------------------------------------------------------
// Plan -> waves -> wave_targets (DESIGN §9.3) — read model for the UI wave-progression view and
// `scp change explain`.
// -------------------------------------------------------------------------------------------

/** THE OBSERVED-STATE SHAPE. See docs/schemas.md §63. */
export const WaveTargetObservedSchema = z.object({
  revision: z.string().optional(),
  images: z.array(z.string()).optional(),
  rollout: z
    .object({
      phase: z.string().optional(),
      step: z.number().optional(),
      weight: z.number().optional(),
      message: z.string().optional(),
      /** THE STEP TOTAL (M), read from `spec.strategy.canary.steps.length` on the SAME manifest
       *  fetch that produces `step` — no extra call (ADR-0008: observe-only). Steps include pause
       *  and analysis steps, not only weight changes, so "3 of 5" counts Argo's steps, never a
       *  cross-rollout-comparable unit. Absent (never 0, never guessed) when the manifest fetch
       *  failed or the strategy has no canary steps (blue-green, older Rollouts). See
       *  docs/proposals/pipeline-mockup-data.md §5.1. */
      stepCount: z.number().int().nonnegative().optional()
    })
    .optional(),
  /** managed-iac's plan-summary chip (pipeline-mockup-data.md §6): counted from `tofu show -json`'s
   *  `resource_changes[].change.actions` in the runner, NEVER from human stdout. `ref` is the plan
   *  file's own content hash (short-displayed, the same idiom `revision.slice(0, 7)` already uses),
   *  so a re-poll of the same evidence reports one stable identity. Absent means "not reported" —
   *  a parse miss, a rollback's state-format evidence, or an executor with no structured plan at
   *  all — and MUST NEVER be a zeroed summary (charter principle 6: absent ≠ zero). Stays inside
   *  the Managed Execution Exception: this is an observation of a run SCP already executed. */
  plan: z
    .object({
      ref: z.string().optional(),
      add: z.number().int().nonnegative().optional(),
      change: z.number().int().nonnegative().optional(),
      destroy: z.number().int().nonnegative().optional()
    })
    .optional(),
  /** What the persistence bound removed, keyed by field. See docs/schemas.md §64. */
  truncation: z
    .record(
      z.string(),
      z.object({
        /** The field is not in `observed` at all, and that is OUR doing. */
        dropped: z.boolean(),
        droppedCharacters: z.number().int().nonnegative().optional(),
        droppedEntries: z.number().int().nonnegative().optional(),
        /** Object fields removed from objects inside this field. Their names are not
         *  recoverable below the root — the store keeps a count, not a list. */
        droppedFields: z.number().int().nonnegative().optional()
      })
    )
    .optional()
});
export type WaveTargetObserved = z.infer<typeof WaveTargetObservedSchema>;

/** ONE DECLARED PIPELINE HOOK'S STATE, for one wave target.
 *
 *  A `z.discriminatedUnion`, NOT a `z.enum`, and deliberately: vendored oasdiff 1.23.0 does not
 *  flag a new response `oneOf` member but DOES flag a new response enum value (memory
 *  `scp-oasdiff-oneof-vs-enum`), so the set stays open under the `/v1` additive-only gate. Two
 *  members it does NOT have yet, on purpose:
 *  - `not_reported` — "this instance holds no record because the record lives at another domain".
 *    Not emitted today and therefore not declared today: the coordinating instance dispatches its
 *    own `postMerge`/`postDeploy` runs, and BOTH evidence kinds (`testRun` and, since the
 *    increment-0 fix to `recordAlarmEvidence`, `alarmState`) federate upward as
 *    `pipeline_evidence_upsert`. It arrives with increment 6
 *    (docs/proposals/pipeline-mockup-data.md §3.3/§5.3), which owns the federation path.
 *  - a separate "aborted" — an aborted run is a `failed` whose `runStatus` says `aborted`, so the
 *    rail's colour and the recorded word never disagree.
 *
 *  WHAT EACH ABSENCE MEANS, and why they are four different members rather than one:
 *  `not_applicable` (this hook cannot apply here), `not_run` (it applies and nothing has reached
 *  it), `no_evidence` (a probe was promised and has NEVER reported), `stale` (a probe was promised,
 *  reported, and went quiet). Collapsing any pair rebuilds the wall-of-amber the design system's
 *  §1.5 exists to prevent — and collapsing `not_applicable`/`not_run` into "no hook declared"
 *  (the empty `hooks` array) would claim nobody ever promised the check. */
export const PipelineHookStateSchema = z.discriminatedUnion("state", [
  /** Declared, but cannot apply to THIS wave target — `reason` is server-composed and rendered
   *  verbatim (charter principle 6). Today: a `stage`-narrowed hook whose stage is not this wave's
   *  (`pipeline-hook-gate.ts`'s one-line stage rule), a `stage`-narrowed `postMerge` hook (which
   *  gates before any wave, so no stage can ever match it), or a row whose per-kind number is NULL
   *  (`maxAgeSeconds` / `quietWindowSeconds`) — not a rule, and never defaulted to a number nobody
   *  declared. */
  z.object({ state: z.literal("not_applicable"), hookId: z.string(), reason: z.string() }),
  /** Bound, and no run row exists for this (change, hookId, wave) yet — the gate has not reached
   *  it. DISTINCT from the empty `hooks` array: one is waiting, the other will never happen. */
  z.object({ state: z.literal("not_run"), hookId: z.string() }),
  /** A run row exists and has not concluded. `runStatus` carries the recorded word verbatim
   *  (`pending` = dispatched, the executor has not started it; `running` = it has), as a plain
   *  string rather than an enum for the reason in this schema's doc. `startedAt` is the run row's
   *  own `started_at`, i.e. when SCP dispatched it.
   *
   *  `closedAt`/`closedReason` are set once this run's CHANGE reaches a terminal state
   *  (cancelled/rolled_back) while the run itself is still `pending`/`running` — it is frozen here
   *  forever (nothing polls it again). `state` deliberately stays `"running"` rather than growing a
   *  new `oneOf` member for this: MEASURED against the vendored oasdiff (v1.23.0) this schema's
   *  actual `/v1` gate runs, a new response `oneOf` member IS flagged `response-property-one-of-added`
   *  and fails the additive-only gate — the `scp-oasdiff-oneof-vs-enum` memory's claim that
   *  `oneOf` additions are safe does NOT hold for this checker/spec shape (reproduced directly against
   *  `CampaignRecipeSchema.adoption`, the memory's own example, with the same binary). Additive
   *  nullable fields on an EXISTING member is the pattern PR #373 proved clean here
   *  (`approval_requests.closedAt`/`closedReason` beside an unchanged `status`), so a caller that
   *  wants to stop reading a frozen run as "in flight" checks `closedAt !== null`, exactly as
   *  `service-board.ts`'s `awaitingApproval` checks it for approval requests. */
  z.object({
    state: z.literal("running"),
    hookId: z.string(),
    startedAt: z.string().datetime(),
    runStatus: z.string(),
    externalUrl: z.string().nullable(),
    closedAt: z.string().datetime().nullable(),
    closedReason: z.string().nullable()
  }),
  /** A `postMerge`/`postDeploy` run that `succeeded`, or a `continuous` probe whose newest evidence
   *  is `passed` AND inside `maxAgeSeconds`. `concludedAt` is the run's `last_observed_at` (the
   *  poll that saw the terminal status — `null` for a run that reached terminal without one) or the
   *  evidence's own `completedAt`. */
  z.object({
    state: z.literal("passed"),
    hookId: z.string(),
    concludedAt: z.string().datetime().nullable(),
    externalUrl: z.string().nullable()
  }),
  /** A run that `failed`/`aborted`, or a `continuous` probe whose newest evidence is `failed` —
   *  "the probe ran and the target is sick", the one hook absence that is a claim about the TARGET
   *  (`pipeline-hook-verdicts.ts`). `runStatus` is `null` for the evidence-backed form, which has
   *  no run row. */
  z.object({
    state: z.literal("failed"),
    hookId: z.string(),
    concludedAt: z.string().datetime().nullable(),
    runStatus: z.string().nullable(),
    externalUrl: z.string().nullable()
  }),
  /** `continuous` only. A probe is declared and has NEVER reported for this (component, target) —
   *  `evaluateContinuousHold`'s `no_evidence`. Nobody is looking; check the PROBER. */
  z.object({
    state: z.literal("no_evidence"),
    hookId: z.string(),
    maxAgeSeconds: z.number().int().nonnegative()
  }),
  /** `continuous` only. It reported, and the newest evidence is older than `maxAgeSeconds` — which
   *  `ManifestContinuousHookSchema` defines as ABSENT, never a stale PASS. A different operator
   *  action from `no_evidence` (that one has never reported at all), so a different member. */
  z.object({
    state: z.literal("stale"),
    hookId: z.string(),
    maxAgeSeconds: z.number().int().nonnegative(),
    newestEvidenceAt: z.string().datetime(),
    staleAfter: z.string().datetime()
  }),
  /** `bakeAlarms` only. DECLARED AND NOT STARTED: the quiet window begins when the target deploys
   *  and this target has not (`waveTargetDeployedAt` is null — the same definition the wave gate
   *  uses). `pipeline-hook-gate.ts`'s `bakeEntry` drops this case entirely (it returns `null` and
   *  records nothing), which is correct for a GATE — a window that has not opened cannot hold one —
   *  but leaves an operator unable to tell a declared-and-waiting bake from an undeclared one.
   *  This member is the only place that fact reaches the wire. */
  z.object({
    state: z.literal("bake_not_started"),
    hookId: z.string(),
    quietWindowSeconds: z.number().int().nonnegative()
  }),
  /** `bakeAlarms` only. The window is OPEN — the target deployed, no alarm has fired inside it, and
   *  `windowEndsAt` is still in the future, so evidence may yet arrive. Not a pass: nothing has
   *  been established yet. */
  z.object({
    state: z.literal("baking"),
    hookId: z.string(),
    quietWindowSeconds: z.number().int().nonnegative(),
    windowEndsAt: z.string().datetime()
  }),
  /** `bakeAlarms` only. `evaluateBakeGate`'s `quiet`: one source covered the WHOLE window and
   *  nothing fired. `coveredBy` names the sources that covered it, so an operator can see that (for
   *  example) only `pushed` covered it in an air-gapped domain. */
  z.object({
    state: z.literal("quiet"),
    hookId: z.string(),
    quietWindowSeconds: z.number().int().nonnegative(),
    windowEndsAt: z.string().datetime(),
    coveredBy: z.array(z.string())
  }),
  /** `bakeAlarms` only. `evaluateBakeGate`'s `alarm_firing`: at least one alarm fired inside the
   *  window, from any source, with no precedence between sources (the gate is fail-safe on firing).
   *  `since` is the EARLIEST such `firedAt`. Reported even while the window is still open — an
   *  alarm that already fired is not pending news. */
  z.object({
    state: z.literal("alarm_firing"),
    hookId: z.string(),
    windowEndsAt: z.string().datetime(),
    since: z.string().datetime()
  }),
  /** `bakeAlarms` only. `evaluateBakeGate`'s `window_not_covered`, AND the window has elapsed:
   *  reports exist and leave a gap. Distinct from `no_source` because the operator action differs —
   *  here something is reporting and stopped, there nothing ever reported. */
  z.object({
    state: z.literal("window_not_covered"),
    hookId: z.string(),
    quietWindowSeconds: z.number().int().nonnegative(),
    windowEndsAt: z.string().datetime()
  }),
  /** `bakeAlarms` only. `evaluateBakeGate`'s `no_source`, AND the window has elapsed: a declared
   *  bake gate with no evidence source at all. Surfaced LOUDLY rather than as a mystery hang. */
  z.object({
    state: z.literal("no_source"),
    hookId: z.string(),
    quietWindowSeconds: z.number().int().nonnegative(),
    windowEndsAt: z.string().datetime()
  })
]);
export type PipelineHookState = z.infer<typeof PipelineHookStateSchema>;

/** ONE SLOT of the rail — one hook KIND, and every hook of that kind declared on this target's
 *  component. */
export const WaveTargetCheckSlotSchema = z.object({
  /** `postMerge` | `postDeploy` | `continuous` | `bakeAlarms`. A plain `z.string`, NOT
   *  `PipelineHookKindSchema`: a response enum freezes the set (memory `scp-oasdiff-oneof-vs-enum`),
   *  and a fifth kind must stay an additive change. */
  kind: z.string(),
  /** WHAT THE RECORD BEHIND THIS SLOT IS KEYED BY — so the UI cannot imply per-target evidence
   *  where none exists. `pipeline_hook_runs` is identified by `(change, hookId, waveIndex)`, NOT by
   *  target (docs/proposals/pipeline-mockup-data.md §3.4), so:
   *  - `per_change` (`postMerge`, whose `waveIndex` is NULL and whose `targetObjectId` is NULL):
   *    every target of the change shows the SAME run.
   *  - `per_wave` (`postDeploy`): every target of this wave shows the same run.
   *  - `per_target` (`continuous`, `bakeAlarms`): the evidence really is keyed by
   *    `(component, target, hookId)`.
   *  A plain `z.string` for the same reason `kind` is. */
  grain: z.string(),
  /** Every declared hook of `kind` on this target's component, SORTED BY `hookId`.
   *  **EMPTY = NOT DECLARED** — nobody promised this check. That is a structural absence and must
   *  never render like a promised check that has gone quiet. */
  hooks: z.array(PipelineHookStateSchema)
});
export type WaveTargetCheckSlot = z.infer<typeof WaveTargetCheckSlotSchema>;

/** THE CHECKS RAIL for one wave target — the four hook kinds' state, in fixed pipeline order.
 *
 *  A union on `basis` (the same idiom `executor` above uses) rather than a bare array, because
 *  "no hook is declared" and "this server could not work out what is declared" are different facts
 *  and an empty `slots[].hooks` already means the first one. `unresolvable` is reachable: a wave
 *  target whose object is soft-deleted, or a `placement` missing half its identity, resolves to no
 *  subject at all in `resolveHookSubjects`, so there is no component whose declarations could be
 *  read — the honest answer is "unknown", never "nothing is declared". */
/** Reporting provenance for a `resolved` target's hook evidence (owner decision, 2026-09-20:
 *  additive optional field, NOT an eighth `PipelineHookStateSchema` member — a per-hook state
 *  addition would be an oasdiff-breaking `oneOf` addition, memory `scp-oasdiff-oneof-vs-enum`).
 *
 *  Every slot above is built from tables local to THIS instance (`pipeline_hook_runs`,
 *  `pipeline_evidence`, alarm reports) — correct when this target executes here, but not a claim
 *  this instance can make about a prober it does not run. `resolveWaveTargetOriginDomains` (shared
 *  with `observedFreshness`, never a second copy of the domain check) is how the server already
 *  knows the difference.
 *
 *  ABSENT: this target executes in THIS domain — the slots are watched directly, so no provenance
 *  statement is needed. PRESENT: the declaring component executes at ANOTHER domain:
 *  - `fresh` / `stale`: a `wave_target_observed` (subject `hook_run`) journal entry has arrived for
 *    this target and is this current, mirroring `observedFreshness`'s own two words for the same
 *    fact about a different subject.
 *  - `not_reported`: none has arrived. The rail must render this as "not reported to this
 *    commander", never as a failed or silent prober — this instance simply cannot see one.
 *
 *  No `never` member: unlike `observedFreshness` (whose `never` means "local, but not read yet, and
 *  might still arrive from OUR OWN reconcile loop"), this field exists ONLY for the elsewhere-driven
 *  case, so there is no "might still arrive locally" state to name. */
export const WaveTargetCheckEvidenceOriginSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("fresh"), ageSeconds: z.number().int().nonnegative() }),
  z.object({
    state: z.literal("stale"),
    ageSeconds: z.number().int().nonnegative(),
    staleAfterSeconds: z.number().int().nonnegative()
  }),
  z.object({ state: z.literal("not_reported") })
]);
export type WaveTargetCheckEvidenceOrigin = z.infer<typeof WaveTargetCheckEvidenceOriginSchema>;

export const WaveTargetChecksSchema = z.discriminatedUnion("basis", [
  z.object({
    basis: z.literal("resolved"),
    /** ALWAYS all four kinds, ALWAYS in pipeline order: postMerge -> postDeploy -> continuous ->
     *  bakeAlarms. Fixed position is what makes a column of targets scannable (the mockup's own
     *  rationale: "the third slot is always the canary"). */
    slots: z.array(WaveTargetCheckSlotSchema),
    /** See {@link WaveTargetCheckEvidenceOriginSchema}. Absent = locally-driven target, or a server
     *  predating this field — either way, never treat absence as "not_reported": check `checks`'s
     *  own basis and this instance's federation state before assuming anything about a prober. */
    evidenceOrigin: WaveTargetCheckEvidenceOriginSchema.optional()
  }),
  z.object({ basis: z.literal("unresolvable"), reason: z.string() })
]);
export type WaveTargetChecks = z.infer<typeof WaveTargetChecksSchema>;

export const ChangeWaveTargetSchema = z.object({
  id: z.string().uuid(),
  waveId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  targetUrn: z.string().optional(),
  targetName: z.string().optional(),
  /** WHICH pipeline this target rolls (M12 P4A) — the routing Type (ADR-0007), snapshotted from the
   *  change at plan time, so it selects the target's executor binding at trigger AND status-poll
   *  time. Plans predating the Type cutover read back as 'configuration' (the server default). */
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategorySchema,
  executorPluginId: z.string().nullable(),
  /** The `<Type> · <provider>` subtitle's provider half — a union so a THIRD basis (or a richer
   *  triggered/bound shape) stays additive. `pluginModule` is `executor_bindings.plugin_module`.
   *  `triggered`: the binding `executorPluginId` (the plugin INSTANCE the trigger actually used)
   *  joins to. `bound`: not triggered yet — the binding the resolution ladder
   *  (`binding-resolution.ts`'s `resolveBindingForTarget`) selects NOW for `(targetObjectId, type)`;
   *  it may change before trigger. `unbound`: no binding resolves — render "no executor", never a
   *  guessed provider. Absent = a server that does not project the field. */
  executor: z
    .discriminatedUnion("basis", [
      z.object({ basis: z.literal("triggered"), pluginModule: z.string() }),
      z.object({ basis: z.literal("bound"), pluginModule: z.string() }),
      z.object({ basis: z.literal("unbound") })
    ])
    .optional(),
  /** The `ExternalRunRef` the executor's `trigger()` returned. See docs/schemas.md §65. */
  executorRef: z.record(z.string(), z.unknown()).nullable(),
  /** The snapshot reconcile observed from status(). See docs/schemas.md §66. */
  observed: WaveTargetObservedSchema.nullable().optional(),
  /** THE WAVE-TARGET FREEZE-HOLD PROJECTION. See docs/schemas.md §67. */
  hold: z
    .object({
      freezes: z.array(
        z.object({
          freezeId: z.string().uuid(),
          /** `null` for a platform-tier freeze — that tier addresses a stage coordinate, not an
           *  object id (see `InstanceFreezeMatchSchema`). */
          scope: z.object({ objectId: z.string().uuid(), name: z.string().nullable() }).nullable(),
          summary: z.string(),
          endsAt: z.string().datetime()
        })
      ),
      /** Every declared `continuous` hook currently holding this target, SORTED BY `hookId`
       *  (`continuous-hold.ts` sorts, and the order is load-bearing there for Decision stability —
       *  the wire inherits the same array). Absent when no probe holds the target; never present
       *  as an empty array. */
      continuousTests: z.array(ContinuousTestHoldSchema).optional()
    })
    .optional(),
  /** How fresh the reconcile-observed `observed` snapshot is (currently used for the rollout
   *  pip-stepper) — a discriminated union, not an enum, so a later state stays additive
   *  (`scp-oasdiff-oneof-vs-enum`). Shares ONE definition with `stage-dependency-hold.ts`'s
   *  `OBSERVED_WEIGHT_FRESHNESS_MS` and reads the reading's OWN stamped `observed_state.observedAt`
   *  — never `lastObservedAt`, the row-level column, which is a second, coarser clock.
   *  `not_reported`: this target executes at another domain instance and no observation has yet
   *  ARRIVED via the `wave_target_observed` journal kind, subject `target`
   *  (docs/proposals/pipeline-mockup-data.md §5.3, increment 6, PR #374) — checked against
   *  `listPeerObservationsForChanges` (`plan-service.ts`'s `resolveWaveTargetFreshness`), never
   *  inferred from topology alone. Once one arrives, `fresh`/`stale` follow from ITS OWN stamped
   *  time, exactly like a locally-driven reading, mirroring `WaveTargetCheckEvidenceOriginSchema`'s
   *  vocabulary for the same journal kind's `hook_run` subject. Absent = a server predating this
   *  field. */
  observedFreshness: z
    .discriminatedUnion("state", [
      z.object({ state: z.literal("never") }),
      z.object({ state: z.literal("fresh"), ageSeconds: z.number().int().nonnegative() }),
      z.object({
        state: z.literal("stale"),
        ageSeconds: z.number().int().nonnegative(),
        staleAfterSeconds: z.number().int().nonnegative()
      }),
      z.object({ state: z.literal("not_reported") })
    ])
    .optional(),
  /** THE PER-TARGET CHECKS RAIL. See docs/schemas.md §67a. */
  checks: WaveTargetChecksSchema.optional(),
  status: z.string(),
  attempt: z.number().int(),
  lastObservedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ChangeWaveTarget = z.infer<typeof ChangeWaveTargetSchema>;

/** WHAT MUST HOLD BEFORE THIS WAVE IS ADMITTED (D1, 2026-09-16, docs/proposals/pipeline-mockup-data.md
 *  §4/§9): the mockups use "fan-in" for two DIFFERENT facts, and the owner decided both ship, as
 *  SEPARATE members — a union rather than two booleans, so a future entry gate adds a member, not
 *  an enum value (`scp-oasdiff-oneof-vs-enum`). `coupled_changes` attaches only to wave 0 (the
 *  build-arm fan-in of one push, `ChangeWaitStatusSchema.requirements`); `previous_wave` attaches
 *  only to a wave with an actual predecessor (waveIndex > 0), counting THAT wave's targets in
 *  `succeeded`/`skipped` — the same reading `heldTargetCount` already uses for "done". */
export const ChangeWaveEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coupled_changes"),
    satisfiedCount: z.number().int().nonnegative(),
    requiredCount: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal("previous_wave"),
    satisfiedCount: z.number().int().nonnegative(),
    requiredCount: z.number().int().nonnegative()
  })
]);
export type ChangeWaveEntry = z.infer<typeof ChangeWaveEntrySchema>;

export const ChangeWaveSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  waveIndex: z.number().int(),
  name: z.string().nullable(),
  requiresFanIn: z.boolean(),
  status: z.string(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  /** SERVER-COMPUTED COUNT of this wave's currently-held targets. See docs/schemas.md §68. */
  heldTargetCount: z.number().int().nonnegative().optional(),
  /** SERVER-COMPUTED admission facts for this wave's own connector — see `ChangeWaveEntrySchema`.
   *  Absent for an older server, and for a wave with nothing to report (e.g. wave 0 with no
   *  declared `requires`) — never a fabricated empty array standing in for "we didn't check". */
  entry: z.array(ChangeWaveEntrySchema).optional(),
  targets: z.array(ChangeWaveTargetSchema)
});
export type ChangeWave = z.infer<typeof ChangeWaveSchema>;

export const ChangePlanSchema = z.object({
  id: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
  waves: z.array(ChangeWaveSchema),
  /** `objects.name` of `topologyObjectId` — the header's topology name, already on the
   *  component-pipeline response but missing here. `null` when there is no topology, or its
   *  object no longer resolves (dangling / deleted). Absent = a server that does not project it. */
  topologyName: z.string().nullable().optional()
});
export type ChangePlan = z.infer<typeof ChangePlanSchema>;

/** `GET /changes/{id}:explain` — the change, its compiled plan. See docs/schemas.md §69. */
/** One cross-change prerequisite's live status (M12 P4B Phase 4), for `explain`'s wait-status view. */
export const ChangeRequirementStatusSchema = z.object({
  key: z.string(),
  /** The object id the key must be provided at. */
  at: z.string().uuid(),
  /** The object's display name, for a readable "Waiting on …" surface (null if it can't be resolved). */
  atName: z.string().nullable(),
  satisfied: z.boolean(),
  /** The change (validating|accepted) currently providing this key at `at`, or null while outstanding. */
  satisfiedByChangeId: z.string().uuid().nullable(),
  /** M12 P4B Phase 4 "did you mean" (coupled-pipelines.md §3.7): while UNSATISFIED, the `provides`
   *  keys some change has actually declared at this `at` object — an exact, scoped diagnosis (not a
   *  prefix guess) for a typo'd key. `.optional()`, present only when unsatisfied and non-empty;
   *  absent once satisfied (the question is moot) and for every pre-Phase-4 explain caller. */
  didYouMean: z.array(z.string()).optional()
});
export type ChangeRequirementStatus = z.infer<typeof ChangeRequirementStatusSchema>;

/** A change's coupled-pipeline wait status (M12 P4B Phase 4). Present on `explain` for any change
 *  that declared `requires`; null otherwise. `waiting` reflects the change's current state. */
export const ChangeWaitStatusSchema = z.object({
  waiting: z.boolean(),
  requirements: z.array(ChangeRequirementStatusSchema),
  /** M12 P4B fail-closed (coupled-pipelines.md §6#14). See docs/schemas.md §70. */
  malformed: z.array(z.unknown()).optional()
});
export type ChangeWaitStatus = z.infer<typeof ChangeWaitStatusSchema>;

// ADR-0028 increment 4 — THE STAGE-DEPENDENCY WAIT STATUS. See docs/schemas.md §71.

/** Which branch of ADR-0028 decision 4 produced a verdict. See docs/schemas.md §72. */
export const StageDependencyBranchSchema = z.enum([
  "not_placed",
  "succeeded",
  "min_weight",
  "never_deployed",
  "behind",
  "weight_unreadable",
  "undeclarable",
  "unscopeable",
  "self"
]);
export type StageDependencyBranchWire = z.infer<typeof StageDependencyBranchSchema>;

/** One dependency's LIVE verdict at one place. The optional fields are optional for the same reason
 *  they are optional on the persisted verdict: they are echoes of a qualifier the declaration
 *  carried, and a change that declared none must not grow fields claiming otherwise. */
export const ChangeStageDependencyVerdictSchema = z.object({
  /** The component object id depended on — or, for an `undeclarable` entry, the raw stored entry
   *  rendered as JSON, because there was no parseable id to name. Not `.uuid()` for that reason. */
  dependsOn: z.string(),
  /** The dependency's display name, for a readable "held behind …" surface. Null when the id does
   *  not resolve to a live object (a deleted component, or an `undeclarable` entry's raw JSON). */
  dependsOnName: z.string().nullable(),
  branch: StageDependencyBranchSchema,
  satisfied: z.boolean(),
  /** Present only when this dependency came from a plain `depends_on` edge between two of this
   *  change's own targets rather than from the change's own declaration (ADR-0028 decision 6). The
   *  remedy differs — delete an edge, not edit a pipeline — so it has to be visible. */
  source: z.literal("edge").optional(),
  /** The status of the dependency's most recent wave target at this place, when it had one. */
  dependencyStatus: z.string().optional(),
  /** Echoed only when the declaration carried the qualifier. */
  minWeight: z.number().int().optional(),
  /** The declared `minWeight` was NOT applied, because a `depends_on` edge between two targets of
   *  this change asserts the stricter plain-`succeeded` test and a declaration may not weaken it. */
  minWeightSupersededByEdge: z.literal(true).optional(),
  /** Why a declared `minWeight` could not be read — mirrors `WeightUnreadableCause`. Present even on
   *  a verdict that went on to be SATISFIED by the universal `succeeded` test: the release proceeded,
   *  but not for the reason its author asked for. An unreadable weight never means "satisfied". */
  weightUnreadable: z.enum(["no_weight", "not_observed", "stale"]).optional(),
  /** The one-line operator sentence, from `describeStageDependencyHold` — the SAME function the hold
   *  Decision's `reasonTree.blocked` lines are built from, so the API and the audit record cannot
   *  drift into describing the same verdict differently. */
  summary: z.string()
});
export type ChangeStageDependencyVerdict = z.infer<typeof ChangeStageDependencyVerdictSchema>;

/** One wave target of the active wave that has not been triggered yet, and every dependency verdict
 *  that applies to it. Only `pending`/`triggering` targets appear: a target already handed to its
 *  executor is past the hold, and re-deciding its coupling would report a wait that is over. */
export const ChangeStageDependencyTargetSchema = z.object({
  targetObjectId: z.string().uuid(),
  targetName: z.string().nullable(),
  /** The (component, place) pair this wave target resolves to. BOTH null for a legacy-shaped target
   *  naming a component rather than a placement — the `unscopeable` fail-open, where there is no
   *  place for a stage-scoped hold to be scoped by and the declaration is NOT enforced. */
  componentObjectId: z.string().uuid().nullable(),
  componentName: z.string().nullable(),
  deploymentTargetObjectId: z.string().uuid().nullable(),
  deploymentTargetName: z.string().nullable(),
  /** True when at least one verdict here is unsatisfied — this target's trigger is being withheld
   *  right now. */
  held: z.boolean(),
  dependencies: z.array(ChangeStageDependencyVerdictSchema)
});
export type ChangeStageDependencyTarget = z.infer<typeof ChangeStageDependencyTargetSchema>;

/** A change's stage-dependency status (ADR-0028 increment 4). Present on `explain` for any change
 *  that declared `stageDependencies` (well-formed or not) OR whose own targets are joined by a
 *  `depends_on` edge; null otherwise, so it is absent for every uncoupled change. */
export const ChangeStageDependencyStatusSchema = z.object({
  /** True when any evaluated target is held. This is a LIVE answer: it goes false the moment the
   *  dependency lands, with no clearing row to write and none to wait for. */
  held: z.boolean(),
  /** The wave this reflects — the first one not `succeeded`/`skipped`, exactly the wave reconcile
   *  is working. Null when the change has no plan yet, or every wave is done. */
  waveIndex: z.number().int().nullable(),
  /** True when any verdict landed on the `unscopeable` branch: a coupling was declared and NOT
   *  enforced (the wave target names a component, not a placement). The live counterpart of the
   *  `stage_dependency_unscoped` warn Decision — a fail-open an operator must be able to see. */
  unenforced: z.boolean(),
  targets: z.array(ChangeStageDependencyTargetSchema)
});
export type ChangeStageDependencyStatus = z.infer<typeof ChangeStageDependencyStatusSchema>;

// M16.1 — THE UNIVERSAL BOUNDARY SEGMENT. See docs/schemas.md §73.

/** One observed hop of the bundle-transfer ledger that carried this change (`bundle_transfers`).
 *  Every field is a row this instance actually wrote — the ledger is INSERT-only and per-instance,
 *  so these are strictly THIS side's observations of the handoff, never the far side's. */
export const BoundaryTransferHopSchema = z.object({
  direction: z.enum(["export", "import"]),
  status: z.enum(["created", "submitted", "confirmed"]),
  /** The peer this hop was recorded against (TRUST sense, ADR-0021 D4). */
  peerDomainId: z.string().uuid(),
  /** The bundle's Ed25519 checksum — the value that joins this hop to the change (M16.1 I1). */
  checksum: z.string().nullable(),
  /** drizzle/0087 — WHICH LEG this hop was. See docs/schemas.md §74. */
  channel: z.enum(["metadata", "bytes"]).nullable().optional(),
  observedAt: z.string().datetime()
});
export type BoundaryTransferHop = z.infer<typeof BoundaryTransferHopSchema>;

/** The TRANSFERRED phase. `exported`. See docs/schemas.md §75. */
export const BoundaryTransferPhaseSchema = z.object({
  state: z.enum(["exported", "received", "not_observed"]),
  hops: z.array(BoundaryTransferHopSchema),
  /** When this instance observed the most recent hop; null when `not_observed`. */
  observedAt: z.string().datetime().nullable()
});
export type BoundaryTransferPhase = z.infer<typeof BoundaryTransferPhaseSchema>;

/** The VALIDATED phase. See docs/schemas.md §76. */
export const BoundaryValidatePhaseSchema = z.object({
  state: z.enum(["verified", "refused", "not_yet_verified", "not_reported"]),
  /** The Decision behind `verified`/`refused` — every verdict is explainable (principle 6). */
  decisionId: z.string().uuid().nullable(),
  observedAt: z.string().datetime().nullable(),
  /** How many artifacts the verdict's AUTHORIZED SET held. See docs/schemas.md §77. */
  authorizedArtifactCount: z.number().int().nullable()
});
export type BoundaryValidatePhase = z.infer<typeof BoundaryValidatePhaseSchema>;

/** The two-phase boundary segment for one change. `unknownFields` follows the established honesty
 *  shape (`ServiceBoardRowSchema.unknownFields`): every listed dotted path still carries its zero
 *  value on the wire for shape stability, but that zero is NOT an observation and a client must not
 *  render it as one. */
export const BoundarySegmentSchema = z.object({
  transfer: BoundaryTransferPhaseSchema,
  validate: BoundaryValidatePhaseSchema,
  unknownFields: z.array(z.string())
});
export type BoundarySegment = z.infer<typeof BoundarySegmentSchema>;

export const ChangeExplainResponseSchema = z.object({
  change: ChangeSchema,
  plan: ChangePlanSchema.nullable(),
  decisions: z.array(DecisionSchema),
  controlRuns: z.array(ControlRunSchema),
  /** Cross-change coupling status (M12 P4B): null when the change declared no `requires`. */
  waitStatus: ChangeWaitStatusSchema.nullable(),
  /** The stage-dependency status, re-evaluated live on read. See docs/schemas.md §78. */
  stageDependencyStatus: ChangeStageDependencyStatusSchema.nullable().optional(),
  /** M16.1 — the boundary segment. `null` for a change that has NOT crossed a domain boundary:
   *  absent, deliberately not a fabricated empty pass. Optional/additive within /v1 — a pre-M16.1
   *  SDK reading a new response is unaffected, and an old server's response is valid here. */
  boundarySegment: BoundarySegmentSchema.nullable().optional()
});
export type ChangeExplainResponse = z.infer<typeof ChangeExplainResponseSchema>;

// Change sources / webhook ingress (DESIGN §8 "persist-then-process", §9.2 correlation)

export const SourceMappingSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  sourceKind: z.string(),
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  /** Glob matched against the event's git REF (`refs/heads/dev`) — the third routing glob
   *  (ADR-0030 §1). NULL means "match any ref", so every mapping written before it existed keeps
   *  routing exactly as it did. */
  refPattern: z.string().nullable(),
  componentObjectId: z.string().uuid(),
  /** WHICH pipeline releases from this source roll (M12 P4A) — the routing Type (ADR-0007). NOT
   *  inferable from `sourceKind` — a GitHub Actions run can apply Terraform or ship an app — so the
   *  operator declares it per mapping. Mappings predating the Type cutover read back as
   *  'configuration' (the server default). */
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategorySchema,
  /** The operator's declared classification of this pipeline (ADR-0030 §2) — UI/reporting only,
   *  never an enforcement input. `null` for an ordinary pipeline. */
  classification: PipelineClassificationSchema.nullable(),
  /** The operator's DECLARED provenance of this repo (outpost-ui.md §9.3a, migration 0062): `true`
   *  = this repo mirrors a globally shared source authored at the commander (a domain's local COPY
   *  of shared IaC); `false` = domain-specific, tracked only in this domain. Declared, never
   *  inferred from the repo host; UI/reporting only, never an enforcement input. */
  mirrorOfShared: z.boolean(),
  /** The operator's PAUSE SWITCH. See docs/schemas.md §79. */
  enabled: z.boolean(),
  disabledUntil: z.string().datetime().nullable(),
  /** The read-time truth the matcher acts on: `enabled`, OR a timed close whose bound has passed.
   *  Paint state from THIS. */
  effectivelyEnabled: z.boolean(),
  /** The operator's DECLARED reach of this repo. See docs/schemas.md §80. */
  scope: SourceMappingScopeSchema.nullable(),
  /** WHICH RELEASE PATH a change from this source takes (journey-view §8.14, migration 0112) —
   *  `source` runs the whole source→build→scan/sign→registry→config→waves spine, `config` enters at
   *  the config node. Declared per mapping and read by the VIEW only: it is deliberately NOT `type`,
   *  because `type` routes the release and a journey label that routed would block it (see
   *  `JourneyKindSchema`). NULL = not declared, which is every mapping written before 0112. */
  journeyKind: JourneyKindSchema.nullable(),
  createdAt: z.string().datetime()
});
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export const CreateSourceMappingRequestSchema = z.object({
  sourceKind: z.string().min(1),
  repoPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  /** Glob matched against the event's git ref (`refs/heads/dev`), ADR-0030 §1. Omitted means "match
   *  any ref" — the pre-0057 behaviour, so an existing caller is unaffected. */
  refPattern: z.string().optional(),
  component: z.string().min(1),
  /** The routing Type (ADR-0007). Omitted means 'configuration' (defaulted server-side in
   *  `source-mappings-repo.ts`). `.optional()` not `.default()`: a default renders the property
   *  REQUIRED in the generated SDK request type, an unnecessary extra request-shape break. */
  type: ExecutorTypeSchema.optional(),
  /** The operator's declared pipeline classification (ADR-0030 §2) — UI/reporting only. Omitted
   *  means unclassified. Accepting it here is what makes dev-ness DECLARED rather than inferred
   *  from the branch name. */
  classification: PipelineClassificationSchema.optional(),
  /** Declare this repo a MIRROR of a commander-shared source (outpost-ui.md §9.3a). Omitted means
   *  domain-specific — the pre-0062 meaning of every mapping, so existing callers are unaffected.
   *  `.optional()` not `.default()` for the same request-shape reason as `type` above. */
  mirrorOfShared: z.boolean().optional(),
  /** The operator's pause switch (migration 0063). Omitted means enabled — a mapping routes by
   *  default, the pre-0063 behaviour, so an existing caller is unaffected. Pass `false` to create
   *  a mapping that is declared but does not yet route. `.optional()` not `.default()` for the
   *  same request-shape reason as `type`/`mirrorOfShared` above. */
  enabled: z.boolean().optional(),
  /** Declare this repo's reach (§10.6): `global` (shared across domains, tracked at the commander)
   *  or `domain` (tracked only here). Omitted means NOT DECLARED — stored NULL, no label rendered,
   *  nothing inferred; set it later with `PATCH .../mappings/{id}/scope`. `.optional()` not
   *  `.default()` for the same request-shape reason as the fields above. */
  scope: SourceMappingScopeSchema.optional(),
  /** Declare WHICH RELEASE PATH changes from this source take (§8.14). Omitted means NOT DECLARED —
   *  stored NULL, no journey claim made, and the view falls back to what it could already see; set it
   *  later with `PATCH .../mappings/{id}/journey-kind`. `.optional()` not `.default()` for the same
   *  request-shape reason as the fields above. Accepting it here is what makes the release path
   *  DECLARED rather than inferred from repo layout (§8.3 rejected repo-identity) or borrowed from
   *  the routing Type (§8.14 measured what that costs). */
  journeyKind: JourneyKindSchema.optional()
});
export type CreateSourceMappingRequest = z.infer<typeof CreateSourceMappingRequestSchema>;

/** `DELETE /change-sources/{sourceKind}/mappings` body. See docs/schemas.md §81. */
export const DeleteSourceMappingRequestSchema = z.object({
  component: z.string().min(1),
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  refPattern: z.string().nullable().optional(),
  type: ExecutorTypeSchema.optional()
});
export type DeleteSourceMappingRequest = z.infer<typeof DeleteSourceMappingRequestSchema>;

/** How many rows the delete actually removed — 0 means nothing matched, which is NOT an error but
 *  is the answer an operator needs to see (a silent 204 would look like success). */
export const DeleteSourceMappingResponseSchema = z.object({ deleted: z.number().int().min(0) });
export type DeleteSourceMappingResponse = z.infer<typeof DeleteSourceMappingResponseSchema>;

export const SourceMappingListResponseSchema = cursorPageResponseSchema(SourceMappingSchema);
export type SourceMappingListResponse = z.infer<typeof SourceMappingListResponseSchema>;

/** `PATCH /change-sources/{sourceKind}/mappings/{id}` params. See docs/schemas.md §82. */
export const SourceMappingIdParamSchema = z.object({
  sourceKind: z.string().min(1),
  id: z.string().uuid()
});

/** `PATCH /change-sources/{sourceKind}/mappings/{id}` body. See docs/schemas.md §83. */
export const SetSourceMappingEnabledRequestSchema = z.object({
  enabled: z.boolean(),
  /** With `enabled: false` only: close UNTIL this instant (ISO), then re-open automatically at
   *  read time — no timer job. Omitted/null = closed until an operator re-opens. Ignored with
   *  `enabled: true`. */
  disabledUntil: z.string().datetime().nullable().optional()
});
export type SetSourceMappingEnabledRequest = z.infer<typeof SetSourceMappingEnabledRequestSchema>;

/** `PATCH /change-sources/{sourceKind}/mappings/{id}/scope` body. See docs/schemas.md §84. */
export const SetSourceMappingScopeRequestSchema = z.object({
  scope: SourceMappingScopeSchema.nullable()
});
export type SetSourceMappingScopeRequest = z.infer<typeof SetSourceMappingScopeRequestSchema>;

/** `PATCH /change-sources/{sourceKind}/mappings/{id}/journey-kind` body. Nullable so a mis-declared
 *  path can be RETRACTED to undeclared, not just corrected — the same affordance `scope` has, and the
 *  reason both are `.nullable()` rather than a plain enum. */
export const SetSourceMappingJourneyKindRequestSchema = z.object({
  journeyKind: JourneyKindSchema.nullable()
});
export type SetSourceMappingJourneyKindRequest = z.infer<
  typeof SetSourceMappingJourneyKindRequestSchema
>;

/** `POST /change-sources/{sourceKind}/webhook` body. See docs/schemas.md §85. */
export const ChangeSourceWebhookBodySchema = z.record(z.string(), z.unknown());
export type ChangeSourceWebhookBody = z.infer<typeof ChangeSourceWebhookBodySchema>;

export const WebhookIngressResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string().uuid()
});
export type WebhookIngressResponse = z.infer<typeof WebhookIngressResponseSchema>;

export const ChangeSourceEventParamSchema = z.object({ sourceKind: z.string().min(1) });

/** The webhook-secret write route for a source kind. See docs/schemas.md §86. */
export const CreateWebhookSecretRequestSchema = z.object({
  secret: z.string().min(1)
});
export type CreateWebhookSecretRequest = z.infer<typeof CreateWebhookSecretRequestSchema>;

export const WebhookSecretConfiguredResponseSchema = z.object({
  configured: z.literal(true),
  sourceKind: z.string()
});
export type WebhookSecretConfiguredResponse = z.infer<typeof WebhookSecretConfiguredResponseSchema>;
