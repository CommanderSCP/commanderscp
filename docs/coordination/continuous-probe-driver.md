# continuous-probe-driver

Reference for `apps/server/src/coordination/continuous-probe-driver.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 4 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. OUTPOST-RUN CONTINUOUS PROBES

OUTPOST-RUN CONTINUOUS PROBES — the domain holds the schedule until told otherwise.

WHY THIS RUNS AT THE OUTPOST AND NOT THE COMMANDER
The commander cannot run a probe: it does not reach into a domain, and the digest-pinned test bundle D23 requires lives in the DOMAIN's own Gitea. So the commander declares WHAT to probe (`pipeline_hook_upsert`, journalled down), the domain holds the schedule in its own Argo Workflows, and results journal back up as `peer_reported` evidence. Owner decision, 2026-08-28.

SCP DOES NOT TICK THE SCHEDULE, AND THAT IS NOT A DETAIL
`everySeconds` is DESCRIPTIVE in three places — `ManifestContinuousHookSchema`, `pipelineHooks.everySeconds`, migration 0096 — all saying Argo runs the cron and SCP does not schedule it. This driver honours that: it DECLARES a cadence to the executor once per tick and the executor's own scheduler runs it. It never fires a probe itself, which is the difference between coordinating a schedule and being one.

RE-DECLARED EVERY TICK, DELIBERATELY
`ensureSchedule` is idempotent by `scheduleId`, so re-declaring costs one call and changes nothing. That is the point: a schedule an operator deleted out-of-band, or one lost when the executor was rebuilt, is RESTORED on the next tick. "Until they hear otherwise" is only worth anything if the declaration is actively maintained rather than fired once and assumed.

A hook the commander RETRACTS stops being declared because the row is gone (the tombstone deleted it), and the schedule is removed by the retraction sweep below rather than expiring.

THAT SWEEP DID NOT EXIST until migration 0111, and the sentence above was the only thing that said it did. `removeSchedule` was implemented on the contract, routed by the plugin-host RPC, and implemented by both the Argo Workflows plugin and the test fake — with no application caller anywhere, so every retracted probe left its cron running on the executor indefinitely. It runs FIRST, ahead of the declarations, so a hook deleted and re-created between two ticks is retracted and then immediately re-declared rather than the other way round.

## §2. THE RETRACTION SWEEP

THE RETRACTION SWEEP. Removes the schedule of every `continuous` hook that has been deleted since the last tick, from the executor of every placement the hook's component still has.

IT CANNOT BE DERIVED FROM THE LIVE ROWS, which is why migration 0111's queue exists rather than a diff: the hook row is gone, `probeScheduleId` needs the hook's identity to name what to retract, and the contract has no `listSchedules` to ask the executor what it is holding. So the delete records the debt and this pays it.

FAILURE LEAVES THE ROW PENDING, deliberately, unlike `config_source_sync_queue`'s drain which marks a failed item processed. An undrained sync makes the graph stale; an undrained retraction leaves a cron running against a domain, so retrying every tick is the cheaper wrong answer.

THE ONE CASE IT CANNOT REACH, stated rather than hidden: a component whose placements are ALL gone has no binding to resolve an executor from, so there is no executor left to address and the debt is dropped. Deleting the component that owned a probe therefore relies on the same apply having pruned the hook first, which is the order `plans-repo.ts` prunes in.

## §3. WHICH TARGETS this hook covers

WHICH TARGETS this hook covers. A continuous hook holds per TARGET (that is what the hold is keyed on), so one declaration per placement rather than one per component.

THE PLACEMENT IS THE TARGET, and this is worth stating because the first version got it backwards: it passed the COMPONENT id to `resolveHookSubjects`, which takes TARGET ids and returned nothing, so the driver declared no schedules at all and failed silently — every hook skipped, no error anywhere. `listPlacementsForComponents` is the direction that exists.
