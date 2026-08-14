import { z } from "zod";

/**
 * M21.2 — the DEPENDENCY INVENTORY contract (ADR-0032 §3/§4/§5/§7).
 *
 * The inventory is what a component's own dependency manifests DECLARE: `dependency_lines` (the
 * identity of one MAJOR LINE of one dependency) and `component_dependencies` (which component
 * declares which line, at which version, from which manifest). Storage rationale — the four
 * measurements behind the scoped bend of charter principle 2 — lives in
 * `apps/server/drizzle/0060_dependency_inventory.sql`'s header; this file is the typed contract.
 *
 * Three invariants ride on these shapes and are stated here because a later reader of the types
 * alone would not see them:
 *
 *  1. DIRECT DECLARED DEPENDENCIES ONLY (§4). No shape here can express a transitive closure, and
 *     none may grow one: a stored closure is an SBOM by another name, and ADR-0013 keeps SBOM bytes
 *     out of SCP deliberately (`supply-chain.ts` stores an `SbomRef`, never the document).
 *  2. NOTHING HERE EXPOSES A TRANSITIVE TRAVERSAL (§3). There is deliberately no "dependencies of
 *     my dependencies" shape. That boundary is what makes the table representation sufficient;
 *     without it the graph representation becomes necessary again and the measured `impact-of`
 *     recursive-CTE hazard (7+ minutes, then disk exhaustion, against a 5s `statement_timeout`)
 *     applies to this path too.
 *  3. NO `depends_on` EDGE IS MINTED (§5). There is no relationship in this contract at all —
 *     `depends_on` is the wave-plan toposort input and package graphs routinely contain cycles.
 *
 * Vocabulary (docs/GLOSSARY.md, ADR-0032 §2): a **dependency subscription** is always spelled in
 * full — bare "subscription" belongs to `notification_bindings`. The subscription itself is a graph
 * object (it must federate, ADR-0022 clause 2) and is NOT in this file; this file is the inventory
 * it is written against.
 */

/**
 * The five ecosystems of M21 (ADR-0032 §10), in the owner's build order Go -> images -> npm ->
 * Python -> Maven.
 *
 * `oci` — container base images — is a first-class member, not an afterthought: a `Dockerfile`'s
 * `FROM alpine:1.0` is a declared direct dependency in exactly the sense this feature means, and it
 * is the one ecosystem needing no operator-loaded air-gap feed (the org's own registry IS the
 * index). It is also the one with a version grammar that is not semver — see `tagPattern` below.
 *
 * THE DATABASE COLUMN IS PLAIN `text` WITH NO pg ENUM AND NO CHECK, matching `source_mappings.type`
 * and `scanner_assignments.executor_type`: this enum is the only enforcement point, so a sixth
 * ecosystem is an edit to this file rather than a migration.
 */
export const DependencyEcosystemSchema = z.enum(["npm", "go", "maven", "python", "oci"]);
export type DependencyEcosystem = z.infer<typeof DependencyEcosystemSchema>;

/**
 * The ECOSYSTEM-NATIVE coordinate, carried VERBATIM — case preserved, punctuation preserved, never
 * slugified and never round-tripped through `deriveUrn`.
 *
 * This is the single most load-bearing decision in the inventory's shape (ADR-0032 §3, Context 2).
 * `graph/urn.ts`'s `slugify` lowercases and hyphenate-collapses every non-alphanumeric run, so
 * `@acme/lib`, `acme/lib` and `acme-lib` ALL become the URN `urn:scp:{org}:{type}:acme-lib` — one
 * identity for three different packages, colliding as a 409 with no auto-suffix and no
 * upsert-by-coordinate. Storing the raw string and keying on `(org, ecosystem, coordinate, major)`
 * is what keeps them three.
 *
 *   npm     `@acme/lib`                    (scoped) or `lib`
 *   go      `github.com/acme/lib`          module path; case-sensitive by spec
 *   maven   `com.acme:lib`                 groupId:artifactId
 *   python  `acme-lib`                     the distribution name as written
 *   oci     `docker.io/library/alpine`     registry-qualified repository
 *
 * No normalisation is applied on the way in. Two spellings the ecosystem itself considers equal
 * (PyPI's `Acme_Lib` vs `acme-lib`) are two rows here; that is the conservative direction — it
 * over-counts lines rather than silently merging two packages into one subscription target.
 */
