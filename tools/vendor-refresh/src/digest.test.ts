import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkopeoUnavailableError, createSkopeoDigestResolver } from "./digest.js";

const SHA = "a".repeat(64);

// `deploy/airgap/src/ci-offline-mirror.test.ts` refuses ANY source file that spells
// `docker://<external-host>/…` literally — skopeo dials a registry directly and is never served by a
// local Docker re-tag, so a literal external host in a `docker://` string is exactly the pattern that
// took CI live before that census existed. This test's `runFn` is a full mock (nothing here ever
// really shells out), but the census cannot tell a mocked assertion from a real dial by reading
// source text, and it should not have to — so the fixture ref is spelled under the mirror's own
// namespace instead of a real upstream registry.
const FIXTURE_REF = "ghcr.io/commanderscp/mirror/argocd:v3.5.0";

// `resolveSkopeo()` (from `@scp/cosign`) is real — it is the FAIL-CLOSED resolution this module
// deliberately does not bypass. Every test that wants the injected `runFn` to actually be reached
// points `SCP_SKOPEO_BIN` at a fake path (resolveSkopeo() trusts an explicit override without
// checking it exists — the same contract `@scp/cosign`'s own tests rely on), so ONLY the
// "no skopeo anywhere" test below runs with it genuinely unset.
let originalSkopeoBin: string | undefined;
beforeEach(() => {
  originalSkopeoBin = process.env.SCP_SKOPEO_BIN;
  process.env.SCP_SKOPEO_BIN = "/fake/skopeo-for-tests";
});
afterEach(() => {
  if (originalSkopeoBin === undefined) delete process.env.SCP_SKOPEO_BIN;
  else process.env.SCP_SKOPEO_BIN = originalSkopeoBin;
});

describe("createSkopeoDigestResolver", () => {
  it("returns the digest skopeo inspect reports", async () => {
    const runFn = vi
      .fn()
      .mockReturnValue({ stdout: JSON.stringify({ Digest: `sha256:${SHA}` }), stderr: "" });
    const resolve = createSkopeoDigestResolver(runFn);
    await expect(resolve(FIXTURE_REF)).resolves.toBe(`sha256:${SHA}`);
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["inspect", `docker://${FIXTURE_REF}`])
    );
  });

  it("throws when skopeo inspect does not return JSON", async () => {
    const runFn = vi.fn().mockReturnValue({ stdout: "not json", stderr: "" });
    const resolve = createSkopeoDigestResolver(runFn);
    await expect(resolve(FIXTURE_REF)).rejects.toThrow(/did not return JSON/);
  });

  it("throws when the reported digest is not a well-formed sha256", async () => {
    const runFn = vi
      .fn()
      .mockReturnValue({ stdout: JSON.stringify({ Digest: "not-a-digest" }), stderr: "" });
    const resolve = createSkopeoDigestResolver(runFn);
    await expect(resolve(FIXTURE_REF)).rejects.toThrow(/no well-formed sha256 digest/);
  });

  it("throws when skopeo itself fails (non-zero exit)", async () => {
    const runFn = vi.fn().mockImplementation(() => {
      throw new Error("exit 1: manifest unknown");
    });
    const resolve = createSkopeoDigestResolver(runFn);
    await expect(resolve(FIXTURE_REF)).rejects.toThrow(/manifest unknown/);
  });

  it("fails closed (SkopeoUnavailableError) when no skopeo can be resolved at all", async () => {
    delete process.env.SCP_SKOPEO_BIN; // override the beforeEach fixture for this one test
    const originalPath = process.env.PATH;
    // Neutralise PATH so `which skopeo` cannot find a real one on this machine or CI runner, and the
    // vendored path (/opt/scp/bin/skopeo) does not exist outside the built runtime image anyway.
    process.env.PATH = "";
    try {
      const runFn = vi.fn();
      const resolve = createSkopeoDigestResolver(runFn);
      await expect(resolve(FIXTURE_REF)).rejects.toBeInstanceOf(SkopeoUnavailableError);
      expect(runFn).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
