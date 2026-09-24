import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { InfrastructureChangeDeclarationSchema } from "@scp/schemas";
import { buildProgram, infraApplyProposal, waveTargetPlanText } from "./cli.js";

/** M28.3 (ADR-0056) — the CLI half of plan → approve → apply. The plan is an ordinary infrastructure
 *  change and its approval is `scp change accept`; what the CLI adds is the apply declaration and
 *  the plan evidence on `scp change explain`. */
function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

const PLAN_ID = "01a0d160-9479-7769-91ea-d3c1cf6dd393";

describe("scp change propose --apply-plan", () => {
  it("exists on `change propose`", () => {
    const longs = findCommand(buildProgram(), ["change", "propose"])!.options.map((o) => o.long);
    expect(longs).toContain("--apply-plan");
  });

  it("declares properties.infrastructure.applyPlan and Type infrastructure — the shape the server reads", () => {
    const { type, properties } = infraApplyProposal(PLAN_ID, undefined, { note: "keep me" });
    expect(type).toBe("infrastructure");
    expect(properties).toEqual({ note: "keep me", infrastructure: { applyPlan: PLAN_ID } });
    expect(InfrastructureChangeDeclarationSchema.parse(properties!["infrastructure"])).toEqual({
      applyPlan: PLAN_ID
    });
  });

  it("without the flag, sends the author's type and properties untouched", () => {
    expect(infraApplyProposal(undefined, "image", { a: 1 })).toEqual({
      type: "image",
      properties: { a: 1 }
    });
  });

  it("refuses a contradiction instead of choosing a side", () => {
    expect(() => infraApplyProposal(PLAN_ID, "image", undefined)).toThrow(/--type image/);
    expect(() =>
      infraApplyProposal(PLAN_ID, undefined, { infrastructure: { applyPlan: PLAN_ID } })
    ).toThrow(/both declare the plan/);
    expect(() => infraApplyProposal("not-a-change", undefined, undefined)).toThrow(
      /not a change id/
    );
  });
});

describe("scp change explain prints the plan evidence", () => {
  it("renders the digest and the tally the way the plan chip does", () => {
    expect(
      waveTargetPlanText({ plan: { ref: "7c1e".padEnd(64, "0"), add: 2, change: 0, destroy: 1 } })
    ).toBe("plan 7c1e00000000 · 2 add / 0 change / 1 destroy");
  });

  it("prints nothing for a target with no plan — absent is never a zeroed summary", () => {
    expect(waveTargetPlanText(undefined)).toBeUndefined();
    expect(waveTargetPlanText(null)).toBeUndefined();
    expect(waveTargetPlanText({ revision: "abc" })).toBeUndefined();
  });
});
