import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import { ChangeSchema, DecisionSchema } from "./changes.js";
import { DependencyEcosystemSchema } from "./dependencies.js";
import { ExecutorTypeSchema } from "./executors.js";

/**
 * M5 Campaigns wire contract (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Campaigns introduce NO
 * new engine machinery — a Campaign compiles its own plan/waves over
 * the SAME `coordination/plan-compiler.ts` pure function a Change uses (`coordination/
 * campaign-plan-service.ts`); its wave targets fan out into real M3 Changes (`ChangeSchema`,
 * unchanged) that run through the completely unmodified change lifecycle/gates. Campaign STATUS
 * is a pure DERIVED aggregation (`coordination/campaign-status.ts`), never a stored state column
 * — hence no `CampaignStateSchema` mirroring `ChangeStateSchema`'s 8-state machine here.
 */

export const CampaignStatusSchema = z.enum([
  "proposed", // no plan compiled yet
  "active", // plan compiled, at least one wave in flight, none blocked/failed
  "blocked", // the active wave's boundary gate returned "block" (a policy/control did not pass)
  "failed", // a wave's member changes failed/were cancelled without recovering
  "completed", // every wave succeeded
  "partially_rolled_back", // some — but not all — accepted member changes have been rolled back
  "rolled_back" // every accepted member change has been rolled back
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

// ===========================================================================================
// M25.4 — THE CAMPAIGN RECIPE (owner decision D3: a COORDINATION lever, never an authoring one)
// ===========================================================================================
//
// WHAT A RECIPE IS. One authored trigger intent that a campaign fans across N components: which
// kind of trigger to ask each target's ALREADY-BOUND executor for, and what parameters to hand it.
// That is the whole of it, and the narrowness is the point.
//
// WHAT A RECIPE IS NOT, and cannot become without a charter amendment. It carries NO patch, NO
// file content, NO command line, NO script. CommanderSCP does not write the python3 diff and does
// not know how to port Python — it triggers the TENANT'S OWN migration workflow, once per
// component, wave-ordered and gated (charter principle 1). If a tenant has no such workflow, a
// campaign has nothing to trigger and the honest outcome is the capability refusal below, not a
// managed migration. The `scp-managed-dep` grant is textually narrow ("editing the declared version
// of an already-declared dependency", "never authors any other content") and is deliberately NOT
// stretched to cover this: OQ-5 is unruled, so nothing here drives that actuator.
//
// WHY `campaign.properties.recipe` AND NOT A TABLE — see `docs/adr/0041`. Short form: a recipe has
// no window, no lifecycle and no independent identity (charter principle 2 — new concepts arrive as
// data on existing objects), and the `freezes` projection table earns its exception on window
// semantics queried on a hot gate path, which a recipe read once per trigger does not have. The
// decisive argument is reach: config that must cross a federation boundary rides `object_upsert` as
// a graph OBJECT, and nothing table-shaped travels.

/** The `campaign.properties` / `change.properties` key a recipe lives under. ONE constant: the
 *  authoring guard, the fan-out copy and the trigger-time reader must name the same key, and three
 *  string literals is how one of them silently stops being read. */
export const CAMPAIGN_RECIPE_PROPERTY_KEY = "recipe";

/**
 * The trigger kinds a recipe may ask for — `TriggerIntent["kind"]` MINUS `"rollback"`.
 *
 * The subtraction is a safety property, not tidiness. A rollback is addressed to a `priorStateRef`
 * a prior `status()` call captured, and `reconcile.ts` decides `kind = "rollback"` from the CHANGE
 * (`isRollback`), never from a document. If a recipe could name `"rollback"`, a campaign author
 * could turn every member change into a restore; and because the recipe rides the change's
 * properties through federation promotion, that document would arrive at an outpost too. The
 * inverse is also enforced at the actuator: `isRollback` overrides the recipe's kind
 * unconditionally, so a rollback of a recipe-carrying change is still a rollback.
 */
export const CampaignRecipeTriggerKindSchema = z.enum(["sync", "workflow_dispatch", "custom"]);
export type CampaignRecipeTriggerKind = z.infer<typeof CampaignRecipeTriggerKindSchema>;

/** Max serialized size of `trigger.parameters`, in bytes of JSON. Bounded BEFORE it becomes a row:
 *  the recipe is copied verbatim onto every member change's `properties` (one row per target — 47
 *  for the motivating campaign) and reaches a `block` Decision's `inputContext` on the refusal path.
 *  An unbounded free-form bag on both of those is the shape of the measured 1.44 GB/day Decision
 *  growth incident, arriving through a different door. */
export const CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES = 8 * 1024;

/** How deep `trigger.parameters` may nest. Providers take one or two levels (`inputs`, `variables`,
 *  `clientPayload`); anything deeper is not a parameter set, and an unbounded depth is an unbounded
 *  recursion in every reader that walks it. */
export const CAMPAIGN_RECIPE_PARAMETERS_MAX_DEPTH = 6;

/**
 * Substrings that may not appear in ANY parameter key, at any depth, case-insensitively.
 *
 * `objects.properties` is readable at `object:read`, and a recipe is copied onto every member
 * change's properties — so a secret placed here is a secret published to everyone who can read any
 * one of 47 changes. Secrets belong in `executor_bindings.secret_refs`, which the plugin host
 * resolves per instance and never puts on the graph.
 *
 * MATCHED AGAINST A NORMALIZED KEY — lowercased with every non-alphanumeric character removed —
 * and a SUBSTRING rather than a prefix. Both halves were chosen after the first draft failed its own
 * test: it listed `apikey` and `api_key` as separate entries and let `x-api-key` through, which is
 * the "enumerate the symptoms" mistake in miniature. Normalizing collapses `api_key`, `api-key`,
 * `x-api-key` and `apiKey` into one rule, so the list names CONCEPTS and the separator vocabulary
 * cannot grow a hole. `githubToken`, `deploy_password` and `AWS_SECRET_ACCESS_KEY` are the shapes
 * people actually write, and a prefix rule catches none of them.
 *
 * The false-positive cost is one 400 naming the key and the remedy; the false-negative cost is a
 * credential in a federated, `object:read`-visible document that no later fix can un-publish.
 */
export const CAMPAIGN_RECIPE_BANNED_KEY_SUBSTRINGS: readonly string[] = [
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "apikey",
  "privatekey",
  "accesskey"
];

/** Lowercase, alphanumerics only — see {@link CAMPAIGN_RECIPE_BANNED_KEY_SUBSTRINGS}. */
function normalizeParameterKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Walks a parsed parameter bag: JSON-value-ness, depth, and the banned-key rule in ONE pass, so
 *  the three can never disagree about what they visited. Returns the first violation's message. */
function inspectRecipeParameters(value: unknown, depth: number, path: string): string | undefined {
  if (depth > CAMPAIGN_RECIPE_PARAMETERS_MAX_DEPTH) {
    return `${path}: nested deeper than ${CAMPAIGN_RECIPE_PARAMETERS_MAX_DEPTH} levels`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${path}: ${String(value)} is not a JSON number`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = inspectRecipeParameters(value[i], depth + 1, `${path}[${i}]`);
      if (bad) return bad;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeParameterKey(key);
      const banned = CAMPAIGN_RECIPE_BANNED_KEY_SUBSTRINGS.find((s) => normalized.includes(s));
      if (banned !== undefined) {
        return (
          `${path}.${key}: parameter keys may not contain '${banned}' — a recipe is copied onto ` +
          `every member change's properties, which are readable at 'object:read' and travel through ` +
          `federation. Put the credential in the executor binding's secret refs instead.`
        );
      }
      const bad = inspectRecipeParameters(entry, depth + 1, `${path}.${key}`);
      if (bad) return bad;
    }
    return undefined;
  }
  return `${path}: ${typeof value} is not a JSON value`;
}

