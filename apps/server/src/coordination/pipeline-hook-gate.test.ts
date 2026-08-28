import { describe, expect, it } from "vitest";
import {
  assertWaveGateHookKind,
  describePipelineHookGate,
  type PipelineHookGateContribution,
  type PipelineHookGateEntry
} from "./pipeline-hook-gate.js";

/**
 * Pure decision-logic tests for the two exported functions this module owns that need no
 * `TenantTx`: the loud guard the module doc calls "THE ASSERTION", and the reason-tree composer
 * `gates.ts` folds into a wave-gate Decision. `evaluatePipelineHookGate` itself is a DB seam
 * (hooks, evidence, changes reads) and stays with `pipeline-hook-admission.integration.test.ts`.
 */

describe("assertWaveGateHookKind — continuous must never reach a wave gate", () => {
  it("throws for 'continuous', naming why it must not be here", () => {
    expect(() => assertWaveGateHookKind("continuous")).toThrow(/per-target hold/i);
  });

  it("does not throw for any of the three wave-gate kinds", () => {
    for (const kind of ["postMerge", "postDeploy", "bakeAlarms"] as const) {
      expect(() => assertWaveGateHookKind(kind)).not.toThrow();
    }
  });
});

const entry = (overrides: Partial<PipelineHookGateEntry>): PipelineHookGateEntry => ({
  kind: "postDeploy",
  hookId: "hook-1",
  componentObjectId: "comp-1",
  targetObjectId: "target-1",
  stage: null,
  gatedWaveIndex: 0,
  outcome: "pass",
  satisfied: true,
  ...overrides
});

describe("describePipelineHookGate — the reason-tree half of the wave-gate Decision", () => {
  it("reports satisfaction, including vacuously for an empty entry set", () => {
    const contribution: PipelineHookGateContribution = {
      allowed: true,
      entries: [],
      pendingTriggers: []
    };
    expect(describePipelineHookGate(contribution)).toBe("0 declared pipeline hook(s) satisfied");
  });

  it("reports the count when every entry is satisfied", () => {
    const contribution: PipelineHookGateContribution = {
      allowed: true,
      pendingTriggers: [],
      entries: [entry({ hookId: "a" }), entry({ hookId: "b" })]
    };
    expect(describePipelineHookGate(contribution)).toBe("2 declared pipeline hook(s) satisfied");
  });

  it("names only the unsatisfied entries, never the passing siblings beside them", () => {
    const contribution: PipelineHookGateContribution = {
      allowed: false,
      pendingTriggers: [],
      entries: [
        entry({ hookId: "passing", satisfied: true, outcome: "pass" }),
        entry({
          hookId: "failing",
          kind: "bakeAlarms",
          componentObjectId: "comp-2",
          targetObjectId: "target-2",
          satisfied: false,
          outcome: "alarm_firing"
        })
      ]
    };
    const description = describePipelineHookGate(contribution);
    expect(description).not.toContain("passing");
    expect(description).toBe(
      "bakeAlarms 'failing' on component comp-2 at target target-2 is 'alarm_firing'"
    );
  });

  it("joins multiple unsatisfied entries with '; '", () => {
    const contribution: PipelineHookGateContribution = {
      allowed: false,
      pendingTriggers: [],
      entries: [
        entry({ hookId: "h1", satisfied: false, outcome: "fail" }),
        entry({ hookId: "h2", satisfied: false, outcome: "awaiting" })
      ]
    };
    expect(describePipelineHookGate(contribution)).toBe(
      "postDeploy 'h1' on component comp-1 at target target-1 is 'fail'; " +
        "postDeploy 'h2' on component comp-1 at target target-1 is 'awaiting'"
    );
  });
});
