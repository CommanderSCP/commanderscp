/**
 * M17.4(b) — the PRE-DEPLOY per-artifact byte-verification GATE, wired into the reconcile loop.
 *
 * ## The seam
 *
 * A promoted change reaches its deploy executor through reconcile.ts: `coordinated -> executing`
 * (advanceCoordinatedChanges, "beginning wave execution") is the edge AFTER which
 * `reconcileExecutingChange` triggers each wave target's deploy executor via
 * `triggerWaveTarget` -> `host.executor(...).trigger(...)`. So the LAST safe point to gate a whole
 * change BEFORE any deploy fires is right there, on the `coordinated -> executing` edge — this gate
 * runs there, once, before the transition.
 *
 * ## Scope (ADR-0013 domain-local exemption — do NOT gate ordinary local changes)
 *
 * The gate fires ONLY for a change carrying a VERIFIED CROSS-BOUNDARY promotion manifest — i.e. an
 * imported change whose `sourceRef` carries the M17.4(a)-verified `promotionManifest` + the typed
 * `artifacts[]` authorized set, imported from a known peer. A domain-local change (no manifest)
 * and a pre-M17.4a/pre-manifest imported change are UNTOUCHED and deploy exactly as before.
 *
 * ## Behavior
 *
 * The authorized set = `sourceRef.artifacts` (M17.4(a) already asserted it equals the signed
 * manifest set). For each artifact this verifies the BYTES are present in the reachable registry
 * and their signature verifies against the EXPORTER peer's distributed cosign public key
 * (`currentPeerCosignPublicKey`). If ANY artifact fails/absent: persist a `block` Decision +
 * hash-chained audit event and PARK the change (`markChangeReconcileBlocked`) — the deploy is NOT
 * triggered. Fail-closed. On success the caller proceeds with the normal transition.
 */
import type { ArtifactRef } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { currentPeerCosignPublicKey } from "../federation/peers-repo.js";
import {
  LocationRegistryReader,
  verifyAuthorizedArtifactSet,
  type ArtifactRegistryReader
} from "../federation/artifact-verify.js";
import { insertDecision } from "./decisions-repo.js";
import { markChangeReconcileBlocked, type ChangeRow } from "./changes-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

export const PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND = "pre-deploy-artifact-verify";

/** The subset of a change's `sourceRef` this gate reads — the fields M17.4(a) recorded on import. */
interface CrossBoundaryManifestRef {
  artifacts: ArtifactRef[];
  exporterDomainId: string | null;
}

/**
 * Does this change carry a VERIFIED cross-boundary promotion manifest (the ONLY changes this gate
 * fires for)? A change qualifies iff its `sourceRef` carries BOTH the M17.4(a) `promotionManifest`
 * AND the typed `artifacts[]` set, and it was imported from a peer (`importedFromDomain`). Returns
 * the authorized artifact set (may be empty — a metadata-only promotion) or `null` (not gated).
 */
export function crossBoundaryManifestOf(change: ChangeRow): CrossBoundaryManifestRef | null {
  if (!change.importedFromDomain) return null; // domain-local: exempt (ADR-0013).
  const sourceRef = (change.sourceRef ?? null) as Record<string, unknown> | null;
  if (!sourceRef) return null;
  if (typeof sourceRef.promotionManifest !== "object" || sourceRef.promotionManifest === null) {
    return null; // no verified manifest → pre-M17.4a / not a signed cross-boundary promotion.
  }
  const rawArtifacts = sourceRef.artifacts;
  if (!Array.isArray(rawArtifacts)) return null; // manifest but no typed set → nothing to byte-verify.
  const artifacts = rawArtifacts.filter(
    (a): a is ArtifactRef =>
      typeof a === "object" &&
      a !== null &&
      ((a as ArtifactRef).type === "oci" || (a as ArtifactRef).type === "blob") &&
      typeof (a as ArtifactRef).digest === "string"
  );
  const exporterDomainId =
    typeof sourceRef.promotedFromDomain === "string" ? sourceRef.promotedFromDomain : null;
  return { artifacts, exporterDomainId };
}

export interface PreDeployGateResult {
  blocked: boolean;
  decisionId?: string;
}

