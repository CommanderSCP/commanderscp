import { readFileSync } from "node:fs";

/**
 * ================================================================================================
 * `#`-COMMENT SOURCE — Dockerfiles, shell, YAML, `pin.env`
 * ================================================================================================
 * `./ts.ts`'s {@link stripComments} is the WRONG TOOL here and fails silently: it knows `//` and
 * slash-star only, so running a Dockerfile through it strips nothing and the census keeps counting
 * commented-out lines as live. That was not hypothetical — it is what left the cosign, skopeo and
 * scanner pin gates green with seven pins commented out (package doc, and the four measurements
 * quoted there).
 *
 * Two tools, because the sites need both and neither subsumes the other:
 *
 *   {@link atLineStart}       — a PRESENCE matcher anchored to the start of a line. Strictly the
 *                               stronger of the two: a `#` prefix cannot satisfy it, and neither
 *                               can an occurrence buried in a TRAILING comment on a live line.
 *                               Use it whenever the thing asserted really does begin its line
 *                               (`ARG X=`, `COPY …`, `FROM …`, `d=…`, `exec …`, `KEY=value`).
 *   {@link stripHashComments} — removes WHOLE-line comments and leaves everything else. Use it when
 *                               the text cannot be anchored: a token mid-line (`run: scripts/x.sh`
 *                               in a YAML step), or a shell/Dockerfile CONTINUATION line, where the
 *                               live line legitimately starts with `&&` or `\`.
 *
 * DO NOT USE EITHER ON MARKDOWN. There `#` is a heading, and a `#`-line filter would delete the
 * document's structure — silently, producing a false RED at best.
 *
 * ONLY FOR PRESENCE ASSERTIONS. For an ABSENCE assertion (`expect(text).not.toMatch(…)`), a comment
 * marker already makes the check strictly harder to pass, and anchoring would NARROW what counts as
 * a violation — i.e. weaken the gate. Leave those reading the raw text, and say so where they are.
 *
 * WHAT THIS STILL DOES NOT PROVE: everything in the package doc's list. Anchoring fixes the comment
 * case and no more. A `#`-language census still passes over a stage nothing `COPY --from`s, a shell
 * line behind a condition that is never true, a job disabled by an `if:` above it, and — since
 * nothing here tracks quoting — the same text inside a heredoc or a quoted string.
 */

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `pattern`, re-anchored to the START of a line: leading whitespace is allowed, a `#` is not.
 *
 * Accepts a literal string (escaped for you — the common case, replacing a `.toContain(…)` that a
 * comment could satisfy) or a RegExp (whose capture groups survive, so an existing
 * `/ARG\s+TRIVY_IMAGE=(\S+)/.exec(…)` keeps working unchanged apart from the wrapping). The
 * returned RegExp always carries `m`, so `^` means "start of a line", not "start of the file".
 *
 * The alternation trap this avoids: naively prefixing `^[ \t]*` to `/a|b/` yields `^[ \t]*a|b`,
 * which anchors only the first arm. The pattern is wrapped in a NON-capturing group first.
 */
export function atLineStart(pattern: string | RegExp): RegExp {
  const source = typeof pattern === "string" ? escapeLiteral(pattern) : pattern.source;
  const flags = typeof pattern === "string" ? "m" : new Set([...pattern.flags, "m"]);
  return new RegExp(String.raw`^[ \t]*(?:${source})`, [...flags].join(""));
}

/**
 * `source` with whole-line `#` comments removed — what the build/shell/parser actually acts on.
 *
 * A line counts as a comment when its first non-whitespace character is `#`. Blank lines and the
 * line numbering are preserved (comments become empty lines) so a failure message still points at
 * a plausible place in the real file.
 *
 * IT DOES NOT REMOVE TRAILING COMMENTS. `RUN foo   # ARG COSIGN_IMAGE=sha256:…` survives whole,
 * so a token that could plausibly appear after a `#` on an otherwise live line is NOT protected by
 * this function — use {@link atLineStart} for those. Trailing comments are deliberately left alone
 * because stripping them correctly needs shell quoting rules (`echo "a # b"` contains no comment),
 * and a stripper that guesses would corrupt the very lines the census is asserting on.
 */
export function stripHashComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
}

/** Read + strip in one step, for a Dockerfile / shell script / YAML / `pin.env`. */
export function readHashStripped(file: string): string {
  return stripHashComments(readFileSync(file, "utf8"));
}
