import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ================================================================================================
 * THE PER-TEST BUDGET CENSUS — NO UNIT SUITE MAY RUN ON A DEADLINE NOBODY CHOSE
 * ================================================================================================
 *
 * WHAT WENT WRONG (M23.1f clause 6). `@scp/runner-launcher`'s unit suite failed roughly 1 run in 5
 * of `pnpm -w test` with `Error: Test timed out in 5000ms.` — vitest's IMPLICIT default, because
 * that package's `vitest.config.ts` set `exclude` and nothing else. It failed **zero** times in 420
 * consecutive isolated runs of the same 396 tests, which is why eleven earlier passes could not
 * measure it: isolation is the wrong load profile. What consumes the headroom is the 109-task
 * parallel graph `turbo run test` builds, not the test.
 *
 * WHY THIS IS A CENSUS AND NOT A ONE-LINE FIX. `apps/server/vitest.config.ts` had already raised its
 * own budget to 20,000ms in 2026-08, for this exact reason, with the measurement written down beside
 * it — and the other thirty-four packages were left on the default. The hazard was seen, correctly
 * diagnosed, and fixed in one of the places that had it. That is §4.4a's shape and CLAUDE.md's
 * incomplete-call-site-census property, so the deliverable is the rule, not the number.
 *
 * THE RULE. Every package whose `test` script runs vitest must DECLARE `testTimeout` in the config
 * that script loads, and the declared number must be one this file's table names. Both directions
 * are checked: a package that declares nothing fails, a package that declares a number nobody
 * reviewed fails, and a table entry for a package that no longer exists fails.
 *
 * WHAT THIS DOES NOT COVER, SAID PLAINLY. A **per-test** override (`it(..., 10_000)`) is an explicit
 * declaration and passes this gate by construction; it can still be too small under load, and one
 * was — `apps/server/src/governance/cel-sandbox.test.ts` timed out twice at 10,017ms under the same
 * parallel graph while its package budget was 20,000. That is a chosen number being wrong, not a
 * number nobody chose, and it is fixed at the site rather than gated here. Nor does this gate say
 * anything about `test:integration` / `test:kind` configs — all five of those already declare a
 * budget, and they are checked below only for staleness of that claim.
 *
 * WHY IT LIVES IN `@scp/source-census`. Same reason `test-script-census.test.ts` does: this package
 * is the repo's census-over-its-own-tracked-source utility, and it reads `git ls-files` rather than
 * walking directories so `node_modules` and build output can never enter the set.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * THE REVIEWED BUDGETS. A package may not simply pick a number: it must pick one of these, so the
 * set of budgets in the repo is readable in one place instead of being spread over 35 files.
 *
 *  - 20,000ms — the default for a package with no measured hot spot. Chosen to match
 *    `apps/server`, whose number was derived from a real measurement (v8 coverage instrumentation
 *    pushing real-cryptography tests from ~500ms to ~5,100ms, straddling the 5s default and flaking
 *    about 1 run in 4).
 *  - 30,000ms — `@scp/runner-launcher` only. Its slowest test with no budget of its own is 3,548ms
 *    isolated and was observed at 5,745ms under the parallel graph; `docker-adapter.test.ts`'s
 *    env-file case is 409ms isolated and was observed at 7,485ms — an 18x load factor. 30,000 is
 *    8.5x the isolated worst case and 4x the worst load-inflated observation.
 */
const REVIEWED_BUDGETS_MS = new Set([20_000, 30_000]);

/** Packages whose unit budget is deliberately not the 20,000ms default, with the reason. */
const NON_DEFAULT_BUDGETS: Record<string, { ms: number; why: string }> = {
  "@scp/runner-launcher": {
    ms: 30_000,
    why: "holds the repo's heaviest unit sweeps; 3,548ms isolated worst case, 7,485ms observed under the parallel graph"
  }
};

