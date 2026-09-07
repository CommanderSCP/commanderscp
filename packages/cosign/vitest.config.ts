import { defineConfig } from "vitest/config";

/** THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED. See docs/cosign.md §27. */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose by default. See docs/cosign.md §28.
    hookTimeout: 30_000
  }
});