/**
 * Run the per-artifact byte-verify gate for one change if it carries a verified cross-boundary
 * manifest; otherwise a no-op (`{ blocked: false }`). Runs its cosign `verify`/`verify-blob`
 * subprocesses OUTSIDE any transaction (the codebase forbids holding a pooled connection across a
 * cosign subprocess) and opens its own short txs for the pubkey read and the block persist.
 *
 * `reader` is injectable for tests; production uses {@link LocationRegistryReader}.
 */
export async function runPreDeployArtifactGate(
  db: Db,
  orgId: string,
  change: ChangeRow,
  reader: ArtifactRegistryReader = new LocationRegistryReader()
): Promise<PreDeployGateResult> {
  const manifestRef = crossBoundaryManifestOf(change);
  if (!manifestRef) return { blocked: false }; // domain-local / no manifest — not gated.

  // A metadata-only promotion (no substantive bytes) has nothing to byte-verify → pass vacuously.
  if (manifestRef.artifacts.length === 0) return { blocked: false };

  // Resolve the EXPORTER peer's distributed cosign public key (the same trust anchor M17.4(a) used).
  // `importedFromDomain` is the local federation_peers row id for the promoting peer.
  const cosignPublicKeyPem = await withTenantTx(db, orgId, (tx) =>
    currentPeerCosignPublicKey(tx, orgId, change.importedFromDomain as string)
  );

  let result: Awaited<ReturnType<typeof verifyAuthorizedArtifactSet>> | null = null;
  let blockReason: string;
  if (!cosignPublicKeyPem) {
    // The manifest was verified at import against this peer's cosign key, so a now-absent key is an
    // anomaly (key un-paired between import and deploy). Cannot verify → fail closed.
    blockReason =
      "no exporter cosign public key registered for the promoting peer — cannot verify artifact " +
      "signatures at deploy (rejected, fail-closed); re-pair the peer to exchange its E5 key";
  } else {
    result = await verifyAuthorizedArtifactSet({
      artifacts: manifestRef.artifacts,
      cosignPublicKeyPem,
      reader,
      // The outpost-local registry is commonly HTTP/self-signed; the cosign SIGNATURE is the trust
      // anchor, not registry TLS (see artifact-verify.ts / verifyImage).
      allowInsecureRegistry: true
    });
    if (result.ok) return { blocked: false }; // every artifact present + authentic — deploy proceeds.
    blockReason =
      `per-artifact byte verification failed for ${result.failing.length} of ` +
      `${manifestRef.artifacts.length} authorized artifact(s) — ` +
      result.failing.map((f) => `${f.type} ${f.digest}: ${f.reason}`).join("; ");
  }

  // BLOCK: persist a block Decision + hash-chained audit event and PARK the change (fail-closed).
  const decisionId = await withTenantTx(db, orgId, async (tx) => {
    const decision = await insertDecision(tx, {
      orgId,
      kind: PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND,
      subjectId: change.objectId,
      verdict: "block",
      inputContext: {
        exporterDomainId: manifestRef.exporterDomainId,
        importedFromDomain: change.importedFromDomain,
        authorizedArtifacts: manifestRef.artifacts.map((a) => ({ type: a.type, digest: a.digest })),
        failing:
          result?.failing.map((f) => ({ type: f.type, digest: f.digest, reason: f.reason })) ?? null,
        peerHasCosignKey: Boolean(cosignPublicKeyPem)
      },
      reasonTree: { summary: blockReason }
    });
    await appendAuditEvent(tx, {
      orgId,
      actorId: SYSTEM_ACTOR_ID,
      action: "change.pre_deploy.artifact_verify.blocked",
      subjectId: change.objectId,
      reason: blockReason,
      decisionId: decision.id,
      requestId: "reconcile"
    });
    // Park the change out of the reconcile sweep — it awaits operator remediation (side-load the
    // missing/authentic bytes, then cancel/rollback/re-propose). `listChangeRowsInStates` excludes
    // `reconcile_blocked_at` changes, so this gate runs exactly once.
    await markChangeReconcileBlocked(tx, orgId, change.objectId);
    return decision.id;
  });

  return { blocked: true, decisionId };
}
