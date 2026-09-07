import { describe, expect, it } from "vitest";
import { REGION_MEMBERSHIP_KEYS, declaresRegionMembership } from "./region-membership-guard.js";

/** The PREDICATE half of the un-declaration guard. See docs/coordination.md §825. */
describe("declaresRegionMembership — the predicate must agree with the gate's `->>` read", () => {
  it("names the two keys the gate reads, and no others", () => {
    expect([...REGION_MEMBERSHIP_KEYS]).toEqual(["environment", "region"]);
  });

  it("declares only when BOTH keys are present and non-blank", () => {
    expect(declaresRegionMembership({ environment: "prod", region: "amer" })).toBe(true);
    expect(declaresRegionMembership({ environment: "prod" })).toBe(false);
    expect(declaresRegionMembership({ region: "amer" })).toBe(false);
    expect(declaresRegionMembership({})).toBe(false);
    expect(declaresRegionMembership(null)).toBe(false);
  });

  it("treats blank and whitespace-only as undeclared — `readDeclaredRegionMembership` trims too", () => {
    expect(declaresRegionMembership({ environment: "prod", region: "" })).toBe(false);
    expect(declaresRegionMembership({ environment: "prod", region: "   " })).toBe(false);
    expect(declaresRegionMembership({ environment: "\t\n", region: "amer" })).toBe(false);
  });

  it("treats an explicit JSON null as undeclared — `->>` yields SQL NULL for it", () => {
    expect(declaresRegionMembership({ environment: "prod", region: null })).toBe(false);
    expect(declaresRegionMembership({ environment: null, region: "amer" })).toBe(false);
  });

  it("treats a NON-STRING jsonb value as declared, because `->>` renders it as text", () => {
    // The trap: type-narrowing to `string` here would call `region: 0` undeclared and hand its owner
    // a free withdrawal, while `properties ->> 'region'` returns '0' and the gate still governs it.
    expect(declaresRegionMembership({ environment: "prod", region: 0 })).toBe(true);
    expect(declaresRegionMembership({ environment: "prod", region: false })).toBe(true);
    expect(declaresRegionMembership({ environment: 1, region: ["amer"] })).toBe(true);
    expect(declaresRegionMembership({ environment: "prod", region: { name: "amer" } })).toBe(true);
  });

  it("ignores every other property — a target may carry anything else beside the two keys", () => {
    expect(
      declaresRegionMembership({ environment: "prod", region: "amer", note: "", owner: null })
    ).toBe(true);
    expect(declaresRegionMembership({ note: "prod amer", cluster: "eks-1" })).toBe(false);
  });
});
