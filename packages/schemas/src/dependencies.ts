import { z } from "zod";

/** M21.2 — the DEPENDENCY INVENTORY contract. See docs/schemas.md §124. */

/** The five ecosystems of M21. See docs/schemas.md §125. */
export const DependencyEcosystemSchema = z.enum(["npm", "go", "maven", "python", "oci"]);
export type DependencyEcosystem = z.infer<typeof DependencyEcosystemSchema>;

/** The ECOSYSTEM-NATIVE coordinate, carried VERBATIM. See docs/schemas.md §126. */
export const DependencyCoordinateSchema = z.string().min(1).max(512);

/** The major line, as the ecosystem spells it: a string. See docs/schemas.md §127. */
export const DependencyMajorLineSchema = z.string().min(1).max(64);

/** One MAJOR LINE of one dependency. Identity is `(orgId, ecosystem, coordinate, major)`. */
export const DependencyLineSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema,
  major: DependencyMajorLineSchema,
  /** `oci` only: the tag shape whose version this follows. See docs/schemas.md §128. */
  tagPattern: z.string().nullable(),
  /** THE PRODUCER LINK IS NOT ON THIS ROW ANY MORE. See docs/schemas.md §129. */
  /** The head of the line as last OBSERVED. See docs/schemas.md §130. */
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

/** The DECLARATION that an org produces one COORDINATE. See docs/schemas.md §131. */
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

/** The shape every dependency read uses to name an object. See docs/schemas.md §132. */
export const DependencyObjectRefSchema = z.object({
  objectId: z.string().uuid(),
  name: z.string()
});
export type DependencyObjectRef = z.infer<typeof DependencyObjectRefSchema>;

/** THE WIRE VIEW of a declaration. See docs/schemas.md §133. */
export const DependencyLineProducerViewSchema = DependencyLineProducerSchema.extend({
  producer: DependencyObjectRefSchema,
  /** The principal that asserted the declaration, named. Same object as `declaredByObjectId`. */
  declaredBy: DependencyObjectRefSchema
});
export type DependencyLineProducerView = z.infer<typeof DependencyLineProducerViewSchema>;

/** True iff the coordinate has a DECLARED producer. See docs/schemas.md §134. */
export function isInternalDependencyLine(declaration: DependencyLineProducer | null): boolean {
  return declaration !== null;
}

/** One component's declaration of one line, from one manifest. See docs/schemas.md §135. */
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
  /** The repository the manifest was read from, as spelled. See docs/schemas.md §136. */
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

// M21.3 — DEPENDENCY SUBSCRIPTIONS AND THEIR ENABLEMENT. See docs/schemas.md §137.

/** How much of a line a subscriber accepts automatically. See docs/schemas.md §138. */
export const DependencySubscriptionGranularitySchema = z.enum(["patch", "minor_and_patch"]);
export type DependencySubscriptionGranularity = z.infer<
  typeof DependencySubscriptionGranularitySchema
>;

/** How the M21.5 actuator delivers a bump. See docs/schemas.md §139. */
export const DependencySubscriptionDeliverySchema = z.enum(["pull_request", "auto_merge"]);
export type DependencySubscriptionDelivery = z.infer<typeof DependencySubscriptionDeliverySchema>;

/** ONE `dependencySubscription` EFFECT. See docs/schemas.md §140. */
export const DependencySubscriptionEffectSchema = z.strictObject({
  ecosystem: DependencyEcosystemSchema.optional(),
  /** Absent = every coordinate. Compared verbatim; see the class comment. */
  coordinate: DependencyCoordinateSchema.optional(),
  major: DependencyMajorLineSchema.optional(),
  /** `true` subscribes, `false` OPTS OUT. Required — absent never means enabled. */
  enabled: z.boolean(),
  granularity: DependencySubscriptionGranularitySchema.optional(),
  delivery: DependencySubscriptionDeliverySchema.optional()
});
export type DependencySubscriptionEffect = z.infer<typeof DependencySubscriptionEffectSchema>;

