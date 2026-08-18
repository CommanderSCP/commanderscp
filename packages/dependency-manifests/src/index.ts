/**
 * `@scp/dependency-manifests` — the manifest parsers behind ADR-0032's dependency inventory: the
 * five language/image manifests, plus the Kubernetes/Helm image reader M21.7 added.
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
 * - Charter principle 5 — **air-gap first-class.** The TOML and XML subsets are hand-rolled
 *   (`toml-lite.ts`/`pom-xml.ts`); the ONE third-party dependency is `yaml`, taken deliberately in
 *   M21.7 and recorded as a spent property in `types.ts` — it was already in the lockfile with no
 *   transitive dependencies of its own, so the offline install set did not grow by a package.
 *
 * These parsers also mint no graph edges of any kind, which is ADR-0032 §5 holding by construction:
 * package dependencies must never become `depends_on`, because that relationship type is the wave
 * plan's toposort input and package graphs contain cycles.
 *
 * ## CALLER CONTRACT: THESE PARSERS THROW. AN INGESTION CALLER MUST CATCH.
 *
 * Every parser below except {@link parseRequirementsTxt} throws {@link ManifestParseError} when it
 * is handed content that is not the format at all — **including the empty string**:
 *
 * | export                  | throws on                                                        |
 * |-------------------------|------------------------------------------------------------------|
 * | `parsePackageJson`      | not JSON; JSON that is not an object; a wrong-shaped deps block   |
 * | `parseGoMod`            | no go.mod directive (`module`/`go`/`require`/…) anywhere          |
 * | `parseDockerfile`       | no `FROM` instruction                                             |
 * | `parsePyprojectToml`    | no TOML entries at all                                            |
 * | `parsePomXml`           | malformed XML; no `<project>` root                                |
 * | `parseKubernetesImages` | invalid YAML; NO MAPPING at any document root (a 404 body IS YAML) |
 * | `parseRequirementsTxt`  | **never throws** — the format has no required construct to miss   |
 *
 * This is deliberate and is the reason the package exists in this shape: "this component declares
 * zero dependencies" and "I could not read this file" produce identical inventory rows and mean
 * opposite things, and letting the second collapse into the first DELETES the component's whole
 * inventory on the next ingestion pass. See {@link ManifestParseError}.
 *
 * The consequence for the caller is the part that is easy to get wrong. A manifest fetch does not
 * only return a manifest: a 404 HTML body, an unexpanded Git-LFS pointer, a truncated response and a
 * path that no longer exists all arrive as *strings*, and every one of them lands on a `throw` here.
 * A caller that does not wrap each per-manifest parse in its own try/catch turns one bad fetch into
 * an unhandled rejection that aborts the whole ingestion run — strictly worse than the silent-empty
 * behaviour this contract was designed to avoid. The intended handling is per-manifest: catch,
 * record the manifest as unreadable, leave that component's existing inventory ALONE (do not write
 * an empty set), and continue to the next manifest.
 *
 * Pinned by `parse-contract.test.ts`, which asserts this table against the real exports.
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
export { parseDockerfile, splitImageRef } from "./dockerfile.js";
/**
 * The Kubernetes/Helm image reader (M21.7). Same `oci` ecosystem as `parseDockerfile` — an image
 * pinned in a chart's `values.yaml` is the same dependency line as the same image pinned in a
 * `FROM`, read out of a different file. See `docs/proposals/kubernetes-image-references.md`.
 */
export { parseKubernetesImages } from "./kubernetes-images.js";
export { parsePackageJson } from "./package-json.js";
export { parsePyprojectToml, parseRequirementsTxt, parsePep508 } from "./python.js";
export { parsePomXml } from "./pom-xml.js";

/**
 * The PRODUCER-side question — "what version does this manifest declare for ITSELF?" — which every
 * export above answers the consumer-side of. Added for M21.4's internal-release detection, where a
 * language ecosystem's released version has no other honest signal (`changes.source_ref` carries no
 * version and `observed.images` is the `oci` signal). Its three-way outcome
 * (`declared`/`absent`/`unresolved`) is deliberate: see own-version.ts.
 */
export { readDeclaredProjectVersion } from "./own-version.js";
export type { ProjectVersionEcosystem, ProjectVersionOutcome } from "./own-version.js";
