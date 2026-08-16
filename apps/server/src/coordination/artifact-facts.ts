import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { PromotionManifestSchema, ScanEvidenceSchema, SbomRefSchema } from "@scp/schemas";
import type {
  ArtifactRef,
  ComponentPipelineArtifact,
  ComponentPipelineScanRunSummary,
  ControlOutcomeStatus
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, controlRuns, objects } from "../db/schema.js";
import { MANAGED_SCAN_CONTROL_OBJECT_ID } from "../federation/promotion-scan-step.js";
import { promotionExportsOf } from "../federation/boundary-bundle-ref.js";

/**
 * ARTIFACT FACTS FOR A COMPONENT'S PIPELINE (pipeline-substrate-registry-scan.md §9.3).
 *
 * The pipeline is component-scoped; every fact here is CHANGE-scoped — a digest, an SBOM reference,
 * a scan verdict, a signed promotion manifest all belong to one `changes` row. So this module PICKS
 * a change and STATES the pick, then reads what that change's row and its `control_runs` hold.
 * Nothing is inferred: no digest is derived from a name, no scan is assumed from a policy, no
 * signature is claimed that is not stamped on the row.
 *
 * ## The two readers this module is the ONE home of
 *
 * `ociDigestsOfSourceRef` / `artifactSetOfSourceRef` are the export projection's OWN reader of the
 * change's tracked artifacts (`promotion-repo.ts` — the E3 typed artifact set the promotion bundle
 * carries and the E6 gate scans), factored here so the projection and the exporter read the SAME
 * digests the SAME way; a third copy would be a third place for the two to disagree. The managed
 * scan step (`promotion-scan-step.ts::ociDigestsOf`, which then normalizes to `sha256:<hex>`
 * because it must build a pull ref) and the gate orchestrator's control-context digest
 * (`gate-orchestrator.ts::resolveChangeArtifactDigest`, first digest) delegate here too — ONE
 * function, every reader (§10.4: the importer's `artifactDigests[]` widened all of them at once).
 * The exporter's set is VERBATIM (no normalization — the bundle and the gate carry the digest as
 * tracked).
 *
 * `evaluatePromotionScanGate` is the E6 predicate itself (moved here from `promotion-repo.ts`,
 * unchanged), so `artifact.exportGate` is a READ-ONLY re-run of the exact check the export applies,
 * not a re-implementation that could drift from it.
 */

/** The three `sourceRef` keys under which a change tracks its OCI digest(s), in read order. The
 *  SQL prefilter in `pickArtifactChange` probes exactly this list — keep the two together. */
export const ARTIFACT_DIGEST_SOURCE_REF_KEYS = [
  "artifact_digest",
  "artifactDigest",
  "artifactDigests"
] as const;

/** One key's value as a digest list: string ⇒ `[it]`, array ⇒ its string members, else `[]`. */
function digestListOf(raw: unknown): string[] {
  return typeof raw === "string"
    ? [raw]
    : Array.isArray(raw)
      ? raw.filter((d): d is string => typeof d === "string")
      : [];
}

/** The OCI digests a change tracks, VERBATIM, de-duplicated, in a deterministic order:
 *  `sourceRef.artifact_digest` (canonical, lifted by `canonicalizeSourceRef`) ELSE
 *  `sourceRef.artifactDigest` (the report's own key) — the origin's tracked digest(s), string or
 *  string[] — FOLLOWED BY the importer's `sourceRef.artifactDigests` (string[]; §10.4 — stamped on a
 *  promoted change at import beside `promotionManifest`, the flat digest list the Ed25519 checksum
 *  anchors). The two are a UNION, not a preference: an imported change usually carries the origin's
 *  key too (the exporter's `sourceRef` is spread onto the import), and when both name the same
 *  digest the union says it once; a change stamped ONLY by the importer is picked by the stamp
 *  alone. Malformed ⇒ `[]`. */
export function ociDigestsOfSourceRef(sourceRef: unknown): string[] {
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) return [];
  const ref = sourceRef as Record<string, unknown>;
  const origin = digestListOf(ref.artifact_digest ?? ref.artifactDigest);
  const imported = digestListOf(ref.artifactDigests);
  return [...new Set([...origin, ...imported])];
}

