import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6; source-census's
 *  test-budget-census.test.ts enforces this on every vitest package). 30s rather than the 20s
 *  default: `gitea-plan.test.ts` shells out to the real `helm template` binary against a local
 *  fixture chart, and `argoproj-plan.test.ts` runs a real (if tiny, loopback-only) HTTP server. */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
