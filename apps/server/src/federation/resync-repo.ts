import { v7 as uuidv7 } from "uuid";
import {
  asTrustDomainId,
  type FederationResyncRequest,
  type FederationResyncResult,
  type SyncBundle
} from "@scp/schemas";
import {
  computeBundleChecksum,
  signBundleChecksum,
  verifyBundleSignature
} from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { conflict, forbidden } from "../errors.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { ensureFederationSelf, bumpFederationGeneration } from "./self-repo.js";
import { getPeerByIdOrName, listPeerKeyWindows } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle, FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import { resetCursor, getCursor, FEDERATION_DIVERGENCE_DECISION_KIND } from "./cursors-repo.js";

/**
 * §7.2.6 RESYNC — the mutually-authorized, one-shot recovery from a lost-tail journal divergence. It
 * is the SANCTIONED alternative to re-anchoring (which rail 5 refuses while a divergence stands): the
 * importer's operator runs `scp federation resync --peer <exporter>`; the importer signs a request
 * the exporter verifies (the importer authorizing a forced overwrite of ITS OWN replica); the
 * exporter records a consent Decision and returns a signed FULL re-export from genesis; the importer
 * resets its cursor, force-overwrite-imports (bypassing the revision-staleness guard, NEVER the
 * single-writer authority check), bumps its generation, records its Decision, and clears the standing
 * divergence — which lifts rail 5. Both sides record; the generation stamp attributes entries to
 * before/after the event (§7.2.6). SECURITY-SENSITIVE end to end.
 */
export const FEDERATION_RESYNC_DECISION_KIND = "federation-resync";

/** The canonical payload the importer signs and the exporter verifies. Binds BOTH domain ids so a
 *  captured signature cannot be replayed to authorize a resync between a different pair. */
function resyncRequestChecksum(importerDomainId: string, exporterDomainId: string): string {
  return computeBundleChecksum({ resync: true, importerDomainId, exporterDomainId });
}

/** IMPORTER side — sign a resync request to `exporterDomainId` with THIS domain's instance key. */
export async function signResyncRequest(
  tx: TenantTx,
  orgId: string,
  exporterDomainId: string
): Promise<{ importerDomainId: string; requestSignature: string }> {
  const self = await ensureFederationSelf(tx, orgId);
  const key = await ensureInstanceKey(tx, orgId);
  const checksum = resyncRequestChecksum(self.domainId, exporterDomainId);
  return {
    importerDomainId: self.domainId,
    requestSignature: signBundleChecksum(key.privateKey, checksum)
  };
}

/**
 * EXPORTER side — verify the importer's signed resync request against its paired public key, record
 * the exporter's CONSENT Decision (+ audit), bump the exporter's generation, and return a full signed
 * re-export from genesis for that peer. A bad signature is a 403 (fail-closed): only the paired
 * importer, holding its own private key, can authorize a resync of its replica.
 */
export async function authorizeResyncAndReExport(
  tx: TenantTx,
  orgId: string,
  req: FederationResyncRequest
): Promise<{ bundle: SyncBundle; exporterGeneration: number }> {
  const self = await ensureFederationSelf(tx, orgId);
  const requester = await getPeerByIdOrName(tx, orgId, req.peer);
  const keyWindows = await listPeerKeyWindows(tx, orgId, requester.id);
  const requesterKey = keyWindows.find((k) => k.supersededAtSequence === null)?.publicKey ?? null;
  const checksum = resyncRequestChecksum(requester.id, self.domainId);
  if (!requesterKey || !verifyBundleSignature(checksum, req.requestSignature, requesterKey)) {
    throw forbidden(
      "resync request signature verification failed — only the paired peer, signing with its own " +
        "instance key, can authorize a resync of its replica"
    );
  }

  const decision = await insertDecision(tx, {
    orgId,
    kind: FEDERATION_RESYNC_DECISION_KIND,
    subjectId: requester.id,
    verdict: "allow",
    inputContext: { role: "exporter", peerDomainId: requester.id, peerName: requester.name },
    reasonTree: { summary: `authorized a resync full re-export for peer '${requester.name}' (§7.2.6)` }
  });
  await appendAuditEvent(tx, {
    orgId,
    actorId: FEDERATION_IMPORT_ACTOR_ID,
    action: "federation.resync.authorized",
    subjectId: requester.id,
    reason: `authorized resync for peer '${requester.name}'`,
    decisionId: decision.id,
    requestId: `federation-resync:${requester.id}:${uuidv7()}`
  });

  const exporterGeneration = await bumpFederationGeneration(tx, orgId);
  // Full re-export from genesis (sinceSequence 0 → rail 1's `since > tail` never fires; no anchor →
  // rail 2 never fires). Scope-filtered for this peer exactly as a normal export is.
  const bundle = await exportSyncBundle(tx, orgId, req.peer, 0);
  return { bundle, exporterGeneration };
}