// ===========================================================================================
// M25.5 — ADOPTION EVIDENCE ("has component X migrated yet?")
// ===========================================================================================
//
// THE HONEST ANSWER FIRST, because everything below is shaped by it: **SCP cannot know in general
// whether a component has been migrated.** There is no per-component standing state store —
// `observed_state` is per-wave-target and `control_runs` is per-change — so the platform has no
// place to look unless the recipe TELLS it where. A recipe therefore NAMES its own evidence source,
// and where it names none, or where the named source is silent, the verdict is `unknown`, **never
// `adopted`**. That is `coordination/boundary-segment.ts`'s honesty rule R3 ("silence is never a
// pass") applied unchanged, and it is the entire safety property of this feature: M25.6's deadline
// lock fires on this predicate, so an `adopted` conjured out of an absent fact is a governance
// record asserting compliance that nobody verified.
//
// WHY A DISCRIMINATED UNION AND NOT A BAG OF OPTIONAL FIELDS. Each kind reads a DIFFERENT table
// with different key columns, and a bag would let an author write `{ecosystem, controlObjectId}`
// — two sources, no rule for which wins. The union makes "which fact answers this question" a
// single authored choice that the reader cannot silently reinterpret.
//
// -------------------------------------------------------------------------------------------
// `declared` IS DELIBERATELY ABSENT. OQ-6 IS UNRULED AND THIS SHIPS WITHOUT IT.
// -------------------------------------------------------------------------------------------
// The proposal's §3.4 sketch lists a FOURTH kind — `{kind:"declared", key, value}`, read from a
// `component.properties.adoption.declarations` bag. It is not here, and its absence is a decision
// rather than an omission. §4.4 states the reason and its own recommendation ("do not ship
// `declared` until an above-component admission exists"): the beneficiary of the assertion "I have
// migrated" is exactly the party the deadline exists to coerce, writing at plain `object:write` on
// their OWN component, with none of M22's admission algebra above it. A self-attested deadline
// waiver produces a signed, hash-chained governance record asserting a migration nobody observed —
// strictly worse than having no lock at all.
//
// ADDING IT LATER IS ADDITIVE AND BREAKS NOTHING. A new member of a `z.discriminatedUnion` is a new
// `oneOf` branch in the emitted OpenAPI: an old client never sends it and never has to parse one it
// did not author, and no existing branch changes shape. The same is true of a fifth kind. What is
// NOT additive — and must never be done to this union — is adding a required field to an EXISTING
// branch, or making one of the fields below optional on a response.
export const AdoptionEvidenceSchema = z.discriminatedUnion("kind", [
  /**
   * THIS CAMPAIGN'S OWN wave target for the component is `succeeded`. Zero new machinery: the fact
   * is already in `campaign_wave_targets`.
   *
   * THE VERDICT STRING IS `"delivered"` AND NEVER `"migrated"`, and the distinction is the whole
   * reason this kind is named the way it is. What `succeeded` means is: SCP triggered the tenant's
   * OWN pipeline for that component and the resulting member Change reached `accepted`. It does not
   * mean the code changed — the recipe's `workflow_dispatch` may have run a workflow that did
   * nothing, and `github`/`gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId`
   * so a target whose binding names a different default runs THAT one and still succeeds.
   *
   * IT IS ALSO NEARLY INERT IN THE CAMPAIGN RECONCILER, by construction rather than by accident, and
   * the proposal (§4.4) says so plainly rather than selling it: the reconciler evaluates adoption
   * only for a `pending` target, and a `pending` target has by definition not succeeded. So this
   * kind can never make the reconciler skip a fan-out. Its value is on the READ surface (and, from
   * M25.6, as the deadline lock's default signal) — which is exactly the "the campaign hasn't
   * reached you yet, and now it never will" degeneracy §4.4 names, and the reason a real migration
   * campaign should choose `dependency` or `control` instead.
   */
  z.strictObject({ kind: z.literal("delivered") }),
  /**
   * THE ONE THAT ACTUALLY WORKS FOR python2 -> python3, and the only kind backed by a standing,
   * component-scoped, INDEPENDENTLY REFRESHED fact table: `component_dependencies`, re-read out of
   * the repository itself by `dependencies/inventory-ingestion-loop.ts` whenever a change is
   * accepted. After the migration workflow's push lands, the inventory reads `FROM python:3.12-slim`
   * from the actual file — evidence SCP observed, not evidence anybody asserted.
   *
   * `adopted` iff no live row for this `(ecosystem, coordinate)` resolves BELOW `minVersion`;
   * `unknown` iff the component has ZERO inventory rows at all. That second clause is the load-
   * bearing one: "never ingested" and "declares nothing on this coordinate" are different facts, and
   * conflating them is precisely the silence-as-a-pass failure this whole file exists to refuse.
   * See `coordination/campaign-adoption.ts` for the full verdict matrix, including how a NULL
   * `resolved_version` (an open range — "the manifest pins no concrete version", never "we did not
   * look") and a version pair the shared comparator declines to order are treated. Neither can ever
   * produce `adopted`.
   */
  z.strictObject({
    kind: z.literal("dependency"),
    /** Matches `dependency_lines.ecosystem`. The closed set lives here and nowhere else — the column
     *  is plain `text` with no CHECK, exactly like `dependencyLines.ecosystem` documents. */
    ecosystem: DependencyEcosystemSchema,
    /** The ecosystem-native coordinate, VERBATIM and case-preserved — `docker.io/library/python`,
     *  `@acme/lib`, `com.acme:lib`. Never a URN and never slugified: the join to `dependency_lines`
     *  is byte equality, and `graph/urn.ts`'s `slugify` collapses `@acme/lib`, `acme/lib` and
     *  `acme-lib` into one string. */
    coordinate: z.string().min(1).max(512),
    /** The floor. A row resolving at or above it satisfies the evidence; a row resolving below it is
     *  positive evidence of NON-adoption. Parsed by `@scp/dependency-manifests`'s
     *  `parseComparableVersion` — the repo's single version parser — so a `minVersion` that parser
     *  refuses makes every row incomparable and the verdict `unknown`, never `adopted`. */
    minVersion: z.string().min(1).max(128)
  }),
  /**
   * The latest `control_runs` row for `(this campaign's member change for the target,
   * controlObjectId)` is `pass`. The STRONGEST kind: a control run is a governed, evidence-carrying
   * observation the platform itself orchestrated.
   *
   * `plugin_module` is read off the RUN ROW, never re-resolved from the binding. That column is
   * stamped at insert (drizzle/0063) precisely so that re-pointing a control's binding cannot
   * retroactively relabel a historical pass as having come from a different checker — the
   * provenance-labels-are-read-not-inferred rule, applied to the one fact that decides whether a
   * component escapes a deadline.
   */
  z.strictObject({ kind: z.literal("control"), controlObjectId: z.string().uuid() })
]);
export type AdoptionEvidence = z.infer<typeof AdoptionEvidenceSchema>;

