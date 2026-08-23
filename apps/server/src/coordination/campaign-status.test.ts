import { describe, expect, it } from "vitest";
import type { ChangeState } from "@scp/schemas";
import { computeCampaignStatus, type CampaignWaveStatusInput } from "./campaign-status.js";

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
      waves: [wave(0, "succeeded", ["accepted", "accepted"]), wave(1, "blocked", [null])]
    });
    expect(status).toBe("blocked");
  });

  it("a RUNNING wave with a freeze-held target -> blocked (M25.2 §1.8)", () => {
    // Per-target admission leaves a partially frozen campaign wave `running` so its unfrozen
    // siblings fan out. Before M25.2 the same freeze produced a whole-wave `block` verdict and this
    // function reported `blocked` for free; without this tier a 40-component campaign with one held
    // target reads as ordinarily `active` for the length of the window.
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [{ ...wave(0, "running", ["executing", null]), frozenTargetCount: 1 }]
    });
    expect(status).toBe("blocked");
  });

  it("the SAME running wave with nothing frozen -> active", () => {
    // The paired direction: `blocked` must come from the freeze, not from the wave being running.
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [{ ...wave(0, "running", ["executing", null]), frozenTargetCount: 0 }]
    });
    expect(status).toBe("active");
  });

  it("a wave's member changes failed/cancelled without recovering -> failed", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "failed", ["cancelled", "accepted"])]
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
      waves: [wave(0, "succeeded", ["accepted"]), wave(1, "succeeded", ["accepted", "accepted"])]
    });
    expect(status).toBe("completed");
  });

  it("skipped waves count toward completion (empty/no-op wave)", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["accepted"]), wave(1, "skipped", [])]
    });
    expect(status).toBe("completed");
  });

  it("every accepted target later rolled back -> rolled_back", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["rolled_back", "rolled_back"])]
    });
    expect(status).toBe("rolled_back");
  });

  it("some accepted targets rolled back, others still accepted -> partially_rolled_back", () => {
    const status = computeCampaignStatus({
      hasPlan: true,
      waves: [wave(0, "succeeded", ["rolled_back", "accepted"])]
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
