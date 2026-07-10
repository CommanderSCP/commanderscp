import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";

/**
 * M3 Change Coordination Engine wire contract (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3).
 * The state machine's legal-edge DATA lives server-side (coordination/transitions.ts +
 * drizzle/0007's `state_transitions` seed) — this file only carries the enum for wire validation.
 */
export const ChangeStateSchema = z.enum([
  "proposed",
  "evaluated",
  "coordinated",
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
  executorPluginId: z.string().nullable(),
  executorRef: z.record(z.string(), z.unknown()).nullable(),
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

/** `GET /changes/{id}:explain` — the change, its compiled plan (if any), and every Decision made about it. */
export const ChangeExplainResponseSchema = z.object({
  change: ChangeSchema,
  plan: ChangePlanSchema.nullable(),
  decisions: z.array(DecisionSchema)
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
  createdAt: z.string().datetime()
});
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export const CreateSourceMappingRequestSchema = z.object({
  sourceKind: z.string().min(1),
  repoPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  component: z.string().min(1) // idOrUrn
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