/** The tier a contribution came from — for EXPLAINABILITY ONLY. See docs/schemas.md §141. */
export const DependencySubscriptionTierSchema = z.enum([
  "instance",
  "org",
  "containment_domain",
  "service",
  "component"
]);
export type DependencySubscriptionTier = z.infer<typeof DependencySubscriptionTierSchema>;

/** WHAT one contribution actually contributed to the AND. See docs/schemas.md §142. */
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

/** One level's contribution to the resolved enablement. See docs/schemas.md §143. */
export const DependencySubscriptionContributionSchema = z.object({
  tier: DependencySubscriptionTierSchema,
  source: z.string(),
  /** For policy contributions, the `object_types.id` of the graph object the policy matched at —
   *  recorded verbatim, since the tier label above is DERIVED from it. */
  objectTypeId: z.string().optional(),
  contributed: DependencySubscriptionContributedSchema,
  ignoredReason: DependencySubscriptionIgnoredReasonSchema.optional(),
  /** The selectors this contribution carried, echoed back. See docs/schemas.md §144. */
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

/** WHY the resolution came out the way it did. See docs/schemas.md §145. */
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

/** The resolved enablement of ONE. See docs/schemas.md §146. */
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

// M21.3 — THE API SURFACE for the enablement chain. See docs/schemas.md §147.

/** The instance unlock singleton, as the API projects it. See docs/schemas.md §148. */
export const DependencySubscriptionUnlockSchema = z.object({
  unlocked: z.boolean(),
  note: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The same `source` label the `instance` tier carries in a resolution's `contributions`, so
   *  "which level turned this off" points at a row an operator can actually go and change. */
  source: z.string()
});
export type DependencySubscriptionUnlock = z.infer<typeof DependencySubscriptionUnlockSchema>;

/** The operator write body. See docs/schemas.md §149. */
export const PutDependencySubscriptionUnlockRequestSchema = z.object({
  unlocked: z.boolean(),
  note: z.string().max(500).nullish()
});
export type PutDependencySubscriptionUnlockRequest = z.infer<
  typeof PutDependencySubscriptionUnlockRequestSchema
>;

/** Which deployment shape answered, in the role vocabulary. See docs/schemas.md §150. */
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

/** Does dependency management actually happen on this one. See docs/schemas.md §151. */
export const DependencyManagementSchema = z.object({
  /** True iff dependency automation RUNS on this deployment — i.e. it is an explicitly declared
   *  commander. False means no job here will ever act on the answer beside it. */
  managedHere: z.boolean(),
  /** WHY. Always `commander` exactly when `managedHere` is true; one of the three refusals
   *  otherwise, each with a different remedy. */
  reason: DependencyManagementReasonSchema
});
export type DependencyManagement = z.infer<typeof DependencyManagementSchema>;

/** Is this component subscribed to this line, and why. See docs/schemas.md §152. */
export const DependencySubscriptionResolutionResponseSchema = z.object({
  componentObjectId: z.string().uuid(),
  line: DependencyLineKeySchema,
  resolution: DependencySubscriptionResolutionSchema,
  /** WHETHER ANYTHING HERE WILL EVER ACT ON `resolution`. See docs/schemas.md §153. */
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
  /** The digest of that version, from the same observation. See docs/schemas.md §154. */
  latestDigest: z.string().max(256).nullable()
});
export type ObserveDependencyLineHeadInput = z.infer<typeof ObserveDependencyLineHeadInputSchema>;

// M21.2 — THE INVENTORY BACKFILL. See docs/schemas.md §155.

export const BackfillDependencyInventoryRequestSchema = z.object({
  /** Narrow the run to specific components (id or URN). OMITTED means every component in the org —
   *  which is the point of a backfill, and which the ENABLEMENT GATE keeps cheap: a component with
   *  no enabling subscription is refused before any repo is read. */
  componentIdsOrUrns: z.array(z.string().min(1)).max(500).optional(),
  /** The ref to read at. Defaults to `HEAD`, i.e. the repo's own default branch, because a backfill
   *  has no release to read a commit from — unlike the event-driven path, which reads at the commit
   *  the accepted change carried. The resolved commit is still what lands on each row. */
  ref: z.string().min(1).max(512).optional(),
  /** How many components this request may actually fetch for. See docs/schemas.md §156. */
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
  manifestsIngested: z.number().int().nonnegative(),
  declarationsRecorded: z.number().int().nonnegative(),
  /** Declarations deleted because the manifest dropped them. See docs/schemas.md §157. */
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

/** The COORDINATE half of a producer declaration. See docs/schemas.md §158. */
export const DependencyLineProducerKeySchema = z.object({
  ecosystem: DependencyEcosystemSchema,
  coordinate: DependencyCoordinateSchema
});
export type DependencyLineProducerKey = z.infer<typeof DependencyLineProducerKeySchema>;

/** The operator-driven verb that makes a coordinate internal. See docs/schemas.md §159. */
export const DeclareDependencyLineProducerRequestSchema = DependencyLineProducerKeySchema.extend({
  /** The producing COMPONENT's graph object id or URN. See docs/schemas.md §160. */
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

/** One line the declaration. See docs/schemas.md §161. */
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
  subscribedComponentObjectIds: z.array(z.string().uuid()),
  /** The same set, NAMED — one entry per id above, same order (sorted by id). A blast radius a human
   *  is asked to confirm before it is written must name what it reaches; ids alone are not a
   *  report a declarer can act on (dependency-subscription-ui.md §12.6 Q1). */
  subscribedComponents: z.array(DependencyObjectRefSchema)
});
export type DependencyProducerLineImpact = z.infer<typeof DependencyProducerLineImpactSchema>;

/** A bump already authored and still open at retraction. See docs/schemas.md §162. */
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
  dryRun: z.boolean(),
  /** The declaration as it now stands — `null` after a retraction, and `null` on a `dryRun` retract
   *  because the report describes the state the caller ASKED FOR. Named (the wire view). */
  declaration: DependencyLineProducerViewSchema.nullable(),
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
  /** Named rows (the wire view) — see {@link DependencyLineProducerViewSchema}. */
  producers: z.array(DependencyLineProducerViewSchema),
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

// M21.6 — THE READ SURFACE. See docs/schemas.md §163.

/** The page query for both read routes. See docs/schemas.md §164. */
export const ComponentDependencyPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});
export type ComponentDependencyPageQuery = z.infer<typeof ComponentDependencyPageQuerySchema>;

/** The component both responses are about — its graph id, its name, and its CONTAINMENT domain
 *  (nullable: an org-root object has none). The domain is carried because authoring a
 *  `dependencySubscription` policy for this component sends `domainId` (see the proposal §8 Q3 and
 *  the M21.7-owned gate-ordering pin in `policy-write-gate-ordering.integration.test.ts`). */
export const ComponentDependencyReadSubjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  domainId: z.string().uuid().nullable()
});
export type ComponentDependencyReadSubject = z.infer<typeof ComponentDependencyReadSubjectSchema>;

