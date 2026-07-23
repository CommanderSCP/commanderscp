import { ScanEvidenceSchema } from "@scp/schemas";
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
import { ensureInstanceKey, verifyAttestation } from "../governance/attestation.js";
import { ensureInstanceCosignKey } from "../governance/cosign-keys.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
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

/**
 * The EXACT field set the promotion bundle's Ed25519 checksum is computed over — the SINGLE source
 * of that list, shared by export and import so the two can never drift (checksum covers the HEADER
 * too — M6 review fix). M17.3 (E3): `artifacts` is DELIBERATELY NOT in this list, so adding the
 * typed artifact set to a bundle does not change its checksum or signature; a bundle with
 * `artifacts` present hashes byte-identically to a v1 bundle without it. `computeBundleChecksum`
 * canonicalizes by sorting keys deeply, so the field order here does not affect the result.
 */
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
}

/**
 * M17.3 (E6) — the outcome of an export. On success the caller sends `bundle`; on a scan-gate
 * REFUSAL the caller turns `{ refused: true }` into a 409 carrying `decisionId` (like every other
 * blocked response — DESIGN.md §6/§10.4). The refusal is FAIL-CLOSED: the Decision has ALREADY been
 * persisted (committed) by the time this returns, so `decisionId` resolves.
 */
export type ExportPromotionResult =
  | { refused: false; bundle: PromotionBundle }
  | { refused: true; decisionId: string; reason: string };

/**
 * M17.3 (E6) EXPORT SCAN GATE — the boundary re-check (defense in depth). For EACH SUBSTANTIVE
 * artifact (everything in `artifacts[]` EXCEPT `type: "blob"` — the SBOM is the scan's OUTPUT, not a
 * scanned input, so it is EXEMPT) there MUST exist a control run for this change whose evidence
 * parses as `ScanEvidenceSchema` with the run `status === "pass"`, `digestMatch === true`, and a
 * scanned `artifactDigest` EQUAL to the artifact's promoted digest (M17.1 digest binding). This is
 * UNIVERSAL and fail-closed: a MISSING scan refuses exactly like a FAILED one, whether or not a
 * scan-requirement policy was ever bound. Control runs carry no plugin-id column, so a scan outcome
 * is identified purely by `ScanEvidenceSchema.safeParse(evidence)`. This NEVER runs a scan
 * (coordinate-not-execute) — it only re-verifies existence + digest-binding of an outcome an
 * execution system already produced.
 */
