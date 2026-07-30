import type { FederationStatusResponse, OutpostTrustTier } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { listPeers, type FederationPeerRow } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { lastSyncExportForPeer, listRecentTransfers } from "./bundle-transfers-repo.js";
import { ownJournalTail } from "./journal-repo.js";
import { listOutpostConfigs } from "./outposts-repo.js";
import { federationPeerRequiresMtls } from "./federation-outbound.js";
import { federationClientCertsUsable, peerSyncCadence } from "./federation-sync.js";

/**
 * `GET /federation/status` — the commander cross-domain status view (DESIGN.md §13): every known
 * peer, this side's own sync freshness against it, and bundle-transfer history. Bounded per §13:
 * for an air-gapped peer this is explicitly "as of" the last confirmed transfer, never presented
 * as live — the CLI/UI layer is responsible for rendering `lastSyncedAt` with that framing rather
 * than this endpoint claiming a false real-time guarantee.
 *
 * M16.2 phase A (E3) widens it with the fields the Outposts Overview needs, under one rule: EVERY
 * FIELD IS NAMED FOR WHAT IT MEASURES, AND ANYTHING WITHOUT A SOURCE IS ABSENT AND DECLARED UNKNOWN
 * (`unknownFields`, the contract `ServiceBoardRowSchema` established). See `deriveConnectivity` and
 * `lastSyncExportForPeer` for the two derivations, and note what is NOT here: there is no
 * "applied at the peer" field, because nothing in this instance's database can observe that.
 */

/**
 * DERIVED reachability — a fact about TRANSPORT, kept strictly out of `trustTier` (owner decision:
 * one field meaning both trust posture and reachability would mean neither).
 *
 *  - `"connected"` — the peer has an https/mTLS-capable base URL this side can dial. Uses the SAME
 *    predicate the sender and the M14.1 pair-time guard use (`federationPeerRequiresMtls`), so the
 *    label can never disagree with what the transport actually does.
 *  - `"air-gap"` — no dialable base URL, but a configured `deliveryTarget`: a file/object channel an
 *    operator (or a CDS) carries. That IS the air-gapped topology.
 *  - `null` — neither. NOT "air-gapped": a peer with no base URL and no delivery target has no
 *    transport configured at all, which is a misconfiguration, not a posture. Declared unknown.
 *
 * A plain-http base URL is deliberately not `"connected"`: federation refuses to dial it with the
 * bearer, so calling it connected would describe a link that cannot carry a sync.
 */
function deriveConnectivity(peer: FederationPeerRow): "connected" | "air-gap" | null {
  if (federationPeerRequiresMtls(peer.baseUrl)) return "connected";
  if (peer.deliveryTarget !== null) return "air-gap";
  return null;
}

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
  // E3: the denominator every pending-export figure is read against — this domain's own journal tail.
  const tail = await ownJournalTail(tx, orgId);
  // E3: `trustTier` lives on the peer's `outpost` GRAPH OBJECT, never on the peer row (the authority
  // split — `outpost-binding.ts`). Resolved through the `peerDomainId` binding; a peer with no object,
  // or an object whose operator never asserted a tier, yields NO tier and is declared unknown.
  const outpostConfigs = await listOutpostConfigs(tx, orgId);
  const trustTierByPeer = new Map<string, OutpostTrustTier>();
  for (const config of outpostConfigs) {
    if (config.trustTier !== null) trustTierByPeer.set(config.peerDomainId, config.trustTier);
  }

  const peerStatuses = await Promise.all(
    peers.map(async (peer) => {
      // A peer's OWN journal is authored under its OWN domain id — `getCursor(peerId, originId)`
      // with `originId === peer.id` is "how caught up am I on this peer's own history."
      const cursor = await getCursor(tx, orgId, peer.id, peer.id);
      const transfers = await listRecentTransfers(tx, orgId, peer.id, 5);
      const lastConfirmed = transfers.find((t) => t.status === "confirmed");
      const lastExport = await lastSyncExportForPeer(tx, orgId, peer.id);
      const trustTier = trustTierByPeer.get(peer.id) ?? null;
      const connectivity = deriveConnectivity(peer);
      // The "as of ⟨bundle⟩" identifier for the INBOUND side, read off the SAME ledger row
      // `lastSyncedAt` comes from so the timestamp and the bundle name can never disagree.
      const lastSyncedBundleChecksum = lastConfirmed?.checksum ?? null;
      const pendingExportEntryCount =
        lastExport === null ? null : Math.max(0, tail.sequence - lastExport.throughSequence);

      // The honest-unknown declaration. Each name is here because the value below it is a null that a
      // reader would otherwise mistake for an observation.
      const unknownFields: string[] = [];
      // No operator has asserted a tier (or there is no `outpost` object for this peer at all).
      // `trustTier` has no other source in this codebase — it is entered, never derived.
      if (trustTier === null) unknownFields.push("trustTier");
      // No transport configured at all: not observable as connected OR air-gapped.
      if (connectivity === null) unknownFields.push("connectivity");
      // A confirmed import exists but predates checksum recording (or none exists) — either way there
      // is no bundle to name, so an "as of ⟨bundle⟩" label has nothing to render.
      if (lastSyncedBundleChecksum === null) unknownFields.push("lastSyncedBundleChecksum");
      if (lastExport === null) {
        // Never exported to this peer: the whole pending-export family is un-derivable. Listing the
        // count here is what stops `null` from being read as "nothing pending".
        unknownFields.push("lastExportedThroughSequence");
        unknownFields.push("lastExportedBundleChecksum");
        unknownFields.push("pendingExportEntryCount");
      } else if (lastExport.checksum === null) {
        unknownFields.push("lastExportedBundleChecksum");
      }
      // PROMISED-BUT-SOURCELESS. The M16.2 Overview asks for a per-outpost "health rollup" (from
      // observe-enrichment) and for pending-vs-APPLIED. Neither has any source in this instance's
      // database: no health signal is replicated per peer, and `sync_cursors`/`bundle_transfers`
      // cannot observe what a peer applied (see `lastSyncExportForPeer`). Rather than invent fields,
      // they are ABSENT from the schema and named here, so phase B's UI renders an explicit unknown
      // instead of reading a missing field as healthy/zero.
      unknownFields.push("healthRollup");
      unknownFields.push("appliedAtPeer");

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
        //     no outbound client-cert material (D4), and while the peer's last pull failed.
        lastPullAttemptAt: peer.lastPullAttemptAt,
        lastPullSuccessAt: peer.lastPullSuccessAt,
        lastPokeReceivedAt: peer.lastPokeReceivedAt,
        effectiveCadence: peerSyncCadence(peer, { hasClientCerts }),
        // M16.2 phase A (E3) — pending-EXPORT, never pending-apply.
        lastExportedThroughSequence: lastExport?.throughSequence ?? null,
        lastExportedAt: lastExport?.createdAt.toISOString() ?? null,
        lastExportedBundleChecksum: lastExport?.checksum ?? null,
        lastSyncedBundleChecksum,
        pendingExportEntryCount,
        trustTier,
        connectivity,
        unknownFields,
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
    ownJournalTail: tail.sequence,
    peers: peerStatuses
  };
}
