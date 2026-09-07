import { defineConfig } from "vitest/config";

/** Unit layer (BUILD_AND_TEST.md §4.1). See docs/server.md §99. */
/** COVERAGE THRESHOLDS — a RATCHET, not a target. See docs/server.md §100. */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    // RAISED FROM THE 5s DEFAULT BECAUSE COVERAGE IS NOW ON IN CI. See docs/server.md §101.
    testTimeout: 20_000,
    // The hook budget: a second deadline nobody chose. See docs/server.md §102.
    hookTimeout: 30_000,
    coverage: {
      // Enabled in-config and only under CI, not on the command line. See docs/server.md §103.
      enabled: process.env.CI === "true",
      provider: "v8",
      reporter: ["text-summary"],
      thresholds: {
        statements: 14,
        branches: 72,
        functions: 30,
        lines: 14
      }
    }
  }
});