function evaluatePromotionScanGate(
  substantiveArtifacts: ArtifactRef[],
  controlOutcomes: Array<{ status: string; evidence: Record<string, unknown> }>
): { ok: true } | { ok: false; reason: string; artifactType: string; artifactDigest: string } {
  for (const artifact of substantiveArtifacts) {
    const passing = controlOutcomes.some((outcome) => {
      if (outcome.status !== "pass") return false;
      const parsed = ScanEvidenceSchema.safeParse(outcome.evidence);
      if (!parsed.success) return false;
      return parsed.data.digestMatch === true && parsed.data.artifactDigest === artifact.digest;
    });
    if (!passing) {
      return {
        ok: false,
        artifactType: artifact.type,
        artifactDigest: artifact.digest,
        reason:
          `export refused: substantive artifact ${artifact.type}:${artifact.digest} has no passing, ` +
          `digest-bound scan outcome — every cross-boundary artifact must carry a passing scan whose ` +
          `scanned digest matches (fail-closed, M17.3 E6)`
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

/**
 * Export a Promotion Bundle, HARD-GATING on scans at the boundary and CO-SIGNING a self-binding
 * manifest (M17.3 E6). Takes a `Db` (not a single `TenantTx`) because it spans two transaction
 * phases around an out-of-transaction cosign subprocess — the same "never hold a pooled connection
 * open across a cosign subprocess" invariant `cosign-keys.ts`/E5 already honor:
 *   1. Resolve the org's cosign keypair (may KEYGEN-subprocess on first use) OUTSIDE any tx.
 *   2. tx: gather change/evidence/artifacts + run the scan gate. On refusal, persist a `block`
 *      Decision + audit event and RETURN the refusal (the tx COMMITS, so `decisionId` survives).
 *   3. Cosign-sign the manifest OUTSIDE any tx (materialize key → sign-blob → scrub, in @scp/cosign).
 *   4. tx: Ed25519-checksum + sign the (manifest-EXCLUDED) envelope, record the transfer, return.
 */
export async function exportPromotionBundle(
  db: Db,
  input: ExportPromotionInput
): Promise<ExportPromotionResult> {
  const actorObjectId = input.actorObjectId ?? FEDERATION_IMPORT_ACTOR_ID;

  // Phase 1 — resolve the cosign signing keypair OUTSIDE any tx (first-use keygen runs a subprocess
  // that must never execute while a pooled DB connection is held open).
  const cosignPair = await ensureInstanceCosignKey(db, input.orgId);

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

    // M17.3 (E3): build the TYPED artifact set from the change's tracked refs, then project the flat
    // `artifactDigests` FROM it. `artifacts` is the rich source; `artifactDigests` is the backward-
    // compatible flattening an older outpost reads. The OCI digest(s) are carried VERBATIM (identical
    // to the pre-E3 projection); the SBOM travels as a `blob` entry.
    const sourceRef = change.sourceRef ?? {};
    const artifactDigest =
      (sourceRef as Record<string, unknown>).artifact_digest ??
      (sourceRef as Record<string, unknown>).artifactDigest;
    const ociDigests =
      typeof artifactDigest === "string"
        ? [artifactDigest]
        : Array.isArray(artifactDigest)
          ? artifactDigest.filter((d): d is string => typeof d === "string")
          : [];

    const artifactSet: ArtifactRef[] = ociDigests.map((digest) => ({ type: "oci", digest }));

    const sbom = (sourceRef as Record<string, unknown>).sbom;
    if (sbom && typeof sbom === "object" && !Array.isArray(sbom)) {
      const sbomRef = sbom as Record<string, unknown>;
      if (typeof sbomRef.digest === "string") {
        const blob: ArtifactRef = { type: "blob", digest: sbomRef.digest };
        if (typeof sbomRef.location === "string") blob.location = sbomRef.location;
        if (typeof sbomRef.format === "string") blob.format = sbomRef.format;
        if (typeof sbomRef.signatureRef === "string") blob.signatureRef = sbomRef.signatureRef;
        artifactSet.push(blob);
      }
    }

    // M17.3 (E6) EXPORT SCAN GATE — HARD-REFUSE, fail-closed. The SBOM (`type: "blob"`) is EXEMPT
    // (it is the scan's output). EDGE CASE: a promotion carrying NO substantive artifact has nothing
    // to scan, so the gate passes VACUOUSLY — a metadata-only promotion (config/policy-only, no
    // oci/rpm/deb/npm/config/infra content) still exports (and still carries a signed manifest over
    // an empty artifact set). "Every substantive artifact is scanned" is trivially true of zero.
    const substantiveArtifacts = artifactSet.filter((a) => a.type !== "blob");
    const gate = evaluatePromotionScanGate(substantiveArtifacts, controlOutcomes);
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
          failingArtifact: { type: gate.artifactType, digest: gate.artifactDigest }
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
      sourceRef: change.sourceRef
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
      checksum
    });

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

/**
 * M17.4(a) / M15.2 — the RECEIVER-side verification of the commander's cosign-signed SELF-BINDING
 * promotion manifest (the send-side counterpart is `buildPromotionManifest` + the E6 export gate).
 * This is the outpost's universal pre-deploy validation (ADR-0011): ONE implementation runs at
 * EVERY receiving hop — a commander importing from a peer, or (M15.2) an outpost verifying a
 * commander-promoted artifact BEFORE deploy. The outpost NEVER re-scans — receiver-side
 * never-re-scan is UNCHANGED (ADR-0013/ADR-0015 §6a); the one scan now executes at the commander,
 * before signing, per promotion journey (ADR-0020) — this gate re-verifies the signed metadata, it
 * does not re-run any scan.
 *
 * Metadata-only + coordinate-not-execute: it checks digests/signatures/identity, never artifact
 * BYTES (those are absent from a federation bundle — ADR-0009). Per-artifact `cosign verify` of each
 * artifact's ORIGIN `signatureRef` is part-(b), DEFERRED to M15.5 (the unresolved artifact-bytes
 * channel — ADR-0015 §6b, the "honest open gap"): it needs the bytes at the outpost's Gitea/registry
 * and is NOT half-built here.
 *
 * FAIL-CLOSED over five properties, in order:
 *  1. SIGNATURE — `cosign verify-blob canonicalStringify(manifest)` against the EXPORTER peer's
 *     registered cosign pubkey (E5) must return true (the EXACT bytes phase-3 of export signed).
 *  2. SET-EQUALITY — `bundle.artifacts` (typed, `undefined`→`[]`) EXACTLY equals `manifest.artifacts`
 *     as a MULTISET over `{type,digest,signatureRef}` (equal cardinality + membership; no
 *     add/substitute). Manifest entries carry no `location`/`format`, so only those three fields are
 *     compared. This is the ONLY thing protecting `bundle.artifacts` — it is EXCLUDED from the
 *     Ed25519 checksum (E3), so nothing else binds it.
 *  3. THE TIE — `bundle.artifactDigests` (which IS in the Ed25519 checksum) EQUALS
 *     `manifest.artifacts.map(a => a.digest)` as a multiset. This binds the cosign-anchored set to the
 *     Ed25519-anchored set so neither can be tampered independently of the other.
 *  4. SELF-BINDING — the manifest's `sourceChangeObjectId`/`exporterDomainId`/`peerDomainId`/
 *     `changeUrn` each equal the bundle's, blocking a manifest lifted from a different bundle.
 *  5. BACK-COMPAT + DOWNGRADE DEFENSE — absent manifest AND the peer has NO cosign key => ACCEPT
 *     (a genuine pre-E5/E6 Ed25519-only bundle). Absent manifest BUT the peer HAS a cosign key =>
 *     DOWNGRADE ATTACK => FAIL-CLOSED (an attacker stripped the manifest to dodge this gate). A
 *     PRESENT manifest is ALWAYS verified — including when no cosign key is registered, which then
 *     fails closed (present but unverifiable).
 *
 * Pure of the DB and of any transaction: the ONLY side effect is the `verifyBlob` cosign SUBPROCESS
 * (step 1), which is exactly why `importPromotionBundle` calls this OUTSIDE its apply tx (the
 * codebase forbids holding a pooled connection across a cosign subprocess — see `exportPromotionBundle`).
 */
export interface ManifestVerifyContext {
  reason: string;
  detail: Record<string, unknown>;
}
export type ManifestVerifyResult = { ok: true } | ({ ok: false } & ManifestVerifyContext);

/** Canonical multiset key for an artifact entry — only the three fields the manifest carries. */
function artifactKey(a: { type: string; digest: string; signatureRef?: string | undefined }): string {
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
      reason: "promotion manifest sourceChangeObjectId does not bind this bundle (rejected, fail-closed)",
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
      reason: "promotion manifest exporterDomainId does not bind this bundle (rejected, fail-closed)",
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

/**
 * Import a Promotion Bundle. Takes a `Db` (not a single `TenantTx`) because M17.4(a)'s manifest
 * verification runs a cosign `verify-blob` SUBPROCESS, and the codebase forbids holding a pooled
 * connection open across a cosign subprocess (`exportPromotionBundle` splits phases for exactly this
 * reason). Three phases around the out-of-tx subprocess:
 *   1. tx: address-to-self + resolve exporter peer + Ed25519 checksum/signature gate + resolve the
 *      peer's cosign pubkey. (No cosign subprocess yet — pure DB.)
 *   2. NO tx: M17.4(a) `verifyPromotionManifest` — the cosign subprocess + set/tie/self-binding/
 *      downgrade checks. On failure, persist a `block` Decision + hash-chained audit event in a
 *      fresh tx and throw a 409 carrying `decision_id` (mirrors the export gate — DESIGN §6/§10.4).
 *   3. tx: apply — propose the local Change, attach approval evidence, record the transfer.
 */
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

    // 1. Bundle-level checksum + signature — fail closed, exactly like a sync bundle. Checksum covers
    //    the header (M6 review fix — CRITICAL). A promotion bundle carries no journal sequence to
    //    anchor key selection to, so it is verified against the peer's CURRENT (non-superseded) key —
    //    NEVER a timestamp-selected key (that was the `bundle.header.exportedAt` /
    //    `evidence.record.timestamp` backdating vector). A rotated-away key is hard-revoked for
    //    promotion: a bundle it signed no longer verifies once the peer has rotated.
    //    `artifacts` (M17.3 E3) is EXCLUDED from this recompute exactly as it is at export — the
    //    typed set never participates in checksum/signature verification in the EXPAND phase.
    if (computeBundleChecksum(promotionChecksumPayload(bundle)) !== bundle.checksum) {
      throw conflict("promotion bundle checksum mismatch (rejected, fail-closed)");
    }
    const currentKey = await currentPeerPublicKey(tx, orgId, peer.id);
    if (!currentKey || !verifyBundleSignature(bundle.checksum, bundle.bundleSignature, currentKey)) {
      throw conflict("promotion bundle signature verification failed (rejected, fail-closed)");
    }

    // M17.4(a): resolve the EXPORTER peer's cosign verification key — the SAME non-superseded window
    // the Ed25519 key rode. `null` when the peer has none (governs back-compat vs downgrade below).
    const exporterCosignPubkey = await currentPeerCosignPublicKey(tx, orgId, peer.id);
    return { peerId: peer.id, exporterCosignPubkey };
  });

  // Phase 2 — M17.4(a) / M15.2 manifest verification, OUTSIDE any tx (cosign `verify-blob` subprocess).
  // This is metadata-only (digests/signatures/identity) and complete without artifact BYTES: it
  // proves "these are the authorized digests" and records the verified `artifacts[]` set on the
  // imported change's `sourceRef`. M17.4(b) is the complementary BYTE verify — per-artifact
  // `cosign verify` of each authorized artifact at the outpost's local registry where the bytes land
  // — and it deliberately runs LATER, as a PRE-DEPLOY GATE (coordination/pre-deploy-gate.ts), NOT
  // here: a federation bundle carries no bytes (ADR-0009) and the operator side-loads them AFTER this
  // metadata import. Byte TRANSPORT itself remains M15.5.
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
  peerId: string
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

  // M12 P4B (owner ruling, coupled-pipelines.md §8 Q2): STRIP `requires` on promotion. The COMMANDER
  // is the single coordination point — it held the software release in `waiting` until its infra
  // prerequisite reached `validating` there, and its promotion of this bundle IS the go-ahead. Re-
  // evaluating the coupling locally in the receiving outpost would either be redundant (the commander
  // already enforced it) or DEADLOCK (an outpost whose infra is commander-driven has no local infra
  // change to satisfy the key). `provides` is preserved — a promoted infra change should still be
  // able to satisfy a LOCALLY-authored outpost waiter.
  const { requires: _requiresStrippedOnPromotion, ...promotedProperties } = bundle.change
    .properties as Record<string, unknown>;

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
      ...(bundle.manifestSignature ? { manifestSignature: bundle.manifestSignature } : {})
    },
    targets,
    importedFromDomain: peerId
  });

  // M12 P4B §8 Q2, the AUDIT half of the strip above: when the bundle's change actually CARRIED a
  // `requires` that was stripped, the strip itself is an engine verdict (charter principle 6 —
  // every engine verdict persists a Decision with its inputs) and must not be invisible. Written in
  // the SAME transaction as the import, with the stripped requirements pinned VERBATIM in the
  // Decision inputs, so an outpost operator asking "why didn't this coupled release wait here?" gets
  // a durable, queryable answer rather than an absence. No Decision when nothing was stripped — the
  // common uncoupled promotion stays byte-identical.
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

  // 3. Validate each approval attestation against the EXPORTING domain's OWN registered key —
  //    never merely against the key embedded in the attestation. Stored as evidence regardless of
  //    outcome (rejected ones are visible/auditable AS rejected, not silently dropped).
  let accepted = 0;
  let rejected = 0;
  for (const evidence of bundle.approvals) {
    // Validate against the peer's CURRENT registered key — never the attestation's own embedded
    // `publicKey` (self-consistent by construction, so trusting it would let an attacker sign an
    // "approval" with a throwaway key and mislabel its origin) and never a key selected by the
    // signer-chosen `evidence.record.timestamp` (the backdating vector — M6 review fix, CRITICAL).
    // An approval signed by a since-rotated key is marked verified:false (non-fatal — the local
    // change must earn its OWN approvals regardless), preserving compromise recovery.
    const registeredKey = await currentPeerPublicKey(tx, orgId, peerId);
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
    checksum: bundle.checksum
  });

  return {
    localChangeObjectId: change.id,
    localChangeUrn: change.urn,
    importedFromDomain: peerId,
    approvalsAccepted: accepted,
    approvalsRejected: rejected
  };
}