/**
 * THE AUTHOR'S DOOR — `z.strictObject` throughout, and open in the property registry (the 0043/0075
 * rule: `import-repo.ts`'s `object_upsert` branch Ajv-validates against the REGISTERED schema with
 * no try/catch, so a closed registry schema makes every future key a fail-closed version-skew
 * hazard that wedges a peer's whole signed bundle; a refusal here costs one 400 and nobody's
 * bundle).
 *
 * EVERY FUTURE KEY MUST BE OPTIONAL. M25.5's `adoption` evidence is the next one, and this schema is
 * reachable through federation promotion (a promoted change carries its recipe — see
 * `promotion-repo.ts`), so a REQUIRED addition would make a newer commander's promotion unparseable
 * at an older outpost. `version` exists to say which vocabulary the document speaks, never as a
 * licence to make a later version's key mandatory.
 */
export const CampaignRecipeSchema = z
  .strictObject({
    version: z.literal(1),
    trigger: z.strictObject({
      kind: CampaignRecipeTriggerKindSchema,
      /**
       * VERBATIM into `TriggerIntent.parameters`. **SCP performs NO cross-provider translation**
       * — a recipe written in `github` keys is never guessed into `gitlab` shape (see the adapter
       * table in `docs/adr/0041`). Translating would mean re-rendering a declaration SCP does not
       * fully model, and a wrong guess triggers the wrong automation in a tenant's own repository.
       * The author picks the keys their bound executors read; a target whose executor cannot serve
       * the recipe's KIND is refused loudly rather than silently defaulted.
       */
      parameters: z.record(z.string(), z.unknown()).optional()
    }),
    /**
     * M25.5 — WHERE TO LOOK to answer "has this component migrated yet?" (see
     * {@link AdoptionEvidenceSchema}).
     *
     * OPTIONAL, and the inertness that buys is a stated property rather than a nicety: a recipe that
     * declares none makes `coordination/campaign-adoption.ts` return `unknown` before it issues a
     * single query, and makes the campaign reconciler skip the predicate entirely. A campaign
     * authored before M25.5 therefore costs exactly what it cost before M25.5.
     *
     * ABSENT IS `unknown`, NOT `adopted`. There is no default evidence source and there must never
     * be one — inferring `delivered` from a recipe that named nothing would be the platform
     * answering a question it was not given the means to answer.
     */
    adoption: AdoptionEvidenceSchema.optional(),
    /** DISPLAY ONLY — a link an operator opens themselves. NEVER fetched by the server or by a
     *  plugin: charter principle 5 (no runtime network calls to the outside world) does not bend
     *  for a documentation link, and a server-side fetch of an author-supplied URL is an SSRF. */
    guidance: z
      .strictObject({
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(2000).optional(),
        docsUrl: z.string().min(1).max(2000).optional()
      })
      .optional()
  })
  .superRefine((recipe, ctx) => {
    const parameters = recipe.trigger.parameters;
    if (parameters === undefined) return;
    const bad = inspectRecipeParameters(parameters, 0, "trigger.parameters");
    if (bad !== undefined) {
      ctx.addIssue({ code: "custom", message: bad, path: ["trigger", "parameters"] });
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(parameters), "utf8");
    if (bytes > CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `trigger.parameters serializes to ${bytes} bytes, over the ${CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES}-byte cap`,
        path: ["trigger", "parameters"]
      });
    }
  });
