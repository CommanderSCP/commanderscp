/** The plan compiler (DESIGN.md §9.3). See docs/coordination.md §677. */

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
  /** Gates this wave adds on top, always a union. See docs/coordination.md §678. */
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
  /** Carried verbatim from the source topology spec. See docs/coordination.md §679. */
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

/** One stage-dependency entry, reduced to two fields. See docs/coordination.md §680. */
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
  /** STAGE MODE (ADR-0026 §5). See docs/coordination.md §681. */
  placements?: StagePlacement[];
  /** STAGE MODE ONLY. See docs/coordination.md §682. */
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

/** STAGE MODE (ADR-0026 §5). See docs/coordination.md §683. */
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

  // The same-wave refusal is gone; the cycle refusal is not. See docs/coordination.md §684.
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

/** The one ordering shape stage mode still refuses. See docs/coordination.md §685. */
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
