import type { FederationStatusResponse, OutpostTrustTier } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { listPeers, type FederationPeerRow } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import {
  lastConfirmedSyncImportAt,
  lastSyncExportForPeer,
  listRecentTransfers
} from "./bundle-transfers-repo.js";
import { ownJournalTail } from "./journal-repo.js";
import { findOutpostConfigByPeer, listOutpostConfigs } from "./outposts-repo.js";
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
 * THE CONFIGURED TRANSPORT CHANNEL — a fact about CONFIG, kept strictly out of `trustTier` (owner
 * decision: one field meaning both trust posture and reachability would mean neither) AND strictly out
 * of OBSERVATION (review round 4: the label used to say `"connected"`, which is a claim this instance
 * cannot derive from config at all).
 *
 *  - `"dialable"` — an https/mTLS-capable base URL is CONFIGURED, so this side MAY dial the peer. It
 *    does NOT say the peer has ever been reached: that is `lastPullAttemptAt`/`lastPullSuccessAt` and
 *    `effectiveCadence`, in the same row, which do reflect failure. Uses the SAME predicate the sender
 *    and the M14.1 pair-time guard use (`federationPeerRequiresMtls`), so the label can never disagree
 *    with what the transport would actually do.
 *  - `"air-gap"` — NO base URL at all, and a configured `deliveryTarget`: a file/object channel an
 *    operator (or a CDS) carries. That IS the air-gapped topology.
 *  - `null` — not honestly derivable, in TWO cases, both declared unknown:
 *      * no base URL and no delivery target — no transport configured at all, a misconfiguration
 *        rather than a posture (it is emphatically NOT "air-gapped");
 *      * a base URL federation REFUSES to dial (plain http). A peer with `http://` plus a
 *        deliveryTarget used to read `"air-gap"` — labelling a configured, non-air-gapped topology
 *        air-gapped because its URL was rejected. Two contradictory transport statements is a
 *        misconfiguration to surface, not a posture to infer.
 */
