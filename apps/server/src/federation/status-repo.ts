import type { FederationStatusResponse } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { listPeers } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { listRecentTransfers } from "./bundle-transfers-repo.js";

/**
 * `GET /federation/status` — the commander cross-domain status view (DESIGN.md §13): every known
 * peer, this side's own sync freshness against it, and bundle-transfer history. Bounded per §13:
 * for an air-gapped peer this is explicitly "as of" the last confirmed transfer, never presented
 * as live — the CLI/UI layer is responsible for rendering `lastSyncedAt` with that framing rather
 * than this endpoint claiming a false real-time guarantee.
 */
export async function getFederationStatus(
  tx: TenantTx,
  orgId: string
): Promise<FederationStatusResponse> {
  const selfRow = await ensureFederationSelf(tx, orgId);
  const key = await ensureInstanceKey(tx, orgId);
  const peers = await listPeers(tx, orgId);

  const peerStatuses = await Promise.all(
    peers.map(async (peer) => {
      // A peer's OWN journal is authored under its OWN domain id — `getCursor(peerId, originId)`
      // with `originId === peer.id` is "how caught up am I on this peer's own history."
      const cursor = await getCursor(tx, orgId, peer.id, peer.id);
      const transfers = await listRecentTransfers(tx, orgId, peer.id, 5);
      const lastConfirmed = transfers.find((t) => t.status === "confirmed");
      return {
        peer,
        lastAppliedSequence: cursor.sequence > 0 ? cursor.sequence : null,
        lastSyncedAt: lastConfirmed?.confirmedAt ?? null,
        recentTransfers: transfers
      };
    })
  );

  return {
    self: {
      domainId: selfRow.domainId,
      name: selfRow.name,
      role: selfRow.role,
      publicKey: key.publicKey
    },
    peers: peerStatuses
  };
}
