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
    suites.push({
      name: parsed.name ?? manifest,
      dir,
      configPath: present ? configPath : null,
      declaredMs: present ? declaredTimeoutMs(readFileSync(abs, "utf8")) : null
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
    expect(tracked.slice().sort(), "a new non-unit vitest config appeared — add it to NON_UNIT_CONFIGS").toStrictEqual(
      NON_UNIT_CONFIGS.slice().sort()
    );
  });
});
