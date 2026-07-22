import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PINNED_SKOPEO_IMAGE,
  PINNED_SKOPEO_VERSION,
  SKOPEO_BIN_ENV,
  VENDORED_SKOPEO_PATH,
  assertPinnedSkopeoVersion,
  resolveSkopeo,
  skopeoReportedVersion
} from "@scp/cosign";
import { REPO_ROOT } from "./repo-paths.js";

/** Parse `tools/skopeo/pin.env` (the single source of truth) as KEY=VALUE pairs. */
function readPinEnv(): Record<string, string> {
  const text = readFileSync(path.join(REPO_ROOT, "tools/skopeo/pin.env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * The skopeo pin is a TRIPLE-string coupling — `tools/skopeo/pin.env`, the Dockerfile's build
 * ARG + COPY block, and `packages/cosign/src/skopeo-bin.ts`'s constants. Nothing at build or run
 * time forces those to agree, so a stale copy would silently mean "the image ships binary A
 * while the code asserts version B". These tests are that forcing function — the same shape as
 * cosign-bin.test.ts, which guards the cosign pin's quadruple coupling.
 */
describe("skopeo pin: every copy of the pin agrees with tools/skopeo/pin.env", () => {
  const pin = readPinEnv();

  it("pin.env is well-formed (version + amd64 platform digest + paths)", () => {
    // Upstream reports the version WITHOUT a leading `v` (unlike cosign).
    expect(pin.SKOPEO_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin.SKOPEO_PINNED_IMAGE).toMatch(/^quay\.io\/skopeo\/stable@sha256:[0-9a-f]{64}$/);
    expect(pin.SKOPEO_UPSTREAM_PATH).toBe("/usr/bin/skopeo");
    expect(pin.SKOPEO_VENDORED_PATH).toBe(VENDORED_SKOPEO_PATH);
    expect(pin.SKOPEO_LIBEXEC_DIR).toBe("/opt/scp/libexec/skopeo");
  });

  it("skopeo-bin.ts constants match pin.env", () => {
    expect(PINNED_SKOPEO_VERSION).toBe(pin.SKOPEO_PINNED_VERSION);
    expect(PINNED_SKOPEO_IMAGE).toBe(pin.SKOPEO_PINNED_IMAGE);
  });

  it("the Dockerfile vendors exactly the pinned image into exactly the pinned paths", () => {
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toContain(`ARG SKOPEO_IMAGE=${pin.SKOPEO_PINNED_IMAGE}`);
    // The real ELF binary goes to libexec; the wrapper (which runs it against the vendored
    // loader + libs — the binary is dynamically linked) is what lands on the vendored path.
    expect(dockerfile).toContain(
      `COPY --from=skopeo ${pin.SKOPEO_UPSTREAM_PATH} ${pin.SKOPEO_LIBEXEC_DIR}/skopeo`
    );
    expect(dockerfile).toContain(
      `COPY tools/skopeo/skopeo-wrapper.sh ${pin.SKOPEO_VENDORED_PATH}`
    );
    expect(dockerfile).toContain("COPY tools/skopeo/policy.json /etc/containers/policy.json");
  });

  it("the wrapper runs the vendored binary against the vendored loader, from the libexec dir", () => {
    const wrapper = readRepoFile("tools/skopeo/skopeo-wrapper.sh");
    expect(wrapper).toContain(`d=${pin.SKOPEO_LIBEXEC_DIR}`);
    expect(wrapper).toContain('exec "$d/lib/ld-linux-x86-64.so.2" --library-path "$d/lib" "$d/skopeo" "$@"');
  });

  it("the release path is untouched: install.sh still uses the operator's PATH skopeo", () => {
    // The vendored skopeo is for the runtime image (the c2 relay), NOT for the air-gap
    // release/bundle path — install.sh runs on an operator's install target where
    // /opt/scp/bin does not exist, and its skopeo remains the operator-supplied one.
    const installSh = readRepoFile("deploy/airgap/assets/install.sh");
    expect(installSh).not.toContain("/opt/scp/bin/skopeo");
    expect(installSh).not.toContain(SKOPEO_BIN_ENV);
  });
});

describe("skopeo pin: resolution point", () => {
  const originalOverride = process.env[SKOPEO_BIN_ENV];

  afterEach(() => {
    if (originalOverride === undefined) delete process.env[SKOPEO_BIN_ENV];
    else process.env[SKOPEO_BIN_ENV] = originalOverride;
  });

  it(`${SKOPEO_BIN_ENV} designates a pinned binary`, () => {
    process.env[SKOPEO_BIN_ENV] = "/somewhere/else/skopeo";
    expect(resolveSkopeo()).toEqual({
      bin: "/somewhere/else/skopeo",
      pinned: true,
      source: "override"
    });
  });

  it("without an override, resolution is never 'pinned' unless it found the vendored path", () => {
    delete process.env[SKOPEO_BIN_ENV];
    const resolved = resolveSkopeo();
    // On a dev machine / CI runner this is normally the PATH skopeo (the same one the
    // release-path suites use); inside the runtime image it is the vendored wrapper. Either way
    // `pinned` must be true ONLY for the vendored path — that is what keeps an operator's
    // /usr/local/bin/skopeo from being mislabelled as vetted.
    expect(resolved.pinned).toBe(resolved.bin === VENDORED_SKOPEO_PATH);
  });

  it("an unpinned resolution is never version-asserted (operators bring their own skopeo)", () => {
    expect(() =>
      assertPinnedSkopeoVersion({ bin: "skopeo", pinned: false, source: "path" })
    ).not.toThrow();
  });
});

describe("skopeo pin: the version assertion FAILS CLOSED", () => {
  it("throws when a pinned binary cannot be executed at all", () => {
    expect(() =>
      assertPinnedSkopeoVersion({
        bin: "/nonexistent/definitely-not-skopeo",
        pinned: true,
        source: "override"
      })
    ).toThrow(/could not be executed|did not report a version/i);
  });

  it("throws when a pinned binary reports the WRONG version", () => {
    // `true` exits 0 and prints nothing, so it stands in for "some binary that is not our
    // skopeo" without needing a second real skopeo build on the box.
    expect(() =>
      assertPinnedSkopeoVersion({ bin: "/usr/bin/true", pinned: true, source: "override" })
    ).toThrow(/refusing|mismatch|did not report a version/i);
  });
});

/**
 * The real thing: when a pinned skopeo is actually present (inside the runtime image, or wherever
 * SCP_SKOPEO_BIN points at an extracted pin), its reported version MUST equal the pin. Skips —
 * never falsely fails — where no pinned binary exists (dev machines and today's CI, whose PATH
 * skopeo serves the release-path suites and is deliberately unpinned).
 */
const pinnedPresent = (() => {
  const resolved = resolveSkopeo();
  return resolved.pinned && skopeoReportedVersion(resolved.bin) !== null;
})();

describe.skipIf(!pinnedPresent)("skopeo pin: the resolved pinned binary IS the pinned release", () => {
  it("reports exactly the pinned version", () => {
    const resolved = resolveSkopeo();
    expect(skopeoReportedVersion(resolved.bin)).toBe(PINNED_SKOPEO_VERSION);
    expect(() => assertPinnedSkopeoVersion(resolved)).not.toThrow();
  });
});
