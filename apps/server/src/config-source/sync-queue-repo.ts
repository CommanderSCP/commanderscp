/** THE CONFIG-SOURCE TRIGGER'S TWO HALVES. See docs/config-source.md §32. */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { configSourceSyncQueue } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

export interface SyncQueueEntry {
  id: string;
  configSourceId: string;
  repo: string;
  commitSha: string;
  paths: string[];
}

/** Record that a registered repo moved. See docs/config-source.md §33. */
export async function enqueueConfigSourceSync(
  tx: TenantTx,
  orgId: string,
  input: { configSourceId: string; repo: string; commitSha: string; paths: readonly string[] }
): Promise<void> {
  await tx
    .insert(configSourceSyncQueue)
    .values({
      id: uuidv7(),
      orgId,
      configSourceId: input.configSourceId,
      repo: input.repo,
      commitSha: input.commitSha,
      paths: [...input.paths]
    })
    .onConflictDoNothing();
}

/** Claim pending entries for one org, oldest first. See docs/config-source.md §34. */
export async function claimPendingSyncs(
  tx: TenantTx,
  orgId: string,
  limit: number
): Promise<SyncQueueEntry[]> {
  const rows = await tx
    .select({
      id: configSourceSyncQueue.id,
      configSourceId: configSourceSyncQueue.configSourceId,
      repo: configSourceSyncQueue.repo,
      commitSha: configSourceSyncQueue.commitSha,
      paths: configSourceSyncQueue.paths
    })
    .from(configSourceSyncQueue)
    .where(and(eq(configSourceSyncQueue.orgId, orgId), isNull(configSourceSyncQueue.processedAt)))
    .orderBy(asc(configSourceSyncQueue.enqueuedAt))
    .limit(limit)
    .for("update", { skipLocked: true });

  return rows.map((r) => ({
    id: r.id,
    configSourceId: r.configSourceId,
    repo: r.repo,
    commitSha: r.commitSha,
    paths: Array.isArray(r.paths) ? (r.paths as string[]) : []
  }));
}

/** Mark an entry drained. `error` is the honest record of a sync that stopped short — never a
 *  reason to leave the entry pending, because nothing about a re-run would change the answer. */
export async function markSyncProcessed(
  tx: TenantTx,
  orgId: string,
  id: string,
  error?: string
): Promise<void> {
  await tx
    .update(configSourceSyncQueue)
    .set({
      processedAt: new Date(),
      attempts: sql`${configSourceSyncQueue.attempts} + 1`,
      lastError: error ?? null
    })
    .where(and(eq(configSourceSyncQueue.orgId, orgId), eq(configSourceSyncQueue.id, id)));
}
