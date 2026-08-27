import { describe, expect, it } from "vitest";
import { artifactSetOfSourceRef, substantiveArtifactsOf } from "./artifact-facts.js";

/**
 * THE SELF-EXEMPTION PROBE. `substantiveArtifactsOf` exempts the declared test bundle from the E6
 * scan gate (D23: the bundle is signature-verified per hop but never scanned). The reporter supplies
 * BOTH `artifactDigest` and `testBundle.digest` on the SAME report, so the exemption is keyed on a
 * value the subject controls.
 *
 * The first form of that filter claimed in its own comment that "an image digest can never fall
 * through it". It could: naming the image as its own test bundle collapsed the substantive set to
 * EMPTY and the image crossed a boundary with NO scan demanded. These tests are the disproof, kept
 * permanently so the claim cannot be re-made.
 */
const IMAGE = `sha256:${"a".repeat(64)}`;
const BUNDLE = `sha256:${"b".repeat(64)}`;

describe("substantiveArtifactsOf — a reporter cannot exempt its own image from the scan gate", () => {
  it("exempts a genuine test bundle, and still demands a scan for the image beside it", () => {
    const sourceRef = {
      artifact_digest: IMAGE,
      testBundle: { repository: "x/tests", digest: BUNDLE }
    };
    const substantive = substantiveArtifactsOf(artifactSetOfSourceRef(sourceRef), sourceRef);
    expect(substantive.map((a) => a.digest)).toEqual([IMAGE]);
  });

  it("REFUSES the exemption when the declared bundle digest is ALSO a declared image digest — the image stays substantive and the gate still demands its scan", () => {
    const sourceRef = {
      artifact_digest: IMAGE,
      testBundle: { repository: "x/tests", digest: IMAGE }
    };
    const substantive = substantiveArtifactsOf(artifactSetOfSourceRef(sourceRef), sourceRef);
    expect(substantive.map((a) => a.digest)).toContain(IMAGE);
  });

  it("with no test bundle declared, nothing is exempted", () => {
    const sourceRef = { artifact_digest: IMAGE };
    const substantive = substantiveArtifactsOf(artifactSetOfSourceRef(sourceRef), sourceRef);
    expect(substantive.map((a) => a.digest)).toEqual([IMAGE]);
  });
});
