import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  PromotionManifestSchema,
  ScanEvidenceSchema,
  SbomRefSchema,
  TestBundleRefSchema
} from "@scp/schemas";
import type {
  ArtifactRef,
  ComponentPipelineArtifact,
  ComponentPipelineScanRunSummary,
  ControlOutcomeStatus,
  TestBundleRef
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, controlRuns, objects } from "../db/schema.js";
import {
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  evaluateScanCoverage,
  isScanEvidenceProducer,
  mergeInstanceFloor,
  type ScanRunLike
} from "../federation/scan-evidence.js";
import { readInstanceScanFloors } from "../governance/scan-requirements.js";
import { promotionExportsOf } from "../federation/boundary-bundle-ref.js";

/** ARTIFACT FACTS FOR A COMPONENT'S PIPELINE. See docs/coordination.md §10. */

/** The ORIGIN's two `sourceRef` keys under which a change tracks its OCI digest(s), in read order.
 *  The IMPORTER's stamp (§10.4) is `artifacts[]` (typed) beside `artifactDigests[]` (flat) — see
 *  {@link importedOciDigestsOf}. The SQL prefilter in `pickArtifactChange` probes these two keys
 *  plus a NON-EMPTY `artifactDigests` — keep the three places together. */
export const ARTIFACT_DIGEST_SOURCE_REF_KEYS = ["artifact_digest", "artifactDigest"] as const;

/** One key's value as a digest list: string ⇒ `[it]`, array ⇒ its string members, else `[]`. */
function digestListOf(raw: unknown): string[] {
  return typeof raw === "string"
    ? [raw]
    : Array.isArray(raw)
      ? raw.filter((d): d is string => typeof d === "string")
      : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The OCI digests the IMPORTER stamped on a promoted change. See docs/coordination.md §11. */
function importedOciDigestsOf(ref: Record<string, unknown>): string[] {
  if (Array.isArray(ref.artifacts)) {
    return ref.artifacts
      .filter(isRecord)
      .filter((a) => a.type === "oci" && typeof a.digest === "string")
      .map((a) => a.digest as string);
  }
  const blobDigests = new Set<string>();
  if (isRecord(ref.sbom) && typeof ref.sbom.digest === "string") blobDigests.add(ref.sbom.digest);
  return digestListOf(ref.artifactDigests).filter((d) => !blobDigests.has(d));
}

/** The OCI digests a change tracks, verbatim and deduped. See docs/coordination.md §12. */
export function ociDigestsOfSourceRef(sourceRef: unknown): string[] {
  if (!isRecord(sourceRef)) return [];
  const origin = digestListOf(sourceRef.artifact_digest ?? sourceRef.artifactDigest);
  return [...new Set([...origin, ...importedOciDigestsOf(sourceRef)])];
}

/** The reported test bundle: read, never inferred. See docs/coordination.md §13. */
export function testBundleRefOf(sourceRef: unknown): TestBundleRef | null {
  if (!isRecord(sourceRef)) return null;
  const parsed = TestBundleRefSchema.safeParse(sourceRef.testBundle);
  return parsed.success ? parsed.data : null;
}

/** THE SCAN-GATE SUBSTANTIVE SET. See docs/coordination.md §14. */
export function substantiveArtifactsOf(
  artifactSet: readonly ArtifactRef[],
  sourceRef: unknown
): ArtifactRef[] {
  const bundleDigest = testBundleRefOf(sourceRef)?.digest;
  // A digest the change ALSO declares as one of its images is never exempt (see the doc above).
  const imageDigests = new Set(ociDigestsOfSourceRef(sourceRef));
  const exemptDigest =
    bundleDigest !== undefined && !imageDigests.has(bundleDigest) ? bundleDigest : undefined;
  return artifactSet.filter((a) => a.type !== "blob" && a.digest !== exemptDigest);
}

/** The typed artifact set a change's refs describe. See docs/coordination.md §15. */
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
  // The test bundle crosses as an artifact, not a path. See docs/coordination.md §16.
  const testBundle = testBundleRefOf(sourceRef);
  if (testBundle) artifactSet.push({ type: "oci", digest: testBundle.digest });
  return artifactSet;
}

interface ChangeCandidate {
  id: string;
  name: string | null;
  createdAt: Date;
  sourceRef: unknown;
}

/** THE PICK. Newest-first over `preferredChangeIds`. See docs/coordination.md §17. */
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

  // The fallback: newest digest-carrying change of the component. See docs/coordination.md §18.
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
        sql`(${changes.sourceRef} ?| ${sql.raw(
          `array[${ARTIFACT_DIGEST_SOURCE_REF_KEYS.map((k) => `'${k}'`).join(", ")}]`
        )} OR (jsonb_typeof(${changes.sourceRef} -> 'artifactDigests') = 'array' AND jsonb_array_length(${changes.sourceRef} -> 'artifactDigests') > 0))`
      )
    )
    .orderBy(desc(changes.createdAt), desc(changes.objectId))
    .limit(25);
  return rows.find((r) => ociDigestsOfSourceRef(r.sourceRef).length > 0) ?? null;
}

/** The scan rows of ONE change, reduced to the NEWEST per. See docs/coordination.md §19. */
async function scanRunsForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<{
  scans: ComponentPipelineScanRunSummary[];
  runs: ScanRunLike[];
}> {
  const rows = await tx
    .select({
      id: controlRuns.id,
      controlObjectId: controlRuns.controlObjectId,
      pluginModule: controlRuns.pluginModule,
      status: controlRuns.status,
      evidence: controlRuns.evidence,
      gateRef: controlRuns.gateRef,
      createdAt: controlRuns.createdAt
    })
    .from(controlRuns)
    .where(and(eq(controlRuns.orgId, orgId), eq(controlRuns.changeObjectId, changeObjectId)))
    .orderBy(desc(controlRuns.createdAt), desc(controlRuns.id));

  const runs: ScanRunLike[] = rows.map((row) => ({
    id: row.id,
    controlObjectId: row.controlObjectId,
    pluginModule: row.pluginModule ?? null,
    status: row.status,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt
  }));
  const scans: ComponentPipelineScanRunSummary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const evidence = (row.evidence ?? {}) as Record<string, unknown>;
    const parsed = ScanEvidenceSchema.safeParse(evidence);
    if (!parsed.success) continue;
    const ev = parsed.data;
    const key = `${ev.scanner}|${ev.artifactDigest}`;
    if (seen.has(key)) continue;
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
  return { scans, runs };
}

/** THE `artifact` FIELD of a component's pipeline. See docs/coordination.md §20. */
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

  const { scans, runs } = await scanRunsForChange(tx, orgId, pick.id);

  // `not_run` means nothing scan-like exists on the change. See docs/coordination.md §21.
  const substantive = substantiveArtifactsOf(artifactSet, pick.sourceRef);
  let exportGate: ComponentPipelineArtifact["exportGate"];
  if (scans.length === 0 && !runs.some(isScanEvidenceProducer)) {
    exportGate = "not_run";
  } else {
    const instanceFloor = mergeInstanceFloor(await readInstanceScanFloors(tx));
    exportGate = substantive.every(
      (a) => evaluateScanCoverage({ digest: a.digest, runs, instanceFloor }).covered
    )
      ? "pass"
      : "fail";
  }

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

/** The imported promotion manifest, as stamped. See docs/coordination.md §22. */
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
