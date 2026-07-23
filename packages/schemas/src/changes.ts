import { z } from "zod";
import { ChangeRequirementSchema, CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import { ControlRunSchema } from "./governance.js";
import { ExecutorTypeSchema, ExecutorCategorySchema } from "./executors.js";

/**
 * M3 Change Coordination Engine wire contract (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3).
 * The state machine's legal-edge DATA lives server-side (coordination/transitions.ts +
 * drizzle/0007's `state_transitions` seed) — this file only carries the enum for wire validation.
 */
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
  "promoted",
  "cancelled",
  "rolled_back"
]);
export type ChangeState = z.infer<typeof ChangeStateSchema>;

export const ChangeSchema = z.object({
  id: z.string().uuid(), // = the underlying graph object's id (changes.object_id)
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
  stateEnteredAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
  watchdogFlaggedAt: z.string().datetime().nullable(),
  properties: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Change = z.infer<typeof ChangeSchema>;

/**
 * `POST /changes` ("propose") — `targets` (>=1 idOrUrn) is the set of graph objects (usually
 * components/services/deployment-targets) this change acts on; the plan compiler
 * (coordination/plan-compiler.ts) derives wave order from their `depends_on` edges plus the
 * optional `topology`'s explicit wave groups.
 */
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
   *  change with state validating|promoted `provides` that `key` at that `at` object. `at` is an id
   *  or URN resolved at propose time (a bad ref is a 404, never a silent forever-wait). Omitted/empty
   *  ⇒ no wait; the change goes coordinated→executing as before. */
  requires: z.array(ChangeRequirementSchema).optional(),
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

// -------------------------------------------------------------------------------------------
// Decision records (DESIGN §10.4)
// -------------------------------------------------------------------------------------------

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
  subjectId: z.string().uuid().optional()
});
export type DecisionListQuery = z.infer<typeof DecisionListQuerySchema>;
export const DecisionListResponseSchema = cursorPageResponseSchema(DecisionSchema);
export type DecisionListResponse = z.infer<typeof DecisionListResponseSchema>;

// -------------------------------------------------------------------------------------------
// Plan -> waves -> wave_targets (DESIGN §9.3) — read model for the UI wave-progression view and
// `scp change explain`.
// -------------------------------------------------------------------------------------------

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
  executorRef: z.record(z.string(), z.unknown()).nullable(),
  /** The snapshot reconcile observed from status() — the per-stage version (ADR-0008 decisions 1-2).
   *  Additive-optional: plans predating the `observed_state` column read back without it; `null` once
   *  observed with nothing. `revision` is the opaque stateRef as-is (a git SHA / Argo revision).
   *  `images` (P4C increment 3) is the deployed image refs (tag/digest, e.g. `ghcr.io/x/y:1.2.3` or
   *  `...@sha256:...`) — the human-facing per-stage version, preferred over the git SHA in the UI.
   *  `rollout` (P4D increment 4) is the OBSERVE-ONLY progressive-delivery snapshot (an Argo Rollout's
   *  phase/step/weight/message as the executor reports it) — display-only; SCP never drives it
   *  (ADR-0008: rollout state is OBSERVED, NOT DRIVEN). Every field is optional (only phase/message
   *  are reliably available; step/weight need the live manifest and are version-dependent). */
  observed: z
    .object({
      revision: z.string().optional(),
      images: z.array(z.string()).optional(),
      rollout: z
        .object({
          phase: z.string().optional(),
          step: z.number().optional(),
          weight: z.number().optional(),
          message: z.string().optional()
        })
        .optional()
    })
    .nullable()
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

/** `GET /changes/{id}:explain` — the change, its compiled plan (if any), every Decision made
 *  about it, and every control run evidence persisted against it (DESIGN §10.4: a Decision's
 *  reasonTree names WHICH control fired and what its outcome status was — `contributingPolicyVersions`
 *  and each `requireControls` effect's `detail.controlObjectId`/`detail.outcome` — but the actual
 *  EVIDENCE payload only ever lives on `control_runs`; M4 adds this array so `scp change explain`
 *  can reconstruct "policy version + control outcome + evidence" end to end, not just the first two). */
/** One cross-change prerequisite's live status (M12 P4B Phase 4), for `explain`'s wait-status view. */
export const ChangeRequirementStatusSchema = z.object({
  key: z.string(),
  /** The object id the key must be provided at. */
  at: z.string().uuid(),
  /** The object's display name, for a readable "Waiting on …" surface (null if it can't be resolved). */
  atName: z.string().nullable(),
  satisfied: z.boolean(),
  /** The change (validating|promoted) currently providing this key at `at`, or null while outstanding. */
  satisfiedByChangeId: z.string().uuid().nullable()
});
export type ChangeRequirementStatus = z.infer<typeof ChangeRequirementStatusSchema>;

