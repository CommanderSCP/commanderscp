import { defineConfig } from "vitest/config";

/** Unit layer. The image suite is integration (needs Docker); the kind suite lives in apps/server
 *  (it needs the Testcontainers harness). Budgets are the repo defaults (test-budget-census). */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/bundle/**", "**/*.integration.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
