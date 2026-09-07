import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";

/** THE COVERAGE-ENABLEMENT CENSUS. See docs/source-census.md §2. */

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
