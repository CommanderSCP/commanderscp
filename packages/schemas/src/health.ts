import { z } from "zod";

/**
 * Object health contract (observe-enrichment signal 4; ADR-0008 decision 4). SCP does NOT probe,
 * poll, or compute health — this is a PUSH-IN record an owner (or, later, an opt-in health-source
 * binding writing the SAME row) supplies, stored as an object-referencing PROJECTION row keyed by
 * `objects(id)` (DESIGN §4.1), NOT a new top-level concept table (charter principle 2). The
 * `source` field is binding-ready: an owner push writes `source:'owner'` today; a future
 * Prometheus/HTTP-probe binding on the 60s observe cadence writes `source:'prometheus:<query>'`
 * into the same projection with no schema change (ADR-0008 non-goal: per-observation history).
 */

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

/**
 * Batch latest-health read over a caller-supplied object-id set — the graph node-payload JOIN
 * (`POST /graph/subgraph` returns EDGES ONLY, so health is joined at the node source in a parallel
 * follow-up call, mirroring the subgraph batch-by-ids pattern). `objectId` is the exploration root
 * that scopes `graph:query` authorization, identical to `SubgraphRequestSchema`. Objects with no
 * pushed health are simply absent from `records` — the UI renders them grey/unknown (no fabrication).
 */
export const HealthBatchRequestSchema = z.object({
  objectId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(2000)
});
export type HealthBatchRequest = z.infer<typeof HealthBatchRequestSchema>;

export const HealthBatchResultSchema = z.object({
  records: z.array(HealthRecordSchema)
});
export type HealthBatchResult = z.infer<typeof HealthBatchResultSchema>;
