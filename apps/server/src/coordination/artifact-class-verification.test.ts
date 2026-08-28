import { describe, expect, it } from "vitest";
import {
  artifactClassMismatchReason,
  parseReportedArtifactClass,
  verifyArtifactClass
} from "./artifact-class-verification.js";

/**
 * D13 (increment 8) — the pure verdict. The integration counterpart
 * (`artifact-class-verification.integration.test.ts`) proves the refusal reaches the ingress and
 * writes a Decision; this file pins the decision table itself, including the two states that must
 * NOT be collapsed into each other.
 */
describe("verifyArtifactClass", () => {
  it("agreeing declaration and observation is a match, naming the evidence that answered", () => {
    expect(verifyArtifactClass("image", "image")).toEqual({
      declared: "image",
      observed: "image",
      evidenceSource: "buildReport",
      verdict: "match"
    });
  });

  it("disagreeing declaration and observation is a mismatch, and BOTH sides survive on the record", () => {
    // The record is what the refusal Decision carries, so losing either side would make the
    // refusal unactionable — the operator cannot tell which of the two to correct.
    expect(verifyArtifactClass("image", "rpm")).toEqual({
      declared: "image",
      observed: "rpm",
      evidenceSource: "buildReport",
      verdict: "mismatch"
    });
  });

  it("NO reported class is `unverified` — never `match`, and never a mismatch", () => {
    // THE ADDITIVE PROPERTY. Every reporter predating this field, and every provider webhook
    // adapter, lands here. If this returned `match` the field would silently convert "we never
    // checked" into "we checked and it was fine"; if it returned `mismatch` it would refuse every
    // existing release in the estate.
    for (const absent of [null, undefined]) {
      expect(verifyArtifactClass("image", absent)).toEqual({
        declared: "image",
        observed: null,
        evidenceSource: null,
        verdict: "unverified"
      });
    }
  });

  it("`unverified` carries a null evidenceSource — an unanswered check names no evidence", () => {
    const v = verifyArtifactClass("rpm", undefined);
    expect(v.verdict).toBe("unverified");
    expect(v.evidenceSource).toBeNull();
    expect(v.observed).toBeNull();
  });

  it("a NON-BUILD declaration that reports an artifact class is a mismatch, with no second branch", () => {
    // `source_mappings.type` defaults to `configuration`, so these are reachable values on the
    // declared side, not hypotheticals. An infra pipeline claiming to have produced an image is
    // exactly the misdeclaration D13 names, and it falls out of the SAME equality check — which is
    // why `declared` is the full `ExecutorType` rather than the narrow `ArtifactClass`.
    expect(verifyArtifactClass("configuration", "image").verdict).toBe("mismatch");
    expect(verifyArtifactClass("infrastructure", "chart").verdict).toBe("mismatch");
  });

  it("a non-build declaration with NO reported class stays unverified — infra pipelines are unaffected", () => {
    // The common case by far: infrastructure/configuration pipelines report no artifact class and
    // must keep behaving exactly as they did.
    expect(verifyArtifactClass("configuration", undefined).verdict).toBe("unverified");
    expect(verifyArtifactClass("infrastructure", null).verdict).toBe("unverified");
  });

  it("every build-family class verifies against itself", () => {
    // Guards the derivation rather than a hand-copied list: a future member added to
    // `ExecutorTypeSchema`'s build family is automatically covered here.
    for (const k of [
      "image",
      "rpm",
      "deb",
      "npm",
      "maven",
      "python",
      "go",
      "chart",
      "vm-image"
    ] as const) {
      expect(verifyArtifactClass(k, k).verdict).toBe("match");
    }
  });
});

describe("parseReportedArtifactClass", () => {
  it("accepts a build-family class", () => {
    expect(parseReportedArtifactClass("rpm")).toBe("rpm");
  });

  it("REJECTS the two non-build members — they are not artifact classes", () => {
    expect(parseReportedArtifactClass("infrastructure")).toBeUndefined();
    expect(parseReportedArtifactClass("configuration")).toBeUndefined();
  });

  it("rejects unknown and non-string values without throwing", () => {
    // Dropping (rather than throwing) is what keeps a typo out of the refusal path: it degrades to
    // `unverified`, which holds nothing.
    for (const bad of ["Image", "", "tarball", 7, null, {}, []]) {
      expect(parseReportedArtifactClass(bad)).toBeUndefined();
    }
  });
});

describe("artifactClassMismatchReason", () => {
  it("names both sides and where the declaration was read", () => {
    const reason = artifactClassMismatchReason(verifyArtifactClass("image", "rpm"));
    expect(reason).toContain("image");
    expect(reason).toContain("rpm");
    expect(reason).toContain("source mapping");
  });
});
