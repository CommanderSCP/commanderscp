import { describe, expect, it } from "vitest";
import {
  describeContinuousHeldTargets,
  describeContinuousHold,
  summarize,
  type ContinuousHoldTargetVerdict,
  type ContinuousHookHold
} from "./continuous-hold.js";

/**
 * Pure decision-logic tests for the composers `evaluateContinuousHolds` (a `TenantTx`-bound DB
 * seam, left to `pipeline-hook-admission.integration.test.ts`) hands its answer to:
 *  - `summarize`: the three-reasons-never-collapsed operator sentence.
 *  - `describeContinuousHeldTargets`: the sort that keeps a `continuous_test` Decision from
 *    rewriting itself every tick on a reordered — but otherwise unchanged — query result
 *    (ADR-0024's persist-on-change contract, same property `freeze-hold.test.ts` defends for
 *    `describeHeldTargets`).
 *  - `describeContinuousHold`: the wire/reason-tree sentence per held target.
 */

const hold = (overrides: Partial<ContinuousHookHold>): ContinuousHookHold => ({
  hookId: "probe-1",
  reason: "stale",
  summary: "summary",
  staleAfter: "2026-08-26T00:00:00.000Z",
  lastReportedAt: "2026-08-25T23:00:00.000Z",
  freshness: {
    hook: "continuous",
    hookId: "probe-1",
    maxAgeSeconds: 60,
    latestEvidence: null,
    staleAfter: null
  },
  ...overrides
});

const targetVerdict = (
  targetObjectId: string,
  overrides: Partial<ContinuousHoldTargetVerdict> = {}
): ContinuousHoldTargetVerdict => ({
  targetObjectId,
  stage: null,
  holds: [hold({})],
  ...overrides
});

describe("summarize — three reasons, never collapsed", () => {
  it("names the target as sick for 'failed', and check-the-target", () => {
    const text = summarize("probe-1", {
      held: true,
      reason: "failed",
      staleAfter: "2026-08-26T00:00:00.000Z",
      lastReportedAt: "2026-08-25T23:00:00.000Z"
    });
    expect(text).toContain("FAILED");
    expect(text).toContain("check the target");
    expect(text).not.toContain("check the prober");
  });

  it("names the prober as the thing to check for 'stale', with both boundary instants", () => {
    const text = summarize("probe-1", {
      held: true,
      reason: "stale",
      staleAfter: "2026-08-26T00:00:00.000Z",
      lastReportedAt: "2026-08-25T23:00:00.000Z"
    });
    expect(text).toContain("2026-08-25T23:00:00.000Z");
    expect(text).toContain("2026-08-26T00:00:00.000Z");
    expect(text).toContain("check the prober");
  });

  it("says nobody has ever reported for 'no_evidence', with no instant to name", () => {
    const text = summarize("probe-1", {
      held: true,
      reason: "no_evidence",
      staleAfter: null,
      lastReportedAt: null
    });
    expect(text).toContain("has never reported");
    expect(text).toContain("check the prober");
    expect(text).not.toContain("null");
  });
});

describe("describeContinuousHeldTargets — the anti-write-amplification sort", () => {
  it("sorts held targets by id even when handed them in descending order", () => {
    const held = describeContinuousHeldTargets([targetVerdict("t-c"), targetVerdict("t-a")]);
    expect(held.map((h) => h.targetObjectId)).toEqual(["t-a", "t-c"]);
  });

  it("produces a byte-identical projection for two permutations of the same situation", () => {
    const a = describeContinuousHeldTargets([targetVerdict("t-b"), targetVerdict("t-a")]);
    const b = describeContinuousHeldTargets([targetVerdict("t-a"), targetVerdict("t-b")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate its input array, and carries the stage pair through", () => {
    const input = [
      {
        ...targetVerdict("t-b"),
        stage: { componentObjectId: "c", deploymentTargetObjectId: "d" }
      },
      targetVerdict("t-a")
    ];
    const held = describeContinuousHeldTargets(input);
    expect(
      input.map((v) => v.targetObjectId),
      "the caller's array is its own"
    ).toEqual(["t-b", "t-a"]);
    expect(held[1]).toMatchObject({
      targetObjectId: "t-b",
      componentObjectId: "c",
      deploymentTargetObjectId: "d"
    });
    // A legacy-shaped (component) wave target reports nulls rather than being omitted.
    expect(held[0]).toMatchObject({ componentObjectId: null, deploymentTargetObjectId: null });
  });

  it("preserves the holds array of each entry verbatim", () => {
    const holds = [hold({ hookId: "z" }), hold({ hookId: "a" })];
    const [projected] = describeContinuousHeldTargets([targetVerdict("t-a", { holds })]);
    expect(projected!.holds).toBe(holds);
  });
});

describe("describeContinuousHold — the reason-tree sentence per held target", () => {
  it("names the target as not-triggered beside each hold's summary", () => {
    const text = describeContinuousHold(
      targetVerdict("target-1", { holds: [hold({ summary: "probe X is stale" })] })
    );
    expect(text).toBe("probe X is stale — target target-1 is not triggered while it stands");
  });

  it("joins multiple holding hooks with '; '", () => {
    const text = describeContinuousHold(
      targetVerdict("target-1", {
        holds: [hold({ summary: "first" }), hold({ summary: "second" })]
      })
    );
    expect(text).toBe(
      "first — target target-1 is not triggered while it stands; " +
        "second — target target-1 is not triggered while it stands"
    );
  });

  it("returns the empty string for a target with no holding hooks", () => {
    expect(describeContinuousHold(targetVerdict("target-1", { holds: [] }))).toBe("");
  });
});
