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
 * function, every reader (§10.4: the importer's stamp — typed `artifacts[]`, else the flat
 * `artifactDigests[]` minus blobs — widened all of them at once).
 * The exporter's set is VERBATIM (no normalization — the bundle and the gate carry the digest as
 * tracked).
 *
 * `artifact.exportGate` is a READ-ONLY re-run of the E6 predicate the export applies —
 * `evaluateScanCoverage` in `federation/scan-evidence.ts`, THE rule (producer identity, latest answer
 * wins, instance floor), imported and applied per substantive digest exactly as `promotion-repo.ts`
 * applies it. Not a re-implementation that could drift from it; this module holds no rule of its own.
 */

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

/**
 * The OCI digests the IMPORTER stamped on a promoted change (§10.4). The importer writes TWO
 * shapes side by side: the TYPED set `sourceRef.artifacts[]` (`{type, digest}` — present whenever
 * the exporter's set was non-empty; the same field `crossBoundaryManifestOf` trusts) and the FLAT
 * `sourceRef.artifactDigests[]` (`artifacts.map(a => a.digest)` — the Ed25519-checksummed
 * projection, which therefore ALSO names every SBOM `blob` digest). Reading the flat list as OCI
 * digests would make the SBOM blob a phantom image on every receiving site (E6 `fail`, a refused
 * re-export naming `oci:<sbom digest>`, a scan step pulling the SBOM as an image) — so the typed
 * set is read when it is there, and ONLY WITHOUT it does the flat list count, MINUS every digest
 * the change states as a blob (`sbom.digest`). Malformed ⇒ `[]`.
 */
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

/** The OCI digests a change tracks, VERBATIM, de-duplicated, in a deterministic order:
 *  `sourceRef.artifact_digest` (canonical, lifted by `canonicalizeSourceRef`) ELSE
 *  `sourceRef.artifactDigest` (the report's own key) — the origin's tracked digest(s), string or
 *  string[] — FOLLOWED BY the importer's stamp (§10.4 — `sourceRef.artifacts[]` typed `oci`
 *  entries, else `sourceRef.artifactDigests[]` minus the blob digests; see
 *  {@link importedOciDigestsOf}). The two are a UNION, not a preference: an imported change usually
 *  carries the origin's key too (the exporter's `sourceRef` is spread onto the import), and when
 *  both name the same digest the union says it once; a change stamped ONLY by the importer is
 *  picked by the stamp alone. Malformed ⇒ `[]`. */
export function ociDigestsOfSourceRef(sourceRef: unknown): string[] {
  if (!isRecord(sourceRef)) return [];
  const origin = digestListOf(sourceRef.artifact_digest ?? sourceRef.artifactDigest);
  return [...new Set([...origin, ...importedOciDigestsOf(sourceRef)])];
}

/**
 * The D23 TEST BUNDLE this change's build reported, or `null`.
 *
 * READ, NEVER INFERRED. The only source is `sourceRef.testBundle` — the reference a build put on its
 * report (`ChangeReportRequestSchema.testBundle`), lifted by `webhook-processor.ts` and validated
 * there. Parsed again here rather than trusted, for the reason `capturedWorkflowRefOf` parses: a
 * value that merely has the right keys is not a `TestBundleRef`, and the digest regex is what makes
 * this comparable byte-for-byte against the promotion manifest's artifact set. A change with no
 * reported bundle has none — there is no convention that turns an image repository into a bundle
 * repository, and inventing one would put a guessed location under a signed manifest.
 */
export function testBundleRefOf(sourceRef: unknown): TestBundleRef | null {
  if (!isRecord(sourceRef)) return null;
  const parsed = TestBundleRefSchema.safeParse(sourceRef.testBundle);
  return parsed.success ? parsed.data : null;
}

/**
 * THE SCAN-GATE SUBSTANTIVE SET — ONE definition, because there are two consumers of it and they
 * must never disagree: `promotion-repo.ts`'s E6 EXPORT GATE (which refuses a crossing) and this
 * module's own `artifact.exportGate` projection (which tells an operator what that gate would say).
 * Two copies of this filter is two answers to "may these bytes cross".
 *
 * ============================================================================================
 * WHY THE TEST BUNDLE IS OUT OF THIS SET, STATED RATHER THAN SLIPPED IN
 * ============================================================================================
 * The E6 gate demands a current, digest-bound, floor-satisfying scan outcome for every SUBSTANTIVE
 * artifact. D23 rules the test bundle is "signature-verified per hop but NOT scanned — scan stays
 * image-only per the M13 ruling". Those two sentences collide the moment the bundle rides
 * `artifacts[]` as an `oci` entry, which is what it IS (an OCI artifact beside the image): the gate
 * would demand a scan D23 says will never exist, and every promotion of a component that reports a
 * test bundle would refuse, fail-closed, forever. That collision is REAL and is named here rather
 * than absorbed silently.
 *
 * The exclusion is keyed on the digest the change ITSELF DECLARED (`sourceRef.testBundle.digest`),
 * not on a shape, a name, or a type flag. That matters three ways:
 *   - It cannot be claimed by an artifact the change did not declare as its bundle, so it widens
 *     nothing: an image digest can never fall through it.
 *   - It survives every hop, because the exporter's `sourceRef` is spread onto the imported change,
 *     so the receiver applies the identical exclusion to the identical digest rather than
 *     re-deriving it.
 *   - It is a READ, which is what keeps it honest: a filter that inferred "this looks like a test
 *     bundle" would be the provenance-by-inference defect this repo has already paid for.
 *
 * The SBOM (`type: "blob"`) stays excluded for its own, different reason — it is the scan's OUTPUT,
 * not a scanned input. Two exemptions, two reasons, neither borrowed from the other.
 *
 * ============================================================================================
 * THE SELF-EXEMPTION HOLE, AND WHY THE COLLISION CHECK BELOW IS LOAD-BEARING
 * ============================================================================================
 * An earlier form of this function filtered on `a.digest !== bundleDigest` alone, and its comment
 * claimed "an image digest can never fall through it". THAT CLAIM WAS FALSE, and the probe that
 * disproved it is now a permanent test (`artifact-facts-self-exemption.test.ts`): the reporter
 * supplies BOTH `artifactDigest` and `testBundle.digest` on the SAME report, so a reporter naming
 * its own image as its test bundle collapsed the substantive set to EMPTY — the image crossed with
 * no scan demanded at all. Measured, not theorised: `[{oci, D}, {oci, D}]` filtered to `[]`.
 *
 * So the exemption is REFUSED whenever the declared bundle digest is ALSO a declared image digest.
 * The failure direction is deliberate: with no exemption the E6 gate demands a scan the bundle will
 * never have, so such a promotion REFUSES loudly rather than crossing unscanned. A self-referential
 * declaration is a misconfiguration or an attack; either way the safe answer is to gate it.
 *
 * The general shape, worth carrying: AN EXEMPTION KEYED ON A VALUE THE SUBJECT SUPPLIES IS ONLY AS
 * NARROW AS THE SUBJECT CHOOSES TO MAKE IT. Reading the value rather than inferring it (which this
 * does, correctly) prevents provenance-by-inference; it does NOT prevent self-claiming. Two
 * different defects — closing one leaves the other open.
 */
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

