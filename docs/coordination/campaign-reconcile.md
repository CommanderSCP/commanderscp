# campaign-reconcile

Reference for `apps/server/src/coordination/campaign-reconcile.ts`. The source carries a one-line headline at each site and points here.

> Partial: 7 of 28 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ONE CAMPAIGN'S UNIT OF WORK

ONE CAMPAIGN'S UNIT OF WORK. THE CALLER HOLDS THIS CAMPAIGN'S ADVISORY LOCK for the whole of this function — see `campaign-coordination-lock.ts` for the race it closes and why the campaign side had NO backstop at all (no unique constraint on `campaign_plans.campaign_object_id`, no transition-guarded state machine, so both racing ticks committed a full duplicate plan silently).

`staleCampaignObject` IS THE BATCH READ'S SNAPSHOT AND IS DELIBERATELY NOT USED FOR ANYTHING BUT ITS ID. It was taken by `listActiveCampaignObjectIds` OUTSIDE the lock, which is precisely the window the lock exists to make survivable, so this function's first act is to re-read the row fresh — half (b) of the fix. Two things depend on it:

- `properties`, which the compile path below both READS (targets, topology) and WRITES BACK (the URN-normalisation `updateObject`). A racing tick that already normalised them would be undone from a stale snapshot, bumping the object's version and audit trail for a write the winner already made. - The row still EXISTING and still being ours. A campaign tombstoned (or handed to another domain) between the batch read and this lock is a clean no-op, not a plan compiled against a deleted campaign. The `origin_domain_id` predicate is the same S10 single-writer condition `listActiveCampaignObjectIds` filters on, re-asserted here where it is actually fresh.

The plan read immediately below is the OTHER fresh re-read, and it is the one that makes "another tick already compiled this plan" an ordinary drive-path tick rather than a compile failure.

## §2. THE FREEZE HOLD, CAMPAIGN SIDE

THE FREEZE HOLD, CAMPAIGN SIDE (M25.2, docs/proposals/campaigns-rework.md §1.3) — memoised once per campaign per tick, exactly like `reconcile.ts`'s twin, and lazy for the same reason: a wave with nothing `pending` never asks.

OPERABILITY, NOT CORRECTNESS, and worth stating so nobody deletes it thinking it is redundant. A member Change fanned out into a freeze WOULD be held at the change-side actuator anyway — the fan-out mints a change with exactly one target, and that change's own per-target loop refuses to trigger it. But without this seam a 40-target campaign entering a two-week freeze mints 40 real Changes that each compile a plan, enter `executing`, and trip the watchdog's 30-minute stall SLA for a fortnight. Holding the fan-out keeps the estate clean.

CAMPAIGN WAVE TARGETS ARE COMPONENTS, not placements, so only org/domain/service/component -scoped freezes reach them. A region freeze correctly does NOT stop fan-out — it stops the member change's placement targets, one layer down, at the actuator that can see a place.

## §3. IS THE TARGET OBJECT STILL THERE?

IS THE TARGET OBJECT STILL THERE? — the campaign-side twin of `reconcile.ts`'s liveness gate (`target-liveness.ts`), and the failure it replaces is a WEDGE rather than a bad deploy.

A campaign plan is compiled ONCE. Delete one of its targets afterwards and the fan-out below still ran: `proposeChange` resolves targets through `getObjectByIdOrUrnAnyType`, which IS live-filtered, so it threw `notFound` — straight into `logCampaignError`, which logs "will retry next tick" and does exactly that. Once a second. Forever. `allTerminal` stayed false, the wave never terminalized, `markCampaignWaveTargetProposed` was never reached, and the campaign sat there emitting a line a second with NO Decision, no `decision_id`, no terminal status and nothing an operator could query. The engine had the right answer and threw it away.

So the question is asked EXPLICITLY, and answered with the record the throw never produced: a `block` Decision naming the object, a hash-chained audit event carrying its id, and the wave target terminalized — which fails the wave and parks the campaign through its existing `activeWave.status === "failed"` branch. "Why did this stop" now has an answer.

FAIL DIRECTION: `readTargetLiveness` throws on a database fault rather than reporting "not live", so a transient read failure lands in the SAME `logCampaignError` as before and is retried — it must never be mistaken for a deletion and terminalize a healthy campaign.

## §4. THE FREEZE HOLD