export const DependencyCoordinateSchema = z.string().min(1).max(512);

/**
 * The major line, as the ECOSYSTEM spells it — a string, not a number. Go writes `v2`, an image
 * line is `3.18` as often as `3`, and Maven lines are not reliably numeric. Coercing to an integer
 * here would be the same lossy normalisation the URN scheme performs on the coordinate.
 */
export const DependencyMajorLineSchema = z.string().min(1).max(64);

/**
 * One MAJOR LINE of one dependency. Identity is `(orgId, ecosystem, coordinate, major)`.
 */
export const DependencyLineSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema,
  major: DependencyMajorLineSchema,
  /**
   * `oci` ONLY — the tag shape whose parsed version this line follows.
   *
   * Image tags are not semver: `1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps all coexist
   * in one repository, and a registry has no notion of a major line at all. So an image line needs
   * a tag pattern plus a parsed-version extractor, and a tag the extractor cannot parse is SKIPPED,
   * NEVER GUESSED (ADR-0032 §7) — falling back to string ordering would make `latest` sort above
   * `1.2.3` and bump a subscriber onto arbitrary bytes.
   *
   * NULL for the four language ecosystems, whose version grammar is the ecosystem's own.
   */
  tagPattern: z.string().nullable(),
  /**
   * The component/service this org DECLARES produces this line. `null` = third-party.
   *
   * DECLARED, NEVER INFERRED (ADR-0032 §7, ADR-0030 §2). Nothing reads a coordinate, a repo name or
   * a registry host and concludes "this one is ours". A label named after WHAT MATCHED goes false
   * the moment the matcher covers a second case — already shipped once in this repo, in a Decision
   * where it had been wrong since before the level that exposed it (charter principle 6). Discovery
   * may PROPOSE the link; an operator accepts it.
   *
   * The database pairs this with `producedByDeclaredAt` under a CHECK constraint, so a producer link
   * with no declaration behind it cannot be persisted at all.
   */
  producedByObjectId: z.string().uuid().nullable(),
  producedByDeclaredAt: z.string().nullable(),
  /** Which principal declared the producer link — principle 6: "who asserted this line is internal?"
   *  must be answerable. `null` when no producer is declared. */
  producedByDeclaredByObjectId: z.string().uuid().nullable(),
  /**
   * The head of the line as last OBSERVED (written by M21.4 detection, never by manifest ingestion —
   * a component declaring `1.2.0` says nothing about what the line's head is).
   *
   * `null` is "not yet observed", which is NOT "no newer version exists". Absent never means zero,
   * the same reading `ScanRequirementFloor`'s nullable ceilings established, and the same reading
   * the enablement chain uses for "absent never means enabled" (ADR-0032 §6).
   */
  latestVersion: z.string().nullable(),
  /** `oci` — the digest `latestVersion`'s tag resolved to when it was observed. A MUTABLE TAG IS NOT
   *  AN IDENTITY (ADR-0032 §7): the bytes are recorded next to the label so "the line is on 1.2.3"
   *  is a statement about content, not about a pointer someone can repoint. */
  latestDigest: z.string().nullable(),
  latestObservedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type DependencyLine = z.infer<typeof DependencyLineSchema>;

/** True iff the line has a DECLARED producer. The one place "internal" is decided — read from the
 *  declared link, never derived from `coordinate`. Kept as a function so no call site is tempted to
 *  re-derive it from a name (ADR-0032 §7). */
export function isInternalDependencyLine(
  line: Pick<DependencyLine, "producedByObjectId">
): boolean {
  return line.producedByObjectId !== null;
}

/**
 * One component's DECLARATION of one line, out of one dependency manifest.
 *
 * "Dependency manifest" is always qualified (docs/GLOSSARY.md): bare "manifest" in this codebase is
 * the commander-signed PROMOTION manifest, which authorizes a boundary crossing. A dependency
 * manifest authorizes nothing.
 */
