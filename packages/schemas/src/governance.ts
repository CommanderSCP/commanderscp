import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import {
  ScanFindingRetentionClassSchema,
  ScanFindingSchema,
  ScanFindingsRecordSchema
} from "./supply-chain.js";

/** M4 Governance Engine wire contract. See docs/schemas.md §260. */

export const ControlOutcomeStatusSchema = z.enum([
  "pass",
  "fail",
  "warning",
  "skipped",
  "timed_out",
  "expired"
]);
export type ControlOutcomeStatus = z.infer<typeof ControlOutcomeStatusSchema>;

export const ControlRunSchema = z.object({
  id: z.string().uuid(),
  controlObjectId: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  status: ControlOutcomeStatusSchema,
  evidence: z.record(z.string(), z.unknown()),
  detail: z.string().nullable(),
  decisionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  /** M22.8 — WHICH GATE CROSSING THIS RUN AUTHORIZED. See docs/schemas.md §261. */
  gateKind: z.enum(["lifecycle_edge", "wave_boundary"]).optional(),
  /** `{fromState,toState}` for a lifecycle edge, `{waveIndex,topologyObjectId}` for a wave boundary.
   *  Free-form on purpose: it is the gate's own identity object, and pinning a closed union here
   *  would make adding a third gate kind a wire-breaking change. */
  gateRef: z.record(z.string(), z.unknown()).optional()
});
export type ControlRun = z.infer<typeof ControlRunSchema>;
export const ControlRunListResponseSchema = cursorPageResponseSchema(ControlRunSchema);
export type ControlRunListResponse = z.infer<typeof ControlRunListResponseSchema>;

export const ControlRunIdParamSchema = z.object({ id: z.string().uuid() });
export type ControlRunIdParam = z.infer<typeof ControlRunIdParamSchema>;

/** M22.9 — one `scan_findings` row on the wire. `ScanFindingSchema` unchanged (it is what the parser
 *  produced and what an exclusion clause matches on) plus the two things only the WRITE knows:
 *  `ordinal`, which is the finding's identity because it has no other one, and the ADR-0024 §D1
 *  retention class the row was written at. */
export const PersistedScanFindingSchema = ScanFindingSchema.extend({
  ordinal: z.number().int().nonnegative(),
  /** `E` = an EXCLUDED finding, i.e. accepted-risk evidence recording what an operator chose to
   *  tolerate; `O` = ordinary telemetry. Projected because past `SCAN_EXCLUSION_EVIDENCE_CAP` (100)
   *  the run's `evidence.exclusions.applied` list stops enumerating and only these rows still say
   *  WHICH findings were tolerated (ADR-0033 D10, charter principle 6). */
  retentionClass: ScanFindingRetentionClassSchema
});
export type PersistedScanFinding = z.infer<typeof PersistedScanFindingSchema>;

/** M22.9 — `GET /control-runs/{id}/findings`. See docs/schemas.md §262. */
export const ControlRunFindingsResponseSchema = cursorPageResponseSchema(
  PersistedScanFindingSchema
).extend({
  findingsRecord: ScanFindingsRecordSchema.nullable()
});
export type ControlRunFindingsResponse = z.infer<typeof ControlRunFindingsResponseSchema>;

/** `POST /controls/{idOrUrn}/bindings` — binds a Control graph object to a ControlPlugin instance
 *  (DESIGN §10.2: "ControlPlugin implementations are bindings"). */
export const CreateControlBindingRequestSchema = z.object({
  pluginModule: z.string().min(1),
  pluginInstanceId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional()
});
export type CreateControlBindingRequest = z.infer<typeof CreateControlBindingRequestSchema>;

export const ControlBindingSchema = z.object({
  id: z.string().uuid(),
  controlObjectId: z.string().uuid(),
  pluginModule: z.string(),
  pluginInstanceId: z.string(),
  config: z.unknown()
});
export type ControlBinding = z.infer<typeof ControlBindingSchema>;

// Approvals (DESIGN §10.2 — N-of-M quorum)

export const ApprovalRequestStatusSchema = z.enum(["pending", "satisfied"]);

export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  policyObjectId: z.string().uuid(),
  policyVersion: z.number().int(),
  effectIndex: z.number().int(),
  requiredCount: z.number().int(),
  fromRole: z.string(),
  scopeObjectId: z.string().uuid(),
  status: ApprovalRequestStatusSchema,
  createdAt: z.string().datetime(),
  satisfiedAt: z.string().datetime().nullable(),
  voteCount: z.number().int()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalRequestListQuerySchema = CursorPageQuerySchema.extend({
  changeId: z.string().optional()
});
export type ApprovalRequestListQuery = z.infer<typeof ApprovalRequestListQuerySchema>;
export const ApprovalRequestListResponseSchema = cursorPageResponseSchema(ApprovalRequestSchema);
export type ApprovalRequestListResponse = z.infer<typeof ApprovalRequestListResponseSchema>;

