import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { continuousProbeRetractions } from "../db/schema.js";

/** THE RETRACTION QUEUE. See docs/coordination.md §340. */

/** The schedule id a hook owns in the executor. See docs/coordination.md §341. */
export function probeScheduleId(componentObjectId: string, hookId: string): string {
  // Executor resource names are DNS-ish, and a DNS label is 63 characters: 10 + 24 + 1 + 12 = 47.
  const safeHook = hookId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256")
    .update(`${componentObjectId}:${hookId}`)
    .digest("hex")
    .slice(0, 12);
  return safeHook ? `scp-probe-${safeHook}-${digest}` : `scp-probe-${digest}`;
}

export interface ProbeRetraction {
  id: string;
  componentObjectId: string;
  hookId: string;
  scheduleId: string;
  attempts: number;
}

/** Records a retraction owed; the id is frozen here. See docs/coordination.md §342. */
export async function enqueueProbeScheduleRetraction(
  tx: TenantTx,
  orgId: string,
  hook: { componentObjectId: string; hookId: string }
): Promise<void> {
  await tx
    .insert(continuousProbeRetractions)
    .values({
      id: uuidv7(),
      orgId,
      componentObjectId: hook.componentObjectId,
      hookId: hook.hookId,
      scheduleId: probeScheduleId(hook.componentObjectId, hook.hookId)
    })
    .onConflictDoNothing({
      target: [
        continuousProbeRetractions.orgId,
        continuousProbeRetractions.componentObjectId,
        continuousProbeRetractions.hookId
      ]
    });
}

/** Every outstanding retraction for one org, oldest first. Unbounded on purpose: the set is one row
 *  per hook an operator actually deleted, and a retraction left undone is a cron still costing the
 *  domain money. */
export async function listPendingProbeRetractions(
  tx: TenantTx,
  orgId: string
): Promise<ProbeRetraction[]> {
  return tx
    .select({
      id: continuousProbeRetractions.id,
      componentObjectId: continuousProbeRetractions.componentObjectId,
      hookId: continuousProbeRetractions.hookId,
      scheduleId: continuousProbeRetractions.scheduleId,
      attempts: continuousProbeRetractions.attempts
    })
    .from(continuousProbeRetractions)
    .where(eq(continuousProbeRetractions.orgId, orgId))
    .orderBy(continuousProbeRetractions.enqueuedAt);
}

/** Retracted. The row is DELETED rather than marked — nothing reads this table for status, so a
 *  drained row would be a log with a unique index on it. */
export async function completeProbeRetraction(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<void> {
  await tx
    .delete(continuousProbeRetractions)
    .where(and(eq(continuousProbeRetractions.orgId, orgId), eq(continuousProbeRetractions.id, id)));
}

/** Left pending, with the failure recorded. Retried on the NEXT tick and every tick after: unlike
 *  `config_source_sync_queue`, giving up here is the worse outcome — the orphaned schedule keeps
 *  firing. `attempts`/`last_error` are what make a row that never drains visible. */
export async function recordProbeRetractionFailure(
  tx: TenantTx,
  orgId: string,
  id: string,
  message: string
): Promise<void> {
  await tx
    .update(continuousProbeRetractions)
    .set({ attempts: sql`${continuousProbeRetractions.attempts} + 1`, lastError: message })
    .where(and(eq(continuousProbeRetractions.orgId, orgId), eq(continuousProbeRetractions.id, id)));
}
