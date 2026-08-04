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
 * relay — the three collision classes that previously forced serial execution.
 *
 * ISOLATION IS PER *FILE*, NOT PER WORKER — measured 2026-08-03. `isolate` defaults to true, so
 * `pool: "forks"` gives each test FILE a fresh child process; `setupFiles` therefore re-runs per
 * file and `provisionWorkerDatabase`'s `DROP DATABASE ... WITH (FORCE)` + `CREATE ... TEMPLATE`
 * runs again. A three-file probe under `SCP_TEST_MAX_FORKS=1` saw the same database NAME
 * (`scp_w1`) holding 1 org in the first file and 0 orgs in the third: same name, recreated contents.
 *
 * Worth stating because the previous wording ("files WITHIN a worker still run serially against
 * that worker's database") reads as though files SHARE data. They do not, and that sent one
 * investigation chasing a cross-file interference hazard that cannot occur: the reconcile and
 * watchdog loops DO enumerate every org (`runReconcileSweep`, `runWatchdogSweepForAllOrgs` —
 * neither is tenant-scoped, correctly, since production is one instance serving many orgs), but the
 * only orgs in a file's database are the ones that file created.
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
