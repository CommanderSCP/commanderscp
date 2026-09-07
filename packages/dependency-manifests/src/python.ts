/** Python: `pyproject.toml` and `requirements.txt`. See docs/dependency-manifests.md §73. */
import { ManifestParseError, type DeclaredDependency, type DependencyScope } from "./types.js";
import { scanToml, tableEntries, type TomlEntry, type TomlValue } from "./toml-lite.js";
import { parseComparableVersion } from "./version.js";

/** PEP 508, where the leading anchor is load-bearing. See docs/dependency-manifests.md §74. */
const PEP508_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/;

/** `==1.2.3` / `===1.2.3` naming exactly one version. `==1.2.*` is a range and is excluded here. */
const PY_EXACT_RE = /^={2,3}\s*[^\s,*]+$/;

/** A line whose leading token is a URL scheme. See docs/dependency-manifests.md §75. */
const SCHEME_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[+:]/;

interface ParsedRequirement {
  readonly coordinate: string;
  readonly declared?: string;
  readonly constraint: DeclaredDependency["constraint"];
  readonly note?: string;
}

/** Parse one requirement to coordinate and constraint. See docs/dependency-manifests.md §76. */
export function parsePep508(requirement: string): ParsedRequirement | undefined {
  // Strip the environment marker: it gates installation, not identity.
  const semicolon = requirement.indexOf(";");
  const withoutMarker = (semicolon === -1 ? requirement : requirement.slice(0, semicolon)).trim();
  if (withoutMarker === "") return undefined;

  const m = PEP508_RE.exec(withoutMarker);
  const name = m?.[1];
  if (!m || name === undefined) return undefined;

  const extras = m[2];
  const rest = (m[3] ?? "").trim();
  const extrasNote =
    extras !== undefined && extras.trim() !== ""
      ? `extras [${extras.trim()}] declared; extras select optional features of the same distribution and do not change its identity`
      : undefined;

  // Direct reference (PEP 440 §"Direct references"): `pkg @ https://…/pkg-1.0.whl`. The version is
  // baked into a URL and is not a registry line; unresolved, never parsed out of the path.
  if (rest.startsWith("@")) {
    return {
      coordinate: name,
      declared: rest,
      constraint: "unresolved",
      note: "direct-reference URL specifier: not a registry version line"
    };
  }

  const spec = rest.startsWith("(") && rest.endsWith(")") ? rest.slice(1, -1).trim() : rest;

  if (spec === "") {
    return {
      coordinate: name,
      constraint: "unpinned",
      ...(extrasNote !== undefined ? { note: extrasNote } : {})
    };
  }

  return {
    coordinate: name,
    declared: spec,
    constraint: PY_EXACT_RE.test(spec) ? "pinned" : "range",
    ...(extrasNote !== undefined ? { note: extrasNote } : {})
  };
}

/** One clause of a comma-separated specifier. See docs/dependency-manifests.md §77. */
const PY_CLAUSE_RE = /^(===|==|~=|!=|>=|<=|\^|~|>|<)?\s*(.*)$/;

/** Operators whose clause names the declared floor. See docs/dependency-manifests.md §78. */
const PY_FLOOR_OPS: ReadonlySet<string> = new Set(["", "===", "==", "~=", ">=", ">", "^", "~"]);

