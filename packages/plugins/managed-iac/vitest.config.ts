import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors apps/server/vitest.config.ts's exact pattern:
 * excludes `*.integration.test.ts` (the real-Docker `scp-runner-iac` container test,
 * managed-iac.integration.test.ts) so `pnpm test` never depends on Docker being available.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"]
  }
});
