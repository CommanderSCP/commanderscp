import { defineConfig } from "vitest/config";

/**
 * Docker-requiring integration layer. Mirrors managed-iac/managed-scan's integration config — no
 * Postgres/globalSetup; the only external dependency is a reachable Docker daemon.
 *
 * STALE CLAIM CORRECTED (M23.0 verification pass 8): this comment used to say the `scp-runner-dep`
 * image was "NOT built in this repository yet ... so nothing is included here today". M21.5 built
 * `apps/runner-dep` and added `runner-image.integration.test.ts` (the four-charter-clause proof
 * against the real built image, `RUNNER_NETWORK_MODE`, base-image pin drift) — this config has
 * matched a real file since then, and `test-script-census.test.ts` already treats this package as a
 * normal single-file integration suite, not a debt. A comment claiming absence is not evidence of
 * it; this one was checked against the tracked source, not trusted.
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
