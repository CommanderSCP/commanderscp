import { defineConfig } from "vitest/config";

/**
 * THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6) — copied verbatim from
 * `packages/plugins/argocd/vitest.config.ts`. `@scp/source-census`'s `test-budget-census.test.ts`
 * requires every vitest package to declare an explicit `testTimeout`/`hookTimeout` rather than
 * inherit vitest's implicit defaults (5,000ms / 10,000ms) — the incomplete-call-site-census
 * property CLAUDE.md names, closed once for `@scp/plugin-argocd` and now for this sibling package
 * too, rather than left for the census to catch later.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
