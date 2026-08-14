/**
 * `@scp/dependency-manifests` — the five manifest parsers behind ADR-0032's dependency inventory.
 *
 * Every export here is a **pure function of a string**. No file system, no network, no registry, no
 * package manager, no lockfile. That is a deliberate architectural property, not an accident of
 * scope:
 *
 * - ADR-0032 §4 — **direct declared dependencies only.** A parser that could reach out would be one
 *   step from resolving a closure, which ADR-0013 keeps out of SCP as SBOM bytes.
 * - ADR-0032 §3 — **nothing may expose a transitive traversal.** That boundary is what justifies the
 *   projection-table representation of the inventory; these functions structurally cannot breach it.
 * - ADR-0032 §8 — **manifest-only edits, no lockfile resolution.** Invoking a package manager is
 *   tooling execution and fails gate 5 of ADR-0002's six-gate test. Nothing here can invoke one.
 * - Charter principle 5 — **air-gap first-class.** Zero third-party dependencies (the TOML and XML
 *   subsets are hand-rolled in `toml-lite.ts`/`pom-xml.ts`), so this package runs anywhere.
 *
 * These parsers also mint no graph edges of any kind, which is ADR-0032 §5 holding by construction:
 * package dependencies must never become `depends_on`, because that relationship type is the wave
 * plan's toposort input and package graphs contain cycles.
 */
export type {
  ComparableVersion,
  DeclaredDependency,
  DependencyEcosystem,
  DependencyScope,
  VersionConstraintKind
} from "./types.js";
export { ManifestParseError } from "./types.js";

export { compareVersions, parseComparableVersion, parseImageTagVersion } from "./version.js";

export { parseGoMod } from "./go-mod.js";
export { parseDockerfile } from "./dockerfile.js";
export { parsePackageJson } from "./package-json.js";
export { parsePyprojectToml, parseRequirementsTxt, parsePep508 } from "./python.js";
export { parsePomXml } from "./pom-xml.js";
