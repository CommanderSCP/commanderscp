import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { syncCursors } from "../db/schema.js";

/**
 * Per-peer resumable sync cursors (DESIGN.md §13: "per-domain monotonic sequence cursors make
 * replication idempotent and resumable"). One row per (peer domain, origin domain) this side has
 * ever applied entries from — tracks the last sequence number AND the last applied entry's
 * `rowHash` durably committed, so an interrupted transfer resumes from here, re-applying an
 * already-seen sequence is a no-op, and a RESUMED import can verify true hash-chain continuity
 * against what was actually applied last time (not just internal contiguity within one bundle —
 * see `import-repo.ts`'s doc comment, SECURITY-SENSITIVE).
 */

export interface SyncCursor {
  sequence: number;
  rowHash: string | null;
}

export async function getCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string,
  originDomainId: string
): Promise<SyncCursor> {
  const rows = await tx
    .select({
      lastAppliedSeq: syncCursors.lastAppliedSeq,
      lastAppliedRowHash: syncCursors.lastAppliedRowHash
    })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        eq(syncCursors.originDomainId, originDomainId)
      )
    )
    .limit(1);
  return { sequence: rows[0]?.lastAppliedSeq ?? 0, rowHash: rows[0]?.lastAppliedRowHash ?? null };
}

/** Advances the cursor to `sequence`/`rowHash`, but ONLY forward — never regresses it, so an
 *  out-of-order or duplicate apply can never rewind progress already recorded (belt-and-braces on
 *  top of the entry-level idempotent-replay check the import path itself performs). */
export async function advanceCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string,
  originDomainId: string,
  sequence: number,
  rowHash: string
): Promise<void> {
  const current = await getCursor(tx, orgId, peerDomainId, originDomainId);
  if (sequence <= current.sequence) return;

  const existing = await tx
    .select({ orgId: syncCursors.orgId })
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        eq(syncCursors.originDomainId, originDomainId)
      )
    )
    .limit(1);

  if (existing[0]) {
    await tx
      .update(syncCursors)
      .set({ lastAppliedSeq: sequence, lastAppliedRowHash: rowHash, updatedAt: new Date() })
      .where(
        and(
          eq(syncCursors.orgId, orgId),
          eq(syncCursors.peerDomainId, peerDomainId),
          eq(syncCursors.originDomainId, originDomainId)
        )
      );
  } else {
    await tx
      .insert(syncCursors)
      .values({
        orgId,
        peerDomainId,
        originDomainId,
        lastAppliedSeq: sequence,
        lastAppliedRowHash: rowHash
      });
  }
}
