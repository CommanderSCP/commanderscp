/**
 * `package.json` — `dependencies`, `devDependencies` and `optionalDependencies`.
 *
 * Direct only, which for npm is not merely a policy choice but a structural one: the transitive
 * closure lives in `package-lock.json`/`pnpm-lock.yaml`, and this package never opens those. That
 * is the same boundary from two directions — ADR-0032 §4 forbids storing the closure, and ADR-0032
 * §8 forbids the actuator from regenerating a lockfile at all ("Manifest-only edits. No lockfile
 * resolution."), because running a package manager is tooling execution and breaks gate 5. A parser
 * that read the lock to "enrich" the inventory would be the first step down exactly that path.
 *
 * Included and excluded, deliberately:
 * - `dependencies`         -> scope `runtime`
 * - `devDependencies`      -> scope `dev`
 * - `optionalDependencies` -> scope `runtime` (they ship; they are merely allowed to fail to
 *   install). `declaredIn` preserves which block it actually was, so nothing is lost by the mapping.
 * - `peerDependencies` are **excluded**: a peer dependency is a compatibility *assertion about the
 *   consumer's* tree, not something this component installs. Bumping a peer range on a subscription
 *   tick would silently narrow what downstreams may use.
 * - `bundledDependencies` / `bundleDependencies` are excluded: a name list with no versions, and
 *   every entry is already declared in one of the blocks above.
 *
 * Scoped names survive verbatim (`@acme/lib` stays `@acme/lib`) — see
 * {@link DeclaredDependency.coordinate} for why normalising here would re-create the URN collision
 * that ADR-0032 Context 2 measured.
 */
import { ManifestParseError, type DeclaredDependency, type DependencyScope } from "./types.js";
import { parseComparableVersion } from "./version.js";

/** The blocks we read, and the scope each maps to. Order fixes the order of the returned array. */
const BLOCKS: ReadonlyArray<{ field: string; scope: DependencyScope }> = [
  { field: "dependencies", scope: "runtime" },
  { field: "devDependencies", scope: "dev" },
  { field: "optionalDependencies", scope: "runtime" }
];

/**
 * npm specifiers that are not registry version ranges at all. Each names a location rather than a
 * version, so there is no line to subscribe to and nothing to compare — `unresolved`, never a guess.
 */
const NON_REGISTRY_PREFIXES = [
  "file:",
  "link:",
  "workspace:",
  "portal:",
  "git:",
  "git+",
  "github:",
  "gitlab:",
  "bitbucket:",
  "npm:", // an alias — `npm:other-pkg@^1.2.3`; the real coordinate is a different package
  "http://",
  "https://"
];

/**
 * A specifier naming exactly one version: `1.2.3`, `=1.2.3`, `v1.2.3`.
 *
 * Everything else with a comparator, a caret, a tilde, an `x`, a `||` or a space is a RANGE. The
 * distinction is recorded rather than flattened because `^1.2.3` and `1.2.3` are different
 * statements, and an actuator that rewrote one as the other would change the project's policy while
 * claiming to have bumped a version.
 */
const EXACT_RE = /^=?[vV]?\d+\.\d+\.\d+([-+].*)?$/;

/** `*`, `x`, `X`, `latest`, `""` — "any version", i.e. no constraint expressed. */
const UNPINNED_RE = /^(\*|[xX]|latest|)$/;

function classify(spec: string): {
  constraint: DeclaredDependency["constraint"];
  note?: string;
} {
  const trimmed = spec.trim();
  const prefix = NON_REGISTRY_PREFIXES.find((p) => trimmed.startsWith(p));
  if (prefix !== undefined) {
    return {
      constraint: "unresolved",
      note: `"${prefix}" specifier names a location, not a registry version line`
    };
  }
  if (UNPINNED_RE.test(trimmed)) return { constraint: "unpinned" };
  if (EXACT_RE.test(trimmed)) return { constraint: "pinned" };
  return { constraint: "range" };
}

/**
 * Parse a `package.json`'s direct dependencies.
 *
 * @param content the file's bytes decoded as UTF-8.
 * @throws {ManifestParseError} when the content is not JSON, or is JSON that is not an object. This
 *   is NOT collapsed into an empty result: "declares nothing" and "unreadable" produce identical
 *   inventory rows but mean opposite things, and the second silently wipes a component's dependency
 *   set on the next ingestion pass.
 */
export function parsePackageJson(content: string): DeclaredDependency[] {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new ManifestParseError("package.json is not valid JSON", err);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ManifestParseError("package.json did not decode to a JSON object");
  }

  const record = doc as Record<string, unknown>;
  const out: DeclaredDependency[] = [];

  for (const { field, scope } of BLOCKS) {
    const block = record[field];
    if (block === undefined || block === null) continue;
    if (typeof block !== "object" || Array.isArray(block)) {
      // A present-but-wrong-shaped block is a real defect in the manifest, not an empty block.
      throw new ManifestParseError(`package.json "${field}" is not an object`);
    }

    for (const [name, rawSpec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof rawSpec !== "string") {
        throw new ManifestParseError(
          `package.json "${field}"."${name}" is not a string version specifier`
        );
      }
      const spec = rawSpec.trim();
      const { constraint, note } = classify(spec);

      // Only a version-shaped specifier gets a comparable core, and it comes from the one shared
      // helper. `^1.2.3` yields 1.2.3 — the range's floor, which is what the manifest states today.
      const version =
        constraint === "unresolved" || constraint === "unpinned"
          ? undefined
          : parseComparableVersion(spec.replace(/^[\^~=><\s]+/, ""));

      out.push({
        ecosystem: "npm",
        // Verbatim. `@acme/lib` must stay `@acme/lib`.
        coordinate: name,
        ...(constraint === "unpinned" ? {} : { declared: spec }),
        constraint,
        scope,
        ...(version !== undefined ? { version } : {}),
        declaredIn: field,
        ...(note !== undefined ? { note } : {})
      });
    }
  }

  return out;
}
