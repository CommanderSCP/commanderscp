import { describe, expect, it } from "vitest";
import { byDomain, linear, normalizeWaveItems, waves, widening } from "./waves.js";

describe("@scp/iac: wave helpers (§8)", () => {
  it("waves.linear passes stages through unchanged, in order (staging → production)", () => {
    expect(linear(["commercial-amer-staging", "commercial-amer-production"])).toEqual([
      "commercial-amer-staging",
      "commercial-amer-production"
    ]);
    expect(waves.linear).toBe(linear);
  });

  it("waves.widening groups a flat target list geometrically: 1 → 2 → 4", () => {
    const targets = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
    expect(widening(targets, { start: 1, factor: 2 })).toEqual([
      ["t1"],
      ["t2", "t3"],
      ["t4", "t5", "t6", "t7"]
    ]);
  });

  it("waves.widening's final wave holds whatever remains, even short of the ideal size", () => {
    const targets = ["t1", "t2", "t3"];
    // ideal sizes would be 1, 2, 4 — only 3 targets total, so wave 3 gets what's left (nothing more
    // to pad or refuse).
    expect(widening(targets, { start: 1, factor: 2 })).toEqual([["t1"], ["t2", "t3"]]);
  });

  it("waves.widening rejects a non-positive-integer start or factor", () => {
    expect(() => widening(["t1"], { start: 0, factor: 2 })).toThrow(/start/);
    expect(() => widening(["t1"], { start: 1, factor: 0 })).toThrow(/factor/);
    expect(() => widening(["t1"], { start: 1.5, factor: 2 })).toThrow(/start/);
  });

  it("waves.byDomain emits one PARALLEL wave per group, in the given order", () => {
    expect(byDomain(["commercial-a"], ["govcloud-a"], ["airgap-a"])).toEqual([
      ["commercial-a"],
      ["govcloud-a"],
      ["airgap-a"]
    ]);
  });

  describe("normalizeWaveItems", () => {
    it("names waves by POSITION (wave${index+1}), regardless of which earlier waves were named", () => {
      const result = normalizeWaveItems([
        { name: "staging", targets: ["a", "b"] },
        "commercial-amer-production",
        ["c", "d", "e", "f"]
      ]);
      expect(result).toEqual([
        { name: "staging", mode: "parallel", targets: ["a", "b"] },
        { name: "wave2", mode: "parallel", targets: ["commercial-amer-production"] },
        { name: "wave3", mode: "parallel", targets: ["c", "d", "e", "f"] }
      ]);
    });

    it("defaults mode to parallel and preserves an explicit sequential/requiresFanIn", () => {
      const result = normalizeWaveItems([
        { name: "canary", targets: ["a"], mode: "sequential", requiresFanIn: false }
      ]);
      expect(result).toEqual([
        { name: "canary", mode: "sequential", targets: ["a"], requiresFanIn: false }
      ]);
    });

    it("a bare target is a single-member wave", () => {
      expect(normalizeWaveItems(["solo-target"])).toEqual([
        { name: "wave1", mode: "parallel", targets: ["solo-target"] }
      ]);
    });

    it("accepts IResourceRef targets, not just strings", () => {
      const ref = { urn: "urn:scp:x:deployment-target:y", typeId: "deployment-target" };
      expect(normalizeWaveItems([[ref]])).toEqual([
        { name: "wave1", mode: "parallel", targets: [ref] }
      ]);
    });
  });
});
