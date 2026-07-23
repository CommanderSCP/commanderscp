import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SCANNER PIN DRIFT GATE (mirrors deploy/airgap/src/cosign-bin.test.ts's role for cosign): the single
 * sources of truth are `tools/trivy/pin.env` and `tools/openscap/pin.env`; `apps/runner-scan/Dockerfile`'s
 * `ARG TRIVY_IMAGE` / `ARG OPENSCAP_IMAGE` defaults carry copies. This test fails the build if a copy
 * drifts — so the runner image can never be built FROM anything but the vetted, human-verified pins.
 * Pure text parsing — no Docker, runs in the fast `pnpm test` layer. It is also a FAIL-CLOSED VERSION
 * check: an unset/blank pin (the old stub state) fails the suite.
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
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const argMatch = /ARG\s+TRIVY_IMAGE=(\S+)/.exec(dockerfile);
    expect(argMatch, "apps/runner-scan/Dockerfile must set `ARG TRIVY_IMAGE=<pin>`").not.toBeNull();
    expect(argMatch![1]).toBe(pinnedImage);
    // The (stage-1) FROM must resolve to that ARG (content-addressed, no floating tag).
    expect(dockerfile).toMatch(/FROM\s+\$\{TRIVY_IMAGE\}\s+AS\s+trivy/);
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
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const argMatch = /ARG\s+OPENSCAP_IMAGE=(\S+)/.exec(dockerfile);
    expect(argMatch, "apps/runner-scan/Dockerfile must set `ARG OPENSCAP_IMAGE=<pin>`").not.toBeNull();
    expect(argMatch![1]).toBe(pinnedImage);
    // The FINAL FROM must resolve to that ARG (content-addressed, no floating tag).
    expect(dockerfile).toMatch(/FROM\s+\$\{OPENSCAP_IMAGE\}/);
  });
});
