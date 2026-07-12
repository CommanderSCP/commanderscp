import { describe, expect, it } from "vitest";
import { isCrlExpired, parseCrlNextUpdate } from "./crl-parse.js";
import { createTestCa, generateCrl, opensslAvailable } from "./test-support/mtls-pki.js";

/**
 * M9.3 (ADR-0001) — `crl-parse.ts` is a hand-rolled minimal DER reader (no runtime dependency
 * added, CLAUDE.md principle 5), so it gets its own direct unit coverage against REAL CRLs minted
 * by `openssl` (not hand-crafted byte arrays) — proving it reads the exact `nextUpdate` OpenSSL
 * itself reports (`openssl crl -noout -nextupdate`), for both a normal (future) and a deliberately
 * expired CRL. No Postgres needed — plain `pnpm test`, not the Testcontainers integration suite.
 */
describe.skipIf(!opensslAvailable())("crl-parse", () => {
  it("reads nextUpdate from a fresh (far-future) CRL", () => {
    const ca = createTestCa();
    const crl = generateCrl(ca, { nextUpdate: "20991231235959Z" });

    const nextUpdate = parseCrlNextUpdate(crl);

    expect(nextUpdate).not.toBeNull();
    expect(nextUpdate?.toISOString()).toBe("2099-12-31T23:59:59.000Z");
    expect(isCrlExpired(nextUpdate)).toBe(false);
  });

  it("reads nextUpdate from a deliberately EXPIRED CRL and flags it as expired", () => {
    const ca = createTestCa();
    const crl = generateCrl(ca, { nextUpdate: "20200101000000Z" });

    const nextUpdate = parseCrlNextUpdate(crl);

    expect(nextUpdate).not.toBeNull();
    expect(nextUpdate?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(isCrlExpired(nextUpdate)).toBe(true);
  });

  it("isCrlExpired treats a null nextUpdate (field omitted) as never expired", () => {
    expect(isCrlExpired(null)).toBe(false);
  });

  it("throws on a malformed/truncated CRL rather than silently reporting 'no expiry'", () => {
    const garbage = Buffer.from([0x30, 0x7f, 0x01, 0x02]); // claims 0x7f bytes of content, has 2
    expect(() => parseCrlNextUpdate(garbage)).toThrow();
  });
});
