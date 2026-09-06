/**
 * The plan compiler (DESIGN.md §9.3) — a PURE function, zero I/O, per BUILD_AND_TEST.md §4.1.
 * Turns a target set + `depends_on` edges among them + an optional Release Topology's explicit
 * wave groups into an ordered list of waves (a wave = a set of targets that execute together;
 * "parallel waves share a wave index" per DESIGN §9.3's fan-out language). All DB I/O (resolving
 * `depends_on` from the graph, persisting `change_plans`/`change_waves`/`change_wave_targets`
 * rows) lives in `coordination/plan-service.ts`, which calls this and writes the result.
 *
 * Two modes:
 *  - No topology (or an empty one): wave order is derived ENTIRELY from `depends_on` via a
 *    layered topological sort (Kahn's algorithm) — every node with no unresolved dependency
 *    lands in the next wave; ties (independent targets) land in the SAME wave (fan-out).
 *    Deterministic: ready-sets are sorted before assignment, so identical input always produces
 *    an identical wave plan (BUILD_AND_TEST.md §8 M3 DoD: toposort property tests).
 *  - Explicit topology: each declared wave becomes one step (`mode: "parallel"` -> all its
 *    targets share one wave index; `mode: "sequential"` -> each target gets its own, in the
 *    given order — "waves with sequential/parallel target groups", DESIGN §9.3). Any targets the
 *    topology doesn't mention are appended afterward via the same toposort fallback. The result
 *    is then VALIDATED against `depends_on`: a dependency can never be scheduled in a LATER wave
 *    than its dependent, and two targets with a direct dependency edge can never share a
 *    (necessarily parallel) wave — violations are rejected rather than silently reordered, so a
 *    misconfigured topology fails loudly instead of producing an unsafe rollout order.
 *
 * STAGE MODE (a topology whose waves name deployment-targets, ADR-0026 §5) is a third shape of the
 * second mode, and it keeps exactly ONE of the two `depends_on` checks: a CYCLE among co-placed
 * targets is still refused, because nothing downstream can resolve it. The same-wave refusal is
 * gone — per ADR-0028 decision 6 that ordering duty passed to the per-target trigger hold in
 * `reconcile.ts`'s executing loop. The reasoning is at the site inside `compileStages`; do not
 * restore the same-wave check, and do not remove the cycle check, without reading it.
 *
 * THAT CYCLE CHECK READS TWO SOURCES, because the hold it stands in for reads two: live `depends_on`
 * edges AND the change's own declared `stageDependencies` (`declaredStageDependencies` below). An
 * edge and a declaration are not the same fact and one can outlive the other in either direction —
 * see `coPlacedCycle`. The compiler and the hold must agree on what orders what, or the refusal
 * misses exactly the inputs that wedge.
 */

import type { WaveGate } from "@scp/schemas";

export interface DependsOnEdge {
  /** `from` depends on `to` — `to` must be scheduled in an earlier (or, if truly independent, an
   * un-shared) wave relative to `from`. */
  from: string;
  to: string;
}

export interface TopologyWaveSpec {
  name?: string;
  mode: "parallel" | "sequential";
  targets: string[];
  /** Defaults to `true` (except an implicit wave 0, which has nothing to fan in from). */
  requiresFanIn?: boolean;
  /**
   * Gates this wave ADDS on top of whatever `pipelineHooks` already declares for it — a UNION,
   * never a replacement (§14 resolution 5; the union is evaluated elsewhere, not by this module,
   * which only carries the value from parse through to the compiled wave). ABSENT and `[]` are NOT
   * the same statement: absent means this wave-document is silent about gates (only declared hooks
   * apply), while `[]` explicitly declares "this wave adds no gates of its own" — still a real,
   * present value. `topology-waves.ts`'s `parseTopologyWaves` is the only producer of this field and
   * preserves the distinction; do not `?? []` it anywhere downstream, and do not merge, dedupe, or
   * reconcile it against `pipelineHooks` here.
   */
  gates?: WaveGate[];
}

