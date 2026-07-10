import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { JournalEntryKind, SyncJournalEntry } from "@scp/schemas";
import { JOURNAL_GENESIS_HASH, computeJournalRowHash, signJournalRowHash } from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { syncJournal } from "../db/schema.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";

/**
 * The append-only Sync Journal writer (DESIGN.md §13 core; BUILD_AND_TEST.md §7: `federation/
 * journal` is one of the modules held to ≥95% branch coverage). Mirrors `audit/audit-repo.ts`'s
 * `appendAuditEvent` shape exactly — advisory-lock-then-read-tail-then-append — but keyed by
 * `(orgId, originDomainId)` rather than `orgId` alone, since DESIGN §13 stamps the journal
 * `(origin_domain, sequence, content_hash)` and the chain/sequence are PER ORIGIN DOMAIN, not
 * merely per org (in this codebase's single-domain-per-org scoping, these coincide in practice,
 * but the locking/tail-read below is written to the general case regardless).
 *
 * IMPLEMENTATION NOTE (documented in the M6 PR body as a deliberate deviation): DESIGN §13 calls
 * the journal "outbox-derived". This writer is invoked directly from the SAME call sites that
 * already write the outbox row and the audit event (graph/objects-repo.ts,
 * graph/relationships-repo.ts, coordination/changes-repo.ts, coordination/transition.ts,
 * governance/approvals-repo.ts, audit/audit-repo.ts) — in the SAME transaction — rather than by an
 * async relay reading already-committed outbox rows back out after the fact. This preserves the
 * "one change-capture mechanism, multiple consumers" intent (audit, outbox/SSE, and the journal
 * all originate from the identical mutation call sites) while keeping journal writes strictly
 * transactional with the mutation itself (no risk of the journal diverging from the outbox if a
 * relay process crashes between reading a row and appending its journal entry) and avoiding a
 * second cross-role read of a just-committed row inside the outbox relay's narrowly-scoped
 * `scp_relay` transaction (events/outbox-relay.ts), which today can SELECT/UPDATE `outbox` only.
 */

export async function appendJournalEntry(
  tx: TenantTx,
  input: { orgId: string; entryKind: JournalEntryKind; payload: Record<string, unknown>; contentHash: string }
): Promise<SyncJournalEntry> {
  const self = await ensureFederationSelf(tx, input.orgId);
  const key = await ensureInstanceKey(tx);

  // Serializes journal appends per (org, origin domain) — held until COMMIT/ROLLBACK, same
  // discipline as audit-repo.ts's `pg_advisory_xact_lock`, so concurrent writers can never observe
  // a stale tail and fork the chain.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.orgId + ":" + self.domainId}))`);

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

// NOTE: entries RECEIVED from a peer (as opposed to authored locally) are never inserted into
// this domain's own `sync_journal` table — imports apply through the idempotent public write path
// (graph/objects-repo.ts et al.), and provenance is tracked via `sync_cursors` (cursors-repo.ts)
// alone. There is intentionally no "foreign journal mirror" table: re-verifying a peer's full
// history means re-exporting from that peer, exactly as any other convergent-replication system
// would — `sync_journal` always means "entries this domain itself authored and signed."
