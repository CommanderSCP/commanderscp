import { defineConfig } from "vitest/config";

/** Unit layer. The image suite is integration (needs Docker); the kind suite lives in apps/server
 *  (it needs the Testcontainers harness). */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/bundle/**", "**/*.integration.test.ts"],
    testTimeout: 30_000
  }
});
