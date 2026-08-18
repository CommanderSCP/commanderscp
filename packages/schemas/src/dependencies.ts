import { z } from "zod";

/**
 * M21.2 — the DEPENDENCY INVENTORY contract (ADR-0032 §3/§4/§5/§7).
 *
 * The inventory is what a component's own dependency manifests DECLARE: `dependency_lines` (the
 * identity of one MAJOR LINE of one dependency) and `component_dependencies` (which component
 * declares which line, at which version, from which manifest). Storage rationale — the four
 * measurements behind the scoped bend of charter principle 2 — lives in
 * `apps/server/drizzle/0061_dependency_inventory.sql`'s header; this file is the typed contract.
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
   * THE PRODUCER LINK IS NOT ON THIS ROW ANY MORE (ADR-0032 §7e, proposal §12.1).
   *
   * It used to be `producedByObjectId` + its two companions here, which made the declaration PER
   * MAJOR LINE. "Component X publishes `@acme/lib`" is a fact about the COORDINATE, true across
   * every major X ever cut, and the mismatch was not cosmetic: lines are minted only by a
   * CONSUMER's manifest, so every new major minted a fresh row with a NULL producer, honestly
   * third-party by default, and `buildLineWorkList` then handed the org's own coordinate to a
   * PUBLIC INDEX — ADR-0032 §7b clause 1's dependency-confusion catastrophe, re-armed silently at
   * each major bump. The declaration now lives in `dependency_line_producers`, keyed
   * `(orgId, ecosystem, coordinate)`, so a new major of a declared coordinate is internal FROM THE
   * INSTANT IT IS MINTED because there is no per-major field left to populate.
   *
   * DO NOT ADD IT BACK AS A CACHE. Stamping it at mint time from the declaration table closes the
   * same hole, but it puts a producer write back inside the ingestion verb and so deletes
   * "declared, never inferred" — the property this whole feature exists to protect. Read
   * {@link isInternalDependencyLine} with a `DependencyLineProducer | null` obtained by joining.
   */
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

/**
 * The DECLARATION that an org produces one COORDINATE — the row of `dependency_line_producers`
 * (ADR-0032 §7e, proposal §12.1). Identity is `(orgId, ecosystem, coordinate)`; the row's EXISTENCE
 * is the declaration, so a half-written one is unrepresentable rather than refused by a CHECK.
 *
 * It is a PROJECTION TABLE ROW AND NOT A GRAPH OBJECT, and that is a FEDERATION decision, not a
 * storage-convenience one (§12.4). A `produces` relationship or a `producedBy` policy effect would
 * federate, and a field outpost would then hold a declaration with no inventory behind it — a
 * visible assertion nothing can act on, the exact "true elsewhere, inert here" shape
 * `dependencyManagement` exists to close.
 */
export const DependencyLineProducerSchema = z.object({
  orgId: z.string().uuid(),
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema,
  /** The producing COMPONENT's graph object id. A `service` is refused in the first cut — see
   *  {@link DeclareDependencyLineProducerRequestSchema}. */
  producerObjectId: z.string().uuid(),
  declaredAt: z.string(),
  /** Which principal asserted this coordinate is ours — principle 6. Taken from the AUTHENTICATED
   *  SUBJECT at the route, never from the request body: a caller-supplied field here is a forgeable
   *  provenance label, which is the failure charter principle 6 already caught once in this repo. */
  declaredByObjectId: z.string().uuid()
});
export type DependencyLineProducer = z.infer<typeof DependencyLineProducerSchema>;

/** True iff the coordinate has a DECLARED producer. The one place "internal" is decided — read from
 *  the declared row, never derived from `coordinate`. Kept as a function so no call site is tempted
 *  to re-derive it from a name (ADR-0032 §7).
 *
 *  It takes the DECLARATION, not the line, since M22's regrain: internal-ness is a property of the
 *  coordinate and a line row carries no producer field at all. A caller that has only a line must
 *  join, which is what makes a brand-new major of a declared coordinate internal immediately. */
