import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED. See docs/plugins.md §10. */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
