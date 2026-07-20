/**
 * THE single place that answers "which cosign binary do we run, and is it the one we pinned?".
 *
 * M17.3 E1 vendors a digest-pinned cosign into the SCP runtime image (Dockerfile's `cosign`
 * stage; provenance in `tools/cosign/README.md`; pin values in `tools/cosign/pin.env`). That
 * creates two genuinely different situations, and conflating them is how you either (a) probe a
 * binary you already know everything about on a signing hot path, or (b) silently assume an
 * operator's cosign behaves like ours:
 *
 *   PINNED   — the vendored binary at {@link VENDORED_COSIGN_PATH} (or an explicit
 *              `SCP_COSIGN_BIN` override). We built the image, we know the exact release, so we
 *              use a STATIC known-good flag set and FAIL CLOSED if `cosign version` doesn't
 *              report the pinned version. A cosign that isn't the cosign we vetted is not a
 *              cosign we sign with.
 *   UNPINNED — `cosign` resolved from PATH, i.e. an operator-supplied build. Air-gap operators
 *              legitimately bring their own (BUILD_AND_TEST.md §1), so the version-ADAPTIVE
 *              `--help` probing in cosign.ts stays exactly as it was and remains the only
 *              behavior on this path.
 *
 * `--tlog-upload=false` (sign) and `--insecure-ignore-tlog=true` (verify) are UNCONDITIONAL on
 * both paths — they are the flags that keep signing from touching the public Rekor log, i.e.
 * charter principle 5, not a version-portability detail. See cosign.ts's module comment.
 *
 * This module deliberately holds NO product behavior: nothing here signs, verifies, or decides
 * policy. It is resolution + provenance assertion only.
 */
import { existsSync } from "node:fs";
import { run, which } from "./exec.js";

/**
 * The pinned cosign release. MUST match `COSIGN_PINNED_VERSION` in `tools/cosign/pin.env`
 * (and therefore the digest below) — `cosign-bin.test.ts` fails if they drift.
 */
export const PINNED_COSIGN_VERSION = "v3.1.2";

/**
 * The exact upstream image the binary is taken from: the sigstore cosign image's **linux/amd64
 * platform manifest** digest. Recorded here so a running system can report its own provenance
 * (scripts/doctor.mjs) without shelling out to a registry.
 */
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

/**
 * Resolve the cosign to use, preferring the pinned binary.
 *
 * Order: `SCP_COSIGN_BIN` → the vendored image path → PATH. Note the vendored path is
 * `/opt/scp/bin/cosign` precisely so this check can never accidentally pick up a Homebrew/apt
 * cosign at `/usr/local/bin/cosign` and mislabel someone else's build as "pinned".
 */
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

/**
 * FAIL CLOSED: throw unless `bin` really is the pinned release.
 *
 * Called before every signing/verification run on the pinned path. The failure mode this exists
 * for is a supply-chain one — an image rebuilt against a moved tag, an `SCP_COSIGN_BIN` pointed
 * at some other build — and the only safe response to "the binary isn't the one we vetted" is to
 * refuse, never to shrug and probe it like an operator binary.
 */
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
