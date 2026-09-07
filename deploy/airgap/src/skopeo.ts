/** `skopeo` invocations for the BUILD side of the air-gap bundle. See docs/airgap.md §56. */
import { execFileSync } from "node:child_process";
import { run, which } from "@scp/cosign";

export function skopeoAvailable(): boolean {
  return which("skopeo");
}

/** Best-effort resolution of the local Docker socket. See docs/airgap.md §57. */
export function resolveDockerDaemonHost(): string | undefined {
  try {
    const out = execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      {
        encoding: "utf8"
      }
    ).trim();
    return out.startsWith("unix://") ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface CopyToOciOptions {
  /** "docker-daemon" reads from the local Docker engine; "docker" pulls from a registry (used when the image isn't loaded locally). */
  sourceType: "docker-daemon" | "docker";
  sourceRef: string;
  destDir: string;
  destTag: string;
  /** Only used when sourceType is "docker-daemon" — see resolveDockerDaemonHost(). */
  daemonHost?: string;
}

/** `skopeo copy <src> oci:<destDir>:<destTag>` — produces a single-platform OCI-layout directory. */
export function copyToOciLayout(opts: CopyToOciOptions): void {
  const src =
    opts.sourceType === "docker-daemon"
      ? `docker-daemon:${opts.sourceRef}`
      : `docker://${opts.sourceRef}`;
  const dest = `oci:${opts.destDir}:${opts.destTag}`;
  const args = ["copy"];
  if (opts.sourceType === "docker-daemon" && opts.daemonHost) {
    args.push("--src-daemon-host", opts.daemonHost);
  }
  args.push(src, dest);
  run("skopeo", args);
}