/**
 * IMPORTER side — apply an exporter's signed resync re-export: reset the cursor to genesis,
 * FORCE-OVERWRITE import (re-converging even stale-revision rows), bump this side's generation,
 * record the importer's Decision, and CLEAR the standing divergence by writing a newer non-block
 * `federation-divergence` Decision (so `permitCursorReanchor`'s rail-5 refusal lifts). The bundle's
 * own signature is verified inside `importSyncBundle` against the exporter's paired key.
 */
export async function applyResyncBundle(
  tx: TenantTx,
  orgId: string,
  exporterPeerIdOrName: string,
  bundle: SyncBundle,
  exporterGeneration: number
): Promise<FederationResyncResult> {
  const exporter = await getPeerByIdOrName(tx, orgId, exporterPeerIdOrName);
  const exporterDomainId = asTrustDomainId(exporter.id);
  const previous = await getCursor(tx, orgId, exporterDomainId, exporterDomainId);

  // Reset FIRST so rail 4's high-water mark (cleared here) does not refuse the re-export as a
  // regression, and so force-import re-applies from genesis.
  await resetCursor(tx, orgId, exporterDomainId, exporterDomainId, 0, null);
  const result = await importSyncBundle(tx, orgId, bundle, "bundle", true);

  const generation = await bumpFederationGeneration(tx, orgId);
  const decision = await insertDecision(tx, {
    orgId,
    kind: FEDERATION_RESYNC_DECISION_KIND,
    subjectId: exporter.id,
    verdict: "allow",
    inputContext: {
      role: "importer",
      peerDomainId: exporter.id,
      peerName: exporter.name,
      previousCursorSequence: previous.sequence,
      appliedEntries: result.appliedEntries,
      generation,
      exporterGeneration
    },
    reasonTree: {
      summary: `resynced replica of peer '${exporter.name}' from genesis, force-overwriting to the exporter's restored reality (generation ${generation}, §7.2.6)`
    }
  });
  await appendAuditEvent(tx, {
    orgId,
    actorId: FEDERATION_IMPORT_ACTOR_ID,
    action: "federation.resync.applied",
    subjectId: exporter.id,
    reason: `resynced from peer '${exporter.name}': applied ${result.appliedEntries} entries at generation ${generation}`,
    decisionId: decision.id,
    requestId: `federation-resync:${exporter.id}:${uuidv7()}`
  });

  // CLEAR the standing divergence: a newer, NON-block `federation-divergence` Decision supersedes the
  // block, so `latestDecisionForSubjectKind` returns this and rail 5 lifts its reanchor refusal.
  await insertDecision(tx, {
    orgId,
    kind: FEDERATION_DIVERGENCE_DECISION_KIND,
    subjectId: exporter.id,
    verdict: "allow",
    inputContext: { peerDomainId: exporter.id, clearedByResyncDecisionId: decision.id, generation },
    reasonTree: { summary: `journal divergence resolved by resync (generation ${generation})` }
  });

  return {
    peerDomainId: exporter.id,
    previousCursorSequence: previous.sequence,
    appliedEntries: result.appliedEntries,
    generation,
    decisionId: decision.id
  };
}

/** Convenience: a resync bundle that fails these is refused (mostly a re-statement of import's own
 *  checks, kept here so the resync route can give a clear message before applying). */
export function assertResyncBundleAddressedTo(bundle: SyncBundle, selfDomainId: string): void {
  if (bundle.header.peerDomainId !== selfDomainId) {
    throw conflict(
      `resync bundle is addressed to domain '${bundle.header.peerDomainId}', not this domain ('${selfDomainId}')`
    );
  }
}
