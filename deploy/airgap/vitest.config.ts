import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED. See docs/airgap.md §60. */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose. See docs/airgap.md §61.
    hookTimeout: 30_000
  }
});
