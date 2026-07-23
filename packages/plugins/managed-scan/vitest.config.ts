import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1) — mirrors managed-iac's exact pattern: excludes
 * `*.integration.test.ts` (the real-Docker `scp-runner-scan` container test) so `pnpm test` never
 * depends on Docker being available. `pin.test.ts` is a pure drift check (no Docker) and stays in.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"]
  }
});
