import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED. See docs/source-census.md §39. */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose. See docs/source-census.md §40.
    hookTimeout: 30_000
  }
});
