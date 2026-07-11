import type { SyncBundle } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import { listOwnJournalEntriesSince, ownJournalTail } from "./journal-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";
import { filterByScope } from "./scope-filter.js";

/**
 * `scp federation export` (DESIGN.md §13 file transport). Builds a signed, checksummed
 * `.scpbundle` (a single bounded JSON document — see `packages/schemas/src/federation.ts`'s
 * module doc for why this is deliberately NOT a tar/zip archive) covering this domain's OWN
 * journal entries since a cursor.
 *
 * SECURITY-SENSITIVE (M6 review fix — MAJOR: confidentiality). The exported bundle contains ONLY
 * the entries in the peer's configured sync scope. Previously the FULL journal range was shipped
 * to every peer and scope was applied only at IMPORT/apply time — so a `policies_only` /
 * `status_only` / `custom` peer, scoped precisely FOR confidentiality, still received the complete
 * plaintext graph on disk / in transit and could read everything. Scope is now enforced HERE, at
 * export; import re-applies the same filter as defense-in-depth. `throughSequence` still reflects
 * the FULL range's tail (not the last in-scope entry), so the importer's cursor advances past
 * out-of-scope entries and never re-requests them; the scope-filtered chain is therefore SPARSE
 * (deliberate sequence gaps), verified with `verifyJournalChain({ contiguous: false })` on import.
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
  const allEntries = await listOwnJournalEntriesSince(tx, orgId, since);
  const tail = await ownJournalTail(tx, orgId);
  // throughSequence = the FULL range's tail (so the peer's cursor advances past out-of-scope
  // entries too), even though only in-scope entries are actually shipped.
  const throughSequence =
    allEntries.length > 0 ? (allEntries[allEntries.length - 1]?.sequence ?? since) : since;
  const entries = filterByScope(allEntries, peer.syncScope);

  const header = {
    formatVersion: 1 as const,
    kind: "sync" as const,
    exporterDomainId: self.domainId,
    peerDomainId: peer.id,
    sinceSequence: since,
    throughSequence,
    exportedAt: new Date().toISOString()
  };

  // SECURITY-SENSITIVE (M6 review fix — CRITICAL: the header was unsigned). The signed checksum
  // now covers the HEADER (exporterDomainId, peerDomainId, since/throughSequence, exportedAt) as
  // well as the entries, so a header rewritten in transit fails signature verification on import.
  const checksum = computeBundleChecksum({ header, entries });
  const key = await ensureInstanceKey(tx, orgId);
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