/** The per-component ingestion STAMP. See docs/schemas.md §165. */
export const ComponentDependencyIngestionStampSchema = z.object({
  lastAttemptAt: z.string(),
  /** What ran it: the accepted-change loop, or an operator backfill. The LATEST attempt's. */
  source: z.enum(["loop", "backfill"]),
  outcome: z.enum(["ok", "partial", "unreadable", "not_enabled"]),
  /** Summed across every repository's slice — a fact about the COMPONENT. 0 with `ok` is legal
   *  and meaningful. */
  rowsWritten: z.number().int().nonnegative(),
  /** The stamp's own sentence about the LATEST attempt (a closed gate's reason, a refusal), or
   *  `null` when the per-file entries are the explanation. */
  detail: z.string().nullable(),
  manifests: z.array(
    z.object({
      /** The repository this entry's evidence came from — the merge key. */
      repo: z.string(),
      path: z.string(),
      /** `ok` | `unreadable` | `unsupported` as the writer spells it (`IngestionStampManifest`);
       *  carried as a string so a future outcome word does not break a reader. */
      outcome: z.string(),
      rows: z.number().int().nonnegative(),
      /** When the pass that wrote this entry looked, ISO-8601. */
      at: z.string(),
      detail: z.string().optional()
    })
  )
});
export type ComponentDependencyIngestionStamp = z.infer<
  typeof ComponentDependencyIngestionStampSchema