export interface CompiledWave {
  waveIndex: number;
  name: string | null;
  targets: string[];
  requiresFanIn: boolean;
  /**
   * STAGE MODE only: this wave's place is real but no target of this change is placed there, so it
   * has nothing to do (§5's participation rule). Emitted rather than omitted — see `compileStages`.
   */
  skipped?: boolean;
  /**
   * Carried verbatim from the source `TopologyWaveSpec.gates` (see there for the absent-vs-empty
   * rule this field must keep). Not yet consumed by anything downstream — gate EVALUATION is a
   * separate session's work; this compiler's job ends at "the compiled wave carries it."
   */
  gates?: WaveGate[];
}

export type CompilePlanResult =
  | { ok: true; waves: CompiledWave[] }
  | {
      ok: false;
      error: "cycle";
      cycle: string[];
      /** STAGE MODE only: which place the cycle's members share, since that is what makes it a
       *  deadlock rather than a curiosity. Absent on the toposort path, where a cycle is fatal
       *  regardless of placement. */
      detail?: string;
    }
  | { ok: false; error: "unknown_target"; target: string }
  | { ok: false; error: "target_not_placed_in_any_wave"; target: string; detail: string }
  | { ok: false; error: "no_participating_waves"; detail: string }
  | {
      ok: false;
      error: "topology_violates_dependency";
      from: string;
      to: string;
      waveOfFrom: number;
      waveOfTo: number;
      detail: string;
    };

/**
 * One entry of the change's own `properties.stageDependencies` (ADR-0028), reduced to the two fields
 * a cycle check can read: WHAT is depended on, and WHERE that applies.
 *
 * Structurally a subset of `changes-repo.ts`'s `ResolvedStageDependency`, restated here rather than
 * imported because this module is PURE by contract (BUILD_AND_TEST.md §4.1) and that one lives in a
 * file full of DB I/O. `ResolvedStageDependency[]` assigns to this directly — its extra `minWeight`
 * is deliberately not in the shape, since a qualifier that RELAXES a wait cannot rescue a cycle: a
 * mutual pair is never triggered at all, so neither side ever has a weight to read.
 */
export interface DeclaredStageDependency {
  /** A component object id — resolved at propose time. */
  dependsOn: string;
  /** When present, the declaration applies ONLY at these deployment-target ids. */
  atTargets?: string[];
}

/** One component placed at one deployment-target — the pair a stage-shaped wave resolves to. */
export interface StagePlacement {
  componentObjectId: string;
  deploymentTargetObjectId: string;
  placementObjectId: string;
}

export interface CompilePlanInput {
  targets: string[];
  dependsOn: DependsOnEdge[];
  topologyWaves?: TopologyWaveSpec[];
  /**
   * STAGE MODE (ADR-0026 §5). When present, the topology's wave `targets` are DEPLOYMENT-TARGET
   * ids rather than ids from `targets`, and each wave compiles to the PLACEMENTS of this change's
   * components at that wave's places. `plan-service.ts` classifies which mode a topology is in and
   * supplies this; the compiler stays pure.
   */
  placements?: StagePlacement[];
  /**
   * STAGE MODE ONLY — the change's own declared `stageDependencies`, already resolved to object ids
   * (`stageDependenciesOf`, `changes-repo.ts`). Read for the CO-PLACED CYCLE REFUSAL and nothing
   * else: it does not order waves, and it means nothing on the legacy or toposort paths, where a
   * wave target names a component rather than a place, so the hold's `unscopeable` branch enforces
   * no declaration there and no declaration can deadlock one.
   *
   * OPTIONAL because it REFINES a check that already had a source. Omitting it leaves the refusal
   * exactly as wide as the edge set makes it — the behaviour before this field existed — so a caller
   * with no declarations to hand is not made wrong by the parameter's existence.
   */
  declaredStageDependencies?: readonly DeclaredStageDependency[];
}

