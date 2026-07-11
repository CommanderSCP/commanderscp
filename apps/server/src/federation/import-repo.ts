import type { SyncBundle, SyncJournalEntry } from "@scp/schemas";
import {
  computeBundleChecksum,
  verifyBundleSignature,
  verifyJournalChain
} from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { conflict, ProblemError } from "../errors.js";
import { ensureFederationSelf } from "./self-repo.js";
import { getPeerByIdOrName, peerPublicKeyAt } from "./peers-repo.js";
import { getCursor, advanceCursor } from "./cursors-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";
import { entryMatchesScope } from "./scope-filter.js";
import { createRelationship, deleteRelationship } from "../graph/relationships-repo.js";
import { deleteObject, upsertObjectByUrn } from "../graph/objects-repo.js";
import { updateObject } from "../graph/objects-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * `scp federation import` — the receiving side of the `.scpbundle` file transport (DESIGN.md
 * §13). SECURITY-SENSITIVE (M6 PR body flag — every check here is fail-closed by construction:
 * an exception aborts the whole caller transaction, applying nothing):
 *
 *  1. Bundle-level: the payload must hash to the claimed `checksum`, and `checksum` must verify
 *     against the EXPORTING peer's Ed25519 public key (resolved at the historical point in time
 *     the bundle claims to have been exported, honoring key rotation).
 *  2. Chain-level: every entry from `cursor+1` onward must form a contiguous, correctly-signed
 *     hash chain continuing from the LAST entry this side actually applied (`sync_cursors`'
 *     `lastAppliedRowHash` — not just internal-to-this-bundle contiguity, which alone would let an
 *     attacker splice in a fabricated sub-chain at an arbitrary cursor). `verifyJournalChain`
 *     returning `valid: false` for ANY reason rejects the ENTIRE segment — no partial-prefix
 *     application.
 *  3. Row-level (graph/objects-repo.ts, graph/relationships-repo.ts): single-writer authority is
 *     re-checked on every individual write via `FederationImportContext` — a bundle cannot make
 *     this domain apply a write claiming authorship of an object it doesn't already know belongs
 *     to the SAME origin domain the bundle is nominally from.
 *
 * Import applies through the exact same repo functions the public API's write path uses
 * (`upsertObjectByUrn`, `createRelationship`, ...) — DESIGN §6: "a federation bundle import is
 * literally a replay of public-API writes that converges no matter how many times it is applied."
 * This is also why import can never bypass local RLS/RBAC/tenancy: it runs inside the SAME
 * `withTenantTx` as any other request, under the SAME `scp_app` role, so a bundle addressed to
 * org A can only ever write org A's rows — there is no cross-org code path here at all.
 */

// Well-known sentinel actor id for federation-import-authored audit events — no `objects` row
// backs it (audit_events.actor_id carries no FK constraint, by design — schema.ts). Distinct from
// any real user/service-account id so `scp audit verify`/UI can recognize "this action came from
// a federation import," not a masquerading human actor.
export const FEDERATION_IMPORT_ACTOR_ID = "00000000-0000-0000-0000-00000000fed0";

function isNotFound(err: unknown): boolean {
  return err instanceof ProblemError && err.status === 404;
}

