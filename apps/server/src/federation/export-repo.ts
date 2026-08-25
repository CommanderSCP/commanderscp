import { v7 as uuidv7 } from "uuid";
import type { SyncBundle } from "@scp/schemas";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { ensureFederationSelf } from "./self-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import {
  listOwnJournalEntriesSince,
  ownJournalTail,
  ownJournalEntryAtSequence
} from "./journal-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";
import { filterByScope } from "./scope-filter.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";

/** Decision kind for an EXPORTER-side journal-divergence refusal (rails 1/2, §7.2). Distinct from
 *  the puller's `federation-sync-pull` kind so the two sides' Decisions never collide. */
export const FEDERATION_EXPORT_DECISION_KIND = "federation-export-divergence";

/**
 * A detected journal fork/rollback on the EXPORT path (divergence rails 1/2, §7.2). Thrown by
 * `exportSyncBundle` and caught by the `/exports` route, which turns it into the `journal_divergence`
 * 409 AND records the persist-on-change Decision — the two are split because the throw rolls back the
 * export's own read transaction, so the Decision must be written in a SEPARATE committed tx (exactly
 * as the puller's `recordSyncBlock` does). `rail` is a STABLE discriminator: it is what the Decision
 * dedups on, so a peer stuck in divergence writes ONE Decision, not one per 60s retry as its live
 * tail moves underneath it (the 1,440-Decisions/day amplification `recordSyncBlock` also guards).
 */
export class JournalDivergenceDetected extends Error {
  constructor(
    readonly rail: "export-tail" | "anchor",
    reason: string,
    readonly exporterTailSequence: number,
    readonly exporterTailRowHash: string
  ) {
    super(reason);
    this.name = "JournalDivergenceDetected";
  }
}

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
  sinceSequence?: number,
  lastAppliedRowHash?: string
): Promise<SyncBundle> {
  const self = await ensureFederationSelf(tx, orgId);
  const peer = await getPeerByIdOrName(tx, orgId, peerIdOrName);
  const since = sinceSequence ?? 0;
  const tail = await ownJournalTail(tx, orgId);

  // DIVERGENCE RAIL 1 (§7.2) — the STRICT half, no new wire data: a cursor can never legitimately
  // outrun the origin's own tail, so `since > tail.sequence` is proof this domain's journal was
  // rolled back (a lost-tail after an async-replication failover). The `since == tail.sequence`
  // boundary is rail 2's job (the hash comparison below). Retained rows mean a healthy cursor always
  // sits at or below the tail.
  if (since > tail.sequence) {
    throw new JournalDivergenceDetected(
      "export-tail",
      `pull cursor sinceSequence=${since} is beyond this domain's own journal tail (sequence ` +
        `${tail.sequence}) — the tail was rolled back or forked (a lost-tail restore after failover)`,
      tail.sequence,
      tail.rowHash
    );
  }

  // DIVERGENCE RAIL 2 (§7.2) — anchor verification, full-scope pullers only (they alone send a real
  // `lastAppliedRowHash`): the entry THIS domain now holds at the puller's cursor height must be the
  // one the puller anchored to. A different rowHash there means the tail was rolled back and
  // re-minted. Fires only on a PRESENT-but-different anchor (append-only journals mean a covered
  // height is populated); ambiguous absence never refuses.
  if (lastAppliedRowHash !== undefined && since > 0) {
    const anchor = await ownJournalEntryAtSequence(tx, orgId, since);
    if (anchor && anchor.rowHash !== lastAppliedRowHash) {
      throw new JournalDivergenceDetected(
        "anchor",
        `pull anchor lastAppliedRowHash at sinceSequence=${since} does not match this domain's own ` +
          `journal row at that height — the tail was rolled back and re-minted (a lost-tail restore)`,
        tail.sequence,
        tail.rowHash
      );
    }
  }

  const allEntries = await listOwnJournalEntriesSince(tx, orgId, since);
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
    checksum,
    // An ordinary `.scpbundle` sync export — the metadata leg, never bytes.
    channel: "metadata"
  });

  // DIVERGENCE RAIL 4 (§7.2): sign this domain's own journal tail and attach it OUTSIDE the bundle
  // checksum (a sibling field old importers ignore). Bound to both domain ids so the attestation
  // cannot be lifted onto another bundle. Attached unconditionally — even an empty export carries it,
  // which is exactly what lets a narrow-scope peer (rails 1–3 silent) still detect a rolled-back tail.
  const tailAttestation = {
    tailSequence: tail.sequence,
    tailRowHash: tail.rowHash,
    signature: signBundleChecksum(
      key.privateKey,
      computeBundleChecksum({
        exporterDomainId: self.domainId,
        peerDomainId: peer.id,
        tailSequence: tail.sequence,
        tailRowHash: tail.rowHash
      })
    )
  };

  return { header, entries, checksum, bundleSignature, tailAttestation };
}

/**
 * Records the persist-on-change Decision (+ hash-chained audit event) for an EXPORT-side journal
 * divergence, in its OWN committed transaction — the export's read tx has already rolled back by the
 * time this runs (the `/exports` route calls this from its catch). Mirrors the puller's
 * `recordSyncBlock` exactly, including WHY persist-on-change matters here: a refused pull snaps the
 * peer to the 60s cadence, so without dedup a single stuck peer would mint ~1,440 Decision+audit
 * pairs per day (the same incident `recordSyncBlock`'s doc names). The dedup content is STABLE per
 * `(peer, rail)` — the live tail is deliberately NOT in it, so the Decision is written once and not
 * restated as the exporter's own tail advances underneath the standing divergence. Returns the
 * standing Decision's id either way (charter principle 6 — a blocked response always carries one).
 */
export async function recordExportDivergence(
  db: Db,
  args: { orgId: string; peerIdOrName: string; divergence: JournalDivergenceDetected }
): Promise<string> {
  return withTenantTx(db, args.orgId, async (tx) => {
    const peer = await getPeerByIdOrName(tx, args.orgId, args.peerIdOrName);
    const recorded = await insertDecisionIfChanged(tx, {
      orgId: args.orgId,
      kind: FEDERATION_EXPORT_DECISION_KIND,
      subjectId: peer.id,
      verdict: "block",
      // STABLE content only (no live tail sequence/hash) so persist-on-change collapses the retry
      // storm to one row per (peer, rail).
      inputContext: {
        peerDomainId: peer.id,
        peerName: peer.name,
        rail: args.divergence.rail
      },
      reasonTree: {
        summary:
          args.divergence.rail === "export-tail"
            ? "journal divergence (export tail check): a puller's cursor is beyond this domain's own journal tail — the tail was rolled back or forked"
            : "journal divergence (anchor verification): a puller's applied-row anchor does not match this domain's journal at that height — the tail was rolled back and re-minted"
      }
    });
    if (!recorded.created) return recorded.decision.id;
    await appendAuditEvent(tx, {
      orgId: args.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.export.refused",
      subjectId: peer.id,
      reason: `federation export to peer '${peer.name}' refused (journal divergence, rail ${args.divergence.rail})`,
      decisionId: recorded.decision.id,
      requestId: `federation-export:${peer.id}:${uuidv7()}`
    });
    return recorded.decision.id;
  });
}