/** Builds `node -> set of nodes it depends on`, restricted to `nodes`. */
function buildDependencyMap(
  nodes: readonly string[],
  edges: readonly DependsOnEdge[]
): Map<string, Set<string>> {
  const nodeSet = new Set(nodes);
  const deps = new Map<string, Set<string>>();
  for (const n of nodes) deps.set(n, new Set());
  for (const edge of edges) {
    if (nodeSet.has(edge.from) && nodeSet.has(edge.to) && edge.from !== edge.to) {
      deps.get(edge.from)!.add(edge.to);
    }
  }
  return deps;
}

/** Deterministic layered topological sort (Kahn's algorithm). Ties sort lexicographically. */
function topoLayers(
  nodes: readonly string[],
  deps: Map<string, Set<string>>
): string[][] | { cycle: string[] } {
  const scheduled = new Set<string>();
  const remaining = new Set(nodes);
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((n) => [...deps.get(n)!].every((d) => scheduled.has(d)))
      .sort();
    if (ready.length === 0) {
      return { cycle: [...remaining].sort() };
    }
    layers.push(ready);
    for (const n of ready) {
      scheduled.add(n);
      remaining.delete(n);
    }
  }
  return layers;
}

function withFanIn(layers: string[][], names: (string | null)[] = []): CompiledWave[] {
  return layers.map((targets, i) => ({
    waveIndex: i,
    name: names[i] ?? null,
    targets,
    requiresFanIn: i > 0
  }));
}

/**
 * STAGE MODE (ADR-0026 §5) — the change supplies COMPONENTS, the topology supplies ordered PLACES,
 * and each wave is the cartesian product: the placements of this change's components at that wave's
 * deployment-targets.
 *
 * ============================================================================================
 * WHY THERE IS NO `unknown_target` CHECK HERE, AND WHY THAT IS NOT A WEAKENING
 * ============================================================================================
 * Legacy mode's check exists so a topology can only ORDER targets the change already has, never ADD
 * one. Here that is impossible BY CONSTRUCTION: every emitted target is a placement whose component
 * is in `targets`, so the product can only ever be a subset of what the change asked for. The check
 * has no job left in this mode — but it is NOT deleted, it still guards legacy mode below.
 *
 * The two sibling assumptions in legacy mode had to be handled too, because all three come from the
 * same property — "topology wave targets and change targets are the same id space" — and fixing one
 * would have left the others silently wrong:
 *
 *   * the UNASSIGNED TAIL would see every component as unassigned (the `assigned` set holds
 *     placement ids), and append each one as an extra trailing wave — double-scheduling every
 *     component, once as a placement and once as a bare component. Here, a component that
 *     participates in no wave is an ERROR instead (see below), so there is no tail at all.
 *   * the DEPENDS_ON VALIDATION keys `waveIndexOf` by emitted target; with placements emitted and
 *     component-to-component edges supplied, every lookup would miss and `continue`, turning a
 *     safety check into a silent no-op. It was re-expressed over components here; ADR-0028
 *     decision 6 has since removed it entirely from this mode — see the site below, which explains
 *     what took the guarantee over and why legacy mode keeps its own copy.
 *
 * ============================================================================================
 * AN EMPTY WAVE IS EMITTED AND MARKED `skipped`, NOT OMITTED
 * ============================================================================================
 * A wave whose places hold none of this change's components is legitimate — `agentkit-umami-prod`
 * is prod-only, so a gamma→prod change targeting it has a genuinely empty gamma wave (§5's
 * participation rule; the absence of a placement is a DECLARED statement, per D8, not a guess).
 *
 * It is emitted anyway because omitting it loses information three ways: the plan would stop being
 * isomorphic to the topology an operator wrote, so wave indices would silently not line up with the
 * declared stages; "gamma had no participants" would be invisible in the UI rather than shown; and
 * `requiresFanIn` is computed as `i > 0`, so a formerly-middle wave becoming wave 0 would flip its
 * flag. `skipped` is not a new mechanism — `change_waves.status` has documented it since the schema
 * was written, and BOTH reconcilers already select the active wave as the first one that is neither
 * succeeded nor skipped. Nothing produced the value until now.
 *
 * ============================================================================================
 * A TARGET THAT PARTICIPATES IN NO WAVE IS AN ERROR, NOT A SILENT DROP
 * ============================================================================================
 * The caller asked to release that component and this pipeline cannot: it is placed nowhere the
 * topology names. Compiling anyway would report success for a component that was never deployed —
 * the same class of silent-success the fail-closed-on-missing-binding rule (ADR-0006) exists to
 * prevent. Loud at compile time, where it becomes the change's epitaph, beats a plan that lies.
 */