async function applyEntry(
  tx: TenantTx,
  orgId: string,
  entry: SyncJournalEntry,
  exporterDomainId: string
): Promise<void> {
  const payload = entry.payload;
  const requestId = `federation-import:${entry.id}`;

  switch (entry.entryKind) {
    case "object_upsert":
    case "policy_upsert": {
      const typeId = String(payload.typeId);
      const urn = String(payload.urn);
      const revision = Number(payload.revision ?? entry.sequence);
      const originDomainId = String(payload.originDomainId ?? exporterDomainId);
      await upsertObjectByUrn(tx, {
        orgId,
        typeId,
        actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
        requestId,
        urn,
        id: typeof payload.id === "string" ? payload.id : undefined,
        name: String(payload.name ?? urn),
        domainId: (payload.domainId as string | null | undefined) ?? undefined,
        properties: (payload.properties as Record<string, unknown>) ?? {},
        labels: (payload.labels as Record<string, unknown>) ?? {},
        federationImport: { originDomainId, revision, provenance: null }
      });
      return;
    }
    case "object_tombstone": {
      const typeId = String(payload.typeId);
      const idOrUrn = String(payload.urn ?? payload.id);
      try {
        await deleteObject(tx, {
          orgId,
          typeId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          idOrUrn,
          federationImport: { originDomainId: exporterDomainId, revision: entry.sequence }
        });
      } catch (err) {
        if (isNotFound(err)) return; // never replicated locally — nothing to tombstone
        throw err;
      }
      return;
    }
    case "relationship_upsert": {
      const originDomainId = String(payload.originDomainId ?? exporterDomainId);
      const revision = Number(payload.revision ?? entry.sequence);
      try {
        await createRelationship(tx, {
          orgId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          id: typeof payload.id === "string" ? payload.id : undefined,
          typeId: String(payload.typeId),
          fromId: String(payload.fromId),
          toId: String(payload.toId),
          properties: (payload.properties as Record<string, unknown>) ?? {},
          labels: (payload.labels as Record<string, unknown>) ?? {},
          federationImport: { originDomainId, revision }
        });
      } catch (err) {
        // Endpoints not yet replicated locally (out-of-order relative to this domain's own
        // history — should not happen for a from-genesis or contiguous-cursor import, since a
        // relationship's origin domain always creates its endpoints first in its OWN chain, but
        // handled defensively rather than failing the whole bundle over one skippable edge).
        if (err instanceof ProblemError && err.status === 400) return;
        throw err;
      }
      return;
    }
    case "relationship_tombstone": {
      try {
        await deleteRelationship(tx, {
          orgId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          id: String(payload.id),
          federationImport: { originDomainId: exporterDomainId, revision: entry.sequence }
        });
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      return;
    }
    case "change_status": {
      // Best-effort enrichment ONLY: mirrors the lifecycle state into the change's already-
      // replicated graph object (from a corresponding object_upsert entry) for cross-domain
      // status visibility. Never creates a LOCAL `changes` state-machine row — a synced change
      // must never be picked up by this domain's own reconciliation loop (DESIGN §13
      // single-writer authority: replicas are read-only, and "read-only" here specifically means
      // "not managed by MY engine," not just "not graph-writable"). Swallows any failure (e.g. the
      // underlying object hasn't been replicated yet) — this entry kind is enrichment, not core
      // graph content, so it must never abort an otherwise-valid import.
      try {
        const objectId = String(payload.objectId ?? "");
        if (!objectId) return;
        const existing = await getObjectByIdOrUrnAnyType(tx, orgId, objectId);
        if (existing.originDomainId !== exporterDomainId) return; // not a replica of THIS peer — leave alone
        const state = (payload.toState ?? payload.state) as string | undefined;
        if (!state) return;
        await updateObject(tx, {
          orgId,
          typeId: existing.typeId,
          actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
          requestId,
          idOrUrn: existing.id,
          properties: { ...existing.properties, federationState: state },
          federationImport: { originDomainId: exporterDomainId, revision: existing.revision + 1 }
        });
      } catch {
        // best-effort — see comment above
      }
      return;
    }
    case "approval_evidence":
    case "audit_segment":
    case "key_rotation":
      // Informational-only in a plain sync bundle (v1): already hash-chained/signed on the
      // exporting side (audit-completeness lives there); not separately persisted here. Promotion
      // Bundles carry approval evidence through a DEDICATED, validated path instead
      // (promotion-repo.ts's `importedApprovalEvidence` table) — that is the flow the DoD's
      // "tampered/missing approval attestation rejects the approval as evidence" test targets.
      return;
    default:
      return;
  }
}

export interface ImportSyncBundleResult {
  peerDomainId: string;
  appliedEntries: number;
  skippedEntries: number;
  lastAppliedSequence: number;
}

export async function importSyncBundle(
  tx: TenantTx,
  orgId: string,
  bundle: SyncBundle
): Promise<ImportSyncBundleResult> {
  const self = await ensureFederationSelf(tx, orgId);
  if (bundle.header.peerDomainId !== self.domainId) {
    throw conflict(
      `bundle is addressed to domain '${bundle.header.peerDomainId}', not this domain ('${self.domainId}')`
    );
  }
  const peer = await getPeerByIdOrName(tx, orgId, bundle.header.exporterDomainId);

  // 1. Bundle-level checksum + signature — fail closed.
  const recomputedChecksum = computeBundleChecksum(bundle.entries);
  if (recomputedChecksum !== bundle.checksum) {
    throw conflict("bundle checksum mismatch — payload does not match the signed checksum (rejected, fail-closed)");
  }
  const exportTimeKey = await peerPublicKeyAt(tx, orgId, peer.id, new Date(bundle.header.exportedAt));
  if (!exportTimeKey || !verifyBundleSignature(bundle.checksum, bundle.bundleSignature, exportTimeKey)) {
    throw conflict("bundle signature verification failed (rejected, fail-closed)");
  }

  // 2. Resume-from-cursor + hash-chain verification, continuous with what was actually applied
  //    last time (not just internally contiguous within this one bundle).
  const cursor = await getCursor(tx, orgId, peer.id, bundle.header.exporterDomainId);
  const toApply = bundle.entries.filter((entry) => entry.sequence > cursor.sequence);

  if (toApply.length > 0) {
    const verification = verifyJournalChain(toApply, {
      expectedPrevHash: cursor.rowHash ?? undefined,
      expectedStartSequence: cursor.sequence + 1,
      resolvePublicKey: () => exportTimeKey // same peer, same bundle-level export instant for every entry
    });
    if (!verification.valid) {
      throw conflict(
        `tampered or broken journal segment (rejected, fail-closed): ${verification.brokenAt?.reason ?? "unknown"}`
      );
    }
  }

  let applied = 0;
  let lastSequence = cursor.sequence;
  for (const entry of toApply) {
    if (entryMatchesScope(entry, peer.syncScope)) {
      await applyEntry(tx, orgId, entry, bundle.header.exporterDomainId);
    }
    applied += 1;
    lastSequence = entry.sequence;
    await advanceCursor(tx, orgId, peer.id, bundle.header.exporterDomainId, entry.sequence, entry.rowHash);
  }

  const skipped = bundle.entries.length - toApply.length;

  await recordBundleTransfer(tx, {
    orgId,
    peerDomainId: peer.id,
    direction: "import",
    kind: "sync",
    status: "confirmed",
    sinceSequence: bundle.header.sinceSequence,
    throughSequence: bundle.header.throughSequence,
    checksum: bundle.checksum
  });

  return { peerDomainId: peer.id, appliedEntries: applied, skippedEntries: skipped, lastAppliedSequence: lastSequence };
}
