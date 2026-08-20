import { defineConfig } from "vitest/config";

/**
 * Docker-requiring integration layer (M23.1 phase 4). Mirrors
 * `apps/server/vitest.integration.config.ts`'s and `@scp/plugin-managed-iac`'s
 * `vitest.integration.config.ts` shape but has no Postgres/globalSetup dependency — this suite's
 * only external dependency is a reachable Docker daemon (`DOCKER_HOST`, colima locally / native
 * Docker in CI — see `reaper.integration.test.ts`'s own module doc). `singleFork` because the
 * suite creates and removes real containers by a small, deliberately colliding set of names/labels
 * — parallel workers racing each other's fixtures would be indistinguishable from a real reap bug.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Belt: the include above already cannot match `*.kind.test.ts`, and it is restated because CI
    // job 5 runs this config and has no Kubernetes cluster — a pattern loosened later must not
    // silently pull a suite that fails-by-design into the required integration gate.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.kind.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
