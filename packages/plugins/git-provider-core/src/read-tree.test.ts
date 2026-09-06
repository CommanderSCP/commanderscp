/**
 * `read-tree.ts` unit tests — the provider-neutral half of `readFilesAtRef` (team-pipeline-iac
 * proposal §12: bounded multi-file/tree reads). Pure functions and accumulators only: no HTTP, no
 * nock, no provider — each adapter's wire shapes (tree-listing endpoint, pagination) are proven in
 * that package's own nock suite; what is proven HERE is the bound machinery all three share.
 */
import { describe, expect, it } from "vitest";
import {
  assertNonEmptyGlobs,
  createTreeReadAccumulator,
  createTreeScanAccumulator,
  DEFAULT_MAX_TREE_ENTRIES_SCANNED,
  DEFAULT_MAX_TREE_FILES,
  DEFAULT_MAX_TREE_TOTAL_BYTES,
  gitProviderTreeBoundError,
  globMatchesPath,
  HARD_MAX_TREE_ENTRIES_SCANNED,
  HARD_MAX_TREE_FILES,
  HARD_MAX_TREE_TOTAL_BYTES,
  isGitProviderTreeBoundError,
  matchesAnyGlob,
  resolveMaxEntriesScanned,
  resolveMaxFiles,
  resolveMaxTotalBytes,
  type RawTreeEntry
} from "./read-tree.js";

describe("globMatchesPath", () => {
  it("`*` matches within one segment but NOT across `/`", () => {
    expect(globMatchesPath("services/*/package.json", "services/api/package.json")).toBe(true);
    expect(globMatchesPath("services/*/package.json", "services/api/nested/package.json")).toBe(
      false
    );
  });

  it("`**` matches across `/`, including zero segments", () => {
    expect(globMatchesPath("**/go.mod", "go.mod")).toBe(true);
    expect(globMatchesPath("**/go.mod", "services/api/go.mod")).toBe(true);
    expect(globMatchesPath("services/**/Dockerfile", "services/a/b/c/Dockerfile")).toBe(true);
  });

  it("an exact literal path matches only itself", () => {
    expect(globMatchesPath("package.json", "package.json")).toBe(true);
    expect(globMatchesPath("package.json", "src/package.json")).toBe(false);
  });

  it("regex metacharacters in the pattern are escaped, not interpreted", () => {
    expect(globMatchesPath("a.b", "aXb")).toBe(false);
    expect(globMatchesPath("a.b", "a.b")).toBe(true);
    expect(globMatchesPath("a+b", "a+b")).toBe(true);
  });
});

describe("matchesAnyGlob", () => {
  it("matches when ANY glob in the list matches", () => {
    expect(matchesAnyGlob(["**/go.mod", "**/package.json"], "services/a/package.json")).toBe(true);
    expect(matchesAnyGlob(["**/go.mod", "**/package.json"], "services/a/Dockerfile")).toBe(false);
  });

  it("an empty glob list matches nothing", () => {
    expect(matchesAnyGlob([], "anything")).toBe(false);
  });
});

describe("assertNonEmptyGlobs", () => {
  it("throws on an empty array, naming the provider", () => {
    expect(() => assertNonEmptyGlobs("gitea", [])).toThrow(
      /gitea readFilesAtRef: globs must be a non-empty array/
    );
  });

  it("does not throw for a non-empty array", () => {
    expect(() => assertNonEmptyGlobs("gitea", ["*.txt"])).not.toThrow();
  });
});

// -------------------------------------------------------------------------------------------
// Bound resolvers — same clamp shape as `read-file.ts`'s `resolveMaxBytes`, tested per bound.
// -------------------------------------------------------------------------------------------

describe("resolveMaxFiles / resolveMaxTotalBytes / resolveMaxEntriesScanned", () => {
  it("default when unset, undefined, zero, negative, NaN or non-finite", () => {
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveMaxFiles(bad)).toBe(DEFAULT_MAX_TREE_FILES);
      expect(resolveMaxTotalBytes(bad)).toBe(DEFAULT_MAX_TREE_TOTAL_BYTES);
      expect(resolveMaxEntriesScanned(bad)).toBe(DEFAULT_MAX_TREE_ENTRIES_SCANNED);
    }
  });

  it("clamps a caller value above the hard ceiling, and floors a fractional one", () => {
    expect(resolveMaxFiles(HARD_MAX_TREE_FILES + 1000)).toBe(HARD_MAX_TREE_FILES);
    expect(resolveMaxFiles(10.9)).toBe(10);
    expect(resolveMaxTotalBytes(HARD_MAX_TREE_TOTAL_BYTES * 2)).toBe(HARD_MAX_TREE_TOTAL_BYTES);
    expect(resolveMaxEntriesScanned(HARD_MAX_TREE_ENTRIES_SCANNED * 2)).toBe(
      HARD_MAX_TREE_ENTRIES_SCANNED
    );
  });

  it("passes through a valid in-range caller value unchanged", () => {
    expect(resolveMaxFiles(5)).toBe(5);
    expect(resolveMaxTotalBytes(4096)).toBe(4096);
    expect(resolveMaxEntriesScanned(500)).toBe(500);
  });
});

