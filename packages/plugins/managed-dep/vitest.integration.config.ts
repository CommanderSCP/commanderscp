import { defineConfig } from "vitest/config";

/**
 * Docker-requiring integration layer. Mirrors managed-iac/managed-scan's integration config — no
 * Postgres/globalSetup; the only external dependency is a reachable Docker daemon. The
 * `scp-runner-dep` image itself is NOT built in this repository yet (see `src/index.ts`'s
 * "WHAT THIS INCREMENT DOES NOT SHIP"), so nothing is included here today; the config exists so the
 * package's script surface matches its two sibling managed executors.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
