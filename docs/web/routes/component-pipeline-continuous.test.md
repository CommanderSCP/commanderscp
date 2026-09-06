# component-pipeline-continuous.test

Reference for `apps/web/src/routes/component-pipeline-continuous.test.tsx`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 14 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ADR-0028 INCREMENT 4

ADR-0028 INCREMENT 4 — A HELD STAGE IS LEGIBLE AS ONE.

The defect in one line: a wave target whose trigger is withheld by a stage-scoped component coupling keeps `change_wave_targets.status = "pending"` forever — the server's hold `continue`s before the target is ever handed to an executor — and this view painted that identically to "the wave has not reached this stage yet". Those are opposite facts. One is waiting on something NAMED and clears itself; the other is waiting on nothing.

The server half (`apps/server/src/coordination/stage-dependency-surfaces.integration.test.ts`) proves `stages[].hold` is computed live and self-clearing. This file owns what a browser can still undo: given that response, does the page say WHAT it is waiting on?

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `StatusPill` renders `status ?? "never deployed"` regardless of the hold | 1 fails — `expected 'pending' to contain 'held'`. The pill reads `pending`: the defect verbatim | | `HoldSubnode` maps over `[]` instead of `hold.dependencies` | 4 fail — the naming, id-fallback, edge-provenance and per-lane cases. The card still says "Held here" and gives no way to find out by what | | `holdFor` ignores the lane and returns `stage.hold` whenever it is set | 1 fails — `expected … not to contain 'payments-api'`. The infrastructure lane, whose release here succeeded a month ago, is painted as held by the software pipeline's coupling | | `stateOf` maps a hold to `"blocked"` — the union member that already existed | 2 fail — `expected 'blocked' to be 'held'`. Worth keeping in mind: it type-checks, it renders, and it re-creates the permanent-red marker the server deliberately wrote `verdict: "hold"` rather than `"block"` to avoid | | `arrowInto` checks `held` AFTER `approval` | 1 fails — `expected 'approval' to be 'held'` | | `arrowInto` checks `held` BEFORE `blocked` (by dropping the `blocked` rung) | 1 fails — `expected 'held' to be 'blocked'`. This is the rung the ladder test was given a two-target fixture for; with one target per wave it would have stayed green, which is why the fixture holds a held target and a FAILED one in the same wave |

## §2. ONE TILE PER SOURCE

ONE TILE PER SOURCE (owner rule, 2026-08-14: "each source and target must be in its own tile — commander and outposts alike; the only thing that ever shares a tile is a test with its target"). The target side already obeyed it (one StageCard per target under a wave label). This pins the source side: N inputs → N tiles, side by side, and never two repos inside one tile. The commander-as-opaque-input is itself a tile when present.

## §3. NOT ONE CLICK

NOT ONE CLICK (owner, 2026-08-14): "Enabled is default. If clicking on it while enabled, it should give you the option to disable for x period of time or until manually enabled again. There should also be a confirmation screen. When disabled, users can enable but it also needs a confirmation screen." The arrow opens a DIALOG; the dialog holds the choice and the confirm; the mutation fires only from the confirm. Radix's dialog renders nothing under renderToStaticMarkup, so the dialog body is pinned by rendering it open via its own component export.
