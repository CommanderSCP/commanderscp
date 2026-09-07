/** What version does this manifest declare for itself. See docs/dependency-manifests.md §53. */
import { ManifestParseError } from "./types.js";
import { scanToml, tableEntries } from "./toml-lite.js";

/** The three ecosystems that state their own version. See docs/dependency-manifests.md §54. */
export type ProjectVersionEcosystem = "npm" | "python" | "maven";

export type ProjectVersionOutcome =
  | { readonly outcome: "declared"; readonly version: string; readonly declaredIn: string }
  /** The manifest is readable and simply names no version of its own. */
  | { readonly outcome: "absent"; readonly detail: string }
  /** A version IS expressed but knowing it requires resolution this package must not perform. */
  | { readonly outcome: "unresolved"; readonly detail: string };

/**
 * Read the version a manifest declares for the project it describes.
 *
 * @throws {ManifestParseError} when `content` is not the named format at all.
 */
export function readDeclaredProjectVersion(
  ecosystem: ProjectVersionEcosystem,
  content: string
): ProjectVersionOutcome {
  switch (ecosystem) {
    case "npm":
      return readPackageJsonVersion(content);
    case "python":
      return readPyprojectVersion(content);
    case "maven":
      return readPomProjectVersion(content);
  }
}

/** `package.json`'s own `version`. See docs/dependency-manifests.md §55. */
function readPackageJsonVersion(content: string): ProjectVersionOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new ManifestParseError("package.json is not valid JSON", err);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ManifestParseError("package.json is not a JSON object");
  }
  const version = (doc as { version?: unknown }).version;
  if (version === undefined) {
    return { outcome: "absent", detail: "package.json declares no `version` field" };
  }
  if (typeof version !== "string" || version.trim() === "") {
    // NOT a throw: the file IS a readable package.json, it just says something unusable. Throwing
    // would make the caller report "could not read the manifest", which is a different — and
    // false — statement about the repo.
    return {
      outcome: "absent",
      detail: `package.json \`version\` is not a non-empty string (${typeof version})`
    };
  }
  return { outcome: "declared", version: version.trim(), declaredIn: "version" };
}

/** PEP 621's version, then Poetry's, in that order. See docs/dependency-manifests.md §56. */
function readPyprojectVersion(content: string): ProjectVersionOutcome {
  const entries = scanToml(content);
  if (entries.length === 0) {
    // Mirrors `parsePyprojectToml`'s own rule: a document with no entries at all is not a
    // pyproject.toml we read successfully, it is a file we failed to read.
    throw new ManifestParseError("pyproject.toml contains no TOML entries");
  }

  for (const entry of tableEntries(entries, ["project"])) {
    if (entry.key === "dynamic" && entry.value.kind === "array") {
      const dynamic = entry.value.items.some(
        (item) => item.kind === "string" && item.value === "version"
      );
      if (dynamic) {
        return {
          outcome: "unresolved",
          detail:
            'pyproject.toml declares `[project] dynamic = ["version"]` — the version comes from ' +
            "the build backend, and running one is tooling execution (ADR-0032 §8)"
        };
      }
    }
  }

  for (const [path, label] of [
    [["project"], "project.version"],
    [["tool", "poetry"], "tool.poetry.version"]
  ] as const) {
    for (const entry of tableEntries(entries, path)) {
      if (entry.key !== "version") continue;
      if (entry.value.kind !== "string" || entry.value.value.trim() === "") continue;
      return { outcome: "declared", version: entry.value.value.trim(), declaredIn: label };
    }
  }

  return {
    outcome: "absent",
    detail: "pyproject.toml declares neither `[project] version` nor `[tool.poetry] version`"
  };
}

/** The DIRECT `<version>` child of `<project>`. See docs/dependency-manifests.md §57. */
function readPomProjectVersion(content: string): ProjectVersionOutcome {
  const stack: string[] = [];
  let sawProject = false;
  let sawParent = false;
  let version: string | undefined;
  /** Text accumulated since the last tag — the value of whatever element is currently open. */
  let text = "";
  let i = 0;

  while (i < content.length) {
    const lt = content.indexOf("<", i);
    if (lt === -1) break;
    text += content.slice(i, lt);

    if (content.startsWith("<!--", lt)) {
      const end = content.indexOf("-->", lt + 4);
      if (end === -1) throw new ManifestParseError("pom.xml has an unterminated XML comment");
      i = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", lt)) {
      const end = content.indexOf("]]>", lt + 9);
      if (end === -1) throw new ManifestParseError("pom.xml has an unterminated CDATA section");
      text += content.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (content.startsWith("<?", lt) || content.startsWith("<!", lt)) {
      const end = content.indexOf(">", lt);
      if (end === -1) throw new ManifestParseError("pom.xml has an unterminated declaration");
      i = end + 1;
      continue;
    }

    const gt = content.indexOf(">", lt);
    if (gt === -1) throw new ManifestParseError("pom.xml has an unterminated tag");
    const inner = content.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith("/")) {
      const name = pomLocalName(inner.slice(1).trim());
      const open = stack[stack.length - 1];
      if (open === undefined) {
        throw new ManifestParseError(`pom.xml closes </${name}> with no element open`);
      }
      if (open !== name) {
        throw new ManifestParseError(`pom.xml closes </${name}> while <${open}> is open`);
      }
      // Depth 2 with `project` at depth 1 is the project's OWN version. The first one wins; a POM
      // with two is malformed in a way this reader does not adjudicate.
      if (
        version === undefined &&
        name === "version" &&
        stack.length === 2 &&
        stack[0] === "project"
      ) {
        version = text.trim();
      }
      stack.pop();
      text = "";
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const name = pomLocalName(inner.replace(/\/$/, "").trim().split(/\s/)[0] ?? "");
    if (name === "") throw new ManifestParseError("pom.xml has a tag with no name");
    if (name === "project" && stack.length === 0) sawProject = true;
    if (name === "parent" && stack.length === 1 && stack[0] === "project") sawParent = true;
    if (selfClosing) {
      text = "";
      continue;
    }
    stack.push(name);
    text = "";
  }

  if (stack.length !== 0) {
    throw new ManifestParseError(`pom.xml ended with unclosed element(s): ${stack.join("/")}`);
  }
  if (!sawProject) throw new ManifestParseError("pom.xml has no <project> root element");

  if (version === undefined || version === "") {
    return sawParent
      ? {
          outcome: "unresolved",
          detail:
            "pom.xml declares no <project><version> and does declare a <parent> — the version is " +
            "inherited, and reading the parent POM is a closure walk (ADR-0032 §4)"
        }
      : { outcome: "absent", detail: "pom.xml declares no <project><version>" };
  }
  if (version.includes("${")) {
    return {
      outcome: "unresolved",
      detail: `pom.xml declares <project><version>${version}</version> — a property interpolation, and evaluating Maven's property model is running the build (ADR-0032 §8)`
    };
  }
  return { outcome: "declared", version, declaredIn: "project.version" };
}

/** `ns:version` -> `version`. Namespace prefixes are syntax, not identity (same rule as
 *  `pom-xml.ts`'s `localName`). */
function pomLocalName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}