/** The floor clause of a specifier, or `undefined` when no clause states one. */
function comparableFrom(spec: string | undefined): ReturnType<typeof parseComparableVersion> {
  if (spec === undefined) return undefined;
  for (const raw of spec.split(",")) {
    const clause = raw.trim();
    if (clause === "") continue;
    const m = PY_CLAUSE_RE.exec(clause);
    if (!m) continue;
    if (!PY_FLOOR_OPS.has(m[1] ?? "")) continue;
    const parsed = parseComparableVersion((m[2] ?? "").trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function toDeclared(
  parsed: ParsedRequirement,
  scope: DependencyScope,
  declaredIn: string,
  line?: number
): DeclaredDependency {
  const version = parsed.constraint === "unresolved" ? undefined : comparableFrom(parsed.declared);
  return {
    ecosystem: "python",
    coordinate: parsed.coordinate,
    ...(parsed.declared !== undefined ? { declared: parsed.declared } : {}),
    constraint: parsed.constraint,
    scope,
    ...(version !== undefined ? { version } : {}),
    declaredIn,
    ...(line !== undefined ? { line } : {}),
    ...(parsed.note !== undefined ? { note: parsed.note } : {})
  };
}

/** Parse a `requirements.txt`. See docs/dependency-manifests.md §79. */
export function parseRequirementsTxt(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  const physical = content.split(/\r?\n/);

  let buffer = "";
  let startLine = 0;

  const flush = (): void => {
    const text = buffer.trim();
    buffer = "";
    if (text === "") return;

    // Option lines are not filtered here, and why. See docs/dependency-manifests.md §80.

    // A URL, VCS or path requirement names no distribution we can key on — whether it is spelled
    // correctly or not. One guard covers both, for the reasons on SCHEME_LINE_RE.
    if (SCHEME_LINE_RE.test(text) || text.startsWith(".") || text.startsWith("/")) return;

    const withoutHashes = text.replace(/\s--hash=\S+/g, "").trim();
    const parsed = parsePep508(withoutHashes);
    if (!parsed) return;
    // requirements.txt expresses no scope distinction whatsoever — the convention of a separate
    // `requirements-dev.txt` is a FILENAME convention, and inferring scope from a filename is the
    // provenance-label mistake (a label named after what matched goes false the moment a second
    // kind of file matches). The caller knows which file it fetched; this parser does not guess.
    out.push(toDeclared(parsed, "runtime", "requirements.txt", startLine));
  };

  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i] ?? "";
    // A `#` comment runs to end of line. `#` cannot appear inside a requirement specifier.
    const hash = raw.indexOf("#");
    const code = (hash === -1 ? raw : raw.slice(0, hash)).trimEnd();
    if (code.trim() === "" && buffer === "") continue;

    if (buffer === "") startLine = i + 1;

    if (code.endsWith("\\")) {
      buffer += `${code.slice(0, -1).trim()} `;
      continue;
    }
    buffer += code;
    flush();
  }
  flush();

  return out;
}

/** Pull the string items out of an array value, ignoring anything that is not a string. */
function stringItems(value: TomlValue): string[] {
  if (value.kind !== "array") return [];
  return value.items.flatMap((item) => (item.kind === "string" ? [item.value] : []));
}

/**
 * A Poetry dependency value is either `"^2.31"` or an inline table `{version = "^2.31", ...}`.
 * A table with no `version` key (`{git = "…"}`, `{path = "…"}`) is a location, not a version line.
 */
function poetrySpec(value: TomlValue): { spec?: string; unresolvedReason?: string } {
  if (value.kind === "string") return { spec: value.value };
  if (value.kind === "table") {
    const versionEntry = value.entries.find(([k]) => k === "version");
    const v = versionEntry?.[1];
    if (v !== undefined && v.kind === "string") return { spec: v.value };
    return {
      unresolvedReason:
        "Poetry table specifier names a location (git/path/url) rather than a registry version line"
    };
  }
  if (value.kind === "array") {
    // Multiple-constraints dependencies: `[{version="^1", python="<3.9"}, …]`. Which one applies
    // depends on the environment, so no single declared version is stateable from the file.
    return {
      unresolvedReason:
        "Poetry multiple-constraints dependency: the applicable version depends on the resolution environment"
    };
  }
  return { unresolvedReason: "unrecognised Poetry dependency value" };
}

function poetryEntries(
  entries: readonly TomlEntry[],
  path: readonly string[],
  scope: DependencyScope,
  out: DeclaredDependency[]
): void {
  for (const entry of tableEntries(entries, path)) {
    // The interpreter constraint, not a package. See the module comment.
    if (entry.key === "python") continue;

    const { spec, unresolvedReason } = poetrySpec(entry.value);
    const declaredIn = path.join(".");

    if (spec === undefined) {
      out.push({
        ecosystem: "python",
        coordinate: entry.key,
        constraint: "unresolved",
        scope,
        declaredIn,
        ...(unresolvedReason !== undefined ? { note: unresolvedReason } : {})
      });
      continue;
    }

    // Poetry's own operators (`^`, `~`, `*`) are ranges; `2.31.0` bare in Poetry means EXACTLY that
    // version (unlike npm's caret default), so it classifies as pinned.
    const constraint: DeclaredDependency["constraint"] =
      spec === "*" ? "unpinned" : /^[0-9]/.test(spec) && !/[,\s*]/.test(spec) ? "pinned" : "range";

    out.push({
      ecosystem: "python",
      coordinate: entry.key,
      ...(constraint === "unpinned" ? {} : { declared: spec }),
      constraint,
      scope,
      ...(() => {
        const v = constraint === "unpinned" ? undefined : comparableFrom(spec);
        return v !== undefined ? { version: v } : {};
      })(),
      declaredIn
    });
  }
}

/**
 * Parse a `pyproject.toml`.
 *
 * @throws {ManifestParseError} when the TOML cannot be read at all — never silently empty, for the
 *   reason given on {@link ManifestParseError}.
 */
export function parsePyprojectToml(content: string): DeclaredDependency[] {
  const entries = scanToml(content);
  const out: DeclaredDependency[] = [];

  for (const entry of tableEntries(entries, ["project"])) {
    if (entry.key !== "dependencies") continue;
    for (const req of stringItems(entry.value)) {
      const parsed = parsePep508(req);
      if (parsed) out.push(toDeclared(parsed, "runtime", "project.dependencies"));
    }
  }

  for (const entry of tableEntries(entries, ["project", "optional-dependencies"])) {
    for (const req of stringItems(entry.value)) {
      const parsed = parsePep508(req);
      // Optional extras still SHIP — they are runtime code for whoever asks for the extra. The
      // group name is preserved in `declaredIn` so a caller that wants to treat a group named
      // "test" as dev can do so from a DECLARED fact rather than this parser guessing from a name.
      if (parsed)
        out.push(toDeclared(parsed, "runtime", `project.optional-dependencies.${entry.key}`));
    }
  }

  // --- PEP 735 dependency groups (the standard dev-dependency mechanism) --------------------
  for (const entry of tableEntries(entries, ["dependency-groups"])) {
    for (const item of entry.value.kind === "array" ? entry.value.items : []) {
      // `{include-group = "other"}` is a reference to another group, not a package.
      if (item.kind !== "string") continue;
      const parsed = parsePep508(item.value);
      if (parsed) out.push(toDeclared(parsed, "dev", `dependency-groups.${entry.key}`));
    }
  }

  for (const entry of tableEntries(entries, ["build-system"])) {
    if (entry.key !== "requires") continue;
    for (const req of stringItems(entry.value)) {
      const parsed = parsePep508(req);
      if (parsed) out.push(toDeclared(parsed, "build", "build-system.requires"));
    }
  }

  poetryEntries(entries, ["tool", "poetry", "dependencies"], "runtime", out);
  poetryEntries(entries, ["tool", "poetry", "dev-dependencies"], "dev", out);
  // `[tool.poetry.group.<name>.dependencies]` — the group name is the 4th path segment, so the
  // groups are discovered from the scanned paths rather than from a hard-coded list of names.
  const groupNames = new Set<string>();
  for (const e of entries) {
    if (
      e.path.length === 5 &&
      e.path[0] === "tool" &&
      e.path[1] === "poetry" &&
      e.path[2] === "group" &&
      e.path[4] === "dependencies"
    ) {
      const g = e.path[3];
      if (g !== undefined) groupNames.add(g);
    }
  }
  for (const g of groupNames) {
    poetryEntries(entries, ["tool", "poetry", "group", g, "dependencies"], "dev", out);
  }

  if (out.length === 0 && entries.length === 0) {
    // An entirely empty scan means we were handed something that is not a pyproject.toml at all.
    throw new ManifestParseError("pyproject.toml contained no TOML entries");
  }

  return out;
}