/** The non-unit vitest configs, each of which already declares a budget. Checked for staleness. */
const NON_UNIT_CONFIGS = [
  "apps/server/vitest.integration.config.ts",
  "packages/plugins/managed-dep/vitest.integration.config.ts",
  "packages/plugins/managed-iac/vitest.integration.config.ts",
  "packages/plugins/managed-scan/vitest.integration.config.ts",
  "packages/runner-launcher/vitest.integration.config.ts",
  "packages/runner-launcher/vitest.kind.config.ts"
];

interface UnitSuite {
  name: string;
  dir: string;
  configPath: string | null;
  declaredMs: number | null;
  setupFiles: string[];
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split("\0").filter((p) => p.length > 0);
}

/**
 * Read the declared `testTimeout` out of a vitest config's SOURCE rather than by importing it.
 * Importing would execute `defineConfig` and every plugin the config pulls in — which is how a
 * census turns into a second copy of the build. The number is a literal in every config in this
 * repo, and a config that computed it would fail here loudly rather than silently.
 */
function declaredTimeoutMs(source: string): number | null {
  const m = /^\s*testTimeout:\s*([0-9_]+)\s*,?\s*$/m.exec(source);
  return m ? Number(m[1]!.replace(/_/g, "")) : null;
}

/** Every path listed in a config's `setupFiles`, in source order; `[]` when it declares none. */
function declaredSetupFiles(source: string): string[] {
  const m = /^\s*setupFiles:\s*\[([^\]]*)\]/m.exec(source);
  if (m === null) return [];
  return Array.from(m[1]!.matchAll(/"([^"]+)"/g), (hit) => hit[1]!);
}

function unitSuites(): UnitSuite[] {
  const files = trackedFiles();
  const manifests = files.filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const suites: UnitSuite[] = [];
  for (const manifest of manifests) {
    const dir = manifest === "package.json" ? "" : manifest.slice(0, -"/package.json".length);
    let parsed: { name?: string; scripts?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), "utf8")) as typeof parsed;
    } catch {
      continue;
    }
    const script = parsed.scripts?.["test"];
    // `turbo run test` (the root) and `tsx src/verify.ts` (helm-verify) are not vitest suites and
    // have no per-test budget to declare.
    if (script === undefined || !/\bvitest\b/.test(script)) continue;
    // A `--config` argument would mean the script loads something other than the conventional file;
    // no script in this repo has one, and the assertion below is what keeps that true.
    const configPath = dir === "" ? "vitest.config.ts" : `${dir}/vitest.config.ts`;
    const abs = resolve(REPO_ROOT, configPath);
    const present = existsSync(abs);
    const source = present ? readFileSync(abs, "utf8") : null;
    suites.push({
      name: parsed.name ?? manifest,
      dir,
      configPath: present ? configPath : null,
      declaredMs: source === null ? null : declaredTimeoutMs(source),
      setupFiles: source === null ? [] : declaredSetupFiles(source)
    });
  }
  return suites;
}

const SUITES = unitSuites();

