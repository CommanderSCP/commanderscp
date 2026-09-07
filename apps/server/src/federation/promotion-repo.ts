import { and, eq } from "drizzle-orm";
import type { TrustDomainId } from "@scp/schemas";
import type {
  ArtifactRef,
  ImportPromotionResponse,
  PromotionBundle,
  PromotionManifest,
  PromotionApprovalEvidence
} from "@scp/schemas";
import {
  canonicalStringify,
  computeBundleChecksum,
  signBundleChecksum,
  verifyBundleSignature
} from "@scp/schemas/federation-journal";
import { signBlob, verifyBlob } from "@scp/cosign";
import type { Db } from "../db/client.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { badRequest, conflict } from "../errors.js";
import { ensureFederationSelf } from "./self-repo.js";
import {
  getPeerByIdOrName,
  currentPeerPublicKey,
  currentPeerCosignPublicKey
} from "./peers-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";
import { seedRelayBuild } from "./relay-builds-repo.js";
import { autoRelayEnabled } from "./auto-relay.js";
import { ensureInstanceKey, verifyAttestation } from "../governance/attestation.js";
import { ensureInstanceCosignKey } from "../governance/cosign-keys.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { mintArtifactObjects } from "../graph/artifacts-repo.js";
import {
  getChange,
  proposeChange,
  stampBoundaryBundleChecksum
} from "../coordination/changes-repo.js";
import {
  BOUNDARY_BUNDLE_CHECKSUMS_KEY,
  withoutBoundaryBundleChecksums,
  withoutPromotionExports
} from "./boundary-bundle-ref.js";
import { artifactSetOfSourceRef, substantiveArtifactsOf } from "../coordination/artifact-facts.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import { readInstanceScanFloors } from "../governance/scan-requirements.js";
import {
  evaluateScanCoverage,
  mergeInstanceFloor,
  type ScanCoverageRefusalCode,
  type ScanRunLike,
  type SeverityCeiling
} from "./scan-evidence.js";
import {
  listApprovalRequestsForChange,
  listVotesForRequest
} from "../governance/approvals-repo.js";
import { importedApprovalEvidence, objects } from "../db/schema.js";
import { v7 as uuidv7 } from "uuid";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import {
  runPromotionScanStep,
  createServerManagedScanRunner,
  resolveScanExclusionsForChange,
  type ManagedScanRunner
} from "./promotion-scan-step.js";

/** Promotion bundles, and their grafted semantics. See docs/federation.md §386. */

/** The exact field set the bundle checksum is computed over. See docs/federation.md §387. */
export function promotionChecksumPayload(bundle: {
  header: PromotionBundle["header"];
  change: PromotionBundle["change"];
  controlOutcomes: PromotionBundle["controlOutcomes"];
  approvals: PromotionBundle["approvals"];
  artifactDigests: PromotionBundle["artifactDigests"];
}) {
  return {
    header: bundle.header,
    change: bundle.change,
    controlOutcomes: bundle.controlOutcomes,
    approvals: bundle.approvals,
    artifactDigests: bundle.artifactDigests
  };
}

export interface ExportPromotionInput {
  orgId: string;
  peerIdOrName: string;
  changeIdOrUrn: string;
  /** The subject exporting the promotion — recorded on the gate-refusal Decision + audit event so a
   *  block is attributable. Defaults to the federation import actor when the caller omits it. */
  actorObjectId?: string;
  /** ADR-0020 / §13.3: the commander's promotion scan step runner. Injected so the step is
   *  hermetically testable (a fake returns canned counts); omitted ⇒ the default server-side
   *  skopeo-pull + `scp-managed-scan` runner. Pass `null` to DISABLE the managed step entirely (the
   *  legacy behaviour — only org-pipeline evidence satisfies E6), which the pre-13.3a tests rely on. */
  scanRunner?: ManagedScanRunner | null;
}

/** M17.3 (E6) — the outcome of an export. See docs/federation.md §388. */
export type ExportPromotionResult =
  | { refused: false; bundle: PromotionBundle }
  | { refused: true; decisionId: string; reason: string };

