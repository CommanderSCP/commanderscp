/**
 * The vocabulary every manifest parser in this package speaks.
 *
 * SCOPE OF THIS PACKAGE (ADR-0032 §4, "Direct declared dependencies only"):
 * these parsers return **what a component's own manifest declares, and nothing else**. They never
 * resolve, never fetch, never walk a lockfile, and never expand a transitive closure. That is not a
 * simplification we chose for convenience — ADR-0013 keeps SBOM bytes out of SCP deliberately, and
 * ADR-0032 §3's "nothing in the dependency path may expose a transitive traversal" is the boundary
 * that justifies the whole projection-table representation. A parser here that returned a
 * transitively-resolved set would silently dissolve that justification, so every parser is a pure
 * string -> declarations function with no I/O of any kind.
 *
 * The types below deliberately have no Zod counterpart in this package. Per CLAUDE.md, Zod schemas
 * live in `packages/schemas`; when these declarations become API-visible they get a schema there
 * that mirrors this file. Keeping the parsers dependency-free also keeps them trivially usable from
 * a runner image (charter principle 5 — everything must work offline, so this package pulls in no
 * third-party TOML or XML library and hand-rolls the small subsets it needs).
 */

/**
 * The five ecosystems ADR-0032 §10 puts in scope, built "Go -> images -> npm -> Python -> Maven".
 *
 * `oci` is a first-class member, not an afterthought: a `FROM alpine:1.0` that should become
 * `alpine:1.1` is the owner's headline example (proposal §6.3) and container images are the one
 * ecosystem with no air-gap gap, because the org's own registry is the index.
 *
 * MUST stay identical to `DependencyEcosystemSchema` in `@scp/schemas/dependencies` — that Zod enum
 * is what the API, the DB check constraint and the `(org, ecosystem, coordinate, major)` identity key
 * all validate against, so a value this package emits and that one rejects is a row that cannot be
 * written. This package deliberately does NOT import the schema (parsers stay dependency-free and
 * pure), which is precisely why the two drifted once already: the container ecosystem was built here
 * as `"image"` and there as `"oci"`, and nothing caught it because neither side's tests cross the
 * boundary. `ecosystem-vocabulary.test.ts` now pins the two lists equal.
 *
 * `oci`, NOT `image`: `image` is already a value of the executor `type` enum
 * (`packages/schemas/src/executors.ts:32`), where it means "a build that PRODUCES an image artifact".
 * This axis is what a component CONSUMES. Reusing one word across a produces/consumes boundary is the
 * same collision class as bare `subscription` and bare `manifest`, both settled in GLOSSARY.md.
 * (`npm` unavoidably appears in both enums with different senses — see the glossary note.)
 */
export type DependencyEcosystem = "npm" | "go" | "maven" | "python" | "oci";

/**
 * Why the component depends on this thing. Only recorded where the manifest FORMAT expresses it —
 * we never infer a scope from a package's name, which is the ADR-0030 §2 / provenance-label lesson
 * ("declared, never inferred"): a label named after what happened to match goes false the moment a
 * second kind of thing matches it.
 *
 * - `runtime` — shipped with, and needed by, the running component.
 * - `dev`     — needed only to develop/test it (npm `devDependencies`, Maven `test`, PEP 735 groups).
 * - `build`   — needed to produce the artifact but not shipped inside it (a Dockerfile `FROM`,
 *               `[build-system].requires`, Maven `provided`/`system`).
 *
 * Formats that express no distinction at all (go.mod, requirements.txt) report `runtime` — see the
 * per-parser doc comments, each of which says so explicitly rather than leaving it implied.
 */
export type DependencyScope = "runtime" | "dev" | "build";

/**
 * How precisely the manifest pins the dependency. This is the "declared vs pinned differ, record
 * which it was" distinction: `requests>=2.0` and `requests==2.31.0` are not the same statement, and
 * a subscription actuator that treated them alike would rewrite a range as a pin.
 *
 * - `pinned`     — exactly one version is named (`==2.31.0`, `v1.2.3` in go.mod, `alpine:3.19`).
 * - `range`      — a set of acceptable versions (`^1.2.3`, `>=2.0,<3`, `[1.0,2.0)`).
 * - `unpinned`   — the dependency is declared with no version constraint whatsoever
 *                  (`FROM alpine`, a bare `requests` line, npm `"*"`). NOTE this is NOT recorded as
 *                  "latest": Docker's implicit `:latest` and npm's `*` are RESOLUTION rules, and
 *                  writing them into `declared` would be inventing text the author never wrote.
 * - `unresolved` — a version is expressed but this package cannot know it without doing work it is
 *                  forbidden to do: a Maven `${property}` or parent-POM inheritance, a Dockerfile
 *                  `ARG` interpolation, a `git+https://`/`workspace:` npm specifier. Reported as
 *                  unresolved rather than guessed — a wrong version here becomes a wrong bump.
 */
