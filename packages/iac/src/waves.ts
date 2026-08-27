import type { IResourceRef, ReleaseTopologyWaveSpec } from "./construct.js";

/**
 * Wave-organization guidance (team-pipeline-iac.md §8, D6 vocabulary) — the friendlier authoring
 * shape a `Pipeline`'s `waves` prop accepts, and the three helpers (`linear`/`widening`/`byDomain`)
 * that build it. `docs/guides/organizing-waves.md` is the prose companion to this file; keep the two
 * in sync if the shape here changes.
 *
 * `staging`/`production` vocabulary throughout (D6/D21e) — never `gamma`, never bare `prod`.
 */

/** One wave's member — an owned construct, a `fromXxx()` reference, or a bare URN/stage-id string,
 *  matching every other endpoint shape in this package. */
export type WaveTarget = IResourceRef | string;

/**
 * One wave, in the relaxed shape a pipeline's `waves` prop accepts (team-pipeline-iac-examples.md
 * §5's `waves.standard`):
 *   - a bare target — a single-member wave (`"commercial-amer-production"`);
 *   - a bare array of targets — a single unnamed PARALLEL wave (`[a, b, c]`);
 *   - an object — full control over `name`/`mode`/`requiresFanIn`.
 *
 * A pipeline's synth normalizes every item to a `ReleaseTopologyWaveSpec` (`construct.ts`): an
 * unnamed item gets `wave${index + 1}` (1-based, by POSITION — the same numbering regardless of
 * whether earlier waves were named, so `[{name:"staging",...}, x, [a,b]]` names its third item
 * `wave3`, matching the worked example's synth output), and `mode` defaults to `"parallel"` unless
 * given.
 */
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

/**
 * Normalizes a `WaveItem[]` (what a pipeline's `waves` prop and every `waves.*` helper below
 * produce) into the `ReleaseTopologyWaveSpec[]` `ReleaseTopology`'s constructor already accepts
 * (round A, `construct.ts`). Exported so `pipeline.ts` (which embeds this into a component's
 * release-topology object) and tests share one normalization instead of two.
 */
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

/**
 * `waves.linear(stages)` — a straight sequence of stages, one wave each, in the given order
 * (`staging → production`). Each element may itself be a group (an array) for a stage that fans out
 * to several targets at once while still being ONE step in the sequence — `linear` does not merge or
 * reorder; it is a typed pass-through so a program reads "this is the ordered stage list" at the
 * call site rather than an unlabeled array literal.
 */
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

/**
 * `waves.widening(targets, { start, factor })` — buckets a flat target list into waves whose size
 * grows geometrically (`1 → 2 → 4 → 8`, D6/§8's canonical production shape), each wave PARALLEL. The
 * final wave holds whatever remains, even if short of the ideal size — this is not padded or
 * refused, since "these targets, sooner" is exactly the point of the tail wave.
 */
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

/**
 * `waves.byDomain(...groups)` — one wave per security-domain group, IN THE GIVEN ORDER
 * (`commercial before govcloud before air-gap`, §8) — the CDS crossing gate applies per crossing, so
 * naming the domain order here is what keeps a later domain from widening ahead of an earlier one
 * that hasn't cleared its own gate. Each group is one PARALLEL wave (targets within a domain release
 * together); the SEQUENCE between groups is what carries the domain ordering.
 */
export function byDomain(...groups: (readonly WaveTarget[])[]): WaveItem[] {
  return groups.map((group) => [...group]);
}

/** Namespaced export matching the doc's `waves.linear(...)` / `waves.widening(...)` /
 *  `waves.byDomain(...)` call shape. */
export const waves = { linear, widening, byDomain };