/** A change's coupled-pipeline wait status (M12 P4B Phase 4). Present on `explain` for any change
 *  that declared `requires`; null otherwise. `waiting` reflects the change's current state. */
export const ChangeWaitStatusSchema = z.object({
  waiting: z.boolean(),
  requirements: z.array(ChangeRequirementStatusSchema),
  /** M12 P4B fail-closed (coupled-pipelines.md §6#14): stored `requires` entries that do NOT parse
   *  as `{key, at}` (federation peer skew, a legacy row, or raw-SQL corruption — propose-time typed
   *  validation refuses them, so they can only arrive PAST the API). A change carrying any is
   *  UNSATISFIABLE: it parks in `waiting` (the watchdog SLA flags it) rather than proceeding as if
   *  uncoupled, and the offending entries are surfaced here verbatim so an operator can see exactly
   *  what to fix. `.optional()` not `.default()` — additive, absent for every well-formed change. */
  malformed: z.array(z.unknown()).optional()
});
export type ChangeWaitStatus = z.infer<typeof ChangeWaitStatusSchema>;

export const ChangeExplainResponseSchema = z.object({
  change: ChangeSchema,
  plan: ChangePlanSchema.nullable(),
  decisions: z.array(DecisionSchema),
  controlRuns: z.array(ControlRunSchema),
  /** Cross-change coupling status (M12 P4B): null when the change declared no `requires`. */
  waitStatus: ChangeWaitStatusSchema.nullable()
});
export type ChangeExplainResponse = z.infer<typeof ChangeExplainResponseSchema>;

// -------------------------------------------------------------------------------------------
// Change sources / webhook ingress (DESIGN §8 "persist-then-process", §9.2 correlation)
// -------------------------------------------------------------------------------------------

export const SourceMappingSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  sourceKind: z.string(),
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  componentObjectId: z.string().uuid(),
  /** WHICH pipeline releases from this source roll (M12 P4A) — the routing Type (ADR-0007). NOT
   *  inferable from `sourceKind` — a GitHub Actions run can apply Terraform or ship an app — so the
   *  operator declares it per mapping. Mappings predating the Type cutover read back as
   *  'configuration' (the server default). */
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategorySchema,
  createdAt: z.string().datetime()
});
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export const CreateSourceMappingRequestSchema = z.object({
  sourceKind: z.string().min(1),
  repoPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  component: z.string().min(1), // idOrUrn
  /** The routing Type (ADR-0007). Omitted means 'configuration' (defaulted server-side in
   *  `source-mappings-repo.ts`). `.optional()` not `.default()`: a default renders the property
   *  REQUIRED in the generated SDK request type, an unnecessary extra request-shape break. */
  type: ExecutorTypeSchema.optional()
});
export type CreateSourceMappingRequest = z.infer<typeof CreateSourceMappingRequestSchema>;

export const SourceMappingListResponseSchema = cursorPageResponseSchema(SourceMappingSchema);
export type SourceMappingListResponse = z.infer<typeof SourceMappingListResponseSchema>;

/**
 * `POST /change-sources/{sourceKind}/webhook` body — a source-specific payload, kept verbatim
 * (`change_source_events.payload`, DESIGN §8 persist-then-process). M3 ships no per-provider
 * payload parsing (that's M7's real executor plugins); `coordination/webhook-processor.ts` reads
 * only the small, documented, provider-agnostic correlation hint (`repo`/`path`/
 * `correlationKey`) this schema's shape anticipates, but accepts (and persists) any JSON object.
 */
export const ChangeSourceWebhookBodySchema = z.record(z.string(), z.unknown());
export type ChangeSourceWebhookBody = z.infer<typeof ChangeSourceWebhookBodySchema>;

export const WebhookIngressResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string().uuid()
});
export type WebhookIngressResponse = z.infer<typeof WebhookIngressResponseSchema>;

export const ChangeSourceEventParamSchema = z.object({ sourceKind: z.string().min(1) });

/**
 * `PUT /change-sources/{sourceKind}/webhook-secret` (M7, DESIGN §12/BUILD_AND_TEST.md §8 M7) —
 * configures the HMAC signing secret `routes/change-sources.ts`'s webhook route requires and
 * verifies against once set (coordination/webhook-signature.ts). The plaintext secret is
 * write-only from the API's perspective: it is encrypted at rest immediately (secrets/crypto.ts)
 * and never echoed back by any endpoint.
 */
export const CreateWebhookSecretRequestSchema = z.object({
  secret: z.string().min(1)
});
export type CreateWebhookSecretRequest = z.infer<typeof CreateWebhookSecretRequestSchema>;

export const WebhookSecretConfiguredResponseSchema = z.object({
  configured: z.literal(true),
  sourceKind: z.string()
});
export type WebhookSecretConfiguredResponse = z.infer<typeof WebhookSecretConfiguredResponseSchema>;