THE FREEZE HOLD — M25.2's SECOND ACTUATOR. This `continue` is the refusal.
AFTER THE LIVENESS GATE, deliberately: a tombstoned target is dead regardless of any freeze, and terminalizing it is PROGRESS — holding it instead would keep a dead row non-terminal for the length of the freeze window and hide the block Decision the liveness gate exists to write. BEFORE `proposeChange`, so no member Change, no `coordinates` edge, and no `campaign_wave_targets.member_change_object_id` is written for a fan-out we are declining to perform.

`allTerminal` IS ALREADY FALSE — set at the top of this `pending` branch — so this `continue` cannot let the wave terminalize behind a held target. That is the campaign-side equivalent of `reconcile.ts`'s "counted first" invariant, and it is inherited rather than restated: there is no separate count here to get wrong.

NO CURSOR BUMP IS NEEDED. `reconcileCampaignsOrgTick` already bumps `objects.updated_at` UNCONDITIONALLY for every locally-owned campaign it examines (starvation-class instance 4, verified at that call site), so a campaign every one of whose targets is frozen still rotates through the batch. The change side needs its own bump only because nothing there writes the `changes` row on the held path.

## §5. THE ADOPTION SEAM

THE ADOPTION SEAM — M25.5's ACTUATOR. This `continue` is the refusal to do work.
WHAT IT BUYS: a campaign is IDEMPOTENT against a component that migrated on its own. Half a 47-component estate is usually already on python3 when the campaign is authored, and without this seam each of those gets a real member Change, a plan, an `executing` state and a triggered pipeline run to re-do work that is done. Worse, the campaign then reports having migrated them — which is true of the trigger and false of the component.

ORDERING, WHICH IS INHERITED FROM THE TWO SEAMS ABOVE RATHER THAN INVENTED:

* AFTER THE LIVENESS GATE. A tombstoned target is dead regardless of what its inventory says, and terminalizing it `failed` is PROGRESS. Asking about adoption first would read a deleted component's stale inventory and terminalize it `succeeded` — a campaign reporting a migration for an object that no longer exists. * AFTER THE M25.2 FREEZE HOLD. A freeze is a HOLD, not a terminal state: the campaign is meant to resume when the window closes. Terminalizing a frozen target `succeeded` here would make the hold irreversible and would write a permanent Decision during a window in which the campaign was explicitly told to do nothing. Held first, asked later. * BEFORE `proposeChange`. That is the whole point — no member Change, no `coordinates` edge, no `member_change_object_id` for a fan-out we are declining to perform.

`allTerminal` IS ALREADY FALSE (set at the top of this `pending` branch), so nothing here depends on getting a count right; the terminalizing write below is what lets the wave finish.

INERT BY DEFAULT: the recipe was parsed ONCE for this campaign above, so a campaign that declares no `adoption` costs exactly one property read and not a single query. The predicate early-returns on the same condition — the guard is stated twice on purpose, because a guard that lives only at the call site is a guard that survives until the second call site.

NO MEMOISATION, and that is the M22.0a lesson rather than an oversight: each `(campaign, target)` is evaluated exactly once per tick by this loop, so a cache would buy nothing and would introduce the one thing that failure was made of — a key coarser than the question.

FAIL DIRECTION: a thrown predicate is caught and the target is fanned out NORMALLY. An unreadable inventory must never be mistaken for "already migrated" — that is the same silence-as-a-pass this feature exists to refuse, arriving as an exception instead of a NULL.

## §6. THE DEADLINE LOCK

THE DEADLINE LOCK — M25.6a's ACTUATOR. This `continue` is the refusal.
> `reconcileOneCampaign`'s per-target `pending` branch is the function that refuses. The > refusal is: IT DOES NOT CALL `proposeChange`.

THE RADIUS IS THIS CAMPAIGN'S OWN TARGETS (owner decision D4), and that is a property of WHERE this sits rather than of anything it computes. It withholds one campaign's fan-out from one component. The component keeps receiving every other change on the estate, INCLUDING SECURITY FIXES, because nothing here touches the component's gates, its freezes, or any change but the one this campaign would have minted. Routing it through `checkFreeze` instead would have stopped all of those — see `campaign-deadline-lock.ts` for why neither that nor `evaluateWaveGate` is the seam.

ORDERING, INHERITED FROM THE THREE SEAMS ABOVE RATHER THAN INVENTED:

