import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TRIVY PIN DRIFT GATE (mirrors deploy/airgap/src/cosign-bin.test.ts's role for cosign): the single
 * source of truth is `tools/trivy/pin.env`; `apps/runner-scan/Dockerfile`'s `ARG TRIVY_IMAGE`
 * default carries a copy. This test fails the build if the copy drifts — so the runner image can
 * never be built FROM anything but the vetted, human-verified pin (tools/trivy/README.md "Trust on
 * first vendor"). Pure text parsing — no Docker, runs in the fast `pnpm test` layer.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const PIN_ENV = resolve(REPO_ROOT, "tools/trivy/pin.env");
const DOCKERFILE = resolve(REPO_ROOT, "apps/runner-scan/Dockerfile");

/** Read a `KEY=value` (last wins), ignoring comments/blank lines — the shell-sourceable pin.env. */
function readPin(key: string): string | undefined {
  const text = readFileSync(PIN_ENV, "utf8");
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
    const image = readPin("TRIVY_PINNED_IMAGE");
    expect(image, "TRIVY_PINNED_IMAGE must be set in tools/trivy/pin.env").toBeDefined();
    expect(image).toMatch(/^aquasec\/trivy@sha256:[a-f0-9]{64}$/);
    const amd64 = readPin("TRIVY_PINNED_AMD64_DIGEST");
    expect(amd64, "TRIVY_PINNED_AMD64_DIGEST must be recorded for provenance").toMatch(SHA256);
    // The index digest and the amd64 platform digest are DIFFERENT artifacts (see the pin.env
    // rationale on why the runner FROMs the index, not the platform).
    expect(image).not.toContain(amd64!.slice("sha256:".length));
    expect(readPin("TRIVY_PINNED_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("apps/runner-scan/Dockerfile FROMs exactly the pin.env TRIVY_PINNED_IMAGE (no drift)", () => {
    const pinnedImage = readPin("TRIVY_PINNED_IMAGE");
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const argMatch = /ARG\s+TRIVY_IMAGE=(\S+)/.exec(dockerfile);
    expect(argMatch, "apps/runner-scan/Dockerfile must set `ARG TRIVY_IMAGE=<pin>`").not.toBeNull();
    expect(argMatch![1]).toBe(pinnedImage);
    // The FROM must resolve to that ARG (content-addressed, no floating tag).
    expect(dockerfile).toMatch(/FROM\s+\$\{TRIVY_IMAGE\}/);
  });
});
