import { defineConfig } from "vitest/config";

/**
 * Unit layer (BUILD_AND_TEST.md §4.1): pure functions, no Docker, milliseconds. Vitest's default
 * test glob (`**\/*.test.ts`) would otherwise also pick up `*.integration.test.ts` files, which
 * need the Testcontainers Postgres from `vitest.integration.config.ts`'s `globalSetup` — exclude
 * them explicitly so `pnpm test` never depends on Docker.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"]
  }
});
