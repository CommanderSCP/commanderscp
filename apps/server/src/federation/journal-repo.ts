import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { JournalEntryKind, SyncJournalEntry } from "@scp/schemas";
import {
  JOURNAL_GENESIS_HASH,
  computeJournalRowHash,
  signJournalRowHash
} from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { syncJournal } from "../db/schema.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";

/** The append-only Sync Journal writer. See docs/federation.md §292. */

export async function appendJournalEntry(
  tx: TenantTx,
  input: {
    orgId: string;
    entryKind: JournalEntryKind;
    payload: Record<string, unknown>;
    contentHash: string;
  }
): Promise<SyncJournalEntry> {
  const self = await ensureFederationSelf(tx, input.orgId);
  const key = await ensureInstanceKey(tx, input.orgId);

  // Serializes journal appends per (org, origin domain) — held until COMMIT/ROLLBACK, same
  // discipline as audit-repo.ts's `pg_advisory_xact_lock`, so concurrent writers can never observe
  // a stale tail and fork the chain.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${input.orgId + ":" + self.domainId}))`
  );

  const tail = await tx
    .select({ rowHash: syncJournal.rowHash, sequence: syncJournal.sequence })
    .from(syncJournal)
    .where(and(eq(syncJournal.orgId, input.orgId), eq(syncJournal.originDomainId, self.domainId)))
    .orderBy(desc(syncJournal.sequence))
    .limit(1);
  const prevHash = tail[0]?.rowHash ?? JOURNAL_GENESIS_HASH;
  const sequence = (tail[0]?.sequence ?? 0) + 1;

  const id = uuidv7();
  const draft = {
    id,
    orgId: input.orgId,
    originDomainId: self.domainId,
    sequence,
    entryKind: input.entryKind,
    payload: input.payload,
    contentHash: input.contentHash,
    baseRevision: null as number | null,
    conflict: null as string | null,
    prevHash
  };
  const rowHash = computeJournalRowHash(draft);
  const signature = signJournalRowHash(key.privateKey, rowHash);

  await tx.insert(syncJournal).values({ ...draft, rowHash, signature });

  return { ...draft, rowHash, signature, createdAt: new Date().toISOString() };
}

function toEntry(row: typeof syncJournal.$inferSelect): SyncJournalEntry {
  return {
    id: row.id,
    orgId: row.orgId,
    originDomainId: row.originDomainId,
    sequence: row.sequence,
    entryKind: row.entryKind as JournalEntryKind,
    payload: row.payload as Record<string, unknown>,
    contentHash: row.contentHash,
    baseRevision: row.baseRevision,
    conflict: row.conflict,
    prevHash: row.prevHash,
    rowHash: row.rowHash,
    signature: row.signature,
    createdAt: row.createdAt.toISOString()
  };
}

/** This domain's own journal entries after `sinceSequence` (exclusive), in chain order — what
 *  `scp federation export` reads for the ORIGINATING side of a sync bundle. */
export async function listOwnJournalEntriesSince(
  tx: TenantTx,
  orgId: string,
  sinceSequence: number,
  limit = 5000
): Promise<SyncJournalEntry[]> {
  const self = await ensureFederationSelf(tx, orgId);
  const rows = await tx
    .select()
    .from(syncJournal)
    .where(
      and(
        eq(syncJournal.orgId, orgId),
        eq(syncJournal.originDomainId, self.domainId),
        gt(syncJournal.sequence, sinceSequence)
      )
    )
    .orderBy(asc(syncJournal.sequence))
    .limit(limit);
  return rows.map(toEntry);
}

/** The current tail sequence + rowHash for THIS domain's own journal (genesis if empty) — what a
 *  fresh export's header/continuation math is built from. */
export async function ownJournalTail(
  tx: TenantTx,
  orgId: string
): Promise<{ sequence: number; rowHash: string }> {
  const self = await ensureFederationSelf(tx, orgId);
  const rows = await tx
    .select({ rowHash: syncJournal.rowHash, sequence: syncJournal.sequence })
    .from(syncJournal)
    .where(and(eq(syncJournal.orgId, orgId), eq(syncJournal.originDomainId, self.domainId)))
    .orderBy(desc(syncJournal.sequence))
    .limit(1);
  return { sequence: rows[0]?.sequence ?? 0, rowHash: rows[0]?.rowHash ?? JOURNAL_GENESIS_HASH };
}

/** The row hash of this domain's own entry at one sequence. See docs/federation.md §293. */
export async function ownJournalEntryAtSequence(
  tx: TenantTx,
  orgId: string,
  sequence: number
): Promise<{ rowHash: string } | null> {
  const self = await ensureFederationSelf(tx, orgId);
  const rows = await tx
    .select({ rowHash: syncJournal.rowHash })
    .from(syncJournal)
    .where(
      and(
        eq(syncJournal.orgId, orgId),
        eq(syncJournal.originDomainId, self.domainId),
        eq(syncJournal.sequence, sequence)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

// NOTE: entries RECEIVED from a peer. See docs/federation.md §294.
