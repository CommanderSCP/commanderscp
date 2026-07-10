import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";

/**
 * M4 Governance Engine wire contract (DESIGN.md §10, BUILD_AND_TEST.md §8 M4). Policies and
 * Controls themselves are ordinary graph objects (typed-registry resources — `GraphObjectSchema`
 * already covers them, same as `release-topology`); this file only carries the projection-table
 * resources that have no graph-object equivalent: control run evidence, approval quorum, and
 * freezes.
 */

export const ControlOutcomeStatusSchema = z.enum(["pass", "fail", "warning", "skipped", "timed_out", "expired"]);
export type ControlOutcomeStatus = z.infer<typeof ControlOutcomeStatusSchema>;

export const ControlRunSchema = z.object({
  id: z.string().uuid(),
  controlObjectId: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  status: ControlOutcomeStatusSchema,
  evidence: z.record(z.string(), z.unknown()),
  detail: z.string().nullable(),
  decisionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime()
});
export type ControlRun = z.infer<typeof ControlRunSchema>;
export const ControlRunListResponseSchema = cursorPageResponseSchema(ControlRunSchema);
export type ControlRunListResponse = z.infer<typeof ControlRunListResponseSchema>;

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

// -------------------------------------------------------------------------------------------
// Approvals (DESIGN §10.2 — N-of-M quorum)
// -------------------------------------------------------------------------------------------

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

// -------------------------------------------------------------------------------------------
// Freezes (DESIGN §10.3)
// -------------------------------------------------------------------------------------------

export const FreezeSchema = z.object({
  id: z.string().uuid(),
  scopeObjectId: z.string().uuid(),
  name: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string(),
  createdByActorId: z.string().uuid(),
  createdAt: z.string().datetime()
});
export type Freeze = z.infer<typeof FreezeSchema>;

export const CreateFreezeRequestSchema = z.object({
  scopeObjectId: z.string().min(1), // id or URN — resolved server-side
  name: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().min(1)
});
export type CreateFreezeRequest = z.infer<typeof CreateFreezeRequestSchema>;

export const FreezeIdParamSchema = z.object({ id: z.string().uuid() });
export const FreezeListResponseSchema = cursorPageResponseSchema(FreezeSchema);
export type FreezeListResponse = z.infer<typeof FreezeListResponseSchema>;

// -------------------------------------------------------------------------------------------
// `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7) — a dry-run gate evaluation against a
// change's CURRENT state, without attempting any transition. Reuses the exact same
// governance/gate-orchestrator.ts logic the real lifecycle-edge/wave-boundary gates run, so its
// output is by construction identical in shape to what a real block's Decision would show.
// -------------------------------------------------------------------------------------------

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
