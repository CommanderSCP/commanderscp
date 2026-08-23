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
  declaredHookMs: number | null;
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

/**
 * The same reader for `hookTimeout`. Deliberately a SECOND function rather than a parameterised
 * one: the two options have different defaults (5,000ms vs 10,000ms), different tables and
 * different reasons, and a shared reader is the kind of convenience that makes one of them
 * silently inherit the other's verdict.
 */
function declaredHookTimeoutMs(source: string): number | null {
  const m = /^\s*hookTimeout:\s*([0-9_]+)\s*,?\s*$/m.exec(source);
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
      declaredHookMs: source === null ? null : declaredHookTimeoutMs(source),
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

/**
 * ================================================================================================
 * THE HOOK BUDGET — THE OTHER HALF OF THE SAME CENSUS, AND IT WAS LEFT UNDONE
 * ================================================================================================
 *
 * WHAT THE FIRST HALF MISSED. Everything above is about `testTimeout`. `hookTimeout` is a SECOND,
 * INDEPENDENT deadline with its own implicit default (10,000ms, not 5,000ms), and the census that
 * fixed the first one did not look at it. Measured on this tree, filterless, over every tracked
 * `vite*.config.*` in the repo — 43 files, of which 36 are the unit configs a `test` script loads:
 *
 *   - 36 of 36 unit configs declared NO `hookTimeout`. Every `beforeAll`/`beforeEach`/`afterAll`/
 *     `afterEach` in the unit layer — 179 call sites across 22 packages — ran on a number nobody
 *     chose.
 *   - All 6 non-unit configs (the five integration ones and the kind one) DID declare it, at
 *     60,000 / 120,000 / 300,000 / 600,000ms. So the option was known, deliberately set where a
 *     container start made it obvious, and left implicit everywhere else. That is CLAUDE.md's
 *     incomplete-call-site-census property again, in the same file that was written to close it.
 *
 * THE HAZARD IS NOT HYPOTHETICAL AND THE REPO ALREADY PAID FOR IT. `@scp/cli`'s three CLI-warm-up
 * hooks exist because a lazy `import("./cli.js")` cost ~0.3s warm and **5,400ms on a cold CI
 * runner** — an 18x load factor — and the fix was to move that cost OUT of a test and INTO a hook,
 * reasoned in `outpost-reconcile-precondition.test.ts` as "hooks get vitest's separate
 * `hookTimeout` (10s)". 5,400 of 10,000 is 1.9x of margin on the one hook cost this repo has ever
 * measured on CI. All three sites then wrote `}, 30_000)` at the call site anyway — the authors did
 * not trust the default either, three times, and still nobody moved the package-level knob.
 *
 * WHAT `hookTimeout` DOES *NOT* REACH, SAID PLAINLY, BECAUSE IT IS EASY TO ASSUME OTHERWISE. It
 * governs `beforeAll`/`beforeEach`/`afterAll`/`afterEach` only. It does NOT govern `globalSetup`:
 * vitest awaits that with no timer at all (`await globalSetupFile.setup?.(this)`, main process),
 * so `apps/server`'s Testcontainers Postgres + template migration — measured at **5,384ms** here,
 * warm image, idle machine — is not on a 10,000ms budget, it is on no budget. Nor does it govern
 * `setupFiles`, nor the kind cluster, which `scripts/kind-runner-harness.sh up` creates outside
 * vitest entirely (`kubernetes-adapter.kind.test.ts`'s `beforeAll` only READS the harness file).
 * Those are worth stating because a gate that claims to bound them would be false comfort.
 *
 * THE RULE, IDENTICAL IN SHAPE TO THE ONE ABOVE. Every package whose `test` script runs vitest must
 * DECLARE `hookTimeout`, and the declared number must be one this file's table names; every
 * non-unit config must declare the number ITS table names. Both directions, both layers.
 */

/**
 * THE REVIEWED UNIT HOOK BUDGET. One number, because the measurement supports one.
 *
 * MEASURED, isolated, over every unit suite in the repo (a custom vitest reporter recording
 * `onHookStart`->`onHookEnd`, 2026-08-23, this machine): the slowest hook in the whole unit layer
 * is 1,205ms (`packages/runner-launcher/src/port-deadline.test.ts`'s `afterEach`), the next
 * 926ms (`no-spawn-on-kubernetes.behaviour.test.ts`'s `beforeAll`, an incremental `tsc -b`), the
 * next 268ms. 75 of 79 hooks that cost more than 1ms cost under 270ms.
 *
 * MEASURED ON CI, and this is the number that actually sets the budget: `@scp/cli`'s CLI-warm-up
 * `beforeAll` was 5,400ms on a cold runner against ~0.3s warm. It is the only hook cost this repo
 * has measured under CI's load profile, and it is 18x its warm figure.
 *
 * 30,000ms is 25x the isolated worst case and 5.5x that cold-runner observation, and it is the
 * number the three `@scp/cli` sites independently arrived at for exactly this hazard.
 *
 * WHY NOT 20,000 — the default on the `testTimeout` side. 20,000 is 3.7x the 5,400ms cold-runner
 * figure, against load factors this repo has already measured at 14x, 18x and 44x. Reusing it
 * because it is there is how a table becomes decoration.
 *
 * WHY NOT MORE THAN 30,000. `WORKER_RPC_DEADLINE_MS` above, unchanged: a purely synchronous hook
 * starves the worker exactly as a synchronous test does, and a budget at or above 60,000 lets one
 * cross the un-declarable `onTaskUpdate` deadline — a failure that names no test and reports every
 * test as passing. 30,000 is half of it, matching the per-test budget's own ceiling argument.
 */
const REVIEWED_HOOK_BUDGETS_MS = new Set([30_000]);

/**
 * The non-unit hook budgets. Unlike the unit layer these were already declared; they are named here
 * so a future config cannot double one silently, and each is checked BOTH ways.
 *
 * They are legitimately far above the unit ceiling and above `WORKER_RPC_DEADLINE_MS`, for a reason
 * that does not apply upward: these hooks AWAIT real containers and images (`docker pull`, a
 * Postgres start, a Trivy DB preload). Awaiting I/O yields the worker's event loop every tick, so
 * the RPC-starvation argument that caps the unit budget has no purchase here. A synchronous sweep
 * appearing in one of these hooks would be a defect regardless of the number beside it.
 */
const NON_UNIT_HOOK_BUDGETS: Record<string, { ms: number; why: string }> = {
  "apps/server/vitest.integration.config.ts": {
    ms: 60_000,
    why: "per-worker DROP+CREATE DATABASE ... TEMPLATE clone; the Postgres container itself is globalSetup, which no timer governs (5,384ms measured)"
  },
  "packages/plugins/managed-dep/vitest.integration.config.ts": {
    ms: 600_000,
    why: "builds/pulls the scp-runner-dep image in beforeAll (the site itself declares 600_000)"
  },
  "packages/plugins/managed-iac/vitest.integration.config.ts": {
    ms: 300_000,
    why: "pulls the scp-runner-iac image in beforeAll (the site itself declares 300_000)"
  },
  "packages/plugins/managed-scan/vitest.integration.config.ts": {
    ms: 600_000,
    why: "pulls scp-runner-scan and preloads the Trivy vulnerability DB; the server-side sibling of this hook is measured at 420,000ms"
  },
  "packages/runner-launcher/vitest.integration.config.ts": {
    ms: 60_000,
    why: "real Docker container create/remove under singleFork; no image build in a hook"
  },
  "packages/runner-launcher/vitest.kind.config.ts": {
    ms: 120_000,
    why: "real Job create/teardown against a kind API server; the CLUSTER is created by scripts/kind-runner-harness.sh, outside vitest"
  }
};

/**
 * PER-HOOK OVERRIDES IN THE UNIT LAYER, NAMED RATHER THAN ABSORBED.
 *
 * A `beforeAll(fn, 190_000)` is an explicit declaration and passes the config-level gate by
 * construction, exactly as `it(..., 10_000)` does for `testTimeout`. That is a real hole in a gate
 * that only reads configs, and in the unit layer it is small enough to close: there are four such
 * sites in the whole repo, so they are listed, and a fifth appearing — or one of these changing —
 * fails here. The integration layer's 97 overrides are deliberately NOT listed: they are the
 * container-pull budgets the configs above already reason about, and enumerating them would be
 * bookkeeping rather than a gate.
 *
 * THE ONE THAT IS A FINDING, NOT A SETTING: `no-spawn-on-kubernetes.behaviour.test.ts` needs
 * 190,000ms — 6.3x the reviewed maximum — because its `beforeAll` shells out to `npx tsc -b` with
 * an inner 180,000ms subprocess timeout. It is a build in a hook. The budget is NOT raised to
 * accommodate it (that would hand every other hook in the repo a 190s licence to hide in); it stays
 * a site-local override with its cost written on it, and it is recorded here so it stays visible.
 */
const UNIT_HOOK_OVERRIDES: Record<string, { ms: number; why: string }> = {
  "packages/cli/src/login-base-url.test.ts": {
    ms: 30_000,
    why: "warms the lazy import('./cli.js') so the first `it` does not pay the CLI module graph's transform; now equal to the package budget and kept for the site-local reasoning"
  },
  "packages/cli/src/outpost-reconcile-precondition.test.ts": {
    ms: 30_000,
    why: "same warm-up; the 5,400ms cold-CI-runner measurement that sets REVIEWED_HOOK_BUDGETS_MS was taken here"
  },
  "packages/cli/src/scan-exclusion-admissions-cli.test.ts": {
    ms: 30_000,
    why: "same warm-up"
  },
  "packages/runner-launcher/src/no-spawn-on-kubernetes.behaviour.test.ts": {
    ms: 190_000,
    why: "A BUILD IN A HOOK: `npx tsc -b` with an inner 180_000ms subprocess timeout, because the subject of that file is the built dist rather than the vitest-transformed source. 6.3x the reviewed maximum, deliberately NOT absorbed into it"
  }
};

/**
 * Every hook call site in `source` that passes an explicit numeric timeout, e.g. `beforeAll(fn, N)`.
 *
 * Brace/paren matching rather than a regex over the closing line, because `}, 60_000);` also ends
 * an `it(...)` and a `describe(...)`, and a census that cannot tell them apart is a census of the
 * wrong thing. Strings, template literals and comments are skipped so a `")"` inside one cannot
 * close the call early.
 *
 * ANCHORED TO LINE START, for the same reason `declaredTimeoutMs` is: a REGISTRATION always begins
 * its line (indented inside a `describe` or not), and a MENTION never does — this file's own prose,
 * a few paragraphs up, contains the words `beforeAll(fn, 190_000)`. The unanchored first draft read
 * that sentence, attributed a 190,000ms override to THIS file, and failed. The census reading its
 * own source is correct and stays that way — no path filters, because a filter is where the next
 * instance hides — so it was the reader that was wrong and the reader that was fixed. The anchor
 * also rejects `cfg.beforeEach(...)`, a method call that is not a hook registration.
 */
function hookTimeoutOverrides(source: string): { hook: string; ms: number }[] {
  const found: { hook: string; ms: number }[] = [];
  const re = /^[ \t]*(beforeAll|beforeEach|afterAll|afterEach)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i++) {
      const c = source[i]!;
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const tail = /,\s*([0-9][0-9_]*)\s*$/.exec(source.slice(open + 1, close));
    if (tail) found.push({ hook: m[1]!, ms: Number(tail[1]!.replace(/_/g, "")) });
  }
  return found;
}

