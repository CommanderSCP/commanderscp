import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";

/**
 * ================================================================================================
 * THE COVERAGE-ENABLEMENT CENSUS — A THRESHOLD ONLY GATES WHEN COVERAGE IS ACTUALLY COLLECTED
 * ================================================================================================
 *
 * WHAT WENT WRONG, TWICE. BUILD_AND_TEST.md §7 once claimed "≥80% unit coverage" while no config
 * declared a threshold and `pnpm test` ran bare — aspiration presented as policy (the 2026-08-01
 * owner decision fixed that by adding thresholds to the two app configs). CI then enforced them by
 * appending `-- --coverage` to `pnpm test`, which worked — but anything after turbo's `--` is
 * folded into the hash of EVERY task in the graph, so all 38 `:build` tasks missed cache and
 * re-executed inside the unit-test job (measured 2026-08-31: @scp/server#build finished at t+162s
 * of that step, delaying the package's own suite by exactly that). The fix moved enablement into
 * the configs themselves — CI-conditional, see below — which un-busts the cache while keeping
 * local behaviour exactly what it was.
 *
 * THE HOLE THAT LEAVES OPEN, AND WHAT THIS FILE CLOSES. A vitest threshold only fails a run when
 * coverage is actually collected. With no `--coverage` on the CI command line, the next config to
 * declare `thresholds` WITHOUT enabling collection would be decorative from the day it lands —
 * green in CI, never once measured — which is precisely the state §7 was in before 2026-08-01. So
 * the rule, both directions: a config that declares `coverage.thresholds` must declare EXACTLY
 * `enabled: process.env.CI === "true"` (CI-conditional, not a bare `true`, because an
 * unconditional enable gates FILTERED local runs against whole-package floors — measured: one
 * apps/web file run reports 11.55% against the 38% floor and exits 1; the exact literal is pinned
 * so a well-meaning variant cannot drift into either failure mode), and the census must actually
 * find the configs known to gate today (non-vacuity — an empty census passes every "this set is
 * empty" assertion for free). The distinctive literal also keeps `typecheck: { enabled: true }` —
 * the same line shape in a different vitest block — from satisfying this check by accident.
 *
 * WHY IT LIVES IN `@scp/source-census`: same as its siblings — this package is the repo's
 * census-over-tracked-source utility, reading `git ls-files` so node_modules and build output can
 * never enter the set, and reading config SOURCE rather than importing it (importing executes
 * `defineConfig` and every plugin the config pulls in).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/** The configs whose thresholds are the CI unit-coverage gate today (owner decision 2026-08-01). */
const KNOWN_GATING_CONFIGS = ["apps/server/vitest.config.ts", "apps/web/vitest.config.ts"];

/** Every tracked vitest config, whatever its variant (unit, integration, kind). */
const CONFIGS = trackedFiles(REPO_ROOT)
  .filter((p) => /(?:^|\/)vitest(?:\.[a-z-]+)?\.config\.ts$/.test(p))
  .map((rel) => ({ rel, source: readFileSync(resolve(REPO_ROOT, rel), "utf8") }));

const declaresThresholds = (source: string): boolean => /^\s*thresholds:\s*\{/m.test(source);
const declaresEnabled = (source: string): boolean =>
  /^\s*enabled:\s*process\.env\.CI === "true",?\s*$/m.test(source);

describe("a coverage threshold must come with coverage enablement, or it gates nothing", () => {
  it("the census actually read the repo's vitest configs (it is not an empty list)", () => {
    expect(CONFIGS.length).toBeGreaterThan(30);
    for (const known of KNOWN_GATING_CONFIGS) {
      expect(
        CONFIGS.map((c) => c.rel),
        `${known} is the config this rule was written for; if it moved, update KNOWN_GATING_CONFIGS`
      ).toContain(known);
    }
    // …and both detectors match the shape they hunt for — and refuse the two known drift forms
    // (a bare `true`, which gates filtered local runs; a commented-out line).
    expect(declaresThresholds("  thresholds: {\n    lines: 1\n  }")).toBe(true);
    expect(declaresEnabled('  enabled: process.env.CI === "true",')).toBe(true);
    expect(declaresEnabled("  enabled: true,")).toBe(false);
    expect(declaresEnabled('  // enabled: process.env.CI === "true" elsewhere')).toBe(false);
  });

  it("EVERY config declaring coverage.thresholds also declares coverage.enabled: true", () => {
    const decorative = CONFIGS.filter(
      (c) => declaresThresholds(c.source) && !declaresEnabled(c.source)
    ).map((c) => c.rel);
    expect(
      decorative,
      "a threshold in a config that never collects coverage is decoration: nothing on the CI " +
        'command line passes --coverage anymore, so add `enabled: process.env.CI === "true"` to ' +
        "the coverage block — exactly that literal, not a bare `true` (see " +
        "apps/server/vitest.config.ts's comment for both halves of the reason)"
    ).toStrictEqual([]);
  });

  it("the known gating configs still declare thresholds — the rule has not gone vacuous", () => {
    for (const known of KNOWN_GATING_CONFIGS) {
      const config = CONFIGS.find((c) => c.rel === known);
      expect(config, `${known} disappeared — update KNOWN_GATING_CONFIGS`).toBeDefined();
      expect(
        declaresThresholds(config!.source),
        `${known} no longer declares coverage.thresholds; if that was deliberate (owner call — ` +
          "the 2026-08-01 decision put them there), remove it from KNOWN_GATING_CONFIGS with the " +
          "decision reference"
      ).toBe(true);
    }
  });
});
