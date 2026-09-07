import { z } from "zod";

/** Object health contract. See docs/schemas.md §297. */

export const HealthStatusSchema = z.enum(["healthy", "degraded", "down", "unknown"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/** `PUT /objects/{type}/{idOrUrn}/health` — idempotent upsert of the latest-health record. */
export const PushHealthRequestSchema = z.object({
  status: HealthStatusSchema,
  detail: z.string().max(2000).optional(),
  /** When the pushing source observed this state. Defaults to server receive time when omitted. */
  observedAt: z.string().datetime().optional(),
  /** Provenance of the push — free text today (`owner`), a binding descriptor later. */
  source: z.string().max(500).optional()
});
export type PushHealthRequest = z.infer<typeof PushHealthRequestSchema>;

/** The latest-health record surfaced on the object read and the graph node join. */
export const HealthRecordSchema = z.object({
  objectId: z.string().uuid(),
  status: HealthStatusSchema,
  detail: z.string().nullable(),
  observedAt: z.string().datetime(),
  source: z.string().nullable()
});
export type HealthRecord = z.infer<typeof HealthRecordSchema>;

/** Batch latest-health read over a caller-supplied object-id set. See docs/schemas.md §298. */
export const HealthBatchRequestSchema = z.object({
  objectId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(2000)
});
export type HealthBatchRequest = z.infer<typeof HealthBatchRequestSchema>;

export const HealthBatchResultSchema = z.object({
  records: z.array(HealthRecordSchema)
});
export type HealthBatchResult = z.infer<typeof HealthBatchResultSchema>;