describe("no unit suite runs on a per-test deadline nobody chose", () => {
  it("the census actually read the repo (it is not an empty list) and the reader can read", () => {
    // Non-vacuity, in both halves: the set is real, AND the parser that decides every verdict below
    // finds a number when one is there and reports null when it is not.
    expect(SUITES.length).toBeGreaterThan(30);
    expect(SUITES.map((s) => s.name)).toContain("@scp/runner-launcher");
    expect(SUITES.map((s) => s.name)).toContain("@scp/server");
    expect(declaredTimeoutMs("  test: {\n    testTimeout: 20_000\n  }")).toBe(20_000);
    expect(declaredTimeoutMs("  test: {\n    testTimeout: 30_000,\n  }")).toBe(30_000);
    expect(declaredTimeoutMs('  test: {\n    exclude: ["a"]\n  }')).toBeNull();
    // …and it does not match a MENTION of the option in prose, which is how this gate would
    // otherwise be satisfied by a comment.
    expect(declaredTimeoutMs("// a bigger testTimeout: 60_000 would have hidden it")).toBeNull();
  });

  it("EVERY vitest `test` script loads a config that DECLARES testTimeout", () => {
    const offenders = SUITES.filter((s) => s.declaredMs === null).map(
      (s) =>
        `${s.name} (${s.dir || "<root>"}): ${s.configPath === null ? "no vitest.config.ts at all" : `${s.configPath} declares no testTimeout`}`
    );
    expect(
      offenders,
      "these packages run on vitest's implicit 5,000ms default. That default flaked @scp/runner-launcher 5 runs in 23 of `pnpm -w test` and 0 in 420 isolated runs. Declare a number from REVIEWED_BUDGETS_MS."
    ).toStrictEqual([]);
  });

  it("every declared budget is one the table names — a number nobody reviewed fails too", () => {
    const unreviewed = SUITES.filter(
      (s) => s.declaredMs !== null && !REVIEWED_BUDGETS_MS.has(s.declaredMs)
    ).map((s) => `${s.name}: ${s.declaredMs}ms`);
    expect(
      unreviewed,
      "add the number to REVIEWED_BUDGETS_MS with the measurement that justifies it, or use one already there"
    ).toStrictEqual([]);
  });

  it("a package deviating from the 20,000ms default is NAMED, and every name still deviates", () => {
    // Both directions. A package that quietly moves off the default fails; an entry describing a
    // deviation that no longer exists fails, so the table cannot become decoration.
    const undeclaredDeviations = SUITES.filter(
      (s) => s.declaredMs !== null && s.declaredMs !== 20_000 && !NON_DEFAULT_BUDGETS[s.name]
    ).map((s) => `${s.name}: ${s.declaredMs}ms`);
    expect(
      undeclaredDeviations,
      "add the package to NON_DEFAULT_BUDGETS with the measurement, or bring it back to the default"
    ).toStrictEqual([]);

    const stale = Object.entries(NON_DEFAULT_BUDGETS)
      .filter(([name, entry]) => {
        const suite = SUITES.find((s) => s.name === name);
        return suite === undefined || suite.declaredMs !== entry.ms;
      })
      .map(([name, entry]) => `${name} (table says ${entry.ms}ms)`);
    expect(stale, "remove or correct these NON_DEFAULT_BUDGETS entries").toStrictEqual([]);
  });

  it("the non-unit vitest configs still declare their own budgets", () => {
    // These were never the defect — every one of them already carried a number. Asserted so that a
    // future config added without one is caught by the same gate rather than by a flake.
    const missing = NON_UNIT_CONFIGS.filter((p) => {
      const abs = resolve(REPO_ROOT, p);
      return !existsSync(abs) || declaredTimeoutMs(readFileSync(abs, "utf8")) === null;
    });
    expect(
      missing,
      "an integration/kind config that lost its testTimeout, or a path that moved — fix the config or the list"
    ).toStrictEqual([]);

    // The list must also be complete: every tracked non-unit vitest config is in it.
    const tracked = trackedFiles().filter(
      (p) => /vitest\.[a-z]+\.config\.ts$/.test(p) && !p.endsWith("vitest.config.ts")
    );
    expect(
      tracked.slice().sort(),
      "a new non-unit vitest config appeared — add it to NON_UNIT_CONFIGS"
    ).toStrictEqual(NON_UNIT_CONFIGS.slice().sort());
  });
});

