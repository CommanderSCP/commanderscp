import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { BundleTransfer, TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { bundleTransfers } from "../db/schema.js";

/**
 * Bundle-transfer tracking (DESIGN.md §13: "export created -> transfer submitted -> confirmed when
 * a returned bundle carries the outpost's import cursor"). Purely observational bookkeeping —
 * never consulted for authority/idempotency decisions (the journal's own sequence/hash chain is
 * what makes replication safe); this just gives the commander UI/CLI something to show for an
 * air-gapped peer's outstanding handoffs.
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
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null
  };
}

/** HOW a bundle travelled — recorded at import time because that is the only moment it is known.
 *  See drizzle/0041's header for why no pair of stored timestamps can reconstruct it. */
export type BundleTransport = "live-pull" | "bundle";

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
 * `bundle_transfers_org_peer_confirmed` matches this predicate and its `confirmed_at DESC` ordering
 * exactly, and INCLUDEs `transport`, so it is an index-only seek no matter how deep the
 * (never-pruned, by design) transfer history gets.
 */
export async function lastConfirmedSyncImportAt(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<{ at: Date; transport: BundleTransport | null } | null> {
  const rows = await tx
    .select({ confirmedAt: bundleTransfers.confirmedAt, transport: bundleTransfers.transport })
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
    .orderBy(desc(bundleTransfers.confirmedAt))
    .limit(1);
  const row = rows[0];
  if (!row?.confirmedAt) return null;
  return {
    at: row.confirmedAt,
    transport: row.transport === "live-pull" || row.transport === "bundle" ? row.transport : null
  };
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
