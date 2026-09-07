import type { ExecutorCapabilities, TriggerIntent } from "@scp/plugin-api";
import { boundText } from "@scp/runner-launcher";
import {
  CAMPAIGN_RECIPE_PROPERTY_KEY,
  CampaignRecipeSchema,
  type CampaignRecipe
} from "@scp/schemas";

/** M25.4 — THE READ SIDE of the campaign recipe. See docs/coordination.md §155. */

/** Terminal status when the executor cannot serve the kind. See docs/coordination.md §156. */
export const WAVE_TARGET_RECIPE_UNSUPPORTED_STATUS = "recipe_unsupported";

/** The hash-chained audit action for that refusal, sibling of `change.wave_target.no_executor`. */
export const WAVE_TARGET_RECIPE_UNSUPPORTED_AUDIT_ACTION = "change.wave_target.recipe_unsupported";

/** Terminal status when the recipe does not parse. See docs/coordination.md §157. */
export const WAVE_TARGET_RECIPE_UNREADABLE_STATUS = "recipe_unreadable";

export const WAVE_TARGET_RECIPE_UNREADABLE_AUDIT_ACTION = "change.wave_target.recipe_unreadable";

/** Terminal status when the target is a managed actuator. See docs/coordination.md §158. */
export const WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_STATUS = "recipe_managed_executor";

export const WAVE_TARGET_RECIPE_MANAGED_EXECUTOR_AUDIT_ACTION =
  "change.wave_target.recipe_managed_executor";

/** CommanderSCP's OWN actuators. See docs/coordination.md §159. */
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

/** Reads `properties.recipe` off a CHANGE. See docs/coordination.md §160. */
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

/** How many issues the refusal names, and how long. See docs/coordination.md §161. */
const RECIPE_ISSUE_LIMIT = 5;
const RECIPE_ISSUE_MAX_CHARS = 300;
const RECIPE_DETAIL_MAX_CHARS = 1_000;

/** Why a recipe did not parse, bounded at the producer. See docs/coordination.md §162. */
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

/** Can this target's executor serve this trigger kind. See docs/coordination.md §163. */
export function executorSupportsTriggerKind(
  capabilities: Pick<ExecutorCapabilities, "triggerKinds"> | null | undefined,
  kind: TriggerIntent["kind"]
): boolean {
  const kinds = capabilities?.triggerKinds;
  if (!Array.isArray(kinds)) return false;
  return kinds.includes(kind);
}

/** What `TriggerIntent.parameters` gets. See docs/coordination.md §164. */
export function recipeTriggerParameters(
  recipe: CampaignRecipe
): Record<string, unknown> | undefined {
  return recipe.trigger.parameters;
}
