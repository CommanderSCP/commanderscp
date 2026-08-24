import type { ExecutorCapabilities, TriggerIntent } from "@scp/plugin-api";
import { boundText } from "@scp/runner-launcher";
import {
  CAMPAIGN_RECIPE_PROPERTY_KEY,
  CampaignRecipeSchema,
  type CampaignRecipe
} from "@scp/schemas";

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

/**
 * The terminal wave-target status for "this target is bound to one of CommanderSCP's OWN managed
 * actuators, and a recipe may not drive those".
 *
 * ===========================================================================================
 * OQ-5 IS UNRULED, AND THE CAPABILITY CHECK ALONE DOES NOT ENFORCE IT
 * ===========================================================================================
 * The capability check above asks the executor whether it can serve the recipe's kind. MEASURED at
 * HEAD, all three managed actuators answer YES to `"custom"`:
 *
 *   | module       | triggerKinds                | what `custom` means to it                       |
 *   |--------------|-----------------------------|-------------------------------------------------|
 *   | managed-dep  | ["custom"]                  | `parameters.action: "bump" \| "merge"` — WRITES  |
 *   |              |                             | a commit to a tenant repository                 |
 *   | managed-scan | ["custom"]                  | `parameters.inputDir/outputDir` — server-owned  |
 *   | managed-iac  | ["sync","rollback","custom"]| `parameters.sourceFiles` — authored file bodies |
 *
 * So a recipe of `{kind:"custom", parameters:{action:"bump", ...}}` PASSES
 * `executorSupportsTriggerKind` against a `managed-dep` binding, and reconcile would hand those
 * author-controlled parameters straight to the bump actuator. That is precisely the wiring OQ-5
 * leaves unruled and this increment was told not to build — reached transitively rather than by a
 * direct call, which is exactly how an unruled coupling gets built by accident.
 *
 * It is not hypothetical reachability. `managed-dep` is on `KNOWN_EXECUTOR_MODULES`, and
 * `executor-bindings-repo.ts` states plainly that server settings "are still injected below for a
 * managed-dep binding an operator creates by hand" — so a hand-created binding is a supported shape
 * that `resolveBindingForTarget` resolves like any other.
 *
 * WHAT M25.4 CHANGED. Before this increment the generic release path passed NO `parameters` at all,
 * so `managed-dep.trigger()` threw on its own missing-`action` check and the path was INERT. Wiring
 * `parameters` is what makes it live. The refusal restores the inertness deliberately instead of
 * leaving it as an emergent property of an unwired channel — the "component built, never installed"
 * failure running in reverse.
 *
 * A THIRD STATUS, not a reuse of `recipe_unsupported`, and by this module's own stated rule: the
 * remedy is different in kind. `recipe_unsupported` is fixed by binding an executor that HAS the
 * verb; there is no such fix here, because the refusal is a governance boundary rather than a
 * capability gap. An operator told "this executor cannot perform a 'custom' trigger" would go and
 * confirm that `managed-dep` declares exactly that verb, and conclude SCP was lying to them.
 */
export const WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS = "recipe_managed_executor";

/** The hash-chained audit action for that refusal. */
export const WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_AUDIT_ACTION =
  "change.wave_target.recipe_managed_executor";

/**
 * CommanderSCP's OWN actuators — the modules that act under a scoped charter grant rather than
 * coordinating a tenant's existing pipeline. A recipe may not drive any of them.
 *
 * The membership test is "does this module perform work under the Managed Execution Exception",
 * which is the same test the charter applies, and all three current members are named there
 * (`scp-managed-iac`, `scp-managed-scan`, `scp-managed-dep`). A fourth managed executor added later
 * must join this list in the same commit that adds it to `KNOWN_EXECUTOR_MODULES` — see
 * `campaign-recipe.integration.test.ts`, which pins the two lists against each other so a new
 * managed module cannot land on only one.
 */
export const RECIPE_FORBIDDEN_EXECUTOR_MODULES: readonly string[] = [
  "managed-dep",
  "managed-iac",
  "managed-scan"
];

/** Is `module` one of CommanderSCP's own actuators? See {@link RECIPE_FORBIDDEN_EXECUTOR_MODULES}. */
export function isRecipeForbiddenExecutorModule(module: string | null | undefined): boolean {
  return (
    module !== null && module !== undefined && RECIPE_FORBIDDEN_EXECUTOR_MODULES.includes(module)
  );
}

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
  return { outcome: "malformed", detail: describeRecipeIssues(parsed.error.issues) };
}

/**
 * How many issues the refusal names, and how long each one and the whole may be.
 *
 * THE CAP ON THE DETAIL IS NOT COSMETIC — it is the one path on which
 * `CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES` structurally CANNOT protect anything. That cap is a
 * `superRefine` on `CampaignRecipeSchema`, so it runs only when the document PARSES; a document
 * that does not parse never reaches it, and the malformed branch is by definition the branch where
 * it did not.
 *
 * What that left open, measured against this repo's own zod at HEAD: a recipe carrying 20,000
 * unrecognised keys produces ONE issue whose message enumerates every one of them — **188,915
 * bytes** from a single strict-object failure. `POST /api/v1/changes` accepts free-form
 * `properties`, and a `change` is deliberately NOT covered by the campaign authoring guard (see
 * `governance/campaign-recipe-guard.ts` for why the promotion path must fail HERE rather than at a
 * write door), so that string is one authenticated call away — and it is then written FOUR times,
 * all of them permanent: the Decision's `inputContext`, the Decision's `reasonTree.summary`, the
 * hash-chained audit event's `reason`, and the `audit_segment` payload that rides signed federation
 * bundles to peers. Half a megabyte of permanent record per call, scaling linearly with the junk.
 *
 * That is the unbounded-growth shape ADR-0024 was written for, arriving through the one door the
 * byte cap does not cover.
 *
 * ISSUES ARE CAPPED **AND** EACH ONE IS CUT, because either alone is insufficient: capping the
 * count does not help when a SINGLE issue is 188 KB, and cutting only the joined string lets one
 * enormous first issue crowd out the four that follow it — so the reader loses exactly the
 * information the refusal exists to give them.
 */
