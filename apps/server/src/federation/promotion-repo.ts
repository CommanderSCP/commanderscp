import type {
  ImportPromotionResponse,
  PromotionBundle,
  PromotionApprovalEvidence
} from "@scp/schemas";
import {
  computeBundleChecksum,
  signBundleChecksum,
  verifyBundleSignature
} from "@scp/schemas/federation-journal";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, conflict } from "../errors.js";
import { ensureFederationSelf } from "./self-repo.js";
import { getPeerByIdOrName, peerPublicKeyAt } from "./peers-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";
import { ensureInstanceKey, verifyAttestation } from "../governance/attestation.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { getChange, proposeChange } from "../coordination/changes-repo.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import {
  listApprovalRequestsForChange,
  listVotesForRequest
} from "../governance/approvals-repo.js";
import { importedApprovalEvidence } from "../db/schema.js";
import { v7 as uuidv7 } from "uuid";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";

/**
 * Promotion Bundles (DESIGN.md §13 "federated change promotion" — grafted semantics). A change
 * promoted toward another domain exports as change + provenance + control outcomes + artifact
 * digests + per-approval Ed25519 attestations; the importing domain instantiates its OWN LOCAL
 * Change (`imported_from_domain` set) which must still pass LOCAL policies/controls/approvals —
 * imported approvals are attached as read-only EVIDENCE, never local authority (never inserted
 * into `approval_votes`/`approval_requests`, which is what quorum-checking gates actually read).
 *
 * SECURITY-SENSITIVE (M6 PR body flag — attestation validation must bind approver identity +
 * exactly what was approved, and reject on ANY mismatch): `importPromotionBundle` validates EVERY
 * approval attestation against the EXPORTING domain's OWN registered public key (not merely the
 * key embedded in the attestation itself — `signAttestation`'s output is self-consistent by
 * construction, so checking only that would let an attacker forge an "approval" by signing with
 * their own throwaway key and simply mislabeling its origin). A mismatch — wrong signer, wrong
 * key, or `approvedObjectUrn` not matching the change actually being imported — marks that
 * specific approval `verified: false` (rejected as evidence) WITHOUT aborting the whole import:
 * the local Change still lands in `proposed` and must earn its own LOCAL approvals regardless.
 */

export interface ExportPromotionInput {
  orgId: string;
  peerIdOrName: string;
  changeIdOrUrn: string;
}

export async function exportPromotionBundle(
  tx: TenantTx,
  input: ExportPromotionInput
): Promise<PromotionBundle> {
  const self = await ensureFederationSelf(tx, input.orgId);
  const peer = await getPeerByIdOrName(tx, input.orgId, input.peerIdOrName);
  const change = await getChange(tx, input.orgId, input.changeIdOrUrn);

  const controlRuns = await listControlRunsForChange(tx, input.orgId, change.id);
  const controlOutcomes = await Promise.all(
    controlRuns.map(async (run) => {
      let controlUrn: string | null = null;
      try {
        const controlObject = await getObjectByIdOrUrnAnyType(tx, input.orgId, run.controlObjectId);
        controlUrn = controlObject.urn;
      } catch {
        controlUrn = null;
      }
      return { controlUrn, status: run.status, evidence: run.evidence, detail: run.detail };
    })
  );

  const approvalRequests = await listApprovalRequestsForChange(tx, input.orgId, change.id);
  const approvals: PromotionApprovalEvidence[] = [];
  for (const request of approvalRequests) {
    const votes = await listVotesForRequest(tx, input.orgId, request.id);
    for (const vote of votes) approvals.push(vote.attestation);
  }

  const sourceRef = change.sourceRef ?? {};
  const artifactDigest =
    (sourceRef as Record<string, unknown>).artifact_digest ??
    (sourceRef as Record<string, unknown>).artifactDigest;
  const artifactDigests =
    typeof artifactDigest === "string"
      ? [artifactDigest]
      : Array.isArray(artifactDigest)
        ? artifactDigest.filter((d): d is string => typeof d === "string")
        : [];

  const header = {
    formatVersion: 1 as const,
    kind: "promotion" as const,
    exporterDomainId: self.domainId,
    peerDomainId: peer.id,
    sourceChangeObjectId: change.id,
    exportedAt: new Date().toISOString()
  };
  const changePayload = {
    urn: change.urn,
    name: change.name,
    properties: change.properties,
    sourceKind: change.sourceKind,
    sourceRef: change.sourceRef
  };
  const checksumPayload = { change: changePayload, controlOutcomes, approvals, artifactDigests };
  const checksum = computeBundleChecksum(checksumPayload);
  const key = await ensureInstanceKey(tx, input.orgId);
  const bundleSignature = signBundleChecksum(key.privateKey, checksum);

  await recordBundleTransfer(tx, {
    orgId: input.orgId,
    peerDomainId: peer.id,
    direction: "export",
    kind: "promotion",
    status: "created",
    checksum
  });

  return {
    header,
    change: changePayload,
    controlOutcomes,
    approvals,
    artifactDigests,
    checksum,
    bundleSignature
  };
}

