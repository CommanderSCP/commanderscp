import { CAMPAIGN_RECIPE_PROPERTY_KEY, CampaignRecipeSchema } from "@scp/schemas";
import { badRequest } from "../errors.js";

/**
 * M25.4 (owner decision D3) — THE LOCAL AUTHOR'S DOOR for a campaign's coordination recipe.
 *
 * ===========================================================================================
 * WHY THIS IS INSTALLED AT `graph/objects-repo.ts` AND NOT AT `routes/campaigns.ts`
 * ===========================================================================================
 * `campaign.properties` has exactly THREE write doors, and the typed route is only one of them:
 *
 *   1. `POST /api/v1/campaigns` -> `coordination/campaign-repo.ts::proposeCampaign` -> `createObject`
 *   2. **IaC apply** -> `iac/plans-repo.ts:1373/1396` -> `createObject` / `updateObject` DIRECTLY,
 *      with a free-form `typeId` and free-form `properties`. It never touches the campaign route,
 *      so a guard installed there is invisible to it. (`plans-repo.ts:991` records this exact class
 *      of miss already: "apply calls `createObject` DIRECTLY, so the route's refusal never ran
 *      here.")
 *   3. **Federation import** -> `federation/import-repo.ts`'s `object_upsert` branch, and its
 *      operator-facing twin `federation/handfill-repo.ts`.
 *
 * The generic `/objects/{type}` route is NOT a fourth door: `coordination/campaign-scope-authz.ts`
 * refuses `campaign` (and `change`) on every write verb there. So the census is three, two of which
 * a route-level guard misses — which is the precedent `governance/component-declaration-guard.ts`
 * records from ADR-0032 §6a, where the same mistake left three doors open. `createObject` /
 * `updateObject` is the one choke point every LOCAL write funnels through, so that is where it goes.
 *
 * ===========================================================================================
 * WHY `campaign` ONLY, AND NOT ALSO `change` — the deliberate half of the census
 * ===========================================================================================
 * The recipe is READ off a member CHANGE's properties at trigger time (`coordination/reconcile.ts`),
 * not off the campaign, so "census by property" points straight at `change` as well. It is
 * deliberately NOT guarded here, and the reason is measured rather than aesthetic:
 *
 *   * `federation/promotion-repo.ts::importPromotionBundle` re-proposes a promoted change LOCALLY
 *     via `proposeChange` -> `createObject` with **`federationImport` UNSET** (it is a locally
 *     authored change carrying the exporter's properties). A refusal on `change` therefore fires on
 *     the promotion path.
 *   * `federation/inbox-loop.ts:552-556` DEFERS a 400 and retries it next tick — forever. So a
 *     promoted change whose recipe an OLDER outpost cannot parse would not fail once and surface; it
 *     would loop silently. That is the version-skew wedge 0043/0075 exist to prevent, arriving
 *     through the promotion door instead of the journal door.
 *
 * The gap that leaves is closed at the OTHER end, fail-closed: `coordination/campaign-recipe.ts`
 * `safeParse`s the recipe at trigger time and REFUSES the wave target — block Decision with a
 * resolvable `decision_id`, hash-chained audit event — on a malformed one. So an unparseable recipe
 * never silently degrades to "trigger with no parameters"; it stops, explainably, at the actuator
 * instead of wedging a bundle at the door. Strict where a human is standing there to read the 400;
 * loud-and-terminal where they are not.
 *
 * ===========================================================================================
 * WHAT A REFUSAL ACTUALLY PREVENTS
 * ===========================================================================================
 * `{"recipie": {...}}`, or a recipe with `trigger.kind: "rollback"`, or a `parameters` bag holding
 * `githubToken`. The first is stored happily and read at trigger time as NO recipe — every one of 47
 * components triggers a bare sync and the campaign goes green having coordinated nothing. The second
 * would turn a forward migration into a restore. The third publishes a credential into 47 changes'
 * `properties`, readable at `object:read` and carried through federation, where no later fix can
 * un-publish it.
 */
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
  const detail = parsed.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
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
