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
 * | drop the co-placed cycle refusal | "a MUTUAL pair CO-PLACED is refused LOUDLY" fails |
 * | scope the cycle refusal to the target set instead of per place | "NEVER CO-PLACED still compiles" fails |
 * | filter placements by target set AFTER grouping (i.e. not at all) | "another change's placements" fails |
 * | sequential mode → one step for the whole wave | "sequential splits per place" fails |
 * | break the `gates` carry-through in `compileStages` | "a wave's gates SURVIVE stage-mode compilation" fails |
 */
describe("coordination/plan-compiler — stage mode (waves name places)", () => {
  const GAMMA = "target-gamma";
  const PROD = "target-prod";
  /** A place the components are placed at but NO topology below names — see the "never goes" test. */
  const STAGING = "target-staging";

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

  it("a MUTUAL pair CO-PLACED is refused LOUDLY — the hold could only deadlock on it", () => {
    // Two microservices whose CI each names the other is a plausible declaration, and increment 2
    // materialises BOTH edges. Stage mode never toposorts, so nothing downstream can order them:
    // the per-target hold would withhold `api` until `db` succeeds at gamma and `db` until `api`
    // succeeds at gamma, neither would ever be triggered, and the change would sit in `executing`
    // behind a Decision forever. The removed same-wave check turned this input into a 400; a
    // compile-time refusal keeps that loudness, which is the whole reason it is not left to run.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [
        { from: "api", to: "db" },
        { from: "db", to: "api" }
      ],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("cycle");
    if (result.error !== "cycle") return;
    // BOTH components named, and the place that makes it a deadlock — this string is the change's
    // permanent epitaph (`auto-cancelled: plan compilation failed — …`), the only explanation an
    // operator ever gets.
    expect([...result.cycle].sort()).toEqual(["api", "db"]);
    expect(result.detail).toContain("api");
    expect(result.detail).toContain("db");
    expect(result.detail).toContain(GAMMA);
  });

  it("a MUTUAL pair that is NEVER CO-PLACED still compiles — no place, no deadlock", () => {
    // The precision half of the refusal above, and the reason it is scoped per PLACE rather than
    // over the whole target set. `api` is prod-only and `db` is gamma-only, so at every place one of
    // them resolves to `not_placed` — which the hold treats as SATISFIED (ADR-0028 decision 4, a
    // declared fact per ADR-0026 D8). Nothing is ever held, so refusing this would reject a working
    // configuration on a technicality about edges.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [
        { from: "api", to: "db" },
        { from: "db", to: "api" }
      ],
      topologyWaves: gammaThenProd,
      placements: [place("db", GAMMA), place("api", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["db@target-gamma"], ["api@target-prod"]]);
  });

  it("a cycle co-placed ONLY where the topology never goes still compiles — the refusal is no wider than the deadlock", () => {
    // The second precision half. The pair IS co-placed — at `staging` — so a check keyed on "do
    // these two share any place at all" refuses. But the topology names only gamma and prod, so
    // `staging` never becomes a wave target, the hold (scoped by a wave target's deployment-target)
    // can never look there, and nothing could ever deadlock. Refusing here would auto-cancel a
    // pipeline that never co-schedules the pair: `compilePlan` -> 400 (`plan-service.ts`) ->
    // `auto-cancelled: plan compilation failed` (`reconcile.ts`).
    //
    // This is why the refusal is handed the placements the plan actually SCHEDULES rather than
    // every placement of the change's components.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [
        { from: "api", to: "db" },
        { from: "db", to: "api" }
      ],
      topologyWaves: gammaThenProd,
      placements: [
        place("api", GAMMA),
        place("db", PROD),
        place("api", STAGING),
        place("db", STAGING)
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["api@target-gamma"], ["db@target-prod"]]);
  });

  it("a MUTUAL pair declared in the CHANGE'S OWN stageDependencies is refused even when an edge is missing", () => {
    // THE TOMBSTONE WEDGE. `materialiseStageDependencyEdges` deliberately treats a SOFT-DELETED edge
    // as "already materialised" (a plain UNIQUE key, not a partial index), so an operator's one-off
    // deletion of `api -> db` means that edge is never re-minted. `loadDependsOnEdges` filters on
    // `deleted_at IS NULL`, so the compiler saw only `db -> api` and found no cycle.
    //
    // The RUNTIME hold does not read edges for this pair at all — it enforces the change's own
    // DECLARATIONS, and a declaration is CHANGE-scoped, applying to EVERY target (the KNOWN
    // LIMITATION in `changes-repo.ts`). So `api@gamma` holds behind `db@gamma` and `db@gamma` holds
    // behind `api@gamma`: every target held, none failed, and reconcile's pure-hold return fires
    // forever. The change wedges in `executing` behind a watchdog warn, and the loud
    // `auto-cancelled: plan compilation failed` epitaph ADR-0028 promises never arrives.
    //
    // The compiler must therefore see what the HOLD enforces, not only what the graph still stores.
    const result = compilePlan({
      targets: ["api", "db"],
      // Only the surviving edge: `api -> db` hit the tombstone at propose and was skipped.
      dependsOn: [{ from: "db", to: "api" }],
      declaredStageDependencies: [{ dependsOn: "api" }, { dependsOn: "db" }],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("cycle");
    if (result.error !== "cycle") return;
    expect([...result.cycle].sort()).toEqual(["api", "db"]);
    expect(result.detail).toContain("api");
    expect(result.detail).toContain("db");
    expect(result.detail).toContain(GAMMA);
  });

  it("declarations alone deadlock with NO surviving edge at all, and are refused", () => {
    // The end state of the same tombstone story: BOTH edges deleted, so `loadDependsOnEdges` returns
    // nothing. `coPlacedCycle` used to return `null` on an empty edge list before looking at a single
    // placement — the shortest path to the wedge, and the one a union that only ever ADDS to a
    // non-empty edge set would still miss.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [],
      declaredStageDependencies: [{ dependsOn: "api" }, { dependsOn: "db" }],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "cycle") return;
    expect([...result.cycle].sort()).toEqual(["api", "db"]);
  });

  it("a declaration that is NOT mutual still compiles and serialises — no false refusal", () => {
    // The precision half. `db` is declared as a dependency of the change, which the KNOWN LIMITATION
    // applies to BOTH targets — so `api` holds behind `db`, and `db`'s entry against itself is the
    // `self` branch (satisfied, dropped, exactly as `buildDependencyMap` drops `from === to`). One
    // wave per place, serialised inside it by the hold. Refusing this would auto-cancel the ordinary
    // shape ADR-0028 exists to support.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [],
      declaredStageDependencies: [{ dependsOn: "db" }],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => [...w.targets].sort())).toEqual([
      ["api@target-gamma", "db@target-gamma"],
      ["api@target-prod", "db@target-prod"]
    ]);
  });

  it("a mutual declaration whose `atTargets` never overlap still compiles — the hold cannot deadlock", () => {
    // `atTargets` narrows WHERE a declaration applies, and the hold honours it. Here `api`'s
    // coupling applies only at prod and `db`'s only at gamma: at gamma `db` holds behind `api` while
    // `api` is free, at prod `api` holds behind `db` while `db` is free. Neither place deadlocks, so
    // a refusal keyed on the declaration set as a whole would reject a working configuration — the
    // same "no wider than the deadlock" rule that made the refusal per-place in the first place.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [],
      declaredStageDependencies: [
        { dependsOn: "db", atTargets: [PROD] },
        { dependsOn: "api", atTargets: [GAMMA] }
      ],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => [...w.targets].sort())).toEqual([
      ["api@target-gamma", "db@target-gamma"],
      ["api@target-prod", "db@target-prod"]
    ]);
  });

  it("a declaration cycle CO-PLACED ONLY where the topology never goes still compiles", () => {
    // The declaration half of the `staging` case below: the derived pairs are scoped to the
    // placements the plan ACTUALLY SCHEDULES, exactly as the edge-derived ones already were. `api`
    // and `db` share only `staging`, which no wave names, so the hold can never look there.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [],
      declaredStageDependencies: [{ dependsOn: "api" }, { dependsOn: "db" }],
      topologyWaves: gammaThenProd,
      placements: [
        place("api", GAMMA),
        place("db", PROD),
        place("api", STAGING),
        place("db", STAGING)
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves.map((w) => w.targets)).toEqual([["api@target-gamma"], ["db@target-prod"]]);
  });

  it("a declaration and a surviving edge compose into one cycle — neither alone is one", () => {
    // The union is not decoration. The graph still holds `db -> api` (an operator's, a seed's, or an
    // earlier change's), and this change declares `api -> db`. Each source alone is a clean ordering;
    // together they are the deadlock, and only a check that reads BOTH can see it.
    const result = compilePlan({
      targets: ["api", "db"],
      dependsOn: [{ from: "db", to: "api" }],
      declaredStageDependencies: [{ dependsOn: "db", atTargets: [GAMMA] }],
      topologyWaves: gammaThenProd,
      placements: [place("api", GAMMA), place("api", PROD), place("db", GAMMA), place("db", PROD)]
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "cycle") return;
    expect([...result.cycle].sort()).toEqual(["api", "db"]);
    expect(result.detail).toContain(GAMMA);
  });

  it("a LONGER cycle among co-placed targets is refused too — not just mutual pairs", () => {
    // The deadlock is a property of the cycle, not of its length: A waits on B waits on C waits on
    // A, all at gamma, holds all three forever. Keyed on the toposort's own cycle detection rather
    // than a hand-rolled pair check, so this needs no separate rule.
    const result = compilePlan({
      targets: ["a", "b", "c"],
      dependsOn: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" }
      ],
      topologyWaves: [{ name: "gamma", mode: "parallel" as const, targets: [GAMMA] }],
      placements: [place("a", GAMMA), place("b", GAMMA), place("c", GAMMA)]
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "cycle") return;
    expect([...result.cycle].sort()).toEqual(["a", "b", "c"]);
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

  it("a wave's gates SURVIVE stage-mode compilation too, absent-vs-empty intact", () => {
    // Gate EVALUATION is another session's work (§14 resolution 5); this only proves the value
    // reaches `CompiledWave` on the STAGE path, which `compilePlan`'s explicit-topology test covers
    // separately for the legacy path.
    const result = compilePlan({
      targets: ["keycloak"],
      dependsOn: [],
      topologyWaves: [
        {
          name: "gamma",
          mode: "parallel" as const,
          targets: [GAMMA],
          gates: [{ kind: "bakeAlarms" }]
        },
        { name: "prod", mode: "parallel" as const, targets: [PROD] }
      ],
      placements: [place("keycloak", GAMMA), place("keycloak", PROD)]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waves[0]!.gates).toEqual([{ kind: "bakeAlarms" }]);
    expect(result.waves[1]).not.toHaveProperty("gates");
  });
});