export const ApprovalIdParamSchema = z.object({ id: z.string().uuid() });

export const AttestationSchema = z.object({
  record: z.object({
    approverSubjectId: z.string(),
    approverIdpSubject: z.string().nullable(),
    approvedObjectUrn: z.string(),
    approvedObjectContentHash: z.string(),
    decisionId: z.string().uuid().nullable(),
    timestamp: z.string().datetime()
  }),
  signature: z.string(),
  publicKey: z.string()
});
export type Attestation = z.infer<typeof AttestationSchema>;

export const ApprovalVoteSchema = z.object({
  id: z.string().uuid(),
  approvalRequestId: z.string().uuid(),
  voterObjectId: z.string().uuid(),
  decisionId: z.string().uuid().nullable(),
  attestation: AttestationSchema,
  votedAt: z.string().datetime()
});
export type ApprovalVote = z.infer<typeof ApprovalVoteSchema>;

/** `POST /approvals/{id}/votes` — no body beyond an optional IdP-subject hint (attestation
 *  richness); the voter is always the authenticated caller — you can never cast a vote on
 *  someone else's behalf. */
export const CastApprovalVoteRequestSchema = z.object({
  voterIdpSubject: z.string().optional()
});
export type CastApprovalVoteRequest = z.infer<typeof CastApprovalVoteRequestSchema>;

// Freezes (DESIGN §10.3)

export const FreezeSchema = z.object({
  id: z.string().uuid(),
  scopeObjectId: z.string().uuid(),
  name: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string(),
  createdByActorId: z.string().uuid(),
  createdAt: z.string().datetime(),
  /** Does this freeze park the whole wave, or the targets. See docs/schemas.md §263. */
  atomic: z.boolean(),
  /** When this freeze was retracted, or null while it stands. See docs/schemas.md §264. */
  liftedAt: z.string().datetime().nullable(),
  liftedByActorId: z.string().uuid().nullable(),
  /** Why it was lifted — mandatory and non-empty whenever `liftedAt` is set, `null` otherwise. A
   *  lift is a governance LOOSENING that applies to everyone at once; `freeze:override` already
   *  refuses to bypass a freeze for a single change without a reason, and retracting one outright
   *  cannot be held to a lower standard. */
  liftReason: z.string().nullable(),
  /** The id of this freeze's graph object, or null. See docs/schemas.md §265. */
  objectId: z.string().uuid().nullable()
});
export type Freeze = z.infer<typeof FreezeSchema>;

export const CreateFreezeRequestSchema = z.object({
  scopeObjectId: z.string().min(1),
  name: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().min(1),
  /** Opt this freeze out of per-target admission. See docs/schemas.md §266. */
  atomic: z.boolean().optional(),
  /** Also give this freeze a graph object, so it federates. See docs/schemas.md §267. */
  federate: z.boolean().optional(),
  /** This freeze's object never leaves this security domain. See docs/schemas.md §268. */
  domainLocal: z.boolean().optional()
});
export type CreateFreezeRequest = z.infer<typeof CreateFreezeRequestSchema>;

export const FreezeIdParamSchema = z.object({ id: z.string().uuid() });
export const FreezeListResponseSchema = cursorPageResponseSchema(FreezeSchema);
export type FreezeListResponse = z.infer<typeof FreezeListResponseSchema>;

/** M25.1 — the body of `DELETE /api/v1/freezes/{id}`. See docs/schemas.md §269. */
export const LiftFreezeRequestSchema = z.object({
  reason: z.string().min(1)
});
export type LiftFreezeRequest = z.infer<typeof LiftFreezeRequestSchema>;

/** M25.1 — the body of `PATCH /api/v1/freezes/{id}`. See docs/schemas.md §270. */
export const UpdateFreezeWindowRequestSchema = z.object({
  endsAt: z.string().datetime(),
  reason: z.string().min(1)
});
export type UpdateFreezeWindowRequest = z.infer<typeof UpdateFreezeWindowRequestSchema>;

// `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7). See docs/schemas.md §271.

export const PolicyEvaluateRequestSchema = z.object({
  changeId: z.string().min(1) // id or URN
});
export type PolicyEvaluateRequest = z.infer<typeof PolicyEvaluateRequestSchema>;

