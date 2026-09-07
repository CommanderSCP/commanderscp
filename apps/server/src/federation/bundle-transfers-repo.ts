import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { BundleTransfer, TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { bundleTransfers } from "../db/schema.js";

/** Bundle-transfer tracking (DESIGN.md §13). See docs/federation.md §55. */

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

/** When a bundle from this peer was last confirmed imported. See docs/federation.md §56. */
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

/** Every ledger row whose bundle checksum is one of these. See docs/federation.md §57. */
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

/** The pending-export high-water mark for one peer. See docs/federation.md §58. */
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
