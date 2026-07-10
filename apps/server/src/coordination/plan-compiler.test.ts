import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compilePlan, type DependsOnEdge } from "./plan-compiler.js";

describe("coordination/plan-compiler — pure toposort mode (no topology)", () => {
  it("a single target with no dependencies is one wave", () => {
    const result = compilePlan({ targets: ["a"], dependsOn: [] });
    expect(result).toEqual({ ok: true, waves: [{ waveIndex: 0, name: null, targets: ["a"], requiresFanIn: false }] });
  });

  it("independent targets fan out into the same wave", () => {
    const result = compilePlan({ targets: ["b", "a", "c"], dependsOn: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]!.targets).toEqual(["a", "b", "c"]); // sorted, deterministic
  });

  it("a linear dependency chain produces one wave per link, dependency first", () => {
    // app depends_on infra: infra must go first.
    const result = compilePlan({
      targets: ["app", "infra"],
      dependsOn: [{ from: "app", to: "infra" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["infra"], ["app"]]);
    expect(result.waves[0]!.requiresFanIn).toBe(false);
    expect(result.waves[1]!.requiresFanIn).toBe(true);
  });

  it("a diamond dependency (app -> {left, right} -> infra) fans out then converges", () => {
    const result = compilePlan({
      targets: ["app", "left", "right", "infra"],
      dependsOn: [
        { from: "app", to: "left" },
        { from: "app", to: "right" },
        { from: "left", to: "infra" },
        { from: "right", to: "infra" }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["infra"], ["left", "right"], ["app"]]);
  });

  it("rejects a 2-cycle", () => {
    const result = compilePlan({
      targets: ["a", "b"],
      dependsOn: [
        { from: "a", to: "b" },
        { from: "b", to: "a" }
      ]
    });
    expect(result).toMatchObject({ ok: false, error: "cycle" });
    if (result.ok) return;
    if (result.error !== "cycle") return;
    expect(result.cycle.sort()).toEqual(["a", "b"]);
  });

  it("rejects a longer cycle embedded among otherwise-fine targets", () => {
    const result = compilePlan({
      targets: ["a", "b", "c", "standalone"],
      dependsOn: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" }
      ]
    });
    expect(result).toMatchObject({ ok: false, error: "cycle" });
  });

  it("self-dependency edges are ignored (never a cycle by themselves)", () => {
    const result = compilePlan({ targets: ["a"], dependsOn: [{ from: "a", to: "a" }] });
    expect(result.ok).toBe(true);
  });

  it("dependency edges outside the target set are ignored", () => {
    const result = compilePlan({
      targets: ["a"],
      dependsOn: [{ from: "a", to: "outside-the-change" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toEqual([{ waveIndex: 0, name: null, targets: ["a"], requiresFanIn: false }]);
  });

  it("is deterministic: identical input always produces an identical plan", () => {
    const input = {
      targets: ["c", "a", "b", "d"],
      dependsOn: [
        { from: "a", to: "d" },
        { from: "b", to: "d" }
      ]
    };
    const r1 = compilePlan(input);
    const r2 = compilePlan(input);
    expect(r1).toEqual(r2);
  });
});

describe("coordination/plan-compiler — explicit topology mode", () => {
  it("a sequential wave splits into one wave per target, in order", () => {
    const result = compilePlan({
      targets: ["r1", "r2", "r3"],
      dependsOn: [],
      topologyWaves: [{ mode: "sequential", targets: ["r1", "r2", "r3"], name: "rolling" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["r1"], ["r2"], ["r3"]]);
  });

  it("a parallel wave keeps all its targets in one wave index", () => {
    const result = compilePlan({
      targets: ["r1", "r2", "r3"],
      dependsOn: [],
      topologyWaves: [{ mode: "parallel", targets: ["r1", "r2", "r3"], name: "big-bang" }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]!.targets).toEqual(["r1", "r2", "r3"]);
  });

  it("canary: two sequential waves (5% then 100%)", () => {
    const result = compilePlan({
      targets: ["canary-1", "rest-1", "rest-2"],
      dependsOn: [],
      topologyWaves: [
        { mode: "sequential", targets: ["canary-1"], name: "canary" },
        { mode: "parallel", targets: ["rest-1", "rest-2"], name: "full" }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => ({ name: w.name, targets: w.targets }))).toEqual([
      { name: "canary", targets: ["canary-1"] },
      { name: "full", targets: ["rest-1", "rest-2"] }
    ]);
  });

  it("targets the topology omits are appended via toposort fallback", () => {
    const result = compilePlan({
      targets: ["explicit", "leftover"],
      dependsOn: [],
      topologyWaves: [{ mode: "parallel", targets: ["explicit"] }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["explicit"], ["leftover"]]);
  });

  it("rejects a topology wave referencing a target outside the change", () => {
    const result = compilePlan({
      targets: ["a"],
      dependsOn: [],
      topologyWaves: [{ mode: "parallel", targets: ["a", "not-in-this-change"] }]
    });
    expect(result).toMatchObject({ ok: false, error: "unknown_target", target: "not-in-this-change" });
  });

  it("rejects a topology that schedules a dependency AFTER its dependent", () => {
    // topology says app first, infra second — but app depends_on infra.
    const result = compilePlan({
      targets: ["app", "infra"],
      dependsOn: [{ from: "app", to: "infra" }],
      topologyWaves: [
        { mode: "sequential", targets: ["app"] },
        { mode: "sequential", targets: ["infra"] }
      ]
    });
    expect(result).toMatchObject({ ok: false, error: "topology_violates_dependency" });
  });

  it("rejects a topology that places a dependent pair in the same parallel wave", () => {
    const result = compilePlan({
      targets: ["app", "infra"],
      dependsOn: [{ from: "app", to: "infra" }],
      topologyWaves: [{ mode: "parallel", targets: ["app", "infra"] }]
    });
    expect(result).toMatchObject({ ok: false, error: "topology_violates_dependency" });
  });

  it("an explicit requiresFanIn overrides the default", () => {
    const result = compilePlan({
      targets: ["a", "b"],
      dependsOn: [],
      topologyWaves: [
        { mode: "sequential", targets: ["a"], requiresFanIn: true },
        { mode: "sequential", targets: ["b"], requiresFanIn: false }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves[0]!.requiresFanIn).toBe(true);
    expect(result.waves[1]!.requiresFanIn).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Property-based tests (fast-check) — BUILD_AND_TEST.md §8 M3 DoD: "toposort property tests".
// -------------------------------------------------------------------------------------------

/** Generates a random DAG (never a cycle by construction: edges only point to LOWER indices) over `n` labeled nodes. */
function dagArbitrary() {
  return fc
    .integer({ min: 1, max: 8 })
    .chain((n) => {
      const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
      const edgeArb = fc.array(
        fc
          .tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 }))
          .filter(([a, b]) => a !== b)
          .map(([a, b]) => ({ from: nodes[Math.max(a, b)]!, to: nodes[Math.min(a, b)]! })),
        { maxLength: n * 2 }
      );
      return edgeArb.map((edges) => ({ nodes, edges }));
    });
}

describe("coordination/plan-compiler — property tests", () => {
  it("a randomly-generated DAG always compiles (no false-positive cycle rejection)", () => {
    fc.assert(
      fc.property(dagArbitrary(), ({ nodes, edges }) => {
        const result = compilePlan({ targets: nodes, dependsOn: edges });
        expect(result.ok).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it("every dependency is scheduled in a strictly earlier wave than its dependent (topological validity)", () => {
    fc.assert(
      fc.property(dagArbitrary(), ({ nodes, edges }) => {
        const result = compilePlan({ targets: nodes, dependsOn: edges });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const waveOf = new Map<string, number>();
        for (const w of result.waves) for (const t of w.targets) waveOf.set(t, w.waveIndex);
        for (const edge of edges) {
          expect(waveOf.get(edge.to)!).toBeLessThan(waveOf.get(edge.from)!);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("every target appears in exactly one wave (partition property)", () => {
    fc.assert(
      fc.property(dagArbitrary(), ({ nodes, edges }) => {
        const result = compilePlan({ targets: nodes, dependsOn: edges });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const seen = result.waves.flatMap((w) => w.targets);
        expect(seen.sort()).toEqual([...nodes].sort());
        expect(new Set(seen).size).toBe(seen.length);
      }),
      { numRuns: 200 }
    );
  });

  it("compiling the same DAG twice always yields the identical plan (determinism)", () => {
    fc.assert(
      fc.property(dagArbitrary(), ({ nodes, edges }) => {
        const r1 = compilePlan({ targets: nodes, dependsOn: edges });
        const r2 = compilePlan({ targets: nodes, dependsOn: edges });
        expect(r1).toEqual(r2);
      }),
      { numRuns: 100 }
    );
  });

  it("a DAG plus one reversed back-edge (forcing a real cycle) is always rejected", () => {
    fc.assert(
      fc.property(
        dagArbitrary().filter(({ edges }) => edges.length > 0),
        ({ nodes, edges }) => {
          const someEdge = edges[0]!;
          const backEdge: DependsOnEdge = { from: someEdge.to, to: someEdge.from };
          const result = compilePlan({ targets: nodes, dependsOn: [...edges, backEdge] });
          // Adding a reverse of an existing edge always creates at least a 2-cycle between that pair,
          // UNLESS the forward edge was redundant with an already-existing path making them equal —
          // with single edges (not multi-graphs) a direct back-edge on a real edge is always a cycle.
          expect(result.ok).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });
});
