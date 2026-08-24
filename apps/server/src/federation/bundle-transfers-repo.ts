import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { BundleTransfer, TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { bundleTransfers } from "../db/schema.js";

/**
 * Bundle-transfer tracking (DESIGN.md §13). Purely observational bookkeeping — never consulted for
 * authority/idempotency decisions (the journal's own sequence/hash chain is what makes replication
 * safe); this just gives the commander UI/CLI something to show for an air-gapped peer's
 * outstanding handoffs.
 *
 * PER-HOP AND INSERT-ONLY (doc corrected 2026-07-29, M16.1). This is NOT a lifecycle: no production
 * path updates a row — this module exposes no update, and the only `update(bundleTransfers)` in the
 * tree is a test fixture backdating `confirmed_at`
 * (`coordination/service-board-staleness.integration.test.ts`). One row per `.scpbundle` an instance
 * produced or consumed, in THAT instance's own database:
 *   `created`   — the EXPORTER, on producing a bundle (export-repo, exportPromotionBundle).
 *   `submitted` — a RETRANS only, for its onward drop (retrans-relay).
 *   `confirmed` — the RECEIVER, on a successful import (import-repo, applyPromotionImport,
 *                 retrans-relay's inbound hop).
 * CONSEQUENCE: in the commander's own database an export can only ever read `created`, so the
 * commander may say "exported" and MUST declare the handoff unknown — see
 * `coordination/boundary-segment.ts`. The DESIGN §13 aspiration ("confirmed when a returned bundle
 * carries the outpost's import cursor") is UNBUILT and named there as future increment M16.4.
 */

function toBundleTransfer(row: typeof bundleTransfers.$inferSelect): BundleTransfer {
  return {
    id: row.id,
    peerDomainId: row.peerDomainId,
    direction: row.direction as "export" | "import",
    kind: row.kind as "sync" | "promotion",
    status: row.status as "created" | "submitted" | "confirmed",
    sinceSequence: row.sinceSequence,
    throughSequence: row.throughSequence,
    // M16.1 (I1): the per-change join handle (see `boundary-bundle-ref.ts`). Additive on the wire.
    checksum: row.checksum,
    // drizzle/0087 — which leg this hop was ('metadata' | 'bytes'); NULL = not recorded. See the
    // migration header and `recordBundleTransfer`'s doc comment.
    channel: row.channel === "metadata" || row.channel === "bytes" ? row.channel : null,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null
  };
}

/** HOW a bundle travelled — recorded at import time because that is the only moment it is known.
 *  See drizzle/0041's header for why no pair of stored timestamps can reconstruct it. */
export type BundleTransport = "live-pull" | "bundle";

/** WHICH LEG a hop was (drizzle/0087) — 'metadata' for an ordinary `.scpbundle` sync/promotion
 *  export or import, 'bytes' for a retrans byte-relay hop (`buildRelayTarball`'s submit,
 *  `validateAndForwardRelayTarball`'s confirm+submit, `importRelayTarball`'s confirm). `null` is a
 *  DELIBERATE, explicit "genuinely cannot determine" — never a stand-in for "not asked". */
export type BundleChannel = "metadata" | "bytes";

export async function recordBundleTransfer(
  tx: TenantTx,
  input: {
    orgId: string;
    /** TRUST sense (ADR-0021 D4). */
    peerDomainId: TrustDomainId;
    direction: "export" | "import";
    kind: "sync" | "promotion";
    status?: "created" | "submitted" | "confirmed";
    sinceSequence?: number | null;
    throughSequence?: number | null;
    checksum?: string | null;
    transport?: BundleTransport | null;
    /** REQUIRED (not optional) so no future writer can forget to declare it — pass `null` only when
     *  this call site is genuinely unable to know which leg it is recording (drizzle/0087). */
    channel: BundleChannel | null;
  }
): Promise<BundleTransfer> {
  const [row] = await tx
    .insert(bundleTransfers)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      peerDomainId: input.peerDomainId,
      direction: input.direction,
      kind: input.kind,
      status: input.status ?? "created",
      sinceSequence: input.sinceSequence ?? null,
      throughSequence: input.throughSequence ?? null,
      checksum: input.checksum ?? null,
      transport: input.transport ?? null,
      channel: input.channel,
      confirmedAt: input.status === "confirmed" ? new Date() : null
    })
    .returning();
  if (!row) throw new Error("recordBundleTransfer: failed to insert");
  return toBundleTransfer(row);
}