export function isInternalDependencyLine(declaration: DependencyLineProducer | null): boolean {
  return declaration !== null;
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
  /**
   * The REPOSITORY the manifest was read from, as the provider spells it — the half of the address
   * that `observedRef` alone never carried (a commit sha names no repository).
   *
   * It is what makes a prune attributable to the evidence that justifies it: an ingestion pass
   * reads ONE repo, and "this path is not there" is evidence about THAT repo only. `null` means the
   * repository was not recorded, and such a row is never pruned (drizzle/0063).
   */
  observedRepo: z.string().nullable(),
  /** The git ref the manifest was read at (`refs/heads/main`), so a declaration is attributable to a
   *  point in the repo rather than to "whenever we last looked". */
  observedRef: z.string().nullable(),
  /** When the manifest was READ, not when the row was written. The two differ whenever two passes
   *  overlap, and it is the read time that orders their evidence. */
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

/** Upsert input for one declaration read out of one dependency manifest. */
export const UpsertComponentDependencyInputSchema = z.object({
  componentObjectId: z.string().uuid(),
  lineId: z.string().uuid(),
  manifestPath: z.string().min(1).max(1024),
  declaredVersion: z.string().min(1).max(256),
  resolvedVersion: z.string().max(256).nullable().optional(),
  resolvedDigest: z.string().max(256).nullable().optional(),
  /** The repository this declaration was read from. Optional so a test fixture or a future ingress
   *  that genuinely has no repository can say so, and `null` then means exactly that — but a row
   *  written without it can never be pruned, because a prune needs evidence from the same
   *  repository. */
  observedRepo: z.string().max(512).nullable().optional(),
  observedRef: z.string().max(512).nullable().optional(),
  /** When the manifest was READ. Defaults to now; the ingestion passes its phase-2 read time so two
   *  overlapping passes are ordered by when they looked, not by when they landed. */
  observedAt: z.date().optional()
});
export type UpsertComponentDependencyInput = z.infer<typeof UpsertComponentDependencyInputSchema>;

// ===========================================================================================
// M21.3 — DEPENDENCY SUBSCRIPTIONS AND THEIR ENABLEMENT (ADR-0032 §3a, §6).
//
// A DEPENDENCY SUBSCRIPTION IS NOT AN OBJECT. It is a `dependencySubscription` EFFECT on an
// ordinary `policy` object (ADR-0032 §3a), validated by the policy document JSON Schema extended in
// `drizzle/0062_dependency_subscription_enablement.sql` and resolved by the existing
// `matchPoliciesForTargets` / `containmentChain` machinery. This mirrors `scanThreshold` (ADR-0016)
// in every structural respect, deliberately: `policy` is a built-in type on every instance and its
// upsert shares the importer's `object_upsert` case, so the subscription federates already, with no
// new type for a not-yet-migrated outpost to be missing.
//
// The shapes below are therefore the AUTHORING SURFACE and the EXPLAINED RESULT. The merge itself
// lives in `apps/server/src/dependencies/subscription-resolution.ts` — a pure function, so its
// properties are unit-testable with no database (BUILD_AND_TEST.md §4.1).
// ===========================================================================================

/**
 * How much of a line a subscriber accepts automatically.
 *
 * `patch` is the MORE RESTRICTIVE of the two, and the resolver's merge is most-restrictive-wins over
 * EVERY enabling contribution — INCLUDING THE SILENT ONES, which are read as `patch`. So a
 * contribution can only ever tighten what another contribution would have allowed, never loosen it,
 * and no scope can hand a looser granularity to a scope that did not ask for one. There is no
 * `major` member on purpose — a subscription is to a MAJOR LINE (ADR-0032's opening sentence), so
 * crossing majors is a different subscription, never a looser setting on this one.
 */
export const DependencySubscriptionGranularitySchema = z.enum(["patch", "minor_and_patch"]);
export type DependencySubscriptionGranularity = z.infer<
  typeof DependencySubscriptionGranularitySchema
>;

/**
 * How the M21.5 actuator delivers a bump (ADR-0032 §8, owner decision 2026-08-13).
 *
 * `pull_request` is the MORE RESTRICTIVE of the two and the merge treats it as such.
 *
 * AUTO-MERGE IS THE PRIVILEGED OPTION AND IS ACQUIRED UNANIMOUSLY. Every enabling contribution votes
 * — and A SILENT CONTRIBUTION VOTES `pull_request`, because it never asked for anything else. The
 * merge takes the MIN over those votes, so auto-merge is reached only when EVERY contribution that
 * enabled this pair declared it. A BROADER SCOPE THEREFORE MAY NOT GRANT AUTO-MERGE TO A NARROWER
 * ONE THAT STAYED SILENT: an org-wide `{"enabled": true, "delivery": "auto_merge"}` combined with a
 * component's own `{"enabled": true}` resolves to `pull_request`, because the component team never
 * asked for commits to land in their repo without a pull request. The cost is stated rather than
 * discovered: a team that DOES want auto-merge cannot get it while any other enabling policy is
 * silent — that policy must declare `auto_merge` too. That is the safe direction of the trade, and
 * it is the direction the owner's requirement points ("teams choose").
 *
 * ============================================================================================
 * `auto_merge` IS ACTUATED, AND NEVER ON A BUMP'S FIRST LOOK (M21.5, ADR-0032 §8c)
 * ============================================================================================
 * The charter grants automatic merge only where a governed control evidences the component's OWN
 * checks passed ON THE BUMP'S OWN COMMIT — which cannot be true when the bump is authored, because
 * the commit the control would have to have passed is the one that run is about to create. So the
 * FIRST dispatch of an `auto_merge` subscription always resolves to `pull_request`, whatever the
 * subscription asked for, and records why on the change: the option is visibly declined rather than
 * silently ignored.
 *
 * The SECOND look is what merges, and it exists (`apps/server/src/dependencies/bump-gate.ts`): when
 * an observed provider event correlates to a bump SCP authored — the authored push, then the CI
 * conclusion that names its commit — the EXISTING governance gate is run for that change, and the
 * delivery question is asked again against what it deposited. A grant additionally requires the
 * evidence to name the bump's own repository AND its own head commit, both read from SCP's own
 * server-owned record of what it authored, and the merge is then addressed to the pull request SCP
 * itself opened.
 *
 * "The bump merges on its second look, never on its first" is the property. `bump-actuator.ts`'s
 * `resolveEffectiveDelivery` states every narrowing and what each one closes.
 */
export const DependencySubscriptionDeliverySchema = z.enum(["pull_request", "auto_merge"]);
export type DependencySubscriptionDelivery = z.infer<typeof DependencySubscriptionDeliverySchema>;

/**
 * ONE `dependencySubscription` EFFECT — the authoring surface, one item of a policy document's
 * `effects[]`.
 *
 * SELECTORS: `ecosystem` / `coordinate` / `major`. A contribution MATCHES a (component, line) when
 * EVERY PRESENT selector equals the line's value; an ABSENT selector is a WILDCARD. That single
 * rule is what makes both halves of the intended authoring expressible without a second surface:
 *
 *     {"enabled": true}                                   subscribe this whole scope
 *     {"coordinate": "@acme/lib", "enabled": false}       …but never that one package
 *
 * `coordinate` is compared VERBATIM against `dependency_lines.coordinate` — byte-for-byte, case
 * preserved, never slugified and never round-tripped through `deriveUrn`. See
 * `DependencyCoordinateSchema` above for why: `@acme/lib`, `acme/lib` and `acme-lib` collapse to one
 * URN, and an opt-out that matched all three would silently un-subscribe two packages nobody named.
 *
 * `enabled` IS REQUIRED, not defaulted. ABSENT NEVER MEANS ENABLED (ADR-0032 §6), so an omitted
 * flag would have to read as `false` — at which point a typo in the key name produces an
 * opt-out-shaped effect that opts nothing out. The JSON Schema in 0062 requires it too, so the
 * mistake is a 400 at authoring time rather than a silent inert policy.
 *
 * `enabled: false` is an OPT-OUT, and an opt-out ALWAYS WINS over any number of enables at any tier
 * (§6: "the deepest level may only subtract"). A `granularity`/`delivery` alongside `enabled: false`
 * is therefore inert — the resolver reads those two only from contributions that actually enable.
 *
 * `strictObject`, AND THAT IS THE SELECTOR PROPERTY'S OTHER HALF. A plain `z.object` STRIPS an
 * unrecognised key, so `{"enabled": true, "coordinat": "@acme/lib"}` would parse cleanly into
 * `{enabled: true}` — an effect with NO selectors, which is a WILDCARD. One transposed character
 * would subscribe every dependency line in the scope instead of one npm package, and the same typo
 * on an opt-out would wildcard the DISABLE across every line. That is the identical property 0062's
 * header already argues for a bad ecosystem VALUE ("an unrecognised ecosystem on a SELECTOR silently
 * voids the selector, and a voided selector fails OPEN") — A SELECTOR THAT FAILS TO BIND MUST VOID
 * ITSELF, not the constraint. Stripping is exactly failing to bind, so it is refused here and,
 * independently, by `additionalProperties: false` on 0062's `dependencySubscription` block. Two
 * layers because they fail in different places: Ajv refuses the AUTHORING write, this refuses a
 * document that reached the resolver by any other route (federation, a direct DB write, a migration
 * that restated the policy document and dropped the constraint).
 */
export const DependencySubscriptionEffectSchema = z.strictObject({
  /** Absent = every ecosystem. */
  ecosystem: DependencyEcosystemSchema.optional(),
  /** Absent = every coordinate. Compared verbatim; see the class comment. */
  coordinate: DependencyCoordinateSchema.optional(),
  /** Absent = every major line. */
  major: DependencyMajorLineSchema.optional(),
  /** `true` subscribes, `false` OPTS OUT. Required — absent never means enabled. */
  enabled: z.boolean(),
  granularity: DependencySubscriptionGranularitySchema.optional(),
  delivery: DependencySubscriptionDeliverySchema.optional()
});
export type DependencySubscriptionEffect = z.infer<typeof DependencySubscriptionEffectSchema>;

/**
 * The tier a contribution came from — for EXPLAINABILITY ONLY (charter principle 6: a caller must
 * be able to answer "WHICH level turned this off?").
 *
 * NEVER FOR PRECEDENCE. There is no precedence in an AND, exactly as there is none in
 * `scan-requirements.ts`'s MIN, and for the same documented reason: `graph/containment.ts:60-73`
 * records that containment-domain-vs-service is NOT a strict ordering, so two ancestors of
 * different kinds can TIE. Override semantics would be undefined at that tie; a monotone AND has no
 * such failure mode.
 *
 * A tier label is derived from the contributing object's `typeId`, NEVER from its position in the
 * containment chain. `containmentChain` bounds its recursion at `depth < 10` and does not error at
 * the bound — it stops expanding and then recomputes depth over the rows it DID return, so the org
 * can arrive at a NONZERO depth while a top-level domain occupies index 0 (BUILD_AND_TEST.md's
 * M21.3 "a ceiling whose ROOT LABELS CAN LIE"). Index 0 is not the org.
 *
 * `instance` is the above-org tier and has no graph object at all — it is the
 * `dependency_subscription_unlock` singleton row.
 */
export const DependencySubscriptionTierSchema = z.enum([
  "instance",
  "org",
  "containment_domain",
  "service",
  "component"
]);
export type DependencySubscriptionTier = z.infer<typeof DependencySubscriptionTierSchema>;

/**
 * WHAT one contribution actually contributed to the AND.
 *
 *  - `unlock` / `lock` — the instance singleton. `unlock` PERMITS and never activates; `lock` is the
 *    answer to "which level turned this off" when the deployment never opened the feature at all.
 *  - `enable` / `disable` — a matching `dependencySubscription` effect. `disable` always wins.
 *  - `ignored` — a contribution that was FOUND on a matched policy and admitted to NEITHER side.
 *    It is recorded rather than dropped: a malformed or unevaluable opt-out that vanished silently
 *    would leave a line subscribed that an operator believed they had excluded, and principle 6
 *    requires that be visible in the result rather than only in a log.
 */
export const DependencySubscriptionContributedSchema = z.enum([
  "unlock",
  "lock",
  "enable",
  "disable",
  "ignored"
]);
export type DependencySubscriptionContributed = z.infer<
  typeof DependencySubscriptionContributedSchema
>;

/** Why a found contribution was admitted to neither side of the AND. */
export const DependencySubscriptionIgnoredReasonSchema = z.enum([
  /** The effect did not parse against `DependencySubscriptionEffectSchema`. */
  "malformed",
  /** The contributing policy carries a CEL `condition`, and enablement resolution has no change
   *  context to evaluate one against. An unevaluable condition may never ENABLE (absent never means
   *  enabled); it still DISABLES, because subtracting is the direction that cannot fail open — so
   *  this reason only ever appears on a would-be enable. */
  "condition_unevaluable"
]);
export type DependencySubscriptionIgnoredReason = z.infer<
  typeof DependencySubscriptionIgnoredReasonSchema
>;

/**
 * ONE level's contribution to the resolved enablement, carried so a Decision can answer WHICH level
 * turned this off (charter principle 6). Modelled on `ScanThresholdContribution`
 * (`supply-chain.ts`), including the verbatim `objectTypeId` that keeps the tier mapping auditable
 * instead of implicit.
 */
export const DependencySubscriptionContributionSchema = z.object({
  tier: DependencySubscriptionTierSchema,
  /** Human-legible origin: `instance:dependency_subscription_unlock`, `policy:<name>@<objectId>`. */
  source: z.string(),
  /** For policy contributions, the `object_types.id` of the graph object the policy matched at —
   *  recorded verbatim, since the tier label above is DERIVED from it. */
  objectTypeId: z.string().optional(),
  contributed: DependencySubscriptionContributedSchema,
  ignoredReason: DependencySubscriptionIgnoredReasonSchema.optional(),
  /** The selectors this contribution carried, echoed back so "why did this apply to THIS line?" is
   *  answerable from the result alone. Absent KEYS were wildcards.
   *
   *  PRESENT-AND-EMPTY (`{}`) IS THE ANSWER TO "wildcard by intent, or wildcard by accident?".
   *  Every contribution whose effect PARSED and MATCHED the line carries this key, so `{}` records
   *  "matched every line of this scope, and every selector was DELIBERATELY absent" — it is never
   *  the residue of a selector that failed to bind, because `DependencySubscriptionEffectSchema` is
   *  a `strictObject` and 0062 sets `additionalProperties: false`, so a mistyped selector key is
   *  refused rather than stripped into a wildcard. The key is omitted only where there are no
   *  selectors to report at all: the instance `unlock`/`lock`, which is not a policy effect, and a
   *  `malformed` contribution, which never parsed. */
  selector: z
    .object({
      ecosystem: DependencyEcosystemSchema.optional(),
      coordinate: DependencyCoordinateSchema.optional(),
      major: DependencyMajorLineSchema.optional()
    })
    .optional(),
  /** DECLARED values only — absent means this contribution declared nothing, and the merge reads
   *  that silence as the MOST RESTRICTIVE option (`patch` / `pull_request`) rather than as "no
   *  opinion". Recorded as authored so the explanation shows which contributions actually asked for
   *  something and which were carried at the default. */
  granularity: DependencySubscriptionGranularitySchema.optional(),
  delivery: DependencySubscriptionDeliverySchema.optional()
});
export type DependencySubscriptionContribution = z.infer<
  typeof DependencySubscriptionContributionSchema
>;

/**
 * WHY the resolution came out the way it did — a summary of the contributions below it, never a
 * substitute for them (every cause is in `contributions` regardless of which one this names).
 * Reported in a fixed order — `instance_locked` before `disabled` before `not_enabled` — so the
 * value is order-independent like the rest of the result.
 */
export const DependencySubscriptionReasonSchema = z.enum([
  "enabled",
  /** The deployment never unlocked the feature. */
  "instance_locked",
  /** A matching contribution opted out. A disable always wins. */
  "disabled",
  /** Nothing enabled it. THE DEFAULT — absent never means enabled, and an instance unlock alone
   *  lands here, which is what "unlocks and never activates" means concretely. */
  "not_enabled"
]);
export type DependencySubscriptionReason = z.infer<typeof DependencySubscriptionReasonSchema>;

/**
 * The resolved enablement of ONE (component, line) pair, with its full explanation.
 *
 * `granularity`/`delivery` are ALWAYS present and always the MOST RESTRICTIVE across the
 * contributions that actually enabled — `patch` / `pull_request` when none carried one. They are
 * meaningful only when `enabled` is true; they are reported unconditionally so the shape is total.
 */
export const DependencySubscriptionResolutionSchema = z.object({
  enabled: z.boolean(),
  reason: DependencySubscriptionReasonSchema,
  granularity: DependencySubscriptionGranularitySchema,
  delivery: DependencySubscriptionDeliverySchema,
  contributions: z.array(DependencySubscriptionContributionSchema)
});
export type DependencySubscriptionResolution = z.infer<
  typeof DependencySubscriptionResolutionSchema
>;

/** The most restrictive granularity — the value an enablement resolves to when no enabling
 *  contribution declares one. Absent is never read as the looser option. */
export const DEFAULT_DEPENDENCY_SUBSCRIPTION_GRANULARITY: DependencySubscriptionGranularity =
  "patch";

/** The most restrictive delivery. Auto-merge is never reached by omission (ADR-0032 §8). */
export const DEFAULT_DEPENDENCY_SUBSCRIPTION_DELIVERY: DependencySubscriptionDelivery =
  "pull_request";

// ===========================================================================================
// M21.3 — THE API SURFACE for the enablement chain (charter principle 3: API -> SDK -> CLI).
//
// TWO SURFACES, AND DELIBERATELY NO THIRD:
//
//  1. The INSTANCE UNLOCK — read + write of the `dependency_subscription_unlock` singleton. Read is
//     tenant-facing (a team whose subscription is inert because the DEPLOYMENT never opened the
//     feature must be able to see that — principle 6); write is operator-only, because the row binds
//     every org on the deployment.
//  2. The RESOLUTION of one (component, line) pair, WITH its contributions. This is the
//     explainability surface, and carrying `contributions` is the entire reason they exist: a caller
//     must be able to answer "WHICH level turned this off?" without reading the policy set itself.
//
// THERE IS NO SUBSCRIPTION-WRITE SHAPE HERE, ON PURPOSE. A dependency subscription IS a
// `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a), so it is authored,
// listed, versioned and federated through the EXISTING policy surface
// (`CreateObjectRequestSchema` / `scp policy register`). A bespoke create/update/delete shape here
// would be a second authoring path for one concept — it would need its own versioning, its own
// journal handling and its own scope semantics, and the two would drift. Do not add one.
// ===========================================================================================

/**
 * The instance unlock singleton as the API projects it — the FIRST conjunct of §6's AND, and
 * nothing more. `unlocked: true` means "components on this deployment MAY be subscribed", NEVER
 * "are subscribed": with no enabling policy anywhere it subscribes exactly zero components
 * (ADR-0006, "managed execution is never a default").
 *
 * `updatedAt` is `null` exactly when NO ROW EXISTS, which is the LOCKED default (absent never means
 * enabled). The pair `{unlocked: false, updatedAt: null}` therefore reads "never set", and
 * `{unlocked: false, updatedAt: <ts>}` reads "deliberately re-locked" — two different operator
 * situations that a bare boolean would flatten into one.
 */
export const DependencySubscriptionUnlockSchema = z.object({
  unlocked: z.boolean(),
  note: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The same `source` label the `instance` tier carries in a resolution's `contributions`, so
   *  "which level turned this off" points at a row an operator can actually go and change. */
  source: z.string()
});
export type DependencySubscriptionUnlock = z.infer<typeof DependencySubscriptionUnlockSchema>;

/**
 * The operator write body. `unlocked` is REQUIRED for the same reason the effect's `enabled` is:
 * absent never means enabled, so an omitted flag would have to be read as `false` — and a PUT that
 * silently LOCKED a deployment because a field name was misspelled is the same failure in the other
 * direction. Requiring it makes both mistakes a 400.
 */
export const PutDependencySubscriptionUnlockRequestSchema = z.object({
  unlocked: z.boolean(),
  note: z.string().max(500).nullish()
});
export type PutDependencySubscriptionUnlockRequest = z.infer<
  typeof PutDependencySubscriptionUnlockRequestSchema
>;

/**
 * WHICH DEPLOYMENT SHAPE ANSWERED, in the vocabulary of `SCP_FEDERATION_ROLE` — plus the one value
 * that is NOT a role.
 *
 * `role_undeclared` IS ITS OWN VALUE AND IS NEVER FOLDED INTO `commander`. That is the whole point
 * of carrying a reason rather than a bare boolean. `config.federationRole` DEFAULTS to `commander`
 * when `SCP_FEDERATION_ROLE` is unset, so an outpost that predates the setting, or a chart that
 * omits it, reads as a commander on the value alone — and dependency automation FAILS CLOSED there
 * (ADR-0032 §7d, `apps/server/src/dependencies/commander-only.ts`). A reader handed `commander` for
 * that deployment would be told the opposite of the truth: it looks like the place work happens, and
 * it is precisely the place nothing will run. It is a distinct value so the remedy is distinct too —
 * an outpost's operator calls the commander, an undeclared deployment's operator sets one env var.
 */
export const DependencyManagementReasonSchema = z.enum([
  /** An EXPLICITLY declared commander. The one shape that manages dependencies. */
  "commander",
  /** A declared outpost. It RECEIVES bumps down the global pipeline; it never originates one. */
  "outpost",
  /** A declared retrans (CDS-boundary relay). It originates nothing either. */
  "retrans",
  /** `SCP_FEDERATION_ROLE` was never set, so nobody has said what this deployment is. Fail-closed. */
  "role_undeclared"
]);
export type DependencyManagementReason = z.infer<typeof DependencyManagementReasonSchema>;

/**
 * DOES DEPENDENCY MANAGEMENT ACTUALLY HAPPEN ON THE DEPLOYMENT THAT ANSWERED THIS REQUEST?
 *
 * ============================================================================================
 * WHEN `managedHere` IS FALSE, THE REST OF THE ENVELOPE IS NOT TO BE INTERPRETED
 * ============================================================================================
 * All dependency automation is COMMANDER-ONLY (ADR-0032 §7d): a FIELD outpost runs no dependency job
 * and holds no dependency inventory, because the point of the feature is to pull from PUBLIC
 * repositories and the resulting change is pushed down the global pipeline the commander manages.
 * ("Field" is load-bearing, not decoration: an HQ outpost is the outpost in the COMMANDER'S OWN
 * trust domain, so its inventory simply IS the commander's. Nothing on this wire can be one, which
 * is why the values below need no fourth member — a `reason` of `outpost` means the answering
 * deployment DECLARED `SCP_FEDERATION_ROLE=outpost`, and that is a field outpost by construction.
 * `apps/server/src/dependencies/commander-only.ts` reads the distinction out of the code.)
 * So on any deployment where `managedHere` is false:
 *
 *   - inventory-shaped answers are STRUCTURALLY EMPTY — not "this component declares nothing", but
 *     "nothing here ever ingested a dependency manifest, and nothing ever will";
 *   - a RESOLVE verdict is still computed, and it is still arithmetically correct FOR THIS
 *     DEPLOYMENT: the policy tiers it merges federated down from the commander. But NOTHING ON THIS
 *     DEPLOYMENT WILL ACT ON IT. An `enabled: true` here does not mean a bump will be authored here;
 *     it means a bump would be authored on the commander, for a subscription that also resolves
 *     there. Nor is it a prediction of the commander's answer: the INSTANCE UNLOCK conjunct is a
 *     local singleton row that does NOT federate, so `enabled: false, reason: instance_locked` here
 *     says this deployment is locked and says nothing about whether the commander is. Ask the
 *     commander — which is what a `managedHere: false` is telling a caller to do.
 *
 * That gap is the reason this envelope is REQUIRED rather than advisory. Answering `enabled` where
 * nothing acts on it is charter principle 6 FAILING — an answer whose reason is unavailable — and
 * the honest sentence is not "enabled"/"disabled" but "enabled, and not managed here, because this
 * deployment is an outpost". `reason` is what lets a caller write that sentence without a second
 * round trip and without inferring a posture from a hostname.
 *
 * `managedHere` is the FEDERATION axis only, deliberately, and so it is a fact about the DEPLOYMENT
 * rather than about the process that served the request. In the split topology every HTTP request
 * lands on an `SCP_ROLE=api` process while the jobs drain on a `worker`; a `managedHere` that also
 * read the process axis would tell every caller of a perfectly correct commander that dependencies
 * are not managed there. See `commanderOnlyFederationVerdict` for that argument in full.
 */
export const DependencyManagementSchema = z.object({
  /** True iff dependency automation RUNS on this deployment — i.e. it is an explicitly declared
   *  commander. False means no job here will ever act on the answer beside it. */
  managedHere: z.boolean(),
  /** WHY. Always `commander` exactly when `managedHere` is true; one of the three refusals
   *  otherwise, each with a different remedy. */
  reason: DependencyManagementReasonSchema
});
export type DependencyManagement = z.infer<typeof DependencyManagementSchema>;

/**
 * The answer to "is THIS component subscribed to THIS line, and why?" — the resolution plus the
 * inputs it was computed for, so the response stands alone in a log or a Decision.
 *
 * The line is ECHOED rather than assumed from the request because the coordinate is compared
 * VERBATIM (`DependencySubscriptionEffectSchema`): seeing exactly which bytes were resolved is how
 * an operator discovers that their opt-out named `acme-lib` while the manifest declares
 * `@acme/lib`.
 *
 * IT ANSWERS ENABLEMENT, NOT DECLARATION. Any well-formed line key resolves, whether or not the
 * component declares it — which is what makes the surface useful BEFORE a dependency is added, and
 * is why it never 404s on an undeclared line. What a component declares is the inventory's
 * question (ADR-0032 §4), not this one.
 */
export const DependencySubscriptionResolutionResponseSchema = z.object({
  componentObjectId: z.string().uuid(),
  line: DependencyLineKeySchema,
  resolution: DependencySubscriptionResolutionSchema,
  /**
   * WHETHER ANYTHING HERE WILL EVER ACT ON `resolution`. REQUIRED, because a caller that could
   * receive the verdict without it is exactly the caller this closes the hole for: the answer alone
   * is unqualified, and on an outpost it is unqualified in the direction that reads as "yes, this is
   * running". Adding a required response property to this operation was measured against the
   * vendored oasdiff at the merge base and is not an ERR (nothing existing is removed and no
   * required property became optional) — the same shape `/components/{idOrUrn}/pipeline` already
   * carries. See {@link DependencyManagementSchema} for what a `false` does and does not mean.
   */
  dependencyManagement: DependencyManagementSchema
});
export type DependencySubscriptionResolutionResponse = z.infer<
  typeof DependencySubscriptionResolutionResponseSchema
>;

/** What M21.4 detection records when it observes a line's head. Separate from the line upsert for
 *  the same reason the producer declaration is: observing a manifest and observing a registry are
 *  different ingresses and must not be able to overwrite each other's fields. */
export const ObserveDependencyLineHeadInputSchema = z.object({
  lineId: z.string().uuid(),
  latestVersion: z.string().min(1).max(256),
  /**
   * The digest OF `latestVersion`, resolved in the SAME observation — `null` when it could not be
   * (a language ecosystem has none, an operator-loaded air-gap feed carries none, a registry
   * inspect can fail).
   *
   * REQUIRED, NOT OPTIONAL, and that is a defect fix rather than a style preference. While this key
   * was optional a writer could move `latestVersion` and simply omit the digest, leaving the
   * PREVIOUS version's digest standing beside the new tag — a (tag, digest) pair that never existed
   * in any registry, in a column pair whose entire purpose is that "a mutable tag is not an
   * identity" (ADR-0032 §7). The omission is now unrepresentable: the pair moves together or not at
   * all. The whole meaning of the trio lives in `apps/server/src/dependencies/line-head.ts`.
   */
  latestDigest: z.string().max(256).nullable()
});
export type ObserveDependencyLineHeadInput = z.infer<typeof ObserveDependencyLineHeadInputSchema>;

// ===========================================================================================
// M21.2 — THE INVENTORY BACKFILL (ADR-0032 §4).
//
// Ingestion is event-driven: a correlated, accepted change re-reads its component's dependency
// manifests. That covers every component that releases from now on and NO component that does not —
// so on an existing estate the inventory would stay empty until each team happened to commit, and a
// component that never pushes again would never acquire one at all.
//
// The precedent is `POST /discovery/backfill-source-mappings`, which exists for exactly this class
// of problem ("create rows onto already-imported components"): operator-triggered, idempotent, and
// it reports every skip rather than only a count.
// ===========================================================================================

export const BackfillDependencyInventoryRequestSchema = z.object({
  /** Narrow the run to specific components (id or URN). OMITTED means every component in the org —
   *  which is the point of a backfill, and which the ENABLEMENT GATE keeps cheap: a component with
   *  no enabling subscription is refused before any repo is read. */
  componentIdsOrUrns: z.array(z.string().min(1)).max(500).optional(),
  /** The ref to read at. Defaults to `HEAD`, i.e. the repo's own default branch, because a backfill
   *  has no release to read a commit from — unlike the event-driven path, which reads at the commit
   *  the accepted change carried. The resolved commit is still what lands on each row. */
  ref: z.string().min(1).max(512).optional(),
  /**
   * How many components this request may actually FETCH for, before it stops and reports the rest
   * as unattempted. Defaults to {@link DEFAULT_DEPENDENCY_INVENTORY_BACKFILL_FETCH_BUDGET}.
   *
   * A BOUND IS REQUIRED, not a nicety. With no `componentIdsOrUrns` the run walks every component
   * in the org INLINE IN ONE REQUEST, and each enabled one makes up to 40 live git-provider reads.
   * On a four-hundred-component estate that is a single HTTP request holding tens of thousands of
   * round trips against a user's provider and its rate limit, with a client that will have timed
   * out long before. The bound counts only components that were actually fetched for: an
   * unsubscribed component costs no read (the gate refuses before the repo is touched), so it does
   * not consume budget and a whole-org run still reports every component's enablement.
   */
  fetchBudget: z.number().int().min(1).max(500).optional()
});
export type BackfillDependencyInventoryRequest = z.infer<
  typeof BackfillDependencyInventoryRequestSchema
>;

/** What happened for ONE component. `not_enabled` is the common, cheap outcome and is REPORTED
 *  rather than filtered out: "these 400 components were skipped, and why" is the answer an operator
 *  running a backfill actually needs (the same reason the source-mapping backfill reports skips). */
export const DependencyInventoryBackfillComponentSchema = z.object({
  componentObjectId: z.string().uuid(),
  name: z.string(),
  /** `not_attempted` is this route's own verdict, not the ingestion's: the fetch budget was spent
   *  before this component was reached, so nothing was read and nothing was written. */
  verdict: z.enum(["not_enabled", "not_addressable", "superseded", "ingested", "not_attempted"]),
  detail: z.string(),
  /** Dependency manifests read, parsed and written. */
  manifestsIngested: z.number().int().nonnegative(),
  /** Declarations recorded across those manifests. */
  declarationsRecorded: z.number().int().nonnegative(),
  /**
   * Declarations DELETED because the manifest no longer declares them.
   *
   * REPORTED BECAUSE THE DESTRUCTIVE HALF MUST NOT BE INVISIBLE IN ITS OWN RECEIPT. Without it a
   * run that emptied a component's entire inventory — every manifest gone from the ref the operator
   * happened to name — reads exactly like a clean one: `verdict: "ingested"`, and only the counts
   * of what was ADDED. An operator backfilling at the wrong ref would have no signal at all.
   */
  declarationsPruned: z.number().int().nonnegative(),
  /** Manifests found to be GONE at this ref, whose rows were therefore removed entirely. The
   *  loudest half of the line above, separated because "the file is not there any more" is a
   *  different fact from "this file dropped a dependency". */
  manifestsRemoved: z.number().int().nonnegative(),
  /** Manifests that could NOT be read or parsed. Their existing rows were left untouched —
   *  unreadable is never treated as "declares nothing". */
  manifestsSkipped: z.number().int().nonnegative(),
  /** Provider reads actually attempted. ZERO for `not_enabled`, by construction. */
  reads: z.number().int().nonnegative()
});
export type DependencyInventoryBackfillComponent = z.infer<
  typeof DependencyInventoryBackfillComponentSchema
>;

/** The default of `BackfillDependencyInventoryRequest.fetchBudget` — see that field for why a bound
 *  exists at all. Sized so a whole-org run stays inside one request's plausible lifetime: 25
 *  components x up to 40 reads each is the same order as a single discovery run. */
export const DEFAULT_DEPENDENCY_INVENTORY_BACKFILL_FETCH_BUDGET = 25;

export const BackfillDependencyInventoryResponseSchema = z.object({
  /** The ref every component was read at, echoed so the answer is self-describing. */
  ref: z.string(),
  components: z.array(DependencyInventoryBackfillComponentSchema),
  ingested: z.number().int().nonnegative(),
  notEnabled: z.number().int().nonnegative(),
  notAddressable: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  /** Components the fetch budget did not reach. NON-ZERO MEANS THE RUN IS INCOMPLETE and should be
   *  repeated (or narrowed with `componentIdsOrUrns`) — it is a count of work not done, which is
   *  precisely what a receipt that only counted successes could not say. */
  notAttempted: z.number().int().nonnegative(),
  /** Declarations deleted across the whole run. The one number that says a backfill was
   *  DESTRUCTIVE; a clean re-run reports zero. */
  declarationsPruned: z.number().int().nonnegative()
});
export type BackfillDependencyInventoryResponse = z.infer<
  typeof BackfillDependencyInventoryResponseSchema
>;

/**
 * The COORDINATE half of a producer declaration — the natural key of `dependency_line_producers`,
 * and the query shape of the read.
 *
 * The coordinate travels in the BODY or the QUERY, never a path segment: coordinates contain `/`,
 * `@` and `:` (`github.com/acme/lib`, `@acme/lib`, `docker.io/library/alpine`), so path-segmenting
 * one is a trap. `GET /components/:idOrUrn/dependency-subscription` already makes this choice.
 */
export const DependencyLineProducerKeySchema = z.object({
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema
});
export type DependencyLineProducerKey = z.infer<typeof DependencyLineProducerKeySchema>;

/**
 * The separate, operator-driven verb that makes a COORDINATE internal. Kept apart from
 * `UpsertDependencyLineInput` on purpose: if ingestion could pass a producer alongside a coordinate
 * it observed, "declared, never inferred" would survive only as long as every ingestion call site
 * remembered to leave it unset. Splitting the verb removes the capability instead of guarding it.
 *
 * THERE IS NO `declaredByObjectId` HERE, AND THERE MUST NOT BE. Principle 6 asks WHO asserted this,
 * and an answer the asserter typed is not an answer. The route stamps the authenticated subject.
 */
export const DeclareDependencyLineProducerRequestSchema = DependencyLineProducerKeySchema.extend({
  /**
   * The producing COMPONENT's graph object id or URN.
   *
   * A `service` IS REFUSED IN THE FIRST CUT (ADR-0032 §7e, proposal §12.2), and the refusal is not
   * pedantry: `listProducedLines` derives a head only from the COMPONENT a prod placement names, so
   * a service-valued declaration derives no head at all while still removing the coordinate from
   * third-party polling — it does the harmful half silently and not the useful half.
   */
  producerIdOrUrn: z.string().min(1).max(512),
  /** Compute and return the blast radius, write NOTHING. Not a nicety: it is the only way a
   *  declarer sees WHOSE repositories they are about to affect before they affect them. */
  dryRun: z.boolean().optional()
});
export type DeclareDependencyLineProducerRequest = z.infer<
  typeof DeclareDependencyLineProducerRequestSchema
>;

/** Retract a declaration and return the coordinate to third-party polling. Same blast-radius report
 *  and the same `dryRun`, because a retraction changes exactly as much as a declaration does. */
export const RetractDependencyLineProducerRequestSchema = DependencyLineProducerKeySchema.extend({
  dryRun: z.boolean().optional()
});
export type RetractDependencyLineProducerRequest = z.infer<
  typeof RetractDependencyLineProducerRequestSchema
>;

/**
 * One line the declaration (or retraction) covers, and what it did to that line's head.
 *
 * THE HEAD IS CLEARED BY BOTH VERBS, and the reason is a security one rather than a tidiness one
 * (§12.3.2, and stronger since M22). `latest_version` is not only the poll's backward-movement
 * floor: the M22 vendor rule grants a scan PASS when a component sits on the latest of its major
 * line. A head left over from the internal era, on a coordinate that is third-party again, can
 * therefore grant a vendor-pass against a version no registry ever published. In the other
 * direction a poisoned public head (the stranger's `9.9.9`) would survive the very declaration that
 * exists to undo it, and internal detection could never move the head back down to the org's real
 * `2.1.0` — `recordDependencyLineHead` refuses backward movement.
 */
export const DependencyProducerLineImpactSchema = z.object({
  lineId: z.string().uuid(),
  major: DependencyMajorLineSchema,
  tagPattern: z.string().nullable(),
  /** The head as it stood BEFORE this verb ran — the value that was cleared, so an operator can see
   *  what was discarded rather than only that something was. */
  headBefore: z.object({
    latestVersion: z.string().nullable(),
    latestDigest: z.string().nullable(),
    latestObservedAt: z.string().nullable()
  }),
  /** False when the line had no observed head to clear — an honest no-op, not a silent skip. */
  headCleared: z.boolean(),
  /** WHOSE REPOSITORIES THIS REACHES. The declarer names one coordinate and affects a set of
   *  components they cannot see from the request; this list is that set. Sorted. */
  subscribedComponentObjectIds: z.array(z.string().uuid())
});
export type DependencyProducerLineImpact = z.infer<typeof DependencyProducerLineImpactSchema>;

/**
 * A bump SCP already authored that is still open at the moment of a retraction.
 *
 * IT IS REPORTED AND NEVER TOUCHED. A dispatched bump has left SCP: it is a pull request in another
 * team's repository, or — under `auto_merge` — a commit on their branch. Closing or rewriting these
 * rows would assert SCP closed a PR it did not close. Retraction stops FUTURE triggers only, and
 * this list is what an operator takes away to go and close them (§12.3.2).
 */
export const DependencyProducerOpenBumpSchema = z.object({
  changeObjectId: z.string().uuid(),
  componentObjectId: z.string().uuid(),
  repo: z.string(),
  manifestPath: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  /** As the provider returned it. Absent means SCP recorded no link — never "compose one". */
  pullRequestUrl: z.string().optional()
});
export type DependencyProducerOpenBump = z.infer<typeof DependencyProducerOpenBumpSchema>;

/**
 * What a declare or a retract reports back — THE BLAST RADIUS, which is why this is a verb and not
 * a field write (§12.3, ADR-0031 §6's grounds 1 and 3; ground 2, one-way-ness, does not transfer).
 */
export const DependencyLineProducerVerbResponseSchema = z.object({
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema,
  /** `declare` | `retract`. Echoed so a stored response stands alone. */
  action: z.enum(["declare", "retract"]),
  /** True when nothing was written. */
  dryRun: z.boolean(),
  /** The declaration as it now stands — `null` after a retraction, and `null` on a `dryRun` retract
   *  because the report describes the state the caller ASKED FOR. */
  declaration: DependencyLineProducerSchema.nullable(),
  /** Every major line of this coordinate the verb covers, with what happened to its head. EMPTY is
   *  a legitimate and common answer: a producer may be declared before any consumer's manifest has
   *  minted a line, which is exactly what per-coordinate grain makes representable. */
  lines: z.array(DependencyProducerLineImpactSchema),
  /** Open bumps in flight at this moment (retract only, and only when not a dry run). */
  openBumpAuthorships: z.array(DependencyProducerOpenBumpSchema),
  /** The Decision this verb recorded, or `null` on a dry run — principle 6's `decision_id`. */
  decisionId: z.string().uuid().nullable(),
  dependencyManagement: DependencyManagementSchema
});
export type DependencyLineProducerVerbResponse = z.infer<
  typeof DependencyLineProducerVerbResponseSchema
>;

/** The read. Optionally narrowed to one ecosystem, or to one exact coordinate. */
export const ListDependencyLineProducersQuerySchema = z.object({
  ecosystem: DependencyEcosystemSchema.optional(),
  /** VERBATIM byte equality, never a prefix or a slug — `@acme/lib` and `acme-lib` are two
   *  coordinates that share a URN slug and must not share an answer. */
  coordinate: DependencyCoordinateSchema.optional()
});
export type ListDependencyLineProducersQuery = z.infer<
  typeof ListDependencyLineProducersQuerySchema
>;

export const ListDependencyLineProducersResponseSchema = z.object({
  producers: z.array(DependencyLineProducerSchema),
  dependencyManagement: DependencyManagementSchema
});
export type ListDependencyLineProducersResponse = z.infer<
  typeof ListDependencyLineProducersResponseSchema
>;

/** What the repo verb takes. `declaredByObjectId` is present HERE and absent from the request
 *  schema above — the route supplies it from the authenticated subject. */
export interface DeclareLineProducerInput {
  ecosystem: DependencyEcosystem;
  coordinate: string;
  producerObjectId: string;
  declaredByObjectId: string;
}
