/**
 * `read-file.ts` unit tests — the provider-neutral half of `readFileAtRef` (M21.2, ADR-0032 §4).
 * Pure functions only: no HTTP, no nock, no provider. Each adapter's wire shapes are proven in that
 * package's own nock suite; what is proven HERE is the behavior all three share, so a refusal is
 * tested once instead of three times.
 *
 * Every assertion below is mutation-proven: the bound checks fail if either size gate is removed,
 * the UTF-8 round-trip test fails if the round-trip check is dropped OR if the decode is changed to
 * latin1, and the whitespace-stripping test fails if `base64DecodedByteLength` stops stripping.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FILE_BYTES,
  HARD_MAX_FILE_BYTES,
  assertNoRedirect,
  assertSafeRepoPath,
  base64DecodedByteLength,
  decodeBoundedBase64,
  encodePathSegments,
  isGitProviderReadError,
  resolveMaxBytes,
  wrapProviderRequestError,
  type DecodeBoundedBase64Input
} from "./read-file.js";

/** Base input every decode test starts from; each test overrides only the field under test. */
function decodeInput(overrides: Partial<DecodeBoundedBase64Input> = {}): DecodeBoundedBase64Input {
  return {
    provider: "testprovider",
    path: "package.json",
    requestedRef: "main",
    commitSha: "c".repeat(40),
    base64: Buffer.from("{}", "utf8").toString("base64"),
    encoding: "base64",
    maxBytes: DEFAULT_MAX_FILE_BYTES,
    ...overrides
  };
}

// -------------------------------------------------------------------------------------------
// resolveMaxBytes — the bound is structural, not advisory
// -------------------------------------------------------------------------------------------

