/**
 * `go.mod` — the `require` directive, direct requirements only.
 *
 * Go is the one ecosystem where "direct only" is not a discipline we impose from outside: the file
 * itself marks the distinction. `go mod tidy` writes the module's own imports as plain `require`
 * lines and everything pulled in beneath them with a trailing `// indirect` comment. So a go.mod
 * contains BOTH the declared set and a chunk of the transitive closure, in one block, distinguished
 * only by a comment — and a parser that ignores that comment does not merely over-report, it
 * imports the transitive closure that ADR-0032 §4 exists to keep out (and that ADR-0013 keeps out
 * as SBOM bytes). Dropping `// indirect` is therefore the whole point of this parser, not a detail.
 *
 * Not parsed, deliberately:
 * - `replace` — a local redirection of an existing requirement, not a new dependency. Reporting a
 *   replace target would invent a dependency the module never declared.
 * - `exclude` / `retract` — negative statements; there is nothing to subscribe to.
 * - `go` / `toolchain` — the language version, not a package.
 * These are not silently skipped as a side effect of matching only `require`: the block-directive
 * state machine below tracks WHICH directive a parenthesised block belongs to, because
 * `replace (\n  a => b v1.0.0\n)` is line-shaped exactly like a require block and a naive
 * "am I inside parens" parser reads its contents as dependencies.
 *
 * Scope: go.mod expresses no runtime/dev/build distinction — Go test dependencies are ordinary
 * requirements — so every result is `runtime`. Stated here rather than left to be inferred from the
 * code, per ADR-0030 §2's "declared, never inferred".
 */
import type { DeclaredDependency } from "./types.js";
import { parseComparableVersion } from "./version.js";

/** `// indirect`, or `// indirect; <anything>`. Anchored so a module named `indirectly` in a comment cannot match. */
const INDIRECT_RE = /^indirect\b/;

/** Directives that take a parenthesised block. We only ever read the contents of `require`. */
const BLOCK_DIRECTIVES = ["require", "replace", "exclude", "retract"] as const;
type BlockDirective = (typeof BLOCK_DIRECTIVES)[number];

/**
 * Strip a line comment, returning the code part and the comment text.
 *
 * go.mod has no string literals that can contain `//` (module paths are quoted with `"` but never
 * contain a comment marker in practice), so a first-`//` split is sufficient and is what the
 * upstream `modfile` lexer effectively does for these directives.
 */
function splitComment(line: string): { code: string; comment: string } {
  const idx = line.indexOf("//");
  if (idx === -1) return { code: line, comment: "" };
  return { code: line.slice(0, idx), comment: line.slice(idx + 2).trim() };
}

/** go.mod permits (and `go mod edit` sometimes emits) quoted module paths. The quotes are syntax, not identity. */
function unquote(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Parse a `go.mod` file's direct requirements.
 *
 * Handles both surface forms of `require`, which is not cosmetic — real modules mix them, and
 * `go mod tidy` emits two separate blocks (direct, then indirect) in modern Go:
 *
 * ```
 * require github.com/pkg/errors v0.9.1            // single-line form
 * require (                                        // block form
 *     github.com/spf13/cobra v1.8.1
 *     golang.org/x/sys v0.22.0 // indirect
 * )
 * ```
 *
 * @param content the file's bytes decoded as UTF-8.
 * @returns direct requirements, in file order. Indirect requirements are absent by design.
 */
export function parseGoMod(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  // Which parenthesised block we are inside, or undefined at top level. Tracking the DIRECTIVE and
  // not just the depth is what keeps `replace (...)` contents out of the results.
  let block: BlockDirective | undefined;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const { code, comment } = splitComment(rawLine);
    const trimmed = code.trim();
    if (trimmed === "") continue;

    if (block !== undefined) {
      if (trimmed === ")") {
        block = undefined;
        continue;
      }
      if (block === "require") {
        const dep = parseRequireLine(trimmed, comment, i + 1);
        if (dep) out.push(dep);
      }
      // Inside replace/exclude/retract: consume and discard.
      continue;
    }

    const opened = BLOCK_DIRECTIVES.find((d) => trimmed === `${d} (`);
    if (opened !== undefined) {
      block = opened;
      continue;
    }

    if (trimmed.startsWith("require ")) {
      const dep = parseRequireLine(trimmed.slice("require ".length).trim(), comment, i + 1);
      if (dep) out.push(dep);
    }
    // Every other top-level directive (module/go/toolchain/replace/exclude/retract) is ignored.
  }

  return out;
}

/**
 * One `<module-path> <version>` requirement, already stripped of its `require` keyword and comment.
 *
 * Returns `undefined` for an indirect requirement (the ADR-0032 §4 exclusion) and for anything that
 * is not two tokens — a malformed line yields nothing rather than a half-built dependency, because
 * a dependency with a wrong version is worse than a dependency that is missing.
 */
function parseRequireLine(
  code: string,
  comment: string,
  line: number
): DeclaredDependency | undefined {
  if (INDIRECT_RE.test(comment)) return undefined;

  const tokens = code.split(/\s+/).filter((t) => t !== "");
  const path = tokens[0];
  const version = tokens[1];
  if (path === undefined || version === undefined || tokens.length > 2) return undefined;

  const coordinate = unquote(path);
  const declared = unquote(version);
  // Pseudo-versions (`v0.0.0-20240115120000-abc123def456`) parse to 0.0.0 with the timestamp+sha as
  // the suffix, which is correct and useful: compareVersions refuses to order them against a real
  // tagged release, so a subscription cannot "bump" a module off a pseudo-version by accident.
  const parsed = parseComparableVersion(declared);

  return {
    ecosystem: "go",
    coordinate,
    declared,
    // go.mod requirements are always a single exact version — Go's MVS resolves ranges at the
    // module graph level, never in the file. There is no range form to represent here.
    constraint: "pinned",
    scope: "runtime",
    ...(parsed !== undefined ? { version: parsed } : {}),
    declaredIn: "require",
    line
  };
}
