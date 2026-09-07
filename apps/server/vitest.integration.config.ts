import { defineConfig } from "vitest/config";

/** Integration layer (BUILD_AND_TEST.md §4.2). See docs/server.md §104. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test-support/global-setup.ts"],
    setupFiles: ["src/test-support/per-worker-db.ts", "src/test-support/plugin-state-dir.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: Number(process.env.SCP_TEST_MAX_FORKS) || 4
      }
    }
  }
});