function compileStages(
  input: CompilePlanInput & { topologyWaves: TopologyWaveSpec[]; placements: StagePlacement[] }
): CompilePlanResult {
  const targetSet = new Set(input.targets);
  const relevant = input.placements.filter((p) => targetSet.has(p.componentObjectId));

  const steps: {
    name: string | null;
    targets: string[];
    requiresFanIn?: boolean;
    gates?: WaveGate[];
  }[] = [];
  const participated = new Set<string>();

  const placementsAt = (deploymentTargetIds: string[]): StagePlacement[] => {
    const places = new Set(deploymentTargetIds);
    return relevant.filter((p) => places.has(p.deploymentTargetObjectId));
  };

  const pushStep = (
    name: string | null,
    group: StagePlacement[],
    requiresFanIn?: boolean,
    gates?: WaveGate[]
  ) => {
    for (const p of group) {
      participated.add(p.componentObjectId);
    }
    steps.push({
      name,
      targets: group.map((p) => p.placementObjectId),
      ...(requiresFanIn !== undefined ? { requiresFanIn } : {}),
      ...(gates !== undefined ? { gates } : {})
    });
  };

  for (const wave of input.topologyWaves) {
    const name = wave.name ?? null;
    if (wave.mode === "parallel") {
      pushStep(name, placementsAt(wave.targets), wave.requiresFanIn, wave.gates);
    } else {
      // Sequential: one step per PLACE, in the declared order. A place with no participants still
      // gets its own (empty) step, so the sequence keeps its shape. The source wave's `gates`
      // (absent-vs-empty preserved, per `TopologyWaveSpec.gates`) is carried to EVERY step split out
      // of it — the same treatment `name` and `requiresFanIn` already get on this path.
      for (const deploymentTargetId of wave.targets) {
        pushStep(name, placementsAt([deploymentTargetId]), wave.requiresFanIn, wave.gates);
      }
    }
  }

  for (const target of input.targets) {
    if (!participated.has(target)) {
      return {
        ok: false,
        error: "target_not_placed_in_any_wave",
        target,
        detail: `'${target}' has no placement at any deployment-target named by this topology, so this pipeline cannot release it — declare a placement, or use a topology that covers where it runs`
      };
    }
  }

  if (steps.every((s) => s.targets.length === 0)) {
    // Unreachable while the per-target check above stands (a change has at least one target, and
    // that target must have participated). Kept because a plan with nothing to do is a change that
    // would sit in `executing` forever: `reconcile.ts`'s zero-wave branch is a defensive no-op and
    // the watchdog only WARNS, so the failure mode is a permanent silent stall behind a warning.
    return {
      ok: false,
      error: "no_participating_waves",
      detail: "the topology's waves contain none of this change's placements — nothing would deploy"
    };
  }

  // ============================================================================================
  // THE SAME-WAVE REFUSAL IS GONE; THE CYCLE REFUSAL IS NOT (ADR-0028 decision 6)
  // ============================================================================================
  // What stood here rejected a plan whose topology put two components joined by a direct
  // `depends_on` edge in the SAME wave, as `topology_violates_dependency`.
  //
  // Cross-wave ORDER was never this check's business in stage mode: the topology orders PLACES, and
  // a component legitimately appears in several waves (gamma, then prod), so "the dependency must
  // be in an earlier wave" has no single meaning here. The one clause that did mean something was
  // the legacy check's second: two components with a direct dependency edge must not deploy AT THE
  // SAME TIME, because same wave means parallel.
  //
  // THAT GUARANTEE MOVES; IT DOES NOT VANISH. Under ADR-0028 a microservice's own CI declares what
  // it must not deploy ahead of, and every declaration is materialised as a `depends_on` edge
  // (`coordination/changes-repo.ts`) — so these edges stop being a rarity and become the ordinary
  // state of the graph. A compile-time refusal at that density converts a CORRECTLY declared
  // dependency into `plan compilation failed` -> 400 (`plan-service.ts`) -> `auto-cancelled: plan
  // compilation failed` (`reconcile.ts`) for every multi-target change that happens to touch both
  // components. The ordering is enforced instead at the per-target seam in `reconcile.ts`'s
  // executing loop, which holds A's TRIGGER at a stage until each declared dependency is satisfied
  // THERE — a grain nothing here can express, and one the wave gate cannot express either (it
  // issues one verdict for the whole wave, so blocking it to hold A would also hold B and the
  // dependency could never clear).
  //
  // THAT HOLD HAS LANDED (`coordination/stage-dependency-hold.ts`, ADR-0028 increment 3): a
  // dependent pair sharing a stage wave now COMPILES into one wave and then SERIALISES inside it —
  // the dependant's target is withheld until the dependency's target at that same place is
  // satisfied. The handover is pinned end to end by `stage-dependency-hold.integration.test.ts`'s
  // same-wave case, which is the test that makes deleting this check safe rather than merely
  // convenient.
  //
  // THE HOLD COVERS THE SAME SET THIS CHECK DID, and that equality is the whole point of calling it
  // a replacement. `input.dependsOn` is exactly the edges with BOTH endpoints among this change's
  // own targets (`loadDependsOnEdges`, `plan-service.ts`); reconcile loads that same set and unions
  // it into each target's dependency set, so an edge no declaration backs — seeded, imported,
  // operator-written, or materialised by an EARLIER change's declaration — still orders the pair.
  // What did NOT move, deliberately, is every OTHER edge in the org: an edge with an endpoint
  // outside the change's target set ordered nothing before and orders nothing now. `graph`.
  // `dependentIds` is a live CEL policy input, so making the whole graph a release gate would be a
  // large unrequested behaviour change; this check never reached that far and neither does the hold.
  //
  // WHAT CANNOT BE HANDED OVER IS A CYCLE, so it is refused right here instead. Stage mode never
  // toposorts, and the hold is a per-tick predicate with no global view: a mutual pair co-placed at
  // one deployment-target would hold each other forever, silently, where this check used to 400.
  // `coPlacedCycle` below therefore refuses it at compile time, naming the members and the place —
  // the same shape and the same loudness as what was removed. It is scoped to components that share
  // a PLACE because that is precisely where the hold looks: a cycle whose members are never
  // co-placed resolves to `not_placed` on both sides and deadlocks nothing.
  //
  // AND IT IS SCOPED TO THE PLACEMENTS THIS PLAN ACTUALLY SCHEDULES, not to `relevant`. The two
  // differ whenever a component is placed somewhere the topology never names: `relevant` is filtered
  // by COMPONENT only, while `placementsAt` is what narrows a wave to topology-named places. Handing
  // `relevant` here refuses a plan for a cycle at a deployment-target that never becomes a wave
  // target — so the hold could never look there, nothing could ever deadlock, and the change dies as
  // `auto-cancelled: plan compilation failed` for a pipeline that never co-schedules the pair. The
  // refusal must be exactly as wide as the deadlock it prevents, and no wider.
  //
  // LEGACY MODE KEEPS BOTH OF ITS CHECKS (`compilePlan` below), on purpose. Its waves name the
  // change's own targets rather than places, so its wave targets carry no deployment-target for a
  // STAGE-scoped hold to be scoped by; dropping the check there would remove the guarantee with
  // nothing taking it over.
  //
  // `componentOf` was the same-wave check's only reader and went with it. If a future rule needs
  // placement -> component again, rebuild it from `input.placements` rather than re-introducing a
  // map that is populated on every push and read by nothing.
  //
  // AND IT READS THE CHANGE'S OWN DECLARATIONS BESIDE THE EDGES, because the hold does. `input.
  // dependsOn` is `loadDependsOnEdges`, which filters `deleted_at IS NULL`; the hold enforces
  // `properties.stageDependencies` whether or not any edge survives. The two sets were assumed equal
  // and are not — see `coPlacedCycle`, which is where the divergence and the deadlock it bought are
  // written down.
  const scheduledPlacementIds = new Set(steps.flatMap((step) => step.targets));
  const cycle = coPlacedCycle(
    relevant.filter((p) => scheduledPlacementIds.has(p.placementObjectId)),
    input.dependsOn,
    input.declaredStageDependencies ?? []
  );
  if (cycle) {
    return {
      ok: false,
      error: "cycle",
      cycle: cycle.components,
      // NAMES BOTH SOURCES, because this string is the change's permanent epitaph and "delete the
      // edge" is no longer sufficient advice on its own: the ordering may come from a declaration
      // with no live edge behind it at all, which is the case that used to wedge silently.
      detail: `${cycle.components.map((c) => `'${c}'`).join(", ")} form a dependency cycle and are all placed at '${cycle.deploymentTargetObjectId}', so none of them could ever be triggered there — break the cycle before releasing them together, checking BOTH the \`depends_on\` edges among this change's targets and the change's own declared \`stageDependencies\``
    };
  }

  return {
    ok: true,
    waves: steps.map((step, i) => ({
      waveIndex: i,
      name: step.name,
      targets: step.targets,
      requiresFanIn: step.requiresFanIn ?? i > 0,
      ...(step.targets.length === 0 ? { skipped: true } : {}),
      ...(step.gates !== undefined ? { gates: step.gates } : {})
    }))
  };
}

