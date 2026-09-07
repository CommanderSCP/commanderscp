import { describe, expect, it } from "vitest";
import { artifactSetOfSourceRef, substantiveArtifactsOf } from "./artifact-facts.js";

/** THE SELF-EXEMPTION PROBE. See docs/coordination.md §9. */
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
