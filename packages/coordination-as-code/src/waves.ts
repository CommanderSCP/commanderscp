import type { IResourceRef, ReleaseTopologyWaveSpec } from "./construct.js";

/** Wave-organization guidance (team-pipeline-iac.md §8, D6 vocabulary). See docs/coordination-as-code.md §320. */

/** One wave's member — an owned construct, a `fromXxx()` reference, or a bare URN/stage-id string,
 *  matching every other endpoint shape in this package. */
export type WaveTarget = IResourceRef | string;

/** One wave, in the relaxed shape a pipeline's `waves` prop accepts. See docs/coordination-as-code.md §321. */
export type WaveItem =
  | WaveTarget
  | readonly WaveTarget[]
  | {
      readonly name?: string;
      readonly targets: readonly WaveTarget[];
      readonly mode?: "parallel" | "sequential";
      readonly requiresFanIn?: boolean;
    };

function isWaveObject(
  item: WaveItem
): item is Extract<WaveItem, { readonly targets: readonly WaveTarget[] }> {
  return (
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    "targets" in item &&
    Array.isArray((item as { targets?: unknown }).targets)
  );
}

/** Normalizes a `WaveItem[]`. See docs/coordination-as-code.md §322. */
export function normalizeWaveItems(items: readonly WaveItem[]): ReleaseTopologyWaveSpec[] {
  return items.map((item, index) => {
    const autoName = `wave${index + 1}`;
    if (Array.isArray(item)) {
      return { name: autoName, mode: "parallel", targets: [...(item as readonly WaveTarget[])] };
    }
    if (isWaveObject(item)) {
      return {
        name: item.name ?? autoName,
        mode: item.mode ?? "parallel",
        targets: [...item.targets],
        ...(item.requiresFanIn !== undefined ? { requiresFanIn: item.requiresFanIn } : {})
      };
    }
    // A bare target (string or IResourceRef) — a single-member wave.
    return { name: autoName, mode: "parallel", targets: [item as WaveTarget] };
  });
}

/** A straight sequence of stages, one wave each. See docs/coordination-as-code.md §323. */
export function linear(stages: readonly WaveItem[]): WaveItem[] {
  return [...stages];
}

export interface WideningOptions {
  /** Targets in the first wave. Must be a positive integer. */
  readonly start: number;
  /** Multiplier applied to the previous wave's size for each subsequent wave. Must be a positive
   *  integer (`factor: 1` yields equal-sized waves — legal, just not "widening"). */
  readonly factor: number;
}

/** `waves.widening(targets, { start, factor })`. See docs/coordination-as-code.md §324. */
export function widening(
  targets: readonly WaveTarget[],
  opts: WideningOptions
): (readonly WaveTarget[])[] {
  if (!Number.isInteger(opts.start) || opts.start < 1) {
    throw new Error(`waves.widening: start must be a positive integer, got ${opts.start}`);
  }
  if (!Number.isInteger(opts.factor) || opts.factor < 1) {
    throw new Error(`waves.widening: factor must be a positive integer, got ${opts.factor}`);
  }
  const result: (readonly WaveTarget[])[] = [];
  let index = 0;
  let size = opts.start;
  while (index < targets.length) {
    result.push(targets.slice(index, index + size));
    index += size;
    size *= opts.factor;
  }
  return result;
}

/** One wave per security-domain group, in the given order. See docs/coordination-as-code.md §325. */
export function byDomain(...groups: (readonly WaveTarget[])[]): WaveItem[] {
  return groups.map((group) => [...group]);
}

/** Namespaced export matching the doc's `waves.linear(...)` / `waves.widening(...)` /
 *  `waves.byDomain(...)` call shape. */
export const waves = { linear, widening, byDomain };
