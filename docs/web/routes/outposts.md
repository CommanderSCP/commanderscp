# outposts

Reference for `apps/web/src/routes/outposts.tsx`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 21 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE ATTENTION-DOT COLUMN

THE ATTENTION-DOT COLUMN (spec §4E) — a leading at-a-glance triage signal derived ONLY from signals already computed on this row, never a new fetch or a fabricated threshold:

```text
* `danger` (red) — a signal that something set up to work is NOT working: this side is opted
  into poke-mode but has never actually received one (the named unilateral-sparse case
  `outpost-configuration.tsx` also renders, computed the same way here for the overview).
* `warning` (amber) — "worth a look": transport cannot be derived (no base URL or delivery
  target configured), or the trust tier is unset/unverified.
* `nominal` (slate) — nothing above is true.
```

Transport-unknown is DELIBERATELY warning, not danger (first QA pass got this wrong): a freshly enrolled peer has no transport yet, and a genuinely air-gapped peer may NEVER have one — bundles move by hand, which is a supported deployment shape, not a failure. Red on every fresh or air-gap row is the wall-of-amber problem reborn one tier up: when everything is a fire, nothing is. Red therefore requires a signal that a configured mechanism is misbehaving.

## §2. THE TIER CLAIM AND ITS QUALIFIER, DERIVED ONCE

THE TIER CLAIM AND ITS QUALIFIER, DERIVED ONCE (round 3, the X4 census miss).

`data-trust-tier` is a CLAIM, and this suite's own stated rule is that the forbidden thing is the claim — the rendered word AND the machine-readable attribute. The ROW carried a bare `data-trust-tier={status.trustTier ?? "unknown"}` with no qualifier beside it, so an unverified hand-typed peer and a commander-declared one produced a BYTE-IDENTICAL `<tr … data-trust-tier="commercial">` — and the row attribute is exactly what an E2E selector or any other DOM consumer keys on. The cell inside had been fixed; the row had not, because the census walked the components rather than the attributes.

So both read this. A qualifier that is computed in one place cannot be applied in one place and forgotten in the other.

## §3. THE RETRANS BRANCH, DERIVED ONCE

THE RETRANS BRANCH, DERIVED ONCE. Read off `trustTierMark` — the SAME derivation `OutpostRow` puts on the row's own `data-trust-tier`/`data-tier-provenance`, so the two cannot disagree — never re-checked with a second bare `status.peer.role === "retrans"` here.

Rendered as the §1.5 STRUCTURALLY-EXPECTED-ABSENCE dash, not a badge: "a retrans can never have a tier" is a permanent structural absence (the same class as the spec's own "Layer B unmodeled fields" example), and §1.5 reserves pills for signal — a column of "not applicable" badges on every retrans row is the wall-of-pills problem reborn one tone over. The honesty sentence rides the title, exactly as the dash idiom prescribes; the amber unknown pill below stays reserved for the genuinely-unobservable outpost case, so the two states cannot be confused.

## §4. OUTBOUND — PENDING-EXPORT, AND NOTHING MORE

OUTBOUND — PENDING-EXPORT, AND NOTHING MORE.

Every figure here measures what THIS SIDE PUT ON THE WIRE. The commander cannot observe what a peer applied (`sync_cursors` records only what WE applied FROM a peer; `bundle_transfers` export rows are INSERT-only and never advance), so there is no "up to date", no "in sync", no green tick — a zero backlog means only that this side has bundled everything it has authored, which says nothing whatsoever about whether the outpost received or applied any of it.

## §5. THE HQ OUTPOST'S TIER

THE HQ OUTPOST'S TIER (§10.5; formerly "co-located" — GLOSSARY, ADR-0021 D7) — the same three states `TrustTierCell` renders for a peer row, read off the OutpostConfig itself (this record has no peer-status row): no tier → the unknown marker; a tier the server ALSO lists in `unknownFields` (an unverified hand-filled shadow) → `<tier> · unverified`; else the plain badge. Never blank, never defaulted.