>;

/** The newest ingestion Decision about this component. See docs/schemas.md §166. */
export const ComponentDependencyLastIngestionDecisionSchema = z.object({
  decisionId: z.string().uuid(),
  firstObservedAt: z.string(),
  manifestPathsRead: z.array(z.string()),
  manifestPathsAbsent: z.array(z.string()),
  /** Dependency manifests that could NOT be read or parsed on that pass — left untouched, never
   *  treated as declaring nothing. */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() }))
});
export type ComponentDependencyLastIngestionDecision = z.infer<
  typeof ComponentDependencyLastIngestionDecisionSchema
>;

/** The COMPONENT-LEVEL ingestion gate. See docs/schemas.md §167. */
export const ComponentIngestionGateReasonSchema = z.enum([
  "enabled",
  "instance_locked",
  "no_enabling_contribution"
]);
export type ComponentIngestionGateReason = z.infer<typeof ComponentIngestionGateReasonSchema>;

export const ComponentDependencyIngestionGateSchema = z.object({
  enabled: z.boolean(),
  reason: ComponentIngestionGateReasonSchema,
  /** The contributions of the merge that decided it — the same explanation the ingestion Decision
   *  carries under `reasonTree.gate.contributions`. */
  contributions: z.array(DependencySubscriptionContributionSchema)
});
export type ComponentDependencyIngestionGate = z.infer<
  typeof ComponentDependencyIngestionGateSchema
>;

/** The head of a line as last OBSERVED — every field `null` = not yet observed. Never "nothing
 *  newer exists" (`DependencyLineSchema.latestVersion`). */
export const ComponentDependencyLineHeadSchema = z.object({
  latestVersion: z.string().nullable(),
  latestDigest: z.string().nullable(),
  latestObservedAt: z.string().nullable()
});
export type ComponentDependencyLineHead = z.infer<typeof ComponentDependencyLineHeadSchema>;

/** ONE ROW of a component's inventory. See docs/schemas.md §168. */
export const ComponentDependencyInventoryRowSchema = z.object({
  line: z.object({
    id: z.string().uuid(),
    ecosystem: DependencyEcosystemSchema,
    coordinate: DependencyCoordinateSchema,
    major: DependencyMajorLineSchema,
    /** `oci` only; `null` for the language ecosystems. */
    tagPattern: z.string().nullable()
  }),
  manifestPath: z.string(),
  /** What the manifest LITERALLY says (`^1.2.3`, `3.18-alpine`) — the actuator's edit target. */
  declaredVersion: z.string(),
  /** `null` = the manifest pins no concrete version, never "did not look". */
  resolvedVersion: z.string().nullable(),
  resolvedDigest: z.string().nullable(),
  observedRepo: z.string().nullable(),
  observedRef: z.string().nullable(),
  observedAt: z.string(),
  head: ComponentDependencyLineHeadSchema,
  /** The DECLARED producer of this line — `null` when none is declared, which is what a
   *  third-party line AND an undeclared internal one both look like; the stored fact does not say
   *  which, and neither does this field. Never inferred from the coordinate. */
  producer: z
    .object({
      objectId: z.string().uuid(),
      name: z.string()
    })
    .nullable(),
  /** The resolved subscription of this component and line. See docs/schemas.md §169. */
  subscription: DependencySubscriptionResolutionSchema
});
export type ComponentDependencyInventoryRow = z.infer<typeof ComponentDependencyInventoryRowSchema>;

