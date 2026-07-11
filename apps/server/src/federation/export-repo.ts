import type { SyncBundle } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import { listOwnJournalEntriesSince, ownJournalTail } from "./journal-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";

/**
 * `scp federation export` (DESIGN.md §13 file transport). Builds a signed, checksummed
 * `.scpbundle` (a single bounded JSON document — see `packages/schemas/src/federation.ts`'s
 * module doc for why this is deliberately NOT a tar/zip archive) covering this domain's OWN
 * journal entries since a cursor. Ships the FULL unfiltered range — see `scope-filter.ts`'s doc
 * comment for why scope is enforced at import/apply time instead of by excluding entries here.
 */
export async function exportSyncBundle(
  tx: TenantTx,
  orgId: string,
  peerIdOrName: string,
  sinceSequence?: number
): Promise<SyncBundle> {
  const self = await ensureFederationSelf(tx, orgId);
  const peer = await getPeerByIdOrName(tx, orgId, peerIdOrName);
  const since = sinceSequence ?? 0;
  const entries = await listOwnJournalEntriesSince(tx, orgId, since);
  const tail = await ownJournalTail(tx, orgId);
  const throughSequence =
    entries.length > 0 ? (entries[entries.length - 1]?.sequence ?? since) : since;

  const header = {
    formatVersion: 1 as const,
    kind: "sync" as const,
    exporterDomainId: self.domainId,
    peerDomainId: peer.id,
    sinceSequence: since,
    throughSequence,
    exportedAt: new Date().toISOString()
  };

  const checksum = computeBundleChecksum(entries);
  const key = await ensureInstanceKey(tx);
  const bundleSignature = signBundleChecksum(key.privateKey, checksum);

  await recordBundleTransfer(tx, {
    orgId,
    peerDomainId: peer.id,
    direction: "export",
    kind: "sync",
    status: "created",
    sinceSequence: since,
    throughSequence,
    checksum
  });

  // `tail` is read for symmetry/observability (a future `scp federation status` widening can
  // report "N entries not yet exported to peer X" from `tail.sequence - throughSequence`) — not
  // otherwise consulted by the export itself, which is purely cursor-driven.
  void tail;

  return { header, entries, checksum, bundleSignature };
}
