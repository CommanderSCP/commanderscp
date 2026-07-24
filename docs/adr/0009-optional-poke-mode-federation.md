# ADR-0009: Optional poke-mode federation (per-outpost)

**Status:** Proposed (2026-07-18)
**Context doc:** [docs/proposals/outpost-poke.md](../proposals/outpost-poke.md)
**Relates to:** DESIGN.md §13 (Federation); [ADR-0001](0001-in-app-federation-mtls.md) (in-app federation mTLS); [ADR-0004](0004-service-naming-commander-outpost-retrans.md) (commander/outpost/retrans)

## Context

Federation is outpost-initiated on an interval (DESIGN.md §13, Transports item 1, review decision 2026-07-08): the outpost dials the commander to pull config and push status, and **the commander never initiates a connection to an outpost**. The stated rationale is regulated-partition reality — *"GovCloud may dial out to the commercial partition where the commander lives, but commercial cannot dial into GovCloud."*

This is correct and non-negotiable for regulated partitions, but where it is not required (co-located, same-partition, commercial outposts) it forces a tradeoff between **frequent polling** (continuous load on both sides, scaling with outpost count) and **pending-transfer latency**. There is no boundary to honor in those topologies, so the polling is waste.

## Decision

Introduce an **optional, per-outpost poke-mode**. The commander may send a **contentless** wake signal ("something is pending, come pull") to an outpost or retrans configured for poke-mode. The signal carries no data; all data continues to flow **outpost→commander via pull**. When poke-mode is enabled for an outpost, that outpost's **frequent interval poll is disabled**; it pulls on poke, backed by a sparse safety-net reconcile so a dropped poke self-heals (recommended reliability model; see the proposal's Open decisions).

**Invariant restatement.** The federation invariant changes from:

> *the commander never initiates a connection to an outpost*

to:

> *no **data** flows commander→outpost; the commander MAY send a **contentless, authenticated wake signal** to an outpost — and only where that outpost is explicitly configured for poke-mode and the topology and accreditation permit it.*

The data-direction guarantee (no config/status/audit ever pushed down to an outpost) is **unchanged**. Only the *triggering* direction is relaxed, and only opt-in.

Poke-mode is **off by default**, set **per outpost** (some outposts poll-mode, others poke-mode on the same instance), and authenticated by the same enrolled-commander mTLS peer identity the outpost already trusts (ADR-0001). The poke is contentless, idempotent, and rate-limited.

## Consequences

**Positive**
- Where enabled, near-real-time pending-transfer delivery with **no steady-state polling** — lower load on both outpost and commander.
- The relaxation is minimal and contained: a contentless signal, opt-in, per-outpost, with the integrity model (Ed25519 journal/bundle signatures) untouched.
- Poll-mode, air-gap/bundle, and all regulated-partition topologies are unaffected.

**Costs / constraints**
- Poke-mode **inverts the initiation direction** and therefore requires **bidirectional reachability** (commander→outpost for the poke, outpost→commander for the pull) plus a **new inbound listener**. A *direct* commander→outpost poke into a GovCloud/air-gap domain is *topologically impossible* (commercial cannot dial into GovCloud). This is why poke-mode is optional and per-outpost rather than a default.
- **The poke reaches an air-gapped domain via the retrans chain (owner clarification, 2026-07-18)** — it does not require a direct path. It propagates hop by hop: the commander pokes the **reachable low-side retrans** → the retrans pulls/validates/packages a tarball → pushes it across the **CDS** → the **high-side retrans inside the air gap** receives it → **pokes the outpost locally** (intra-domain, reachable, and **required** — not optional). Each hop is locally reachable even though no end-to-end commander→outpost path exists. Only pure **sneakernet** (no CDS data path at all) has no poke and stays fully manual. (Byte transport across the CDS is the retrans validate-then-relay — designed in [ADR-0019](0019-artifact-byte-channel.md), M15.5(c); a **separate channel** from these metadata-only bundles, which are unchanged.)
- If poke-mode disabled polling entirely with no backstop, a single lost poke would strand a pending transfer. The retained sparse safety-net (or, alternatively, reliable poke delivery) is a required part of the design, not optional polish.
- Adds one config surface (`federation.pokeMode` per outpost) and one contentless transport verb, carried through the API→SDK→CLI→UI parity chain.

**Resolved (owner, 2026-07-18)**
- **Reliability model → sparse safety-net backstop** (not pure poke-only): poke-mode disables the frequent poll but keeps a sparse reconcile + pull-on-(re)connect so a dropped poke self-heals.
- **Poke transport → reuse the `federation-https` mTLS routes** with one new contentless verb — a single identity/verification path (ADR-0001), no dedicated listener.

**Deferred to the milestone (M14)**
- The safety-net interval default (a tuning value; per-outpost, sensible default at implementation time).

**Grounding finding + build note (2026-07-24, M14.0)**
- **The frequent poll this ADR assumed did not exist yet.** M6 shipped the `.scpbundle` file transport + the `federation-https` plugin contract, but the **scheduled HTTP live pull** and the **outbound mTLS client-cert injection** were **deferred** (flagged in the M6 PR body + the `federation-https` module header); M8 built only the client-cert *presentation* for the plugin subprocess. Poke-mode therefore had no interval poll to disable.
- **Owner decision (full-scope M14, 2026-07-24):** build the deferred live-sync **substrate** first — **M14.0**: a fail-closed per-peer mTLS OUTBOUND dialer (reusing the M8 client-cert material — the enrolled `urn:scp:domain:<ownDomainId>` client cert; **no new CA scheme**) + the **outpost live-pull scheduler** (`startFederationSyncLoop`, mirroring `startInboxLoop`), pulling+importing over the dialer through the **unchanged** `importSyncBundle` verification (Ed25519 + hash chain). Both reliability-floor legs land here: **pull-on-startup** and the **sparse safety-net** interval tick — so poke-mode (M14.4) later disables only the *frequent* leg. This is the foundation the poke optimizes; the transport reuse ("the mTLS routes") and the reliability model ("sparse safety-net") decided above are honored by construction.
