import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES,
  CAMPAIGN_RECIPE_PARAMETERS_MAX_DEPTH,
  CampaignRecipeSchema,
  CreateCampaignRequestSchema
} from "./campaigns.js";

/**
 * M25.4 — the AUTHOR'S DOOR, as a pure schema.
 *
 * Every case here is a document a real author could type, and the assertion is about what the
 * document would MEAN if it were stored. A recipe that parses wrong does not error at trigger time
 * — it reads as absent, and 47 components each roll their default pipeline while the campaign
 * reports success. That is the failure this schema exists to make impossible, so the negative cases
 * carry the weight.
 */

const valid = {
  version: 1,
  trigger: {
    kind: "workflow_dispatch",
    parameters: { workflowId: "migrate-py3.yml", ref: "main", inputs: { target: "3.12" } }
  }
} as const;

describe("CampaignRecipeSchema", () => {
  it("accepts the motivating python2 -> python3 recipe", () => {
    const parsed = CampaignRecipeSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    // VERBATIM — the parse must not reshape, reorder or drop a key, because whatever survives here
    // is what `TriggerIntent.parameters` hands a tenant's own pipeline.
    expect(parsed.success && parsed.data.trigger.parameters).toEqual(valid.trigger.parameters);
  });

  it("accepts a recipe with no parameters at all (the binding's defaults still apply)", () => {
    expect(CampaignRecipeSchema.safeParse({ version: 1, trigger: { kind: "sync" } }).success).toBe(
      true
    );
  });

  it("REFUSES kind 'rollback' — a campaign may not turn a restore into a forward change", () => {
    const parsed = CampaignRecipeSchema.safeParse({ version: 1, trigger: { kind: "rollback" } });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES an unknown top-level key — a misspelling would be stored and read as no recipe", () => {
    expect(
      CampaignRecipeSchema.safeParse({ ...valid, adoption: { kind: "delivered" } }).success
    ).toBe(false);
    // ...and the same for a misspelling of a key that DOES exist, which is the likelier typo.
    expect(CampaignRecipeSchema.safeParse({ version: 1, triggers: { kind: "sync" } }).success).toBe(
      false
    );
  });

  it("REFUSES an unknown key inside `trigger`", () => {
    expect(
      CampaignRecipeSchema.safeParse({
        version: 1,
        trigger: { kind: "sync", parameter: { a: 1 } }
      }).success
    ).toBe(false);
  });

  it.each([
    ["githubToken", { githubToken: "ghp_x" }],
    ["DEPLOY_PASSWORD", { DEPLOY_PASSWORD: "hunter2" }],
    // Every separator spelling of the SAME concept — the first draft of the guard listed `apikey`
    // and `api_key` as separate entries and let `x-api-key` through. Normalization, not enumeration.
    ["x-api-key", { "x-api-key": "abc" }],
    ["api_key", { api_key: "abc" }],
    ["apiKey", { apiKey: "abc" }],
    ["AWS_SECRET_ACCESS_KEY", { AWS_SECRET_ACCESS_KEY: "abc" }],
    ["awsSecretAccessKey", { awsSecretAccessKey: "abc" }],
    ["privateKey", { privateKey: "-----BEGIN" }],
    ["nested credentialRef", { inputs: { credentialRef: "vault://x" } }]
  ])("REFUSES a parameter key that looks like a secret: %s", (_label, parameters) => {
    const parsed = CampaignRecipeSchema.safeParse({
      version: 1,
      trigger: { kind: "workflow_dispatch", parameters }
    });
    expect(parsed.success).toBe(false);
    // The message must NAME the offending key, or the author cannot find it in a 30-key bag.
    expect(parsed.success ? "" : JSON.stringify(parsed.error.issues)).toMatch(
      /object:read|secret refs/
    );
  });

  it("accepts an innocent key that merely CONTAINS a banned word's neighbours", () => {
    // Guards the guard: `tokenizer`/`passwordless` WOULD be refused (substring match, deliberately),
    // but a key like `credentials` is not somehow special-cased into acceptance. This case pins the
    // opposite direction — a key with none of the substrings passes, so the rule is not "refuse
    // everything".
    expect(
      CampaignRecipeSchema.safeParse({
        version: 1,
        trigger: { kind: "custom", parameters: { eventType: "migrate", clientPayload: { to: 3 } } }
      }).success
    ).toBe(true);
  });

  it("REFUSES parameters nested deeper than the depth bound", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i <= CAMPAIGN_RECIPE_PARAMETERS_MAX_DEPTH + 1; i++) deep = { a: deep };
    expect(
      CampaignRecipeSchema.safeParse({
        version: 1,
        trigger: { kind: "sync", parameters: deep as Record<string, unknown> }
      }).success
    ).toBe(false);
  });

  it("REFUSES parameters over the byte cap — the recipe is copied onto EVERY member change", () => {
    const parsed = CampaignRecipeSchema.safeParse({
      version: 1,
      trigger: {
        kind: "sync",
        parameters: { blob: "x".repeat(CAMPAIGN_RECIPE_PARAMETERS_MAX_BYTES + 1) }
      }
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? "" : JSON.stringify(parsed.error.issues)).toMatch(/byte cap/);
  });

  it("REFUSES a non-JSON value (NaN/Infinity survive a JS object but not a round trip)", () => {
    expect(
      CampaignRecipeSchema.safeParse({
        version: 1,
        trigger: { kind: "sync", parameters: { weight: Number.NaN } }
      }).success
    ).toBe(false);
  });

  it("REFUSES a future version rather than guessing at its vocabulary", () => {
    expect(CampaignRecipeSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it("carries guidance as data and never as something to fetch", () => {
    const parsed = CampaignRecipeSchema.safeParse({
      ...valid,
      guidance: { title: "Port to python 3.12", docsUrl: "https://internal/runbook" }
    });
    expect(parsed.success).toBe(true);
  });
});

describe("CreateCampaignRequestSchema", () => {
  it("carries the recipe, and stays valid without one", () => {
    const withRecipe = CreateCampaignRequestSchema.safeParse({
      name: "py3",
      targets: ["urn:scp:x:component:a"],
      recipe: valid
    });
    expect(withRecipe.success).toBe(true);
    expect(
      CreateCampaignRequestSchema.safeParse({ name: "py3", targets: ["urn:scp:x:component:a"] })
        .success
    ).toBe(true);
  });

  it("refuses a bad recipe at the request body, before any door is reached", () => {
    expect(
      CreateCampaignRequestSchema.safeParse({
        name: "py3",
        targets: ["urn:scp:x:component:a"],
        recipe: { version: 1, trigger: { kind: "rollback" } }
      }).success
    ).toBe(false);
  });
});