export const ComponentDependencyInventoryResponseSchema = z.object({
  component: ComponentDependencyReadSubjectSchema,
  /** WHETHER DEPENDENCY MANAGEMENT HAPPENS ON THIS DEPLOYMENT (rule 4 above). Required. When
   *  `managedHere` is false the fields below are not to be interpreted. */
  dependencyManagement: DependencyManagementSchema,
  /** The M21.7 ingestion stamp; `null` = NEVER ATTEMPTED (no row — `findIngestionStampByComponent`).
   *  Optional on the wire only so a deployment predating the stamp's read path can omit it; this
   *  route always sends it. NEVER read as "no dependencies" — see the stamp's own doc. */
  ingestion: ComponentDependencyIngestionStampSchema.nullable().optional(),
  /** `null` = no `dependency_inventory_ingestion` Decision is on record for this component. */
  lastIngestionDecision: ComponentDependencyLastIngestionDecisionSchema.nullable(),
  componentGate: ComponentDependencyIngestionGateSchema,
  /** One row per (line, dependency manifest); ordered by line id then manifest path, which is the
   *  storage order and stable under paging. `[]` beside null `ingestion`/`lastIngestionDecision` is
   *  UNKNOWN, not empty. */
  rows: z.array(ComponentDependencyInventoryRowSchema),
  nextCursor: z.string().nullable()
});
export type ComponentDependencyInventoryResponse = z.infer<
  typeof ComponentDependencyInventoryResponseSchema
>;

/** ONE BUMP SCP AUTHORED for this component. See docs/schemas.md §170. */
export const ComponentDependencyBumpSchema = z.object({
  changeId: z.string().uuid(),
  changeName: z.string(),
  line: z.object({
    id: z.string().uuid(),
    ecosystem: DependencyEcosystemSchema,
    coordinate: DependencyCoordinateSchema,
    major: DependencyMajorLineSchema
  }),
  manifestPath: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  /** `owner/repo` as SCP recorded it — the authority for which repository the merge may touch. */
  repo: z.string(),
  baseBranch: z.string(),
  authoredRef: z.string(),
  /** The pull request SCP opened; `null` until the authoring run reported one. */
  pullRequestNumber: z.number().int().nullable(),
  /** The pull request's URL as the provider returned it. See docs/schemas.md §171. */
  pullRequestUrl: z.string().nullable(),
  /** The commit SCP's own branch is at; `null` until the authored push is observed back. */
  headCommit: z.string().nullable(),
  /** When SCP RECORDED THE AUTHORSHIP. See docs/schemas.md §172. */
  dispatchedAt: z.string(),
  /** When the provider confirmed the merge; `null` while no merge is recorded (which includes a
   *  pull request that is still open, one closed without a merge — never observed — and one that
   *  was never opened). */
  mergedAt: z.string().nullable(),
  /** The delivery the dispatch RESOLVED TO (the first look is always `pull_request`, ADR-0032 §8c)
   *  and why, read from the newest `dependency_bump_dispatch` Decision; `null` when that Decision
   *  is not on record. */
  delivery: DependencySubscriptionDeliverySchema.nullable(),
  deliveryReason: z.string().nullable(),
  /** The newest `dependency_bump_merge` Decision — the second look; `null` when the gate has not
   *  run for this bump. `verdict` is `merged` or `withheld` as the gate wrote it. */
  merge: z
    .object({
      verdict: z.string(),
      decisionId: z.string().uuid(),
      evaluatedAt: z.string()
    })
    .nullable()
});
export type ComponentDependencyBump = z.infer<typeof ComponentDependencyBumpSchema>;

export const ComponentDependencyBumpsResponseSchema = z.object({
  component: ComponentDependencyReadSubjectSchema,
  /** WHETHER DEPENDENCY MANAGEMENT HAPPENS ON THIS DEPLOYMENT (rule 4 above). Required. When
   *  `managedHere` is false, `rows` is not to be interpreted (nothing is ever dispatched there). */
  dependencyManagement: DependencyManagementSchema,
  rows: z.array(ComponentDependencyBumpSchema),
  nextCursor: z.string().nullable()
});
export type ComponentDependencyBumpsResponse = z.infer<
  typeof ComponentDependencyBumpsResponseSchema
>;