/**
 * M17.3 (E3): the TYPED artifact set a change's tracked refs describe — the OCI digest(s) VERBATIM,
 * plus the SBOM as a `blob` entry when `sourceRef.sbom` carries a string `digest` (its
 * `location`/`format`/`signatureRef` ride along when they are strings). This is what the promotion
 * bundle carries as `artifacts[]` and what the E6 gate filters to its substantive set.
 */
export function artifactSetOfSourceRef(sourceRef: unknown): ArtifactRef[] {
  const artifactSet: ArtifactRef[] = ociDigestsOfSourceRef(sourceRef).map((digest) => ({
    type: "oci",
    digest
  }));
  if (!sourceRef || typeof sourceRef !== "object" || Array.isArray(sourceRef)) return artifactSet;
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
  return artifactSet;
}

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
export function evaluatePromotionScanGate(
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

/** One candidate change, as the pick reads it. */
interface ChangeCandidate {
  id: string;
  name: string | null;
  createdAt: Date;
  sourceRef: unknown;
}

/**
 * THE PICK. Newest-first over `preferredChangeIds` (the stages' currents/holds — the releases the
 * pipeline is showing), the first whose `sourceRef` carries an artifact digest wins. Failing those,
 * the component's newest digest-carrying change AT ALL (a change targets a component through its
 * `properties.targets`, the same containment probe `service-board.ts` uses). Nothing ⇒ null.
 *
 * Ordered by the change's `created_at` then id (UUIDv7) — the same tiebreak `currentsByPlacement`
 * documents, so two changes proposed in one transaction still pick deterministically.
 */
async function pickArtifactChange(
  tx: TenantTx,
  orgId: string,
  componentId: string,
  preferredChangeIds: string[]
): Promise<ChangeCandidate | null> {
  const preferred = [...new Set(preferredChangeIds)];
  if (preferred.length > 0) {
    const rows = await tx
      .select({
        id: objects.id,
        name: objects.name,
        createdAt: changes.createdAt,
        sourceRef: changes.sourceRef
      })
      .from(changes)
      .innerJoin(objects, and(eq(objects.id, changes.objectId), eq(objects.orgId, changes.orgId)))
      .where(
        and(
          eq(changes.orgId, orgId),
          inArray(changes.objectId, preferred),
          isNull(objects.deletedAt)
        )
      )
      .orderBy(desc(changes.createdAt), desc(changes.objectId));
    const hit = rows.find((r) => ociDigestsOfSourceRef(r.sourceRef).length > 0);
    if (hit) return hit;
  }

  // The fallback: newest digest-carrying change of the component. The `?|` key probe is a coarse
  // SQL prefilter (either key present); the JS reader decides whether what is under it IS a digest
  // (string or string[]), which is why a bounded page is scanned rather than `LIMIT 1` trusted.
  const rows = await tx
    .select({
      id: objects.id,
      name: objects.name,
      createdAt: changes.createdAt,
      sourceRef: changes.sourceRef
    })
    .from(changes)
    .innerJoin(objects, and(eq(objects.id, changes.objectId), eq(objects.orgId, changes.orgId)))
    .where(
      and(
        eq(changes.orgId, orgId),
        eq(objects.typeId, "change"),
        isNull(objects.deletedAt),
        sql`${objects.properties} @> ${JSON.stringify({ targets: [componentId] })}::jsonb`,
        sql`${changes.sourceRef} ?| ${sql.raw(
          `array[${ARTIFACT_DIGEST_SOURCE_REF_KEYS.map((k) => `'${k}'`).join(", ")}]`
        )}`
      )
    )
    .orderBy(desc(changes.createdAt), desc(changes.objectId))
    .limit(25);
  return rows.find((r) => ociDigestsOfSourceRef(r.sourceRef).length > 0) ?? null;
}

/**
 * The scan rows of ONE change, reduced to the NEWEST per (scanner, scanned digest). Every
 * `control_runs` row whose evidence parses as `ScanEvidenceSchema` counts — the org-pipeline
 * `scan-result-control` and the commander's managed step alike (E6 identifies a scan the same
 * way); `managed` is READ off `controlObjectId` (the synthetic id), the one discriminator there is.
 */
async function scanRunsForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<{
  scans: ComponentPipelineScanRunSummary[];
  outcomes: Array<{ status: string; evidence: Record<string, unknown> }>;
}> {
  const rows = await tx
    .select({
      id: controlRuns.id,
      controlObjectId: controlRuns.controlObjectId,
      status: controlRuns.status,
      evidence: controlRuns.evidence,
      gateRef: controlRuns.gateRef,
      createdAt: controlRuns.createdAt
    })
    .from(controlRuns)
    .where(and(eq(controlRuns.orgId, orgId), eq(controlRuns.changeObjectId, changeObjectId)))
    .orderBy(desc(controlRuns.createdAt), desc(controlRuns.id));

  const outcomes: Array<{ status: string; evidence: Record<string, unknown> }> = [];
  const scans: ComponentPipelineScanRunSummary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const evidence = (row.evidence ?? {}) as Record<string, unknown>;
    const parsed = ScanEvidenceSchema.safeParse(evidence);
    if (!parsed.success) continue;
    outcomes.push({ status: row.status, evidence });
    const ev = parsed.data;
    const key = `${ev.scanner}|${ev.artifactDigest}`;
    if (seen.has(key)) continue; // newest-first ⇒ the first seen IS the newest
    seen.add(key);
    const gateRef = (row.gateRef ?? null) as Record<string, unknown> | null;
    scans.push({
      method: typeof gateRef?.method === "string" ? gateRef.method : ev.scanner,
      scanner: ev.scanner,
      scannerVersion: ev.scannerVersion,
      digest: ev.artifactDigest,
      digestMatch: ev.digestMatch,
      status: row.status as ControlOutcomeStatus,
      counts: ev.severityCounts,
      threshold: ev.threshold,
      evaluatedAt: row.createdAt.toISOString(),
      controlRunId: row.id,
      managed: row.controlObjectId === MANAGED_SCAN_CONTROL_OBJECT_ID
    });
  }
  return { scans, outcomes };
}

