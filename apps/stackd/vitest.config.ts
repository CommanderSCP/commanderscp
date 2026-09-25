import { defineConfig } from "vitest/config";

/** Unit layer. The kind suite lives in apps/server (it needs the Testcontainers harness). */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/bundle/**"],
    testTimeout: 30_000
  }
});
