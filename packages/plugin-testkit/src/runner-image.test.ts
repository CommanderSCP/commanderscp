import { describe, expect, it, vi } from "vitest";

/**
 * `resolveRunnerImage` HAD NO TESTS, and it is not a stub: it decides whether a real-Docker
 * integration test pulls a pre-built image or spends minutes building one, and it is called from
 * three integration suites. The CI branch — `process.env[refEnvVar]` set by the `runner-images` job
 * — is pure, needs no daemon, and is the branch every CI run takes.
 *
 * THE ASSERTION THAT MATTERS IS THE ABSENCE: with a ref present, NO `docker build` may be spawned.
 * A regression that fell through to the build would still return a usable image locally and would
 * only show up as CI minutes, which is exactly the kind of thing nothing notices.
 *
 * WHAT IT DOES NOT COVER: the fallback build arm (it spawns `docker build` for real) and the
 * `DOCKER_BUILDKIT=0` env it passes are asserted here only through the recorded call, not executed.
 */

const execFileCalls: { file: string; args: string[] }[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    execFileCalls.push({ file, args });
    cb(null, { stdout: "", stderr: "" });
  }
}));

const { resolveRunnerImage } = await import("./runner-image.js");

const OPTS = {
  refEnvVar: "SCP_TEST_RUNNER_IMAGE_REF",
  localTag: "scp-runner-test:local",
  context: "apps/runner-scan"
};

describe("@scp/plugin-testkit: resolveRunnerImage", () => {
  it("RETURNS THE PRE-BUILT REF, TRIMMED, AND SPAWNS NOTHING", async () => {
    execFileCalls.length = 0;
    vi.stubEnv(OPTS.refEnvVar, "  ghcr.io/commanderscp/scp-runner-scan@sha256:abc  ");

    expect(await resolveRunnerImage(OPTS)).toBe("ghcr.io/commanderscp/scp-runner-scan@sha256:abc");
    expect(execFileCalls, "a pre-pulled image must never be rebuilt").toStrictEqual([]);

    vi.unstubAllEnvs();
  });

  it("A BLANK REF IS NOT A REF — it falls back to the local build, with the legacy builder", async () => {
    // `""` and `"   "` are what an unset-but-declared CI variable expands to; treating either as a
    // ref would hand `docker run` an empty image name much later, far from here.
    execFileCalls.length = 0;
    vi.stubEnv(OPTS.refEnvVar, "   ");

    expect(await resolveRunnerImage(OPTS)).toBe("scp-runner-test:local");
    expect(execFileCalls).toStrictEqual([
      { file: "docker", args: ["build", "-t", "scp-runner-test:local", "apps/runner-scan"] }
    ]);

    vi.unstubAllEnvs();
  });
});
