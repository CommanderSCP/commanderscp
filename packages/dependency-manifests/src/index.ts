/** The manifest parsers behind dependency inventory. See docs/dependency-manifests.md §23. */
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
/** The Kubernetes/Helm image reader. See docs/dependency-manifests.md §24. */
export { parseKubernetesImages } from "./kubernetes-images.js";
export { parsePackageJson } from "./package-json.js";
export { parsePyprojectToml, parseRequirementsTxt, parsePep508 } from "./python.js";
export { parsePomXml } from "./pom-xml.js";

/** The PRODUCER-side question. See docs/dependency-manifests.md §25. */
export { readDeclaredProjectVersion } from "./own-version.js";
export type { ProjectVersionEcosystem, ProjectVersionOutcome } from "./own-version.js";
