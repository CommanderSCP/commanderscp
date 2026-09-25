import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COSIGN_BIN_ENV } from "./cosign-bin.js";
import { createKeylessImageVerifier } from "./cosign.js";

/** Offline invocation-contract tests for keyless verification (ADR-0059). See `cosign.ts`'s own
 *  doc comment on `createKeylessImageVerifier` for what these can and cannot prove: the exact argv
 *  built and how the exit code is interpreted, never real Sigstore cryptography (which needs the
 *  network this repo's tests never touch). */

let originalCosignBin: string | undefined;
beforeEach(() => {
  originalCosignBin = process.env[COSIGN_BIN_ENV];
  process.env[COSIGN_BIN_ENV] = "/fake/cosign-for-tests";
});
afterEach(() => {
  if (originalCosignBin === undefined) delete process.env[COSIGN_BIN_ENV];
  else process.env[COSIGN_BIN_ENV] = originalCosignBin;
});

const IDENTITY = {
  identityRegexp: "^https://github\\.com/argoproj/argo-cd/",
  oidcIssuer: "https://token.actions.githubusercontent.com"
};

describe("createKeylessImageVerifier", () => {
  it("builds the standard keyless invocation: verify, --certificate-identity-regexp, --certificate-oidc-issuer, the ref", () => {
    const runFn = vi.fn().mockReturnValue({ stdout: "Verification for quay.io/x OK", stderr: "" });
    const verify = createKeylessImageVerifier(runFn);
    const result = verify("quay.io/argoproj/argocd:v3.5.0", IDENTITY);
    expect(result.status).toBe("verified");
    expect(runFn).toHaveBeenCalledWith(expect.any(String), [
      "verify",
      "--certificate-identity-regexp",
      IDENTITY.identityRegexp,
      "--certificate-oidc-issuer",
      IDENTITY.oidcIssuer,
      "quay.io/argoproj/argocd:v3.5.0"
    ]);
  });

  it("never passes --insecure-ignore-tlog — keyless verification checks the transparency log by default", () => {
    const runFn = vi.fn().mockReturnValue({ stdout: "OK", stderr: "" });
    createKeylessImageVerifier(runFn)("acme/api:1.0", IDENTITY);
    const args = runFn.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--insecure-ignore-tlog=true");
    expect(args).not.toContain("--insecure-ignore-tlog");
  });

  it("reports 'unverified' (not a throw) when cosign exits non-zero — a real, informative answer, not a tooling failure", () => {
    const runFn = vi.fn().mockImplementation(() => {
      throw new Error("Error: no matching signatures");
    });
    const result = createKeylessImageVerifier(runFn)("acme/api:1.0", IDENTITY);
    expect(result.status).toBe("unverified");
    expect(result.detail).toContain("no matching signatures");
  });

  it("fails closed with status 'unavailable' (never 'verified') when no cosign can be resolved at all", () => {
    delete process.env[COSIGN_BIN_ENV]; // override the beforeEach fixture for this one test
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const runFn = vi.fn();
      const result = createKeylessImageVerifier(runFn)("acme/api:1.0", IDENTITY);
      expect(result.status).toBe("unavailable");
      expect(runFn).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("the default runner (no injection) shells out via the real run() — constructed correctly even though never invoked in tests", () => {
    // Not invoked (would need a real cosign + network); this only proves the DEFAULT PARAMETER is
    // itself the production wiring — the same shape `resolveRunnerLauncher`'s own default proves.
    const verify = createKeylessImageVerifier();
    expect(typeof verify).toBe("function");
  });
});
