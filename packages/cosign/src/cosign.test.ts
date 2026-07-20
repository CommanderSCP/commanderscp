import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COSIGN_BIN_ENV, VENDORED_COSIGN_PATH } from "./cosign-bin.js";

/**
 * These are the OFFLINE unit tests for the lifted @scp/cosign wrapper (M17.3 E2). They must never
 * touch the real cosign binary or the network — the real-binary sign/verify path stays covered by
 * deploy/airgap's install-sh-tamper suite (the zero-behavior-change proof). Here we assert the two
 * things that CAN be proven without a genuine cosign:
 *   1. the sign-blob FLAG BUILDER — its keyful/offline invariants and the pinned-vs-probe split;
 *   2. the E1 binary RESOLUTION (pin-vs-probe) branch — exercised against a FAKE cosign shim on
 *      PATH rather than a real install.
 *
 * The `--use-signing-config` probe caches its result at module scope, so every probe-branch case
 * re-imports the module fresh via `vi.resetModules()` to get a clean cache.
 */

let shimDir: string;
/** A fake cosign whose `sign-blob --help` ADVERTISES `--use-signing-config` (a newer/3.x build). */
let newerShim: string;
/** A fake cosign whose `sign-blob --help` does NOT mention it (an older 2.x build). */
let olderShim: string;

function writeShim(dir: string, name: string, helpBody: string): string {
  const p = path.join(dir, name);
  // Echoes canned `--help` text for any argv — enough for the flag probe, never signs anything.
  writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${helpBody}\nEOF\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  shimDir = mkdtempSync(path.join(tmpdir(), "scp-cosign-shim-"));
  newerShim = writeShim(
    shimDir,
    "cosign-newer",
    "Usage: cosign sign-blob\n  --tlog-upload            upload to the transparency log\n  --use-signing-config     use a signing config"
  );
  olderShim = writeShim(
    shimDir,
    "cosign-older",
    "Usage: cosign sign-blob\n  --tlog-upload            upload to the transparency log"
  );
  // A bare `cosign` so `which cosign` resolves on the PATH-resolution test.
  writeShim(shimDir, "cosign", "Usage: cosign");
});

const savedEnv = { PATH: process.env.PATH, override: process.env[COSIGN_BIN_ENV] };

afterEach(() => {
  process.env.PATH = savedEnv.PATH;
  if (savedEnv.override === undefined) delete process.env[COSIGN_BIN_ENV];
  else process.env[COSIGN_BIN_ENV] = savedEnv.override;
  vi.resetModules();
});

/** Re-import the flag builder with a fresh module cache (resets the `--use-signing-config` probe). */
async function freshSignBlobFlags() {
  vi.resetModules();
  return (await import("./cosign.js")).signBlobFlags;
}

describe("signBlobFlags — keyful/offline invariants (never Fulcio/Rekor)", () => {
  it("ALWAYS disables the Rekor upload and requests the legacy detached format", async () => {
    const signBlobFlags = await freshSignBlobFlags();
    for (const pinned of [true, false]) {
      const flags = signBlobFlags({ bin: pinned ? "/opt/scp/bin/cosign" : olderShim, pinned, source: pinned ? "vendored" : "path" });
      expect(flags).toContain("--tlog-upload=false");
      expect(flags).toContain("--new-bundle-format=false");
      // No signing flow here may ever reference a public transparency/CA service.
      expect(JSON.stringify(flags)).not.toMatch(/fulcio|rekor|sigstore\.dev/i);
    }
  });
});

describe("signBlobFlags — PINNED path is a static known-good constant (no --help probe)", () => {
  it("returns exactly [tlog-upload=false, new-bundle-format=false, use-signing-config=false]", async () => {
    const signBlobFlags = await freshSignBlobFlags();
    // A pinned resolution whose bin does not even exist: if this probed `--help` it would fail,
    // proving the pinned branch never shells out.
    const flags = signBlobFlags({ bin: "/nonexistent/pinned/cosign", pinned: true, source: "override" });
    expect(flags).toEqual([
      "--tlog-upload=false",
      "--new-bundle-format=false",
      "--use-signing-config=false"
    ]);
  });
});

describe("signBlobFlags — UNPINNED path probes cosign sign-blob --help (BYO cosign)", () => {
  it("ADDS --use-signing-config=false when the operator cosign advertises the flag (newer build)", async () => {
    const signBlobFlags = await freshSignBlobFlags();
    const flags = signBlobFlags({ bin: newerShim, pinned: false, source: "path" });
    expect(flags).toEqual([
      "--tlog-upload=false",
      "--new-bundle-format=false",
      "--use-signing-config=false"
    ]);
  });

  it("OMITS --use-signing-config=false when the operator cosign lacks the flag (older 2.x build)", async () => {
    const signBlobFlags = await freshSignBlobFlags();
    const flags = signBlobFlags({ bin: olderShim, pinned: false, source: "path" });
    expect(flags).toEqual(["--tlog-upload=false", "--new-bundle-format=false"]);
    expect(flags).not.toContain("--use-signing-config=false");
  });
});

describe("resolveCosign — the E1 pin-vs-probe branch", () => {
  async function freshResolveCosign() {
    vi.resetModules();
    return (await import("./cosign-bin.js")).resolveCosign;
  }

  it("SCP_COSIGN_BIN override => pinned (override wins over everything)", async () => {
    process.env[COSIGN_BIN_ENV] = "/some/pinned/cosign";
    const resolveCosign = await freshResolveCosign();
    expect(resolveCosign()).toEqual({ bin: "/some/pinned/cosign", pinned: true, source: "override" });
  });

  it("a cosign found on PATH (our fake shim) resolves as UNPINNED, source=path", async () => {
    delete process.env[COSIGN_BIN_ENV];
    // Only the shim dir on PATH so `which cosign` finds our fake and nothing labels it pinned.
    process.env.PATH = `${shimDir}:${savedEnv.PATH ?? ""}`;
    const resolveCosign = await freshResolveCosign();
    const resolved = resolveCosign();
    // The vendored path never exists on a dev/CI host, so PATH resolution is what we get here.
    expect(resolved.bin === VENDORED_COSIGN_PATH ? "vendored" : resolved.source).toBe("path");
    expect(resolved.pinned).toBe(false);
    expect(resolved.bin).toBe("cosign");
  });

  it("no override, no vendored binary, nothing on PATH => source=missing (still unpinned)", async () => {
    delete process.env[COSIGN_BIN_ENV];
    // Empty PATH => even `which` itself can't be found, so which('cosign') returns false.
    process.env.PATH = "";
    const resolveCosign = await freshResolveCosign();
    const resolved = resolveCosign();
    // Guard against a host that vendored cosign at the in-image path (it won't in CI/dev).
    if (resolved.source !== "vendored") {
      expect(resolved).toEqual({ bin: "cosign", pinned: false, source: "missing" });
    }
  });
});
