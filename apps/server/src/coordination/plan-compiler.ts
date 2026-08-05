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
 * second mode, and it does NOT validate `depends_on` at all: per ADR-0028 decision 6 its ordering
 * duty passed to the per-target trigger hold in `reconcile.ts`'s executing loop. The reasoning is at
 * the (deliberately empty) site inside `compileStages`; do not restore a check there without
 * reading it.
 */

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
}

export type CompilePlanResult =
  | { ok: true; waves: CompiledWave[] }
  | { ok: false; error: "cycle"; cycle: string[] }
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

  const steps: { name: string | null; targets: string[]; requiresFanIn?: boolean }[] = [];
  const participated = new Set<string>();

  const placementsAt = (deploymentTargetIds: string[]): StagePlacement[] => {
    const places = new Set(deploymentTargetIds);
    return relevant.filter((p) => places.has(p.deploymentTargetObjectId));
  };

  const pushStep = (name: string | null, group: StagePlacement[], requiresFanIn?: boolean) => {
    for (const p of group) {
      participated.add(p.componentObjectId);
    }
    steps.push({
      name,
      targets: group.map((p) => p.placementObjectId),
      ...(requiresFanIn !== undefined ? { requiresFanIn } : {})
    });
  };

  for (const wave of input.topologyWaves) {
    const name = wave.name ?? null;
    if (wave.mode === "parallel") {
      pushStep(name, placementsAt(wave.targets), wave.requiresFanIn);
    } else {
      // Sequential: one step per PLACE, in the declared order. A place with no participants still
      // gets its own (empty) step, so the sequence keeps its shape.
      for (const deploymentTargetId of wave.targets) {
        pushStep(name, placementsAt([deploymentTargetId]), wave.requiresFanIn);
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
  // DEPENDS_ON IS NO LONGER VALIDATED IN STAGE MODE (ADR-0028 decision 6)
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
  // UNTIL THAT HOLD LANDS (ADR-0028 increment 3), a dependent pair sharing a stage wave compiles
  // and its targets run in parallel. That window is deliberate and bounded: `loadDependsOnEdges`
  // (`plan-service.ts`) only returns edges with BOTH endpoints inside the change's own target set,
  // and 277 of 281 measured changes target exactly one component (ADR-0026) — a single-target
  // change has no such pair to order.
  //
  // LEGACY MODE KEEPS BOTH OF ITS CHECKS (`compilePlan` below), on purpose. Its waves name the
  // change's own targets rather than places, so its wave targets carry no deployment-target for a
  // STAGE-scoped hold to be scoped by; dropping the check there would remove the guarantee with
  // nothing taking it over.
  //
  // `componentOf` was this check's only reader and went with it. If a future rule needs
  // placement -> component again, rebuild it from `input.placements` rather than re-introducing a
  // map that is populated on every push and read by nothing.

  return {
    ok: true,
    waves: steps.map((step, i) => ({
      waveIndex: i,
      name: step.name,
      targets: step.targets,
      requiresFanIn: step.requiresFanIn ?? i > 0,
      ...(step.targets.length === 0 ? { skipped: true } : {})
    }))
  };
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

  // Explicit-topology mode.
  const steps: { name: string | null; targets: string[]; requiresFanIn?: boolean }[] = [];
  const assigned = new Set<string>();

  for (const wave of input.topologyWaves) {
    for (const t of wave.targets) {
      if (!targetSet.has(t)) return { ok: false, error: "unknown_target", target: t };
    }
    if (wave.mode === "parallel") {
      steps.push({
        name: wave.name ?? null,
        targets: [...wave.targets],
        requiresFanIn: wave.requiresFanIn
      });
      for (const t of wave.targets) assigned.add(t);
    } else {
      for (const t of wave.targets) {
        steps.push({ name: wave.name ?? null, targets: [t], requiresFanIn: wave.requiresFanIn });
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
      requiresFanIn: step.requiresFanIn ?? i > 0
    }))
  };
}
