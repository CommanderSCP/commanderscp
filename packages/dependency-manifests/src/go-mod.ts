/** `go.mod` require: direct requirements only. See docs/dependency-manifests.md §18. */
import { ManifestParseError, type DeclaredDependency } from "./types.js";
import { parseComparableVersion } from "./version.js";

/**
 * Every directive go.mod has (`go help go.mod`). Seeing none of them means we were not handed a
 * go.mod at all — see {@link parseGoMod}'s throw for why that must not return `[]`.
 */
const ALL_DIRECTIVES = ["module", "go", "toolchain", "require", "replace", "exclude", "retract"];

/** `// indirect`, or `// indirect; <anything>`. Anchored so a module named `indirectly` in a comment cannot match. */
const INDIRECT_RE = /^indirect\b/;

/** Directives that take a parenthesised block. We only ever read the contents of `require`. */
const BLOCK_DIRECTIVES = ["require", "replace", "exclude", "retract"] as const;
type BlockDirective = (typeof BLOCK_DIRECTIVES)[number];

/** Strip a line comment, returning code and comment. See docs/dependency-manifests.md §19. */
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
 * Parse a `go.mod` file's direct requirements. See docs/dependency-manifests.md §20.
 * @param content the file's bytes decoded as UTF-8.
 * @returns direct requirements, in file order. Indirect requirements are absent by design.
 * @throws {ManifestParseError} when the content carries no go.mod directive at all, so a 404 body,
 * an HTML error page or an unexpanded LFS pointer can never be mistaken for a module that
 * requires nothing. Go is sequenced FIRST by ADR-0032 §10, so this parser is the one most likely
 * to be handed a bad fetch, and a silent `[]` here DELETES the component's whole Go inventory on
 * the next ingestion pass — the exact collapse {@link ManifestParseError} exists to prevent, and
 * which `parsePackageJson`/`parsePomXml`/`parsePyprojectToml` already refuse to make.
 */
export function parseGoMod(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  // Which parenthesised block we are inside, or undefined at top level. Tracking the DIRECTIVE and
  // not just the depth is what keeps `replace (...)` contents out of the results.
  let block: BlockDirective | undefined;
  /** Whether anything in the file looked like a go.mod directive. See the @throws above. */
  let sawDirective = false;

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
      // Independently load-bearing, not a second belt. See docs/dependency-manifests.md §21.
      if (block === "require") {
        const dep = parseRequireLine(trimmed, comment, i + 1);
        if (dep) out.push(dep);
      }
      continue;
    }

    // Plausibility, tracked on the first token of every top-level line rather than by pattern-
    // matching the whole file: a directive is the one thing every go.mod has and no HTML error page
    // does.
    const firstToken = trimmed.split(/\s+/)[0] ?? "";
    if (ALL_DIRECTIVES.includes(firstToken)) sawDirective = true;

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

  if (!sawDirective) {
    throw new ManifestParseError("go.mod contains no go.mod directive (module/go/require/…)");
  }

  return out;
}

/** One requirement line; indirect returns undefined. See docs/dependency-manifests.md §22. */
function parseRequireLine(
  code: string,
  comment: string,
  line: number
): DeclaredDependency | undefined {
  if (INDIRECT_RE.test(comment)) return undefined;

  const tokens = code.split(/\s+/).filter((t) => t !== "");
  const path = tokens[0];
  const version = tokens[1];
  // Both arms are pinned separately in the tests: fewer than two tokens (`require github.com/x/y`,
  // a bare `retract` version) AND more than two (`a => b v1.0.0`, the shape a `replace` line takes
  // if the block-directive tracking above ever regresses). Neither arm is a backup for the other.
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
