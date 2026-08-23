import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors apps/server/vitest.config.ts's exact pattern:
 * excludes `*.integration.test.ts` (the real-Docker `scp-runner-iac` container test,
 * managed-iac.integration.test.ts) so `pnpm test` never depends on Docker being available.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    // THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6). Vitest's implicit
    // default is 5,000ms; `@scp/runner-launcher` flaked on it under `pnpm -w test`'s parallel
    // graph while never failing once in 420 isolated runs. Gated for every package by
    // `@scp/source-census`'s `test-budget-census.test.ts` — a number must be chosen, not inherited.
    testTimeout: 20_000,
    // THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts`
    // gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit
    // default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under
    // CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x
    // the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms
    // `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
    hookTimeout: 30_000
  }
});