/**
 * THE `artifact` FIELD of a component's pipeline (§9.3), or null when no change of the component
 * carries an artifact digest.
 *
 * `preferredChangeIds` are the change ids the stages already surface (currents + holds), so the
 * artifact shown is the one the journey is showing when there is one. `peerNameOf` resolves a
 * stamped `peerDomainId` to the peer's name from this instance's `federation_peers` (null when no
 * row — the peer may have been unpaired since; the stamp is not rewritten).
 */
export async function artifactFactsForComponent(
  tx: TenantTx,
  orgId: string,
  componentId: string,
  preferredChangeIds: string[],
  peerNameOf: (peerDomainId: string) => string | null
): Promise<ComponentPipelineArtifact | null> {
  const pick = await pickArtifactChange(tx, orgId, componentId, preferredChangeIds);
  if (!pick) return null;

  const unknownFields: string[] = [];
  const digests = ociDigestsOfSourceRef(pick.sourceRef);
  const artifactSet = artifactSetOfSourceRef(pick.sourceRef);

  // SBOM — the typed reference, or a STATED unparseable one. `artifactSetOfSourceRef` (the export
  // reader) is deliberately more lenient (it needs only a string digest to carry a blob); the tile
  // shows the fields, so it takes the typed parse and says so when that fails.
  const ref =
    pick.sourceRef && typeof pick.sourceRef === "object" && !Array.isArray(pick.sourceRef)
      ? (pick.sourceRef as Record<string, unknown>)
      : {};
  let sbom: ComponentPipelineArtifact["sbom"] = null;
  if (ref.sbom !== undefined && ref.sbom !== null) {
    const parsedSbom = SbomRefSchema.safeParse(ref.sbom);
    if (parsedSbom.success) sbom = parsedSbom.data;
    else unknownFields.push("sbom:unparseable");
  }

  const { scans, outcomes } = await scanRunsForChange(tx, orgId, pick.id);

  // E6, read-only. `not_run` is "no scan evidence exists for this change at all" — distinct from
  // `fail`, which is "evidence exists and does not cover every substantive artifact with a passing,
  // digest-bound row". The predicate is the exporter's own, not a copy.
  const substantive = artifactSet.filter((a) => a.type !== "blob");
  const exportGate: ComponentPipelineArtifact["exportGate"] =
    outcomes.length === 0
      ? "not_run"
      : evaluatePromotionScanGate(substantive, outcomes).ok
        ? "pass"
        : "fail";

  const stamped = promotionExportsOf(pick.sourceRef);
  if (stamped.unparseable > 0) unknownFields.push("promotionExports:unparseable");
  const promotionExports = stamped.entries.map((e) => ({
    peerDomainId: e.peerDomainId,
    peerName: peerNameOf(e.peerDomainId),
    exportedAt: e.exportedAt,
    checksum: e.checksum,
    manifest: e.manifest,
    manifestSignature: e.manifestSignature,
    keyFingerprint: e.keyFingerprint
  }));

  // Every ORIGIN signature reference the sourceRef holds — read off the same typed artifact set the
  // export carries. Today only the SBOM blob can carry one (`sbom.signatureRef`); an OCI entry has
  // no signatureRef anywhere in the graph, so an artifact with an unsigned SBOM yields `[]`.
  const originSignatureRefs = artifactSet
    .map((a) => a.signatureRef)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const importedManifest = importedManifestOf(ref, unknownFields, peerNameOf);

  return {
    changeId: pick.id,
    changeName: pick.name,
    changeCreatedAt: pick.createdAt.toISOString(),
    digests,
    sbom,
    scans,
    exportGate,
    signing: { promotionExports, originSignatureRefs, importedManifest },
    unknownFields
  };
}

