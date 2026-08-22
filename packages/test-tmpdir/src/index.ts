/**
 * THE ONE PLACE A TEST FILE MAKES A TEMP DIRECTORY IT DOES NOT HAVE TO REMEMBER TO CLEAN UP.
 *
 * WHAT WENT WRONG (CLAUDE.md "Census by property, not by symptom"). A repo-wide census found
 * mkdtemp/mkdtempSync called directly from `node:fs`/`node:fs/promises` in dozens of test files.
 * Most paired it with a correct `try/finally` or `afterEach` `rm(dir, { recursive: true, force:
 * true })` — but the PROPERTY that makes a leak possible is not "this file forgot to write a
 * cleanup line", it is "cleanup is opt-in and invisible at the call site" — nothing at
 * `mkdtemp(...)` itself says whether the three lines below it exist. Two real instances shipped
 * with none at all (a plugin conformance-suite fixture whose factory runs once per `it()`,
 * `@scp/plugin-testkit`'s `runExecutorConformanceSuite`, plus a couple of hand-written test
 * files), and 463 directories were sitting on the author's machine, unnoticed, at the time this
 * was found — each rediscovery got hand-swept and the property shipped again.
 *
 * THE FIX MAKES CLEANUP NOT A SEPARATE STEP. `mkdtempTracked*` allocates the directory AND
 * registers its removal in the same call — there is no second line to forget, and nothing to keep
 * in sync with a variable name. Call it once per directory a test needs; that is the whole API.
 *
 * TWO LIFETIMES, BECAUSE THE REPO GENUINELY HAS BOTH. Most call sites make a fresh directory per
 * `it()` — those want `mkdtempTracked`/`mkdtempTrackedSync`, swept in `afterEach`. A few build ONE
 * directory in `beforeAll` and share it read-only across every test in the file (a fake binary's
 * shim dir, a fixture root) — those want `mkdtempTrackedForFile`/`mkdtempTrackedForFileSync`,
 * swept once in `afterAll`. Using the per-test pair on a `beforeAll` fixture would delete out from
 * under test 2 the moment test 1 finishes; that failure mode is exactly why this is a named
 * choice at the call site instead of one function guessing from where it was called.
 *
 * WHY `afterEach` (not `afterAll`) IS THE RIGHT DEFAULT. A leaked directory from test N should not
 * survive to be blamed on test N+1's failure, and — more concretely — the reproduction of the
 * ENOTEMPTY race in `managed-trigger-budget.test.ts` depended on cleanup running BETWEEN tests in
 * the same file, not only at the very end. `afterAll`-only cleanup by default would have hidden
 * that race, not fixed it — which is why it is the named, opt-in exception here, not the default.
 *
 * WHY THIS IS SAFE TO IMPORT FROM ANY TEST FILE WITHOUT SETUP. Both hooks are registered ONCE, at
 * MODULE LOAD (below) — never lazily on first call: an `afterEach`/`afterAll` added later, from
 * inside a running `it()`, still gets called eventually but is NOT guaranteed to run at the right
 * boundary (measured — it silently missed exactly that boundary here first; see git history if
 * this file ever grows a "lazy register on first call" variant again, and revert it). The
 * registration is MODULE-SCOPED — safe because every vitest config in this repo runs with the
 * (vitest 3 default) `isolate: true`, so each test FILE gets its own fresh module registry
 * (`vitest.integration.config.ts`'s own doc comment measured and pinned this). A file that imports
 * this but calls neither pair still pays two empty `Promise.all`s per file — negligible.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, afterEach } from "vitest";

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

/**
 * `fs.promises.mkdtemp(prefix)`, tracked: removed automatically in the module-level `afterEach`
 * above — use this for a directory one `it()` owns. `prefix` is passed straight through — pass
 * `path.join(os.tmpdir(), "scp-whatever-")` exactly as you would to the raw `mkdtemp`.
 */
export async function mkdtempTracked(prefix: string): Promise<string> {
  const dir = await mkdtemp(prefix);
  pendingPerTest.push(dir);
  return dir;
}

/** Sync counterpart of {@link mkdtempTracked}. */
export function mkdtempTrackedSync(prefix: string): string {
  const dir = mkdtempSync(prefix);
  pendingPerTest.push(dir);
  return dir;
}

/**
 * Like {@link mkdtempTracked}, but for a directory a `beforeAll` builds once and every `it()` in
 * the file shares — removed in the module-level `afterAll` above instead of after each test. Using
 * the per-test pair here would delete the directory out from under the second test the moment the
 * first one finishes.
 */
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

/**
 * Escape hatch for the rare test that needs to assert ON the directory's removal itself (or
 * otherwise wants it gone before its own `afterEach`/`afterAll` runs) rather than waiting for the
 * automatic sweep. Safe to call on a directory either tracked pair already tracks — the automatic
 * sweep silently no-ops on a path that is already gone.
 */
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