/** M17.3 (E6) EXPORT SCAN GATE. See docs/federation.md §389. */
function evaluatePromotionScanGate(
  substantiveArtifacts: ArtifactRef[],
  runs: readonly ScanRunLike[],
  instanceFloor: SeverityCeiling,
  /** M22.9 — the hash of the exclusion set resolved as in force at THIS export (ADR-0033 §10), or
   *  `undefined` when none is. Positional and required rather than optional, so a future caller of
   *  this gate cannot acquire the pre-M22.9 behaviour by omission. */
  expectedExclusionSetHash: string | undefined
):
  | { ok: true }
  | {
      ok: false;
      reason: string;
      artifactType: string;
      artifactDigest: string;
      code: ScanCoverageRefusalCode;
      detail: Record<string, unknown>;
    } {
  for (const artifact of substantiveArtifacts) {
    const coverage = evaluateScanCoverage({
      digest: artifact.digest,
      runs,
      instanceFloor,
      expectedExclusionSetHash
    });
    if (!coverage.covered) {
      return {
        ok: false,
        artifactType: artifact.type,
        artifactDigest: artifact.digest,
        code: coverage.code,
        detail: coverage.detail,
        reason:
          `export refused: substantive artifact ${artifact.type}:${artifact.digest} has no passing, ` +
          `digest-bound scan outcome — ${coverage.reason} (fail-closed, M17.3 E6)`
      };
    }
  }
  return { ok: true };
}

/** Build the SELF-BINDING promotion manifest — binds the bundle identity (exporter/peer/change/
 *  artifact digest set) so a cosign signature over it cannot be lifted onto a different bundle. */
function buildPromotionManifest(args: {
  sourceChangeObjectId: string;
  exporterDomainId: string;
  peerDomainId: string;
  changeUrn: string;
  artifactSet: ArtifactRef[];
}): PromotionManifest {
  return {
    manifestVersion: "scp-promotion-manifest/v1",
    createdAt: new Date().toISOString(),
    sourceChangeObjectId: args.sourceChangeObjectId,
    exporterDomainId: args.exporterDomainId,
    peerDomainId: args.peerDomainId,
    changeUrn: args.changeUrn,
    artifacts: args.artifactSet.map((a) => ({
      type: a.type,
      digest: a.digest,
      ...(a.signatureRef ? { signatureRef: a.signatureRef } : {})
    }))
  };
}

