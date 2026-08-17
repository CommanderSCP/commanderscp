import { describe, expect, it } from "vitest";
import { atLineStart, stripHashComments } from "./hash.js";
import { stripComments } from "./ts.js";

/**
 * NEGATIVE CONTROLS FOR THE `#`-LANGUAGE READERS.
 *
 * Every consumer of these helpers is a test that asserts something is PRESENT, and the whole class
 * of bug being fixed is such a test passing when it should not. So the helpers themselves are
 * proven to BITE — each case below is a real shape taken from the files that were measured
 * false-green on 2026-08-17 (package doc), not an invented one.
 */

describe("atLineStart — a `#` prefix cannot satisfy a presence assertion", () => {
  const DOCKERFILE = [
    "# The cosign pin lives here:",
    "# ARG COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign@sha256:dead",
    "ARG SKOPEO_IMAGE=quay.io/skopeo/stable@sha256:beef",
    "  ARG INDENTED=yes",
    "RUN echo hi   # ARG TRAILING=commented"
  ].join("\n");

  it("matches a live line, with or without leading whitespace", () => {
    expect(DOCKERFILE).toMatch(atLineStart("ARG SKOPEO_IMAGE=quay.io/skopeo/stable@sha256:beef"));
    expect(DOCKERFILE).toMatch(atLineStart("ARG INDENTED=yes"));
  });

  it("REFUSES the same text once it is commented out — the whole point", () => {
    // The measured defect: `.toContain("ARG COSIGN_IMAGE=…")` passed with Dockerfile:28 commented.
    expect(DOCKERFILE).toContain("ARG COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign@sha256:dead");
    expect(DOCKERFILE).not.toMatch(
      atLineStart("ARG COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign@sha256:dead")
    );
  });

  it("REFUSES a match inside a TRAILING comment on an otherwise live line", () => {
    // Strictly stronger than a whole-line `#` filter, which would keep this line intact.
    expect(stripHashComments(DOCKERFILE)).toContain("ARG TRAILING=commented");
    expect(DOCKERFILE).not.toMatch(atLineStart("ARG TRAILING=commented"));
  });

  it("escapes a literal — regex metacharacters in a pin are data, not syntax", () => {
    expect("FROM alpine@sha256:00").toMatch(atLineStart("FROM alpine@sha256:00"));
    // `.` must not match `x`; without escaping, `a.c` would.
    expect("axc=1").not.toMatch(atLineStart("a.c=1"));
  });

  it("keeps a RegExp's capture groups, so an existing `.exec()` census can be anchored in place", () => {
    const anchored = atLineStart(/ARG\s+SKOPEO_IMAGE=(\S+)/);
    expect(anchored.exec(DOCKERFILE)?.[1]).toBe("quay.io/skopeo/stable@sha256:beef");
    expect(atLineStart(/ARG\s+COSIGN_IMAGE=(\S+)/).exec(DOCKERFILE)).toBeNull();
  });

  it("anchors EVERY arm of an alternation, not just the first", () => {
    // The trap: naively prefixing `^[ \t]*` to `/a|b/` gives `^[ \t]*a|b`, where `b` stays
    // unanchored and a commented-out `b` still matches. The non-capturing wrapper is what
    // prevents that, and this case fails without it.
    expect("# BBB").not.toMatch(atLineStart(/AAA|BBB/));
    expect("BBB").toMatch(atLineStart(/AAA|BBB/));
  });

  it("always searches per-line, whatever flags the caller's RegExp carried", () => {
    expect("first\nARG X=1").toMatch(atLineStart(/ARG X=1/));
    expect("first\narg x=1").toMatch(atLineStart(/ARG X=1/i));
  });
});

describe("stripHashComments — for the text that cannot be anchored", () => {
  const RUN_BLOCK = [
    "# VERSION ASSERTION: `oscap --version | grep -qF ...` FAILS THE BUILD on drift.",
    "RUN dnf install -y openscap-scanner \\",
    "  && oscap --version | grep -qF version \\",
    "  && dnf clean all"
  ].join("\n");

  it("keeps a CONTINUATION line, which no line-start anchor could match", () => {
    // `  && oscap …` does not start with `oscap`, so anchoring is the wrong tool here; removing the
    // prose line above it is what makes the unanchored match mean something.
    expect(stripHashComments(RUN_BLOCK)).toMatch(/oscap\s+--version\s*\|\s*grep\s+-qF/);
  });

  it("REFUSES when only the prose comment describes the check", () => {
    // The measured defect in `@scp/plugin-managed-scan`'s pin.test.ts: two comments describing the
    // oscap version assertion satisfied it, so the assertion itself could be deleted outright.
    const proseOnly = RUN_BLOCK.split("\n")
      .filter((l) => !l.startsWith("  && oscap"))
      .join("\n");
    expect(proseOnly).toMatch(/oscap\s+--version\s*\|\s*grep\s+-qF/);
    expect(stripHashComments(proseOnly)).not.toMatch(/oscap\s+--version\s*\|\s*grep\s+-qF/);
  });

  it("preserves line numbering, so a failure still points at a plausible place", () => {
    expect(stripHashComments(RUN_BLOCK).split("\n")).toHaveLength(4);
    expect(stripHashComments(RUN_BLOCK).split("\n")[0]).toBe("");
  });

  it("leaves a TRAILING comment alone — the documented limit, not an oversight", () => {
    // Stripping these correctly needs shell quoting rules (`echo "a # b"` contains no comment),
    // and a stripper that guessed would corrupt the lines a census asserts on. `atLineStart` is
    // the tool for anything a trailing comment could satisfy.
    expect(stripHashComments('echo "a # b"')).toBe('echo "a # b"');
    expect(stripHashComments("RUN foo # ARG X=1")).toContain("ARG X=1");
  });
});

describe("the two comment syntaxes are not interchangeable — using the wrong one strips NOTHING", () => {
  it("the TS stripper leaves a `#` comment entirely intact", () => {
    // This is the silence that let the pin gates rot: no error, no empty result, just a census
    // still counting a commented-out line as live.
    expect(stripComments("# ARG COSIGN_IMAGE=x")).toBe("# ARG COSIGN_IMAGE=x");
  });

  it("the `#` stripper leaves a `//` comment entirely intact", () => {
    expect(stripHashComments("// startXLoop(db);")).toBe("// startXLoop(db);");
  });
});
