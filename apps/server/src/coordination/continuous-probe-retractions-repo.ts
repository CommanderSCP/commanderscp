import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { continuousProbeRetractions } from "../db/schema.js";

/**
 * THE RETRACTION QUEUE (migration 0111) — schedules a deleted `continuous` hook still owes its
 * executor a `removeSchedule` for.
 *
 * `deleteHook` enqueues here inside its own transaction and the probe driver drains it on the next
 * tick. The migration header carries the full argument; the short form is that `removeSchedule` is
 * an out-of-process RPC, `deleteHook` runs inside a tenant transaction, and a retraction that threw
 * there would abort the IaC apply or federation import that removed the row AND be lost — the row
 * is gone, so nothing would know to try again.
 *
 * THIS MODULE OWNS `probeScheduleId` so that neither side has to import the other. The driver
 * DECLARES ids and this queue RETRACTS them; putting the derivation in the driver would make
 * `pipeline-hooks-repo.ts` import it, closing a cycle through `pipeline-hook-runs.ts`.
 */

/**
 * The schedule id a hook owns in the executor. Derived, never stored at declare time: the same
 * inputs must produce the same id on every tick and in every replica, or a re-declaration would
 * create a second schedule beside the first instead of updating it. A RETRACTION stores it, for the
 * opposite reason — see {@link enqueueProbeScheduleRetraction}.
 *
 * IT USED TO BE `componentObjectId.slice(0, 8)` PLUS THE HOOK ID, AND THAT COLLIDED. Object ids are
 * uuidv7: the first 12 hex characters are the 48-bit millisecond timestamp, so the first EIGHT are
 * its top 32 bits and change only once every 2^16 ms — about 65 seconds. Measured, not reasoned:
 * 1000 ids minted in a burst produced ONE distinct 8-character prefix. Every component created in
 * the same minute therefore shared a prefix, so two components each declaring a `canary` probe —
 * the ordinary shape of one IaC apply — got the SAME schedule id. One overwrote the other's cadence
 * and target, and a retraction of either removed both.
 *
 * A 48-bit hash of the FULL identity replaces the prefix, keeping the readable hook segment so an
 * operator looking at a cron in Argo can still tell what it is. The component id is fixed-length, so
 * concatenation needs no delimiter to be unambiguous; the `:` is for legibility only.
 *
 * ON UPGRADE, a schedule declared under the old id is re-declared under the new one and the old
 * cron is left behind, once. That is deliberate and is the smaller of two bad options — the
 * alternative is keeping a derivation under which two components silently share a probe — and it is
 * bounded: the retraction sweep this module feeds is what stops it ever happening again.
 */
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

/**
 * Records that a deleted `continuous` hook's schedule is owed a retraction.
 *
 * THE ID IS FROZEN HERE rather than re-derived at drain time. `probeScheduleId` is derived on
 * purpose, but the retraction has to name the id that was ACTUALLY declared: change that derivation
 * later and a re-deriving drain would retract an id the executor never heard of while the real cron
 * kept firing — silently, which is the exact failure the queue exists to end.
 *
 * `ON CONFLICT DO NOTHING` on the identity index: a hook deleted, re-created and deleted again
 * while the first retraction is still pending is the SAME work, because the id derives from the
 * same two inputs.
 */
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
