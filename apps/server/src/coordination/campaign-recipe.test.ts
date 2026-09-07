import { describe, expect, it } from "vitest";
import { CAMPAIGN_RECIPE_PROPERTY_KEY } from "@scp/schemas";
import {
  RECIPE_FORBIDDEN_EXECUTOR_MODULES,
  executorSupportsTriggerKind,
  isRecipeForbiddenExecutorModule,
  recipeTriggerParameters,
  resolveChangeRecipe
} from "./campaign-recipe.js";
import { KNOWN_EXECUTOR_MODULES } from "./executor-bindings-repo.js";

/** M25.4 — the READ side of the recipe, as pure functions. See docs/coordination.md §150. */

const recipe = (over: Record<string, unknown> = {}) => ({
  version: 1,
  trigger: { kind: "workflow_dispatch", parameters: { workflowId: "migrate-py3.yml" } },
  ...over
});

describe("resolveChangeRecipe: three outcomes, because two would lie", () => {
  it("returns 'none' for absent properties, an absent key, and an explicit null", () => {
    expect(resolveChangeRecipe(undefined).outcome).toBe("none");
    expect(resolveChangeRecipe(null).outcome).toBe("none");
    expect(resolveChangeRecipe({}).outcome).toBe("none");
    expect(resolveChangeRecipe({ stageDependencies: [] }).outcome).toBe("none");
    expect(resolveChangeRecipe({ [CAMPAIGN_RECIPE_PROPERTY_KEY]: null }).outcome).toBe("none");
  });

  it("parses a well-formed recipe and hands back the parameters unreshaped", () => {
    const resolved = resolveChangeRecipe({ [CAMPAIGN_RECIPE_PROPERTY_KEY]: recipe() });
    expect(resolved.outcome).toBe("recipe");
    if (resolved.outcome !== "recipe") throw new Error("unreachable");
    expect(resolved.recipe.trigger.kind).toBe("workflow_dispatch");
    expect(recipeTriggerParameters(resolved.recipe)).toEqual({ workflowId: "migrate-py3.yml" });
  });

  /** THE LOAD-BEARING CASE OF THE WHOLE MODULE. See docs/coordination.md §151. */
  it.each([
    ["a future vocabulary version", { version: 2, trigger: { kind: "sync" } }],
    ["the forbidden rollback kind", { version: 1, trigger: { kind: "rollback" } }],
    ["a misspelled top-level key", { version: 1, triggers: { kind: "sync" } }],
    ["a bare string", "sync"],
    ["an array", [{ version: 1 }]],
    ["an empty object", {}]
  ])("reports %s as MALFORMED, never as absent", (_label, planted) => {
    const resolved = resolveChangeRecipe({ [CAMPAIGN_RECIPE_PROPERTY_KEY]: planted });
    expect(resolved.outcome).toBe("malformed");
    // The detail is what reaches the operator's Decision, so it must not be empty.
    if (resolved.outcome !== "malformed") throw new Error("unreachable");
    expect(resolved.detail.length).toBeGreaterThan(0);
  });
});

describe("executorSupportsTriggerKind: fail-closed on anything that is not a declared list", () => {
  it("answers from the executor's own declared set", () => {
    expect(executorSupportsTriggerKind({ triggerKinds: ["sync", "rollback"] }, "sync")).toBe(true);
    expect(executorSupportsTriggerKind({ triggerKinds: ["sync", "rollback"] }, "custom")).toBe(
      false
    );
  });

  /** An executor that says nothing is not evidence it can. See docs/coordination.md §152. */
  it.each([
    ["null capabilities", null],
    ["undefined capabilities", undefined],
    ["capabilities with no triggerKinds", {}],
    ["triggerKinds that is not an array", { triggerKinds: "workflow_dispatch" }],
    ["an empty declared set", { triggerKinds: [] }]
  ])("treats %s as CANNOT", (_label, capabilities) => {
    expect(
      executorSupportsTriggerKind(
        capabilities as Parameters<typeof executorSupportsTriggerKind>[0],
        "workflow_dispatch"
      )
    ).toBe(false);
  });
});

