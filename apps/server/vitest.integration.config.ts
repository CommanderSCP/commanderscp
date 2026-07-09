import { defineConfig } from "vitest/config";

/**
 * Integration layer (BUILD_AND_TEST.md §4.2): real PostgreSQL 16 via Testcontainers, never a
 * mocked DB. One container for the whole run (test-support/global-setup.ts), migrated once;
 * `singleFork` keeps every suite on one worker against that one container/connection pool
 * (simplicity over parallelism — DESIGN.md's #1 decision priority — for a suite this size).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test-support/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