describe("resolveMaxBytes", () => {
  it("defaults to DEFAULT_MAX_FILE_BYTES when nothing was requested", () => {
    expect(resolveMaxBytes(undefined)).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("honors a smaller caller-supplied bound", () => {
    expect(resolveMaxBytes(4096)).toBe(4096);
  });

  it("CLAMPS a caller who asks for more than the hard ceiling — the bound is not the caller's to raise", () => {
    expect(resolveMaxBytes(2 ** 31)).toBe(HARD_MAX_FILE_BYTES);
    expect(resolveMaxBytes(HARD_MAX_FILE_BYTES + 1)).toBe(HARD_MAX_FILE_BYTES);
  });

  it("treats a zero/negative/NaN request as 'not a bound the caller meant' and uses the default", () => {
    // The alternative — honoring 0 — would make an accidental `maxBytes: 0` silently refuse every
    // manifest and produce an empty inventory that looks like "this org declares no dependencies".
    expect(resolveMaxBytes(0)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(resolveMaxBytes(-1)).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(resolveMaxBytes(Number.NaN)).toBe(DEFAULT_MAX_FILE_BYTES);
  });
});

// -------------------------------------------------------------------------------------------
// base64DecodedByteLength — the pre-decode measurement the size refusal rests on
// -------------------------------------------------------------------------------------------

describe("base64DecodedByteLength", () => {
  it("matches the real decoded length for payloads at each padding length (0, 1, 2 '=')", () => {
    for (const text of ["abc", "abcd", "abcde", "", "a"]) {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      expect(base64DecodedByteLength(b64), `for ${JSON.stringify(text)}`).toBe(
        Buffer.byteLength(text, "utf8")
      );
    }
  });

  it("STRIPS embedded whitespace before measuring — GitHub wraps its base64 at 60 chars with '\\n'", () => {
    const text = "x".repeat(300);
    const flat = Buffer.from(text, "utf8").toString("base64");
    const wrapped = (flat.match(/.{1,60}/g) ?? []).join("\n");

    expect(wrapped).toContain("\n"); // the fixture really is wrapped (guards the guard)
    expect(base64DecodedByteLength(wrapped)).toBe(300);
    // Mutation control: without the strip, the newlines inflate the count.
    expect(base64DecodedByteLength(wrapped)).not.toBe(Math.floor((wrapped.length * 3) / 4));
  });
});

// -------------------------------------------------------------------------------------------
// decodeBoundedBase64 — the four gates
// -------------------------------------------------------------------------------------------

describe("decodeBoundedBase64", () => {
  it("decodes a normal base64 payload and reports the resolved commit sha and decoded byte length", () => {
    const result = decodeBoundedBase64(
      decodeInput({ base64: Buffer.from('{"name":"a"}', "utf8").toString("base64"), blobSha: "b1" })
    );
    expect(result).toEqual({
      outcome: "found",
      path: "package.json",
      requestedRef: "main",
      commitSha: "c".repeat(40),
      content: '{"name":"a"}',
      sizeBytes: 12,
      blobSha: "b1"
    });
  });

  it("round-trips MULTI-BYTE UTF-8 exactly — sizeBytes counts BYTES, content.length counts UTF-16 units", () => {
    // A manifest with non-ASCII in it is ordinary (an author field, a description). If the decode
    // were latin1, or if sizeBytes were content.length, both assertions below would fail.
    const text = '{"author":"Ada Lovelace — 日本語 🎉","v":"1.0.0"}';
    const result = decodeBoundedBase64(
      decodeInput({ base64: Buffer.from(text, "utf8").toString("base64") })
    );
    expect(result.outcome).toBe("found");
    if (result.outcome !== "found") throw new Error("unreachable");
    expect(result.content).toBe(text);
    expect(result.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(result.sizeBytes).toBeGreaterThan(result.content.length);
  });

  it("refuses on the PROVIDER-DECLARED size, before the payload is decoded", () => {
    const result = decodeBoundedBase64(
      decodeInput({ declaredSizeBytes: 5_000_000, maxBytes: 1024 })
    );
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "too_large",
      sizeBytes: 5_000_000
    });
    expect((result as { detail: string }).detail).toContain("provider-declared size");
  });

  it("refuses on the COMPUTED size even when the provider DECLARES a small one — gate 3 does not trust gate 2", () => {
    // The provider asserts 10 bytes and sends 4 KiB. A single gate keyed on `size` would decode it.
    const big = "y".repeat(4096);
    const result = decodeBoundedBase64(
      decodeInput({
        base64: Buffer.from(big, "utf8").toString("base64"),
        declaredSizeBytes: 10,
        maxBytes: 1024
      })
    );
    expect(result).toMatchObject({ outcome: "refused", reason: "too_large", sizeBytes: 4096 });
    expect((result as { detail: string }).detail).toContain("computed from the payload");
  });

  it("accepts a payload EXACTLY at the bound and refuses one byte more (the boundary is inclusive)", () => {
    const at = decodeBoundedBase64(
      decodeInput({ base64: Buffer.from("z".repeat(64), "utf8").toString("base64"), maxBytes: 64 })
    );
    const over = decodeBoundedBase64(
      decodeInput({ base64: Buffer.from("z".repeat(65), "utf8").toString("base64"), maxBytes: 64 })
    );
    expect(at.outcome).toBe("found");
    expect(over).toMatchObject({ outcome: "refused", reason: "too_large" });
  });

  it('maps GitHub\'s `encoding: "none"` to a too_large refusal — that is what GitHub means by it', () => {
    const result = decodeBoundedBase64(
      decodeInput({ encoding: "none", base64: "", declaredSizeBytes: 8_000_000 })
    );
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "too_large",
      sizeBytes: 8_000_000
    });
    // NEGATIVE CONTROL: it must NOT come back as a successfully-read empty file, which is what an
    // implementation that only looked at `content` would produce for this exact response.
    expect(result.outcome).not.toBe("found");
  });

  it("refuses an encoding it does not implement, rather than decoding it as base64 anyway", () => {
    const result = decodeBoundedBase64(decodeInput({ encoding: "gzip+base64" }));
    expect(result).toMatchObject({ outcome: "refused", reason: "unsupported_encoding" });
  });

  it("refuses a payload containing a NUL byte as binary (git's own heuristic)", () => {
    const binary = Buffer.from([0x7b, 0x00, 0x7d]);
    const result = decodeBoundedBase64(decodeInput({ base64: binary.toString("base64") }));
    expect(result).toMatchObject({ outcome: "refused", reason: "not_text", sizeBytes: 3 });
    expect((result as { detail: string }).detail).toContain("offset 1");
  });

  it("refuses NUL-free bytes that are not valid UTF-8 — the round trip is what catches them", () => {
    // 0xC3 0x28 is an invalid two-byte sequence with no NUL anywhere, so ONLY the round-trip gate
    // sees it. Without that gate `toString("utf8")` silently yields "�(" and a parser would be
    // handed plausible-looking mojibake.
    const invalid = Buffer.from([0xc3, 0x28, 0x41]);
    expect(invalid.indexOf(0)).toBe(-1); // the NUL gate genuinely cannot catch this fixture
    const result = decodeBoundedBase64(decodeInput({ base64: invalid.toString("base64") }));
    expect(result).toMatchObject({ outcome: "refused", reason: "not_text" });
    expect((result as { detail: string }).detail).toContain("not valid UTF-8");
  });

  it("does NOT refuse a file merely because it is empty (a zero-byte manifest is a real file)", () => {
    const result = decodeBoundedBase64(decodeInput({ base64: "", declaredSizeBytes: 0 }));
    expect(result).toMatchObject({ outcome: "found", content: "", sizeBytes: 0 });
  });
});

// -------------------------------------------------------------------------------------------
// Path / ref URL safety
// -------------------------------------------------------------------------------------------

