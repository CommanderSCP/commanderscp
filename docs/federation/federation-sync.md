# federation-sync

Reference for `apps/server/src/federation/federation-sync.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 20 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M14.4 — the SPARSE cadence CEILING: 12 hours

M14.4 — the SPARSE cadence CEILING: 12 hours. REQUIRED, not decorative. pg-boss asserts `singletonSeconds <= archiveSeconds` (12h by default), so a "daily" sparse floor would THROW at runtime the moment such a value reached pg-boss. The cap makes an over-large operator value clamp instead of breaking the loop.

## §2. M14.4 — the EFFECTIVE cadence for one peer

M14.4 — the EFFECTIVE cadence for one peer. A peer is on the sparse (`"poke"`) cadence ONLY when ALL of the following hold; any one of them failing keeps it on the frequent poll:

1. `pokeMode` is set for the peer (the local operator opted in); 2. **D2, SELF-PROVING SPARSE** — a poke from that peer has ACTUALLY been received at least once (`lastPokeReceivedAt`). Poke-mode is TWO independent flags on TWO instances; if the outpost's is set and the commander's is not, nothing pokes and the frequent poll would silently drop to a 15-minute staleness with no error anywhere. Requiring PROOF that pokes arrive closes that unilateral-sparse footgun: an unproven peer keeps polling, so the misconfiguration costs nothing but the poll it was already paying; 3. **D4, RUNTIME CERT MATERIAL** — this instance has outbound client-cert material. `pokeMode` is only mTLS-checked at PAIR time; if the cert material later disappears, the poke SENDER goes inert and the dialer fail-closes, so the poke path is dead while the flag still says sparse. Both halves of poke-mode must fail the same way, so no certs ⇒ frequent; 4. **the reconnect leg** — the last pull ATTEMPT succeeded. A failing peer (commander down, network partition, refused bundle) returns to the frequent cadence until ONE pull succeeds, which re-arms sparse. This is the "pull-on-(re)connect" half of the decided reliability model, expressed as a pure function of two timestamps (no counters — replica-safe).

## §3. The `reason` a tick carries

The `reason` a tick carries. An INTERVAL tick carries none (the self-reschedule sends `{}`), so `reason === undefined` is exactly "this is a scheduled tick".

- `"poke"` — the contentless poke's wake (`wakeFederationSyncNow`): FORCES, does NOT re-schedule (it rides alongside the interval chain, which is still pending). - `"startup"` — the pull-on-(re)connect tick fired by `startFederationSyncLoop`: FORCES (see `FEDERATION_SYNC_STARTUP_REASON`) and DOES re-schedule (it bootstraps the chain).

## §4. TWO INDEPENDENT FLAGS

TWO INDEPENDENT FLAGS — see the module header's table. pg-boss hands the handler a BATCH.

FORCE: a POKE job or a STARTUP job bypasses the due-gate (otherwise a poke pulls nothing, and a restart pulls nothing for any peer that had already been attempted).

RESCHEDULE: owed by every NON-POKE job. A poke rides ALONGSIDE the interval chain (its pending interval job is untouched and still fires), so re-scheduling on a poke would insert an EXTRA pending tick — pg-boss computes the singleton slot from now() AT INSERT, so a poke landing in a different slot is not deduped and poke traffic would make the "sparse" loop non-deterministically denser. A STARTUP job, by contrast, is the tick that BOOTSTRAPS the chain and MUST re-schedule.

Keying the re-schedule on "the batch contains a non-poke job" rather than on "no poke is present" is the batchSize>1 hardening: pg-boss 10.4.2 defaults batchSize to 1, so a poke and an interval tick cannot arrive together today — but if this queue ever took a larger batch, a mixed batch would CONSUME the interval job and skip its re-schedule, permanently killing the self-rescheduling chain until process restart.
