import { describe, expect, it } from "vitest";
import {
  PROMOTION_EXPORTS_KEY,
  promotionExportsOf,
  withPromotionExport,
  withoutPromotionExports,
  type PromotionExportStamp
} from "./boundary-bundle-ref.js";

/**
 * §9.4 — the pure `sourceRef` helpers under the export stamp. The integration test
 * (boundary-segment.integration.test.ts scenario 7) covers the real export path; this pins the
 * defensive edges a real export never produces on its own: a malformed stored entry, a duplicate
 * checksum, a stamp on a non-object `sourceRef`.
 *
 * MUTATION LOG (each applied ALONE, then reverted)
 * | Mutation | Result |
 * |---|---|
 * | `withPromotionExport` appends without the checksum dedupe | the dedupe test FAILS (2 entries) |
 * | `promotionExportsOf` returns malformed entries as-is (no safeParse) | the lenient test FAILS (`unparseable` 0, entries 2) |
 * | `withoutPromotionExports` returns the input unchanged | the strip test FAILS |
 */
describe("boundary-bundle-ref: promotionExports[] helpers (§9.4)", () => {
  const stamp = (checksum: string): PromotionExportStamp => ({
    peerDomainId: "11111111-1111-4111-8111-111111111111",
    exportedAt: "2026-08-16T00:00:00.000Z",
    checksum,
    manifest: {
      manifestVersion: "scp-promotion-manifest/v1",
      createdAt: "2026-08-16T00:00:00.000Z",
      sourceChangeObjectId: "22222222-2222-4222-8222-222222222222",
      exporterDomainId: "33333333-3333-4333-8333-333333333333",
      peerDomainId: "11111111-1111-4111-8111-111111111111",
      changeUrn: "urn:scp:acme:change:x",
      artifacts: [{ type: "oci", digest: "sha256:" + "a".repeat(64) }]
    },
    manifestSignature: "MEUCIQ==",
    keyFingerprint: "ff".repeat(32)
  });

  it("appends in order, dedupes on checksum, and never touches other keys", () => {
    const one = withPromotionExport(
      { repo: "acme/x", boundaryBundleChecksums: ["c1"] },
      stamp("c1")
    );
    const two = withPromotionExport(one, stamp("c2"));
    const again = withPromotionExport(two, stamp("c1"));
    expect(again.repo).toBe("acme/x");
    expect(again.boundaryBundleChecksums).toEqual(["c1"]);
    expect((again[PROMOTION_EXPORTS_KEY] as PromotionExportStamp[]).map((e) => e.checksum)).toEqual(
      ["c1", "c2"]
    );
  });

  it("stamps onto a non-object sourceRef by starting a fresh bag", () => {
    expect(promotionExportsOf(withPromotionExport(null, stamp("c1"))).entries).toHaveLength(1);
    expect(promotionExportsOf(withPromotionExport("junk", stamp("c1"))).entries).toHaveLength(1);
  });

  it("reads leniently: a malformed stored entry is COUNTED, not dropped silently or fabricated", () => {
    const sourceRef = {
      [PROMOTION_EXPORTS_KEY]: [stamp("c1"), { checksum: "c2" }, "garbage", stamp("c3")]
    };
    const read = promotionExportsOf(sourceRef);
    expect(read.entries.map((e) => e.checksum)).toEqual(["c1", "c3"]);
    expect(read.unparseable).toBe(2);
    // ...and a stamp over such a list carries the malformed entries VERBATIM (never rewritten).
    const stamped = withPromotionExport(sourceRef, stamp("c4"));
    expect((stamped[PROMOTION_EXPORTS_KEY] as unknown[]).length).toBe(5);
    expect((stamped[PROMOTION_EXPORTS_KEY] as unknown[])[2]).toBe("garbage");
  });

  it("reads `[]` / 0 when the key is MISSING — and `[]` / 1 when it is PRESENT but not a list (a stored value that does not read is stated, not claimed absent)", () => {
    expect(promotionExportsOf(undefined)).toEqual({ entries: [], unparseable: 0 });
    expect(promotionExportsOf("junk")).toEqual({ entries: [], unparseable: 0 });
    expect(promotionExportsOf({ repo: "acme/x" })).toEqual({ entries: [], unparseable: 0 });
    expect(promotionExportsOf({ [PROMOTION_EXPORTS_KEY]: null })).toEqual({
      entries: [],
      unparseable: 0
    });
    for (const malformed of ["nope", { checksum: "x" }, 42, true]) {
      expect(promotionExportsOf({ [PROMOTION_EXPORTS_KEY]: malformed }), String(malformed)).toEqual({
        entries: [],
        unparseable: 1
      });
    }
  });

  it("strips the key from an exported payload and leaves everything else", () => {
    const stripped = withoutPromotionExports({
      repo: "acme/x",
      [PROMOTION_EXPORTS_KEY]: [stamp("c1")]
    });
    expect(stripped).toEqual({ repo: "acme/x" });
    expect(withoutPromotionExports(null)).toBeNull();
    const untouched = { repo: "acme/x" };
    expect(withoutPromotionExports(untouched)).toBe(untouched);
  });
});
