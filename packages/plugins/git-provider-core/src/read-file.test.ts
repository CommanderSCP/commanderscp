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
  assertSafeRef,
  assertSafeRepo,
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

    expect(wrapped).toContain("\n");
    expect(base64DecodedByteLength(wrapped)).toBe(300);
    // Mutation control: without the strip, the newlines inflate the count.
    expect(base64DecodedByteLength(wrapped)).not.toBe(Math.floor((wrapped.length * 3) / 4));
  });
});

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

  describe("gate 3b — a body SHORTER than the provider declares is not the file", () => {
    /**
     * THE ONLY EVIDENCE OF TRUNCATION THERE IS. Every one of ADR-0032's six manifest formats is
     * line-oriented or brace-balanced, and the first N bytes of a `requirements.txt` are still a
     * valid `requirements.txt` — so no parser and no consumer can see this from the content. Its
     * one consumer PRUNES a manifest's declarations down to what it just parsed, so a body missing
     * its second half deletes the declarations that never arrived.
     *
     * Gates 2 and 3 each compare ONE size against the decode bound; this is the only place the two
     * sizes are compared with each other.
     */
    it("refuses a payload that decodes to fewer bytes than the declared size", () => {
      const arrived = "requests==2.31.0\n";
      const result = decodeBoundedBase64(
        decodeInput({
          base64: Buffer.from(arrived, "utf8").toString("base64"),
          // The provider says the file is far bigger than what arrived — a cut response.
          declaredSizeBytes: 4096
        })
      );
      expect(result).toMatchObject({
        outcome: "refused",
        reason: "incomplete_body",
        sizeBytes: Buffer.byteLength(arrived, "utf8")
      });
      if (result.outcome !== "refused") throw new Error("unreachable");
      expect(result.detail).toContain("4096");
    });

    it("PASSES a payload whose length matches — the ordinary read is not made to fail", () => {
      // The negative control without which the assertion above proves only that something refuses.
      const body = "requests==2.31.0\nurllib3==2.2.1\n";
      const result = decodeBoundedBase64(
        decodeInput({
          base64: Buffer.from(body, "utf8").toString("base64"),
          declaredSizeBytes: Buffer.byteLength(body, "utf8")
        })
      );
      expect(result.outcome).toBe("found");
    });

    it("does NOT refuse a payload LONGER than declared — the direction that deletes is the short one", () => {
      // `size` is provider metadata. A provider that under-reports it (a stale index entry, a size
      // computed before a filter) would otherwise make every manifest in that repo unreadable —
      // failing closed over a discrepancy that cannot truncate anything.
      const body = "requests==2.31.0\nurllib3==2.2.1\n";
      const result = decodeBoundedBase64(
        decodeInput({
          base64: Buffer.from(body, "utf8").toString("base64"),
          declaredSizeBytes: 4
        })
      );
      expect(result.outcome).toBe("found");
    });

    it("says nothing about completeness when the provider declares no size", () => {
      const result = decodeBoundedBase64(
        decodeInput({ base64: Buffer.from("x", "utf8").toString("base64") })
      );
      expect(result.outcome).toBe("found");
    });
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

// `ref` is the one that percent-encoding LOOKS like it already covered and does not: the proof
// asserted here is that `encodeURIComponent("..") === ".."`, so `encodePathSegments` leaves a
// traversal ref byte-identical and only a refusal closes it.
describe("assertSafeRef", () => {
  it("accepts every ref shape a provider is legitimately asked for", () => {
    for (const ref of [
      "main",
      "feature/x",
      "release/1.x",
      "refs/heads/main",
      "refs/tags/v1.2.3",
      "v1.2.3",
      "9f".repeat(20),
      "user@example.com-branch"
    ]) {
      expect(() => assertSafeRef("p", ref), ref).not.toThrow();
    }
  });

  it("refuses a '..' traversal — the ONE case percent-encoding silently passes through", () => {
    // The premise, asserted rather than assumed: encoding is not the control here.
    expect(encodePathSegments("../../../../user")).toBe("../../../../user");
    expect(() => assertSafeRef("p", "../../../../user")).toThrow(/contains '\.\.'/);
    expect(() => assertSafeRef("p", "main/../../../user")).toThrow(/contains '\.\.'/);
  });

  it("refuses each character git forbids in a ref name", () => {
    for (const ref of ["a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      expect(() => assertSafeRef("p", ref), ref).toThrow(/git forbids in a ref name/);
    }
    expect(() => assertSafeRef("p", `a${String.fromCharCode(0)}b`)).toThrow(
      /git forbids in a ref name/
    );
    expect(() => assertSafeRef("p", `a${String.fromCharCode(127)}b`)).toThrow(
      /git forbids in a ref name/
    );
  });

  it("refuses the remaining check-ref-format shapes: empty, leading/trailing '/', '//', '@{', bare '@', trailing '.', a '.'-leading or '.lock' segment", () => {
    expect(() => assertSafeRef("p", "")).toThrow(/is empty/);
    expect(() => assertSafeRef("p", "/main")).toThrow(/begins or ends with '\/'/);
    expect(() => assertSafeRef("p", "main/")).toThrow(/begins or ends with '\/'/);
    expect(() => assertSafeRef("p", "a//b")).toThrow(/empty segment/);
    expect(() => assertSafeRef("p", "main@{1}")).toThrow(/'@\{'/);
    expect(() => assertSafeRef("p", "@")).toThrow(/single character '@'/);
    expect(() => assertSafeRef("p", "main.")).toThrow(/ends with '\.'/);
    expect(() => assertSafeRef("p", "refs/heads/.hidden")).toThrow(/beginning with '\.'/);
    expect(() => assertSafeRef("p", "refs/heads/main.lock")).toThrow(/'\.lock'/);
  });

  it("names the provider and quotes the ref, so an operator sees which binding refused what", () => {
    expect(() => assertSafeRef("github", "../../user")).toThrow(
      /^github readFileAtRef: ref '\.\.\/\.\.\/user'/
    );
  });
});

describe("assertSafeRepo", () => {
  it("accepts the shapes each provider actually addresses", () => {
    expect(() => assertSafeRepo("github", "acme/widgets", 2)).not.toThrow();
    expect(() => assertSafeRepo("gitea", "acme-org/my_repo.git-ish", 2)).not.toThrow();
    expect(() => assertSafeRepo("gitlab", "group/subgroup/repo")).not.toThrow();
  });

  it("refuses a '..' segment — the route re-targeting proven against all three adapters", () => {
    expect(() => assertSafeRepo("github", "acme/widgets/../../..", 2)).toThrow();
    expect(() => assertSafeRepo("gitlab", "acme/widgets/../..")).toThrow(/'\.'\/'\.\.' segment/);
    expect(() => assertSafeRepo("gitlab", "acme/./widgets")).toThrow(/'\.'\/'\.\.' segment/);
  });

  it("refuses a '?' — it TERMINATES the route, folding the rest of it into a query string", () => {
    expect(() => assertSafeRepo("gitlab", "acme/widgets?x=")).toThrow(/outside \[A-Za-z0-9\._-\]/);
  });

  it("refuses everything else outside the providers' own [A-Za-z0-9._-] segment charset", () => {
    for (const repo of ["acme/wid gets", "acme/wid#gets", "acme/wid%2Fgets", "acme/wid\\gets"]) {
      expect(() => assertSafeRepo("p", repo), repo).toThrow(/outside \[A-Za-z0-9\._-\]/);
    }
    expect(() => assertSafeRepo("p", "")).toThrow(/is empty/);
    expect(() => assertSafeRepo("p", "/acme/widgets")).toThrow(/begins or ends with '\/'/);
    expect(() => assertSafeRepo("p", "acme/widgets/")).toThrow(/begins or ends with '\/'/);
  });

  it("enforces the segment COUNT only where the provider has a fixed one", () => {
    expect(() => assertSafeRepo("github", "acme/group/widgets", 2)).toThrow(
      /exactly 2 '\/'-separated segments/
    );
    expect(() => assertSafeRepo("github", "widgets", 2)).toThrow(
      /exactly 2 '\/'-separated segments/
    );
    // Same string, no count asserted — this is the gitlab call and it must NOT throw.
    expect(() => assertSafeRepo("gitlab", "acme/group/widgets")).not.toThrow();
  });

  it("every character it ACCEPTS is URL-identity — the property the adapters splice `repo` raw on", () => {
    // This is the load-bearing half of the M21.2 repo fix, and it lives here rather than in the
    // adapters because it is a property of THIS charset. github's and gitea's `readFileAtRef` put
    // the validated `repo` into their routes unencoded (see the comment at each `const repoPath =
    // repo`), which is only safe while `REPO_SEGMENT` admits nothing that a URL would treat
    // structurally or that would need an escape. They previously wrapped it in
    // `encodePathSegments`, but that call was a provable identity under this same charset — a
    // no-op indistinguishable from its own deletion, so no test could hold it (CLAUDE.md: a
    // well-written comment naming a hazard is a signal to sweep, not evidence it was handled).
    // Relaxing the charset — a space, `~`, `%`, `/`, or "any non-slash character" — fails HERE
    // instead of silently re-opening the injection two packages away.
    //
    // The sweep is over every ASCII code point plus a sample of non-ASCII (an exhaustive Unicode
    // sweep is not runnable; these catch the realistic relaxation, e.g. to a negated class).
    const candidates = [
      ...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)),
      "é",
      "空",
      " ",
      "∕"
    ];
    const accepted: string[] = [];
    for (const character of candidates) {
      // Probed inside a real second segment: a bare character would also trip the empty/leading-
      // slash arms and hide which rule did the refusing.
      try {
        assertSafeRepo("p", `acme/wid${character}gets`, 2);
        accepted.push(character);
      } catch {
        /* refused — not this test's business which rule refused it */
      }
    }
    const acceptedNonIdentity = accepted.filter((c) => encodeURIComponent(c) !== c);
    expect(
      acceptedNonIdentity.map((c) => JSON.stringify(c)),
      "assertSafeRepo accepts characters that are NOT URL-identity — github/gitea splice the validated repo into their REST routes UNENCODED, so relaxing REPO_SEGMENT means re-introducing encoding at those call sites"
    ).toEqual([]);
    // The sweep must also be shown to have ACCEPTED something: an assert that refused every
    // candidate would satisfy the check above vacuously (this repo's second recurring bug class —
    // green for the wrong reason). Pinning the exact accepted set rather than a count also makes
    // the charset itself readable here, and makes any change to it — tightening included — arrive
    // as a deliberate edit to this line.
    expect(accepted.join("")).toBe(
      "-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
    );
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
    const blocked = Object.assign(
      new Error("egress guard: host 'gitea.internal' resolves to private 10.0.0.5"),
      { egressBlocked: true as const }
    );
    const wrapped = wrapProviderRequestError("gitea", "https://gitea.internal/api/v1/x", blocked);

    expect(wrapped.message).toMatch(/refused by the plugin egress guard/);
    expect(wrapped.message).toMatch(/self-hosted gitea/);
    expect(wrapped.message).toMatch(/10\.0\.0\.5/);
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
