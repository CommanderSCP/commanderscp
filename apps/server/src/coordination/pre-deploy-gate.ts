/** The pre-deploy byte-verification gate. See docs/coordination.md §718. */
import type { ArtifactRef } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { currentPeerCosignPublicKey } from "../federation/peers-repo.js";
import {
  LocationRegistryReader,
  parseRegistryHostList,
  verifyAuthorizedArtifactSet,
  type ArtifactRegistryReader
} from "../federation/artifact-verify.js";
import { insertDecision, latestDecisionForSubjectKind } from "./decisions-repo.js";
import { markChangeReconcileBlocked, type ChangeRow } from "./changes-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

export const PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND = "pre-deploy-artifact-verify";

/** Registry hosts this gate may reach without TLS. See docs/coordination.md §719. */
export function artifactInsecureRegistryHosts(): string[] {
  return parseRegistryHostList(process.env.SCP_ARTIFACT_INSECURE_HOSTS);
}

/** The subset of a change's `sourceRef` this gate reads — the fields M17.4(a) recorded on import. */
interface CrossBoundaryManifestRef {
  artifacts: ArtifactRef[];
  exporterDomainId: string | null;
}

/** Does this change carry a verified cross-boundary manifest. See docs/coordination.md §720. */
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

/** The audit action for a passing pre-deploy verify. See docs/coordination.md §721. */
export const PRE_DEPLOY_ARTIFACT_VERIFY_PASSED_AUDIT_ACTION =
  "change.pre_deploy.artifact_verify.passed";

/** An artifact set as an order-independent, comparable key — the identity an `allow` verdict is
 *  ABOUT. Two verdicts cover "the same verified set" iff these match. */
function artifactSetKey(artifacts: { type: string; digest: string }[]): string {
  return artifacts
    .map((a) => `${a.type}:${a.digest}`)
    .sort()
    .join("|");
}

/** The authorized artifact set a persisted verdict covered, read defensively out of its opaque
 *  `inputContext` (JSONB — a malformed value must yield "no match", never a throw and never a
 *  false match against the empty set, hence `null` rather than `[]`). */
function decisionArtifactSetKey(inputContext: Record<string, unknown>): string | null {
  const raw = inputContext.authorizedArtifacts;
  if (!Array.isArray(raw)) return null;
  const parsed: { type: string; digest: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { type, digest } = entry as Record<string, unknown>;
    if (typeof type !== "string" || typeof digest !== "string") return null;
    parsed.push({ type, digest });
  }
  return artifactSetKey(parsed);
}

export interface PreDeployGateResult {
  blocked: boolean;
  /** The persisted verdict's id — a `block` Decision when `blocked`, an `allow` Decision when a
   *  real verify ran and passed (M16.1 I2). ABSENT when nothing was verified at all: a
   *  domain-local/unmanifested change, or a metadata-only promotion with zero artifacts. */
  decisionId?: string;
}

/** Runs the byte-verify gate for one qualifying change. See docs/coordination.md §722. */
export async function runPreDeployArtifactGate(
  db: Db,
  orgId: string,
  change: ChangeRow,
  reader: ArtifactRegistryReader = new LocationRegistryReader()
): Promise<PreDeployGateResult> {
  // THE TWO VACUOUS EXITS. See docs/coordination.md §723.
  const manifestRef = crossBoundaryManifestOf(change);
  if (!manifestRef) return { blocked: false };

  // A metadata-only promotion (no substantive bytes) has nothing to byte-verify → pass vacuously.
  if (manifestRef.artifacts.length === 0) return { blocked: false };

  // Resolve the EXPORTER peer's distributed cosign public key (the same trust anchor M17.4(a) used).
  // `importedFromDomain` is the local federation_peers row id for the promoting peer.
  const cosignPublicKeyPem = await withTenantTx(db, orgId, (tx) =>
    // Non-null by construction: `crossBoundaryManifestOf` returned null above when this is unset.
    currentPeerCosignPublicKey(tx, orgId, change.importedFromDomain!)
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
    // PER-HOST TLS scoping. See docs/coordination.md §724.
    const insecureHosts = artifactInsecureRegistryHosts();
    result = await verifyAuthorizedArtifactSet({
      artifacts: manifestRef.artifacts,
      cosignPublicKeyPem,
      reader,
      allowInsecureRegistry: (host) => insecureHosts.includes(host.toLowerCase())
    });
    if (result.ok) {
      // PASS. Every artifact present + authentic. See docs/coordination.md §725.
      const verifiedArtifacts = manifestRef.artifacts.map((a) => ({
        type: a.type,
        digest: a.digest
      }));
      const passReason =
        `all ${manifestRef.artifacts.length} authorized artifact(s) verified present and ` +
        `signed by the exporting peer's cosign key — pre-deploy artifact verification passed`;
      // Idempotent, against the per-tick Decision flood. See docs/coordination.md §726.
      const passDecisionId = await withTenantTx(db, orgId, async (tx) => {
        const previous = await latestDecisionForSubjectKind(
          tx,
          orgId,
          change.objectId,
          PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND
        );
        if (
          previous?.verdict === "allow" &&
          decisionArtifactSetKey(previous.inputContext) === artifactSetKey(verifiedArtifacts)
        ) {
          return previous.id;
        }
        const decision = await insertDecision(tx, {
          orgId,
          kind: PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND,
          subjectId: change.objectId,
          verdict: "allow",
          inputContext: {
            exporterDomainId: manifestRef.exporterDomainId,
            importedFromDomain: change.importedFromDomain,
            authorizedArtifacts: verifiedArtifacts,
            failing: null,
            peerHasCosignKey: true
          },
          reasonTree: { summary: passReason }
        });
        await appendAuditEvent(tx, {
          orgId,
          actorId: SYSTEM_ACTOR_ID,
          action: PRE_DEPLOY_ARTIFACT_VERIFY_PASSED_AUDIT_ACTION,
          subjectId: change.objectId,
          reason: passReason,
          decisionId: decision.id,
          requestId: "reconcile"
        });
        return decision.id;
      });
      return { blocked: false, decisionId: passDecisionId };
    }
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
          result?.failing.map((f) => ({ type: f.type, digest: f.digest, reason: f.reason })) ??
          null,
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
