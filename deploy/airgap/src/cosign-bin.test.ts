import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COSIGN_BIN_ENV,
  PINNED_COSIGN_IMAGE,
  PINNED_COSIGN_VERSION,
  VENDORED_COSIGN_PATH,
  assertPinnedCosignVersion,
  cosignReportedVersion,
  resolveCosign
} from "./cosign-bin.js";
import { REPO_ROOT } from "./repo-paths.js";

/** Parse `tools/cosign/pin.env` (the single source of truth) as KEY=VALUE pairs. */
function readPinEnv(): Record<string, string> {
  const text = readFileSync(path.join(REPO_ROOT, "tools/cosign/pin.env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * The cosign pin is a QUADRUPLE-string coupling — it appears in `tools/cosign/pin.env`, the
 * Dockerfile's build ARG, this package's TypeScript constants, and `scripts/doctor.mjs`. Nothing
 * at build or run time forces those to agree, so a stale copy would silently mean "the image
 * ships binary A while the code asserts version B". These tests are that forcing function.
 */
describe("cosign pin: every copy of the pin agrees with tools/cosign/pin.env", () => {
  const pin = readPinEnv();

  it("pin.env is well-formed (version + amd64 platform digest + paths)", () => {
    expect(pin.COSIGN_PINNED_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pin.COSIGN_PINNED_IMAGE).toMatch(
      /^ghcr\.io\/sigstore\/cosign\/cosign@sha256:[0-9a-f]{64}$/
    );
    expect(pin.COSIGN_UPSTREAM_PATH).toBe("/ko-app/cosign");
    expect(pin.COSIGN_VENDORED_PATH).toBe(VENDORED_COSIGN_PATH);
  });

  it("cosign-bin.ts constants match pin.env", () => {
    expect(PINNED_COSIGN_VERSION).toBe(pin.COSIGN_PINNED_VERSION);
    expect(PINNED_COSIGN_IMAGE).toBe(pin.COSIGN_PINNED_IMAGE);
  });

  it("the Dockerfile vendors exactly the pinned image into exactly the pinned path", () => {
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toContain(`ARG COSIGN_IMAGE=${pin.COSIGN_PINNED_IMAGE}`);
    expect(dockerfile).toContain(
      `COPY --from=cosign ${pin.COSIGN_UPSTREAM_PATH} ${pin.COSIGN_VENDORED_PATH}`
    );
  });

  it("scripts/doctor.mjs reports the same pin", () => {
    const doctor = readRepoFile("scripts/doctor.mjs");
    expect(doctor).toContain(pin.COSIGN_PINNED_VERSION);
    expect(doctor).toContain(pin.COSIGN_PINNED_IMAGE);
  });

  it("CI installs the pinned binary and no longer uses the unpinned network installer", () => {
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/deploy-drills.yml"]) {
      const text = readRepoFile(workflow);
      // Matches the `uses:` invocation only — the comments explaining WHY the installer was
      // dropped legitimately name it.
      expect(text, `${workflow} must not use sigstore/cosign-installer`).not.toMatch(
        /uses:\s*sigstore\/cosign-installer/
      );
      expect(text, `${workflow} must install the pinned cosign`).toContain(
        "scripts/install-pinned-cosign.sh"
      );
    }
  });
});

describe("cosign pin: resolution point", () => {
  const originalOverride = process.env[COSIGN_BIN_ENV];

  afterEach(() => {
    if (originalOverride === undefined) delete process.env[COSIGN_BIN_ENV];
    else process.env[COSIGN_BIN_ENV] = originalOverride;
  });

  it(`${COSIGN_BIN_ENV} designates a pinned binary`, () => {
    process.env[COSIGN_BIN_ENV] = "/somewhere/else/cosign";
    expect(resolveCosign()).toEqual({
      bin: "/somewhere/else/cosign",
      pinned: true,
      source: "override"
    });
  });

  it("without an override, resolution is never 'pinned' unless it found the vendored path", () => {
    delete process.env[COSIGN_BIN_ENV];
    const resolved = resolveCosign();
    // On a dev machine / CI runner this is normally the PATH cosign; inside the runtime image
    // it is the vendored one. Either way `pinned` must be true ONLY for the vendored path —
    // that is what keeps an operator's /usr/local/bin/cosign from being mislabelled as vetted.
    expect(resolved.pinned).toBe(resolved.bin === VENDORED_COSIGN_PATH);
  });

  it("an unpinned resolution is never version-asserted (operators bring their own cosign)", () => {
    expect(() =>
      assertPinnedCosignVersion({ bin: "cosign", pinned: false, source: "path" })
    ).not.toThrow();
  });
});

describe("cosign pin: the version assertion FAILS CLOSED", () => {
  it("throws when a pinned binary cannot be executed at all", () => {
    expect(() =>
      assertPinnedCosignVersion({
        bin: "/nonexistent/definitely-not-cosign",
        pinned: true,
        source: "override"
      })
    ).toThrow(/could not be executed|did not report a version/i);
  });

  it("throws when a pinned binary reports the WRONG version", () => {
    // `true` exits 0 and prints nothing, so it stands in for "some binary that is not our
    // cosign" without needing a second real cosign build on the box.
    expect(() =>
      assertPinnedCosignVersion({ bin: "/usr/bin/true", pinned: true, source: "override" })
    ).toThrow(/refusing|mismatch|did not report a version/i);
  });
});

/**
 * The real thing: when a pinned cosign is actually present (inside the runtime image, or in CI
 * where scripts/install-pinned-cosign.sh put one and pointed SCP_COSIGN_BIN at it), its reported
 * version MUST equal the pin. Skips — never falsely fails — where no pinned binary exists.
 */
const pinnedPresent = (() => {
  const resolved = resolveCosign();
  return resolved.pinned && cosignReportedVersion(resolved.bin) !== null;
})();

describe.skipIf(!pinnedPresent)("cosign pin: the resolved pinned binary IS the pinned release", () => {
  it("reports exactly the pinned version", () => {
    const resolved = resolveCosign();
    expect(cosignReportedVersion(resolved.bin)).toBe(PINNED_COSIGN_VERSION);
    expect(() => assertPinnedCosignVersion(resolved)).not.toThrow();
  });
});
