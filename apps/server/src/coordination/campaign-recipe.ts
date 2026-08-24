import type { ExecutorCapabilities, TriggerIntent } from "@scp/plugin-api";
import { CAMPAIGN_RECIPE_PROPERTY_KEY, CampaignRecipeSchema, type CampaignRecipe } from "@scp/schemas";

/**
 * M25.4 — THE READ SIDE of the campaign recipe (owner decision D3). One module, so the fan-out, the
 * trigger and the capability refusal all read the same document the same way.
 *
 * The write side is `governance/campaign-recipe-guard.ts` (strict, at the `objects-repo` choke
 * point, `campaign` only). This side is what runs on the hot path, and it has two jobs:
 *
 *   1. Turn a change's free-form `properties` into a parsed recipe, a "there isn't one", or a
 *      NAMED refusal — never into a silent absence.
 *   2. Answer whether the executor this target actually resolved to can serve the recipe's kind.
 *
 * INERTNESS IS A PROPERTY, NOT A NICETY. `resolveChangeRecipe` returns `{ outcome: "none" }` on a
 * pure key-absence check before any parsing, and the overwhelming majority of changes on the
 * instance carry no recipe. This runs once per wave target per trigger.
 */

/**
 * The terminal wave-target status for "the bound executor cannot serve this recipe's trigger kind".
 *
 * A DEDICATED status, on the `no_executor` / `target_deleted` precedent and for the same reason
 * `terminalizeRefusedWaveTarget` takes the status as a PARAMETER rather than a literal: reporting
 * this as `no_executor` would be the provenance-label mistake — a label named after the branch that
 * happened to match rather than after what is true. There IS a binding here, and it IS for the right
 * Type; what it cannot do is the verb the recipe asked for. An operator told "no executor binding"
 * would go and create the binding that already exists.
 *
 * `change_wave_targets.status` is plain `text` with no CHECK constraint and `ChangeWaveTargetSchema.
 * status` is `z.string()`, so a new value costs NO migration and is API-additive within /v1 — the
 * same three facts ADR-0006 §"no migration" recorded for `no_executor`.
 */
export const WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS = "recipe_unsupported";

/** The hash-chained audit action for that refusal, sibling of `change.wave_target.no_executor`. */
export const WAVE_TARGET_RECIPE_UNSUPPORTED_AUDIT_ACTION = "change.wave_target.recipe_unsupported";

/**
 * The terminal wave-target status for "this change carries a recipe that does not parse".
 *
 * A SECOND status rather than a `cause` field on the first, and that is `terminalizeRefusedWaveTarget`'s
 * stated rule rather than a preference: it takes the status as a PARAMETER "precisely so a second
 * cause could not be smuggled in under the first one's name". The two causes have DIFFERENT remedies
 * and different owners — `recipe_unsupported` is fixed by binding a different executor (or narrowing
 * the campaign's targets), `recipe_unreadable` by fixing the document — so collapsing them would send
 * an operator to the wrong surface.
 *
 * Reachable only from the two doors the authoring guard deliberately does not cover: a promoted
 * change from a peer speaking a newer recipe vocabulary, and a hand-authored `POST /changes`. See
 * `governance/campaign-recipe-guard.ts` for why those are left to fail HERE rather than at the
 * write door (a 400 on the promotion path is deferred and retried forever by
 * `federation/inbox-loop.ts`).
 */
export const WAVE_TARGET_RECIPE_UNREADABLE_STATUS = "recipe_unreadable";

/** The hash-chained audit action for that refusal. */
export const WAVE_TARGET_RECIPE_UNREADABLE_AUDIT_ACTION = "change.wave_target.recipe_unreadable";

export type RecipeResolution =
  | { outcome: "none" }
  | { outcome: "recipe"; recipe: CampaignRecipe }
  /** Present but unparseable. NOT "none": see `resolveChangeRecipe`. */
  | { outcome: "malformed"; detail: string };

/**
 * Reads `properties.recipe` off a CHANGE (a campaign fanned it out there, or a promotion bundle
 * carried it in).
 *
 * A MALFORMED RECIPE IS A REFUSAL, NEVER AN ABSENCE, and that is the whole reason this returns three
 * outcomes instead of `CampaignRecipe | undefined`. Degrading to "no recipe" would trigger every one
 * of 47 components with a bare `sync` and no parameters — the campaign would go green, the wave
 * would complete, and nothing whatsoever would have been coordinated. Silence read as a pass is the
 * failure mode this milestone's whole freeze/hold family exists to refuse; a recipe is no different.
 *
 * It is also the fail-closed half of the deliberate `campaign`-only authoring guard (see that
 * module): the shapes that can reach here unvalidated are a promoted change from a peer speaking a
 * newer vocabulary and a hand-authored `POST /changes`. Both get a `decision_id` and a terminal row
 * rather than a wedged bundle or a lie.
 */
