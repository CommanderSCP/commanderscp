import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors managed-iac's exact pattern: excludes
 * `*.integration.test.ts` (the real-Docker `scp-runner-scan` container test) so `pnpm test` never
 * depends on Docker being available. `pin.test.ts` is a pure drift check (no Docker) and stays in.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    // THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6). Vitest's implicit
    // default is 5,000ms; `@scp/runner-launcher` flaked on it under `pnpm -w test`'s parallel
    // graph while never failing once in 420 isolated runs. Gated for every package by
    // `@scp/source-census`'s `test-budget-census.test.ts` — a number must be chosen, not inherited.
    testTimeout: 20_000
  }
});
