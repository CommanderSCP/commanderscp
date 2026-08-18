import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atLineStart, readHashStripped } from "@scp/source-census";

/**
 * SCANNER PIN DRIFT GATE (mirrors deploy/airgap/src/cosign-bin.test.ts's role for cosign): the single
 * sources of truth are `tools/trivy/pin.env` and `tools/openscap/pin.env`; `apps/runner-scan/Dockerfile`'s
 * `ARG TRIVY_IMAGE` / `ARG OPENSCAP_IMAGE` defaults carry copies. This test fails the build if a copy
 * drifts — so the runner image can never be built FROM anything but the vetted, human-verified pins.
 * Pure text parsing — no Docker, runs in the fast `pnpm test` layer. It is also a FAIL-CLOSED VERSION
 * check: an unset/blank pin (the old stub state) fails the suite.
 *
 * ================================================================================================
 * WHY THE DOCKERFILE IS READ THROUGH `@scp/source-census` AND NOT `readFileSync`
 * ================================================================================================
 * MEASURED 2026-08-17: commenting out `ARG TRIVY_IMAGE=` and `ARG OPENSCAP_IMAGE=` in
 * `apps/runner-scan/Dockerfile` left this file green at 7/7. `readPin` below was already immune (it
 * skips `#` lines), but every Dockerfile assertion read raw text, so a drift gate over the pins that
 * decide WHICH SCANNER BINARY RUNS could be satisfied by a comment.
 *
 * The oscap-version case was worse than a hypothetical: `apps/runner-scan/Dockerfile` carries TWO
 * prose comments (lines 42 and 85) that quote the assertion — ``oscap --version | grep -qF "(oscap)
 * ${OPENSCAP_PINNED_VERSION}"`` — verbatim, to explain it. The unanchored search below matched those
 * comments, so the RUN step doing the actual fail-closed check could have been deleted outright with
 * this suite still green. That is the "well-written comment naming a hazard" trap from CLAUDE.md,
 * live: the documentation of a control was standing in for the control.
 *
 * Two readers, because the shapes differ: `atLineStart` for the `ARG …=` lines (which begin their
 * line, so a `#` cannot precede them), and `readHashStripped` for the `RUN` block, whose live lines
 * are CONTINUATIONS starting `&& oscap …` / `\` and therefore cannot be anchored at all.
 *
 * AND THE LIMIT: this fixes the comment case and no more. It still cannot see a `FROM` stage the
 * final image never draws from, a `RUN` behind a shell condition that is never true, or the same
 * text inside a heredoc. What the pin CANNOT be talked out of is the build itself — the
 * `oscap --version | grep -qF` step fails the image build on drift, and `scanner-containment.test.ts`
 * proves the scanners exist nowhere else.
 *
 * ================================================================================================
 * THAT BACKSTOP CLAIM, VERIFIED RATHER THAN ASSERTED (2026-08-17)
 * ================================================================================================
 * "The build itself is the real gate" is exactly the shape of claim that turns out to be false — a
 * signal that is read while no actuator exists. So it was checked, and it holds. Both halves:
 *
 *   THE STEP IS REAL. `apps/runner-scan/Dockerfile` names the version assertion three times: lines
 *   42 and 85 are the PROSE COMMENTS described above, and line 90 is the live `RUN` continuation
 *   that pipes a `--version` call into `grep -qF` against `${OPENSCAP_PINNED_VERSION}`.
 *   `readHashStripped` removes whole-line `#` comments, so 42 and 85 are gone by the time the
 *   assertion below runs and only line 90 can satisfy it. That is the M21.7 fix doing its job,
 *   confirmed by reading the stripped text rather than by trusting the change.
 *
 *   THE QUOTE THAT USED TO BE HERE WAS ITSELF A CONTAINMENT VIOLATION, which is worth leaving a
 *   note about rather than silently rewording. This paragraph originally reproduced line 90
 *   verbatim, `&&` and all — and `scanner-containment.test.ts` failed it, because a scanner name in
 *   shell COMMAND POSITION inside a `packages/**` file is exactly what that gate forbids, and its
 *   invocation detector reads RAW on purpose so a comment cannot hide one. The gate was right: a
 *   file explaining a control had started to look like the control. Describe the step; do not
 *   re-type it. (`packages/source-census`'s own fixture was fixed for the same reason in fb3e1a2,
 *   by renaming its sample binary to a neutral placeholder.)
 *
 *   THE BUILD ACTUALLY RUNS, ON EVERY PR. CI job 4c ("Prebuild + publish runner images to GHCR")
 *   builds `apps/runner-scan` with no main-only guard — its own comment: "Runs on every push/PR …
 *   so a PR that touches a runner Dockerfile or a scanner pin rebuilds + republishes before the
 *   integration job pulls it." A version drift therefore fails a PR check, not just a release.
 *
 * The one thing neither half covers: DELETING the `RUN` step. The build would then succeed with no
 * assertion at all, and only the census below would notice — which is precisely why it is anchored
 * to the code rather than reading raw text, and why it is worth keeping now that the prose comments
 * can no longer satisfy it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const TRIVY_PIN_ENV = resolve(REPO_ROOT, "tools/trivy/pin.env");
const OPENSCAP_PIN_ENV = resolve(REPO_ROOT, "tools/openscap/pin.env");
const DOCKERFILE = resolve(REPO_ROOT, "apps/runner-scan/Dockerfile");

/** Read a `KEY=value` (last wins), ignoring comments/blank lines — the shell-sourceable pin.env. */
function readPin(pinEnv: string, key: string): string | undefined {
  const text = readFileSync(pinEnv, "utf8");
  let value: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
    if (m && m[1] === key) value = m[2]!.trim();
  }
  return value;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;

