/**
 * THE single place that answers "which skopeo binary do we run, and is it the one we pinned?".
 *
 * M15.5 c1 vendors a digest-pinned skopeo into the SCP runtime image (Dockerfile's `skopeo`
 * stage; provenance in `tools/skopeo/README.md`; pin values in `tools/skopeo/pin.env`), the
 * exact shape M17.3 E1 established for cosign — see `cosign-bin.ts`, whose module comment
 * explains the pinned-vs-operator split this mirrors:
 *
 *   PINNED   — the vendored wrapper at {@link VENDORED_SKOPEO_PATH} (or an explicit
 *              `SCP_SKOPEO_BIN` override). We built the image, we know the exact release, so we
 *              FAIL CLOSED if `skopeo --version` doesn't report the pinned version. A skopeo that
 *              isn't the skopeo we vetted is not a skopeo the relay moves bytes with.
 *   UNPINNED — `skopeo` resolved from PATH, i.e. an operator-supplied build. The release/bundle
 *              path (deploy/airgap's build-bundle.ts and install.sh) legitimately uses the
 *              operator's own skopeo and stays exactly as it was: probing, never
 *              version-asserted. Nothing on that path calls this module.
 *
 * This module lives in @scp/cosign beside resolveCosign() deliberately (shared exec helpers, one
 * pin-vs-probe pattern in one package); the M15.5 c2 relay — the first real consumer — imports
 * both from here. Like cosign-bin.ts, this module holds NO product behavior: nothing here copies
 * images or decides policy. It is resolution + provenance assertion only.
 */
import { existsSync } from "node:fs";
import { run, which } from "./exec.js";

/**
 * The pinned skopeo release. MUST match `SKOPEO_PINNED_VERSION` in `tools/skopeo/pin.env`
 * (and therefore the digest below) — `skopeo-bin.test.ts` fails if they drift. Note upstream
 * reports the version WITHOUT a leading `v` (`skopeo version 1.22.2 commit: …`).
 */
export const PINNED_SKOPEO_VERSION = "1.22.2";

/**
 * The exact upstream image the binary (and its library closure — see the Dockerfile's skopeo
 * COPY block) is taken from: the official skopeo image's **linux/amd64 platform manifest**
 * digest. Recorded here so a running system can report its own provenance without shelling out
 * to a registry.
 */
export const PINNED_SKOPEO_IMAGE =
  "quay.io/skopeo/stable@sha256:8b23fe434af822adf71bc7c8674a8dfab379771aa1400fb81ff655a5cecfca87";

/**
 * Where the Dockerfile puts the vendored entry point inside the SCP runtime image — a wrapper
 * script that runs the real binary against its vendored loader + libraries (the upstream binary
 * is dynamically linked, unlike cosign's). Deliberately NOT /usr/local/bin, so this check can
 * never pick up an operator-installed skopeo and mislabel it as "pinned".
 */
export const VENDORED_SKOPEO_PATH = "/opt/scp/bin/skopeo";

/** Environment variable that points at a pinned skopeo living somewhere else (CI, dev machines). */
export const SKOPEO_BIN_ENV = "SCP_SKOPEO_BIN";

export type SkopeoSource =
  /** `SCP_SKOPEO_BIN` — an explicitly designated pinned binary. */
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

/**
 * Resolve the skopeo to use, preferring the pinned binary.
 *
 * Order: `SCP_SKOPEO_BIN` → the vendored image path → PATH. Identical shape to
 * {@link resolveCosign} in cosign-bin.ts, and for the same reason: `pinned` must be true ONLY
 * for a binary this repo vetted, never for whatever a Homebrew/apt install put on PATH.
 */
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

/**
 * FAIL CLOSED: throw unless `bin` really is the pinned release.
 *
 * Same supply-chain failure mode as {@link assertPinnedCosignVersion}: an image rebuilt against
 * a moved tag, an `SCP_SKOPEO_BIN` pointed at some other build. The only safe response to "the
 * binary isn't the one we vetted" is to refuse, never to shrug and use it anyway.
 */
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