/**
 * The tracked test files a package's UNIT config runs: its own `*.test.ts(x)`, minus the two
 * patterns every config in this repo excludes from that layer, minus anything belonging to a
 * nested workspace package.
 */
function unitTestFiles(suite: UnitSuite, allSuites: UnitSuite[], files: string[]): string[] {
  const prefix = suite.dir === "" ? "" : `${suite.dir}/`;
  const nested = allSuites
    .filter((s) => s !== suite && s.dir !== suite.dir && s.dir.startsWith(prefix))
    .map((s) => `${s.dir}/`);
  return files.filter(
    (f) =>
      f.startsWith(prefix) &&
      /\.test\.tsx?$/.test(f) &&
      !/\.(integration|kind)\.test\.tsx?$/.test(f) &&
      !nested.some((n) => f.startsWith(n))
  );
}

describe("no HOOK runs on a deadline nobody chose either", () => {
  it("the hookTimeout reader reads, and is not fooled by prose or by the testTimeout beside it", () => {
    // Non-vacuity for the parser every verdict below rests on — the same shape the testTimeout and
    // setupFiles readers get, and for the same reason: a reader that silently returns null agrees
    // with "declares nothing" AND disagrees with nothing, so it would make this whole block quiet.
    expect(declaredHookTimeoutMs("  test: {\n    hookTimeout: 30_000\n  }")).toBe(30_000);
    expect(declaredHookTimeoutMs("  test: {\n    hookTimeout: 600_000,\n  }")).toBe(600_000);
    expect(declaredHookTimeoutMs("  test: {\n    testTimeout: 20_000\n  }")).toBeNull();
    expect(declaredHookTimeoutMs("// a hookTimeout: 60_000 would have hidden it")).toBeNull();
    // …and it does not read the OTHER option's number when both are present.
    expect(
      declaredHookTimeoutMs("  test: {\n    testTimeout: 20_000,\n    hookTimeout: 30_000\n  }")
    ).toBe(30_000);
  });

  it("EVERY vitest `test` script loads a config that DECLARES hookTimeout", () => {
    const offenders = SUITES.filter((s) => s.declaredHookMs === null).map(
      (s) =>
        `${s.name} (${s.dir || "<root>"}): ${s.configPath === null ? "no vitest.config.ts at all" : `${s.configPath} declares no hookTimeout`}`
    );
    expect(
      offenders,
      "these packages run every beforeAll/beforeEach/afterAll/afterEach on vitest's implicit 10,000ms default. The one hook cost this repo has measured on CI was 5,400ms — 1.9x margin. Declare a number from REVIEWED_HOOK_BUDGETS_MS."
    ).toStrictEqual([]);
  });

  it("every declared unit hook budget is one the table names — an unreviewed number fails too", () => {
    const unreviewed = SUITES.filter(
      (s) => s.declaredHookMs !== null && !REVIEWED_HOOK_BUDGETS_MS.has(s.declaredHookMs)
    ).map((s) => `${s.name}: ${s.declaredHookMs}ms`);
    expect(
      unreviewed,
      "add the number to REVIEWED_HOOK_BUDGETS_MS with the measurement that justifies it, or use one already there"
    ).toStrictEqual([]);
  });

  it("EVERY package declares one, including the fourteen that have no hook today", () => {
    // No allowlist, deliberately, and this asserts that choice rather than leaving it to drift.
    // Fourteen of the thirty-six unit suites contain no hook at all right now, so a budget there
    // bounds nothing — but the cost of declaring it is a line, and the cost of NOT declaring it is
    // that the next hook to be added arrives on the implicit default with nobody looking. That is
    // the precise shape of the defect this file exists for, so uniformity wins over minimalism.
    const files = trackedFiles();
    const withoutHooks = SUITES.filter((s) =>
      unitTestFiles(s, SUITES, files).every((f) => {
        const src = readFileSync(resolve(REPO_ROOT, f), "utf8");
        return !/(^|[^\w.$])(beforeAll|beforeEach|afterAll|afterEach)\s*\(/.test(src);
      })
    );
    expect(withoutHooks.length).toBeGreaterThan(0);
    expect(
      withoutHooks.filter((s) => s.declaredHookMs === null).map((s) => s.name),
      "a package with no hooks today still declares a budget — see the comment above"
    ).toStrictEqual([]);
  });

  it("every non-unit config declares the hook budget ITS table names, both ways", () => {
    const wrong = NON_UNIT_CONFIGS.map((p) => {
      const entry = NON_UNIT_HOOK_BUDGETS[p];
      if (entry === undefined) return `${p}: not in NON_UNIT_HOOK_BUDGETS`;
      const abs = resolve(REPO_ROOT, p);
      if (!existsSync(abs)) return `${p}: no such config`;
      const declared = declaredHookTimeoutMs(readFileSync(abs, "utf8"));
      if (declared === null) return `${p}: declares no hookTimeout`;
      if (declared !== entry.ms) return `${p}: declares ${declared}ms, table says ${entry.ms}ms`;
      return null;
    }).filter((x): x is string => x !== null);
    expect(
      wrong,
      "fix the config or the table — a container-pull budget that doubles silently is exactly what this names"
    ).toStrictEqual([]);

    // And the table may not outlive the configs it describes.
    expect(
      Object.keys(NON_UNIT_HOOK_BUDGETS).slice().sort(),
      "NON_UNIT_HOOK_BUDGETS lists a config that is not in NON_UNIT_CONFIGS"
    ).toStrictEqual(NON_UNIT_CONFIGS.slice().sort());
  });

  it("every PER-HOOK override in the unit layer is named, and every name still overrides", () => {
    // The hole a config-only gate leaves. Both directions, so the table cannot become decoration.
    const files = trackedFiles();
    const seen = new Map<string, number>();
    for (const suite of SUITES) {
      for (const f of unitTestFiles(suite, SUITES, files)) {
        for (const o of hookTimeoutOverrides(readFileSync(resolve(REPO_ROOT, f), "utf8"))) {
          seen.set(f, Math.max(seen.get(f) ?? 0, o.ms));
        }
      }
    }

    const unnamed = [...seen]
      .filter(([f, ms]) => UNIT_HOOK_OVERRIDES[f]?.ms !== ms)
      .map(([f, ms]) => `${f}: ${ms}ms`);
    expect(
      unnamed,
      "a unit-layer hook declares its own budget — add it to UNIT_HOOK_OVERRIDES with the measurement, or delete the override and let the package budget govern"
    ).toStrictEqual([]);

    const stale = Object.entries(UNIT_HOOK_OVERRIDES)
      .filter(([f, entry]) => seen.get(f) !== entry.ms)
      .map(([f, entry]) => `${f} (table says ${entry.ms}ms, file has ${seen.get(f) ?? "none"})`);
    expect(stale, "remove or correct these UNIT_HOOK_OVERRIDES entries").toStrictEqual([]);
  });

  it("the override reader tells a hook's trailing number from an `it`'s, and finds none when there is none", () => {
    // Non-vacuity for the scanner the two assertions above rest on. The third case is the one that
    // matters: `}, 60_000);` closing an `it` inside a `describe` must NOT be read as a hook budget.
    expect(hookTimeoutOverrides("beforeAll(async () => {\n  await x();\n}, 30_000);")).toEqual([
      { hook: "beforeAll", ms: 30_000 }
    ]);
    expect(hookTimeoutOverrides("afterEach(() => {\n  y();\n});")).toEqual([]);
    expect(hookTimeoutOverrides('it("a", () => {\n  z();\n}, 60_000);')).toEqual([]);
    // A `)` inside a string may not close the call early and strand the number outside it.
    expect(hookTimeoutOverrides('beforeAll(() => {\n  f(") ");\n}, 5_000);')).toEqual([
      { hook: "beforeAll", ms: 5_000 }
    ]);
    // A method named `beforeEach` on an object is not a hook registration.
    expect(hookTimeoutOverrides("cfg.beforeEach(() => {}, 1_000);")).toEqual([]);
    // A hook indented inside a `describe` IS one — the anchor allows leading whitespace only.
    expect(hookTimeoutOverrides("describe('d', () => {\n  beforeAll(f, 9_000);\n});")).toEqual([
      { hook: "beforeAll", ms: 9_000 }
    ]);
    // And a PROSE MENTION mid-line is not — the case that made this reader anchored. Without it
    // the census read its own doc comment and reported a 190,000ms override on itself.
    expect(
      hookTimeoutOverrides(" * a `beforeAll(fn, 190_000)` is an explicit declaration")
    ).toEqual([]);
  });

  it("the unit hook budget stays under the RPC deadline it cannot raise", () => {
    // Same argument as the per-test budget's, and it has to be restated rather than inherited: a
    // synchronous hook starves the worker exactly as a synchronous test does, and `hookTimeout` is
    // a SEPARATE number that a future edit could raise past 60,000 while `testTimeout` stayed put.
    const overrun = [...REVIEWED_HOOK_BUDGETS_MS].filter((ms) => ms >= WORKER_RPC_DEADLINE_MS);
    expect(
      overrun,
      `a unit hook budget at or above vitest's ${WORKER_RPC_DEADLINE_MS}ms onTaskUpdate deadline lets one synchronous hook cross it, and that failure names no test`
    ).toStrictEqual([]);
  });
});
