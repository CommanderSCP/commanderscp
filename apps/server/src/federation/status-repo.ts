import type { FederationStatusResponse } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { listPeers } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { listRecentTransfers } from "./bundle-transfers-repo.js";
import { federationClientCertsUsable, peerSyncCadence } from "./federation-sync.js";

/**
 * `GET /federation/status` — the commander cross-domain status view (DESIGN.md §13): every known
 * peer, this side's own sync freshness against it, and bundle-transfer history. Bounded per §13:
 * for an air-gapped peer this is explicitly "as of" the last confirmed transfer, never presented
 * as live — the CLI/UI layer is responsible for rendering `lastSyncedAt` with that framing rather
 * than this endpoint claiming a false real-time guarantee.
 */
export async function getFederationStatus(
  tx: TenantTx,
  orgId: string,
  cosignPublicKey: string | null = null
): Promise<FederationStatusResponse> {
  const selfRow = await ensureFederationSelf(tx, orgId);
  const key = await ensureInstanceKey(tx, orgId);
  const peers = await listPeers(tx, orgId);
  // D4 is a RUNTIME property of this instance, so the reported cadence must consult it here rather
  // than assume the pair-time check still holds. It uses the SCHEDULER'S OWN never-throwing probe —
  // not the cheap presence check — because the presence check answers "are the paths set?" while the
  // scheduler asks "did the material actually READ?". Those diverge in exactly the case D4 exists
  // for (paths set, secret rotated away), and this endpoint's whole job is to make cadence
  // divergence VISIBLE, so it must not be the thing that hides it.
  const hasClientCerts = federationClientCertsUsable();

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
        // M14.4 (S7, ADR-0009) — the live-pull FRESHNESS + the cadence actually in force. These are
        // what an operator needs to answer "is this peer sparse, and is that intentional?":
        //   * lastPullAttemptAt / lastPullSuccessAt — an attempt WITHOUT a later success is a peer in
        //     the reconnect leg (it is back on the frequent cadence until one pull succeeds);
        //   * lastPokeReceivedAt — `null` on a pokeMode peer is the UNILATERAL-SPARSE misconfiguration
        //     (this side opted in, the other side never pokes). D2 keeps it polling, and this field is
        //     how you SEE that;
        //   * effectiveCadence — the cadence the scheduler would use RIGHT NOW, not the raw flag. It
        //     reports "poll" for a pokeMode peer that has never been poked (D2), when this instance has
        //     no outbound client-cert material (D4), and while the peer's last pull failed. The raw
        //     flag stays visible as `peer.pokeMode`, so a divergence between the two is legible.
        lastPullAttemptAt: peer.lastPullAttemptAt,
        lastPullSuccessAt: peer.lastPullSuccessAt,
        lastPokeReceivedAt: peer.lastPokeReceivedAt,
        effectiveCadence: peerSyncCadence(peer, { hasClientCerts }),
        recentTransfers: transfers
      };
    })
  );

  return {
    self: {
      domainId: selfRow.domainId,
      name: selfRow.name,
      role: selfRow.role,
      publicKey: key.publicKey,
      // M17.3 (E5) — the LOCAL cosign verification public key an operator copies into a peer's
      // `scp federation pair`. Resolved by the CALLER (route handler / test) via
      // `getInstanceCosignPublicKey`, which provisions the keypair lazily OUTSIDE any open tx (the
      // cosign generator is a subprocess and must never run while this status tx holds a connection).
      cosignPublicKey
    },
    peers: peerStatuses
  };
}