const RECIPE_ISSUE_LIMIT = 5;
const RECIPE_ISSUE_MAX_CHARS = 300;
const RECIPE_DETAIL_MAX_CHARS = 1_000;

/**
 * The operator-facing rendering of why a recipe did not parse, BOUNDED AT THE PRODUCER.
 *
 * Bounded here rather than at each of the four writers, and that placement is the point: a cap
 * applied at the Decision would leave the audit event unbounded, and a reviewer checking any one
 * writer would find it guarded. One producer, one bound, and every consumer inherits it.
 *
 * `boundText(…, 0)` is `@scp/runner-launcher`'s shared primitive with a HEAD-ONLY bound — its own
 * docblock names that as "the right shape for a short diagnostic preview, where a reserved tail
 * would leave almost no head", and offers itself precisely so this is not "another bare `.slice`".
 * A bare slice cuts at UTF-16 CODE-UNIT offsets, which splits surrogate pairs, which `jsonb`
 * refuses, which throws inside the enclosing transaction — this repository's own worked example
 * (BUILD_AND_TEST §4.4a), where that exact sequence stopped a coordination loop for 13 days behind
 * a green health check. The same primitive also sanitises NULs and already-ill-formed input, which
 * an author-controlled string decoded from anywhere is entitled to contain.
 *
 * The remedy an operator needs is "fix the document", and the first few problems are what serves
 * it. Twenty thousand key names do not.
 */
export function describeRecipeIssues(
  issues: readonly { path: PropertyKey[]; message: string }[]
): string {
  const rendered = issues
    .slice(0, RECIPE_ISSUE_LIMIT)
    .map((i) =>
      boundText(
        `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
        RECIPE_ISSUE_MAX_CHARS,
        0
      )
    )
    .join("; ");
  const suffix =
    issues.length > RECIPE_ISSUE_LIMIT
      ? ` (and ${issues.length - RECIPE_ISSUE_LIMIT} further issue(s))`
      : "";
  return boundText(`${rendered}${suffix}`, RECIPE_DETAIL_MAX_CHARS, 0);
}

/**
 * Can the executor instance this target resolved to serve `kind`?
 *
 * `describeCapabilities().triggerKinds` is the executor's own answer and it is genuinely
 * discriminating — MEASURED across the in-tree adapters at HEAD, not assumed:
 *
 *   | module                       | triggerKinds                              | src line |
 *   |------------------------------|-------------------------------------------|----------|
 *   | github                       | workflow_dispatch, custom                 | :652     |
 *   | gitea                        | workflow_dispatch                         | :542     |
 *   | gitlab                       | workflow_dispatch                         | :492     |
 *   | argocd                       | sync, rollback                            | :599     |
 *   | pipeline-generic / terraform | sync, rollback, custom                    | :222     |
 *   | managed-iac                  | sync, rollback, custom                    | :632     |
 *   | managed-dep                  | custom                                    | :1155    |
 *   | managed-scan                 | custom                                    | :446     |
 *   | fake-executor                | sync, workflow_dispatch, rollback, custom | :386     |
 *
 * Read from each module's `describeCapabilities()` at HEAD; `terraform` is `pipeline-generic` with
 * TFC-flavoured defaults (`packages/plugins/terraform/src/index.ts` — it re-exports
 * `createPipelineGenericExecutorPlugin()` verbatim), so it is one row, not two.
 *
 * THE MANAGED ROWS ARE REAL SETS, NOT A DASH. An earlier draft of this table wrote them off as
 * "(server-driven only — never a recipe)", which described the INTENT and not the code: all three
 * declare `"custom"`, so all three PASS the check below. "Never a recipe" is enforced by
 * {@link RECIPE_FORBIDDEN_EXECUTOR_MODULES}, not by this function — see that constant for why the
 * distinction is the whole of OQ-5.
 *
 * No adapter serves all four kinds except the fake, and `sync` and `workflow_dispatch` are disjoint
 * across `argocd` and `github`/`gitea`/`gitlab` — i.e. a mixed estate cannot be covered by ANY
 * single recipe kind, which is precisely why the refusal has to be explainable per target rather
 * than a global validation at authoring time. (The sets are NOT all distinct from one another —
 * `gitea` and `gitlab` are both exactly `["workflow_dispatch"]`, and `managed-iac` matches
 * `pipeline-generic` — so nothing may infer a module's identity from its capability set.)
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
export function recipeTriggerParameters(
  recipe: CampaignRecipe
): Record<string, unknown> | undefined {
  return recipe.trigger.parameters;
}
