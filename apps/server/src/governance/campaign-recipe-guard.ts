import { CAMPAIGN_RECIPE_PROPERTY_KEY, CampaignRecipeSchema } from "@scp/schemas";
import { badRequest } from "../errors.js";
import { describeRecipeIssues } from "../coordination/campaign-recipe.js";

/** The local author's door for a campaign's recipe. See docs/governance.md §23. */
export function assertValidCampaignRecipe(args: {
  typeId: string;
  properties: Record<string, unknown>;
}): void {
  // Only a `campaign` AUTHORS one. A `recipe` key on any other type is not read by the fan-out (it
  // reads the campaign object) and refusing it here would reject documents that mean nothing rather
  // than documents that mean the wrong thing. `change` is the one type that also CARRIES a recipe,
  // and it is excluded on purpose — see the module doc.
  if (args.typeId !== "campaign") return;
  const raw = args.properties[CAMPAIGN_RECIPE_PROPERTY_KEY];
  // ABSENT IS FINE — the overwhelmingly common shape, and the one every campaign created before
  // M25.4 is in. This guard bounds what a recipe MAY SAY; it never requires one.
  if (raw === undefined || raw === null) return;
  const parsed = CampaignRecipeSchema.safeParse(raw);
  if (parsed.success) return;
  // The same bound as the trigger-time refusal, one function. See docs/governance.md §24.
  const detail = describeRecipeIssues(parsed.error.issues);
  throw badRequest(
    `campaign 'properties.${CAMPAIGN_RECIPE_PROPERTY_KEY}' is invalid — ${detail}. ` +
      `A recipe is exactly {"version": 1, "trigger": {"kind": "sync"|"workflow_dispatch"|"custom", ` +
      `"parameters"?: {...}}, "guidance"?: {...}} (ADR-0041). It names a trigger CommanderSCP asks ` +
      `each target's already-bound executor for — it never carries a patch, a file or a command, ` +
      `and it may not name 'rollback'. A misspelled key would be stored and then read at trigger ` +
      `time as no recipe at all, so every target would roll a bare sync and the campaign would go ` +
      `green having coordinated nothing.`
  );
}
