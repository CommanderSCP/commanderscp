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
 * Purely observational, exactly as this module's header says — it feeds a LABEL, never an
 * authority or idempotency decision.
 */
export async function lastConfirmedSyncImportAt(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<Date | null> {
  const rows = await tx
    .select({ confirmedAt: bundleTransfers.confirmedAt })
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
  return rows[0]?.confirmedAt ?? null;
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
