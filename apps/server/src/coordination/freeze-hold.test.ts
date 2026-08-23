import { describe, expect, it } from "vitest";
import { describeHeldTargets, type FreezeHoldVerdict } from "./freeze-hold.js";

/**
 * THE `held` PROJECTION — pure, and unit-tested because the integration fixture CANNOT reach the
 * property it defends.
 *
 * `freeze-admission.integration.test.ts` drives real waves, and a wave's placements are created
 * monotonically: uuidv7 ids ascend in creation order, and the order reconcile's per-target loop
 * pushes held targets in coincides with it. So an integration case can assert the output IS sorted
 * and stay green with the sort deleted — which is exactly what happened (the mutation "delete both
 * Decision sorts" survived a passing suite while three docblocks claimed it was covered). The
 * freeze-order sort IS reachable there, because an `atomic` freeze covering a sibling is appended
 * after a target's own; the TARGET-order sort is not.
 *
 * Hence this file: hand the projection an order no fixture can produce and assert it comes back
 * sorted. What is at stake is not tidiness — `restatesDecision` canonicalizes object keys only, so
 * a reordered `held` array is a "different" Decision, written again on the next 1 s tick, for the
 * length of the freeze window. That is ADR-0024's measured 1.44 GB/day.
 */
const verdict = (targetObjectId: string, freezeIds: string[]): FreezeHoldVerdict => ({
  targetObjectId,
  stage: null,
  freezes: freezeIds.map((id) => ({
    id,
    scopeObjectId: `scope-${id}`,
    name: id,
    endsAt: "2030-01-01T00:00:00.000Z",
    atomic: false
  }))
});

describe("describeHeldTargets (M25.2 — the anti-write-amplification sort)", () => {
  it("sorts held targets by id even when handed them in descending order", () => {
    const held = describeHeldTargets([verdict("t-c", ["f-1"]), verdict("t-a", ["f-2"])]);
    expect(held.map((h) => h.targetObjectId)).toEqual(["t-a", "t-c"]);
  });

  it("produces a byte-identical projection for two permutations of the same situation", () => {
    // THE ACTUAL CONTRACT, stated the way `insertDecisionIfChanged` asks it: two orderings of one
    // unchanged situation must serialize the same, or tick N+1 looks new.
    const a = describeHeldTargets([verdict("t-b", ["f-x"]), verdict("t-a", ["f-y"])]);
    const b = describeHeldTargets([verdict("t-a", ["f-y"]), verdict("t-b", ["f-x"])]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate its input, and carries the stage pair through", () => {
    const input = [
      { ...verdict("t-b", ["f-1"]), stage: { componentObjectId: "c", deploymentTargetObjectId: "d" } },
      verdict("t-a", [])
    ];
    const held = describeHeldTargets(input);
    expect(input.map((v) => v.targetObjectId), "the caller's array is its own").toEqual([
      "t-b",
      "t-a"
    ]);
    expect(held[1]).toMatchObject({
      targetObjectId: "t-b",
      componentObjectId: "c",
      deploymentTargetObjectId: "d"
    });
    // A legacy-shaped (component) wave target reports nulls rather than being omitted — the freeze
    // holds it exactly as well, and the Decision must say so.
    expect(held[0]).toMatchObject({ componentObjectId: null, deploymentTargetObjectId: null });
  });
});
