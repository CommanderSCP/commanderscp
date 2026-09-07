import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED. See docs/plugins.md §40. */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose. See docs/plugins.md §41.
    hookTimeout: 30_000
  }
});
