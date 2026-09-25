import { defineConfig } from "vitest/config";

/**
 * THE KIND LAYER for the stack controller (M29.4, ADR-0058): a real scpd against Testcontainers
 * Postgres, a real stack controller, and a real Kubernetes API server from
 * `scripts/kind-runner-harness.sh up`. CI runs it in job 4e only. It has NO skip path — with no
 * harness it fails, because a green job that ran nothing is the failure this layer exists to stop.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.kind.test.ts"],
    globalSetup: ["src/test-support/global-setup.ts"],
    setupFiles: ["src/test-support/per-worker-db.ts", "src/test-support/plugin-state-dir.ts"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
