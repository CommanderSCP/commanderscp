import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FEED_HARD_MAX_AGE_HOURS,
  DEFAULT_FEED_SOFT_MAX_AGE_HOURS,
  DEPENDENCY_INDEX_FEED_FILE,
  buildDependencyIndexFeed,
  loadDependencyIndexFeedBlob,
  lookupFeedVersions,
  parseDependencyIndexFeed,
  readDependencyIndexFeed
} from "./version-index-feed.js";

/**
 * The air-gap feed's job is to be REFUSABLE. Every test here is about a way the feed can be wrong,
 * and the assertion is always the same shape: the wrong feed produces an explicit refusal, never a
 * quiet "this coordinate has no newer version".
 */

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "scp-dep-feed-test-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function installFeed(dir: string, text: string): void {
  writeFileSync(join(dir, DEPENDENCY_INDEX_FEED_FILE), text, "utf8");
}

function freshFeedText(generatedAt = new Date()): string {
  return buildDependencyIndexFeed(
    [
      { ecosystem: "go", coordinate: "github.com/Masterminds/semver/v3", versions: ["v3.2.1"] },
      { ecosystem: "npm", coordinate: "@acme/lib", versions: ["4.17.21", "5.0.0"] }
    ],
    generatedAt
  );
}

describe("parseDependencyIndexFeed refuses everything it cannot fully understand", () => {
  it("accepts a well-formed document", () => {
    const doc = parseDependencyIndexFeed(freshFeedText());
    expect(doc.schemaVersion).toBe(1);
    expect(doc.entries).toHaveLength(2);
  });

  it("refuses a future schemaVersion rather than best-effort parsing it", () => {
    expect(() =>
      parseDependencyIndexFeed(
        JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), entries: [] })
      )
    ).toThrow(/schemaVersion 2 is not readable/);
  });

  it("refuses a malformed ENTRY instead of dropping it", () => {
    // A tolerant parser would turn a corrupted transfer into a silently smaller feed, and every
    // coordinate that fell out would look up to date.
    expect(() =>
      parseDependencyIndexFeed(
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          entries: [{ ecosystem: "go", coordinate: "x", versions: ["v1.0.0"] }, { ecosystem: "go" }]
        })
      )
    ).toThrow(/malformed entry/);
  });

  it("refuses a document with no parseable generatedAt — the staleness clock must exist", () => {
    expect(() =>
      parseDependencyIndexFeed(
        JSON.stringify({ schemaVersion: 1, generatedAt: "whenever", entries: [] })
      )
    ).toThrow(/generatedAt/);
  });

  it("refuses non-JSON", () => {
    expect(() => parseDependencyIndexFeed("<html>404</html>")).toThrow(/not valid JSON/);
  });
});

describe("readDependencyIndexFeed — staleness is fail-closed at the hard bound", () => {
  it("no feed dir configured is ABSENT, which the caller reports as not_configured", () => {
    expect(readDependencyIndexFeed({})).toEqual({ status: "absent" });
  });

  it("a configured dir with no feed file is ABSENT, not an empty feed", () => {
    const dir = mkdtempSync(join(scratch, "empty-"));
    expect(readDependencyIndexFeed({ SCP_DEPENDENCY_INDEX_FEED_DIR: dir })).toEqual({
      status: "absent"
    });
  });

  it("classifies fresh / soft / hard against the operator's bounds", () => {
    const dir = mkdtempSync(join(scratch, "ages-"));
    const env = { SCP_DEPENDENCY_INDEX_FEED_DIR: dir };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

    installFeed(dir, freshFeedText(hoursAgo(1)));
    expect(readDependencyIndexFeed(env)).toMatchObject({ status: "present", staleness: "fresh" });

    installFeed(dir, freshFeedText(hoursAgo(DEFAULT_FEED_SOFT_MAX_AGE_HOURS + 1)));
    expect(readDependencyIndexFeed(env)).toMatchObject({ status: "present", staleness: "soft" });

    installFeed(dir, freshFeedText(hoursAgo(DEFAULT_FEED_HARD_MAX_AGE_HOURS + 1)));
    expect(readDependencyIndexFeed(env)).toMatchObject({ status: "present", staleness: "hard" });
  });

  it("the operator's own bounds override the defaults", () => {
    const dir = mkdtempSync(join(scratch, "policy-"));
    installFeed(dir, freshFeedText(new Date(Date.now() - 3 * 3_600_000)));
    expect(
      readDependencyIndexFeed({
        SCP_DEPENDENCY_INDEX_FEED_DIR: dir,
        SCP_DEPENDENCY_INDEX_FEED_SOFT_MAX_AGE_HOURS: "1",
        SCP_DEPENDENCY_INDEX_FEED_HARD_MAX_AGE_HOURS: "2"
      })
    ).toMatchObject({ staleness: "hard" });
    // NEGATIVE CONTROL: a nonsense bound falls back to the default rather than to zero — a
    // mis-typed policy value must not silently refuse every feed.
    expect(
      readDependencyIndexFeed({
        SCP_DEPENDENCY_INDEX_FEED_DIR: dir,
        SCP_DEPENDENCY_INDEX_FEED_HARD_MAX_AGE_HOURS: "not-a-number"
      })
    ).toMatchObject({ staleness: "fresh" });
  });

  it("a corrupt installed feed is UNREADABLE, never treated as empty", () => {
    const dir = mkdtempSync(join(scratch, "corrupt-"));
    installFeed(dir, "{ truncated");
    expect(readDependencyIndexFeed({ SCP_DEPENDENCY_INDEX_FEED_DIR: dir })).toMatchObject({
      status: "unreadable"
    });
  });
});

