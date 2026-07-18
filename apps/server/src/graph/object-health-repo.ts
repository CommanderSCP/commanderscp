import { and, eq, inArray } from "drizzle-orm";
import type { HealthRecord } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objectHealth } from "../db/schema.js";

/**
 * Latest-object-health projection repo (observe-enrichment signal 4; ADR-0008 decision 4).
 *
 * INVARIANT (coordinate-not-execute, charter principle 1): SCP never probes/polls/computes health.
 * Every write here is a PUSH-IN (owner PUT today; a future opt-in health-source binding writes the
 * SAME row via `source`). Upsert-in-place — one latest row per (org, object), no delete path —
 * mirroring `executor_observe_cursors`. The row references an EXISTING graph object by
 * `objects(id)` (DESIGN §4.1 projection pattern); it is not a new top-level concept.
 */

function toHealthRecord(row: typeof objectHealth.$inferSelect): HealthRecord {
  return {
    objectId: row.objectId,
    status: row.status as HealthRecord["status"],
    detail: row.detail,
    observedAt: row.observedAt.toISOString(),
    source: row.source
  };
}

export interface UpsertObjectHealthInput {
  orgId: string;
  objectId: string;
  status: HealthRecord["status"];
  detail?: string | undefined;
  observedAt?: string | undefined;
  source?: string | undefined;
}

/** Idempotent upsert of the single latest-health row for (org, object). */
export async function upsertObjectHealth(
  tx: TenantTx,
  input: UpsertObjectHealthInput
): Promise<HealthRecord> {
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
  const detail = input.detail ?? null;
  const source = input.source ?? null;
  const rows = await tx
    .insert(objectHealth)
    .values({
      orgId: input.orgId,
      objectId: input.objectId,
      status: input.status,
      detail,
      observedAt,
      source,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: [objectHealth.orgId, objectHealth.objectId],
      set: {
        status: input.status,
        detail,
        observedAt,
        source,
        updatedAt: new Date()
      }
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("object_health upsert returned no row");
  return toHealthRecord(row);
}

/** The latest-health record for one object, or null when none has ever been pushed. */
export async function getObjectHealth(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<HealthRecord | null> {
  const rows = await tx
    .select()
    .from(objectHealth)
    .where(and(eq(objectHealth.orgId, orgId), eq(objectHealth.objectId, objectId)))
    .limit(1);
  const row = rows[0];
  return row ? toHealthRecord(row) : null;
}

/**
 * Latest-health records for an object-id set (the graph node-payload JOIN). Objects with no pushed
 * health are simply absent from the result — the UI renders them grey/unknown (no fabrication).
 */
export async function getObjectHealthBatch(
  tx: TenantTx,
  orgId: string,
  ids: string[]
): Promise<HealthRecord[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(objectHealth)
    .where(and(eq(objectHealth.orgId, orgId), inArray(objectHealth.objectId, ids)));
  return rows.map(toHealthRecord);
}
