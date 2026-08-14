/**
 * `pom.xml` — the project's own `<dependencies>` block.
 *
 * **Two Maven features are explicitly OUT OF SCOPE for this increment, and both are reported as
 * `unresolved` rather than guessed:**
 *
 * 1. **Parent-POM inheritance / `<dependencyManagement>`.** A `<dependency>` with no `<version>` is
 *    not under-specified — its version is supplied by a parent POM or a `<dependencyManagement>`
 *    section, quite possibly in a *different file in a different repository*. Resolving that means
 *    fetching and merging the parent chain, which is dependency RESOLUTION: exactly the work
 *    ADR-0032 §8 puts out of bounds ("Manifest-only edits. No lockfile resolution.") and exactly
 *    the I/O this package refuses to do.
 * 2. **Property interpolation** — `<version>${spring.version}</version>`. The value may come from
 *    this POM's `<properties>`, from a parent's, from a profile that is only active on some
 *    machines, from `-Dspring.version=…` on the command line, or from a `settings.xml`. Even the
 *    subset that *is* resolvable from this one file is only a DEFAULT. An interpolated version is
 *    therefore reported unresolved.
 *
 * Both are stated here as a scope boundary rather than discovered during implementation, per
 * ADR-0032's own standard for the lockfile limit ("a real functional limit … stated as a scope
 * boundary, not discovered during implementation"). A dependency reported `unresolved` is still a
 * real inventory row — the coordinate is known and the reverse query "which components declare
 * org.springframework:spring-core?" still answers correctly. Only the *version* is withheld, and
 * withholding it is what stops an actuator writing a confidently wrong number into someone's POM.
 *
 * **Only the project's own `<dependencies>`.** `<dependencyManagement><dependencies>` declares
 * versions for dependencies that may never be used, `<build><plugins>` are build-tool plugins, and
 * `<profiles>` are conditionally active. Each is excluded by matching the FULL element path
 * (`project/dependencies/dependency`) rather than the element name — a name-matching parser reads
 * all four blocks as one and reports dependencies the module does not have.
 *
 * **Maven scopes** map as: `compile` (the default) and `runtime` -> `runtime`; `test` -> `dev`;
 * `provided` and `system` -> `build` (available while compiling, deliberately not packaged).
 */
import { ManifestParseError, type DeclaredDependency, type DependencyScope } from "./types.js";
import { parseComparableVersion } from "./version.js";

/** Maven's `<scope>` vocabulary, mapped onto this package's three-value scope. */
const SCOPE_MAP: Readonly<Record<string, DependencyScope>> = {
  compile: "runtime",
  runtime: "runtime",
  test: "dev",
  provided: "build",
  system: "build"
};

/** The five predefined XML entities. Maven coordinates and versions contain nothing else. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One `<dependency>` element's collected child text. */
interface RawDependency {
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  optional?: string;
  line?: number;
}

/**
 * Walk the document, tracking the full element path, and hand each `<dependency>` element's
 * children to `onChild`.
 *
 * A hand-written walker rather than an XML library for the same reason as `toml-lite.ts`: charter
 * principle 5 (offline, vendored, no runtime network) and a deliberately dependency-free package.
 * It handles comments, CDATA, processing instructions, self-closing elements and namespace
 * prefixes, and it throws on a malformed document instead of returning a partial one.
 */