export type CampaignRecipe = z.infer<typeof CampaignRecipeSchema>;

// ===========================================================================================
// M25.6a — THE DEADLINE (owner decision D4: the radius is THE CAMPAIGN'S OWN TARGETS)
// ===========================================================================================
//
// WHAT A DEADLINE IS. A date, on a campaign, past which that campaign stops fanning out to targets
// it cannot observe as migrated. Nothing more.
//
// WHAT ITS RADIUS IS, because this is the thing most easily got wrong. An unmigrated component
// stops receiving *THIS CAMPAIGN'S* changes. Unrelated releases — INCLUDING SECURITY FIXES — keep
// flowing to it, untouched. It is **not** a freeze on the component and it must not be implemented
// as one: not through `checkFreeze` (scope-based, campaign-blind and all-or-nothing across a wave —
// routing a per-target deadline through it would re-lock the crux M25.2 just fixed), and not
// through `evaluateWaveGate` (one verdict, no target dimension, fires exactly once).
//
// WHY IT LIVES ON `campaign.properties` AND NOT IN A TABLE — the same three reasons ADR-0041 gives
// for the recipe, one of which is decisive here too: config that must cross a federation boundary
// rides `object_upsert` as a graph OBJECT, and nothing table-shaped travels. `campaign.properties`
// validates against an OPEN JSON Schema under `new Ajv({strict:false})` (drizzle/0011 §4), so this
// key costs no migration at all.
//
// IT IS CONFIGURATION, NOT STATUS, and that is what keeps "campaign status is derived, never
// stored" intact. The deadline is an INPUT. Nothing anywhere ever writes "locked": the lock is
// re-derived from `(deadline.at, adoption)` on every tick, which is exactly what makes a late
// adoption or a moved deadline clear it with NO unlock verb.

/** The `campaign.properties` key a deadline lives under. ONE constant, for the reason
 *  {@link CAMPAIGN_RECIPE_PROPERTY_KEY} states: three string literals is how one of them silently
 *  stops being read. */
export const CAMPAIGN_DEADLINE_PROPERTY_KEY = "deadline";

/**
 * WHICH adoption signal this deadline was authored against — DECLARATIVE ONLY.
 *
 * ================================================================================================
 * IT IS NOT A SELECTOR, AND MUST NEVER BECOME ONE
 * ================================================================================================
 * The verdict "has this component migrated?" comes from `coordination/campaign-adoption.ts`'s
 * `evaluateCampaignAdoption` reading the campaign's OWN `recipe.adoption` document — the ONE
 * resolution core (§3.4 consumer 4: "reads this function and nothing else"). This field cannot
 * select an evidence source even if someone wanted it to: a bare string carries no `ecosystem`,
 * `coordinate`, `minVersion` or `controlObjectId`, so there is nothing here to resolve WITH. It is
 * recorded so the durable record says which signal the author believed they were relying on, and so
 * an operator reading the campaign can see at a glance whether the deadline is a real lock or the
 * near-no-op §4.4 describes.
 *
 * THE VOCABULARY IS `AdoptionEvidenceSchema`'s DISCRIMINATOR, not the proposal's §4.1 sketch.
 * That sketch predates M25.5 and writes the first value as `"campaign_target_succeeded"`; the
 * shipped name for that fact is `delivered` (see `AdoptionEvidenceSchema`, which chose it precisely
 * to stop anyone reading it as "migrated"). Two spellings of one concept is how the two drift, so
 * there is one. `campaign-deadline-lock.test.ts` pins this enum against the evidence union's
 * members so a fourth evidence kind cannot land on only one of them.
 *
 * `declared` IS ABSENT for the same reason it is absent from `AdoptionEvidenceSchema`: OQ-6 is
 * unruled and §4.4's own recommendation is not to ship it until an above-component admission
 * algebra exists. A self-attested deadline waiver produces a signed governance record asserting a
 * migration nobody observed.
 */
