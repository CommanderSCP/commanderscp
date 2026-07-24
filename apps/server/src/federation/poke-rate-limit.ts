/**
 * M14.2 (ADR-0009, docs/proposals/outpost-poke.md §"Design principles" 5) — the inbound federation
 * poke's PER-PEER token bucket.
 *
 * The poke is contentless and idempotent: N pokes in a window must trigger AT MOST ONE pull (the
 * pull drains everything pending regardless of how many pokes prompted it), so a spoofed or replayed
 * burst can do no more than one authorized pull's worth of work — no dedupe ledger is needed, just a
 * fixed low cap that drops the excess with a 429. This is a deliberately simple in-memory bucket,
 * NOT a durable/clustered limiter: the worst case a slipped-through extra poke can cause is one more
 * (already-authorized, idempotent) pull, so per-process state is sufficient and the charter's
 * PostgreSQL-only-required-dependency invariant is untouched (no new stateful service).
 *
 * Default cap is 1 with a short refill window: the first poke from a peer consumes the token and
 * wakes the pull; further pokes from that peer within the window are dropped (429) until the window
 * refills. Keyed per `(org, peer)` so one noisy commander can never starve another's pokes.
 */

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