/**
 * When a signed sync bundle from `peerDomainId` was last CONFIRMED as imported here — the one
 * transport-agnostic freshness anchor this instance has, and the basis of DESIGN §13's
 * "as of &lt;bundle/date&gt;" label.
 *
 * WHY THIS AND NOT `federation_peers.lastPullSuccessAt`. That column is stamped only by the
 * live-pull scheduler (`federation-sync.ts`), which iterates `role === "commander" && baseUrl` —
 * so on an AIR-GAPPED instance it is NULL forever, and a freshness label derived from it would
 * render "never synced" on an instance that imports bundles weekly. Every import path instead
 * funnels through `importSyncBundle` → `recordBundleTransfer(direction:'import', kind:'sync',
 * status:'confirmed')`: the live pull, `POST /v1/federation/imports` (a pushed bundle or
 * `scp federation import`), and the unattended air-gap inbox loop alike. `status:'confirmed'` is
 * only ever written on IMPORT rows (exports insert `'created'` and this module exposes no update),
 * so the predicate is unambiguous.
 *
 * The row also carries HOW it arrived (`transport`, drizzle/0041) — the honest source for the
 * label's live-pull-vs-bundle distinction, which nothing else can reconstruct after the fact. NULL
 * on pre-0041 rows and reported as such rather than guessed.
 *
 * Purely observational, exactly as this module's header says — it feeds a LABEL, never an
 * authority or idempotency decision.
 *
 * PERF: runs once per peer on every service-board render. drizzle/0041's partial index
 * `bundle_transfers_org_peer_confirmed` matches this predicate and INCLUDEs `transport`, so it is
 * an index-only seek no matter how deep the (never-pruned, by design) transfer history gets — but
 * only since drizzle/0070. 0041 built the index as bare `confirmed_at DESC`, which PostgreSQL reads
 * as NULLS FIRST, while this read asks for `DESC NULLS LAST`; those are different orderings, the
 * index was therefore INELIGIBLE, and every board render seq-scanned the whole ledger and sorted it
 * — the exact plan 0041's header says it exists to abolish. Measured at 20,000 rows: 364 buffers
 * and a top-N heapsort over every row, against 4 buffers for the seek. Do not "simplify" the
 * `NULLS LAST` away to match an index; the index is what moved.
 */
export function lastConfirmedSyncImportQuery(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
) {
  return (
    tx
      .select({
        confirmedAt: bundleTransfers.confirmedAt,
        transport: bundleTransfers.transport,
        // Returned so `GET /federation/status`'s "as of ⟨bundle⟩" label names the bundle from the SAME row
        // this timestamp came from. It previously picked its own row with a much looser predicate (review
        // round 4, H3) and could name a PROMOTION bundle for a peer no sync bundle had arrived from.
        checksum: bundleTransfers.checksum
      })
      .from(bundleTransfers)
      .where(
        and(
          eq(bundleTransfers.orgId, orgId),
          eq(bundleTransfers.peerDomainId, peerDomainId),
          eq(bundleTransfers.direction, "import"),
          eq(bundleTransfers.kind, "sync"),
          eq(bundleTransfers.status, "confirmed")
        )
      )
      // `NULLS LAST` is load-bearing here for exactly the reason it is in `lastSyncExportForPeer`
      // (H9a), and this helper is the one H3 has since made TWO MORE fields depend on. Postgres `DESC`
      // is NULLS FIRST, so a single confirmed import/sync row with a NULL `confirmed_at` sorted ahead
      // of every genuinely-stamped one and the `!row?.confirmedAt` bail below reported BOTH
      // `lastSyncedAt` AND `lastSyncedBundleChecksum` as null — the commander saying "never synced" and
      // "bundle unknown" over a real, correctly-stamped sync import. `recordBundleTransfer` cannot
      // write that row today, which is precisely the reachability argument this PR used to justify
      // disarming the identical trap two files away (review round 5, N8).
      //
      // It is ALSO what drizzle/0070's index must be declared with, or the index cannot serve this
      // read at all. Split out as a BUILDER so `bundle-transfer-read-plan.integration.test.ts` can
      // `EXPLAIN` this exact query rather than a re-typed copy — a copy would keep passing while the
      // real one drifted off the index, which is precisely how 0041 shipped unused.
      .orderBy(sql`${bundleTransfers.confirmedAt} DESC NULLS LAST`)
      .limit(1)
  );
}