describe("assertSafeRepoPath", () => {
  it("accepts an ordinary nested repo-relative path", () => {
    expect(() => assertSafeRepoPath("p", "services/api/package.json")).not.toThrow();
  });

  it("refuses a '..' segment — it would re-target the REST ROUTE, not just the file", () => {
    expect(() => assertSafeRepoPath("p", "../../user")).toThrow(/'\.'\/'\.\.' segment/);
    expect(() => assertSafeRepoPath("p", "a/../../b")).toThrow(/'\.'\/'\.\.' segment/);
  });

  it("refuses a bare '.' segment, a leading slash, an empty segment, a backslash and an empty path", () => {
    expect(() => assertSafeRepoPath("p", "a/./b")).toThrow();
    expect(() => assertSafeRepoPath("p", "/etc/passwd")).toThrow(/repo-relative/);
    expect(() => assertSafeRepoPath("p", "a//b")).toThrow(/empty segment/);
    expect(() => assertSafeRepoPath("p", "a\\b")).toThrow(/backslash/);
    expect(() => assertSafeRepoPath("p", "")).toThrow(/empty/);
  });

  it("names the provider in the message, so an operator knows which binding refused", () => {
    expect(() => assertSafeRepoPath("gitea", "../x")).toThrow(/^gitea readFileAtRef:/);
  });
});

describe("encodePathSegments", () => {
  it("keeps '/' as a literal separator and encodes only within segments", () => {
    expect(encodePathSegments("services/my api/go.mod")).toBe("services/my%20api/go.mod");
    expect(encodePathSegments("release/1.x")).toBe("release/1.x");
  });

  it("escapes characters that would otherwise change the request (?, #, %)", () => {
    expect(encodePathSegments("a?b#c%d")).toBe("a%3Fb%23c%25d");
  });
});

// -------------------------------------------------------------------------------------------
// Failure classification — redirects and transport/egress
// -------------------------------------------------------------------------------------------

describe("assertNoRedirect", () => {
  it("passes 2xx and 4xx/5xx straight through (they are the adapter's own business)", () => {
    for (const status of [200, 204, 404, 422, 500]) {
      expect(() => assertNoRedirect("p", "https://h/x", status)).not.toThrow();
    }
  });

  it("throws a LEGIBLE error for each 3xx, naming the redirect and the disabled-follow policy", () => {
    for (const status of [301, 302, 307, 308]) {
      expect(() => assertNoRedirect("p", "https://h/x", status, "https://h/x/")).toThrow(
        new RegExp(`HTTP ${status}.*Location: https://h/x/.*redirects are refused`, "s")
      );
    }
  });

  it("marks the error so a transport wrapper does not bury the redirect explanation", () => {
    let caught: unknown;
    try {
      assertNoRedirect("p", "https://h/x", 302);
    } catch (err) {
      caught = err;
    }
    expect(isGitProviderReadError(caught)).toBe(true);
    // Round-tripping it through the wrapper must return the SAME error, not a generic transport one.
    expect(wrapProviderRequestError("p", "https://h/x", caught)).toBe(caught);
  });
});

describe("wrapProviderRequestError", () => {
  it("re-states an egress-guard denial with the self-hosted case named, and preserves the cause", () => {
    // The exact marker the guard sets (apps/server/src/plugin-host/egress-guard.ts:83).
    const blocked = Object.assign(
      new Error("egress guard: host 'gitea.internal' resolves to private 10.0.0.5"),
      { egressBlocked: true as const }
    );
    const wrapped = wrapProviderRequestError("gitea", "https://gitea.internal/api/v1/x", blocked);

    expect(wrapped.message).toMatch(/refused by the plugin egress guard/);
    expect(wrapped.message).toMatch(/self-hosted gitea/);
    expect(wrapped.message).toMatch(/10\.0\.0\.5/); // the guard's own detail survives
    expect(wrapped.cause).toBe(blocked);
    expect(wrapped.provider).toBe("gitea");

    // NEGATIVE CONTROL: it must NOT be classified as a plain transport failure, which is what an
    // implementation missing the `egressBlocked` branch would produce for this exact error.
    expect(wrapped.message).not.toMatch(/failed at the transport/);
  });

  it("classifies anything else as transport AND names the refused-redirect possibility", () => {
    // This is what a 3xx looks like under the PRODUCTION client: undici rejects (redirect:"error")
    // rather than returning the status, so the message has to raise redirects itself or the cause
    // is invisible to whoever reads the log.
    const wrapped = wrapProviderRequestError(
      "github",
      "https://api.github.com/x",
      new TypeError("fetch failed")
    );
    expect(wrapped.message).toMatch(/failed at the transport \(fetch failed\)/);
    expect(wrapped.message).toMatch(/redirects are refused rather than followed/);
    expect(isGitProviderReadError(wrapped)).toBe(true);
  });

  it("handles a non-Error throw without losing it", () => {
    expect(wrapProviderRequestError("p", "https://h/x", "boom").message).toContain("boom");
  });
});