/**
 * The one ordering shape stage mode still refuses (ADR-0028 decision 6): a cycle among this change's
 * own targets that are ALL PLACED AT THE SAME deployment-target.
 *
 * WHY IT CANNOT BE LEFT TO THE HOLD. `reconcile.ts`'s per-target hold withholds A's trigger at a
 * place until every dependency of A placed THERE has succeeded there. For a mutual pair co-placed
 * at one deployment-target that is a permanent, silent deadlock: each waits for the other's wave
 * target to leave `pending`, neither is ever triggered, the wave never terminalizes, and the change
 * sits in `executing` behind a `stage_dependency` Decision forever. A compile-time refusal turns
 * that into an epitaph an operator reads immediately (`auto-cancelled: plan compilation failed`),
 * which is exactly what the same-wave check used to do for this input.
 *
 * ============================================================================================
 * IT READS BOTH OF THE HOLD'S SOURCES — EDGES *AND* THE CHANGE'S OWN DECLARATIONS
 * ============================================================================================
 * The hold's dependency set has two halves (`stage-dependency-hold.ts`): the change's declared
 * `stageDependencies`, and plain `depends_on` edges with both endpoints among its targets. Reading
 * only the edges here treats the two as interchangeable, and they are not — a declaration can exist
 * with NO live edge behind it, permanently:
 *
 *   * `loadDependsOnEdges` (`plan-service.ts`) filters `deleted_at IS NULL`, so a soft-deleted edge
 *     is invisible to the compiler; and
 *   * `materialiseStageDependencyEdges` (`changes-repo.ts`) deliberately treats a TOMBSTONED edge as
 *     "already materialised" — `relationships_org_type_from_to_key` is a plain UNIQUE, not a partial
 *     index, so no create could replace it anyway — and therefore never re-mints it.
 *
 * So an operator deleting one edge of a mutual pair once makes that direction invisible here FOREVER,
 * while the hold keeps enforcing the declaration that has not changed at all. The change then
 * compiles, both targets hold each other at the shared place, `nonTerminalTargets - heldTargets`
 * reaches 0 with nothing failed, and reconcile's pure-hold return fires every tick: a silent wedge in
 * `executing` behind a watchdog warn, which is precisely the outcome this refusal exists to convert
 * into a loud epitaph.
 *
 * The declarations are turned into ordering pairs the way the HOLD applies them, not the way one
 * might wish they were scoped: a declaration is CHANGE-scoped and applies to EVERY target of the
 * change (the KNOWN LIMITATION on `stageDependenciesOf`, pinned by tests — do not "fix" it here,
 * where the compiler would then disagree with what actually runs). Hence, at each place: every
 * component scheduled there -> every dependency declared for that place. `buildDependencyMap`
 * discards the self-pairs and the ones naming a component not scheduled here, which is exactly the
 * hold's `self` and `not_placed` branches — both satisfied, neither able to deadlock.
 *
 * `atTargets` IS HONOURED, for the same "no wider than the deadlock" reason the whole check is
 * per-place. Two components each declaring the other, but at DIFFERENT places, deadlock at neither:
 * at each place exactly one side is held and the other is free to proceed. `minWeight` is ignored on
 * purpose — it relaxes a wait, and a pair that is never triggered never produces a weight to relax
 * against (the composition rule in `stage-dependency-hold.ts` supersedes it for an edge-asserted
 * pair regardless).
 *
 * SCOPED PER PLACE, NOT PER TARGET SET, so the refusal is neither wider nor narrower than the
 * deadlock. Two components that depend on each other but are never co-placed (A gamma-only, B
 * prod-only) resolve to `not_placed` on both sides — satisfied, nothing held — and a plan for them
 * is releasable. Refusing that would reject a working configuration; not refusing the co-placed case
 * would ship the deadlock. Per-place is also strictly finer than "same wave": a place named by two
 * topology waves puts the pair in both.
 *
 * Places are visited in sorted order so a plan with several bad places always names the same one.
 */
