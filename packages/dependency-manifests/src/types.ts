/** The vocabulary every manifest parser here speaks. See docs/dependency-manifests.md §83. */

/** The five ecosystems in scope, `oci` among them. See docs/dependency-manifests.md §84. */
export type DependencyEcosystem = "npm" | "go" | "maven" | "python" | "oci";

/** Why the component depends on this thing. See docs/dependency-manifests.md §85. */
export type DependencyScope = "runtime" | "dev" | "build";

/** How precisely the manifest pins the dependency. See docs/dependency-manifests.md §86. */
export type VersionConstraintKind = "pinned" | "range" | "unpinned" | "unresolved";

/** A numeric version core, plus comparison context. See docs/dependency-manifests.md §87. */
export interface ComparableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** How many numeric components the string carried. See docs/dependency-manifests.md §88. */
  readonly precision: 1 | 2 | 3;
  /** Everything after the numeric core, uninterpreted. See docs/dependency-manifests.md §89. */
  readonly suffix?: string;
  /** The input string, so an audit trail can show what was parsed rather than what we made of it. */
  readonly raw: string;
}

export interface DeclaredDependency {
  readonly ecosystem: DependencyEcosystem;
  /** The coordinate in its ecosystem's own spelling. See docs/dependency-manifests.md §90. */
  readonly coordinate: string;
  /** The constraint text exactly as written (`^1.2.3`, `>=2.0,<3`, `3.19-alpine`), or undefined for `unpinned`. */
  readonly declared?: string;
  readonly constraint: VersionConstraintKind;
  readonly scope: DependencyScope;
  /** The comparable core, or undefined when unparsed. See docs/dependency-manifests.md §91. */
  readonly version?: ComparableVersion;
  /** OCI digest (`sha256:...`) when the manifest pins one. Images only; tag is a label, digest is identity (proposal §6.3). */
  readonly digest?: string;
  /** Which part of the manifest this came from. See docs/dependency-manifests.md §92. */
  readonly declaredIn: string;
  /** 1-based line number in the source manifest, where the format is line-oriented. */
  readonly line?: number;
  /** How many declaration sites fed this entry. See docs/dependency-manifests.md §93. */
  readonly occurrences?: number;
  /** Set when understood but still worth surfacing. See docs/dependency-manifests.md §94. */
  readonly note?: string;
}

/** Thrown when a manifest is not the format it claims. See docs/dependency-manifests.md §95. */
export class ManifestParseError extends Error {
  constructor(message: string, cause?: unknown) {
    // `cause` goes through Error's own options bag rather than a parameter property: `Error.cause`
    // already exists on the base class (ES2022 lib), so re-declaring it as a field would shadow it.
    super(message, { cause });
    this.name = "ManifestParseError";
  }
}
