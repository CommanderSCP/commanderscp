import { describe, expect, it } from "vitest";
import {
  composeWaveTargetHold,
  toWaveTargetHold,
  type WaveTargetFreezeHold
} from "./plan-service.js";
import type { FreezeHoldVerdict } from "./freeze-hold.js";
import type { ContinuousHoldTargetVerdict } from "./continuous-hold.js";

/**
 * Pure decision-logic tests for the two wire-shape composers `toChangePlanShape` folds into
 * `ChangeWaveTargetSchema.hold` — the read-time predicates that feed them
 * (`resolveWaveTargetFreezeHolds`, `resolveWaveTargetContinuousHolds`) are `TenantTx`-bound and
 * stay with the integration suites that already cover the wire field end to end
 * (`campaign-wave-hold-projection.integration.test.ts` and the freeze/continuous admission
 * integration tests).
 */

describe("toWaveTargetHold — FreezeHoldVerdict -> wire shape", () => {
  it("returns undefined for an undefined verdict", () => {
    expect(toWaveTargetHold(undefined, new Map())).toBeUndefined();
  });

  it("returns undefined for a verdict with no covering freezes", () => {
    const verdict: FreezeHoldVerdict = { targetObjectId: "t-1", stage: null, freezes: [] };
    expect(toWaveTargetHold(verdict, new Map())).toBeUndefined();
  });

  it("projects one freeze per covering freeze, in order, resolving the scope name when known", () => {
    const verdict: FreezeHoldVerdict = {
      targetObjectId: "t-1",
      stage: null,
      freezes: [
        {
          id: "freeze-1",
          tier: "org",
          scopeObjectId: "scope-1",
          match: null,
          name: "code freeze",
          endsAt: "2026-09-01T00:00:00.000Z",
          atomic: false
        }
      ]
    };
    const hold = toWaveTargetHold(verdict, new Map([["scope-1", "Payments Service"]]));
    expect(hold).toBeDefined();
    expect(hold!.freezes).toHaveLength(1);
    expect(hold!.freezes[0]).toMatchObject({
      freezeId: "freeze-1",
      scope: { objectId: "scope-1", name: "Payments Service" },
      endsAt: "2026-09-01T00:00:00.000Z"
    });
    expect(hold!.freezes[0]!.summary.length).toBeGreaterThan(0);
  });

  it("reports scope name null when the scope id has no resolved name", () => {
    const verdict: FreezeHoldVerdict = {
      targetObjectId: "t-1",
      stage: null,
      freezes: [
        {
          id: "freeze-1",
          tier: "org",
          scopeObjectId: "scope-unresolved",
          match: null,
          name: null,
          endsAt: "2026-09-01T00:00:00.000Z",
          atomic: false
        }
      ]
    };
    const hold = toWaveTargetHold(verdict, new Map());
    expect(hold!.freezes[0]!.scope).toEqual({ objectId: "scope-unresolved", name: null });
  });

  it("reports a null scope (never a fabricated one) for a platform-tier freeze", () => {
    const verdict: FreezeHoldVerdict = {
      targetObjectId: "t-1",
      stage: null,
      freezes: [
        {
          id: "freeze-1",
          tier: "platform",
          scopeObjectId: null,
          match: { allEnvironments: true, environment: null, region: null },
          name: null,
          endsAt: "2026-09-01T00:00:00.000Z",
          atomic: true
        }
      ]
    };
    const hold = toWaveTargetHold(verdict, new Map());
    expect(hold!.freezes[0]!.scope).toBeNull();
  });
});

describe("composeWaveTargetHold — merges the freeze half and the continuous half into one wire object", () => {
  const freezeHalf: WaveTargetFreezeHold = {
    freezes: [
      {
        freezeId: "freeze-1",
        scope: null,
        summary: "freeze summary",
        endsAt: "2026-09-01T00:00:00.000Z"
      }
    ]
  };

  const continuousHeld: ContinuousHoldTargetVerdict = {
    targetObjectId: "t-1",
    stage: null,
    holds: [
      {
        hookId: "probe-1",
        reason: "stale",
        summary: "probe stale",
        staleAfter: "2026-08-26T00:00:00.000Z",
        lastReportedAt: "2026-08-25T00:00:00.000Z",
        freshness: {
          hook: "continuous",
          hookId: "probe-1",
          maxAgeSeconds: 60,
          latestEvidence: null,
          staleAfter: null
        }
      }
    ]
  };

  it("returns undefined when held by neither", () => {
    expect(composeWaveTargetHold(undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when the continuous verdict is present but carries no holds", () => {
    // `evaluateContinuousHolds` never actually produces this shape (an unheld target is simply
    // absent from its map) — this is the defensive branch `composeWaveTargetHold` itself takes,
    // and the reason `continuousTests` is checked for BOTH undefined and empty.
    expect(composeWaveTargetHold(undefined, { ...continuousHeld, holds: [] })).toBeUndefined();
  });

  it("carries only freezes, with continuousTests omitted, when held by a freeze alone", () => {
    const hold = composeWaveTargetHold(freezeHalf, undefined);
    expect(hold).toEqual({ freezes: freezeHalf.freezes });
    expect(hold).not.toHaveProperty("continuousTests");
  });

  it("carries freezes: [] and continuousTests when held by a continuous probe alone", () => {
    const hold = composeWaveTargetHold(undefined, continuousHeld);
    expect(hold!.freezes).toEqual([]);
    expect(hold!.continuousTests).toEqual([
      {
        hookId: "probe-1",
        reason: "stale",
        summary: "probe stale",
        staleAfter: "2026-08-26T00:00:00.000Z",
        lastReportedAt: "2026-08-25T00:00:00.000Z"
      }
    ]);
  });

  it("carries both halves when held by both", () => {
    const hold = composeWaveTargetHold(freezeHalf, continuousHeld);
    expect(hold!.freezes).toEqual(freezeHalf.freezes);
    expect(hold!.continuousTests).toHaveLength(1);
  });

  it("never leaks the freshness field onto the wire continuousTests entry", () => {
    // `HookFreshnessContext` is a Decision inputContext concern, not the wire shape's — a defector
    // here would be a silent oasdiff-invisible field addition on a response the SDK already types.
    const hold = composeWaveTargetHold(undefined, continuousHeld);
    expect(hold!.continuousTests![0]).not.toHaveProperty("freshness");
  });
});
