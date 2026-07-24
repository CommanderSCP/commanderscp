# Proposal: Optional Poke-Mode Federation (per-outpost)

**Status:** Proposed — pending review (2026-07-18)
**Relates to:** DESIGN.md §13 (Federation), [ADR-0004](../adr/0004-service-naming-commander-outpost-retrans.md) (commander/outpost/retrans), [ADR-0009](../adr/0009-optional-poke-mode-federation.md) (this decision)
**Milestone:** M14 (provisional — post-M11 federation track; see BUILD_AND_TEST.md §8)

## Grounding finding + build note (2026-07-24)

**The "frequent interval poll" this proposal assumed already existed did NOT.** M6 shipped the `.scpbundle` **file** transport (`scp federation export/import`, fully tested) and the `federation-https` **plugin contract** (`packages/plugins/federation-https`), but the actual **scheduled HTTP live pull** (an outpost dialing the commander's `/federation/exports` on an interval to pull+import) and the **outbound mTLS client-cert injection** were **deferred** — flagged in the M6 PR body and in the `federation-https` module header ("wiring the subprocess host to actually inject per-peer mTLS certs … is real remaining work this milestone does not complete"). M8 later built the client-cert *presentation* for the `federation-https` subprocess (env-file material forwarded gated on module identity), but no scheduler ever drove a live pull. So poke-mode had nothing to optimize yet: there was no frequent poll to disable.

**Owner decision (full-scope M14, 2026-07-24):** build the deferred live-sync **substrate** first (M14.0), then the poke increments (M14.1–M14.4) on top. M14.0 delivers (a) a **fail-closed per-peer mTLS outbound dialer** reusing the M8 client-cert material (no new CA scheme) and (b) the **outpost live-pull scheduler** (`startFederationSyncLoop`, mirroring `startInboxLoop`) that pulls+imports over that dialer through the **unchanged** `importSyncBundle` verification, with the two backstop legs this design's reliability model requires — **pull-on-startup** and the **sparse safety-net** interval tick. It adds no new public API (internal loop + dialer; `/v1` untouched). See BUILD_AND_TEST.md §8 M14.0.

## Problem

Today every federation connection is **outpost-initiated on an interval** (DESIGN.md §13, Transports item 1, review decision 2026-07-08): a connected outpost dials the commander over mTLS HTTPS to *pull* commander-origin config and *push* its own status/audit segments, and **the commander never initiates a connection to an outpost**. The same holds for a retrans instance at a CDS boundary. *(2026-07-24: "on an interval" is now literally true — M14.0 built the scheduled pull that had been deferred since M6; see the grounding note above.)*

This is exactly right for regulated partitions — but where it *isn't* required, it has two costs:

1. **Chatty steady state.** To keep pending transfers latency-low, the outpost must poll frequently. Most polls find nothing. That's continuous load on both the outpost and the commander, and it scales with the number of outposts.
2. **Latency floor.** A pending transfer waits up to one poll interval before the outpost notices it. Lowering the interval trades directly against cost #1.

For co-located, same-partition, or commercial outposts — where there is no cross-domain boundary to honor — this polling is pure waste.

## Proposal

Add an **optional, per-outpost "poke"**: a **contentless** notification the commander sends to an outpost (or retrans) meaning only *"something is pending for you — come pull."* The poke carries **no data**: the outpost already knows how to reach the commander to query and pull pending transfers over its existing outbound path. When **poke-mode** is enabled for an outpost, that outpost's **frequent interval poll is disabled** — it pulls in response to a poke (plus a sparse safety-net; see below).

Poke-mode is **off by default** and configured **per outpost**. An instance can serve some outposts in poll-mode and others in poke-mode simultaneously.

## Design principles

1. **Contentless — the data-direction invariant is preserved.** The poke carries zero bytes of config/status. All data still flows **outpost→commander via pull**. The federation invariant is restated (see ADR-0009) from *"the commander never initiates to an outpost"* to *"no **data** flows commander→outpost; the commander MAY send a **contentless wake signal** to an outpost only where that outpost is configured for poke-mode and the topology/accreditation permit it."* The Ed25519 journal/bundle signatures remain the sole integrity/authenticity control, exactly as today.

2. **Per-outpost, default-off.** Poke-mode is a property of the enrollment/binding of a specific outpost, not a global switch. Default is unchanged (poll-mode).

3. **Poke-mode disables the chatty interval poll.** This is the explicit goal: eliminate the constant reach-outs. In poke-mode the outpost does not run its frequent poll loop; it pulls on poke.

4. **A dropped poke must self-heal — reliability backstop (decided, owner 2026-07-18).** If the poke were the *only* trigger, a single lost poke (commander restart mid-send, outpost briefly down, transient network fault) would strand a pending transfer until the next unrelated poke. **Decision:** poke-mode disables the *frequent* poll but retains a **sparse safety-net reconcile** (a rare pull sweep on a long interval) **plus pull-on-(re)connect/startup**, so a missed poke self-heals within a bounded window. This keeps the poke a *latency optimization over a slow, reliable backstop* — never a single-point-of-failure trigger — while still removing the chatty polling. (Considered and rejected: pure poke-only with commander-side retry-until-pull-confirmed — more machinery, and still needs a floor for a fully-offline outpost.)

5. **Authenticated, idempotent, contentless → tiny attack surface.** The poke endpoint on the outpost authenticates the *caller* as the enrolled commander via the same mTLS peer identity the outpost already trusts for the commander (ADR-0001 in-app mTLS applies unchanged), and is rate-limited. Because the poke carries no data and is idempotent, the worst a spoofed or replayed poke can do is cause the outpost to perform a pull it is already authorized to perform — no data injection, no amplification beyond one pull.

## The network-topology crux (why this must be optional and per-outpost)

Poke-mode **inverts the connection-initiation direction**: the commander must be able to **dial into** the outpost's poke endpoint. That is precisely the property the regulated-partition boundary constrains. DESIGN.md §13 states the motivating reality directly: *"GovCloud may dial out to the commercial partition where the commander lives, but commercial cannot dial into GovCloud."*

Consequences:

- **Poke-mode requires bidirectional reachability** — commander→outpost for the poke *and* outpost→commander for the pull. Pure-pull needs only the latter. Poke-mode is therefore strictly more demanding on network topology.
- **A *direct* commander→outpost poke into a GovCloud/IL domain is topologically impossible** (commercial cannot reach into GovCloud). This is a *stronger* justification for default-off/per-outpost than policy alone.
- **But the poke still reaches an air-gapped domain via the retrans chain (owner clarification, 2026-07-18):** commander → reachable **low-side retrans** → (pull/validate/tarball) → **CDS** → **high-side retrans inside the air gap** → **pokes the outpost locally** (intra-domain, required). Each hop is locally reachable; no end-to-end commander→outpost path is needed. See [ADR-0009](../adr/0009-optional-poke-mode-federation.md) and the master model `promotion-and-execution-model.md` §5.
- **Only pure sneakernet** (no CDS data path at all) has no poke — a signed bundle file walked across, exactly as today.
- Poke-mode fits **co-located / same-partition / commercial outposts** — exactly where the outpost *is* reachable from the commander and where the constant polling is wasted.

Enabling poke-mode for an outpost thus requires two independent conditions: (a) the network permits commander→outpost dialing, and (b) the outpost's accreditation permits a (contentless, authenticated) inbound listener. FedRAMP / IL4-5 / CDS deployments keep it **off** — which is the whole point of making it optional.

## retrans

A retrans instance at a CDS boundary gets the identical model: the commander pokes it to signal *"there is a pending transfer to relay,"* and retrans pulls and relays onward. Same contentless/authenticated/idempotent contract, same reachability caveats (a retrans on the far side of a CDS is typically not commander-dialable → stays pull-mode).

## Milestone scope (M14)

- **Config:** a per-outpost `federation.pokeMode` (default off) on the outpost enrollment/peer binding, surfaced through the API→SDK→CLI→UI parity chain like any other capability.
- **Outpost/retrans poke endpoint:** a contentless, mTLS-commander-authenticated, rate-limited endpoint (FederationTransport-adjacent) that, on receipt, wakes the outpost's pull immediately. No request body is trusted.
- **Commander poke sender:** on a new pending-transfer for a poke-mode outpost (outbox-derived, like all federation feeds — DESIGN §5), the commander sends a poke to that outpost. Best-effort under the recommended backstop design; the sparse pull is the reliability floor.
- **Outpost scheduler mode:** in poke-mode, disable the frequent interval poll; retain the sparse safety-net reconcile + pull-on-(re)connect/startup.
- **Tests (real Postgres via Testcontainers where applicable):** poke triggers an immediate pull; poke-mode disables the frequent poll; a non-commander caller is rejected; a replayed/contentless poke is idempotent; **a dropped poke self-heals via the safety-net backstop**; poll-mode outposts are unchanged; air-gap/bundle path unaffected.

## Decisions

**Resolved (owner, 2026-07-18):**
1. **Reliability model → poke + sparse safety-net backstop.** Poke-mode disables the *frequent* poll but retains a sparse safety-net reconcile + pull-on-(re)connect, so a dropped poke self-heals; the poke is a latency optimization over a reliable floor, never a single point of failure. *Not* pure poke-only.
3. **Poke transport → reuse the `federation-https` mTLS routes** with one new contentless verb. A single identity/verification path (ADR-0001) — no dedicated listener.

**Resolved (owner, 2026-07-24 — M14.4 build):**
2. **Safety-net interval default → 900s (15 min), as an INSTANCE env var — CLOSED.**
   `SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default `900`, resolved per tick from the live env
   and clamped to `[SCP_FEDERATION_SYNC_INTERVAL_SECONDS, 43200]`.
   - **Not per outpost** (this reverses the "configurable per outpost" phrasing above). A per-peer
     column lives on the *commander's* row for that outpost, so it would let a commander operator
     dictate how often a downstream instance polls — a policy inversion. How often THIS instance
     reconciles is an instance-deployment concern, exactly like `SCP_FEDERATION_SYNC_LOOP` and
     `SCP_INBOX_LOOP`. It also avoids dragging a pure tuning knob through the whole
     schema→API→SDK→CLI→UI parity chain for no operator gain.
   - **15 minutes** because that is the worst-case staleness a *dropped poke* can cause (the poke
     normally delivers in seconds), while cutting steady-state poll traffic by ~15× versus the 60s
     frequent default. Non-chatty, and small enough that no one is left wondering for an hour.
   - **The 43200s (12h) ceiling is REQUIRED, not cosmetic — do not re-propose "daily".** pg-boss
     asserts `singletonSeconds <= archiveSeconds` (12h by default), so a daily value would throw at
     runtime the moment it reached pg-boss. The lower clamp exists because a "sparse" interval
     denser than the frequent one is meaningless.
   - **Two additional gates on going sparse at all** (owner decisions D2/D4, 2026-07-24): a peer must
     have **actually received a poke** from that peer before its frequent poll is disabled
     (self-proving sparse — poke-mode is two independent flags on two instances, and a one-sided
     enable would otherwise degrade freshness silently), and the instance must have runtime outbound
     client-cert material (without it the poke path is dead while the flag still says sparse). A
     failing pull also returns the peer to the frequent cadence until one pull succeeds.

## Non-goals

- **Not a data channel.** The poke never carries config, status, or any payload.
- **Not required.** Federation continues to work in pure-pull everywhere; poke-mode is an opt-in optimization for reachable outposts only.
- **Not for pure sneakernet** (no CDS data path — a signed bundle walked across). Air-gapped domains *behind a CDS* are still reached via the retrans relay chain (see the network-topology crux); only fully-disconnected bundle-only domains stay manual.
- **No change to the integrity model.** Ed25519 signatures over the journal/bundle remain authoritative; mTLS remains a transport-identity layer on top.
