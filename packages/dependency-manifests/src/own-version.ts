/**
 * "WHAT VERSION DOES THIS MANIFEST DECLARE FOR **ITSELF**?" — the producer-side question, as
 * opposed to every other parser in this package, which answers the consumer-side one ("what does
 * this manifest declare about OTHER packages").
 *
 * WHY IT LIVES HERE AND NOT IN THE SERVER. M21.4's internal-release detection has to answer "which
 * version did this release publish?" for a language ecosystem, and the only honest signal is the
 * producing component's own manifest read at the released commit (`changes.source_ref` carries
 * repo/ref/commit/run_url/artifact_digest and NO version; `change_wave_targets.observed.images`
 * carries an image ref, which is the `oci` signal and not a language one). Answering it needs the
 * same TOML and XML subsets `python.ts` and `pom-xml.ts` already hand-rolled — so this file reuses
 * them rather than growing a second TOML reader and a second XML walker inside `apps/server`, where
 * manifest-format knowledge does not belong.
 *
 * THE THREE-WAY OUTCOME IS THE WHOLE POINT (ADR-0032 §7: "unparseable tags are skipped rather than
 * guessed"). "This manifest declares 1.4.2", "this manifest declares no version at all" and "this
 * manifest declares a version that cannot be known without doing work we are forbidden to do" are
 * three different facts, and collapsing the last two into a guess is how a component ends up
 * looking up-to-date at a version it never published. A WRONG version is worse than NO version,
 * because no version is visibly missing and a wrong one is invisibly false.
 *
 * The `unresolved` outcome is not hypothetical for Maven in particular: a POM whose `<version>` is
 * inherited from `<parent>` or written as `${revision}` is the common shape in a multi-module
 * build, and resolving either one means reading a second document or running the build — the first
 * is a closure walk (ADR-0032 §4) and the second is tooling execution (ADR-0032 §8, ADR-0002
 * gate 5). `DeclaredDependency.constraint` already models exactly this distinction as `unresolved`
 * on the consumer side; this is the same distinction on the producer side.
 *
 * SAME THROW CONTRACT AS EVERY OTHER PARSER HERE (see `index.ts`): content that is not the format
 * at all raises {@link ManifestParseError}. A 404 body, an unexpanded Git-LFS pointer and a
 * truncated response all arrive as strings, and a caller MUST catch per manifest — see the caller
 * contract in `index.ts`.
 */
import { ManifestParseError } from "./types.js";
import { scanToml, tableEntries } from "./toml-lite.js";

/** The three ecosystems whose manifest states the producing project's OWN version.
 *
 *  `go` is absent BY DESIGN, not by omission: `go.mod` declares the module PATH and never a
 *  version — a Go module's version IS its git tag — so there is nothing here to read and a caller
 *  must use the ref instead. `oci` is absent for the mirror-image reason: an image's version is the
 *  tag it was pushed under, which the registry knows and the Dockerfile does not. */
export type ProjectVersionEcosystem = "npm" | "python" | "maven";

export type ProjectVersionOutcome =
  /** The manifest states a version, verbatim and uninterpreted. */
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

// -------------------------------------------------------------------------------------------
// npm — package.json "version"
// -------------------------------------------------------------------------------------------

/**
 * `package.json`'s own `version`. The one ecosystem where the answer is a single field with no
 * inheritance and no interpolation.
 *
 * A workspace ROOT `package.json` routinely carries `"private": true` and either no `version` or a
 * placeholder — that lands on `absent`, which is correct: the root package is not what was
 * released. Deciding WHICH `package.json` describes the released component is the caller's problem
 * and is answered from the component's own recorded manifest paths, never guessed here.
 */
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

// -------------------------------------------------------------------------------------------
// python — pyproject.toml [project].version / [tool.poetry].version
// -------------------------------------------------------------------------------------------

/**
 * PEP 621's `[project] version`, then Poetry's `[tool.poetry] version`, in that order — the same
 * two tables `parsePyprojectToml` reads dependencies from, so a component whose dependencies this
 * package can read is a component whose version it can read too.
 *
 * `[project] dynamic = ["version"]` (PEP 621) is `unresolved`, NOT `absent`: the project has a
 * version and deliberately delegates it to the build backend (setuptools-scm reading a git tag,
 * hatch-vcs, a `__version__` attribute). Determining it means running the backend, which is tooling
 * execution — ADR-0032 §8's scope boundary and ADR-0002's gate 5. Reporting it as `absent` would
 * say "this project has no version", which is false and would send a reader looking in the wrong
 * place.
 */
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

// -------------------------------------------------------------------------------------------
// maven — the <project>'s own <version>
// -------------------------------------------------------------------------------------------

/**
 * The DIRECT `<version>` child of `<project>` — never `<parent><version>`, never a
 * `<dependency><version>`, never a plugin's.
 *
 * A depth-tracked scan rather than a reuse of `pom-xml.ts`'s `walk`: that walker's callback surface
 * is `onDependency`, i.e. it is shaped around the consumer-side question, and widening it to also
 * emit arbitrary top-level elements would change a function three shipped code paths depend on for
 * the sake of a fourth. The two share the refusal set below deliberately — an unterminated
 * construct is a read failure in both, for the reason `ManifestParseError` states.
 *
 * The two `unresolved` shapes are the ones that actually occur in multi-module builds:
 *   - no `<project><version>` but a `<project><parent>` — the version is INHERITED, and reading it
 *     means fetching a second POM (a closure walk, ADR-0032 §4);
 *   - a `${...}` interpolation (`${revision}`, `${project.parent.version}`) — resolving it means
 *     evaluating Maven's property model, which is running the build (ADR-0032 §8).
 * Both are reported rather than guessed. A guess here writes a version into `dependency_lines` that
 * the org never published.
 */
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