describe("lookupFeedVersions — null and [] are different facts", () => {
  const document = parseDependencyIndexFeed(freshFeedText());

  it("returns the versions for a carried coordinate", () => {
    expect(lookupFeedVersions(document, "npm", "@acme/lib")).toEqual(["4.17.21", "5.0.0"]);
  });

  it("returns null (unlisted) for a coordinate the feed does not carry", () => {
    expect(lookupFeedVersions(document, "npm", "@acme/other")).toBeNull();
  });

  it("matches VERBATIM — a slug-equivalent spelling is a different package", () => {
    // `graph/urn.ts`'s slug collapses `@acme/lib`, `acme/lib` and `acme-lib` into one key; a
    // normalising lookup would answer one package's question with another package's versions.
    expect(lookupFeedVersions(document, "npm", "acme-lib")).toBeNull();
    expect(lookupFeedVersions(document, "npm", "acme/lib")).toBeNull();
    // NEGATIVE CONTROL: the ecosystem is part of the key too.
    expect(lookupFeedVersions(document, "go", "@acme/lib")).toBeNull();
  });
});

describe("buildDependencyIndexFeed — the connected side's output is byte-stable", () => {
  it("re-generating an unchanged estate produces identical bytes, whatever the input order", () => {
    const at = new Date("2026-08-15T00:00:00.000Z");
    const a = buildDependencyIndexFeed(
      [
        { ecosystem: "npm", coordinate: "@acme/lib", versions: ["1.0.0"] },
        { ecosystem: "go", coordinate: "example.com/x", versions: ["v1.0.0"] }
      ],
      at
    );
    const b = buildDependencyIndexFeed(
      [
        { ecosystem: "go", coordinate: "example.com/x", versions: ["v1.0.0"] },
        { ecosystem: "npm", coordinate: "@acme/lib", versions: ["1.0.0"] }
      ],
      at
    );
    expect(a).toBe(b);
  });
});

describe("loadDependencyIndexFeedBlob — verify, then install; never the other way round", () => {
  it("refuses on a digest mismatch WITHOUT writing anything", async () => {
    const dir = mkdtempSync(join(scratch, "load-digest-"));
    const blob = join(dir, "feed.json");
    writeFileSync(blob, freshFeedText(), "utf8");
    writeFileSync(join(dir, "feed.sig"), "signature", "utf8");
    writeFileSync(join(dir, "key.pub"), "key", "utf8");
    const feedDir = mkdtempSync(join(scratch, "load-target-"));

    await expect(
      loadDependencyIndexFeedBlob({
        feedDir,
        blobPath: blob,
        signaturePath: join(dir, "feed.sig"),
        publicKeyPath: join(dir, "key.pub"),
        expectedDigest: `sha256:${"0".repeat(64)}`
      })
    ).rejects.toThrow(/refusing \(no install\)/);

    // The install target is untouched — a failed load must never be able to empty the feed.
    expect(readDependencyIndexFeed({ SCP_DEPENDENCY_INDEX_FEED_DIR: feedDir })).toEqual({
      status: "absent"
    });
  });

  it("refuses when the signature does not verify, and says so", async () => {
    // No cosign binary is needed to prove this branch: `verifyBlobDetached` never throws, it returns
    // `{ok:false}` for anything it cannot verify — including an unresolvable cosign — so an
    // UNVERIFIED blob is refused on every machine, which is the fail-closed direction.
    const dir = mkdtempSync(join(scratch, "load-sig-"));
    const blob = join(dir, "feed.json");
    const bytes = freshFeedText();
    writeFileSync(blob, bytes, "utf8");
    writeFileSync(join(dir, "feed.sig"), "not-a-signature", "utf8");
    writeFileSync(join(dir, "key.pub"), "not-a-key", "utf8");
    const feedDir = mkdtempSync(join(scratch, "load-target-2-"));

    await expect(
      loadDependencyIndexFeedBlob({
        feedDir,
        blobPath: blob,
        signaturePath: join(dir, "feed.sig"),
        publicKeyPath: join(dir, "key.pub")
      })
    ).rejects.toThrow(/verification FAILED/);
    expect(readDependencyIndexFeed({ SCP_DEPENDENCY_INDEX_FEED_DIR: feedDir })).toEqual({
      status: "absent"
    });
    // And nothing was staged and left behind either.
    await expect(
      readFile(join(feedDir, `${DEPENDENCY_INDEX_FEED_FILE}.staging`))
    ).rejects.toThrow();
  });

  it("refuses a missing blob/signature/key by name", async () => {
    const feedDir = mkdtempSync(join(scratch, "load-target-3-"));
    await expect(
      loadDependencyIndexFeedBlob({
        feedDir,
        blobPath: join(scratch, "nope.json"),
        signaturePath: join(scratch, "nope.sig"),
        publicKeyPath: join(scratch, "nope.pub")
      })
    ).rejects.toThrow(/feed '.*nope\.json' not found/);
  });
});