export const ComponentDependencySchema = z.object({
  orgId: z.string().uuid(),
  /** The component's GRAPH OBJECT id — this row is a projection of an existing first-class object,
   *  not a new concept (DESIGN §4.1, charter principle 2). */
  componentObjectId: z.string().uuid(),
  lineId: z.string().uuid(),
  /** Repo-relative path of the dependency manifest (`package.json`, `go.mod`,
   *  `services/api/Dockerfile`). Part of the identity: one component can declare the same line from
   *  two manifests, and collapsing them would let a prune of one silently delete the other. */
  manifestPath: z.string().min(1).max(1024),
  /** What the manifest LITERALLY says — `^1.2.3`, `~=1.4`, `v1.2.3`, `3.18-alpine`. Verbatim,
   *  because this is the exact string the M21.5 actuator edits; a normalised copy would be an edit
   *  target that does not appear in the file. */
  declaredVersion: z.string().min(1).max(256),
  /** The concrete version parsed OUT of `declaredVersion`, or `null` when the declaration pins none.
   *  Derived from the MANIFEST ALONE: no lockfile is read and no package manager is run, which is
   *  ADR-0032 §8's manifest-only scope boundary (running one is tooling execution and trips the
   *  anti-CI corollary). `null` means "the manifest does not pin one", never "we did not look". */
  resolvedVersion: z.string().nullable(),
  /** `oci` — the digest this component's `FROM` currently resolves to. */
  resolvedDigest: z.string().nullable(),
  /** The git ref the manifest was read at (`refs/heads/main`), so a declaration is attributable to a
   *  point in the repo rather than to "whenever we last looked". */
  observedRef: z.string().nullable(),
  observedAt: z.string(),
  createdAt: z.string()
});
export type ComponentDependency = z.infer<typeof ComponentDependencySchema>;

/** What identifies a line for an upsert — the natural key, never a URN. */
export const DependencyLineKeySchema = z.object({
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema,
  major: DependencyMajorLineSchema
});
export type DependencyLineKey = z.infer<typeof DependencyLineKeySchema>;

/** Upsert input for a line. The DECLARED producer link is deliberately NOT settable here — see
 *  `DeclareLineProducerInputSchema`, which is a separate verb so an ingestion path cannot set it as
 *  a side effect of observing a manifest (ADR-0032 §7). */
export const UpsertDependencyLineInputSchema = DependencyLineKeySchema.extend({
  /** `oci` only; ignored (and stored as NULL) for the language ecosystems. */
  tagPattern: z.string().max(256).optional()
});
export type UpsertDependencyLineInput = z.infer<typeof UpsertDependencyLineInputSchema>;

/**
 * The separate, operator-driven verb that makes a line INTERNAL. Kept apart from
 * `UpsertDependencyLineInput` on purpose: if ingestion could pass a producer alongside a coordinate
 * it observed, "declared, never inferred" would survive only as long as every ingestion call site
 * remembered to leave it unset. Splitting the verb removes the capability instead of guarding it.
 */
export const DeclareLineProducerInputSchema = z.object({
  lineId: z.string().uuid(),
  /** The producing component/service graph object, or `null` to retract the declaration and return
   *  the line to third-party. */
  producedByObjectId: z.string().uuid().nullable(),
  /** The principal making the declaration (principle 6). */
  declaredByObjectId: z.string().uuid()
});
export type DeclareLineProducerInput = z.infer<typeof DeclareLineProducerInputSchema>;

/** Upsert input for one declaration read out of one dependency manifest. */
export const UpsertComponentDependencyInputSchema = z.object({
  componentObjectId: z.string().uuid(),
  lineId: z.string().uuid(),
  manifestPath: z.string().min(1).max(1024),
  declaredVersion: z.string().min(1).max(256),
  resolvedVersion: z.string().max(256).nullable().optional(),
  resolvedDigest: z.string().max(256).nullable().optional(),
  observedRef: z.string().max(512).nullable().optional()
});
export type UpsertComponentDependencyInput = z.infer<typeof UpsertComponentDependencyInputSchema>;

/** What M21.4 detection records when it observes a line's head. Separate from the line upsert for
 *  the same reason the producer declaration is: observing a manifest and observing a registry are
 *  different ingresses and must not be able to overwrite each other's fields. */
export const ObserveDependencyLineHeadInputSchema = z.object({
  lineId: z.string().uuid(),
  latestVersion: z.string().min(1).max(256),
  /** `oci` — the digest the observed tag resolved to. Required in spirit for images (a tag is not an
   *  identity); `null` for the language ecosystems, which have no digest. */
  latestDigest: z.string().max(256).nullable().optional()
});
export type ObserveDependencyLineHeadInput = z.infer<typeof ObserveDependencyLineHeadInputSchema>;