export const CampaignDeadlineAdoptionSignalSchema = z.enum(["delivered", "dependency", "control"]);
export type CampaignDeadlineAdoptionSignal = z.infer<typeof CampaignDeadlineAdoptionSignalSchema>;

/**
 * M25.6b — ONE PER-TARGET WAIVER of this campaign's deadline (§4.5).
 *
 * ================================================================================================
 * IT IS A STORED DOCUMENT, NEVER A REQUEST BODY — AND THAT SPLIT IS THE AUTHORITY CHECK
 * ================================================================================================
 * Every field here except `until` is filled in BY THE SERVER from the authenticated act:
 * `targetObjectId` from the resolved target, `reason` from the mandatory request field, `actorId`
 * from the bearer subject, `at` from the write's own clock. Nothing on the wire can author one.
 *
 * That is not stylistic. `POST /campaigns` and `POST /campaigns/{id}/deadline` both take a
 * {@link CampaignDeadlineInputSchema} at plain `object:write`, and `POST
 * /campaigns/{id}/deadline-override` takes {@link OverrideCampaignDeadlineRequestSchema} behind the
 * Owner-only `campaign:deadline-override`. If the two doors shared one schema, the cheap door would
 * mint waivers the expensive one exists to gate — a self-service waiver channel that LOOKS
 * enforced, which is precisely the hazard M25.6a refused this key to avoid. `CampaignDeadlineSchema`
 * (storage + read) carries `overrides`; `CampaignDeadlineInputSchema` (both authoring doors) does
 * not, and it is `.strict()`, so naming the key there is a 400 rather than a silent drop.
 *
 * `until` IS A BOUNDARY, NOT A TIMER, and its expiry is READ-TIME: `campaign-deadline-lock.ts`
 * compares it against the tick's `now` on every evaluation and no job un-flips anything. An `until`
 * in the past is simply not effective — the M22.6 ruling, applied a third time in this milestone.
 * ABSENT means "until the deadline is cleared or the target adopts", which is the common case: an
 * Owner excusing a laggard usually cannot say when it will be done.
 */
export const CampaignDeadlineOverrideSchema = z.strictObject({
  /** The campaign wave target this waiver covers — one entry per target, never a scope or a
   *  pattern. A waiver that matched by scope would be a freeze in miniature, which is the exact
   *  thing owner decision D4 excludes. */
  targetObjectId: z.string().uuid(),
  /** The authoring operator's own words. MANDATORY at the door (`min(1)`) — a waiver of a
   *  governance deadline with no stated reason is the record failing at the one job it has. */
  reason: z.string().min(1),
  /** The subject that minted it. Recorded so the durable document names who excused whom; it is
   *  DELIBERATELY absent from the Decision's `inputContext` (identity-shaped, ADR-0024) and lives
   *  there and on the `campaign.deadline.override` audit event instead. */
  actorId: z.string().uuid(),
  /** When it was minted. Clock-shaped, so likewise NEVER in a Decision's `inputContext`. */
  at: z.string().datetime(),
  /** Optional expiry BOUNDARY. Effective while `now <= until`; an instant in the past is not
   *  effective and needs no job to make it so. */
  until: z.string().datetime().optional()
});
export type CampaignDeadlineOverride = z.infer<typeof CampaignDeadlineOverrideSchema>;

/**
 * THE STORED / READ SHAPE — `z.strictObject`, and OPEN in the property registry, the same 0043/0075
 * split `CampaignRecipeSchema` documents. Wire-side strictness is a LOCAL authoring refusal (one
 * 400, nobody's bundle); a tightened REGISTRY schema is a fail-closed version-skew hazard that
 * wedges a peer's whole signed bundle at an older receiver. Hence: no property-schema migration in
 * this increment either, and a document a newer commander writes that this schema refuses degrades
 * to "no deadline" on the read surface and to a loud `warn` at the predicate — never to a silent
 * lock.
 *
 * `overrides[]` — §4.1's fourth key — LANDS HERE IN M25.6b, and only here. The two AUTHORING doors
 * take {@link CampaignDeadlineInputSchema}, which omits it; see
 * {@link CampaignDeadlineOverrideSchema} for why that split is the authority check rather than a
 * tidiness preference.
 */
export const CampaignDeadlineSchema = z.strictObject({
  /**
   * The instant past which unmigrated targets stop receiving this campaign's fan-out.
   *
   * THE ONLY CLOCK-SHAPED VALUE ANY OF THIS FEATURE'S DECISIONS MAY CARRY. `at` is a stored
   * BOUNDARY, byte-identical on every one of the 86,400 ticks in a day, which is what lets
   * `insertDecisionIfChanged` collapse a standing lock to ONE row. Recording the clock instead —
   * `now`, `evaluatedAt`, `overdueMs`, `daysLate`, `lockedSince`, any remaining-TTL — is the
   * measured 1.44 GB/day production incident (ADR-0024) rebuilt from parts.
   */
  at: z.string().datetime(),
  /** See {@link CampaignDeadlineAdoptionSignalSchema} — DECLARATIVE, never a selector. */
  adoptionSignal: CampaignDeadlineAdoptionSignalSchema.optional(),
  /**
   * M25.6b — the per-target waivers in force, AT MOST ONE PER TARGET and stored sorted by
   * `targetObjectId`.
   *
   * BOTH OF THOSE ARE LOAD-BEARING RATHER THAN TIDY. This document rides `object_upsert` to every
   * federated replica and is content-hashed on every write, so an append-only list would grow
   * without bound and re-hash the campaign object on every re-statement of a waiver that already
   * existed; sorting makes a re-issued waiver byte-identical instead. Re-overriding a target
   * REPLACES its entry — the newest reason and the newest `until` are the ones in force, and the
   * superseded one survives on the hash chain where history belongs.
   */
  overrides: z.array(CampaignDeadlineOverrideSchema).optional()
});
export type CampaignDeadline = z.infer<typeof CampaignDeadlineSchema>;