export async function lastConfirmedSyncImportAt(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<{ at: Date; transport: BundleTransport | null; checksum: string | null } | null> {
  const rows = await lastConfirmedSyncImportQuery(tx, orgId, peerDomainId);
  const row = rows[0];
  if (!row?.confirmedAt) return null;
  return {
    at: row.confirmedAt,
    transport: row.transport === "live-pull" || row.transport === "bundle" ? row.transport : null,
    checksum: row.checksum
  };
}

/**
 * M16.1 (I1) — every ledger row whose bundle checksum is one of `checksums`: the PER-CHANGE cut of
 * this per-hop ledger, reached through the stamp `federation/boundary-bundle-ref.ts` writes onto a
 * change's `sourceRef`. Ordered oldest-first so a caller reads the hops in the order they happened.
 * An empty input (a change that never crossed a boundary) short-circuits to `[]` without a query.
 */
export async function listTransfersByChecksums(
  tx: TenantTx,
  orgId: string,
  checksums: string[]
): Promise<BundleTransfer[]> {
  if (checksums.length === 0) return [];
  const rows = await tx
    .select()
    .from(bundleTransfers)
    .where(and(eq(bundleTransfers.orgId, orgId), inArray(bundleTransfers.checksum, checksums)))
    .orderBy(asc(bundleTransfers.createdAt));
  return rows.map(toBundleTransfer);
}

/**
 * M16.2 phase A (E3) — THE PENDING-EXPORT HIGH-WATER MARK for one peer: the highest
 * `through_sequence` over the SYNC EXPORT rows this instance has written for it, plus the identity of
 * that bundle (its Ed25519 `checksum`) and when it was produced here.
 *
 * This is the strongest statement a commander can honestly make about a peer's sync progress, and it
 * is deliberately ONE-SIDED. `sync_cursors` records only what WE applied FROM a peer; `export-repo.ts`
 * ships only this domain's own entries, so a return bundle cannot carry our sequences back; and this
 * ledger has no production UPDATE path, so an export row is inserted `created` and never advances.
 * Nothing here means "the peer applied it" — only "we put it on the wire". A field named for
 * application at the peer would be fabrication; that is future increment M16.4's work.
 *
 * `null` when this instance has never exported a sync bundle to the peer — never `0`, which a reader
 * would take for "synced through the beginning". Ordered by `through_sequence DESC` rather than
 * `created_at` because a later resume-from-cursor export can legitimately cover a lower range, and the
 * question asked here is "how far have we ever exported?".
 */
export async function lastSyncExportForPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<{ throughSequence: number; checksum: string | null; createdAt: Date } | null> {
  const rows = await tx
    .select({
      throughSequence: bundleTransfers.throughSequence,
      checksum: bundleTransfers.checksum,
      createdAt: bundleTransfers.createdAt
    })
    .from(bundleTransfers)
    .where(
      and(
        eq(bundleTransfers.orgId, orgId),
        eq(bundleTransfers.peerDomainId, peerDomainId),
        eq(bundleTransfers.direction, "export"),
        eq(bundleTransfers.kind, "sync")
      )
    )
    // `NULLS LAST` is load-bearing, not decoration: Postgres `DESC` is NULLS FIRST, so a single sync-export
    // row with a NULL `through_sequence` would sort ahead of every real one and the `row.throughSequence
    // === null` bail below would report "never exported" FOREVER despite real exports. `export-repo.ts`
    // always sets the column today, so this is a trap being disarmed rather than a bug being fixed —
    // which is exactly when it is cheap to disarm (review round 4, H9a).
    .orderBy(sql`${bundleTransfers.throughSequence} DESC NULLS LAST`)
    .limit(1);
  const row = rows[0];
  if (!row || row.throughSequence === null) return null;
  return { throughSequence: row.throughSequence, checksum: row.checksum, createdAt: row.createdAt };
}

export async function listRecentTransfers(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  limit = 10
): Promise<BundleTransfer[]> {
  const rows = await tx
    .select()
    .from(bundleTransfers)
    .where(and(eq(bundleTransfers.orgId, orgId), eq(bundleTransfers.peerDomainId, peerDomainId)))
    .orderBy(desc(bundleTransfers.createdAt))
    .limit(limit);
  return rows.map(toBundleTransfer);
}