function walk(
  content: string,
  onDependency: (dep: RawDependency, path: readonly string[]) => void
): { sawProject: boolean } {
  const stack: string[] = [];
  let sawProject = false;

  /** The dependency currently being collected, if the cursor is inside one. */
  let current: RawDependency | undefined;
  /** Depth of the `<dependency>` element itself, so nested elements do not close it early. */
  let currentDepth = -1;
  /** Text accumulated since the last tag — the value of whatever element just opened. */
  let text = "";
  /** Line number tracking, for {@link DeclaredDependency.line}. */
  let line = 1;

  let i = 0;
  const advanceLines = (chunk: string): void => {
    for (let k = 0; k < chunk.length; k++) if (chunk[k] === "\n") line++;
  };

  while (i < content.length) {
    const lt = content.indexOf("<", i);
    if (lt === -1) break;

    const chunk = content.slice(i, lt);
    text += chunk;
    advanceLines(chunk);

    if (content.startsWith("<!--", lt)) {
      const end = content.indexOf("-->", lt + 4);
      if (end === -1) throw new ManifestParseError("pom.xml has an unterminated XML comment");
      advanceLines(content.slice(lt, end + 3));
      i = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", lt)) {
      const end = content.indexOf("]]>", lt + 9);
      if (end === -1) throw new ManifestParseError("pom.xml has an unterminated CDATA section");
      text += content.slice(lt + 9, end);
      advanceLines(content.slice(lt, end + 3));
      i = end + 3;
      continue;
    }
    if (content.startsWith("<?", lt) || content.startsWith("<!", lt)) {
      const end = content.indexOf(">", lt);
      if (end === -1) throw new ManifestParseError("pom.xml has an unterminated declaration");
      advanceLines(content.slice(lt, end + 1));
      i = end + 1;
      continue;
    }

    const gt = content.indexOf(">", lt);
    if (gt === -1) throw new ManifestParseError("pom.xml has an unterminated tag");
    const inner = content.slice(lt + 1, gt);
    const tagLine = line;
    advanceLines(content.slice(lt, gt + 1));
    i = gt + 1;

    if (inner.startsWith("/")) {
      // Closing tag. The text accumulated since the matching open tag is this element's value.
      const name = localName(inner.slice(1).trim());
      const closedDepth = stack.length - 1;
      stack.pop();

      if (current !== undefined && closedDepth === currentDepth) {
        onDependency(current, stack);
        current = undefined;
        currentDepth = -1;
      } else if (current !== undefined && closedDepth === currentDepth + 1) {
        // A direct child of <dependency>: groupId / artifactId / version / scope / optional.
        assignChild(current, name, decodeEntities(text).trim());
      }
      text = "";
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const name = localName(inner.replace(/\/$/, "").trim().split(/\s/)[0] ?? "");
    if (name === "") throw new ManifestParseError("pom.xml has a tag with no name");
    if (name === "project" && stack.length === 0) sawProject = true;

    if (selfClosing) {
      // `<version/>` — an empty element. Treated as an empty child value of the current dependency.
      if (current !== undefined && stack.length === currentDepth + 1)
        assignChild(current, name, "");
      text = "";
      continue;
    }

    stack.push(name);
    text = "";

    // Entering a dependency, but ONLY on the project's own path. Full-path matching is what keeps
    // <dependencyManagement>, <build><plugins> and <profiles> out.
    if (
      current === undefined &&
      stack.length === 3 &&
      stack[0] === "project" &&
      stack[1] === "dependencies" &&
      stack[2] === "dependency"
    ) {
      current = { line: tagLine };
      currentDepth = stack.length - 1;
    }
  }

  // A truncated document is a read failure, not a module that declares nothing. Without this check
  // a file cut off mid-`<dependencies>` returns [] and the next ingestion pass silently deletes the
  // component's entire inventory — see ManifestParseError for why the two must never collapse.
  if (stack.length !== 0) {
    throw new ManifestParseError(`pom.xml ended with unclosed element(s): ${stack.join("/")}`);
  }

  return { sawProject };
}

/** `ns:artifactId` -> `artifactId`. Namespace prefixes are syntax, not identity. */
function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function assignChild(dep: RawDependency, name: string, value: string): void {
  switch (name) {
    case "groupId":
      dep.groupId = value;
      break;
    case "artifactId":
      dep.artifactId = value;
      break;
    case "version":
      dep.version = value;
      break;
    case "scope":
      dep.scope = value;
      break;
    case "optional":
      dep.optional = value;
      break;
    default:
      // <type>, <classifier>, <exclusions> and friends: not part of the coordinate this feature
      // subscribes on, and deliberately not silently folded into it.
      break;
  }
}

/** `[1.0,2.0)`, `(,1.0]`, `[1.0,)` — a Maven version RANGE, as opposed to the usual soft pin. */
const MAVEN_RANGE_RE = /^[[(].*[\])]$/;
/** `${anything}` anywhere in the version text. */
const INTERPOLATION_RE = /\$\{[^}]*\}/;

/**
 * Parse a `pom.xml`'s direct dependencies.
 *
 * @param content the file's bytes decoded as UTF-8.
 * @throws {ManifestParseError} when the document is malformed or is not a POM (no `<project>`), so
 *   an unreadable file can never be mistaken for a module that declares nothing.
 */
export function parsePomXml(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];

  const { sawProject } = walk(content, (dep) => {
    const { groupId, artifactId } = dep;
    // A dependency without both halves of its coordinate cannot be keyed, subscribed to, or bumped.
    // (groupId is itself inheritable from a parent POM — same §1 boundary, and there is no partial
    // identity worth storing.)
    if (groupId === undefined || groupId === "" || artifactId === undefined || artifactId === "") {
      return;
    }

    const coordinate = `${groupId}:${artifactId}`;
    const scope = SCOPE_MAP[(dep.scope ?? "compile").trim()] ?? "runtime";
    const optionalNote =
      dep.optional?.trim() === "true"
        ? "declared <optional>true</optional>: not propagated to consumers of this module"
        : undefined;

    const version = dep.version?.trim();

    if (version === undefined || version === "") {
      out.push({
        ecosystem: "maven",
        coordinate,
        constraint: "unresolved",
        scope,
        declaredIn: "dependencies",
        ...(dep.line !== undefined ? { line: dep.line } : {}),
        note:
          "no <version>: inherited from a parent POM or <dependencyManagement>, which this increment does not resolve" +
          (optionalNote !== undefined ? `; ${optionalNote}` : "")
      });
      return;
    }

    if (INTERPOLATION_RE.test(version)) {
      out.push({
        ecosystem: "maven",
        coordinate,
        declared: version,
        constraint: "unresolved",
        scope,
        declaredIn: "dependencies",
        ...(dep.line !== undefined ? { line: dep.line } : {}),
        note:
          `version "${version}" is a property reference; properties may come from a parent POM, a profile or -D on the command line, so it is reported unresolved rather than guessed` +
          (optionalNote !== undefined ? `; ${optionalNote}` : "")
      });
      return;
    }

    const isRange = MAVEN_RANGE_RE.test(version);
    // A bare Maven version is a SOFT pin — a recommendation Maven may override during mediation —
    // but it names exactly one version in this file, which is what `pinned` records here.
    const parsed = isRange ? undefined : parseComparableVersion(version);

    out.push({
      ecosystem: "maven",
      coordinate,
      declared: version,
      constraint: isRange ? "range" : "pinned",
      scope,
      ...(parsed !== undefined ? { version: parsed } : {}),
      declaredIn: "dependencies",
      ...(dep.line !== undefined ? { line: dep.line } : {}),
      ...(optionalNote !== undefined ? { note: optionalNote } : {})
    });
  });

  if (!sawProject) {
    throw new ManifestParseError("pom.xml has no <project> root element");
  }

  return out;
}