export const PolicyEvaluateResponseSchema = z.object({
  verdict: z.enum(["allow", "block"]),
  reasonTree: z.record(z.string(), z.unknown()),
  inputContext: z.record(z.string(), z.unknown())
});
export type PolicyEvaluateResponse = z.infer<typeof PolicyEvaluateResponseSchema>;

// M25.3 — THE INSTANCE-SCOPED. See docs/schemas.md §272.

/** WHERE a platform freeze applies. See docs/schemas.md §273. */
export const InstanceFreezeMatchSchema = z
  .object({
    /** Deployment-wide. Mutually exclusive with `environment` (refused 400, and by a DB CHECK). */
    allEnvironments: z.boolean().optional(),
    /** A `deployment-target`'s `properties.environment`, e.g. See docs/schemas.md §274. */
    environment: z.string().trim().min(1).optional(),
    /** Narrows `environment` to one `properties.region`, e.g. `"amer"`. A target that declares no
     *  region does NOT match a region-narrowed freeze: it has not said it is that region.
     *  Trimmed for exactly the reason `environment` is — same comparison, same silent no-match. */
    region: z.string().trim().min(1).optional()
  })
  .refine((m) => (m.allEnvironments === true) !== (m.environment !== undefined), {
    message:
      "exactly one addressing form: allEnvironments: true (the whole deployment), or environment (optionally narrowed by region). An absent environment is NOT deployment-wide — say allEnvironments: true and mean it."
  })
  .refine((m) => m.region === undefined || m.environment !== undefined, {
    message:
      "region requires environment — a region without an environment is a coordinate with no origin"
  });
// Both refinements are enforced at runtime, not in the spec. See docs/schemas.md §275.
export type InstanceFreezeMatch = z.infer<typeof InstanceFreezeMatchSchema>;

/** One instance-scoped freeze — the API projection of `instance_freezes` (no `orgId`: it binds
 *  EVERY org on the deployment). */
export const InstanceFreezeSchema = z.object({
  /** A real uuid, and the SAME id the gate's block Decision and the service board carry. It does
   *  NOT resolve through `GET /v1/freezes/{id}`, which is org-scoped — the block Decision states
   *  its `tier` so a reader knows to come here instead. */
  id: z.string().uuid(),
  /** The operator slug: the `PUT`/`DELETE` path segment, and the name a remedy sentence quotes. */
  key: z.string().min(1),
  name: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string(),
  match: z.object({
    allEnvironments: z.boolean(),
    environment: z.string().nullable(),
    region: z.string().nullable()
  }),
  /** Owner decision D5, identical semantics to `FreezeSchema.atomic` one tier down. */
  atomic: z.boolean(),
  /** Whether ANY tenant role may override this freeze. `false` (the default) means none can,
   *  however privileged — not an org-root Owner. `true` means the OPERATOR has admitted tenant
   *  override for this freeze, and an actor holding `freeze:override` AT THE ORG ROOT may then
   *  override it with the same mandatory reason. Two independent authorities, both required. */
  overridable: z.boolean(),
  note: z.string().nullable(),
  /** When it was RETRACTED, or null while it stands. Lifted rows are returned FOREVER: a
   *  `gate`/`freeze_admission` Decision cites this id and "what was this freeze that blocked me?"
   *  must stay answerable (charter principle 6). LIFTED IS A FIELD, NOT AN ABSENCE. */
  liftedAt: z.string().datetime().nullable(),
  liftReason: z.string().nullable(),
  updatedAt: z.string().datetime()
});
export type InstanceFreeze = z.infer<typeof InstanceFreezeSchema>;

export const InstanceFreezeListResponseSchema = z.object({
  items: z.array(InstanceFreezeSchema)
});
export type InstanceFreezeListResponse = z.infer<typeof InstanceFreezeListResponseSchema>;

export const InstanceFreezeKeyParamSchema = z.object({ key: z.string().min(1).max(200) });

/** The operator-authored write body: a full replacement. See docs/schemas.md §276. */
export const PutInstanceFreezeRequestSchema = z.object({
  name: z.string().max(200).nullish(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().min(1).max(2000),
  match: InstanceFreezeMatchSchema,
  atomic: z.boolean().optional(),
  overridable: z.boolean().optional(),
  note: z.string().max(500).nullish()
});
export type PutInstanceFreezeRequest = z.infer<typeof PutInstanceFreezeRequestSchema>;

/** The body of `DELETE /v1/instance/freezes/{key}`. See docs/schemas.md §277. */
export const LiftInstanceFreezeRequestSchema = z.object({
  reason: z.string().min(1).max(2000)
});
export type LiftInstanceFreezeRequest = z.infer<typeof LiftInstanceFreezeRequestSchema>;
