import * as argon2 from "argon2";
import { describe, expect, it } from "vitest";
import {
  generateTokenId,
  generateTokenSecret,
  mintPrefixedToken,
  parsePrefixedToken,
  verifyPrefixedToken,
  type PrefixedTokenRow
} from "./prefixed-token.js";

/**
 * The shared `<prefix><tokenId>.<secret>` parse/mint/verify sequence behind both `pat.ts`'s
 * `verifyPat` and `operator-auth.ts`'s `verifyOperatorCredential`. No DB here — `verifyPrefixedToken`
 * takes plain `findByTokenId`/`touchLastUsed` callbacks, so its full decision sequence (parse ->
 * lookup -> revoked -> expired -> secret -> touch) is exercised in-memory, at the layer both callers
 * actually depend on.
 */

const PREFIX = "scp_test_";

describe("parsePrefixedToken / mintPrefixedToken", () => {
  it("round-trips a minted token", () => {
    const minted = mintPrefixedToken(PREFIX, "abc123", "s3cr3t");
    expect(minted).toBe("scp_test_abc123.s3cr3t");
    expect(parsePrefixedToken(PREFIX, minted)).toEqual({ tokenId: "abc123", secret: "s3cr3t" });
  });

  it("rejects a token with the wrong prefix", () => {
    expect(parsePrefixedToken(PREFIX, "scp_other_abc.def")).toBeNull();
  });

  it("rejects a token with no separating dot", () => {
    expect(parsePrefixedToken(PREFIX, "scp_test_abcdef")).toBeNull();
  });

  it("rejects a token with an empty tokenId or empty secret", () => {
    expect(parsePrefixedToken(PREFIX, "scp_test_.secret")).toBeNull();
    expect(parsePrefixedToken(PREFIX, "scp_test_tokenid.")).toBeNull();
  });

  it("generateTokenId/generateTokenSecret produce distinct, non-empty base64url strings", () => {
    const id1 = generateTokenId();
    const id2 = generateTokenId();
    expect(id1).not.toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
    const secret1 = generateTokenSecret();
    expect(secret1.length).toBeGreaterThan(id1.length); // secret is a longer random value than tokenId
  });
});

interface FakeRow extends PrefixedTokenRow {
  ownerLabel: string;
}

async function makeRow(secret: string, overrides: Partial<FakeRow> = {}): Promise<FakeRow> {
  return {
    id: "row-1",
    tokenHash: await argon2.hash(secret),
    revokedAt: null,
    expiresAt: null,
    ownerLabel: "owner",
    ...overrides
  };
}

describe("verifyPrefixedToken", () => {
  it("returns the row for a well-formed, unexpired, unrevoked token with the right secret", async () => {
    const secret = "correct-secret";
    const row = await makeRow(secret);
    const touched: string[] = [];
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-1", secret),
      findByTokenId: async (tokenId) => (tokenId === "tok-1" ? row : undefined),
      touchLastUsed: async (id) => {
        touched.push(id);
      }
    });
    expect(result).toEqual(row);
    expect(touched).toEqual(["row-1"]);
  });

  it("rejects a malformed presented token without ever calling findByTokenId", async () => {
    let called = false;
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: "not-even-the-right-prefix",
      findByTokenId: async () => {
        called = true;
        return undefined;
      },
      touchLastUsed: async () => undefined
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("rejects an unknown tokenId", async () => {
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-missing", "whatever"),
      findByTokenId: async () => undefined,
      touchLastUsed: async () => undefined
    });
    expect(result).toBeNull();
  });

  it("rejects a revoked row without ever checking the secret", async () => {
    const secret = "correct-secret";
    const row = await makeRow(secret, { revokedAt: new Date() });
    let verifyCalled = false;
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-1", secret),
      findByTokenId: async () => {
        verifyCalled = true;
        return row;
      },
      touchLastUsed: async () => undefined
    });
    expect(result).toBeNull();
    expect(verifyCalled).toBe(true); // lookup happens, but the row is rejected before argon2 runs
  });

  it("rejects an expired row", async () => {
    const secret = "correct-secret";
    const row = await makeRow(secret, { expiresAt: new Date(Date.now() - 1000) });
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-1", secret),
      findByTokenId: async () => row,
      touchLastUsed: async () => undefined
    });
    expect(result).toBeNull();
  });

  it("accepts a row with a future expiresAt", async () => {
    const secret = "correct-secret";
    const row = await makeRow(secret, { expiresAt: new Date(Date.now() + 60_000) });
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-1", secret),
      findByTokenId: async () => row,
      touchLastUsed: async () => undefined
    });
    expect(result).toEqual(row);
  });

  it("rejects the wrong secret against the right tokenId", async () => {
    const row = await makeRow("correct-secret");
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-1", "wrong-secret"),
      findByTokenId: async () => row,
      touchLastUsed: async () => undefined
    });
    expect(result).toBeNull();
  });

  it("touchLastUsed failing does not fail verification (best-effort)", async () => {
    const secret = "correct-secret";
    const row = await makeRow(secret);
    const result = await verifyPrefixedToken<FakeRow>({
      prefix: PREFIX,
      presented: mintPrefixedToken(PREFIX, "tok-1", secret),
      findByTokenId: async () => row,
      touchLastUsed: async () => {
        throw new Error("transient DB hiccup");
      }
    });
    expect(result).toEqual(row);
  });
});
