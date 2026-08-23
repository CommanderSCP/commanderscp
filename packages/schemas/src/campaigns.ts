import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import { ChangeSchema, DecisionSchema } from "./changes.js";
import { ExecutorTypeSchema } from "./executors.js";

/**
 * M5 Campaigns wire contract (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Campaigns introduce NO
 * new engine machinery — a Campaign compiles its own plan/waves over
 * the SAME `coordination/plan-compiler.ts` pure function a Change uses (`coordination/
 * campaign-plan-service.ts`); its wave targets fan out into real M3 Changes (`ChangeSchema`,
 * unchanged) that run through the completely unmodified change lifecycle/gates. Campaign STATUS
 * is a pure DERIVED aggregation (`coordination/campaign-status.ts`), never a stored state column
 * — hence no `CampaignStateSchema` mirroring `ChangeStateSchema`'s 8-state machine here.
 */

export const CampaignStatusSchema = z.enum([
  "proposed", // no plan compiled yet
  "active", // plan compiled, at least one wave in flight, none blocked/failed
  "blocked", // the active wave's boundary gate returned "block" (a policy/control did not pass)
  "failed", // a wave's member changes failed/were cancelled without recovering
  "completed", // every wave succeeded
  "partially_rolled_back", // some — but not all — accepted member changes have been rolled back
  "rolled_back" // every accepted member change has been rolled back
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CampaignSchema = z.object({
  id: z.string().uuid(), // = the underlying graph object's id
  orgId: z.string().uuid(),
  urn: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  targets: z.array(z.string().uuid()),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  status: CampaignStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** `POST /campaigns` — `targets` (>=1 idOrUrn) is the set of graph objects each wave's per-target
 *  member Change will be proposed against, exactly like `CreateChangeRequestSchema.targets`. */
export const CreateCampaignRequestSchema = z.object({
  name: z.string().min(1).max(200),
  id: z.string().uuid().optional(),
  urn: z.string().optional(),
  domainId: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
  /** Release-topology object id or URN to compile the campaign's waves against (optional — falls
   *  back to pure `depends_on` toposort, same as a Change). */
  topology: z.string().optional(),
  /** WHICH pipeline every change this campaign fans out rolls (M12 P4A) — the routing Type
   *  (ADR-0007). "Patch the base AMI across every cluster" is an `infrastructure` campaign, "roll
   *  the log4j bump across every service" a `configuration` one. Declared once on the campaign
   *  rather than per fanned-out change, which is what a campaign IS: one intent, many targets.
   *  Omitted means 'configuration' (the server default). */
  type: ExecutorTypeSchema.optional(),
  targets: z.array(z.string().min(1)).min(1)
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequestSchema>;

export const CampaignListQuerySchema = CursorPageQuerySchema.extend({
  status: CampaignStatusSchema.optional()
});
export type CampaignListQuery = z.infer<typeof CampaignListQuerySchema>;

export const CampaignListResponseSchema = cursorPageResponseSchema(CampaignSchema);
export type CampaignListResponse = z.infer<typeof CampaignListResponseSchema>;

export const CampaignIdParamSchema = z.object({ id: z.string().uuid() });

export const RollbackCampaignRequestSchema = z.object({
  reason: z.string().min(1)
});
export type RollbackCampaignRequest = z.infer<typeof RollbackCampaignRequestSchema>;

/** `POST /campaigns/{id}/rollback` response — DESIGN §9.5: "reverts its accepted member targets
 *  through the same wave/rollback machinery, each producing a Decision." One `rolledBack` entry
 *  per member Change actually rolled back (each `rollbackChange` is a real, independent Change);
 *  `skipped` names every member Change that was NOT eligible (never accepted, already rolled
 *  back, etc.) and why — never silently dropped. */
export const RollbackCampaignResponseSchema = z.object({
  rolledBack: z.array(
    z.object({ originalChangeObjectId: z.string().uuid(), rollbackChange: ChangeSchema })
  ),
  skipped: z.array(z.object({ originalChangeObjectId: z.string().uuid(), reason: z.string() }))
});
export type RollbackCampaignResponse = z.infer<typeof RollbackCampaignResponseSchema>;

/** One member Change of a campaign wave, plus the raw target it was proposed against — DESIGN
 *  §9.5: "Member changes are real Changes linked to the campaign via coordinates relationships." */
export const CampaignWaveTargetSchema = z.object({
  id: z.string().uuid(),
  waveId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  targetUrn: z.string().optional(),
  targetName: z.string().optional(),
  memberChangeObjectId: z.string().uuid().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CampaignWaveTarget = z.infer<typeof CampaignWaveTargetSchema>;

export const CampaignWaveSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  waveIndex: z.number().int(),
  name: z.string().nullable(),
  requiresFanIn: z.boolean(),
  status: z.string(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  targets: z.array(CampaignWaveTargetSchema)
});
export type CampaignWave = z.infer<typeof CampaignWaveSchema>;

export const CampaignPlanSchema = z.object({
  id: z.string().uuid(),
  campaignObjectId: z.string().uuid(),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
  waves: z.array(CampaignWaveSchema)
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

/** `GET /campaigns/{id}:explain` — the campaign, its compiled plan (if any, with each wave
 *  target's member Change resolved inline), and every Decision made about it (campaign-level
 *  wave-boundary gate checks + the campaign-level rollback trigger, if any) — the campaign-scoped
 *  analogue of `ChangeExplainResponseSchema`. */
export const CampaignExplainResponseSchema = z.object({
  campaign: CampaignSchema,
  plan: CampaignPlanSchema.nullable(),
  decisions: z.array(DecisionSchema)
});
export type CampaignExplainResponse = z.infer<typeof CampaignExplainResponseSchema>;

// -------------------------------------------------------------------------------------------