/**
 * §10.4 — THE IMPORTED PROMOTION MANIFEST, read off the picked change's `sourceRef` exactly as the
 * importer stamped it (`promotion-repo.ts` import: `promotionManifest` + `manifestSignature`, beside
 * `promotedFromDomain` / `artifactDigests[]`). Non-null only when BOTH are present AND the manifest
 * parses as `PromotionManifestSchema`; a manifest without a signature is STATED
 * (`importedManifest:unsigned`), a manifest that does not parse is STATED
 * (`importedManifest:unparseable`); neither key ⇒ null, no note.
 *
 * NEVER VERIFIED HERE, deliberately. Import already REJECTED any bundle whose signature, artifact
 * set-equality or digest tie failed (`verifyPromotionManifest`), so a manifest that reached the row
 * was verified at import BY CONSTRUCTION — and cosign verification is a subprocess, which has no
 * business inside the projection's read transaction. `exporterName` is the paired peer named by
 * `manifest.exporterDomainId` (the exporter IS a peer at the importer), resolved through the SAME
 * `federation_peers` read the export stamps use — null when no such peer row exists here.
 */
function importedManifestOf(
  ref: Record<string, unknown>,
  unknownFields: string[],
  peerNameOf: (peerDomainId: string) => string | null
): ComponentPipelineArtifact["signing"]["importedManifest"] {
  const rawManifest = ref.promotionManifest;
  if (rawManifest === undefined || rawManifest === null) return null;
  const parsed = PromotionManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    unknownFields.push("importedManifest:unparseable");
    return null;
  }
  const signature = ref.manifestSignature;
  if (typeof signature !== "string" || signature.length === 0) {
    unknownFields.push("importedManifest:unsigned");
    return null;
  }
  const manifest = parsed.data;
  return {
    manifest,
    manifestSignature: signature,
    exporterDomainId: manifest.exporterDomainId,
    exporterName: peerNameOf(manifest.exporterDomainId),
    importedFromDomain: typeof ref.promotedFromDomain === "string" ? ref.promotedFromDomain : null,
    artifactCount: manifest.artifacts.length
  };
}