describe("trivy pin drift gate", () => {
  it("pin.env carries a well-formed pinned index image and amd64 platform digest", () => {
    const image = readPin(TRIVY_PIN_ENV, "TRIVY_PINNED_IMAGE");
    expect(image, "TRIVY_PINNED_IMAGE must be set in tools/trivy/pin.env").toBeDefined();
    expect(image).toMatch(/^aquasec\/trivy@sha256:[a-f0-9]{64}$/);
    const amd64 = readPin(TRIVY_PIN_ENV, "TRIVY_PINNED_AMD64_DIGEST");
    expect(amd64, "TRIVY_PINNED_AMD64_DIGEST must be recorded for provenance").toMatch(SHA256);
    // The index digest and the amd64 platform digest are DIFFERENT artifacts (see the pin.env
    // rationale on why the runner FROMs the index, not the platform).
    expect(image).not.toContain(amd64!.slice("sha256:".length));
    expect(readPin(TRIVY_PIN_ENV, "TRIVY_PINNED_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("apps/runner-scan/Dockerfile FROMs exactly the pin.env TRIVY_PINNED_IMAGE (no drift)", () => {
    const pinnedImage = readPin(TRIVY_PIN_ENV, "TRIVY_PINNED_IMAGE");
    const dockerfile = readHashStripped(DOCKERFILE);
    const argMatch = atLineStart(/ARG\s+TRIVY_IMAGE=(\S+)/).exec(dockerfile);
    expect(argMatch, "apps/runner-scan/Dockerfile must set `ARG TRIVY_IMAGE=<pin>`").not.toBeNull();
    expect(argMatch![1]).toBe(pinnedImage);
    // The (stage-1) FROM must resolve to that ARG (content-addressed, no floating tag).
    expect(dockerfile).toMatch(atLineStart(/FROM\s+\$\{TRIVY_IMAGE\}\s+AS\s+trivy/));
  });
});

describe("openscap pin drift gate (M13.3b — the second managed-scan method)", () => {
  it("pin.env carries a REAL (non-stub), well-formed pinned index image + amd64 platform digest + version", () => {
    const image = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_PINNED_IMAGE");
    // FAIL CLOSED on the old stub state (empty value).
    expect(image, "OPENSCAP_PINNED_IMAGE must be a REAL pin, not the empty stub").toBeTruthy();
    expect(image).toMatch(/^[a-z0-9./-]+@sha256:[a-f0-9]{64}$/);
    const repo = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_UPSTREAM_REPO");
    expect(repo, "OPENSCAP_UPSTREAM_REPO must name the base repo").toBeTruthy();
    expect(image!.startsWith(repo + "@")).toBe(true);
    const amd64 = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_PINNED_AMD64_DIGEST");
    expect(amd64, "OPENSCAP_PINNED_AMD64_DIGEST must be recorded for provenance").toMatch(SHA256);
    // Index digest and amd64 platform digest are DIFFERENT artifacts (same rationale as trivy).
    expect(image).not.toContain(amd64!.slice("sha256:".length));
    const version = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_PINNED_VERSION");
    expect(version, "OPENSCAP_PINNED_VERSION must be set (not the empty stub)").toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it("apps/runner-scan/Dockerfile FROMs exactly the pin.env OPENSCAP_PINNED_IMAGE (no drift)", () => {
    const pinnedImage = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_PINNED_IMAGE");
    const dockerfile = readHashStripped(DOCKERFILE);
    const argMatch = atLineStart(/ARG\s+OPENSCAP_IMAGE=(\S+)/).exec(dockerfile);
    expect(
      argMatch,
      "apps/runner-scan/Dockerfile must set `ARG OPENSCAP_IMAGE=<pin>`"
    ).not.toBeNull();
    expect(argMatch![1]).toBe(pinnedImage);
    // The FINAL FROM must resolve to that ARG (content-addressed, no floating tag).
    expect(dockerfile).toMatch(atLineStart(/FROM\s+\$\{OPENSCAP_IMAGE\}/));
  });

  it("apps/runner-scan/Dockerfile pins the oscap version to pin.env OPENSCAP_PINNED_VERSION (no drift)", () => {
    // Mirrors the image drift check: the Dockerfile's `ARG OPENSCAP_PINNED_VERSION` default must equal
    // pin.env's OPENSCAP_PINNED_VERSION byte-for-byte (not just a well-formed version string).
    const pinnedVersion = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_PINNED_VERSION");
    const dockerfile = readHashStripped(DOCKERFILE);
    const argMatch = atLineStart(/ARG\s+OPENSCAP_PINNED_VERSION=(\S+)/).exec(dockerfile);
    expect(
      argMatch,
      "apps/runner-scan/Dockerfile must set `ARG OPENSCAP_PINNED_VERSION=<pin>`"
    ).not.toBeNull();
    expect(argMatch![1]).toBe(pinnedVersion);
  });

  it("apps/runner-scan/Dockerfile asserts the oscap version FAIL-CLOSED (build fails on drift)", () => {
    // The security-relevant guarantee: the build must assert the RUNNING oscap equals the pin, not
    // merely that oscap runs. A `grep -qF` on `oscap --version` against ${OPENSCAP_PINNED_VERSION}
    // makes the build exit non-zero on any version drift.
    const dockerfile = readHashStripped(DOCKERFILE);
    expect(
      dockerfile,
      "Dockerfile must assert `oscap --version | grep -qF ...${OPENSCAP_PINNED_VERSION}` (fail-closed)"
    ).toMatch(/oscap\s+--version\s*\|\s*grep\s+-qF\b[^\n]*\$\{OPENSCAP_PINNED_VERSION\}/);
  });

  it("apps/runner-scan/Dockerfile installs oscap/SSG from the snapshotted repo, NOT the floating default set", () => {
    // No-floating guard: the oscap+SSG install must be scoped to the frozen GA release repo
    // (--enablerepo=<pin.env OPENSCAP_INSTALL_REPO>) with the rolling repos disabled (--disablerepo=*),
    // so the tool version is reproducible from the pin rather than whatever the repos serve at build.
    const installRepo = readPin(OPENSCAP_PIN_ENV, "OPENSCAP_INSTALL_REPO");
    expect(
      installRepo,
      "OPENSCAP_INSTALL_REPO must name the frozen repo the Dockerfile installs from"
    ).toBeTruthy();
    const dockerfile = readHashStripped(DOCKERFILE);
    const installLine = /dnf\s+install[^\n]*openscap-scanner[^\n]*/.exec(
      dockerfile.replace(/\\\n\s*/g, " ")
    );
    expect(installLine, "Dockerfile must `dnf install ... openscap-scanner ...`").not.toBeNull();
    expect(installLine![0], "install must disable the rolling repos (--disablerepo=*)").toMatch(
      /--disablerepo=(["']?)\*\1/
    );
    expect(installLine![0], "install must enable only the pinned frozen repo").toContain(
      `--enablerepo=${installRepo}`
    );
  });
});
