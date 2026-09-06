# plan-service

Reference for `apps/server/src/coordination/plan-service.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 20 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE CHANGE'S OWN DECLARED COUPLINGS

THE CHANGE'S OWN DECLARED COUPLINGS (ADR-0028), off the row already in hand — no second query. They exist here for ONE reason: `compileStages`'s co-placed cycle refusal has to see what the RUNTIME HOLD enforces, and the hold enforces declarations independently of whether any `depends_on` edge survives. `loadDependsOnEdges` above cannot supply that half — it filters `deleted_at IS NULL`, and `materialiseStageDependencyEdges` never re-mints an edge whose tombstone still occupies the unique key — so a mutual declaration with one deleted edge compiled clean and then wedged in `executing` forever. See `coPlacedCycle`.

`malformed` is deliberately NOT passed. A malformed entry is unsatisfiable and holds every target (`stage-dependency-hold.ts`'s `undeclarable` branch), which is its own failure mode with its own remedy; it is not a CYCLE and this check must not start reporting it as one. Propose-time Zod validation makes such a row unreachable through the API in the first place.

## §2. THE ONE WAVE ADMISSION CURRENTLY GOVERNS

THE ONE WAVE ADMISSION CURRENTLY GOVERNS — first wave not yet terminal. Shared by `resolveWaveTargetFreezeHolds` (which only ever evaluates THIS wave's targets) and `toChangePlanShape`'s `heldTargetCount` emission, so the two cannot disagree about which wave that is. EXPORTED: `campaign-plan-service.ts`'s `resolveActiveCampaignWaveFreezeHolds` uses the SAME selector over campaign waves (structurally compatible — both a raw `campaign_waves` row and the wire `CampaignWave` shape carry a bare `status` string), so "which wave admission governs" cannot drift between the change and campaign sides.

## §3. D7'S ROLLBACK EXEMPTION, MIRRORED

D7'S ROLLBACK EXEMPTION, MIRRORED (M25.UI review finding 3). `reconcile.ts`'s actuator (`!( rollbackExemptible(frozen.freezes) && rollbackHasSomethingToUndoAt(...) )`) lets a rollback's trigger through an org-tier freeze for a target the original change actually dispatched. Without the same check here, `explain` reports that target `held` by the very freeze reconcile has already stepped around — a target sitting in `triggering` backoff after a real dispatch, described as still waiting on a freeze it was exempted from.
