/**
 * M14.4 (S7) — process-local counters for the INBOUND poke path, so the split-topology hole is
 * DETECTABLE rather than a silent one-line log.
 *
 * THE HOLE: a poke is honored by whatever process serves the HTTPS request. If that process is a
 * pure `role=api` replica (or one where the sync/inbox loops are disabled), there is no job queue to
 * enqueue the wake on — the poke returns `202 {accepted:true, woken:false}` and NOTHING pulls. That
 * is by design ("accepted-but-no-op"; the sparse safety-net is the reliability floor), but a
 * deployment where it happens on EVERY poke has effectively lost poke-mode while every dashboard
 * still says the endpoint is healthy. A counter plus a WARN makes "my pokes are accepted and do
 * nothing" visible without inventing a metrics backend (charter principle 4 — no new dependency).
 *
 * Deliberately in-process and unexported to any scrape endpoint: the values ride the structured warn
 * log (`notWoken` is included on every warn) and are readable by tests. If/when an instance-level
 * metrics surface lands, this is the single place to hang it off.
 */
export interface PokeWakeStats {
  /** Pokes that passed every gate (mTLS identity, consent, rate limit) and were acted on. */
  accepted: number;
  /** Accepted pokes that successfully enqueued a federation-sync wake. */
  wokenSync: number;
  /** Accepted pokes that successfully enqueued an inbox wake (the air-gap leg). */
  wokenInbox: number;
  /** Accepted pokes that woke NOTHING — the split-topology hole. Watch this one. */
  notWoken: number;
}

const stats: PokeWakeStats = { accepted: 0, wokenSync: 0, wokenInbox: 0, notWoken: 0 };

export function recordPokeWake(result: {
  wokenSync: boolean;
  wokenInbox: boolean;
}): PokeWakeStats {
  stats.accepted += 1;
  if (result.wokenSync) stats.wokenSync += 1;
  if (result.wokenInbox) stats.wokenInbox += 1;
  if (!result.wokenSync && !result.wokenInbox) stats.notWoken += 1;
  return { ...stats };
}

export function pokeWakeStats(): PokeWakeStats {
  return { ...stats };
}

/** Test seam. */
export function resetPokeWakeStats(): void {
  stats.accepted = 0;
  stats.wokenSync = 0;
  stats.wokenInbox = 0;
  stats.notWoken = 0;
}
