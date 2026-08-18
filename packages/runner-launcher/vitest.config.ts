import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors `@scp/plugin-managed-iac`'s exact pattern: excludes
 * `*.integration.test.ts` (the real-Docker reaper test, `reaper.integration.test.ts` — M23.1 phase
 * 4) so `pnpm test` never depends on a Docker daemon being available.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"]
  }
});
