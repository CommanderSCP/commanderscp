import { describe, expect, it } from "vitest";
import { compilePlan, type StagePlacement } from "./plan-compiler.js";

/**
 * STAGE-SHAPED compilation (ADR-0026 §5): the change supplies COMPONENTS, the topology supplies
 * ordered PLACES, and each wave is the cartesian product — the placements of this change's
 * components at that wave's deployment-targets.
 *
 * These are unit tests because `compilePlan` is pure by contract (BUILD_AND_TEST.md §4.1); the DB
 * side of it — classifying a topology as stage- or legacy-shaped and resolving the placements —
 * is covered in `stage-compilation.integration.test.ts`.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | emit an empty wave as normal (drop `skipped`) | "an empty wave is emitted AND marked skipped" fails |
 * | omit empty waves entirely | the same test fails on wave count and index alignment |
 * | drop the `target_not_placed_in_any_wave` check | "a target placed nowhere the topology names" fails |
 * | restore the same-wave `depends_on` check | "COMPILES a dependent pair sharing a stage wave" fails |
 * | filter placements by target set AFTER grouping (i.e. not at all) | "another change's placements" fails |
 * | sequential mode → one step for the whole wave | "sequential splits per place" fails |
 */
describe("coordination/plan-compiler — stage mode (waves name places)", () => {
  const GAMMA = "target-gamma";
  const PROD = "target-prod";

  /** `<component>@<place>` placement ids, so a failure message reads as the pair it stands for. */
  const place = (component: string, deploymentTarget: string): StagePlacement => ({
    componentObjectId: component,
    deploymentTargetObjectId: deploymentTarget,
    placementObjectId: `${component}@${deploymentTarget}`
  });

  const gammaThenProd = [
    { name: "gamma", mode: "parallel" as const, targets: [GAMMA] },
    { name: "prod", mode: "parallel" as const, targets: [PROD] }
  ];

  it("one component at two places becomes two real waves — the whole point", () => {
    // The gap this closes: a single-target change (277 of 281 measured) compiled to ONE anonymous
    // wave because a topology could only order targets the change already had, and a change has one
    // component. Now the topology supplies the places and the product supplies the waves.
    const result = compilePlan({
      targets: ["keycloak"],
      dependsOn: [],
      topologyWaves: gammaThenProd,
      placements: [place("keycloak", GAMMA), place("keycloak", PROD)]
    });

    expect(result).toEqual({
      ok: true,
      waves: [
        { waveIndex: 0, name: "gamma", targets: ["keycloak@target-gamma"], requiresFanIn: false },
        { waveIndex: 1, name: "prod", targets: ["keycloak@target-prod"], requiresFanIn: true }
      ]
    });
  });

  it("an empty wave is EMITTED and marked skipped, keeping wave indices aligned to the topology", () => {
    // `agentkit-umami-prod` is prod-only: a gamma→prod change targeting it has a legitimately empty
    // gamma wave. Omitting it would renumber prod to wave 0 — which also flips `requiresFanIn`,
    // since that is computed as `i > 0`. Both assertions below would pass if the wave were merely
    // absent, so the index and the flag are what make this test mean something.
    const result = compilePlan({
      targets: ["umami"],
      dependsOn: [],
      topologyWaves: gammaThenProd,
      placements: [place("umami", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0]).toEqual({
      waveIndex: 0,
      name: "gamma",
      targets: [],
      requiresFanIn: false,
      skipped: true
    });
    expect(result.waves[1]).toEqual({
      waveIndex: 1,
      name: "prod",
      targets: ["umami@target-prod"],
      requiresFanIn: true
    });
  });

  it("REFUSES a target placed nowhere the topology names, instead of silently dropping it", () => {
    // The caller asked to release `dev-only` and this pipeline cannot. Compiling anyway would
    // report success for a component that was never deployed.
    const result = compilePlan({
      targets: ["keycloak", "dev-only"],
      dependsOn: [],
      topologyWaves: gammaThenProd,
      placements: [
        place("keycloak", GAMMA),
        place("keycloak", PROD),
        place("dev-only", "target-dev")
      ]
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("target_not_placed_in_any_wave");
    expect((result as { target: string }).target).toBe("dev-only");
  });

  it("REFUSES when NO target participates — a plan with nothing to do is not a release", () => {
    // A change whose plan has no work would sit in `executing` forever: reconcile's zero-wave
    // branch is a defensive no-op and the watchdog only warns.
    const result = compilePlan({
      targets: ["dev-only"],
      dependsOn: [],
      topologyWaves: gammaThenProd,
      placements: [place("dev-only", "target-dev")]
    });
    expect(result.ok).toBe(false);
  });

  it("ignores placements belonging to components this change does not target", () => {
    // Placements are global, not per-change. A wave must contain only what the change asked for —
    // otherwise a topology would silently expand the plan, which is exactly what legacy mode's
    // `unknown_target` check existed to prevent.
    const result = compilePlan({
      targets: ["keycloak"],
      dependsOn: [],
      topologyWaves: gammaThenProd,
      placements: [
        place("keycloak", GAMMA),
        place("keycloak", PROD),
        place("someone-elses-app", GAMMA)
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.flatMap((w) => w.targets)).toEqual([
      "keycloak@target-gamma",
      "keycloak@target-prod"
    ]);
  });

  it("sequential mode splits one declared wave into one step PER PLACE, in order", () => {
    const result = compilePlan({
      targets: ["keycloak"],
      dependsOn: [],
      topologyWaves: [{ name: "rollout", mode: "sequential", targets: [GAMMA, PROD] }],
      placements: [place("keycloak", GAMMA), place("keycloak", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([
      ["keycloak@target-gamma"],
      ["keycloak@target-prod"]
    ]);
  });

  it("COMPILES a dependent pair sharing a stage wave (ADR-0028 decision 6 — was a refusal)", () => {
    // THE LIVE BEHAVIOUR CHANGE of ADR-0028 increment 2, and the reason it needs its own release
    // note. This exact input used to return `topology_violates_dependency`, which `plan-service.ts`
    // turns into a 400 and `reconcile.ts` turns into `auto-cancelled: plan compilation failed`.
    //
    // Once every CI-declared dependency is materialised as a `depends_on` edge, that refusal would
    // auto-cancel every multi-target change that touches both components — i.e. it would punish a
    // CORRECTLY declared dependency. The ordering duty moved to the per-target trigger hold in
    // `reconcile.ts`'s executing loop (increment 3), which can hold `api` at gamma while `db` runs
    // there; a whole-wave verdict never could.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [{ from: "api", to: "db" }],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both placements land in the SAME wave per place — the plan is the topology's shape, and the
    // pair is serialised at trigger time rather than at compile time.
    expect(result.waves.map((w) => [...w.targets].sort())).toEqual([
      ["api@target-gamma", "db@target-gamma"],
      ["api@target-prod", "db@target-prod"]
    ]);
  });

  it("still compiles the same components when the topology separates them per place", () => {
    // Unchanged by decision 6, and kept so the removal above cannot be mistaken for "stage mode
    // stopped compiling dependency-bearing inputs at all": `api` and `db` roll through different
    // places and still produce one wave each.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [{ from: "api", to: "db" }],
      topologyWaves: [
        { name: "db-first", mode: "parallel", targets: [GAMMA] },
        { name: "api-after", mode: "parallel", targets: [PROD] }
      ],
      placements: [place("db", GAMMA), place("api", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["db@target-gamma"], ["api@target-prod"]]);
  });

  it("a MUTUAL declaration compiles in stage mode — a 2-cycle is not a cycle over places", () => {
    // Two microservices whose CI each names the other is a plausible declaration, and increment 2
    // materialises BOTH edges. Stage mode never toposorts, so there is nothing here for a cycle to
    // be found in; the no-topology path is the one that still rejects it (see plan-compiler.test.ts,
    // "rejects a 2-cycle"), and that difference is deliberate, not an oversight.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [
        { from: "api", to: "db" },
        { from: "db", to: "api" }
      ],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(true);
  });

  it("stays in LEGACY mode when no placements are supplied — the old contract is untouched", () => {
    // Existing topologies name the change's own targets. That path keeps its `unknown_target`
    // check, which stage mode does not need and must not lose.
    const legacy = compilePlan({
      targets: ["a"],
      dependsOn: [],
      topologyWaves: [{ name: "one", mode: "parallel", targets: ["a"] }]
    });
    expect(legacy.ok).toBe(true);

    const unknown = compilePlan({
      targets: ["a"],
      dependsOn: [],
      topologyWaves: [{ name: "one", mode: "parallel", targets: ["not-a-target"] }]
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toBe("unknown_target");
  });
});
