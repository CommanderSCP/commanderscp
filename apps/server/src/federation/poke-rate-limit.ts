/** The inbound federation poke rate limit. See docs/federation.md §374. */

/** Seconds between token refills — a peer regains one poke allowance each interval. */
export const POKE_RATE_LIMIT_REFILL_SECONDS = Math.max(
  1,
  Number(process.env.SCP_FEDERATION_POKE_MIN_INTERVAL_SECONDS ?? 5)
);

/** Bucket capacity (max burst). Default 1 → a burst of pokes yields at most one pull per window. */
export const POKE_RATE_LIMIT_CAPACITY = Math.max(
  1,
  Number(process.env.SCP_FEDERATION_POKE_BURST ?? 1)
);

export interface PokeRateLimiterOptions {
  capacity: number;
  refillIntervalMs: number;
  /** Test seam — inject a deterministic clock. Defaults to `Date.now`. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  /** The last instant `tokens` was reconciled to (advances in whole refill intervals). */
  updatedAt: number;
}

export class PokeRateLimiter {
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: PokeRateLimiterOptions) {
    this.capacity = Math.max(1, opts.capacity);
    this.refillIntervalMs = Math.max(1, opts.refillIntervalMs);
    this.now = opts.now ?? Date.now;
  }

  /** Attempts to spend one token for `key`. Returns `true` (allow) if a token was available, `false`
   *  (drop → 429) otherwise. A never-seen key starts full. Refills in whole intervals so the bucket
   *  can never leak fractional tokens or drift with call frequency. */
  tryConsume(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };

    const elapsed = now - bucket.updatedAt;
    if (elapsed >= this.refillIntervalMs) {
      const refills = Math.floor(elapsed / this.refillIntervalMs);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refills);
      bucket.updatedAt += refills * this.refillIntervalMs;
    }

    if (bucket.tokens <= 0) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Test seam — drop all bucket state so cases in one process don't bleed into each other. */
  reset(): void {
    this.buckets.clear();
  }
}

/** The process-wide singleton the poke endpoint uses (per-process state is sufficient — see the
 *  module header). Exported so the integration suite can `reset()` it between cases. */
export const pokeRateLimiter = new PokeRateLimiter({
  capacity: POKE_RATE_LIMIT_CAPACITY,
  refillIntervalMs: POKE_RATE_LIMIT_REFILL_SECONDS * 1000
});