export function resolveChangeRecipe(
  properties: Record<string, unknown> | null | undefined
): RecipeResolution {
  if (!properties) return { outcome: "none" };
  const raw = properties[CAMPAIGN_RECIPE_PROPERTY_KEY];
  if (raw === undefined || raw === null) return { outcome: "none" };
  const parsed = CampaignRecipeSchema.safeParse(raw);
  if (parsed.success) return { outcome: "recipe", recipe: parsed.data };
  return {
    outcome: "malformed",
    detail: parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ")
  };
}

/**
 * Can the executor instance this target resolved to serve `kind`?
 *
 * `describeCapabilities().triggerKinds` is the executor's own answer and it is genuinely
 * discriminating — MEASURED across the in-tree adapters at HEAD, not assumed:
 *
 *   | module                       | triggerKinds                              |
 *   |------------------------------|-------------------------------------------|
 *   | github                       | workflow_dispatch, custom                 |
 *   | gitea                        | workflow_dispatch                         |
 *   | gitlab                       | workflow_dispatch                         |
 *   | argocd                       | sync, rollback                            |
 *   | pipeline-generic / terraform | sync, rollback, custom                    |
 *   | managed-dep/-iac/-scan       | (server-driven only — never a recipe)     |
 *   | fake-executor                | sync, workflow_dispatch, rollback, custom |
 *
 * Read from each module's `describeCapabilities()` at HEAD; `terraform` is `pipeline-generic` with
 * TFC-flavoured defaults (`packages/plugins/terraform/src/index.ts` — it re-exports
 * `createPipelineGenericExecutorPlugin()` verbatim), so it is one row, not two.
 *
 * NOT ONE OF THESE SETS IS THE SAME AS ANOTHER, and no adapter serves all four kinds except the
 * fake. `sync` and `workflow_dispatch` are disjoint across `argocd` and `github`/`gitea`/`gitlab` —
 * i.e. a mixed estate cannot be covered by ANY single recipe kind, which is precisely why the
 * refusal has to be explainable per target rather than a global validation at authoring time.
 *
 * So a `workflow_dispatch` recipe fanned across an estate that includes even ONE Argo CD-bound
 * component reaches an executor with no such verb. Without this check, `github`'s and `gitea`'s
 * `intent.parameters?.workflowId ?? config.defaultWorkflowId` fallback means the SILENT failure is
 * not a crash but something worse: the target's default workflow runs instead of the migration one,
 * the run succeeds, and the campaign records a migration that never happened.
 *
 * FAIL-CLOSED ON AN UNDECLARED SET. A capabilities object that omits `triggerKinds` (a third-party
 * plugin predating the field, or a malformed reply) is treated as "cannot serve it" rather than
 * "can serve anything". An executor that does not say what it can do is not evidence that it can do
 * this.
 */
export function executorSupportsTriggerKind(
  capabilities: Pick<ExecutorCapabilities, "triggerKinds"> | null | undefined,
  kind: TriggerIntent["kind"]
): boolean {
  const kinds = capabilities?.triggerKinds;
  if (!Array.isArray(kinds)) return false;
  return kinds.includes(kind);
}

/**
 * What `TriggerIntent.parameters` gets — the recipe's bag, VERBATIM.
 *
 * **NO CROSS-PROVIDER TRANSLATION, and this function is where that decision is enforced by being
 * the only thing that happens.** A recipe written in `github` keys (`workflowId`, `ref`, `inputs`)
 * is never rewritten into `gitlab` shape (`ref`, `variables`) or `argocd` shape (`targetRevision`).
 * Two reasons, both decisive:
 *
 *   * A translation layer would have to re-render a declaration SCP does not fully model, and a
 *     wrong guess does not fail — it triggers the WRONG automation in the tenant's own repository.
 *     `inputs` and `variables` are not the same thing (GitHub validates inputs against the
 *     workflow's declared `workflow_dispatch.inputs`; GitLab variables are free-form CI variables),
 *     so any mapping between them is a guess about semantics.
 *   * The variance a 47-component estate actually has is ALREADY SOLVED one layer down and must not
 *     be re-solved here. `github`/`gitea` resolve `intent.parameters?.workflowId ??
 *     config.defaultWorkflowId`, and each binding already carries its own. The recipe supplies the
 *     MIGRATION parameters; the which-workflow answer stays on the binding, where a genuine outlier
 *     overrides it — never in a 47-entry map on the campaign.
 *
 * The safety valve for the mixed-provider estate is not translation, it is the capability refusal
 * above: a recipe whose kind an executor cannot serve stops loudly with a `decision_id`.
 *
 * Returns `undefined` when the recipe declares no parameters, so the intent stays BYTE-IDENTICAL to
 * a pre-M25.4 trigger (`parameters` absent, not `{}`) — an adapter that distinguishes the two, and
 * `pipeline-generic` passes the bag straight through to a tenant's HTTP endpoint, must not see a new
 * empty object appear on every trigger on the instance.
 */
export function recipeTriggerParameters(recipe: CampaignRecipe): Record<string, unknown> | undefined {
  return recipe.trigger.parameters;
}
