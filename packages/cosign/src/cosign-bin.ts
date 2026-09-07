/** Which cosign binary runs, and is it the one we pinned. See docs/cosign.md §1. */
import { existsSync } from "node:fs";
import { run, which } from "./exec.js";

/**
 * The pinned cosign release. MUST match `COSIGN_PINNED_VERSION` in `tools/cosign/pin.env`
 * (and therefore the digest below) — `cosign-bin.test.ts` fails if they drift.
 */
export const PINNED_COSIGN_VERSION = "v3.1.2";

/** The upstream image digest, so a system can report provenance. See docs/cosign.md §2. */
export const PINNED_COSIGN_IMAGE =
  "ghcr.io/sigstore/cosign/cosign@sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7";

/** Where the Dockerfile puts the vendored binary inside the SCP runtime image. */
export const VENDORED_COSIGN_PATH = "/opt/scp/bin/cosign";

/** Environment variable that points at a pinned cosign living somewhere else (CI, dev machines). */
export const COSIGN_BIN_ENV = "SCP_COSIGN_BIN";

export type CosignSource =
  /** `SCP_COSIGN_BIN` — an explicitly designated pinned binary (CI extracts one; see scripts/install-pinned-cosign.sh). */
  | "override"
  /** The binary vendored into the runtime image at {@link VENDORED_COSIGN_PATH}. */
  | "vendored"
  /** Operator-supplied `cosign` found on PATH. */
  | "path"
  /** No cosign anywhere. */
  | "missing";

export interface ResolvedCosign {
  /** argv[0] to execute — an absolute path when pinned, the bare name `cosign` when resolved from PATH. */
  bin: string;
  /** True only when `bin` is a binary this repo pinned; drives static-flags + fail-closed version assertion. */
  pinned: boolean;
  source: CosignSource;
}

/** Resolve the cosign to use, preferring the pinned binary. Order. See docs/cosign.md §3. */
export function resolveCosign(): ResolvedCosign {
  const override = process.env[COSIGN_BIN_ENV];
  if (override) return { bin: override, pinned: true, source: "override" };
  if (existsSync(VENDORED_COSIGN_PATH)) {
    return { bin: VENDORED_COSIGN_PATH, pinned: true, source: "vendored" };
  }
  if (which("cosign")) return { bin: "cosign", pinned: false, source: "path" };
  return { bin: "cosign", pinned: false, source: "missing" };
}

/** `cosign version`'s reported `GitVersion:` (e.g. `v3.1.2`), or null if the binary can't be run/parsed. */
export function cosignReportedVersion(bin: string): string | null {
  try {
    const { stdout, stderr } = run(bin, ["version"], { log: false });
    const match = /GitVersion:\s*(\S+)/.exec(stdout + stderr);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** FAIL CLOSED: throw unless `bin` really is the pinned release. See docs/cosign.md §4. */
export function assertPinnedCosignVersion(resolved: ResolvedCosign): void {
  if (!resolved.pinned) return;
  const reported = cosignReportedVersion(resolved.bin);
  if (reported === null) {
    throw new Error(
      `pinned cosign at ${resolved.bin} could not be executed or did not report a version — ` +
        `refusing to proceed (expected ${PINNED_COSIGN_VERSION} from ${PINNED_COSIGN_IMAGE}).`
    );
  }
  if (reported !== PINNED_COSIGN_VERSION) {
    throw new Error(
      `pinned cosign version mismatch at ${resolved.bin}: reported ${reported}, pin is ` +
        `${PINNED_COSIGN_VERSION} (${PINNED_COSIGN_IMAGE}). Refusing to sign/verify with an ` +
        `unvetted cosign — see tools/cosign/README.md "Updating the pin".`
    );
  }
}
