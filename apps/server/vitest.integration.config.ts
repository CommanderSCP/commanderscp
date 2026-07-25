import { defineConfig } from "vitest/config";

/**
 * Integration layer (BUILD_AND_TEST.md §4.2): real PostgreSQL 16 via Testcontainers, never a
 * mocked DB. One container for the whole run (test-support/global-setup.ts), which migrates a
 * `scp_template` database once.
 *
 * LEVER 3 — PARALLEL execution via per-worker template-DB isolation (was `singleFork: true`). Each
 * worker fork clones its own private database from `scp_template` (test-support/per-worker-db.ts,
 * a `setupFiles` entry that runs inside every worker), so files in different workers never share
 * the instance-scoped singleton tables, the single `pgboss` schema, or the org-filter-less outbox
 * relay — the three collision classes that previously forced serial execution. Files WITHIN a
 * worker still run serially against that worker's database.
 *
 * `maxForks` is capped (default 4) to match the CI runner's core count — which happens to still be
 * 4 on a GitHub-hosted standard `ubuntu-latest` runner, the same number the old homelab ARC pod's
 * CPU limit gave (docs/BUILD_AND_TEST.md §6.1). Override with `SCP_TEST_MAX_FORKS` on a runner with
 * more cores. Locally, raise it to your core count for maximum parallelism.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test-support/global-setup.ts"],
    setupFiles: ["src/test-support/per-worker-db.ts"],
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
