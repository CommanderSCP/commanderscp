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
}

export type CompilePlanResult =
  | { ok: true; waves: CompiledWave[] }
  | { ok: false; error: "cycle"; cycle: string[] }
  | { ok: false; error: "unknown_target"; target: string }
  | {
      ok: false;
      error: "topology_violates_dependency";
      from: string;
      to: string;
      waveOfFrom: number;
      waveOfTo: number;
      detail: string;
    };

export interface CompilePlanInput {
  targets: string[];
  dependsOn: DependsOnEdge[];
  topologyWaves?: TopologyWaveSpec[];
}

/** Builds `node -> set of nodes it depends on`, restricted to `nodes`. */
function buildDependencyMap(nodes: readonly string[], edges: readonly DependsOnEdge[]): Map<string, Set<string>> {
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

export function compilePlan(input: CompilePlanInput): CompilePlanResult {
  const targetSet = new Set(input.targets);

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
      steps.push({ name: wave.name ?? null, targets: [...wave.targets], requiresFanIn: wave.requiresFanIn });
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
