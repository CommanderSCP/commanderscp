import { defineConfig } from "vitest/config";

/**
 * Docker-requiring integration layer (proposal §13.3 DoD: "an ephemeral runner at the commander
 * scans a subject artifact pulled by digest ... `--network none` otherwise"). Mirrors managed-iac's
 * integration config — no Postgres/globalSetup; the only external dependency is a reachable Docker
 * daemon (`DOCKER_HOST`, colima locally / native Docker in CI). Generous timeouts: building the
 * `scp-runner-scan` image (first run — trivy DB download) plus real container startup pay real cost.
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
