import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { TrustDomainId } from "@scp/schemas";
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
  /** The ONE-SHOT operator re-anchor permit (drizzle/0042), or `null` for "no permit". Meaningful
   *  only when it EQUALS {@link sequence}: the permit is issued for one exact cursor position, so a
   *  cursor that has moved since has already outrun it. See {@link permitCursorReanchor}. */
  reanchorFromSeq: number | null;
}

export async function getCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  originDomainId: TrustDomainId
): Promise<SyncCursor> {
  const rows = await tx
    .select({
      lastAppliedSeq: syncCursors.lastAppliedSeq,
      lastAppliedRowHash: syncCursors.lastAppliedRowHash,
      reanchorFromSeq: syncCursors.reanchorFromSeq
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
  return {
    sequence: rows[0]?.lastAppliedSeq ?? 0,
    rowHash: rows[0]?.lastAppliedRowHash ?? null,
    reanchorFromSeq: rows[0]?.reanchorFromSeq ?? null
  };
}

/**
 * ISSUE THE ONE-SHOT RE-ANCHOR PERMIT for every cursor of `peerDomainId` that currently holds NO
 * anchor (drizzle/0042). SECURITY-SENSITIVE — read that migration's header before changing this.
 *
 * CALLED FROM EXACTLY ONE PLACE: `pairPeer`, when the LOCAL operator widens this peer's own
 * `sync_scope` to `full`. That is a local, authenticated (`federation:write`) action on config that
 * is never carried on the wire, so no peer can induce it; nothing in an import, relay, inbox, poke
 * or pull path may ever call this.
 *
 * The predicate is the whole safety story. Only a cursor with `last_applied_row_hash IS NULL AND
 * last_applied_seq > 0` — an anchorless cursor left behind by this side's OWN narrow-scope
 * verification — is permitted, and the permit records the EXACT sequence it was issued for, so it
 * can never apply to a position the cursor has since moved to. A cursor that already holds a real
 * anchor is untouched: there is nothing to re-anchor, and weakening it would be a real loss.
 * `last_applied_seq` itself is deliberately NOT rewound (it is the key-rotation anchor —
 * {@link maxAppliedSequenceForPeer}).
 */
export async function permitCursorReanchor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<number> {
  const updated = await tx
    .update(syncCursors)
    .set({ reanchorFromSeq: sql`${syncCursors.lastAppliedSeq}`, updatedAt: new Date() })
    .where(
      and(
        eq(syncCursors.orgId, orgId),
        eq(syncCursors.peerDomainId, peerDomainId),
        isNull(syncCursors.lastAppliedRowHash),
        gt(syncCursors.lastAppliedSeq, 0)
      )
    )
    .returning({ peerDomainId: syncCursors.peerDomainId });
  return updated.length;
}

/** The highest origin sequence THIS domain has verifiably applied from `peerDomainId`, across all
 *  origin domains that peer has relayed (in practice one — a direct peer's own domain). Used as the
 *  key-rotation ANCHOR (peers-repo.ts): when a peer's key rotates, the old key is declared valid
 *  only through this sequence, and the new key from here on — the authenticated compromise-recovery
 *  boundary. `0` when nothing has ever been applied from the peer. */
export async function maxAppliedSequenceForPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<number> {
  const rows = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${syncCursors.lastAppliedSeq}), 0)` })
    .from(syncCursors)
    .where(and(eq(syncCursors.orgId, orgId), eq(syncCursors.peerDomainId, peerDomainId)));
  return Number(rows[0]?.maxSeq ?? 0);
}

/** Advances the cursor to `sequence`/`rowHash`, but ONLY forward — never regresses it, so an
 *  out-of-order or duplicate apply can never rewind progress already recorded (belt-and-braces on
 *  top of the entry-level idempotent-replay check the import path itself performs).
 *
 *  ALSO CONSUMES the one-shot re-anchor permit (drizzle/0042): any real advance clears it, so a
 *  permit covers exactly one accepted run and is re-issued only by another operator widen. Clearing
 *  it unconditionally (rather than only when `rowHash` is non-null) is what makes "one-shot" true in
 *  both directions — a receiver that is narrowed AGAIN before the permit is used advances with a
 *  null hash and must be re-permitted by a fresh widen at the NEW position. */
export async function advanceCursor(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  originDomainId: TrustDomainId,
  sequence: number,
  rowHash: string | null
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
      .set({
        lastAppliedSeq: sequence,
        lastAppliedRowHash: rowHash,
        reanchorFromSeq: null,
        updatedAt: new Date()
      })
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