/**
 * THE AUTHOR'S DOOR — what `POST /campaigns` and `POST /campaigns/{id}/deadline` accept.
 *
 * IDENTICAL TO {@link CampaignDeadlineSchema} MINUS `overrides`, and still STRICT, so naming
 * `overrides` at either door is a 400 rather than a value silently dropped on the floor. Minting a
 * waiver takes `campaign:deadline-override` (Owner-only, drizzle/0088) at the campaign PLUS
 * `object:write` at each named target; both of these doors take plain `object:write` at the
 * campaign alone. One shared schema would make the cheaper door the whole permission's bypass.
 *
 * Deriving it by `.omit()` rather than declaring a second literal object is what keeps a future
 * third key (`at`-like configuration, not a waiver) from being added to one and not the other.
 */
export const CampaignDeadlineInputSchema = CampaignDeadlineSchema.omit({
  overrides: true
}).strict();
export type CampaignDeadlineInput = z.infer<typeof CampaignDeadlineInputSchema>;

/**
 * `POST /api/v1/campaigns/{id}/deadline` — set, move, or CLEAR.
 *
 * ONE VERB FOR ALL THREE, with `deadline: null` meaning clear. Campaigns have no PATCH and no
 * DELETE today — the same entrance-with-no-exit gap M25.1 closed for freezes — and a deadline that
 * cannot be moved is a deadline that gets worked around by deleting the campaign, which takes the
 * whole governance record's SURFACE with it.
 *
 * `reason` IS MANDATORY on every one of the three, including the clear. `object:write` is a low bar
 * for a governance act whose effect is immediate and fleet-wide within the campaign; the audit event
 * this produces records the PREVIOUS value beside the new one, because "the deadline slipped four
 * times" is otherwise unreconstructible from a chain of writes that each say only where it landed.
 */
export const SetCampaignDeadlineRequestSchema = z.object({
  /**
   * The new deadline, or `null` to clear it.
   *
   * {@link CampaignDeadlineInputSchema}, NOT `CampaignDeadlineSchema`: this verb runs at plain
   * `object:write`, and accepting `overrides` here would let it mint the very waivers
   * `campaign:deadline-override` exists to gate. Naming the key is a 400 (the schema is strict), not
   * a silent drop. The waivers already in force are PRESERVED across a set or a move — see
   * `setCampaignDeadline`.
   */
  deadline: CampaignDeadlineInputSchema.nullable(),
  reason: z.string().min(1)
});
export type SetCampaignDeadlineRequest = z.infer<typeof SetCampaignDeadlineRequestSchema>;

/**
 * `POST /api/v1/campaigns/{id}/deadline-override` (M25.6b, §4.5) — EXCUSE ONE LAGGARD without
 * clearing the deadline for everybody, which is the only exit M25.6a shipped.
 *
 * ================================================================================================
 * THE AUTHORIZATION IS THE SUBSTANCE, AND IT IS TWO CHECKS AT TWO DIFFERENT OBJECTS
 * ================================================================================================
 *  * `campaign:deadline-override` **AT THE CAMPAIGN OBJECT**. The thing being waived is *this
 *    campaign's* deadline, so the authority that waives it is authority over the campaign. A
 *    target-scoped check would hand the laggard their own waiver — the component's own operator
 *    could excuse the component from the migration the campaign exists to force.
 *  * `object:write` **AT EACH NAMED TARGET**, so a waiver cannot be minted over a component the
 *    actor has no standing on at all.
 *
 * It is deliberately NOT `freeze:override`. Borrowing that would let anyone holding a freeze
 * override waive migration deadlines and vice versa — two unrelated blast radii collapsed onto one
 * permission, and neither grant could afterwards be narrowed without taking the other with it.
 */
export const OverrideCampaignDeadlineRequestSchema = z.object({
  /**
   * WHICH targets to excuse — object ids or URNs, each of which must already be a target of this
   * campaign (a waiver over a non-target is dead data in a governance record, so it is a 400).
   *
   * OMITTED MEANS EVERY TARGET THE CAMPAIGN CURRENTLY DECLARES, and that is NOT a synonym for
   * clearing the deadline: the deadline stands, each waiver is recorded per target with its own
   * audit event, `until` still expires them, and a target added to a later campaign is not covered.
   * `object:write` is then demanded at every one of them, so the broad form needs broad standing.
   */
  targets: z.array(z.string().min(1)).min(1).optional(),
  /** MANDATORY. Recorded verbatim in the stored waiver and on one high-severity audit event per
   *  target. A governance waiver with no stated reason fails at the one job the record has. */
  reason: z.string().min(1),
  /** Optional expiry BOUNDARY — effective while `now <= until`. Read-time expiry, no job: an
   *  instant already in the past yields a waiver that is stored, audited and NOT effective. */
  until: z.string().datetime().optional()
});
export type OverrideCampaignDeadlineRequest = z.infer<typeof OverrideCampaignDeadlineRequestSchema>;

