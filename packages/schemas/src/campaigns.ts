import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import { ChangeSchema, DecisionSchema } from "./changes.js";
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