describe("gitProviderTreeBoundError / isGitProviderTreeBoundError", () => {
  it("builds an Error carrying treeBoundExceeded/limit/provider, message names both", () => {
    const err = gitProviderTreeBoundError("gitea", "maxFiles", 10, "matched 11 files");
    expect(err).toBeInstanceOf(Error);
    expect(err.treeBoundExceeded).toBe("maxFiles");
    expect(err.limit).toBe(10);
    expect(err.provider).toBe("gitea");
    expect(err.message).toContain("maxFiles");
    expect(err.message).toContain("10");
    expect(err.message).toContain("matched 11 files");
  });

  it("isGitProviderTreeBoundError recognizes only its own product", () => {
    expect(isGitProviderTreeBoundError(gitProviderTreeBoundError("x", "maxFiles", 1, "d"))).toBe(
      true
    );
    expect(isGitProviderTreeBoundError(new Error("boom"))).toBe(false);
    expect(isGitProviderTreeBoundError({ treeBoundExceeded: 123 })).toBe(false);
    expect(isGitProviderTreeBoundError(null)).toBe(false);
    expect(isGitProviderTreeBoundError(undefined)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// createTreeScanAccumulator — axes 2 (maxFiles) and 4 (maxEntriesScanned), enforced DURING the
// scan (per page, not after the whole tree is walked).
// -------------------------------------------------------------------------------------------

function blob(path: string): RawTreeEntry {
  return { path, type: "blob" };
}

function dir(path: string): RawTreeEntry {
  return { path, type: "tree" };
}

describe("createTreeScanAccumulator", () => {
  it("collects only BLOB entries matching a glob, in scan order", () => {
    const acc = createTreeScanAccumulator("gitea", ["**/go.mod"], 10, 100);
    acc.addPage([
      dir("a"),
      blob("a/go.mod"),
      blob("a/main.go"),
      dir("b"),
      blob("b/go.mod"),
      blob("README.md")
    ]);
    expect(acc.matched).toEqual(["a/go.mod", "b/go.mod"]);
  });

  it("never matches a non-blob type, even one literally named to look like a match", () => {
    const acc = createTreeScanAccumulator("gitea", ["**/go.mod"], 10, 100);
    acc.addPage([
      { path: "go.mod", type: "tree" },
      { path: "go.mod", type: "commit" }
    ]);
    expect(acc.matched).toEqual([]);
  });

  it("THROWS the instant maxFiles is exceeded — matches beyond the limit are never added", () => {
    const acc = createTreeScanAccumulator("gitea", ["**/go.mod"], 2, 100);
    expect(() =>
      acc.addPage([blob("a/go.mod"), blob("b/go.mod"), blob("c/go.mod"), blob("d/go.mod")])
    ).toThrow(/gitea readFilesAtRef: exceeded maxFiles \(2\)/);
    // Stopped at the FIRST entry that pushed the count over the limit — 'd/go.mod' never scanned.
    expect(acc.matched).toEqual(["a/go.mod", "b/go.mod", "c/go.mod"]);
  });

  it("THROWS the instant maxEntriesScanned is exceeded, independent of how many (if any) matched", () => {
    const acc = createTreeScanAccumulator("gitea", ["**/go.mod"], 100, 3);
    // NONE of these match any glob — proves the bound is on ENTRIES SCANNED, not matches found.
    expect(() => acc.addPage([dir("a"), dir("b"), dir("c"), dir("d")])).toThrow(
      /gitea readFilesAtRef: exceeded maxEntriesScanned \(3\)/
    );
  });

  it("accumulates correctly ACROSS multiple addPage calls (the gitlab pagination shape)", () => {
    const acc = createTreeScanAccumulator("gitlab", ["*.txt"], 500, 250);
    acc.addPage(Array.from({ length: 100 }, (_, i) => blob(`a${i}.txt`)));
    acc.addPage(Array.from({ length: 100 }, (_, i) => blob(`b${i}.txt`)));
    // 200 entries scanned, all 200 matched, both under their respective bounds (500/250) — no
    // throw, and the SECOND page's matches are appended after the first's.
    expect(acc.matched).toHaveLength(200);
    expect(acc.matched[0]).toBe("a0.txt");
    expect(acc.matched[199]).toBe("b99.txt");
  });

  it("a bound that IS exceeded across pages throws on the page that crosses it, not the first", () => {
    const acc = createTreeScanAccumulator("gitlab", ["*.md"], 100, 150);
    // Page 1: 100 entries, none matching — scanned=100, under the 150 bound, no throw.
    expect(() => acc.addPage(Array.from({ length: 100 }, (_, i) => dir(`d${i}`)))).not.toThrow();
    // Page 2: another 100 — scanned would reach 200, over the 150 bound — throws mid-page.
    expect(() => acc.addPage(Array.from({ length: 100 }, (_, i) => dir(`e${i}`)))).toThrow(
      /gitlab readFilesAtRef: exceeded maxEntriesScanned \(150\)/
    );
  });
});

// -------------------------------------------------------------------------------------------
// createTreeReadAccumulator — axis 3 (maxTotalBytes), enforced as each file finishes decoding.
// -------------------------------------------------------------------------------------------

describe("createTreeReadAccumulator", () => {
  it("does not throw while the running total stays at or under the bound", () => {
    const acc = createTreeReadAccumulator("gitea", 1000);
    expect(() => acc.addFileBytes(400)).not.toThrow();
    expect(() => acc.addFileBytes(600)).not.toThrow(); // exactly 1000 — AT the bound, not over
  });

  it("THROWS the instant the cumulative total exceeds the bound, naming the running total", () => {
    const acc = createTreeReadAccumulator("gitea", 1000);
    acc.addFileBytes(600);
    expect(() => acc.addFileBytes(500)).toThrow(
      /gitea readFilesAtRef: exceeded maxTotalBytes \(1000\).*reached 1100/
    );
  });
});