* AFTER THE LIVENESS GATE. A tombstoned target is dead regardless of any calendar, and terminalizing it is PROGRESS. Locking it instead would keep a dead row non-terminal forever — a deadline, unlike a freeze window, never closes on its own — and would defer the tombstone's own audit event for just as long. * AFTER THE M25.2 FREEZE HOLD. A freeze is the more specific and the more urgent fact: it is an operator saying "stop, right now", it clears by itself, and only one `continue` can fire per tick. A frozen target records the freeze this tick and starts recording the deadline the tick the window closes. The two sets are therefore DISJOINT by construction, which is what keeps the two Decisions from describing the same target twice. * AFTER THE M25.5 ADOPTION CHECK. An already-migrated component must terminalize `succeeded`, not be locked out of a campaign it has already satisfied. Asking about the deadline first would produce a permanent, hash-chained record asserting that a component which HAD migrated missed the deadline — the single worst output this feature can produce, and the one its whole evidence discipline exists to prevent. * BEFORE `proposeChange`. That is the whole point: no member Change, no `coordinates` edge, no `member_change_object_id` for a fan-out we are declining to perform.

`allTerminal` IS ALREADY FALSE (set at the top of this `pending` branch), so this `continue` cannot let the wave terminalize behind a locked target. §4.6's consequence, stated rather than changed: SIBLINGS SHIP AND REACH `accepted`, but the wave never terminalizes and later waves never start. Both alternatives are worse — terminalizing a locked target `failed` parks the campaign anyway AND makes the lock irreversible (a terminal wave is never re-served), while `skipped` produces a campaign that "completed" while a target it was created for never migrated, a lie in the one record the feature exists to produce. That is the existing campaign wave engine's shape; changing it is a separate decision.

NOTHING IS WRITTEN TO THE TARGET ROW. The lock is re-derived from `(deadline.at, adoption)` on every subsequent tick, which is precisely what makes a late adoption or a moved deadline clear it with NO UNLOCK VERB — the same read-time-predicate payoff M22.6 already ruled for expiry and M25.2 for the freeze window. There is correspondingly no hold->release row here: a lock that lifts does so because the target became `adopted` (which writes its own `campaign_adoption`/`allow` row as it terminalizes) or because the deadline was moved or cleared (which writes its own `campaign_deadline_set`/`allow` row and audit event at the route). Both clearings are already on the record under the kind that names what actually changed; a third writer restating them would be a second account of one event.

NO CURSOR BUMP, exactly as for the freeze hold directly above: `reconcileCampaignsOrgTick` bumps `objects.updated_at` unconditionally for every locally-owned campaign it examines (starvation-class instance 4), so a campaign every one of whose targets is locked still rotates through the batch.

ONE KNOWN WRINKLE, RECORDED RATHER THAN QUIETLY WIDENED. `anyTargetFannedOut` — the condition M25.2's `clearCampaignFreezeAdmissionHold` releases on — is set BELOW this `continue`, so a campaign whose freeze window closes on the same tick its deadline starts locking gets no freeze RELEASE row, and its newest `freeze_admission` row keeps reading `hold` while the truth is that the deadline is now what withholds it. The shape is pre-existing (M25.5's adoption seam `continue`s above the same flag) rather than introduced here, and it is an explainability wrinkle rather than a correctness one — the standing `campaign_deadline` block Decision is the newer row and says exactly what is happening. The honest fix is to release on "no target is held by a FREEZE any more" rather than on "some target fanned out", which is an edit to M25.2's seam and belongs with M25.2's own tests.

COST WHEN NOT DUE: ZERO QUERIES. `evaluateCampaignDeadlineLock` compares two instants and returns before touching `tx`. A campaign with no deadline at all never reaches this branch.

## §7. M25.6a — THE TICK'S CLOCK SEAM

M25.6a — THE TICK'S CLOCK SEAM.

RESOLVED ONCE, HERE, FOR THE WHOLE BATCH, and threaded into every campaign this pass examines. The batch is `LIMIT 25` and each campaign's reconciliation is several round trips, so a pass can easily span tens of milliseconds; two campaigns sharing one deadline instant that fell inside that span would disagree about whether it had passed, and each would write a permanent record asserting its own answer. One reading per tick makes the batch internally consistent.

OPTIONAL, and production passes nothing — the precedent is `watchdog.ts`'s `opts.now`. It exists because the alternative for a boundary test is a REAL SLEEP, which `test-support/integration-sleep-census.test.ts` is a CI gate against, and because a deadline test that could only be written by waiting could only ever be written for deadlines seconds away — never for the year-out deadline the feature is actually for.

`reconcileOrgTick` is deliberately UNTOUCHED (proposal §4.2): it calls this with no `opts`, so the production path is byte-identical to a pre-M25.6a tick.
