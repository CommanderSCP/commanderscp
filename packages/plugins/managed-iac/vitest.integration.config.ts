import { defineConfig } from "vitest/config";

/**
 * Docker-requiring integration layer (BUILD_AND_TEST.md §8 M7 DoD: "an integration test that
 * launches a REAL scp-runner-iac container against a local-state tofu fixture"). Mirrors
 * apps/server/vitest.integration.config.ts's shape but has no Postgres/globalSetup dependency —
 * this suite's only external dependency is a reachable Docker daemon (`DOCKER_HOST`, colima
 * locally / native Docker in CI — see the test file's own module doc). Generous timeouts: pulling
 * the base OpenTofu image (first run only) and three separate `docker run` invocations each pay
 * real container-startup overhead.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
