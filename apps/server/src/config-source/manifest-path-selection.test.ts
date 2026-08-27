import { describe, expect, it } from "vitest";
import { manifestPathGlobMatch, selectChangedManifestPaths } from "./manifest-path-selection.js";

describe("manifestPathGlobMatch", () => {
  it("matches a leading '**/' against ZERO leading segments — a repo-root manifest", () => {
    // The exact case `glob-match.ts` misses: read-tree.ts's globMatchesPath fix, mirrored here.
    expect(manifestPathGlobMatch("**/scp/manifest.json", "scp/manifest.json")).toBe(true);
  });

  it("still matches a leading '**/' against one or more leading segments", () => {
    expect(manifestPathGlobMatch("**/scp/manifest.json", "services/api/scp/manifest.json")).toBe(
      true
    );
  });

  it("still matches a plain suffix '**' pattern (the shape every existing consumer stores)", () => {
    expect(manifestPathGlobMatch("services/api/**", "services/api/scp/manifest.json")).toBe(true);
  });

  it("does not match a path missing the required suffix", () => {
    expect(manifestPathGlobMatch("**/scp/manifest.json", "scp/other.json")).toBe(false);
  });

  it("'*' matches within a single path segment only", () => {
    expect(
      manifestPathGlobMatch("services/*/scp/manifest.json", "services/api/scp/manifest.json")
    ).toBe(true);
    expect(
      manifestPathGlobMatch("services/*/scp/manifest.json", "services/api/nested/scp/manifest.json")
    ).toBe(false);
  });
});

describe("selectChangedManifestPaths", () => {
  it("selects a repo-root manifest.json via a leading-'**/' registered glob", () => {
    const matches = selectChangedManifestPaths(
      ["**/scp/manifest.json"],
      ["scp/manifest.json", "README.md"]
    );
    expect(matches).toEqual([{ path: "scp/manifest.json", groupKey: "scp" }]);
  });

  it("selects only paths matching at least one glob, preserving input order", () => {
    const matches = selectChangedManifestPaths(
      ["services/*/scp/manifest.json"],
      [
        "services/api/scp/manifest.json",
        "services/api/src/index.ts",
        "services/web/scp/manifest.json"
      ]
    );
    expect(matches.map((m) => m.path)).toEqual([
      "services/api/scp/manifest.json",
      "services/web/scp/manifest.json"
    ]);
  });

  it("deduplicates a path appearing twice in the changed set", () => {
    const matches = selectChangedManifestPaths(
      ["scp/manifest.json"],
      ["scp/manifest.json", "scp/manifest.json"]
    );
    expect(matches).toHaveLength(1);
  });

  it("derives groupKey as the manifest's containing directory, '' for repo root", () => {
    const matches = selectChangedManifestPaths(
      ["scp/manifest.json", "services/*/scp/manifest.json"],
      ["scp/manifest.json", "services/api/scp/manifest.json"]
    );
    expect(matches).toEqual([
      { path: "scp/manifest.json", groupKey: "scp" },
      { path: "services/api/scp/manifest.json", groupKey: "services/api/scp" }
    ]);
  });

  it("matches nothing against an empty glob list, rather than throwing", () => {
    expect(selectChangedManifestPaths([], ["scp/manifest.json"])).toEqual([]);
  });

  it("matches nothing when no changed path matches any glob", () => {
    expect(selectChangedManifestPaths(["services/*/scp/manifest.json"], ["README.md"])).toEqual([]);
  });
});
