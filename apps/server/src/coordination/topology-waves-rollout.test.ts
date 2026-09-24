import { describe, expect, it } from "vitest";
import { parseTopologyWaves } from "./topology-waves.js";

/** M28.4 (ADR-0055): a wave's `rollout` is parsed with the wave, and a bad one refused at propose. */
describe("parseTopologyWaves — the wave plan's rollout", () => {
  it("carries a valid rollout onto the wave spec", () => {
    const rollout = { strategy: "canary", steps: [{ weightPercent: 10, pauseSeconds: 60 }] };
    expect(parseTopologyWaves({ waves: [{ mode: "parallel", targets: ["t"], rollout }] })).toEqual([
      { mode: "parallel", targets: ["t"], rollout }
    ]);
  });

  it("an absent rollout stays absent", () => {
    expect(
      parseTopologyWaves({ waves: [{ mode: "parallel", targets: ["t"] }] })?.[0]
    ).not.toHaveProperty("rollout");
  });

  it.each([
    [{ strategy: "canary", steps: [] }, /rollout is invalid/],
    [{ strategy: "canary", steps: [{ weightPercent: 150 }] }, /rollout is invalid/],
    [{ strategy: "blueGreen", autoPromotionSeconds: 0 }, /rollout is invalid/],
    ["10%", /rollout is invalid/]
  ])("refuses %j", (rollout, message) => {
    let detail: string | undefined;
    try {
      parseTopologyWaves({ waves: [{ mode: "parallel", targets: ["t"], rollout }] });
    } catch (err) {
      detail = (err as { detail?: string }).detail;
    }
    // Asserted on the ProblemError's DETAIL, not on "it threw": a TypeError would also throw.
    expect(detail).toMatch(message);
  });
});
