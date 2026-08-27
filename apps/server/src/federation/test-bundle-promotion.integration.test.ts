import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportPromotionBundle } from "./promotion-repo.js";
import type {
  ManagedScanRequest,
  ManagedScanResult,
  ManagedScanRunner
} from "./promotion-scan-step.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * D23 AT THE CROSSING — the test bundle rides the promotion manifest as an ordinary artifact, and
 * the ONE mint site stays one.
 *
 * ============================================================================================
 * WHY THIS NEEDED NO SCHEMA CHANGE, MEASURED RATHER THAN ASSUMED
 * ============================================================================================
 * `PromotionManifestSchema.artifacts[]` is already `{type: "oci"|"blob", digest, signatureRef?}`.
 * The test bundle IS an OCI artifact beside the image (D23; §14 resolution 9: "digest-native,
 * cosign-signed like every other artifact, riding the byte channel and registry replication
 * unchanged"), so it fits that shape as-is. Nothing was added to the wire, the manifest keeps its
 * `manifestVersion`, and an outpost one release behind reads a manifest whose only difference is one
 * more entry in a set it already iterates.
 *
 * ============================================================================================
 * THE MINT SITE, AND WHY "ONE" IS AN ASSERTION ABOUT **BEFORE** AS WELL AS AFTER
 * ============================================================================================
 * ADR-0045 D2: an `artifact` object is minted at promotion export (after the manifest is cosign
 * signed) and at promotion import (after verification passes), and NOWHERE ELSE — "a build report,
 * an `observe()` poll, a scan run — none of these creates an artifact object", because that is what
 * keeps the population bounded to promoted digests with no GC problem to solve later.
 *
 * So the natural-looking place to mint a test bundle — the moment a build REPORTS one — is exactly
 * the place D2 forbids. A test that only checked "an artifact object exists after export" would pass
 * just as happily on a build that minted at report time and again at export. This file therefore
 * pins the ABSENCE first: no artifact object for either digest exists while the change merely sits
 * proposed, and exactly one per digest exists afterwards.
 *
 * WHAT THAT ABSENCE DOES **NOT** COVER, MEASURED AND STATED. This file reaches `proposeChange`
 * directly, so its BEFORE assertion witnesses a mint site added at the propose door, at the scan
 * step, or anywhere else between propose and export — but NOT one added at the typed REPORT
 * ingress, which it never calls. Mutation M-c (mint the reported bundle in `webhook-processor.ts`)
 * was run and this file stayed GREEN while
 * `coordination/test-bundle-capture.integration.test.ts` case 1 went red naming the digest. The
 * single-mint-site claim is carried by the two files TOGETHER; neither is complete alone, and the
 * measured mutation table lives on that file.
 *
 * ============================================================================================
 * "SIGNATURE-VERIFIED PER HOP BUT NOT SCANNED" IS A COLLISION, AND IT IS TESTED AS ONE
 * ============================================================================================
 * E6 demands a current, digest-bound, floor-satisfying scan outcome for every SUBSTANTIVE artifact
 * before it may cross. D23 rules the bundle is never scanned (scan stays image-only per M13). Riding
 * `artifacts[]` as an `oci` entry, the bundle would be demanded a scan that by design will never
 * exist, and every promotion of a component that reports one would refuse forever, fail-closed.
 *
 * `substantiveArtifactsOf` resolves that by excluding the digest the change ITSELF DECLARED as its
 * bundle. B2 is the control that keeps the exclusion from being a hole: an unscanned OCI digest the
 * change did NOT declare as its bundle still refuses the export, naming that digest. Same digest
 * value, same runner, same everything else — only the declaration moves.
 *
 * Real PostgreSQL via Testcontainers in this file's OWN database (`createIsolatedDomain`); the
 * `ManagedScanRunner` is the injected seam the scan step exposes, so no Docker, no registry and no
 * real Trivy are involved.
 */

const IMAGE_DIGEST = `sha256:${"3a".repeat(32)}`;
const BUNDLE_DIGEST = `sha256:${"5e".repeat(32)}`;
const BUNDLE_REPOSITORY = "acme/api-tests";

/** Clean for the IMAGE and NOTHING else. A runner that answered clean for every digest would make B2
 *  pass on a build where the exclusion swallowed an unscanned image. */
function imageOnlyRunner(): ManagedScanRunner & { requests: ManagedScanRequest[] } {
  const requests: ManagedScanRequest[] = [];
  return {
    requests,
    async scan(req: ManagedScanRequest): Promise<ManagedScanResult> {
      requests.push(req);
      if (req.digest !== IMAGE_DIGEST) {
        return { ok: false, reason: `this runner scans images only, not ${req.digest}` };
      }
      return {
        ok: true,
        report: {
          scannedDigest: req.digest,
          scannerVersion: "0.53.0",
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          findings: []
        }
      };
    }
  };
}

describe("D23 at the crossing: the test bundle in the promotion manifest, minted once", () => {
  let domain: IsolatedDomain;
  let peerName: string;

  beforeAll(async () => {
    domain = await createIsolatedDomain("testbundle");
    peerName = `peer-${randomUUID().slice(0, 8)}`;
    await withTenantTx(domain.db, domain.orgId, async (tx) => {
      await ensureFederationSelf(tx, domain.orgId);
      const { publicKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" }
      }) as unknown as { publicKey: Buffer };
      await pairPeer(tx, {
        orgId: domain.orgId,
        domainId: asTrustDomainId(randomUUID()),
        name: peerName,
        role: "outpost",
        publicKey: publicKey.toString("base64")
      });
    });
  }, 180_000);

  afterAll(async () => {
    await domain?.close();
  });

  async function proposeWith(sourceRef: Record<string, unknown>): Promise<string> {
    const target = await withTenantTx(domain.db, domain.orgId, (tx) =>
      createObject(tx, {
        orgId: domain.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domain.orgId,
        requestId: `tb-target-${randomUUID()}`,
        name: `tb-target-${randomUUID()}`
      })
    );
    const { change } = await withTenantTx(domain.db, domain.orgId, (tx) =>
      proposeChange(tx, {
        orgId: domain.orgId,
        actorObjectId: domain.orgId,
        requestId: `tb-change-${randomUUID()}`,
        name: `tb-${randomUUID()}`,
        targets: [target.id],
        type: "image",
        sourceRef
      })
    );
    return change.id;
  }

  /** Every `artifact` object this domain holds for one digest — a COUNT, so the query is scoped. */
  function artifactObjectsFor(digest: string) {
    return withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.orgId, domain.orgId),
            eq(objects.typeId, "artifact"),
            isNull(objects.deletedAt),
            sql`${objects.properties} ->> 'digest' = ${digest}`
          )
        )
    );
  }

  const exportTo = (changeId: string, runner: ManagedScanRunner) =>
    exportPromotionBundle(domain.db, {
      orgId: domain.orgId,
      peerIdOrName: peerName,
      changeIdOrUrn: changeId,
      actorObjectId: domain.orgId,
      scanRunner: runner
    });

  it("B1: the reported test bundle rides the signed promotion manifest's artifacts[], is NOT scanned, and is minted as an artifact object EXACTLY ONCE — at export, and nowhere before it", async () => {
    const changeId = await proposeWith({
      artifact_digest: IMAGE_DIGEST,
      image: `registry.test/scp/api@${IMAGE_DIGEST}`,
      // The reference a build reported (`ChangeReportRequestSchema.testBundle`), as
      // `webhook-processor.ts` persists it.
      testBundle: { repository: BUNDLE_REPOSITORY, digest: BUNDLE_DIGEST }
    });

    // BEFORE. The change exists, carries the bundle reference, and has minted NOTHING — ADR-0045 D2
    // in its load-bearing direction. A build-report mint site would already have created this row.
    expect(await artifactObjectsFor(BUNDLE_DIGEST)).toHaveLength(0);
    expect(await artifactObjectsFor(IMAGE_DIGEST)).toHaveLength(0);

    const runner = imageOnlyRunner();
    const outcome = await exportTo(changeId, runner);
    expect(outcome.refused, outcome.refused ? outcome.reason : "expected an export").toBe(false);
    if (outcome.refused) throw new Error(outcome.reason);

    // (a) NOT SCANNED, asserted positively rather than inferred from the export succeeding: the
    // managed scan step was asked about the image and about nothing else. D23 keeps scan image-only
    // (M13), and a bundle quietly entering the scan queue would be a coordinate-not-execute
    // regression long before it was a gate failure.
    expect(runner.requests.map((r) => r.digest)).toEqual([IMAGE_DIGEST]);

    // (b) IN THE TYPED SET the bundle carries across, as an ordinary OCI artifact.
    expect(outcome.bundle.artifacts).toContainEqual({ type: "oci", digest: BUNDLE_DIGEST });
    // (c) IN THE COSIGN-SIGNED MANIFEST — which is what binds it: the manifest enumerates the full
    // artifact digest set, so a signature over it cannot be lifted onto a bundle carrying a
    // different one. This is the sentence "enumerated in the promotion manifest" made a row.
    expect(outcome.bundle.promotionManifest?.artifacts).toContainEqual({
      type: "oci",
      digest: BUNDLE_DIGEST
    });
    expect(outcome.bundle.manifestSignature).toBeTruthy();
    // (d) AND IN THE Ed25519-CHECKSUMMED FLAT PROJECTION, which is the only tie between the
    // cosign-anchored set and the bundle envelope an older outpost verifies.
    expect(outcome.bundle.artifactDigests).toContain(BUNDLE_DIGEST);
    expect(outcome.bundle.artifactDigests).toContain(IMAGE_DIGEST);

    // (e) AFTER: exactly one artifact object per digest, both stamped `export`. "Exactly one" is the
    // single-mint-site claim; a second site (at the report, at `observe()`, at the scan) would have
    // shown up as the BEFORE assertions failing, and a duplicate here would mean the identity
    // upsert stopped converging.
    const bundleObjects = await artifactObjectsFor(BUNDLE_DIGEST);
    expect(bundleObjects).toHaveLength(1);
    expect(bundleObjects[0]!.properties).toMatchObject({
      digest: BUNDLE_DIGEST,
      artifactType: "oci",
      mintedBy: "export",
      firstPromotedChangeId: changeId
    });
    expect(await artifactObjectsFor(IMAGE_DIGEST)).toHaveLength(1);

    // (f) IDEMPOTENT. A re-export of the same change converges on the same rows rather than minting
    // a second identity — the property that makes "exactly one" a fact about the system and not
    // about how many times this test happened to call export.
    const again = await exportTo(changeId, imageOnlyRunner());
    expect(again.refused).toBe(false);
    expect(await artifactObjectsFor(BUNDLE_DIGEST)).toHaveLength(1);
  }, 60_000);

  it("B2: the scan exemption does NOT widen — an unscanned OCI digest the change did not DECLARE as its test bundle still refuses the export, naming that digest", async () => {
    // The SAME digest value, the SAME runner, the SAME everything — except that this change tracks
    // it as an ordinary artifact instead of declaring it as its test bundle. Without this control,
    // `substantiveArtifactsOf` could exclude anything at all and B1 would still pass.
    const changeId = await proposeWith({
      artifact_digest: [IMAGE_DIGEST, BUNDLE_DIGEST],
      image: `registry.test/scp/api@${IMAGE_DIGEST}`
    });

    // Counted BEFORE, not asserted as zero: B1 already promoted this digest in this same org, and a
    // row that already exists is not evidence about what THIS export did. The claim is that a
    // refused export mints nothing NEW.
    const mintedBefore = (await artifactObjectsFor(BUNDLE_DIGEST)).length;

    const outcome = await exportTo(changeId, imageOnlyRunner());
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected the export to refuse");
    expect(outcome.reason).toContain(BUNDLE_DIGEST);
    expect(outcome.decisionId).toBeTruthy();

    // Fail-closed all the way: the mint happens only once the commander's attestation is real, and a
    // refused export produces no attestation.
    expect(await artifactObjectsFor(BUNDLE_DIGEST)).toHaveLength(mintedBefore);
    expect(await artifactObjectsFor(IMAGE_DIGEST)).toHaveLength(1);
  }, 60_000);
});