export async function importPromotionBundle(
  tx: TenantTx,
  orgId: string,
  bundle: PromotionBundle
): Promise<ImportPromotionResponse> {
  const self = await ensureFederationSelf(tx, orgId);
  if (bundle.header.peerDomainId !== self.domainId) {
    throw conflict(
      `promotion bundle is addressed to domain '${bundle.header.peerDomainId}', not this domain ('${self.domainId}')`
    );
  }
  const peer = await getPeerByIdOrName(tx, orgId, bundle.header.exporterDomainId);

  // 1. Bundle-level checksum + signature — fail closed, exactly like a sync bundle.
  const checksumPayload = {
    change: bundle.change,
    controlOutcomes: bundle.controlOutcomes,
    approvals: bundle.approvals,
    artifactDigests: bundle.artifactDigests
  };
  if (computeBundleChecksum(checksumPayload) !== bundle.checksum) {
    throw conflict("promotion bundle checksum mismatch (rejected, fail-closed)");
  }
  const exportTimeKey = await peerPublicKeyAt(
    tx,
    orgId,
    peer.id,
    new Date(bundle.header.exportedAt)
  );
  if (
    !exportTimeKey ||
    !verifyBundleSignature(bundle.checksum, bundle.bundleSignature, exportTimeKey)
  ) {
    throw conflict("promotion bundle signature verification failed (rejected, fail-closed)");
  }

  // 2. Resolve local targets. Promotion targets are carried as object ids in `properties.targets`
  //    — these resolve locally only if the target objects were already replicated (a full-graph
  //    sync bundle preserves ids verbatim across domains — graph/objects-repo.ts's
  //    FederationImportContext never regenerates an incoming id).
  const rawTargets = (bundle.change.properties as Record<string, unknown>).targets;
  const targets = Array.isArray(rawTargets)
    ? rawTargets.filter((t): t is string => typeof t === "string")
    : [];
  if (targets.length === 0) {
    throw badRequest(
      "promotion bundle's change has no resolvable local targets — sync the graph from this peer first"
    );
  }

  const { change } = await proposeChange(tx, {
    orgId,
    actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
    requestId: `federation-promotion:${bundle.header.sourceChangeObjectId}`,
    name: bundle.change.name,
    properties: { ...bundle.change.properties, importedControlOutcomes: bundle.controlOutcomes },
    sourceKind: "federation",
    sourceRef: {
      ...(bundle.change.sourceRef ?? {}),
      promotedFromDomain: bundle.header.exporterDomainId,
      sourceChangeObjectId: bundle.header.sourceChangeObjectId,
      artifactDigests: bundle.artifactDigests
    },
    targets,
    importedFromDomain: peer.id
  });

  // 3. Validate each approval attestation against the EXPORTING domain's OWN registered key —
  //    never merely against the key embedded in the attestation. Stored as evidence regardless of
  //    outcome (rejected ones are visible/auditable AS rejected, not silently dropped).
  let accepted = 0;
  let rejected = 0;
  for (const evidence of bundle.approvals) {
    const registeredKey = await peerPublicKeyAt(
      tx,
      orgId,
      peer.id,
      new Date(evidence.record.timestamp)
    );
    const selfConsistent = verifyAttestation(evidence);
    const signedByRegisteredKey = registeredKey !== null && registeredKey === evidence.publicKey;
    const bindsThisChange = evidence.record.approvedObjectUrn === bundle.change.urn;
    const verified = selfConsistent && signedByRegisteredKey && bindsThisChange;

    if (verified) accepted += 1;
    else rejected += 1;

    await tx.insert(importedApprovalEvidence).values({
      id: uuidv7(),
      orgId,
      changeObjectId: change.id,
      originDomainId: peer.id,
      attestation: evidence,
      verified
    });
  }

  await recordBundleTransfer(tx, {
    orgId,
    peerDomainId: peer.id,
    direction: "import",
    kind: "promotion",
    status: "confirmed",
    checksum: bundle.checksum
  });

  return {
    localChangeObjectId: change.id,
    localChangeUrn: change.urn,
    importedFromDomain: peer.id,
    approvalsAccepted: accepted,
    approvalsRejected: rejected
  };
}
