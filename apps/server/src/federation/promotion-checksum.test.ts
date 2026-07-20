import { describe, it, expect } from "vitest";
import type { ArtifactRef, PromotionBundle } from "@scp/schemas";
import { computeBundleChecksum } from "@scp/schemas/federation-journal";
import { promotionChecksumPayload } from "./promotion-repo.js";

/**
 * M17.3 (E3) CHECKSUM-INVARIANCE unit test — the crux of the EXPAND phase: the TYPED `artifacts[]`
 * set is EXCLUDED from the Ed25519 checksum, so adding it to a bundle must not change the checksum
 * by a single byte. This pins that the checksum payload is exactly
 * `{header, change, controlOutcomes, approvals, artifactDigests}` and never `artifacts`, and that
 * `artifactDigests` (which IS in the payload) stays fully sensitive to tampering (fail-closed).
 */

const header: PromotionBundle["header"] = {
  formatVersion: 1,
  kind: "promotion",
  exporterDomainId: "11111111-1111-1111-1111-111111111111",
  peerDomainId: "22222222-2222-2222-2222-222222222222",
  sourceChangeObjectId: "33333333-3333-3333-3333-333333333333",
  exportedAt: "2026-07-20T00:00:00.000Z"
};

const change: PromotionBundle["change"] = {
  urn: "urn:scp:change:demo",
  name: "demo change",
  properties: { targets: ["44444444-4444-4444-4444-444444444444"] },
  sourceKind: "webhook",
  sourceRef: { artifact_digest: "sha256:" + "a".repeat(64) }
};

const artifacts: ArtifactRef[] = [
  { type: "oci", digest: "sha256:" + "a".repeat(64) },
  {
    type: "blob",
    digest: "sha256:" + "b".repeat(64),
    location: "oci://registry.example/sbom@sha256:" + "b".repeat(64),
    format: "cyclonedx",
    signatureRef: "oci://registry.example/sbom.sig"
  }
];

// The flat projection an old outpost reads — `artifacts.map(a => a.digest)`.
const artifactDigests = artifacts.map((a) => a.digest);

/** A full bundle carrying the typed set. `checksum`/`bundleSignature` are placeholders — the
 *  checksum under test is recomputed via `promotionChecksumPayload`. */
const withArtifacts: PromotionBundle = {
  header,
  change,
  controlOutcomes: [],
  approvals: [],
  artifactDigests,
  artifacts,
  checksum: "",
  bundleSignature: ""
};

/** Byte-identical to `withArtifacts` except `artifacts` is absent (v1 shape). */
const withoutArtifacts: PromotionBundle = {
  header,
  change,
  controlOutcomes: [],
  approvals: [],
  artifactDigests,
  checksum: "",
  bundleSignature: ""
};

describe("M17.3 E3: promotion bundle checksum excludes the typed artifact set", () => {
  it("checksum is BYTE-IDENTICAL whether artifacts[] is present or absent", () => {
    const withChecksum = computeBundleChecksum(promotionChecksumPayload(withArtifacts));
    const withoutChecksum = computeBundleChecksum(promotionChecksumPayload(withoutArtifacts));
    expect(withChecksum).toBe(withoutChecksum);
  });

  it("promotionChecksumPayload never carries an `artifacts` key", () => {
    expect(Object.keys(promotionChecksumPayload(withArtifacts))).not.toContain("artifacts");
    expect(promotionChecksumPayload(withArtifacts)).toStrictEqual(
      promotionChecksumPayload(withoutArtifacts)
    );
  });

  it("mutating the typed artifact set alone does not move the checksum", () => {
    const baseline = computeBundleChecksum(promotionChecksumPayload(withoutArtifacts));
    const mutatedArtifacts: PromotionBundle = {
      ...withArtifacts,
      artifacts: [
        ...artifacts,
        { type: "blob", digest: "sha256:" + "c".repeat(64), format: "spdx" }
      ]
    };
    // Only artifacts[] changed — artifactDigests still reflects the ORIGINAL two entries.
    expect(computeBundleChecksum(promotionChecksumPayload(mutatedArtifacts))).toBe(baseline);
  });

  it("FAIL-CLOSED: tampering with artifactDigests (which IS in the payload) DOES move the checksum", () => {
    const baseline = computeBundleChecksum(promotionChecksumPayload(withArtifacts));
    const tampered: PromotionBundle = {
      ...withArtifacts,
      artifactDigests: [...artifactDigests, "sha256:" + "d".repeat(64)]
    };
    expect(computeBundleChecksum(promotionChecksumPayload(tampered))).not.toBe(baseline);
  });
});
