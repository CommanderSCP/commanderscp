# changes

Reference for `packages/schemas/src/changes.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 32 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHO cancelled this change (migration 0053)

WHO cancelled this change (migration 0053). `system` = the engine auto-cancelled it (today: a plan that would not compile); `user` = a human called cancel. NULL when the change is not cancelled, or was cancelled before this column existed — deliberately not backfilled, because inferring it from the old free-text reason would fabricate a fact.

Optional in the contract so a pre-0053 server's response still validates against this schema.

## §2. THE OBSERVED-STATE SHAPE

THE OBSERVED-STATE SHAPE (ADR-0008 decisions 1-2, M23.1f/g), extracted so a second read site can carry the identical snapshot without re-declaring its honesty rules verbatim. `ChangeWaveTargetSchema` below is still the shape's home for documentation purposes — read the field-level comments there. `ComponentPipelineCurrentSchema` (components.ts) is the other reader, added for the pipeline view's per-stage version (component-pipeline.ts's `currentsByPlacement`).

## §3. THE WAVE-TARGET FREEZE-HOLD PROJECTION

THE WAVE-TARGET FREEZE-HOLD PROJECTION (M25.UI, ADR-0039:173, campaigns-rework.md's closing "wave-target hold projection" section, fixed by reading `PipelineWaveCard` rather than from memory — see that doc for the four properties this shape satisfies).

ADDITIVE-OPTIONAL AND COMPOSED AT READ TIME, never persisted: the `freeze_admission` Decision has no clearing counterpart (`freeze-hold.ts`'s own module doc), so a hold field fed from that row would still say "held" long after a lift — the exact permanent-marker trap ADR-0028's stage-dependency status module states at length and this field must not reproduce. Present ONLY while the target is genuinely held; a lifted freeze is simply absent on the next read.

CARRIES THE COVERING FREEZES THEMSELVES, NEVER A BOOLEAN (property 1) — a `frozen: true` flag would force the client to join back to something to say anything useful. Each entry's `summary` is a SERVER-COMPOSED sentence (property 2, charter principle 6 — the UI composes no copy from raw fields), the same idiom `describeStageDependencyHold` already uses for the stage-dependency hold. `scope` is enriched to `{objectId, name}` server-side (property 3) — `null` means instance-wide/platform-tier, which has no object id in any org's containment chain. `endsAt` is carried and `now` is never (property 4) — the client's own clock contextualizes it, and pushing `now` into a read response is exactly what produced ADR-0024's measured 1.44 GB/day when it was done to a WRITE path instead.

THE RAW `status` STAYS BESIDE THIS FIELD, UNCHANGED. A held target's `status` is still `pending` — `hold` explains that status, it does not replace it (same rule ADR-0028's stage-dependency hold follows on this same schema).

`continuousTests` — THE SECOND HALF (team-pipeline-iac increment 8, D21)
ADDITIVE-OPTIONAL BESIDE `freezes`, never in place of it: a target can be held by a freeze, by a stale/failed/never-reported `continuous` probe, or by both at once, and collapsing the two into one array would lose which authority an operator has to go and talk to. `freezes` STAYS REQUIRED on this object and is `[]` for a target held only by a probe — making it optional would be a breaking weakening of a shipped response field, which is not a trade this repo makes.

COMPOSED AT READ TIME, NEVER PERSISTED, for exactly the reason stated above for `freezes` and restated on `ContinuousTestHoldSchema` itself: the `continuous_test` Decision has no clearing counterpart, so a field fed from that row would still say "held" long after fresh green landed. `plan-service.ts` re-runs `evaluateContinuousHolds` — the SAME predicate `reconcile.ts`'s per-target loop refuses on — on every read. Present ONLY while the target is genuinely held; absent on the next read once a fresh pass arrives.

`now` NEVER CROSSES THIS SEAM (property 4, again): each entry carries `staleAfter` and `lastReportedAt` as DATA that the client's own clock contextualizes, and `summary` is a server-composed sentence naming the boundary rather than a relative time.

## §4. ADR-0028 increment 4 — THE STAGE-DEPENDENCY WAIT STATUS

ADR-0028 increment 4 — THE STAGE-DEPENDENCY WAIT STATUS.

The `requires` wait status above and this one are DIFFERENT COUPLINGS and deliberately do not share a shape. `requires` is keyed on `{key, at}` and parks the WHOLE change in `waiting`; a stage dependency is keyed on (component x deployment-target) and withholds ONE wave target's trigger while the change stays `executing`. Widening `ChangeWaitStatusSchema` to carry both would have made `requirements[]` mean two things for its two existing consumers (the CLI's `printWaitStatusBody` and the web change-pipeline view), so this is a sibling field instead.

READ LIVE, NEVER OFF THE PINNED DECISION (coupled-pipelines.md §3.6, and the reason `resolveWaitStatus` exists at all). `recordStageDependencyHold` writes a `hold` Decision and NOTHING ever writes a clearing row, so the newest `stage_dependency` row of a change that was briefly held, triggered, succeeded and reached `accepted` is still a `hold` — answering "is this held?" from that row would rebuild, on a read surface, precisely the permanent-marker bug the `hold` verdict was chosen to avoid. Every field below is re-derived at request time by `evaluateStageDependencies`, the same predicate reconcile runs.

## §5. The TRANSFERRED phase

The TRANSFERRED phase.

`exported` — this instance produced a promotion bundle for this change. It is the ONLY transfer statement an exporting instance can truthfully make: `bundle_transfers` has no UPDATE anywhere in the tree, and every `submitted`/`confirmed` row is written by a LATER hop's own database. So an exporting instance's row is and stays `created`, and whether the peer ever received the bundle is UNOBSERVABLE here — declared in `unknownFields` as `transfer.handoff`, never rendered as a delivered/confirmed handoff.

`received` — this instance imported and applied a promotion bundle for this change (a genuine local observation: the row is written in the same tx as the import).

`not_observed` — no ledger row here names any bundle that carried this change.
