import { describe, expect, it } from "vitest";
import { computeConfigSourceSyncStatus, type SyncAttemptOutcome } from "./sync-status.js";

describe("computeConfigSourceSyncStatus", () => {
  it("reports manifest_unreadable when the read failed", () => {
    const outcome: SyncAttemptOutcome = { stage: "read_failed", detail: "not found at ref" };
    expect(computeConfigSourceSyncStatus(outcome)).toEqual({
      status: "manifest_unreadable",
      detail: "not found at ref"
    });
  });

  it("reports manifest_invalid when schema validation failed", () => {
    const outcome: SyncAttemptOutcome = {
      stage: "validation_failed",
      errors: ["stacks[0].name: required"]
    };
    expect(computeConfigSourceSyncStatus(outcome)).toEqual({
      status: "manifest_invalid",
      errors: ["stacks[0].name: required"]
    });
  });

  it("reports authz_refused, carrying the refusals", () => {
    const outcome: SyncAttemptOutcome = {
      stage: "authz_refused",
      refusals: [{ action: "create", typeId: "service", reason: "no policy:write at scope" }]
    };
    expect(computeConfigSourceSyncStatus(outcome)).toEqual({
      status: "authz_refused",
      refusals: [{ action: "create", typeId: "service", reason: "no policy:write at scope" }]
    });
  });

  it("reports freeze_held, carrying the freeze ids", () => {
    const outcome: SyncAttemptOutcome = { stage: "freeze_held", freezeIds: ["freeze-1"] };
    expect(computeConfigSourceSyncStatus(outcome)).toEqual({
      status: "freeze_held",
      freezeIds: ["freeze-1"]
    });
  });

  it("reports applied when the plan carried at least one non-noop entry", () => {
    const outcome: SyncAttemptOutcome = { stage: "plan_computed", changedEntryCount: 3 };
    expect(computeConfigSourceSyncStatus(outcome)).toEqual({
      status: "applied",
      changedEntryCount: 3
    });
  });

  it("reports no_op when the plan was entirely noop — never falls through to nothing", () => {
    const outcome: SyncAttemptOutcome = { stage: "plan_computed", changedEntryCount: 0 };
    expect(computeConfigSourceSyncStatus(outcome)).toEqual({ status: "no_op" });
  });

  it("the six outcomes are pairwise distinguishable by `status` alone", () => {
    const outcomes: SyncAttemptOutcome[] = [
      { stage: "read_failed", detail: "x" },
      { stage: "validation_failed", errors: [] },
      { stage: "authz_refused", refusals: [] },
      { stage: "freeze_held", freezeIds: [] },
      { stage: "plan_computed", changedEntryCount: 1 },
      { stage: "plan_computed", changedEntryCount: 0 }
    ];
    const statuses = outcomes.map((o) => computeConfigSourceSyncStatus(o).status);
    expect(new Set(statuses)).toEqual(
      new Set([
        "manifest_unreadable",
        "manifest_invalid",
        "authz_refused",
        "freeze_held",
        "applied",
        "no_op"
      ])
    );
    expect(statuses).toHaveLength(6);
  });
});
