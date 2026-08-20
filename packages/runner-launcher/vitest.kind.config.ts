import { defineConfig } from "vitest/config";

/**
 * THE KIND LAYER (M23.2) — its own config, and the separation is the point.
 *
 * `kubernetes-adapter.kind.test.ts` needs a real Kubernetes API server and FAILS rather than skips
 * when there is none (see that file's header: a `skipIf` is how a gate becomes a green job that ran
 * nothing). That is only safe if exactly one runner ever invokes it, so it lives behind its own
 * `test:kind` script and its own include pattern, invoked by CI job 4e after
 * `scripts/kind-runner-harness.sh up`. `vitest.config.ts` and `vitest.integration.config.ts` both
 * exclude the pattern, so `pnpm test` and `pnpm test:integration` cannot reach it by accident.
 *
 * `singleFork` for the same reason the Docker integration layer uses it: the suite creates and
 * deletes real Jobs by a small, deliberately colliding set of names, and parallel workers racing
 * each other's fixtures would be indistinguishable from a real teardown or reap bug.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.kind.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