function deriveTransportMode(peer: FederationPeerRow): "dialable" | "air-gap" | null {
  if (federationPeerRequiresMtls(peer.baseUrl)) return "dialable";
  // A base URL is set but is not one federation will dial: refuse to reinterpret it as air-gap.
  if (peer.baseUrl !== null && peer.baseUrl.length > 0) return null;
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
  // AUTHORITY, NOT LAST-WRITE-WINS (review round 4). This used to be a plain `Map.set` loop over the
  // list, so with two rows bound to one peer the LAST one seen won — and a `provenance:'manual'` shadow
  // could silently OVERRIDE the commander's own asserted tier on the Overview, a hand-typed copy beating
  // the authority. The projection now carries `originIsSelf`/`provenance`, so the winner is chosen the
  // same way `findOutpostConfigByPeer` chooses one: local-origin first, then a verified replica, then an
  // unverified shadow — and the winner's provenance rides out on the row so phase B can tell them apart.
  //
  // RANK FIRST, THEN READ THE WINNER'S TIER (review round 5, N4). The loop used to `continue` on a
  // tier-less row BEFORE ranking, so the ranking only ever chose among rows that HAPPENED to carry a
  // value — and a commander's own local-origin object that deliberately asserts NO tier lost to a
  // hand-typed shadow that did. Measured: `/federation/status` reported `il5` / `unverified` for a
  // peer whose `GET /v1/federation/outposts/{peer}` answered `trustTier: null, originIsSelf: true`
  // at the same instant. ADR-0022 says the local-origin row WINS, full stop: A LOCAL-ORIGIN ROW'S
  // SILENCE MUST SILENCE THE FIELD. Choosing the winner first and reading its tier afterwards is
  // also exactly what `findOutpostConfigByPeer` does, which is why the two surfaces now agree by
  // construction rather than by coincidence (`outpost-handfill-wedge` pins the agreement).
  const tierRank = (config: (typeof outpostConfigs)[number]): number =>
    config.originIsSelf ? 0 : config.provenance === "manual" ? 2 : 1;
  const winnerByPeer = new Map<string, { config: (typeof outpostConfigs)[number]; rank: number }>();
  for (const config of outpostConfigs) {
    const rank = tierRank(config);
    const current = winnerByPeer.get(config.peerDomainId);
    // `<=` keeps the FIRST row of a tied class, matching `listOutpostConfigs`' deterministic
    // `(created_at, id)` order and `byAuthority`'s stable sort.
    if (current !== undefined && current.rank <= rank) continue;
    winnerByPeer.set(config.peerDomainId, { config, rank });
  }
  const tierByPeer = new Map<string, { tier: OutpostTrustTier; unverified: boolean }>();
  for (const [peerDomainId, winner] of winnerByPeer) {
    // The winner asserted nothing -> the field stays unknown for this peer. A lower-ranked row's
    // value is NOT consulted as a fallback: that fallback is what invented the posture above.
    if (winner.config.trustTier === null) continue;
    tierByPeer.set(peerDomainId, {
      tier: winner.config.trustTier,
      unverified: winner.config.provenance === "manual"
    });
  }

  const peerStatuses = await Promise.all(
    peers.map(async (peer) => {
      // A peer's OWN journal is authored under its OWN domain id — `getCursor(peerId, originId)`
      // with `originId === peer.id` is "how caught up am I on this peer's own history."
      const cursor = await getCursor(tx, orgId, peer.id, peer.id);
      const transfers = await listRecentTransfers(tx, orgId, peer.id, 5);
      // THE CORRECTLY-FILTERED INBOUND ANCHOR (review round 4). `lastSyncedAt`/`lastSyncedBundleChecksum`
      // used to be read off `listRecentTransfers(...).find(t => t.status === 'confirmed')` — ANY
      // direction, ANY kind, over the last 5 rows. A confirmed import/PROMOTION row (exactly what
      // `promotion-repo.ts` writes on every accepted promotion bundle) therefore satisfied it, and the
      // field documented as "the last confirmed INBOUND SYNC bundle" reported a PROMOTION checksum for a
      // peer no sync bundle had ever arrived from. `lastConfirmedSyncImportAt` is the helper that has
      // always had the right predicate (`direction='import' AND kind='sync' AND status='confirmed'`) and
      // an index shaped for it; both fields now come off that ONE row, so they cannot disagree.
      const lastSyncImport = await lastConfirmedSyncImportAt(tx, orgId, peer.id);
      const lastExport = await lastSyncExportForPeer(tx, orgId, peer.id);
      const tier = tierByPeer.get(peer.id);
      const trustTier = tier?.tier ?? null;
      const transportMode = deriveTransportMode(peer);
      const lastSyncedBundleChecksum = lastSyncImport?.checksum ?? null;
      const pendingExportEntryCount =
        lastExport === null ? null : Math.max(0, tail.sequence - lastExport.throughSequence);

      // The honest-unknown declaration. Each name is here because the value below it is a null that a
      // reader would otherwise mistake for an observation.
      const unknownFields: string[] = [];
      // No operator has asserted a tier (or there is no `outpost` object for this peer at all).
      // `trustTier` has no other source in this codebase — it is entered, never derived. An UNVERIFIED
      // hand-filled claim is listed too: the value rides the wire for shape stability, but it is not an
      // assertion this instance can stand behind, so a UI must render it as unknown rather than as a
      // commander assertion (`trustTierProvenance` says which case it is).
      if (trustTier === null || tier?.unverified === true) unknownFields.push("trustTier");
      // Either no transport is configured at all, or a base URL is configured that federation refuses to
      // dial — in both cases the channel is not honestly derivable. See `deriveTransportMode`.
      if (transportMode === null) unknownFields.push("transportMode");
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
        lastSyncedAt: lastSyncImport?.at.toISOString() ?? null,
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
        /** WHOSE assertion the tier above is: `"declared"` = authoritative for this instance (its own
         *  local-origin object on a commander, or the signature-verified commander replica on an
         *  outpost); `"unverified"` = a hand-filled `provenance:'manual'` shadow. `null` = no tier. */
        trustTierProvenance:
          tier === undefined
            ? null
            : tier.unverified
              ? ("unverified" as const)
              : ("declared" as const),
        transportMode,
        unknownFields,
        recentTransfers: transfers
      };
    })
  );

  // §10.5 — THE HQ OUTPOST RECORD. Bound to self's own domain, so it has no peer row and
  // can never be a `peers[]` entry; resolved here by the SAME authority rule the outposts API's
  // single GET applies (`findOutpostConfigByPeer`), so this and `GET /federation/outposts/{self}`
  // agree by construction. `null` is a stated absence — no record registered.
  const selfOutpost = await findOutpostConfigByPeer(tx, orgId, selfRow.domainId as string);

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
    selfOutpost,
    peers: peerStatuses
  };
}
