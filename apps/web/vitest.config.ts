import { configDefaults, defineConfig } from "vitest/config";

/** Standalone from vite.config.ts. See docs/web.md §515. */
/** COVERAGE THRESHOLDS — a RATCHET, not a target. See docs/web.md §516. */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**/*.spec.ts"],
    // THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6). Vitest's implicit
    // default is 5,000ms; `@scp/runner-launcher` flaked on it under `pnpm -w test`'s parallel
    // graph while never failing once in 420 isolated runs. Gated for every package by
    // `@scp/source-census`'s `test-budget-census.test.ts` — a number must be chosen, not inherited.
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose. See docs/web.md §517.
    hookTimeout: 30_000,
    coverage: {
      // Enabled in-config and only under CI, rather than `--coverage` on the CI command line —
      // same reasons, same census as apps/server/vitest.config.ts: a turbo `--` passthrough busts
      // every build task's cache, and an UNconditional enable fails filtered local runs against
      // the whole-package floors (measured on this very config: one file → 11.55% vs 38%).
      enabled: process.env.CI === "true",
      provider: "v8",
      reporter: ["text-summary"],
      thresholds: {
        statements: 38,
        branches: 75,
        functions: 53,
        lines: 38
      }
    }
  }
});
