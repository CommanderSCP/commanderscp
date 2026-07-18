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
- Poke-mode **inverts the initiation direction** and therefore requires **bidirectional reachability** (commander→outpost for the poke, outpost→commander for the pull) plus a **new inbound listener on the outpost**. In the canonical GovCloud/IL case this is *topologically impossible* (commercial cannot dial into GovCloud), so those outposts remain pure-pull. FedRAMP/IL4-5/CDS deployments keep poke-mode off. This is why it is optional and per-outpost rather than a default.
- If poke-mode disabled polling entirely with no backstop, a single lost poke would strand a pending transfer. The retained sparse safety-net (or, alternatively, reliable poke delivery) is a required part of the design, not optional polish.
- Adds one config surface (`federation.pokeMode` per outpost) and one contentless transport verb, carried through the API→SDK→CLI→UI parity chain.

**Deferred to the milestone (M14) / open**
- Reliability model (sparse safety-net vs. reliable delivery) and the safety-net interval default — see the proposal's Open decisions.
- Whether to reuse the `federation-https` transport routes for the poke verb (preferred — single identity path) vs. a dedicated listener.