/**
 * ================================================================================================
 * THE SECOND DEADLINE NOBODY DECLARED — vitest's 60,000ms worker->main RPC timeout
 * ================================================================================================
 *
 * WHAT WENT WRONG (the round after the one above). CI job 4 failed `@scp/runner-launcher#test`
 * with `17 passed / 429 passed / 1 error` and `Error: [vitest-worker]: Timeout calling
 * "onTaskUpdate"`. No assertion was wrong. `onTaskUpdate` is the worker->main RPC carrying test
 * results, and birpc arms a 60,000ms timer on every such CALL. That constant is compiled into
 * vitest's bundle and vitest passes no override from `getRpcOptions()`, so unlike `testTimeout`
 * above it CANNOT be declared — it is a ceiling every suite lives under whether or not it knows.
 *
 * WHAT CROSSES IT is not a slow test but a STARVED WORKER: a file of purely synchronous tests
 * never lets its event loop reach the poll phase, so the main thread's reply — sent in
 * milliseconds — cannot be read. Measured: 63s of synchronous blocking fails with no load and no
 * coverage; the same 63s with one macrotask yield per test is clean, and so is 126s.
 *
 * SO THE DECLARABLE THING IS THE YIELD, AND THIS IS WHERE IT IS DECLARED. A package whose suite
 * yields between tests can stall at most one TEST, which `testTimeout` above already bounds; a
 * package that does not is bounded by its whole FILE, a number that grows with every property
 * added and is measured on a machine nobody controls.
 *
 * THE CLASS IS NOT PACKAGE-SPECIFIC, AND THE FIRST CENSUS THAT SAID OTHERWISE WAS WRONG. Ranking
 * every per-file duration in the failing CI job put two files near the ceiling, both in
 * `@scp/runner-launcher` (62,948ms and 27,832ms), with the next-heaviest at 12,714ms — a 4.7x
 * margin. That ranking was then USED AS A PREDICTION, and the prediction failed: driving the whole
 * workspace under a deliberately excessive local load (a 16-spinner CPU flood on top of the turbo
 * graph, several times CI's), `@scp/plugin-managed-scan` produced the identical
 * `Timeout calling "onTaskUpdate"` — from `scanner-containment.test.ts`, which had measured 2,481ms
 * on CI, a 24x margin. Its "NO product code outside apps/runner-scan EXECUTES a scanner binary"
 * arm — a synchronous `git ls-files` sweep that reads every tracked file — took 109,591ms there.
 * A CI duration is one load profile, and an I/O-heavy synchronous sweep degrades far harder under
 * contention than a pure-CPU one: 44x against runner-launcher's 14x.
 *
 * SO WHY IS THIS STILL A TABLE. Because at that same load the run failed FOUR OTHER WAYS that no
 * amount of yielding addresses — `@scp/airgap` on its chosen 20,000ms budget, `@scp/cli` twice on
 * its chosen 30,000ms hook budgets, and `@scp/runner-launcher` itself on a 129,783ms stall in
 * MODULE LOAD, a window a between-tests yield cannot reach. Of five runs at a load CI does not
 * apply, wiring every package would have changed exactly one. The load is the dominant lever and it
 * is fixed where it belongs, in `.github/workflows/ci.yml`; the yield is the structural one and is
 * declared per package here.
 *
 * WHAT GENERALISES is therefore the RULE and the TRIPWIRE, not a preemptive edit to 36 configs: a
 * package that grows a heavy synchronous sweep adds itself below, and `MAX_WORKER_STALL_MS` inside
 * the setup file fires at 45,000ms — with the cause written on it — before the deadline does. That
 * tripwire is not theoretical either: it is what named the 129,783ms module-load stall above, in a
 * run whose only other symptom was "429 passed, 1 error".
 */

/** vitest's compiled-in birpc deadline for a worker->main RPC call. Not configurable. */
const WORKER_RPC_DEADLINE_MS = 60_000;

/** Unit suites that must yield the worker's event loop between tests, and why. */
const REQUIRED_SETUP_FILES: Record<string, { setupFile: string; why: string }> = {
  "@scp/runner-launcher": {
    setupFile: "src/test-support/yield-between-tests.ts",
    why: "persisted-json-bound.test.ts is 79 purely synchronous sweeps and measured 62,948ms on the CI runner, past the 60,000ms onTaskUpdate deadline"
  }
};

