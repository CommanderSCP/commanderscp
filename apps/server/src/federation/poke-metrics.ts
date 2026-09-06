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
  wokenSync: number;
  /** Accepted pokes that successfully enqueued an inbox wake (the air-gap leg). */
  wokenInbox: number;
  /** M13.1b — accepted pokes that successfully enqueued an auto-relay wake (the BYTE leg at a
   *  `role: retrans` staging node). */
  wokenRelay: number;
  /** Accepted pokes that woke NOTHING — the split-topology hole. Watch this one. */
  notWoken: number;
}

const stats: PokeWakeStats = {
  accepted: 0,
  wokenSync: 0,
  wokenInbox: 0,
  wokenRelay: 0,
  notWoken: 0
};

export function recordPokeWake(result: {
  wokenSync: boolean;
  wokenInbox: boolean;
  wokenRelay?: boolean;
}): PokeWakeStats {
  stats.accepted += 1;
  if (result.wokenSync) stats.wokenSync += 1;
  if (result.wokenInbox) stats.wokenInbox += 1;
  if (result.wokenRelay) stats.wokenRelay += 1;
  if (!result.wokenSync && !result.wokenInbox && !result.wokenRelay) stats.notWoken += 1;
  return { ...stats };
}

export function pokeWakeStats(): PokeWakeStats {
  return { ...stats };
}

// A `resetPokeWakeStats()` "test seam" stood here with ZERO callers, including tests. Removed as
// part of the census that fixed the id-keyed property-schema validator cache: an exported
// reset/invalidate function with no caller is the exact tell that let that bug survive a green
// suite for its whole life, because it reads as a guard that exists. These counters need no reset
// — they are monotonic and nothing derives a verdict from them — so the honest state is no seam.
// Should a test ever need one, add it back WITH the caller in the same commit.