export const CampaignSchema = z.object({
  id: z.string().uuid(), // = the underlying graph object's id
  orgId: z.string().uuid(),
  urn: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  targets: z.array(z.string().uuid()),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  status: CampaignStatusSchema,
  /** M25.4 — the coordination lever this campaign fans out, if it declares one. OPTIONAL on the
   *  response, never required: a campaign authored before M25.4 (and every campaign that just wants
   *  its targets' default pipelines) carries none, and making a response field required later is the
   *  oasdiff break this project has already paid for once. */
  recipe: CampaignRecipeSchema.optional(),
  /**
   * M25.6a — the campaign's deadline, or `null` when it declares none.
   *
   * REQUIRED AND NULLABLE, not optional, and the asymmetry with `recipe` directly above is
   * deliberate rather than an inconsistency. `recipe` is a lever an operator either configured or
   * did not; `deadline` is a governance fact whose ABSENCE is itself the answer to "is anything
   * being withheld from this campaign's laggards?" — and an operator must not have to distinguish
   * "no deadline" from "this response predates the field". Same reasoning, and the same oasdiff
   * arithmetic, as `FreezeSchema.atomic`/`liftedAt`: adding a required response property is
   * additive; making an EXISTING required one optional is the break this project has already paid
   * for once.
   *
   * A document that does not parse reads as `null` HERE — a display surface, where absence is the
   * honest rendering — while the ACTUATOR treats the same bytes as a loud, recorded `warn` and locks
   * nothing (`coordination/campaign-deadline-lock.ts`). The two agree on the operator-visible
   * outcome: nothing is being withheld.
   */
  deadline: CampaignDeadlineSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** `POST /campaigns` — `targets` (>=1 idOrUrn) is the set of graph objects each wave's per-target
 *  member Change will be proposed against, exactly like `CreateChangeRequestSchema.targets`. */
export const CreateCampaignRequestSchema = z.object({
  name: z.string().min(1).max(200),
  id: z.string().uuid().optional(),
  urn: z.string().optional(),
  domainId: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
  /** Release-topology object id or URN to compile the campaign's waves against (optional — falls
   *  back to pure `depends_on` toposort, same as a Change). */
  topology: z.string().optional(),
  /** WHICH pipeline every change this campaign fans out rolls (M12 P4A) — the routing Type
   *  (ADR-0007). "Patch the base AMI across every cluster" is an `infrastructure` campaign, "roll
   *  the log4j bump across every service" a `configuration` one. Declared once on the campaign
   *  rather than per fanned-out change, which is what a campaign IS: one intent, many targets.
   *  Omitted means 'configuration' (the server default). */
  type: ExecutorTypeSchema.optional(),
  /** M25.4 (owner decision D3) — ONE authored trigger intent, fanned across every target. This is
   *  the whole of "1-click": configure it once here and 47 components each get their own member
   *  Change, wave-ordered, governed, and triggered against their OWN already-bound executor with
   *  these parameters. SCP writes no patch (charter principle 1) — see `CampaignRecipeSchema`. */
  recipe: CampaignRecipeSchema.optional(),
  /** M25.6a (owner decision D4) — the date past which this campaign stops fanning out to targets it
   *  cannot observe as migrated. A REQUEST widening, so oasdiff-free. Authoring it here rather than
   *  only through `POST /campaigns/{id}/deadline` is what keeps a deadlined campaign a single call;
   *  the dedicated route exists to MOVE and CLEAR it afterwards, with a mandatory reason and an
   *  audit event carrying the previous value.
   *
   *  {@link CampaignDeadlineInputSchema}, so a campaign cannot be CREATED carrying waivers: this
   *  route runs at `object:write`, and `overrides` takes the Owner-only `campaign:deadline-override`
   *  at the campaign plus `object:write` at every named target. */
  deadline: CampaignDeadlineInputSchema.optional(),
  targets: z.array(z.string().min(1)).min(1)
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequestSchema>;

export const CampaignListQuerySchema = CursorPageQuerySchema.extend({
  status: CampaignStatusSchema.optional()
});
export type CampaignListQuery = z.infer<typeof CampaignListQuerySchema>;

export const CampaignListResponseSchema = cursorPageResponseSchema(CampaignSchema);
export type CampaignListResponse = z.infer<typeof CampaignListResponseSchema>;

export const CampaignIdParamSchema = z.object({ id: z.string().uuid() });

export const RollbackCampaignRequestSchema = z.object({
  reason: z.string().min(1)
});
export type RollbackCampaignRequest = z.infer<typeof RollbackCampaignRequestSchema>;

/** `POST /campaigns/{id}/rollback` response — DESIGN §9.5: "reverts its accepted member targets
 *  through the same wave/rollback machinery, each producing a Decision." One `rolledBack` entry
 *  per member Change actually rolled back (each `rollbackChange` is a real, independent Change);
 *  `skipped` names every member Change that was NOT eligible (never accepted, already rolled
 *  back, etc.) and why — never silently dropped. */
export const RollbackCampaignResponseSchema = z.object({
  rolledBack: z.array(
    z.object({ originalChangeObjectId: z.string().uuid(), rollbackChange: ChangeSchema })
  ),
  skipped: z.array(z.object({ originalChangeObjectId: z.string().uuid(), reason: z.string() }))
});
export type RollbackCampaignResponse = z.infer<typeof RollbackCampaignResponseSchema>;

/** One member Change of a campaign wave, plus the raw target it was proposed against — DESIGN
 *  §9.5: "Member changes are real Changes linked to the campaign via coordinates relationships." */
export const CampaignWaveTargetSchema = z.object({
  id: z.string().uuid(),
  waveId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  targetUrn: z.string().optional(),
  targetName: z.string().optional(),
  memberChangeObjectId: z.string().uuid().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CampaignWaveTarget = z.infer<typeof CampaignWaveTargetSchema>;

export const CampaignWaveSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  waveIndex: z.number().int(),
  name: z.string().nullable(),
  requiresFanIn: z.boolean(),
  status: z.string(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  targets: z.array(CampaignWaveTargetSchema)
});
export type CampaignWave = z.infer<typeof CampaignWaveSchema>;

export const CampaignPlanSchema = z.object({
  id: z.string().uuid(),
  campaignObjectId: z.string().uuid(),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
  waves: z.array(CampaignWaveSchema)
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

/** `GET /campaigns/{id}:explain` — the campaign, its compiled plan (if any, with each wave
 *  target's member Change resolved inline), and every Decision made about it (campaign-level
 *  wave-boundary gate checks + the campaign-level rollback trigger, if any) — the campaign-scoped
 *  analogue of `ChangeExplainResponseSchema`. */
export const CampaignExplainResponseSchema = z.object({
  campaign: CampaignSchema,
  plan: CampaignPlanSchema.nullable(),
  decisions: z.array(DecisionSchema)
});
export type CampaignExplainResponse = z.infer<typeof CampaignExplainResponseSchema>;

// ===========================================================================================
// M25.5 — `GET /campaigns/{id}/adoption`, the READ surface over the same one predicate
// ===========================================================================================

/**
 * THREE VALUES, AND THE THIRD IS NOT A DEGRADED SECOND. `unknown` means "the named evidence source
 * had nothing to say about this component" — never ingested, no control run, no wave target — and it
 * is a DIFFERENT fact from `not_adopted` ("we looked and this component is below the floor / the
 * control did not pass"). Collapsing them would make an un-ingested component indistinguishable
 * from an observed laggard, and would put the platform one refactor away from reading a missing
 * fact as a satisfied one.
 *
 * BOTH `unknown` AND `not_adopted` KEEP A TARGET IN THE CAMPAIGN. Only `adopted` is an exit — from
 * the fan-out here, and from M25.6's deadline lock. That asymmetry is the R3 rule in its operational
 * form, and it is why the enum can never grow a fourth "probably" value.
 */
export const CampaignAdoptionVerdictSchema = z.enum(["adopted", "not_adopted", "unknown"]);
export type CampaignAdoptionVerdict = z.infer<typeof CampaignAdoptionVerdictSchema>;

/** One campaign target's adoption verdict, with the observations that produced it. */
export const CampaignAdoptionTargetSchema = z.object({
  targetObjectId: z.string().uuid(),
  targetUrn: z.string().optional(),
  targetName: z.string().optional(),
  verdict: CampaignAdoptionVerdictSchema,
  /** One sentence naming what was observed and why it produced this verdict — the same text the
   *  `campaign_adoption` Decision's `reasonTree.summary` carries. */
  summary: z.string(),
  /**
   * The EVIDENCE ITSELF, one line per observed fact — a declared/resolved version pair and its
   * position relative to the floor, a control run id with its status and stamped `plugin_module`, a
   * wave target status.
   *
   * **SORTED, and that is a correctness requirement rather than a presentation choice.** This exact
   * array is what the reconciler puts in the `campaign_adoption` Decision's `inputContext`, and
   * `decisions-repo.ts`'s `restatesDecision` canonicalizes object KEYS but deliberately preserves
   * array ORDER ("a reordered array is a genuinely different input set and MUST write a new row").
   * An unsorted array — Postgres returns rows in no guaranteed order — would therefore make an
   * unchanged situation look new on some ticks and write a fresh Decision row for it. That is the
   * shape of the measured 1.44 GB/day incident (ADR-0024), reached through a different door.
   *
   * NOTHING CLOCK-SHAPED APPEARS HERE. No evaluation timestamp, no attempt counter, no "checked
   * N seconds ago" — those are the values that make every tick's observation differ from the last.
   */
  observations: z.array(z.string())
});
export type CampaignAdoptionTarget = z.infer<typeof CampaignAdoptionTargetSchema>;

/**
 * `GET /campaigns/{id}/adoption` — the per-target answer to "has this component migrated yet?",
 * derived live at read time. There is NO stored adoption column and no scheduler: the verdict is
 * re-derived from the named evidence source on every read, which is what makes a late migration, a
 * re-ingested manifest or a re-run control clear it with no "mark adopted" verb anywhere.
 */
export const CampaignAdoptionResponseSchema = z.object({
  campaignObjectId: z.string().uuid(),
  /** The campaign recipe's declared evidence source, echoed back — `null` when the recipe declares
   *  none (or carries no recipe at all), in which case every target below is `unknown`. Echoed
   *  rather than described so an operator can see the exact document the verdicts were derived from
   *  without a second call. */
  evidence: AdoptionEvidenceSchema.nullable(),
  targets: z.array(CampaignAdoptionTargetSchema),
  /**
   * Declared targets that could not be resolved to a live object, named rather than dropped.
   *
   * Only reachable BEFORE a plan is compiled (afterwards the targets come from the plan, which by
   * construction holds resolved ids). An IaC-authored campaign declares URN-shaped targets until the
   * reconciler's first pass normalises them, and a target deleted after authoring never resolves at
   * all — the same fault `campaign-reconcile.ts` records as a `plan_diff` block. Returning an empty
   * `targets` array with no explanation would be this feature's own failure mode in miniature: an
   * absence rendered as a clean result.
   */
  unresolvedTargets: z.array(z.string())
});
export type CampaignAdoptionResponse = z.infer<typeof CampaignAdoptionResponseSchema>;
