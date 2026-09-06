# status-repo

Reference for `apps/server/src/federation/status-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 8 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE CONFIGURED TRANSPORT CHANNEL

THE CONFIGURED TRANSPORT CHANNEL — a fact about CONFIG, kept strictly out of `trustTier` (owner decision: one field meaning both trust posture and reachability would mean neither) AND strictly out of OBSERVATION (review round 4: the label used to say `"connected"`, which is a claim this instance cannot derive from config at all).

- `"dialable"` — an https/mTLS-capable base URL is CONFIGURED, so this side MAY dial the peer. It does NOT say the peer has ever been reached: that is `lastPullAttemptAt`/`lastPullSuccessAt` and `effectiveCadence`, in the same row, which do reflect failure. Uses the SAME predicate the sender and the M14.1 pair-time guard use (`federationPeerRequiresMtls`), so the label can never disagree with what the transport would actually do. - `"air-gap"` — NO base URL at all, and a configured `deliveryTarget`: a file/object channel an operator (or a CDS) carries. That IS the air-gapped topology. - `null` — not honestly derivable, in TWO cases, both declared unknown: * no base URL and no delivery target — no transport configured at all, a misconfiguration rather than a posture (it is emphatically NOT "air-gapped"); * a base URL federation REFUSES to dial (plain http). A peer with `http://` plus a deliveryTarget used to read `"air-gap"` — labelling a configured, non-air-gapped topology air-gapped because its URL was rejected. Two contradictory transport statements is a misconfiguration to surface, not a posture to infer.

## §2. AUTHORITY, NOT LAST-WRITE-WINS

AUTHORITY, NOT LAST-WRITE-WINS (review round 4). This used to be a plain `Map.set` loop over the list, so with two rows bound to one peer the LAST one seen won — and a `provenance:'manual'` shadow could silently OVERRIDE the commander's own asserted tier on the Overview, a hand-typed copy beating the authority. The projection now carries `originIsSelf`/`provenance`, so the winner is chosen the same way `findOutpostConfigByPeer` chooses one: local-origin first, then a verified replica, then an unverified shadow — and the winner's provenance rides out on the row so phase B can tell them apart.

RANK FIRST, THEN READ THE WINNER'S TIER (review round 5, N4). The loop used to `continue` on a tier-less row BEFORE ranking, so the ranking only ever chose among rows that HAPPENED to carry a value — and a commander's own local-origin object that deliberately asserts NO tier lost to a hand-typed shadow that did. Measured: `/federation/status` reported `il5` / `unverified` for a peer whose `GET /v1/federation/outposts/{peer}` answered `trustTier: null, originIsSelf: true` at the same instant. ADR-0022 says the local-origin row WINS, full stop: A LOCAL-ORIGIN ROW'S SILENCE MUST SILENCE THE FIELD. Choosing the winner first and reading its tier afterwards is also exactly what `findOutpostConfigByPeer` does, which is why the two surfaces now agree by construction rather than by coincidence (`outpost-handfill-wedge` pins the agreement).

## §3. THE CORRECTLY-FILTERED INBOUND ANCHOR

THE CORRECTLY-FILTERED INBOUND ANCHOR (review round 4). `lastSyncedAt`/`lastSyncedBundleChecksum` used to be read off `listRecentTransfers(...).find(t => t.status === 'confirmed')` — ANY direction, ANY kind, over the last 5 rows. A confirmed import/PROMOTION row (exactly what `promotion-repo.ts` writes on every accepted promotion bundle) therefore satisfied it, and the field documented as "the last confirmed INBOUND SYNC bundle" reported a PROMOTION checksum for a peer no sync bundle had ever arrived from. `lastConfirmedSyncImportAt` is the helper that has always had the right predicate (`direction='import' AND kind='sync' AND status='confirmed'`) and an index shaped for it; both fields now come off that ONE row, so they cannot disagree.

## §4. M14.4 (S7, ADR-0009)

M14.4 (S7, ADR-0009) — the live-pull FRESHNESS + the cadence actually in force. These are what an operator needs to answer "is this peer sparse, and is that intentional?": * lastPullAttemptAt / lastPullSuccessAt — an attempt WITHOUT a later success is a peer in the reconnect leg (it is back on the frequent cadence until one pull succeeds); * lastPokeReceivedAt — `null` on a pokeMode peer is the UNILATERAL-SPARSE misconfiguration (this side opted in, the other side never pokes). D2 keeps it polling, and this field is how you SEE that; * effectiveCadence — the cadence the scheduler would use RIGHT NOW, not the raw flag. It reports "poll" for a pokeMode peer that has never been poked (D2), when this instance has no outbound client-cert material (D4), and while the peer's last pull failed.
