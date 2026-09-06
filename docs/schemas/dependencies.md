# dependencies

Reference for `packages/schemas/src/dependencies.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 49 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE PRODUCER LINK IS NOT ON THIS ROW ANY MORE

THE PRODUCER LINK IS NOT ON THIS ROW ANY MORE (ADR-0032 §7e, proposal §12.1).

It used to be `producedByObjectId` + its two companions here, which made the declaration PER MAJOR LINE. "Component X publishes `@acme/lib`" is a fact about the COORDINATE, true across every major X ever cut, and the mismatch was not cosmetic: lines are minted only by a CONSUMER's manifest, so every new major minted a fresh row with a NULL producer, honestly third-party by default, and `buildLineWorkList` then handed the org's own coordinate to a PUBLIC INDEX — ADR-0032 §7b clause 1's dependency-confusion catastrophe, re-armed silently at each major bump. The declaration now lives in `dependency_line_producers`, keyed `(orgId, ecosystem, coordinate)`, so a new major of a declared coordinate is internal FROM THE INSTANT IT IS MINTED because there is no per-major field left to populate.

DO NOT ADD IT BACK AS A CACHE. Stamping it at mint time from the declaration table closes the same hole, but it puts a producer write back inside the ingestion verb and so deletes "declared, never inferred" — the property this whole feature exists to protect. Read `isInternalDependencyLine` with a `DependencyLineProducer | null` obtained by joining.

## §2. True iff the coordinate has a DECLARED producer

True iff the coordinate has a DECLARED producer. The one place "internal" is decided — read from the declared row, never derived from `coordinate`. Kept as a function so no call site is tempted to re-derive it from a name (ADR-0032 §7).

It takes the DECLARATION, not the line, since M22's regrain: internal-ness is a property of the coordinate and a line row carries no producer field at all. A caller that has only a line must join, which is what makes a brand-new major of a declared coordinate internal immediately.

## §3. The operator write body

The operator write body. `unlocked` is REQUIRED for the same reason the effect's `enabled` is: absent never means enabled, so an omitted flag would have to be read as `false` — and a PUT that silently LOCKED a deployment because a field name was misspelled is the same failure in the other direction. Requiring it makes both mistakes a 400.

## §4. M21.2 — THE INVENTORY BACKFILL (ADR-0032 §4)

M21.2 — THE INVENTORY BACKFILL (ADR-0032 §4).

Ingestion is event-driven: a correlated, accepted change re-reads its component's dependency manifests. That covers every component that releases from now on and NO component that does not — so on an existing estate the inventory would stay empty until each team happened to commit, and a component that never pushes again would never acquire one at all.

The precedent was `POST /discovery/backfill-source-mappings`, which existed for exactly this class of problem ("create rows onto already-imported components"): operator-triggered, idempotent, and it reported every skip rather than only a count. That route has since been RETIRED — not because the shape was wrong, but because its population closed when `discovery/accept` was removed (see `packages/schemas/src/executors.ts`). The shape is still the right one here, where the population is open.

## §5. The producing COMPONENT's graph object id or URN

The producing COMPONENT's graph object id or URN.

A `service` IS REFUSED IN THE FIRST CUT (ADR-0032 §7e, proposal §12.2), and the refusal is not pedantry: `listProducedLines` derives a head only from the COMPONENT a prod placement names, so a service-valued declaration derives no head at all while still removing the coordinate from third-party polling — it does the harmful half silently and not the useful half.

## §6. The page query for both read routes

The page query for both read routes. Its own schema rather than `CursorPageQuerySchema` because an inventory is read WHOLE far more often than paged (a component declares tens of lines, not thousands), so the ceiling and the default are both higher than the generic envelope's 100/20.
