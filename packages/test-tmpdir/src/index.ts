/** One temp directory a test never has to remember to clean. See docs/test-tmpdir.md §5. */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, afterEach } from "vitest";
import { getCurrentTest } from "vitest/suite";

/** WHY THE PER-TEST PAIR REFUSES TO RUN OUTSIDE A TEST. See docs/test-tmpdir.md §6. */
function assertInsideTest(fn: string): void {
  if (getCurrentTest()) return;
  throw new Error(
    `${fn}() was called outside a running test (module top level, or a beforeAll/afterAll hook). ` +
      "Its directory is swept in `afterEach`, so it would be deleted the moment the FIRST test in " +
      "this file finishes — while a beforeAll fixture is still in use. Use " +
      `${fn.replace("mkdtempTracked", "mkdtempTrackedForFile")}() for a directory built once per ` +
      "FILE (swept in afterAll). See @scp/test-tmpdir's module doc."
  );
}

let pendingPerTest: string[] = [];
let pendingPerFile: string[] = [];

async function removeAll(dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

afterEach(async () => {
  await removeAll(pendingPerTest.splice(0));
});

afterAll(async () => {
  await removeAll(pendingPerFile.splice(0));
});

/** A tracked temp directory one test owns, swept afterEach. See docs/test-tmpdir.md §7. */
export async function mkdtempTracked(prefix: string): Promise<string> {
  assertInsideTest("mkdtempTracked");
  const dir = await mkdtemp(prefix);
  pendingPerTest.push(dir);
  return dir;
}

/** Sync counterpart of {@link mkdtempTracked}. */
export function mkdtempTrackedSync(prefix: string): string {
  assertInsideTest("mkdtempTrackedSync");
  const dir = mkdtempSync(prefix);
  pendingPerTest.push(dir);
  return dir;
}

/** A shared temp directory for a file, swept afterAll. See docs/test-tmpdir.md §8. */
export async function mkdtempTrackedForFile(prefix: string): Promise<string> {
  const dir = await mkdtemp(prefix);
  pendingPerFile.push(dir);
  return dir;
}

/** Sync counterpart of {@link mkdtempTrackedForFile}. */
export function mkdtempTrackedForFileSync(prefix: string): string {
  const dir = mkdtempSync(prefix);
  pendingPerFile.push(dir);
  return dir;
}

/** Escape hatch: remove a tracked directory early. See docs/test-tmpdir.md §9. */
export function removeTrackedNow(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  pendingPerTest = pendingPerTest.filter((d) => d !== dir);
  pendingPerFile = pendingPerFile.filter((d) => d !== dir);
}

// Test-only export: lets a suite assert nothing is left registered, e.g. after deliberately
// calling `removeTrackedNow` on everything it made. Counts BOTH lifetimes together.
export function trackedCountForTest(): number {
  return pendingPerTest.length + pendingPerFile.length;
}
