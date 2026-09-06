# auto-relay

Reference for `apps/server/src/federation/auto-relay.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 12 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. One org's auto-relay sweep

One org's auto-relay sweep. Exported for the integration suite (the 13.1b DoD is asserted through it); production reaches it via `runAutoRelaySweep`.

`multiTenantInstance` is threaded from the caller (which already enumerated orgs) rather than re-counted here — see the drop-resolution guard below for why it matters.

## §2. ONE BAD CHANGE NEVER BRICKS THE TICK

ONE BAD CHANGE NEVER BRICKS THE TICK (the inbox loop's containment rule). A throw here means the build did NOT complete, so nothing was published and recording a failure is the truth. A 400 is a DETERMINISTIC input problem (`buildRelayTarball`'s "no verified manifest" / "empty authorized set" refusals) — retrying it changes nothing, so it exhausts at once. Everything else (a missing/unpinned skopeo, a dead registry surfacing as a throw) gets the budget.

## §3. A POKE WAKE DOES NOT RE-SCHEDULE

A POKE WAKE DOES NOT RE-SCHEDULE (the M14.4 rule, verbatim): pg-boss computes a singleton slot from now() AT INSERT, so a wake landing in a different slot than the already-pending interval tick is not deduped and would leave TWO pending ticks. Keyed on "the batch contains a non-poke job" rather than "no poke present", so a batchSize>1 queue could never consume the interval job and skip its re-schedule.
