import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolveRunnerImageOptions {
  /** Env var CI sets to a pre-pulled image ref. See docs/plugin-testkit.md §11. */
  refEnvVar: string;
  /**
   * Local dev fallback tag to build when `refEnvVar` is unset (e.g.
   * `scp-runner-scan:m13-3a-integration-test`). Built from `context` with the LEGACY builder.
   */
  localTag: string;
  context: string;
  /** OPTIONAL — an out-of-tree Dockerfile (`docker build -f <dockerfile> <context>`). Every existing
   *  caller builds `<context>/Dockerfile` implicitly; `scp-runner-dep-vendor` is the one image whose
   *  build context (the repo root, for its `workspace:*` deps — see its Dockerfile's own header) is
   *  not the directory its Dockerfile lives in. */
  dockerfile?: string;
}

/** Resolve the runner image: CI ref, else local build. See docs/plugin-testkit.md §12. */
export async function resolveRunnerImage(opts: ResolveRunnerImageOptions): Promise<string> {
  const preBuilt = process.env[opts.refEnvVar];
  if (preBuilt && preBuilt.trim() !== "") {
    return preBuilt.trim();
  }
  const fileArgs = opts.dockerfile ? ["-f", opts.dockerfile] : [];
  await execFileAsync("docker", ["build", ...fileArgs, "-t", opts.localTag, opts.context], {
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOCKER_BUILDKIT: "0" }
  });
  return opts.localTag;
}
