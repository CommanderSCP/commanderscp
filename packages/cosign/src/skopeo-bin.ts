/** Which skopeo binary runs, and is it the one we pinned. See docs/cosign.md §21. */
import { existsSync } from "node:fs";
import { run, which } from "./exec.js";

/** The pinned skopeo release. See docs/cosign.md §22. */
export const PINNED_SKOPEO_VERSION = "1.22.2";

/** The exact upstream image the binary. See docs/cosign.md §23. */
export const PINNED_SKOPEO_IMAGE =
  "quay.io/skopeo/stable@sha256:0e392474a4383b733038b85eff26ade929d2ff10e8deead25a6add3ed79fb362";

/** The vendored entry point, deliberately not in /usr/local/bin. See docs/cosign.md §24. */
export const VENDORED_SKOPEO_PATH = "/opt/scp/bin/skopeo";

/** Environment variable that points at a pinned skopeo living somewhere else (CI, dev machines). */
export const SKOPEO_BIN_ENV = "SCP_SKOPEO_BIN";

export type SkopeoSource =
  | "override"
  /** The wrapper vendored into the runtime image at {@link VENDORED_SKOPEO_PATH}. */
  | "vendored"
  /** Operator-supplied `skopeo` found on PATH (the release/bundle path's skopeo). */
  | "path"
  /** No skopeo anywhere. */
  | "missing";

export interface ResolvedSkopeo {
  /** argv[0] to execute — an absolute path when pinned, the bare name `skopeo` when resolved from PATH. */
  bin: string;
  /** True only when `bin` is a binary this repo pinned; drives the fail-closed version assertion. */
  pinned: boolean;
  source: SkopeoSource;
}

/** Resolve the skopeo to use, preferring the pinned binary. Order. See docs/cosign.md §25. */
export function resolveSkopeo(): ResolvedSkopeo {
  const override = process.env[SKOPEO_BIN_ENV];
  if (override) return { bin: override, pinned: true, source: "override" };
  if (existsSync(VENDORED_SKOPEO_PATH)) {
    return { bin: VENDORED_SKOPEO_PATH, pinned: true, source: "vendored" };
  }
  if (which("skopeo")) return { bin: "skopeo", pinned: false, source: "path" };
  return { bin: "skopeo", pinned: false, source: "missing" };
}

/** `skopeo --version`'s reported version (e.g. `1.22.2`), or null if the binary can't be run/parsed. */
export function skopeoReportedVersion(bin: string): string | null {
  try {
    const { stdout, stderr } = run(bin, ["--version"], { log: false });
    const match = /skopeo version\s+(\S+)/.exec(stdout + stderr);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** FAIL CLOSED: throw unless `bin` really is the pinned release. See docs/cosign.md §26. */
export function assertPinnedSkopeoVersion(resolved: ResolvedSkopeo): void {
  if (!resolved.pinned) return;
  const reported = skopeoReportedVersion(resolved.bin);
  if (reported === null) {
    throw new Error(
      `pinned skopeo at ${resolved.bin} could not be executed or did not report a version — ` +
        `refusing to proceed (expected ${PINNED_SKOPEO_VERSION} from ${PINNED_SKOPEO_IMAGE}).`
    );
  }
  if (reported !== PINNED_SKOPEO_VERSION) {
    throw new Error(
      `pinned skopeo version mismatch at ${resolved.bin}: reported ${reported}, pin is ` +
        `${PINNED_SKOPEO_VERSION} (${PINNED_SKOPEO_IMAGE}). Refusing to move bytes with an ` +
        `unvetted skopeo — see tools/skopeo/README.md "Updating the pin".`
    );
  }
}
