import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors managed-iac/managed-scan exactly: excludes
 * `*.integration.test.ts` so `pnpm test` never depends on Docker being available.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"]
  }
});
