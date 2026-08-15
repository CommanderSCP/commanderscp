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
   * The component/service this org DECLARES produces this line. `null` = third-party.
   *
   * DECLARED, NEVER INFERRED (ADR-0032 §7, ADR-0030 §2). Nothing reads a coordinate, a repo name or
   * a registry host and concludes "this one is ours". A label named after WHAT MATCHED goes false
   * the moment the matcher covers a second case — already shipped once in this repo, in a Decision
   * where it had been wrong since before the level that exposed it (charter principle 6). Discovery
   * may PROPOSE the link; an operator accepts it.
   *
   * What keeps inference out is that `UpsertDependencyLineInputSchema` HAS NO PRODUCER FIELD — the
   * capability is absent from the ingestion verb rather than guarded on it. The database's
   * `dependency_lines_internal_is_declared` CHECK is the weaker complement: it ties this column,
   * `producedByDeclaredAt` and `producedByDeclaredByObjectId` together so none of the three can be
   * written without the other two, which refuses a raw-SQL half-write. It does NOT make the declarer
   * a human — that is `DeclareLineProducerInput`'s call sites and the route's authz (0060 header).
   */
  producedByObjectId: z.string().uuid().nullable(),
  producedByDeclaredAt: z.string().nullable(),
  /** Which principal declared the producer link — principle 6: "who asserted this line is internal?"
   *  must be answerable. `null` when no producer is declared, and NEVER null beside a non-null
   *  `producedByObjectId`: the CHECK above binds all three, and the column carries a foreign key, so
   *  the answer can be neither absent nor a uuid that names nothing. */
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
 * (`delivery` describes intent; §8 does not ship until the charter amendment adding
 * `scp-managed-dep` lands — reading this type is not evidence the code bumps anything.)
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
// (`CreatePolicyRequestSchema` / `scp policy create`). A bespoke create/update/delete shape here
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
  resolution: DependencySubscriptionResolutionSchema
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
  /** `oci` — the digest the observed tag resolved to. Required in spirit for images (a tag is not an
   *  identity); `null` for the language ecosystems, which have no digest. */
  latestDigest: z.string().max(256).nullable().optional()
});
export type ObserveDependencyLineHeadInput = z.infer<typeof ObserveDependencyLineHeadInputSchema>;