function coPlacedCycle(
  relevant: readonly StagePlacement[],
  dependsOn: readonly DependsOnEdge[],
  declared: readonly DeclaredStageDependency[]
): { components: string[]; deploymentTargetObjectId: string } | null {
  // BOTH sources have to be empty to skip. Keying this on the edges alone was the shortest path to
  // the wedge above: a change whose every edge had been tombstoned took the early return without
  // looking at a single placement.
  if (dependsOn.length === 0 && declared.length === 0) return null;
  const componentsByPlace = new Map<string, Set<string>>();
  for (const p of relevant) {
    let at = componentsByPlace.get(p.deploymentTargetObjectId);
    if (!at) {
      at = new Set();
      componentsByPlace.set(p.deploymentTargetObjectId, at);
    }
    at.add(p.componentObjectId);
  }
  for (const place of [...componentsByPlace.keys()].sort()) {
    const components = [...componentsByPlace.get(place)!].sort();
    if (components.length < 2) continue;
    // The union, built per place because `atTargets` makes the declared half place-dependent. Edges
    // carry no such qualifier — `minWeight`/`atTargets` deliberately do not ride on a relationship
    // (`materialiseStageDependencyEdges`) — so they apply everywhere.
    const applicable = declared.filter(
      (dep) => dep.atTargets === undefined || dep.atTargets.includes(place)
    );
    const ordering: DependsOnEdge[] = [...dependsOn];
    for (const from of components) {
      for (const dep of applicable) ordering.push({ from, to: dep.dependsOn });
    }
    // Reuses the toposort ONLY to find the cycle — its layers are discarded. Stage waves come from
    // the topology's places, never from this ordering (ADR-0026 §5), so this must not become a
    // second source of wave order.
    const result = topoLayers(components, buildDependencyMap(components, ordering));
    if ("cycle" in result) return { components: result.cycle, deploymentTargetObjectId: place };
  }
  return null;
}

