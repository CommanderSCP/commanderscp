import { defineConfig } from "vitest/config";

/**
 * Integration layer (BUILD_AND_TEST.md §4.2): real PostgreSQL 16 via Testcontainers, never a
 * mocked DB. No suites exist yet in M0 — the graph/RLS/outbox suites land with M1's schema.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000
  }
});
