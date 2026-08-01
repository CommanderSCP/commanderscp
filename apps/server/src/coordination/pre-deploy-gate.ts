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
  parseRegistryHostList,
  verifyAuthorizedArtifactSet,
  type ArtifactRegistryReader
} from "../federation/artifact-verify.js";
import { insertDecision, latestDecisionForSubjectKind } from "./decisions-repo.js";
import { markChangeReconcileBlocked, type ChangeRow } from "./changes-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

export const PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND = "pre-deploy-artifact-verify";

/**
 * `SCP_ARTIFACT_INSECURE_HOSTS` — comma-separated registry `host[:port]` entries this gate's
 * per-artifact `cosign verify` may dial WITHOUT registry TLS verification
 * (`--allow-insecure-registry`), scoped PER HOST via the predicate form of
 * `AllowInsecureRegistry` — exactly the relay's `SCP_RELAY_INSECURE_HOSTS` posture, as a SEPARATE
 * variable (different subsystem, different config surface) sharing the one parse
 * ({@link parseRegistryHostList}). Hosts NOT listed get full TLS verification even when
 * egress-allowlisted in `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` — the two lists answer different
 * questions ("may we dial it at all?" vs "may TLS verification be skipped?"). Listing a
 * plain-HTTP/self-signed outpost-local registry here is safe: the cosign SIGNATURE over the
 * authorized digest — not transport TLS — is the trust anchor, so a TLS MITM can only cause a
 * fail-closed denial. UNSET = TLS verification everywhere (secure default).
 */
export function artifactInsecureRegistryHosts(): string[] {
  return parseRegistryHostList(process.env.SCP_ARTIFACT_INSECURE_HOSTS);
}

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

/**
 * M16.1 (I2) — the audit action for a PASSING pre-deploy verify, sibling of the long-standing
 * `change.pre_deploy.artifact_verify.blocked`. Written ONLY when a real per-artifact verify ran and
 * every artifact passed; see {@link runPreDeployArtifactGate}'s "the two vacuous exits" note.
 */
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
  // ===========================================================================================
  // THE TWO VACUOUS EXITS. Both return here writing NOTHING, and must stay that way (M16.1 I2).
  // Neither of them RAN a verification, so an `allow` Decision at either would assert that this
  // change's artifacts were checked and found authentic when nothing was ever looked at — a
  // fabricated attestation, and strictly worse than the silence it replaced. The `boundarySegment`
  // read model depends on this: it reports the validate phase as verified ONLY on the strength of
  // an `allow` Decision of this kind, so writing one here would fabricate a pass in the UI too.
  // Pinned by `pre-deploy-gate.integration.test.ts` SCOPE (e1)/(e2) and by the metadata-only axis.
  // ===========================================================================================
  const manifestRef = crossBoundaryManifestOf(change);
  if (!manifestRef) return { blocked: false }; // domain-local / no manifest — not gated.

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
    // PER-HOST TLS scoping (mirrors the relay's SCP_RELAY_INSECURE_HOSTS): the outpost-local
    // registry is commonly HTTP/self-signed and the cosign SIGNATURE — not registry TLS — is the
    // trust anchor, but TLS-off is granted only to hosts the operator explicitly listed in
    // SCP_ARTIFACT_INSECURE_HOSTS; every other host keeps full TLS verification. Never a blanket
    // `true`.
    const insecureHosts = artifactInsecureRegistryHosts();
    result = await verifyAuthorizedArtifactSet({
      artifacts: manifestRef.artifacts,
      cosignPublicKeyPem,
      reader,
      allowInsecureRegistry: (host) => insecureHosts.includes(host.toLowerCase())
    });
    if (result.ok) {
      // PASS. Every artifact present + authentic — deploy proceeds, AND the verdict is persisted.
      //
      // M16.1 (I2): before this, a passing verify returned here having written nothing at all, so
      // the strongest statement the system could make about a successfully verified change was an
      // ABSENCE — indistinguishable from "never gated" and from "gate never ran". That made
      // "validated" unrenderable even at the receiving outpost without fabricating it. This mirrors
      // the block path below exactly (same Decision kind, same subject, same input context, a
      // sibling `.passed` audit action carrying the decision_id), so charter principle 6 holds for
      // the allow verdict as it already did for the deny.
      //
      // The cosign subprocess window has CLOSED by this line (`verifyAuthorizedArtifactSet` has
      // returned), so opening a tenant tx here honors this file's own invariant: never hold a
      // pooled connection across a cosign subprocess. Nothing else is written — no state change,
      // no park — this gate still drives nothing on the pass path.
      const verifiedArtifacts = manifestRef.artifacts.map((a) => ({
        type: a.type,
        digest: a.digest
      }));
      const passReason =
        `all ${manifestRef.artifacts.length} authorized artifact(s) verified present and ` +
        `signed by the exporting peer's cosign key — pre-deploy artifact verification passed`;
      //
      // IDEMPOTENT (M16.1 review B5 — the per-tick Decision/audit flood). Both callers in
      // reconcile.ts run this gate on EVERY sweep tick, and one of them —
      // `advanceWaitingChanges` — runs it for a change that may sit in `waiting` for hours while
      // a cross-change prerequisite is outstanding. Before I2 a pass wrote nothing, so ticking was
      // free; persisting made every one of those ticks append an `allow` Decision AND a
      // hash-chained `.passed` audit event, which is the "blocked-gate flood" (~30k rows/day per
      // waiter) that `advanceWaitingChanges`'s own doc comment forbids, arriving through a
      // different door. It is unreachable today only by the coincidence that
      // `applyPromotionImport` strips `requires`, which is exactly why that call site is labelled
      // defence-in-depth: it must be correct on its own.
      //
      // So: re-record only what is NEW. If the LATEST verdict of this kind for this change is
      // already an `allow` over the SAME authorized set, that statement is still true and still
      // on the record — a second identical row would add no information and no auditability, only
      // volume, and would make the audit chain claim a fresh event where nothing happened.
      // "Latest" (not "any"), so a later `block` is never shadowed by an older allow, matching
      // `boundary-segment.ts`'s latest-verdict-wins read.
      //
      // The VERIFY still runs every tick — deliberately. Skipping it would let bytes that vanished
      // from the registry mid-wait sail into `executing` on an old verdict; the gate is fail-closed
      // and stays that way. Only the WRITE is suppressed.
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