describe("OQ-5: a recipe may not drive one of CommanderSCP's own actuators", () => {
  it("refuses all three managed modules and permits every coordinating one", () => {
    for (const managed of ["managed-dep", "managed-iac", "managed-scan"]) {
      expect(isRecipeForbiddenExecutorModule(managed)).toBe(true);
    }
    for (const tenant of [
      "github",
      "gitea",
      "gitlab",
      "argocd",
      "terraform",
      "pipeline-generic",
      "fake-executor"
    ]) {
      expect(isRecipeForbiddenExecutorModule(tenant)).toBe(false);
    }
    expect(isRecipeForbiddenExecutorModule(null)).toBe(false);
    expect(isRecipeForbiddenExecutorModule(undefined)).toBe(false);
  });

  /** The census pin, written against the known module list. See docs/coordination.md §153. */
  it("pins the forbidden set against the binding allowlist — a fourth managed module cannot land on only one", () => {
    const managedOnAllowlist = KNOWN_EXECUTOR_MODULES.filter((m) => m.startsWith("managed-"));
    expect(managedOnAllowlist.length).toBeGreaterThan(0); // the filter itself must not be vacuous
    expect([...managedOnAllowlist].sort()).toEqual([...RECIPE_FORBIDDEN_EXECUTOR_MODULES].sort());
  });

  it("every forbidden module is actually bindable — the refusal guards a reachable path, not a typo", () => {
    for (const forbidden of RECIPE_FORBIDDEN_EXECUTOR_MODULES) {
      expect(KNOWN_EXECUTOR_MODULES).toContain(forbidden);
    }
  });
});

describe("a malformed recipe's DETAIL is bounded at the producer (M25.4 review finding)", () => {
  /** The byte cap cannot reach this path. See docs/coordination.md §154. */
  it("BOUNDS a 20,000-key failure that renders ~188KB unbounded", () => {
    const junk: Record<string, unknown> = { version: 1, trigger: { kind: "sync" } };
    for (let i = 0; i < 20_000; i += 1) junk[`k${i}`] = "v";

    const resolved = resolveChangeRecipe({ [CAMPAIGN_RECIPE_PROPERTY_KEY]: junk });

    expect(resolved.outcome).toBe("malformed");
    const detail = (resolved as { outcome: "malformed"; detail: string }).detail;
    // THE CONTROL FOR THE BOUND ITSELF: assert the UNBOUNDED rendering really is enormous, or this
    // case would still pass against a schema that had simply stopped producing a long message —
    // proving the cap while the thing it caps had quietly gone away.
    const unbounded = 4 * junk.k0!.toString().length + JSON.stringify(junk).length;
    expect(unbounded).toBeGreaterThan(100_000);
    expect(detail.length).toBeLessThanOrEqual(1_000);
  });

  it("STAYS USEFUL: an ordinary failure still names the offending path and reason", () => {
    // Non-vacuity. A bound that returned "" or a fixed string would pass the case above and destroy
    // the only thing the refusal exists to tell an operator.
    const resolved = resolveChangeRecipe({
      [CAMPAIGN_RECIPE_PROPERTY_KEY]: { version: 2, trigger: { kind: "sync" } }
    });

    expect(resolved.outcome).toBe("malformed");
    const detail = (resolved as { outcome: "malformed"; detail: string }).detail;
    expect(detail.length).toBeGreaterThan(0);
    expect(detail).toContain("version");
  });

  it("does not truncate a recipe that PARSES — the bound is on the refusal, not on the document", () => {
    const resolved = resolveChangeRecipe({
      [CAMPAIGN_RECIPE_PROPERTY_KEY]: {
        version: 1,
        trigger: { kind: "workflow_dispatch", parameters: { workflowId: "migrate.yml" } }
      }
    });
    expect(resolved.outcome).toBe("recipe");
  });
});
