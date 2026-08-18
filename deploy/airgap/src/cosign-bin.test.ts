import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atLineStart, readHashStripped, readStripped } from "@scp/source-census";
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

/**
 * Parse `tools/cosign/pin.env` (the single source of truth) as KEY=VALUE pairs.
 *
 * Already comment-proof, and deliberately left as-is: the key pattern is anchored to the start of
 * the trimmed line and admits only `[A-Z_]`, so a `#`-prefixed line cannot become a pin. It is the
 * shape `@scp/source-census`'s {@link atLineStart} generalises.
 */
function readPinEnv(): Record<string, string> {
  const text = readFileSync(path.join(REPO_ROOT, "tools/cosign/pin.env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

/** Raw bytes. ONLY for an ABSENCE assertion, where a comment marker makes the check strictly
 *  harder to pass and stripping would therefore weaken it. Every PRESENCE assertion below reads
 *  through `@scp/source-census` instead. */
function readRepoFileRaw(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * The cosign pin is a QUADRUPLE-string coupling — it appears in `tools/cosign/pin.env`, the
 * Dockerfile's build ARG, this package's TypeScript constants, and `scripts/doctor.mjs`. Nothing
 * at build or run time forces those to agree, so a stale copy would silently mean "the image
 * ships binary A while the code asserts version B". These tests are that forcing function.
 *
 * ================================================================================================
 * WHY THE READS BELOW GO THROUGH `@scp/source-census` AND NOT `readFileSync`
 * ================================================================================================
 * MEASURED 2026-08-17: commenting out `ARG COSIGN_IMAGE=…` at `Dockerfile:28` left this file green
 * at 10 passed / 1 skipped. A `.toContain(…)` over raw text cannot tell a live pin from a
 * commented-out one, so the gate whose entire purpose is "the runner image cannot ship an unvetted
 * binary" was satisfied by a DESCRIPTION of the pin. Three files in three packages had it.
 *
 * The fix is per-language, because the languages are: the Dockerfile comments with `#` (so a
 * presence assertion is anchored to the start of a line, where a `#` cannot precede it),
 * `doctor.mjs` comments with `//` (so it is read stripped), and the workflows are YAML whose token
 * sits mid-line (so whole-line `#` comments are removed and the token matched inside what is left).
 *
 * AND THE LIMIT, because an over-claiming census is what produced this: anchoring fixes the comment
 * case and NO MORE. These assertions still cannot see a Dockerfile stage nothing `COPY --from`s, a
 * workflow step disabled by an `if:` above it, or the pin appearing inside a quoted string. What
 * the pin gate CANNOT be talked out of is elsewhere: the fail-closed `cosign version` assertion at
 * the bottom of this file, which runs the resolved binary whenever a pinned one is present.
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
    // ANCHORED, not `.toContain`: both lines begin their line in the Dockerfile, so requiring that
    // is free — and it is what makes `# ARG COSIGN_IMAGE=…` fail here instead of passing.
    const dockerfile = readRepoFileRaw("Dockerfile");
    expect(dockerfile).toMatch(atLineStart(`ARG COSIGN_IMAGE=${pin.COSIGN_PINNED_IMAGE}`));
    expect(dockerfile).toMatch(
      atLineStart(`COPY --from=cosign ${pin.COSIGN_UPSTREAM_PATH} ${pin.COSIGN_VENDORED_PATH}`)
    );
  });

  it("scripts/doctor.mjs reports the same pin", () => {
    // `.mjs` is a `//`-comment language, so this is the TS/JS stripper, not the `#` one. Both pins
    // appear mid-line here (inside template literals in the report strings), so there is nothing to
    // anchor to — removing the comments is the whole of what can be done cheaply.
    const doctor = readStripped(path.join(REPO_ROOT, "scripts/doctor.mjs"));
    expect(doctor).toContain(pin.COSIGN_PINNED_VERSION);
    expect(doctor).toContain(pin.COSIGN_PINNED_IMAGE);
  });

  it("CI installs the pinned binary and no longer uses the unpinned network installer", () => {
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/deploy-drills.yml"]) {
      // Matches the `uses:` invocation only — the comments explaining WHY the installer was
      // dropped legitimately name it. RAW on purpose: this is an ABSENCE assertion, and stripping
      // comments could only shrink the text it searches, i.e. weaken it.
      expect(
        readRepoFileRaw(workflow),
        `${workflow} must not use sigstore/cosign-installer`
      ).not.toMatch(/uses:\s*sigstore\/cosign-installer/);
      // The PRESENCE half, and the one a comment could satisfy: the script name sits mid-line
      // (`run: scripts/install-pinned-cosign.sh`) and cannot be anchored, so the `#` comment lines
      // — which in ci.yml really do name the script, three lines above the `run:` that calls it —
      // are removed first.
      expect(
        readHashStripped(path.join(REPO_ROOT, workflow)),
        `${workflow} must install the pinned cosign`
      ).toContain("scripts/install-pinned-cosign.sh");
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

describe.skipIf(!pinnedPresent)(
  "cosign pin: the resolved pinned binary IS the pinned release",
  () => {
    it("reports exactly the pinned version", () => {
      const resolved = resolveCosign();
      expect(cosignReportedVersion(resolved.bin)).toBe(PINNED_COSIGN_VERSION);
      expect(() => assertPinnedCosignVersion(resolved)).not.toThrow();
    });
  }
);
