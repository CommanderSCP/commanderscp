import { z } from "zod";
import { ExecutorTypeSchema, ExecutorCategorySchema } from "./executors.js";

/**
 * Service release board (docs/proposals/coordination-ui-views.md § "Service release board", Phase 2,
 * Layer A). A server-side projection: a service's components in one scannable table, each row carrying
 * that component's LATEST change's per-stage wave summary + attention signals, plus a releasing /
 * blocked / stable summary strip.
 *
 * Why a projection and not client-aggregation: there is no target-filtered changes list, so a browser
 * would have to page every change and `explain()` each to find "the latest change for this component"
 * — an O(all-changes) fan-out per board render. This endpoint collapses that to one HTTP call with the
 * fan-out contained in a single server transaction (the `latest-change-per-target` join is the sole
 * net-new capability). Strictly Layer A: no invented per-stage image versions or health — those are
 * Layer B and are surfaced by the UI as explicit placeholders, never fabricated here.
 */

/** A distinct pipeline-kind pair on a stage (ADR-0007): the Category of the wave-target's Type. */
export const ServiceBoardKindSchema = z.object({
  category: ExecutorCategorySchema,
  type: ExecutorTypeSchema
});
export type ServiceBoardKind = z.infer<typeof ServiceBoardKindSchema>;

/** One pipeline stage of a component's latest change = one compiled wave, summarized. `status` is the
 *  raw wave status (pending|running|succeeded|failed|skipped); `kinds` are the distinct Category·Type
 *  pairs across the wave's targets; `failedTargets` counts targets in a terminal-failure status so the
 *  UI can surface a partial-failure stage without re-deriving it. */
export const ServiceBoardStageSchema = z.object({
  waveIndex: z.number().int(),
  name: z.string().nullable(),
  status: z.string(),
  kinds: z.array(ServiceBoardKindSchema),
  targetCount: z.number().int(),
  failedTargets: z.number().int()
});
export type ServiceBoardStage = z.infer<typeof ServiceBoardStageSchema>;

/** The attention signals for a row's latest change (all real, Layer A). `blocked` is derived from a
 *  failed wave/target OR a persisted block `Decision`; `decisionId` is that block Decision's id (charter
 *  principle 6 — every blocked surface carries a decision_id), null otherwise. `awaitingApproval` is a
 *  pending (unsatisfied) ApprovalRequest on the change. `emergency` is the change's own emergency flag. */
export const ServiceBoardAttentionSchema = z.object({
  blocked: z.boolean(),
  decisionId: z.string().uuid().nullable(),
  awaitingApproval: z.boolean(),
  emergency: z.boolean()
});
export type ServiceBoardAttention = z.infer<typeof ServiceBoardAttentionSchema>;

/** An EXISTING active freeze (read-only) scoped directly to this object. Phase 2 surfaces freezes as
 *  status only — declaring/lifting a freeze is a controls-phase (Phase 5) concern. */
export const ServiceBoardFreezeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string(),
  endsAt: z.string().datetime()
});
export type ServiceBoardFreeze = z.infer<typeof ServiceBoardFreezeSchema>;

/** One board row = one component of the service. `latestChangeId` links the row to that component's
 *  active/most-recent change pipeline (`/changes/{id}/pipeline`); null when the component has never
 *  been a change target. `currentStage` is the running (or last non-pending) wave's display name. */
export const ServiceBoardRowSchema = z.object({
  component: z.object({
    id: z.string().uuid(),
    urn: z.string(),
    name: z.string()
  }),
  latestChangeId: z.string().uuid().nullable(),
  changeState: z.string().nullable(),
  changeName: z.string().nullable(),
  currentStage: z.string().nullable(),
  stages: z.array(ServiceBoardStageSchema),
  attention: ServiceBoardAttentionSchema,
  /** An active freeze scoped to THIS component (read-only). Null when none covers it directly. */
  activeFreeze: ServiceBoardFreezeSchema.nullable()
});
export type ServiceBoardRow = z.infer<typeof ServiceBoardRowSchema>;

/** The releasing / blocked / stable summary strip. `blocked` counts rows whose latest change is blocked
 *  (failed wave/target or block Decision); `releasing` counts rows whose latest change is in-flight and
 *  not blocked; `stable` is every remaining row (promoted / settled / no active change). The three are
 *  mutually exclusive and sum to `rows.length`. */
export const ServiceBoardSummarySchema = z.object({
  releasing: z.number().int(),
  blocked: z.number().int(),
  stable: z.number().int()
});
export type ServiceBoardSummary = z.infer<typeof ServiceBoardSummarySchema>;

export const ServiceBoardResponseSchema = z.object({
  service: z.object({
    id: z.string().uuid(),
    urn: z.string(),
    name: z.string()
  }),
  rows: z.array(ServiceBoardRowSchema),
  summary: ServiceBoardSummarySchema,
  /** An active freeze scoped directly to the SERVICE object (read-only), covering every component. */
  serviceFreeze: ServiceBoardFreezeSchema.nullable()
});
export type ServiceBoardResponse = z.infer<typeof ServiceBoardResponseSchema>;
