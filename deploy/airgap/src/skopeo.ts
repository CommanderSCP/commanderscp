/**
 * `skopeo` invocations for the BUILD side of the air-gap bundle: docker-daemon:<image> (or
 * docker://<image>) --> oci:<dir>:<tag>, used by build-bundle.ts. The INSTALL-time direction
 * (oci:<dir>:<tag> --> docker://<customer-registry>/<name>:<tag>, plus the post-copy
 * `skopeo inspect --format '{{.Digest}}'` re-verification) is deliberately NOT duplicated here as
 * a Node wrapper — that logic lives directly in install.sh (bash), which is the artifact that
 * actually runs on an operator's air-gapped install target and must not depend on this project's
 * own Node/pnpm toolchain being present there. Keeping a second, untested, uncalled Node
 * implementation of the same push+re-verify logic here would just be a second place for the two
 * to silently drift; see install.sh's own header comment for that logic's real implementation.
 *
 * `--src-daemon-host` matters on this dev machine specifically: Docker Desktop/Colima/Podman
 * don't all live at the `unix:///var/run/docker.sock` skopeo defaults to, so this module resolves
 * the daemon socket the same way `docker context inspect` would rather than hard-coding a path
 * (verified empirically against this machine's Colima context — see the package README).
 */
import { execFileSync } from "node:child_process";
import { run, which } from "./exec.js";

export function skopeoAvailable(): boolean {
  return which("skopeo");
}

/**
 * Best-effort resolution of the local Docker daemon's socket, so `docker-daemon:` sources work
 * regardless of whether the engine is Docker Desktop, Colima, or plain dockerd. Falls back to
 * undefined (skopeo's own default, `/var/run/docker.sock`) if `docker context inspect` isn't
 * available or doesn't report a unix socket (e.g. a remote/TCP context) — in that case skopeo's
 * default or the operator's own `DOCKER_HOST` env var applies unmodified.
 */
export function resolveDockerDaemonHost(): string | undefined {
  try {
    const out = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      encoding: "utf8"
    }).trim();
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
  const src = opts.sourceType === "docker-daemon" ? `docker-daemon:${opts.sourceRef}` : `docker://${opts.sourceRef}`;
  const dest = `oci:${opts.destDir}:${opts.destTag}`;
  const args = ["copy"];
  if (opts.sourceType === "docker-daemon" && opts.daemonHost) {
    args.push("--src-daemon-host", opts.daemonHost);
  }
  args.push(src, dest);
  run("skopeo", args);
}

