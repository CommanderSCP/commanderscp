import { describe, expect, it } from "vitest";
import {
  infraApplyTemplateFor,
  InfrastructureChangeDeclarationSchema,
  INFRA_CATALOG_APPLY_TEMPLATE,
  INFRA_CATALOG_PLAN_TEMPLATE
} from "./infrastructure-lane.js";

describe("infraApplyTemplateFor — the apply template is DERIVED from the bound plan template (ADR-0056)", () => {
  it("maps the shipped plan template to the shipped apply template", () => {
    expect(infraApplyTemplateFor(INFRA_CATALOG_PLAN_TEMPLATE)).toBe(INFRA_CATALOG_APPLY_TEMPLATE);
  });

  it("maps an org's own '<name>-plan[-vN]' template to its '-apply' sibling", () => {
    expect(infraApplyTemplateFor("acme-net-plan")).toBe("acme-net-apply");
    expect(infraApplyTemplateFor("acme-net-plan-v3")).toBe("acme-net-apply-v3");
  });

  it("returns null for a name with no trailing '-plan' segment — including an APPLY template", () => {
    // The property this exists for: a binding naming the apply template directly must not be
    // accepted as a plan template, or a PLAN change's trigger would run an apply.
    expect(infraApplyTemplateFor(INFRA_CATALOG_APPLY_TEMPLATE)).toBeNull();
    expect(infraApplyTemplateFor("acme-network")).toBeNull();
    expect(infraApplyTemplateFor("plan")).toBeNull();
    expect(infraApplyTemplateFor("acme-plan-v1-extra")).toBeNull();
  });
});

describe("InfrastructureChangeDeclarationSchema", () => {
  it("accepts exactly { applyPlan: <uuid> }", () => {
    const id = "01a0d160-9479-7769-91ea-d3c1cf6dd393";
    expect(InfrastructureChangeDeclarationSchema.parse({ applyPlan: id })).toEqual({
      applyPlan: id
    });
  });

  it("refuses anything else — an unknown key is a malformed declaration, never ignored", () => {
    for (const bad of [
      {},
      { applyPlan: "not-a-uuid" },
      { applyPlan: "01a0d160-9479-7769-91ea-d3c1cf6dd393", planDigest: "a".repeat(64) }
    ]) {
      expect(InfrastructureChangeDeclarationSchema.safeParse(bad).success).toBe(false);
    }
  });
});
