import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempTracked,
  mkdtempTrackedForFile,
  mkdtempTrackedSync,
  removeTrackedNow,
  trackedCountForTest
} from "./index.js";

const PREFIX = join(tmpdir(), "scp-test-tmpdir-selftest-");

/**
 * The real assertion here is cross-test: a directory created in one `it()` must be gone by the
 * time the NEXT `it()` runs, because that is exactly the property `managed-trigger-budget.test.ts`
 * needed (cleanup between tests in the same file, not only at the end of the file) — see this
 * package's `index.ts` module doc for why `afterEach` and not `afterAll`.
 */
let dirFromPreviousTest: string | undefined;

describe("mkdtempTracked", () => {
  it("creates a real directory under the given prefix", async () => {
    const dir = await mkdtempTracked(PREFIX);
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(PREFIX)).toBe(true);
    dirFromPreviousTest = dir;
  });

  it("removed the previous test's directory automatically between tests", () => {
    expect(dirFromPreviousTest).toBeDefined();
    expect(existsSync(dirFromPreviousTest!)).toBe(false);
  });

  it("mkdtempTrackedSync also gets swept automatically", async () => {
    const dir = mkdtempTrackedSync(`${PREFIX}sync-`);
    expect(existsSync(dir)).toBe(true);
    dirFromPreviousTest = dir;
  });

  it("the sync variant's directory was swept too", () => {
    expect(existsSync(dirFromPreviousTest!)).toBe(false);
  });

  it("removeTrackedNow removes immediately and de-registers, so the sweep has nothing left to do", async () => {
    const before = trackedCountForTest();
    const dir = await mkdtempTracked(`${PREFIX}manual-`);
    expect(trackedCountForTest()).toBe(before + 1);
    removeTrackedNow(dir);
    expect(existsSync(dir)).toBe(false);
    expect(trackedCountForTest()).toBe(before);
  });
});

describe("mkdtempTrackedForFile", () => {
  let sharedDir: string;

  beforeAll(async () => {
    sharedDir = await mkdtempTrackedForFile(`${PREFIX}forfile-`);
  });

  it("exists in the first test", () => {
    expect(existsSync(sharedDir)).toBe(true);
  });

  it("STILL exists in the second test — a per-test sweep would have deleted it after the first", () => {
    expect(existsSync(sharedDir)).toBe(true);
  });
});

/**
 * POSITIVE CONTROL FOR `assertInsideTest` (index.ts). Every `it()` above calls the per-test pair
 * from inside a running test, which is the case the guard must stay SILENT for — so a guard that
 * threw unconditionally, or whose `getCurrentTest()` detection broke and reported "no test"
 * always, reds this file rather than passing quietly. The refusing half is driven in
 * `guard-outside-test.test.ts`, which needs its own file because stubbing `vitest/suite` is
 * module-scoped.
 */
