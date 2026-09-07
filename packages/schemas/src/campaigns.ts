import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import { ChangeSchema, DecisionSchema } from "./changes.js";
import { DependencyEcosystemSchema } from "./dependencies.js";
import { ExecutorTypeSchema } from "./executors.js";

/** M5 Campaigns wire contract. See docs/schemas.md §15. */

export const CampaignStatusSchema = z.enum([
  "proposed",
  "active", // plan compiled, at least one wave in flight, none blocked/failed
  "blocked", // the active wave's boundary gate returned "block" (a policy/control did not pass)
  "failed", // a wave's member changes failed/were cancelled without recovering
  "completed",
  "partially_rolled_back", // some — but not all — accepted member changes have been rolled back
  "rolled_back" // every accepted member change has been rolled back
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

// M25.4 — THE CAMPAIGN RECIPE. See docs/schemas.md §16.

/** The `campaign.properties` / `change.properties` key a recipe lives under. ONE constant: the
 *  authoring guard, the fan-out copy and the trigger-time reader must name the same key, and three
 *  string literals is how one of them silently stops being read. */
export const CAMPAIGN_RECIPE_PROPERTY_KEY = "recipe";

/** The trigger kinds a recipe may ask for, minus rollback. See docs/schemas.md §17. */
export const CampaignRecipeTriggerKindSchema = z.enum(["sync", "workflow_dispatch", "custom"]);
export type CampaignRecipeTriggerKind = z.infer<typeof CampaignRecipeTriggerKindSchema>;

/** Max serialized size of `trigger.parameters`, in bytes of JSON. See docs/schemas.md §18. */
export const CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES = 8 * 1024;

/** How deep `trigger.parameters` may nest. Providers take one or two levels (`inputs`, `variables`,
 *  `clientPayload`); anything deeper is not a parameter set, and an unbounded depth is an unbounded
 *  recursion in every reader that walks it. */
export const CAMPAIGN_RECIPE_PARAMETERS_MAX_DEPTH = 6;

/** Substrings that may not appear in any parameter key. See docs/schemas.md §19. */
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

// M25.5 — ADOPTION EVIDENCE. See docs/schemas.md §20.
export const AdoptionEvidenceSchema = z.discriminatedUnion("kind", [
  /** This campaign's own wave target for the component. See docs/schemas.md §21. */
  z.strictObject({ kind: z.literal("delivered") }),
  /** The one that actually works, and what backs it. See docs/schemas.md §22. */
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
  /** The latest control run for this campaign's member change. See docs/schemas.md §23. */
  z.strictObject({ kind: z.literal("control"), controlObjectId: z.string().uuid() })
]);
export type AdoptionEvidence = z.infer<typeof AdoptionEvidenceSchema>;

/** THE AUTHOR'S DOOR. See docs/schemas.md §24. */
export const CampaignRecipeSchema = z
  .strictObject({
    version: z.literal(1),
    trigger: z.strictObject({
      kind: CampaignRecipeTriggerKindSchema,
      /** VERBATIM into `TriggerIntent.parameters`. See docs/schemas.md §25. */
      parameters: z.record(z.string(), z.unknown()).optional()
    }),
    /** Where to look to answer has this component migrated. See docs/schemas.md §26. */
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

// M25.6a — THE DEADLINE. See docs/schemas.md §27.

/** The `campaign.properties` key a deadline lives under. ONE constant, for the reason
 *  {@link CAMPAIGN_RECIPE_PROPERTY_KEY} states: three string literals is how one of them silently
 *  stops being read. */
export const CAMPAIGN_DEADLINE_PROPERTY_KEY = "deadline";

/** WHICH adoption signal this deadline was authored against. See docs/schemas.md §28. */
export const CampaignDeadlineAdoptionSignalSchema = z.enum(["delivered", "dependency", "control"]);
export type CampaignDeadlineAdoptionSignal = z.infer<typeof CampaignDeadlineAdoptionSignalSchema>;

/** M25.6b — ONE PER-TARGET WAIVER of this campaign's deadline. See docs/schemas.md §29. */
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

/** THE STORED / READ SHAPE. See docs/schemas.md §30. */
export const CampaignDeadlineSchema = z.strictObject({
  /** The instant past which unmigrated targets stop receiving. See docs/schemas.md §31. */
  at: z.string().datetime(),
  /** See {@link CampaignDeadlineAdoptionSignalSchema} — DECLARATIVE, never a selector. */
  adoptionSignal: CampaignDeadlineAdoptionSignalSchema.optional(),
  /** The per-target waivers in force, at most one per target. See docs/schemas.md §32. */
  overrides: z.array(CampaignDeadlineOverrideSchema).optional()
});
export type CampaignDeadline = z.infer<typeof CampaignDeadlineSchema>;

/** THE AUTHOR'S DOOR. See docs/schemas.md §33. */
export const CampaignDeadlineInputSchema = CampaignDeadlineSchema.omit({
  overrides: true
}).strict();
export type CampaignDeadlineInput = z.infer<typeof CampaignDeadlineInputSchema>;

/** `POST /api/v1/campaigns/{id}/deadline` — set, move, or CLEAR. See docs/schemas.md §34. */
export const SetCampaignDeadlineRequestSchema = z.object({
  /** The new deadline, or `null` to clear it. See docs/schemas.md §35. */
  deadline: CampaignDeadlineInputSchema.nullable(),
  reason: z.string().min(1)
});
export type SetCampaignDeadlineRequest = z.infer<typeof SetCampaignDeadlineRequestSchema>;

/** `POST /api/v1/campaigns/{id}/deadline-override` (M25.6b, §4.5). See docs/schemas.md §36. */
export const OverrideCampaignDeadlineRequestSchema = z.object({
  /** WHICH targets to excuse. See docs/schemas.md §37. */
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
  id: z.string().uuid(),
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
  /** The campaign's deadline, or null when it declares none. See docs/schemas.md §38. */
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
  /** WHICH pipeline every change this campaign fans out rolls. See docs/schemas.md §39. */
  type: ExecutorTypeSchema.optional(),
  /** M25.4 (owner decision D3) — ONE authored trigger intent, fanned across every target. This is
   *  the whole of "1-click": configure it once here and 47 components each get their own member
   *  Change, wave-ordered, governed, and triggered against their OWN already-bound executor with
   *  these parameters. SCP writes no patch (charter principle 1) — see `CampaignRecipeSchema`. */
  recipe: CampaignRecipeSchema.optional(),
  /** The date past which this campaign stops fanning out. See docs/schemas.md §40. */
  deadline: CampaignDeadlineInputSchema.optional(),
  targets: z.array(z.string().min(1)).min(1)
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequestSchema>;

export const CampaignListQuerySchema = CursorPageQuerySchema.extend({
  status: CampaignStatusSchema.optional(),
  /** Narrow the page to the containment subtree of ONE object. See docs/schemas.md §41. */
  scopeObjectId: z.string().uuid().optional()
});
export type CampaignListQuery = z.infer<typeof CampaignListQuerySchema>;

export const CampaignListResponseSchema = cursorPageResponseSchema(CampaignSchema);
export type CampaignListResponse = z.infer<typeof CampaignListResponseSchema>;

export const CampaignIdParamSchema = z.object({ id: z.string().uuid() });

export const RollbackCampaignRequestSchema = z.object({
  reason: z.string().min(1)
});
export type RollbackCampaignRequest = z.infer<typeof RollbackCampaignRequestSchema>;

/** `POST /campaigns/{id}/rollback` response. See docs/schemas.md §42. */
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
  /** THE WAVE-TARGET FREEZE-HOLD PROJECTION, campaign side. See docs/schemas.md §43. */
  hold: z
    .object({
      freezes: z.array(
        z.object({
          freezeId: z.string().uuid(),
          scope: z.object({ objectId: z.string().uuid(), name: z.string().nullable() }).nullable(),
          summary: z.string(),
          endsAt: z.string().datetime()
        })
      )
    })
    .optional(),
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
  /** SERVER-COMPUTED COUNT of this wave's currently-held targets. See docs/schemas.md §44. */
  heldTargetCount: z.number().int().nonnegative().optional(),
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

// M25.5 — `GET /campaigns/{id}/adoption`, the READ surface over the same one predicate

/** THREE VALUES, AND THE THIRD IS NOT A DEGRADED SECOND. See docs/schemas.md §45. */
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
  /** The EVIDENCE ITSELF, one line per observed fact. See docs/schemas.md §46. */
  observations: z.array(z.string())
});
export type CampaignAdoptionTarget = z.infer<typeof CampaignAdoptionTargetSchema>;

/** The per-target answer to has this component migrated. See docs/schemas.md §47. */
export const CampaignAdoptionResponseSchema = z.object({
  campaignObjectId: z.string().uuid(),
  /** The campaign recipe's declared evidence source, echoed back — `null` when the recipe declares
   *  none (or carries no recipe at all), in which case every target below is `unknown`. Echoed
   *  rather than described so an operator can see the exact document the verdicts were derived from
   *  without a second call. */
  evidence: AdoptionEvidenceSchema.nullable(),
  targets: z.array(CampaignAdoptionTargetSchema),
  /** Declared targets that resolved to no live object. See docs/schemas.md §48. */
  unresolvedTargets: z.array(z.string())
});
export type CampaignAdoptionResponse = z.infer<typeof CampaignAdoptionResponseSchema>;
