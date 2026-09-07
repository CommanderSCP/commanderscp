/** Process-local counters for the inbound poke path. See docs/federation.md §372. */
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

// A test seam stood here with zero callers, and was removed. See docs/federation.md §373.