/** Export a bundle, hard-gating on scans and co-signing it. See docs/federation.md §390. */
export async function exportPromotionBundle(
  db: Db,
  input: ExportPromotionInput
): Promise<ExportPromotionResult> {
  const actorObjectId = input.actorObjectId ?? FEDERATION_IMPORT_ACTOR_ID;

  // Phase 1 — resolve the cosign signing keypair OUTSIDE any tx (first-use keygen runs a subprocess
  // that must never execute while a pooled DB connection is held open).
  const cosignPair = await ensureInstanceCosignKey(db, input.orgId);

  // Phase 1.2 — A DOMAIN-LOCAL CHANGE IS NEVER PROMOTED. See docs/federation.md §391.
  const localityRefusal = await withTenantTx(db, input.orgId, async (tx) => {
    const change = await getChange(tx, input.orgId, input.changeIdOrUrn);
    const rows = await tx
      .select({ domainLocal: objects.domainLocal })
      .from(objects)
      .where(and(eq(objects.orgId, input.orgId), eq(objects.id, change.id)))
      .limit(1);
    if (!rows[0]?.domainLocal) return null;

    const reason =
      `refused: change '${change.urn}' is domain-local — it never leaves its own security domain, ` +
      `so it cannot be promoted to a peer (ADR-0031 §5). Publish the target object first if it is ` +
      `genuinely meant to federate.`;
    const decision = await insertDecision(tx, {
      orgId: input.orgId,
      kind: "promotion-export-domain-local",
      subjectId: change.id,
      verdict: "block",
      inputContext: { changeUrn: change.urn, peerIdOrName: input.peerIdOrName },
      reasonTree: { summary: reason }
    });
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: actorObjectId,
      action: "federation.promotion.export.blocked",
      subjectId: change.id,
      reason,
      decisionId: decision.id,
      requestId: `federation-promotion-export:${change.id}`,
      // The subject IS domain-local — that is why we are here — so its audit segment is withheld
      // from peers while the local chain records the refusal in full. Omitting this would leak the
      // change's id through the very call that refused to let it cross.
      subjectDomainLocal: true
    });
    return { refused: true as const, decisionId: decision.id, reason };
  });
  if (localityRefusal) return localityRefusal;

  // Phase 1.5 — THE COMMANDER'S PROMOTION SCAN STEP. See docs/federation.md §392.
  if (input.scanRunner !== null) {
    const runner: ManagedScanRunner = input.scanRunner ?? createServerManagedScanRunner(db);
    await runPromotionScanStep(
      db,
      { orgId: input.orgId, changeIdOrUrn: input.changeIdOrUrn, actorObjectId },
      runner
    );
  }

  // Phase 2 — gather + gate inside a single tx. Either commits a refusal Decision (and returns it)
  // or returns the fully-assembled build context (nothing signed yet).
  const gathered = await withTenantTx(db, input.orgId, async (tx) => {
    const self = await ensureFederationSelf(tx, input.orgId);
    const peer = await getPeerByIdOrName(tx, input.orgId, input.peerIdOrName);
    const change = await getChange(tx, input.orgId, input.changeIdOrUrn);

    const controlRuns = await listControlRunsForChange(tx, input.orgId, change.id);
    const controlOutcomes = await Promise.all(
      controlRuns.map(async (run) => {
        let controlUrn: string | null = null;
        try {
          const controlObject = await getObjectByIdOrUrnAnyType(
            tx,
            input.orgId,
            run.controlObjectId
          );
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

    // Builds the typed artifact set from the change's refs. See docs/federation.md §393.
    const artifactSet: ArtifactRef[] = artifactSetOfSourceRef(change.sourceRef ?? {});

    // M17.3 (E6) EXPORT SCAN GATE. See docs/federation.md §394.
    const substantiveArtifacts = substantiveArtifactsOf(artifactSet, change.sourceRef ?? {});
    // The operator's above-org floors (ADR-0016 §3) — read once per export, applied to whichever
    // outcome ends up satisfying each artifact. Empty (the default: no floor authored) constrains
    // nothing, which is what makes this addition a no-op on an untouched deployment.
    const instanceFloor = mergeInstanceFloor(await readInstanceScanFloors(tx));
    // The exclusion set in force right now, resolved by this gate. See docs/federation.md §395.
    const expectedExclusionSetHash =
      substantiveArtifacts.length > 0
        ? (
            await resolveScanExclusionsForChange(tx, {
              orgId: input.orgId,
              change,
              actorObjectId
            })
          ).exclusionSetHash
        : undefined;
    const gate = evaluatePromotionScanGate(
      substantiveArtifacts,
      controlRuns,
      instanceFloor,
      expectedExclusionSetHash
    );
    if (!gate.ok) {
      const decision = await insertDecision(tx, {
        orgId: input.orgId,
        kind: "promotion-export-scan-gate",
        subjectId: change.id,
        verdict: "block",
        inputContext: {
          peerDomainId: peer.id,
          exporterDomainId: self.domainId,
          changeUrn: change.urn,
          substantiveArtifacts: substantiveArtifacts.map((a) => ({
            type: a.type,
            digest: a.digest
          })),
          failingArtifact: { type: gate.artifactType, digest: gate.artifactDigest },
          // WHICH of the five narrowings refused, machine-readably. See docs/federation.md §396.
          refusalCode: gate.code,
          ...gate.detail,
          instanceFloor
        },
        reasonTree: { summary: gate.reason }
      });
      await appendAuditEvent(tx, {
        orgId: input.orgId,
        actorId: actorObjectId,
        action: "federation.promotion.export.blocked",
        subjectId: change.id,
        reason: gate.reason,
        decisionId: decision.id,
        requestId: `federation-promotion-export:${change.id}`
      });
      return { refused: true as const, decisionId: decision.id, reason: gate.reason };
    }

    // Derived flat projection — the checksummed, backward-compatible field. `artifacts` itself is
    // `undefined` (NOT `[]`) when empty, so `JSON.stringify` drops it and the canonical bundle string
    // is byte-identical to a v1 bundle for a change that tracks no artifacts.
    const artifactDigests = artifactSet.map((a) => a.digest);
    const artifacts = artifactSet.length > 0 ? artifactSet : undefined;

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
      // The local boundary stamp is stripped from the wire payload. See docs/federation.md §397.
      sourceRef: withoutPromotionExports(withoutBoundaryBundleChecksums(change.sourceRef))
    };

    // The SELF-BINDING manifest — binds THIS bundle's identity + artifact set (built here so it sees
    // the same read-snapshot as the envelope; cosign-SIGNED outside the tx in phase 3).
    const manifest = buildPromotionManifest({
      sourceChangeObjectId: change.id,
      exporterDomainId: self.domainId,
      peerDomainId: peer.id,
      changeUrn: change.urn,
      artifactSet
    });

    return {
      refused: false as const,
      header,
      changePayload,
      controlOutcomes,
      approvals,
      artifactDigests,
      artifacts,
      manifest
    };
  });

  if (gathered.refused) {
    return { refused: true, decisionId: gathered.decisionId, reason: gathered.reason };
  }

  // Phase 3 — cosign-sign the canonical manifest bytes OUTSIDE any tx (subprocess). SCP signs ONLY
  // its OWN manifest here; origin artifact signatures ride untouched in `artifacts[].signatureRef`.
  // The canonical bytes a verifier reconstructs are `canonicalStringify(promotionManifest)`.
  const manifestSignature = await signBlob(
    canonicalStringify(gathered.manifest),
    cosignPair.privateKey
  );

  // Phase 4 — Ed25519-checksum + sign the (manifest-EXCLUDED) envelope, record the transfer.
  const bundle = await withTenantTx(db, input.orgId, async (tx) => {
    // Checksum covers the HEADER too (M6 review fix — CRITICAL). `artifacts` AND the E6 manifest
    // fields are EXCLUDED — `promotionChecksumPayload` is the single source of the checksum list, so
    // the envelope is byte-identical to a v1 bundle and an OLD outpost verifies it unchanged.
    const checksum = computeBundleChecksum(
      promotionChecksumPayload({
        header: gathered.header,
        change: gathered.changePayload,
        controlOutcomes: gathered.controlOutcomes,
        approvals: gathered.approvals,
        artifactDigests: gathered.artifactDigests
      })
    );
    const key = await ensureInstanceKey(tx, input.orgId);
    const bundleSignature = signBundleChecksum(key.privateKey, checksum);

    await recordBundleTransfer(tx, {
      orgId: input.orgId,
      peerDomainId: gathered.header.peerDomainId,
      direction: "export",
      kind: "promotion",
      status: "created",
      checksum,
      // An ordinary `.scpbundle` promotion export — the metadata leg, never bytes (the byte hop, if
      // any, is a separate later `buildRelayTarball` transfer at a retrans).
      channel: "metadata"
    });

    // M16.1 (I1) — the per-change join. See docs/federation.md §398.
    await stampBoundaryBundleChecksum(
      tx,
      input.orgId,
      gathered.header.sourceChangeObjectId,
      checksum,
      {
        peerDomainId: gathered.header.peerDomainId,
        exportedAt: gathered.header.exportedAt,
        checksum,
        manifest: gathered.manifest,
        manifestSignature,
        keyFingerprint: cosignPair.fingerprint
      }
    );

    // Mint artifact objects here, and only here on the export side. See docs/federation.md §399.
    await mintArtifactObjects(
      tx,
      input.orgId,
      gathered.manifest.artifacts.map((a) => ({ artifactType: a.type, digest: a.digest })),
      {
        actorObjectId,
        requestId: `federation-promotion-export:${gathered.header.sourceChangeObjectId}`,
        mintedBy: "export",
        firstPromotedChangeId: gathered.header.sourceChangeObjectId
      }
    );

    return {
      header: gathered.header,
      change: gathered.changePayload,
      controlOutcomes: gathered.controlOutcomes,
      approvals: gathered.approvals,
      artifactDigests: gathered.artifactDigests,
      // `undefined` when empty → dropped by JSON.stringify, so a no-artifact bundle is unchanged.
      artifacts: gathered.artifacts,
      // M17.3 (E6) SIBLING fields — checksum-EXCLUDED, so an old outpost that ignores them still
      // verifies the Ed25519 bundle byte-for-byte.
      promotionManifest: gathered.manifest,
      manifestSignature,
      checksum,
      bundleSignature
    };
  });

  return { refused: false, bundle };
}

/** Receiver-side verification of the self-binding manifest. See docs/federation.md §400. */
export interface ManifestVerifyContext {
  reason: string;
  detail: Record<string, unknown>;
}
export type ManifestVerifyResult = { ok: true } | ({ ok: false } & ManifestVerifyContext);

/** Canonical multiset key for an artifact entry — only the three fields the manifest carries. */
function artifactKey(a: {
  type: string;
  digest: string;
  signatureRef?: string | undefined;
}): string {
  return JSON.stringify([a.type, a.digest, a.signatureRef ?? ""]);
}
/** Multiset equality: equal cardinality AND identical element counts (sort the canonical keys). */
function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

export async function verifyPromotionManifest(args: {
  bundle: PromotionBundle;
  exporterCosignPubkey: string | null;
}): Promise<ManifestVerifyResult> {
  const { bundle, exporterCosignPubkey } = args;
  const manifest = bundle.promotionManifest;
  const manifestSignature = bundle.manifestSignature;

  // 5. BACK-COMPAT + DOWNGRADE DEFENSE (evaluated first — governs whether a manifest is even required).
  if (!manifest || !manifestSignature) {
    if (exporterCosignPubkey) {
      return {
        ok: false,
        reason:
          "promotion bundle carries NO cosign manifest, but the exporter peer HAS a registered " +
          "cosign key — a manifest-less bundle from an E5/E6-capable peer is a DOWNGRADE attack " +
          "(rejected, fail-closed)",
        detail: {
          check: "downgrade",
          hasManifest: Boolean(manifest),
          hasSignature: Boolean(manifestSignature),
          peerHasCosignKey: true
        }
      };
    }
    // Genuine pre-E5/E6 Ed25519-only bundle from a peer with no cosign trust anchor — ACCEPT.
    return { ok: true };
  }

  // A manifest is PRESENT → always verify. Without a trust anchor it cannot be verified → fail closed.
  if (!exporterCosignPubkey) {
    return {
      ok: false,
      reason:
        "promotion bundle carries a cosign manifest but the exporter peer has NO registered cosign " +
        "key to verify it against (rejected, fail-closed) — re-pair the peer to exchange its E5 key",
      detail: { check: "signature", peerHasCosignKey: false }
    };
  }

  // 1. SIGNATURE — cosign verify-blob over the EXACT canonical bytes the exporter signed (subprocess).
  const sigOk = await verifyBlob(
    canonicalStringify(manifest),
    manifestSignature,
    exporterCosignPubkey
  );
  if (!sigOk) {
    return {
      ok: false,
      reason: "promotion manifest cosign signature verification failed (rejected, fail-closed)",
      detail: { check: "signature" }
    };
  }

  // 4. SELF-BINDING — the manifest must bind EXACTLY this bundle's identity (blocks a manifest-swap).
  if (manifest.sourceChangeObjectId !== bundle.header.sourceChangeObjectId) {
    return {
      ok: false,
      reason:
        "promotion manifest sourceChangeObjectId does not bind this bundle (rejected, fail-closed)",
      detail: {
        check: "self-binding",
        field: "sourceChangeObjectId",
        manifest: manifest.sourceChangeObjectId,
        bundle: bundle.header.sourceChangeObjectId
      }
    };
  }
  if (manifest.exporterDomainId !== bundle.header.exporterDomainId) {
    return {
      ok: false,
      reason:
        "promotion manifest exporterDomainId does not bind this bundle (rejected, fail-closed)",
      detail: {
        check: "self-binding",
        field: "exporterDomainId",
        manifest: manifest.exporterDomainId,
        bundle: bundle.header.exporterDomainId
      }
    };
  }
  if (manifest.peerDomainId !== bundle.header.peerDomainId) {
    return {
      ok: false,
      reason: "promotion manifest peerDomainId does not bind this bundle (rejected, fail-closed)",
      detail: {
        check: "self-binding",
        field: "peerDomainId",
        manifest: manifest.peerDomainId,
        bundle: bundle.header.peerDomainId
      }
    };
  }
  if (manifest.changeUrn !== bundle.change.urn) {
    return {
      ok: false,
      reason: "promotion manifest changeUrn does not bind this bundle (rejected, fail-closed)",
      detail: {
        check: "self-binding",
        field: "changeUrn",
        manifest: manifest.changeUrn,
        bundle: bundle.change.urn
      }
    };
  }

  // 2. SET-EQUALITY — the arrived typed set EXACTLY equals the authorized (signed) set. `undefined`→[].
  const bundleArtifacts = bundle.artifacts ?? [];
  const bundleKeys = bundleArtifacts.map(artifactKey);
  const manifestKeys = manifest.artifacts.map(artifactKey);
  if (!multisetEqual(bundleKeys, manifestKeys)) {
    return {
      ok: false,
      reason:
        "promotion bundle's arrived artifact set does not exactly equal the cosign-signed manifest's " +
        "authorized set — an artifact was injected, substituted, added, or dropped (rejected, fail-closed)",
      detail: {
        check: "set-equality",
        bundleArtifacts: bundleKeys.sort(),
        manifestArtifacts: manifestKeys.sort()
      }
    };
  }

  // 3. THE TIE — the Ed25519-anchored digest list must equal the cosign-anchored one (load-bearing:
  //    the typed `artifacts[]` is EXCLUDED from the Ed25519 checksum, so ONLY this ties the two
  //    anchors together, blocking independent tampering of either set).
  const ed25519Digests = [...bundle.artifactDigests].sort();
  const manifestDigests = manifest.artifacts.map((a) => a.digest).sort();
  if (!multisetEqual(ed25519Digests, manifestDigests)) {
    return {
      ok: false,
      reason:
        "promotion bundle's Ed25519-anchored artifactDigests do not equal the cosign-signed manifest's " +
        "digest set — the two anchors diverge, so one was tampered independently (rejected, fail-closed)",
      detail: {
        check: "tie",
        artifactDigests: ed25519Digests,
        manifestDigests
      }
    };
  }

  return { ok: true };
}

/** Import a Promotion Bundle. See docs/federation.md §401. */
export async function importPromotionBundle(
  db: Db,
  orgId: string,
  bundle: PromotionBundle
): Promise<ImportPromotionResponse> {
  // Phase 1 — envelope gate + resolve the exporter's cosign pubkey, all inside one tx (no subprocess).
  const phase1 = await withTenantTx(db, orgId, async (tx) => {
    const self = await ensureFederationSelf(tx, orgId);
    if (bundle.header.peerDomainId !== self.domainId) {
      throw conflict(
        `promotion bundle is addressed to domain '${bundle.header.peerDomainId}', not this domain ('${self.domainId}')`
      );
    }
    const peer = await getPeerByIdOrName(tx, orgId, bundle.header.exporterDomainId);

    // 1. Bundle-level checksum + signature. See docs/federation.md §402.
    if (computeBundleChecksum(promotionChecksumPayload(bundle)) !== bundle.checksum) {
      throw conflict("promotion bundle checksum mismatch (rejected, fail-closed)");
    }
    const currentKey = await currentPeerPublicKey(tx, orgId, peer.id);
    if (
      !currentKey ||
      !verifyBundleSignature(bundle.checksum, bundle.bundleSignature, currentKey)
    ) {
      throw conflict("promotion bundle signature verification failed (rejected, fail-closed)");
    }

    // M17.4(a): resolve the EXPORTER peer's cosign verification key — the SAME non-superseded window
    // the Ed25519 key rode. `null` when the peer has none (governs back-compat vs downgrade below).
    const exporterCosignPubkey = await currentPeerCosignPublicKey(tx, orgId, peer.id);
    return { peerId: peer.id, exporterCosignPubkey };
  });

  // Phase two: manifest verification, outside any transaction. See docs/federation.md §403.
  const verified = await verifyPromotionManifest({
    bundle,
    exporterCosignPubkey: phase1.exporterCosignPubkey
  });
  if (!verified.ok) {
    // Persist a `block` Decision + hash-chained audit event and reject fail-closed with a decision_id
    // (mirrors the export scan gate — DESIGN §6/§10.4). `subjectId` is the exporter's change object id
    // (a uuid; `decisions.subject_id` has no FK, so a not-locally-resolved id is fine).
    const decisionId = await withTenantTx(db, orgId, async (tx) => {
      const decision = await insertDecision(tx, {
        orgId,
        kind: "promotion-import-manifest-verify",
        subjectId: bundle.header.sourceChangeObjectId,
        verdict: "block",
        inputContext: {
          exporterDomainId: bundle.header.exporterDomainId,
          peerDomainId: bundle.header.peerDomainId,
          changeUrn: bundle.change.urn,
          ...verified.detail
        },
        reasonTree: { summary: verified.reason }
      });
      await appendAuditEvent(tx, {
        orgId,
        actorId: FEDERATION_IMPORT_ACTOR_ID,
        action: "federation.promotion.import.blocked",
        subjectId: bundle.header.sourceChangeObjectId,
        reason: verified.reason,
        decisionId: decision.id,
        requestId: `federation-promotion-import:${bundle.header.sourceChangeObjectId}`
      });
      return decision.id;
    });
    throw conflict(verified.reason, { decisionId });
  }

  // Phase 3 — apply the import inside a fresh tx (no subprocess).
  return withTenantTx(db, orgId, (tx) => applyPromotionImport(tx, orgId, bundle, phase1.peerId));
}

async function applyPromotionImport(
  tx: TenantTx,
  orgId: string,
  bundle: PromotionBundle,
  peerId: TrustDomainId
): Promise<ImportPromotionResponse> {
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

  // M12 P4B (owner ruling, coupled-pipelines.md §8 Q2). See docs/federation.md §404.
  const {
    requires: _requiresStrippedOnPromotion,
    stageDependencies: _stageDependenciesStrippedOnPromotion,
    ...promotedProperties
  } = bundle.change.properties as Record<string, unknown>;

  const { change } = await proposeChange(tx, {
    orgId,
    actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
    requestId: `federation-promotion:${bundle.header.sourceChangeObjectId}`,
    name: bundle.change.name,
    // Carries the exporting domain's routing `type` through verbatim, so a promoted release rolls
    // this domain's matching pipeline too (M12 P4A / ADR-0007) — see `proposeChange`'s type precedence.
    properties: { ...promotedProperties, importedControlOutcomes: bundle.controlOutcomes },
    sourceKind: "federation",
    sourceRef: {
      ...(bundle.change.sourceRef ?? {}),
      promotedFromDomain: bundle.header.exporterDomainId,
      sourceChangeObjectId: bundle.header.sourceChangeObjectId,
      artifactDigests: bundle.artifactDigests,
      // M17.3 (E3): carry the TYPED artifact set onto the imported change when present. Purely
      // informational — it took no part in the checksum/signature verification above.
      ...(bundle.artifacts ? { artifacts: bundle.artifacts } : {}),
      // M17.3 (E6, LIGHT): round-trip the commander's cosign-signed self-binding manifest when
      // present, so a receiver can LATER (M17.4) cross-hop verify it. This increment does NOT build
      // the verify gate — the fields are carried through untouched and non-blocking; an old bundle
      // without them imports exactly as before.
      ...(bundle.promotionManifest ? { promotionManifest: bundle.promotionManifest } : {}),
      ...(bundle.manifestSignature ? { manifestSignature: bundle.manifestSignature } : {}),
      // M16.1 (I1) — the RECEIVING side's per-change join into its own `bundle_transfers` ledger.
      // Set (not appended) to exactly the bundle this change arrived in: a promotion bundle is 1:1
      // with a change, and any checksum the exporter might have carried over is its ledger, not
      // ours. The matching `confirmed` import row is written a few lines below in this same tx.
      [BOUNDARY_BUNDLE_CHECKSUMS_KEY]: [bundle.checksum]
    },
    targets,
    importedFromDomain: peerId
  });

  // ADR-0045 D2 — MINT ARTIFACT OBJECTS HERE. See docs/federation.md §405.
  await mintArtifactObjects(
    tx,
    orgId,
    (bundle.artifacts ?? []).map((a) => ({ artifactType: a.type, digest: a.digest })),
    {
      actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
      requestId: `federation-promotion:${bundle.header.sourceChangeObjectId}`,
      mintedBy: "import",
      firstPromotedChangeId: change.id
    }
  );

  // M12 P4B §8 Q2, the AUDIT half of the strip above. See docs/federation.md §406.
  if (_requiresStrippedOnPromotion !== undefined) {
    await insertDecision(tx, {
      orgId,
      kind: "coupling",
      subjectId: change.id,
      verdict: "allow",
      inputContext: {
        strippedRequires: _requiresStrippedOnPromotion,
        exporterDomainId: bundle.header.exporterDomainId,
        sourceChangeObjectId: bundle.header.sourceChangeObjectId
      },
      reasonTree: {
        summary:
          "requires satisfied upstream at commander — stripped on promotion import (coupled-pipelines.md §8 Q2): the commander held this change in `waiting` until its prerequisites were satisfied there, and its promotion of this bundle IS the go-ahead; re-evaluating locally would be redundant or deadlock"
      }
    });
  }

  // ADR-0028, the AUDIT half of the `stageDependencies` strip. See docs/federation.md §407.
  if (_stageDependenciesStrippedOnPromotion !== undefined) {
    await insertDecision(tx, {
      orgId,
      kind: "stage_dependency",
      subjectId: change.id,
      verdict: "allow",
      inputContext: {
        strippedStageDependencies: _stageDependenciesStrippedOnPromotion,
        exporterDomainId: bundle.header.exporterDomainId,
        sourceChangeObjectId: bundle.header.sourceChangeObjectId
      },
      reasonTree: {
        summary:
          "stage dependencies enforced upstream at the commander — stripped on promotion import (ADR-0028, federation ruling D5 open): the commander withheld this change's trigger until every declared dependency was satisfied there, and its promotion of this bundle IS the go-ahead. Evaluating them here would instead FAIL OPEN under any sync scope narrower than `full`, where the depended-on component is not replicated locally and every verdict resolves to `not_placed`"
      }
    });
  }

  // 3. Validate each approval attestation against the EXPORTING domain's OWN registered key —
  //    never merely against the key embedded in the attestation. Stored as evidence regardless of
  //    outcome (rejected ones are visible/auditable AS rejected, not silently dropped).
  let accepted = 0;
  let rejected = 0;
  // Fetched ONCE for the whole loop: `peerId` is fixed for this import, so the registered key
  // cannot change between approvals — hoisted out to avoid an identical SELECT per approval.
  const registeredKey = await currentPeerPublicKey(tx, orgId, peerId);
  for (const evidence of bundle.approvals) {
    // Validate against the peer's CURRENT registered key. See docs/federation.md §408.
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
      originDomainId: peerId,
      attestation: evidence,
      verified
    });
  }

  await recordBundleTransfer(tx, {
    orgId,
    peerDomainId: peerId,
    direction: "import",
    kind: "promotion",
    status: "confirmed",
    checksum: bundle.checksum,
    // An ordinary `.scpbundle` promotion import — the metadata leg, never bytes.
    channel: "metadata"
  });

  // M13.1b — THE CAUSAL SEED for the unattended onward BYTE hop. See docs/federation.md §409.
  const relaySelf = await ensureFederationSelf(tx, orgId);
  const typedArtifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
  if (relaySelf.role === "retrans" && typedArtifacts.length > 0) {
    const seeded = await seedRelayBuild(tx, {
      orgId,
      changeObjectId: change.id,
      sourceChangeObjectId: bundle.header.sourceChangeObjectId
    });
    // The stall signal, reachable by construction and sent once. See docs/federation.md §410.
    if (seeded && !autoRelayEnabled()) {
      console.warn(
        `[federation] org ${orgId}: promotion ${change.id} imported at this retrans owes an onward ` +
          `BYTE hop (${typedArtifacts.length} artifact(s)), but SCP_RETRANS_AUTO_RELAY is not set — ` +
          `hop 2 stays OPERATOR-GATED here: run 'scp federation relay --change ${change.id}' to ` +
          `build and drop the tarball, or set SCP_RETRANS_AUTO_RELAY=1 to automate it`
      );
    }
  }

  return {
    localChangeObjectId: change.id,
    localChangeUrn: change.urn,
    importedFromDomain: peerId,
    approvalsAccepted: accepted,
    approvalsRejected: rejected
  };
}