export type VersionConstraintKind = "pinned" | "range" | "unpinned" | "unresolved";

/**
 * A numeric version core extracted from a version string, plus enough context that a caller can
 * refuse to compare two things that are not comparable. Produced only by
 * {@link import("./version.js").parseComparableVersion} — never assembled by a parser by hand.
 */
export interface ComparableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /**
   * How many numeric components the string ACTUALLY carried: 1 for `3`, 2 for `1.2`, 3 for `1.2.3`.
   *
   * `minor`/`patch` are zero-filled so the triple is always comparable, but zero-filling is an
   * assumption and `precision` is the receipt for it. An image tag `1.2` is a MOVING tag that today
   * points at 1.2.7; treating it as the frozen point 1.2.0 without knowing you did so is how a
   * subscription "bumps" a component backwards.
   */
  readonly precision: 1 | 2 | 3;
  /**
   * Everything after the numeric core, verbatim and WITHOUT interpretation — `-alpine` from
   * `1.2.3-alpine`, `-rc.1` from `1.2.3-rc.1`, `+build.5`.
   *
   * Deliberately NOT called `prerelease`, and deliberately not given semver precedence semantics:
   * in an OCI tag `-alpine` is a VARIANT (a different flavour of the same release), while semver
   * says `1.2.3-alpine` sorts BEFORE `1.2.3`. Applying semver precedence to image tags would order
   * a variant line wrongly, so ordering across differing suffixes is refused outright — see
   * {@link import("./version.js").compareVersions}.
   */
  readonly suffix?: string;
  /** The input string, so an audit trail can show what was parsed rather than what we made of it. */
  readonly raw: string;
}

/** One direct, declared dependency of a component. */
export interface DeclaredDependency {
  readonly ecosystem: DependencyEcosystem;
  /**
   * The dependency's coordinate in its ecosystem's OWN spelling, preserved verbatim — `@acme/lib`,
   * `github.com/Masterminds/semver/v3`, `org.springframework:spring-core`,
   * `ghcr.io/CommanderSCP/base`.
   *
   * Verbatim matters: ADR-0032 Context 2 measured that SCP's URN slug lowercases and hyphenates,
   * collapsing `@acme/lib`, `acme/lib` and `acme-lib` into one identity. That collapse is precisely
   * why the inventory is a projection table keyed on this string and not a graph object, so this
   * string is the identity and normalising it here would re-create the collision the design avoids.
   */
  readonly coordinate: string;
  /** The constraint text exactly as written (`^1.2.3`, `>=2.0,<3`, `3.19-alpine`), or undefined for `unpinned`. */
  readonly declared?: string;
  readonly constraint: VersionConstraintKind;
  readonly scope: DependencyScope;
  /**
   * The comparable numeric core of {@link declared}, or **undefined when it could not be parsed**.
   *
   * Undefined is a first-class, expected outcome (ADR-0032 §7: "unparseable tags are skipped rather
   * than guessed"). A caller MUST treat undefined as "cannot participate in a version comparison",
   * never as a reason to fall back to string ordering.
   */
  readonly version?: ComparableVersion;
  /** OCI digest (`sha256:...`) when the manifest pins one. Images only; tag is a label, digest is identity (proposal §6.3). */
  readonly digest?: string;
  /**
   * Which part of the manifest this came from, in the manifest's own words — `require`,
   * `devDependencies`, `FROM`, `project.optional-dependencies.test`, `build-system.requires`,
   * `dependencies` (Maven). Carried for explainability (charter principle 6): a Decision that
   * refuses a bump can say which block it read.
   */
  readonly declaredIn: string;
  /** 1-based line number in the source manifest, where the format is line-oriented. */
  readonly line?: number;
  /**
   * Set when the entry is understood but something about it is worth surfacing — an unresolvable
   * `ARG` interpolation, an inherited Maven version, a non-registry npm specifier. Human-readable,
   * never parsed.
   */
  readonly note?: string;
}

/**
 * Thrown when a manifest is not the format it claims to be at all (unparseable JSON, XML with no
 * `<project>`), as opposed to a manifest that legitimately declares nothing.
 *
 * These two MUST NOT collapse into the same empty array. "Zero dependencies" and "I could not read
 * this file" produce identical inventory rows but mean opposite things, and the second one silently
 * DELETES a component's whole dependency set on the next ingestion pass. This is the vacuous-test
 * hazard in production form: an assertion of absence that is satisfied for the wrong reason.
 */
export class ManifestParseError extends Error {
  constructor(message: string, cause?: unknown) {
    // `cause` goes through Error's own options bag rather than a parameter property: `Error.cause`
    // already exists on the base class (ES2022 lib), so re-declaring it as a field would shadow it.
    super(message, { cause });
    this.name = "ManifestParseError";
  }
}
