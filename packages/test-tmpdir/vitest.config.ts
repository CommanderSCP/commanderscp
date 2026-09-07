import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED. See docs/test-tmpdir.md §10. */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose by default. See docs/test-tmpdir.md §11.
    hookTimeout: 30_000
  }
});
