/**
 * Tiny latency-percentile helper shared by the M8 informational load-test scripts
 * (graph-scale.ts, event-path.ts — BUILD_AND_TEST.md §8 M8 "informational load tests... no
 * benchmark gate — review decision"). Deliberately dependency-free (no stats library) — this is
 * reporting tooling, not product code, and the percentile math is a handful of lines.
 */

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Nearest-rank percentile over an ALREADY-SORTED-ASCENDING array (caller sorts once, reused
 *  across p50/p95/p99 rather than re-sorting per call). `p` is 0..100. */
function nearestRank(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[index]!;
}

export function summarize(latenciesMs: number[]): LatencySummary {
  if (latenciesMs.length === 0) {
    return { count: 0, minMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN, maxMs: NaN, meanMs: NaN };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    p50Ms: nearestRank(sorted, 50),
    p95Ms: nearestRank(sorted, 95),
    p99Ms: nearestRank(sorted, 99),
    maxMs: sorted[sorted.length - 1]!,
    meanMs: sum / sorted.length
  };
}

export function formatSummary(label: string, s: LatencySummary): string {
  if (s.count === 0) return `${label}: no samples`;
  return (
    `${label}: n=${s.count} min=${s.minMs.toFixed(1)}ms p50=${s.p50Ms.toFixed(1)}ms ` +
    `p95=${s.p95Ms.toFixed(1)}ms p99=${s.p99Ms.toFixed(1)}ms max=${s.maxMs.toFixed(1)}ms ` +
    `mean=${s.meanMs.toFixed(1)}ms`
  );
}

/** Simple mulberry32 PRNG — used only so a script run's target-node sample is reproducible
 *  within a single process without pulling in a dependency; not cryptographic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks `count` distinct random elements from `arr` using `rand()` (a `() => number` in [0,1)). */
export function sampleDistinct<T>(arr: readonly T[], count: number, rand: () => number): T[] {
  const pool = [...arr];
  const picked: T[] = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * pool.length);
    picked.push(pool[idx]!);
    pool[idx] = pool[pool.length - 1]!;
    pool.pop();
  }
  return picked;
}