describe("no unit suite can starve its worker past vitest's un-declarable RPC deadline", () => {
  it("the setupFiles reader reads — it finds a declaration, and is not fooled by prose", () => {
    // Non-vacuity for the parser every verdict below rests on. Written in the same shape as the
    // testTimeout reader's own check, and for the same reason: a census whose reader silently
    // returns nothing agrees with every assertion in this file.
    expect(
      declaredSetupFiles('  setupFiles: ["src/test-support/yield-between-tests.ts"],')
    ).toEqual(["src/test-support/yield-between-tests.ts"]);
    expect(declaredSetupFiles('  setupFiles: ["a.ts", "b.ts"]')).toEqual(["a.ts", "b.ts"]);
    expect(declaredSetupFiles("  test: { testTimeout: 20_000 }")).toEqual([]);
    expect(declaredSetupFiles('// a setupFiles: ["x.ts"] entry would have fixed it')).toEqual([]);
  });

  it("every package the table names DECLARES the yield, and the file it names EXISTS", () => {
    // Both halves matter and neither implies the other. A config that lost the entry runs starved
    // again; an entry pointing at a file that was moved or deleted makes vitest fail loudly, but
    // this says so in one line instead of 17 test files' worth of module-resolution errors.
    const offenders: string[] = [];
    for (const [name, entry] of Object.entries(REQUIRED_SETUP_FILES)) {
      const suite = SUITES.find((s) => s.name === name);
      if (suite === undefined) {
        offenders.push(`${name}: no unit suite by that name — remove the table entry or fix it`);
        continue;
      }
      if (!suite.setupFiles.includes(entry.setupFile)) {
        offenders.push(
          `${name}: ${suite.configPath ?? "<no config>"} does not declare setupFiles ` +
            `["${entry.setupFile}"] — ${entry.why}`
        );
      }
      const abs = resolve(REPO_ROOT, suite.dir, entry.setupFile);
      if (!existsSync(abs)) offenders.push(`${name}: ${entry.setupFile} does not exist`);
    }
    expect(
      offenders,
      'without the yield this suite fails with `[vitest-worker]: Timeout calling "onTaskUpdate"` and EVERY TEST PASSING'
    ).toStrictEqual([]);
  });

  it("no unit suite declares a setup file nobody reviewed", () => {
    // The other direction, so the table cannot drift into decoration while configs grow entries
    // that were never looked at. `setupFiles` is a per-worker side effect on every test in a
    // package; it is not a place for something to appear unnoticed.
    const unreviewed = SUITES.filter((s) => s.setupFiles.length > 0)
      .filter((s) => {
        const entry = REQUIRED_SETUP_FILES[s.name];
        return entry === undefined || !s.setupFiles.every((f) => f === entry.setupFile);
      })
      .map((s) => `${s.name}: ${s.setupFiles.join(", ")}`);
    expect(
      unreviewed,
      "add the package to REQUIRED_SETUP_FILES with the reason, or drop the setupFiles entry"
    ).toStrictEqual([]);
  });

  it("every reviewed per-test budget stays under the RPC deadline it cannot raise", () => {
    // The bound the yield buys is "one test, not one file" — worth exactly as much as testTimeout
    // being smaller than the deadline. A future 60,000ms or 90,000ms entry in REVIEWED_BUDGETS_MS
    // would silently give it away, and the failure it bought back would once again report every
    // test as passing.
    const overrun = [...REVIEWED_BUDGETS_MS].filter((ms) => ms >= WORKER_RPC_DEADLINE_MS);
    expect(
      overrun,
      `a per-test budget at or above vitest's ${WORKER_RPC_DEADLINE_MS}ms onTaskUpdate deadline lets one synchronous test cross it, and that failure names no test`
    ).toStrictEqual([]);
  });
});