export function compilePlan(input: CompilePlanInput): CompilePlanResult {
  const targetSet = new Set(input.targets);

  if (input.placements && input.topologyWaves && input.topologyWaves.length > 0) {
    return compileStages({
      ...input,
      topologyWaves: input.topologyWaves,
      placements: input.placements
    });
  }

  if (!input.topologyWaves || input.topologyWaves.length === 0) {
    const deps = buildDependencyMap(input.targets, input.dependsOn);
    const result = topoLayers(input.targets, deps);
    if ("cycle" in result) return { ok: false, error: "cycle", cycle: result.cycle };
    return { ok: true, waves: withFanIn(result) };
  }

  const steps: {
    name: string | null;
    targets: string[];
    requiresFanIn?: boolean;
    gates?: WaveGate[];
  }[] = [];
  const assigned = new Set<string>();

  for (const wave of input.topologyWaves) {
    for (const t of wave.targets) {
      if (!targetSet.has(t)) return { ok: false, error: "unknown_target", target: t };
    }
    if (wave.mode === "parallel") {
      steps.push({
        name: wave.name ?? null,
        targets: [...wave.targets],
        requiresFanIn: wave.requiresFanIn,
        gates: wave.gates
      });
      for (const t of wave.targets) assigned.add(t);
    } else {
      // Sequential: `gates` (absent-vs-empty preserved) is carried to EVERY split-out step, the same
      // treatment `name` and `requiresFanIn` already get here.
      for (const t of wave.targets) {
        steps.push({
          name: wave.name ?? null,
          targets: [t],
          requiresFanIn: wave.requiresFanIn,
          gates: wave.gates
        });
        assigned.add(t);
      }
    }
  }

  const unassigned = input.targets.filter((t) => !assigned.has(t));
  if (unassigned.length > 0) {
    const deps = buildDependencyMap(unassigned, input.dependsOn);
    const tail = topoLayers(unassigned, deps);
    if ("cycle" in tail) return { ok: false, error: "cycle", cycle: tail.cycle };
    for (const layer of tail) steps.push({ name: null, targets: layer });
  }

  const waveIndexOf = new Map<string, number>();
  steps.forEach((step, i) => {
    for (const t of step.targets) waveIndexOf.set(t, i);
  });

  for (const edge of input.dependsOn) {
    if (!targetSet.has(edge.from) || !targetSet.has(edge.to) || edge.from === edge.to) continue;
    const waveOfFrom = waveIndexOf.get(edge.from);
    const waveOfTo = waveIndexOf.get(edge.to);
    if (waveOfFrom === undefined || waveOfTo === undefined) continue;
    if (waveOfTo > waveOfFrom) {
      return {
        ok: false,
        error: "topology_violates_dependency",
        from: edge.from,
        to: edge.to,
        waveOfFrom,
        waveOfTo,
        detail: `'${edge.from}' depends on '${edge.to}', but the topology schedules '${edge.to}' in a later wave (${waveOfTo}) than '${edge.from}' (${waveOfFrom})`
      };
    }
    if (waveOfTo === waveOfFrom) {
      return {
        ok: false,
        error: "topology_violates_dependency",
        from: edge.from,
        to: edge.to,
        waveOfFrom,
        waveOfTo,
        detail: `'${edge.from}' depends on '${edge.to}', but the topology places them in the SAME wave (${waveOfFrom}) — they cannot execute in parallel`
      };
    }
  }

  return {
    ok: true,
    waves: steps.map((step, i) => ({
      waveIndex: i,
      name: step.name,
      targets: step.targets,
      requiresFanIn: step.requiresFanIn ?? i > 0,
      ...(step.gates !== undefined ? { gates: step.gates } : {})
    }))
  };
}
