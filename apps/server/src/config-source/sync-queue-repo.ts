/**
 * THE CONFIG-SOURCE TRIGGER'S TWO HALVES (migration 0109; ADR-0046 section 2, proposal section 4).
 *
 * ENQUEUE runs inside the webhook pass's transaction and does the one thing that is safe there:
 * records that a registered repo moved. DRAIN runs on its own reconcile step, outside that
 * transaction, because reading a manifest is an out-of-process RPC and applying one writes the
 * graph - neither belongs inside a shared tx whose other work is correlating unrelated events.
 *
 * A FAILED DRAIN IS STILL A DRAIN. `processed_at` is set either way and the reason is recorded, so
 * a repo that is ahead of the graph shows up as a DISPLAYED state (proposal section 4's failure
 * honesty) rather than as an entry retried forever. Retrying a manifest that does not validate would
 * never converge, and the next push enqueues fresh work anyway.
 */

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

/**
 * Record that a registered repo moved.
 *
 * ON CONFLICT DO NOTHING against the PENDING partial unique index: a provider redelivery while an
 * entry is still pending is the same work. Once drained, the same commit may enqueue again — see the
 * migration header for why that is deliberate rather than a leak.
 */
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

/**
 * Claim pending entries for one org, oldest first.
 *
 * `FOR UPDATE SKIP LOCKED`, the same claim `processChangeSourceEvents` uses: two concurrent ticks
 * (or two workers, once the deployment scales) never both drain one entry. Without it the second
 * would re-apply a manifest the first is mid-apply on.
 */
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