/**
 * M17.3 (E3): the TYPED artifact set a change's tracked refs describe — the OCI digest(s) VERBATIM,
 * plus the SBOM as a `blob` entry when `sourceRef.sbom` carries a string `digest` (its
 * `location`/`format`/`signatureRef` ride along when they are strings), plus (D23) the reported TEST
 * BUNDLE as an `oci` entry. This is what the promotion bundle carries as `artifacts[]`, what the
 * signed promotion manifest binds itself to, and what the E6 gate filters to its substantive set
 * (`substantiveArtifactsOf` — which excludes the bundle; see its doc).
 *
 * THE TEST BUNDLE IS ADDED HERE AND NOT TO `ociDigestsOfSourceRef` ABOVE, deliberately. That reader
 * answers "which IMAGE(s) is this change about" for the managed scan step, the control context's
 * single-digest binding, and the component pipeline tile's `digests` — a bundle appearing there
 * would be scanned as an image, gated as an image, and shown to an operator as one. It belongs to
 * the artifact SET that crosses a boundary, which is a strictly larger question.
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
  // D23 — the test bundle crosses AS AN ARTIFACT, which is the whole decision: a `path:` reference
  // is unresolvable in a domain that cannot reach the source repo, so the bundle is enumerated in
  // the promotion manifest, signature-verified per hop, and distributed on the image's own admitted
  // crossing. Its `repository` is NOT carried on the entry: `location` is documented as unset for
  // OCI (a digest already locates it within its repository), and the repository the DOMAIN-LOCAL
  // copy lives in rides on `sourceRef.testBundle`, which the import spreads onto the receiving
  // change. Appended last so an existing change's entry ORDER — and therefore its projected
  // `artifactDigests` and the manifest bytes a peer verifies — is unchanged when no bundle exists.
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

  // The fallback: newest digest-carrying change of the component. The key probe is a coarse SQL
  // prefilter — either ORIGIN key present, OR the importer's `artifactDigests` present AND NON-EMPTY
  // (the importer stamps it on EVERY promoted change, `[]` included for a metadata-only promotion,
  // so a presence-only probe would let digest-less imports fill the page and push the real newest
  // artifact-carrying change out of it); the JS reader decides whether what is under a key IS an
  // OCI digest (string, string[], typed `oci` entry), which is why a bounded page is scanned rather
  // than `LIMIT 1` trusted.
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

/**
 * The scan rows of ONE change, reduced to the NEWEST per (scanner, scanned digest) for DISPLAY, plus
 * the RAW `control_runs` rows (`ScanRunLike`) the E6 rule reads. The display list takes every row
 * whose evidence parses as `ScanEvidenceSchema` — it shows what rows the change holds; `managed` is
 * READ off `controlObjectId` (the synthetic id). The GATE does not identify a scan that way: it is
 * decided by `evaluateScanCoverage` over the raw rows, which admits a row by WHAT PRODUCED IT
 * (`plugin_module` / the managed step's id — `scan-evidence.ts` property 1), so a row that merely
 * looks like scan evidence appears in `scans[]` and still counts for nothing at the gate.
 */
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

  const { scans, runs } = await scanRunsForChange(tx, orgId, pick.id);

  // E6, read-only. `not_run` is "nothing scan-like exists on this change at all" — no row from an
  // admitted scan-evidence producer AND no row whose evidence even parses as a scan verdict —
  // distinct from `fail`, which is "something is there and it does not cover every substantive
  // artifact with a CURRENT, digest-bound, floor-satisfying outcome from an ADMITTED producer". The
  // predicate is the exporter's own (`evaluateScanCoverage`, applied per substantive digest with the
  // same instance floor `promotion-repo.ts` reads), not a copy: a row an unadmitted producer wrote
  // (e.g. `webhook-control` echoing a scan-shaped payload) may show in `scans[]` and still reads
  // `fail` here, exactly as the export would refuse it.
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
