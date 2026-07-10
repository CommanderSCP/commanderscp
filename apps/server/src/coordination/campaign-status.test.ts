import { describe, expect, it } from "vitest";
import type { CampaignStatus, ChangeState } from "@scp/schemas";
import {
  computeCampaignStatus,
  computeInitiativeRollup,
  type CampaignWaveStatusInput
} from "./campaign-status.js";

/** Shorthand: one wave with N targets, each carrying the given member-change state. */
function wave(
  waveIndex: number,
  waveStatus: CampaignWaveStatusInput["waveStatus"],
  memberStates: (ChangeState | null)[]
): CampaignWaveStatusInput {
  return {
    waveIndex,
    waveStatus,
    targets: memberStates.map((memberChangeState, i) => ({
      targetObjectId: `target-${waveIndex}-${i}`,
      memberChangeState
    }))
  };
}

describe("computeCampaignStatus (pure, table-driven — BUILD_AND_TEST.md §4.1/§8 M5)", () => {
  it("no plan compiled yet -> proposed", () => {
    expect(computeCampaignStatus({ hasPlan: false, waves: [] })).toBe("proposed");
    // Defensive: even if a caller somehow passes hasPlan:true with zero waves, still 'proposed'
    // (a plan with no waves has nothing to report progress on).
    expect(computeCampaignStatus({ hasPlan: true, waves: [] })).toBe("proposed");
  });

  it("plan compiled, first wave still pending (no member changes proposed yet) -> active", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "pending", [null, null])]
    });
    expect(status).toBe("active");
  });

  it("first wave running, member changes mid-lifecycle -> active", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "running", ["executing", "validating"])]
    });
    expect(status).toBe("active");
  });

  it("wave 1 succeeded, wave 2 blocked by its boundary gate -> blocked (flagship DoD scenario)", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["promoted", "promoted"]), wave(1, "blocked", [null])]
    });
    expect(status).toBe("blocked");
  });

  it("a wave's member changes failed/cancelled without recovering -> failed", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "failed", ["cancelled", "promoted"])]
    });
    expect(status).toBe("failed");
  });

  it("failed takes priority over blocked when both are somehow present", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "failed", ["cancelled"]), wave(1, "blocked", [null])]
    });
    expect(status).toBe("failed");
  });

  it("every wave succeeded -> completed", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["promoted"]), wave(1, "succeeded", ["promoted", "promoted"])]
    });
    expect(status).toBe("completed");
  });

  it("skipped waves count toward completion (empty/no-op wave)", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["promoted"]), wave(1, "skipped", [])]
    });
    expect(status).toBe("completed");
  });

  it("every promoted target later rolled back -> rolled_back", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["rolled_back", "rolled_back"])]
    });
    expect(status).toBe("rolled_back");
  });

  it("some promoted targets rolled back, others still promoted -> partially_rolled_back", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["rolled_back", "promoted"])]
    });
    expect(status).toBe("partially_rolled_back");
  });

  it("rollback of wave 1 wins over a still-blocked wave 2 (rollback is always visible)", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["rolled_back", "rolled_back"]), wave(1, "blocked", [null])]
    });
    expect(status).toBe("rolled_back");
  });
});

describe("computeInitiativeRollup (pure, table-driven — BUILD_AND_TEST.md §4.1/§8 M5)", () => {
  it("no member campaigns -> proposed", () => {
    expect(computeInitiativeRollup([])).toBe("proposed");
  });

  it("single campaign -> mirrors its own status", () => {
    const statuses: CampaignStatus[] = ["completed"];
    expect(computeInitiativeRollup(statuses)).toBe("completed");
  });

  it("one blocked campaign among several completed ones -> blocked (most actionable wins)", () => {
    const statuses: CampaignStatus[] = ["completed", "blocked", "completed"];
    expect(computeInitiativeRollup(statuses)).toBe("blocked");
  });

  it("failed outranks active/proposed but not blocked", () => {
    expect(computeInitiativeRollup(["active", "failed", "proposed"])).toBe("failed");
    expect(computeInitiativeRollup(["blocked", "failed"])).toBe("blocked");
  });

  it("mixed completed/rolled_back -> rolled_back (something reverted is worth surfacing)", () => {
    expect(computeInitiativeRollup(["completed", "rolled_back", "completed"])).toBe("rolled_back");
  });

  it("all completed -> completed", () => {
    expect(computeInitiativeRollup(["completed", "completed"])).toBe("completed");
  });

  it("mixed active/proposed -> active (something is moving)", () => {
    expect(computeInitiativeRollup(["proposed", "active", "proposed"])).toBe("active");
  });
});
