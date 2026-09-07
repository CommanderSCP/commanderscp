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
  SourceMappingScopeSchema
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
  domainLocal: z.boolean()
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
      message: z.string().optional()
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
  status: z.string(),
  attempt: z.number().int(),
  lastObservedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ChangeWaveTarget = z.infer<typeof ChangeWaveTargetSchema>;

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
  waves: z.array(ChangeWaveSchema)
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
  scope: SourceMappingScopeSchema.optional()
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
