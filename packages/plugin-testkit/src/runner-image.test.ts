import { describe, expect, it, vi } from "vitest";

/** `resolveRunnerImage` HAD NO TESTS, and it is not a stub. See docs/plugin-testkit.md §10. */

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
