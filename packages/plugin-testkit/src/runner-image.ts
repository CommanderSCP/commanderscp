import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolveRunnerImageOptions {
  /**
   * Env var CI sets to a pre-pulled image ref (e.g. `SCP_RUNNER_SCAN_IMAGE_REF`). When present, the
   * image is already on this host (the CI `runner-images` job built + pushed it to GHCR by content
   * hash, and the integration job's pre-step `docker pull`ed it) — so we RETURN the ref and never
   * build.
   */
  refEnvVar: string;
  /**
   * Local dev fallback tag to build when `refEnvVar` is unset (e.g.
   * `scp-runner-scan:m13-3a-integration-test`). Built from `context` with the LEGACY builder.
   */
  localTag: string;
  /** Docker build context directory (e.g. `apps/runner-scan`). */
  context: string;
}

/**
 * LEVER 1 — prebuild + publish runner images; tests PULL with a local-build fallback.
 *
 * Resolves the runner image a real-Docker integration test should run:
 *   - CI path: `process.env[refEnvVar]` is set to the content-hash GHCR ref that the `runner-images`
 *     job built + pushed and the integration job `docker pull`ed. We RETURN it — no build, so the
 *     test stops paying a multi-minute `docker build` on every run.
 *   - Local-dev fallback (env unset): `DOCKER_BUILDKIT=0 docker build -t <localTag> <context>` and
 *     RETURN `localTag`. Behavior is unchanged from before this lever — same legacy-builder build.
 *
 * `DOCKER_BUILDKIT=0` forces the LEGACY builder (PR #126): inside the homelab DinD, the integration
 * job both builds runner images AND creates `--network none` scan containers; modern BuildKit opens
 * an embedded gRPC session that deadlocks against net=none container ops ("session healthcheck
 * failed fatally"). These Dockerfiles are plain single-stage FROM+RUN+COPY builds with no
 * BuildKit-only features, so the legacy builder yields a functionally identical image. Do NOT
 * re-enable BuildKit here without re-solving the DinD session wedge (docs/BUILD_AND_TEST.md §6).
 */
export async function resolveRunnerImage(opts: ResolveRunnerImageOptions): Promise<string> {
  const preBuilt = process.env[opts.refEnvVar];
  if (preBuilt && preBuilt.trim() !== "") {
    return preBuilt.trim();
  }
  await execFileAsync("docker", ["build", "-t", opts.localTag, opts.context], {
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOCKER_BUILDKIT: "0" }
  });
  return opts.localTag;
}
