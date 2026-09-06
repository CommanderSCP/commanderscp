# reconcile

Reference for `apps/server/src/coordination/reconcile.ts`. The source carries a one-line headline at each site and points here.

> Partial: 21 of 85 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. TRIGGER RETRY BACKOFF

TRIGGER RETRY BACKOFF (measured production storm, homelab 2026-08-01: 19 `argocd trigger: sync returned HTTP 400` against 12 successful syncs in 15 minutes, every 400 on the SAME target).

Argo CD refuses a sync while an operation is already running on that Application, and a real backlog fans many changes onto a handful of Argo apps — so contention is the NORMAL case here, not an error. With a 1-second tick and no backoff, every contending target re-fired every second and lost, producing a retry storm that consumed executor capacity and buried genuine failures in the log.

Exponential on the target's OWN `attempt` count, so a target that keeps losing the race steps aside for progressively longer while an uncontended one is unaffected. Deliberately capped, not unbounded: contention clears on its own, so a target must keep checking back rather than effectively giving up.

## §2. IS THIS CHANGE A ROLLBACK?

IS THIS CHANGE A ROLLBACK? — read ONCE, above the wave gate, because BOTH freeze seams need it (owner decision D7) and two readings of one fact is how they drift.

`evaluateLifecycleGate` has always exempted rollbacks at `validating->accepted` (DESIGN §9.4 — "no human-review step to wait for"). The WAVE boundary never learned the same fact, so a rollback of a broken release into a frozen scope was refused by the very mechanism meant to protect the scope — pinning the broken release in place for the whole window. D7 closes that at both places: the gate (below, via `EvaluateWaveGateContext.isRollback`) and the per-target hold (the actuator's `!isRollback`, further down). Both are needed and neither is sufficient: the gate covers the ALL-frozen wave, the actuator covers every partially-frozen one.

## §3. THE DEPLOY INSTANT, AS DATA

THE DEPLOY INSTANT, AS DATA. `lastObservedAt` is when reconcile observed this target succeed; `updatedAt` is the fallback for a row whose success was recorded without an observation. Both are STABLE for a terminal target — nothing writes them again — which is required, because this value becomes the bake window's start inside a Decision record.

## §4. THE STAGE-DEPENDENCY HOLD

THE STAGE-DEPENDENCY HOLD (ADR-0028) — parsed ONCE per change per tick, in memory, before the loop. The overwhelming majority of changes declare nothing, and `evaluateStageDependencies` returns on an empty declaration set before issuing a single query, so an undeclared change pays one property read it was already doing and nothing else. That inertness is a property this feature has to keep, not a nicety: the per-target loop runs on every tick of every executing change on the instance.

A ROLLBACK CARRIES NO DECLARATIONS TODAY (`rollback.ts` does not spread the original's properties, and a test pins that), so this is empty for one by construction rather than by a guard. Named because the guarantee matters: holding a rollback behind a dependency would keep a broken release in place while waiting for the very component it is trying to get away from.

## §5. THE OTHER HALF OF THE HOLD'S DEPENDENCY SET

THE OTHER HALF OF THE HOLD'S DEPENDENCY SET (ADR-0028 decision 6) — plain `depends_on` edges with BOTH endpoints among this change's own targets. That is the exact set `compileStages` used to refuse a same-wave pair over, and it is `loadDependsOnEdges`, the SAME function the compiler is fed from, so the two can never drift into meaning different things.

LAZY AND MEMOISED, once per change per tick, and both properties are load-bearing:

```text
* A SINGLE-TARGET CHANGE NEVER QUERIES. Both endpoints must be in the target set, so one
  target can only ever produce a self-edge, which orders nothing. 277 of 281 measured changes
  target exactly one component (ADR-0026), so the ordinary release pays nothing for this.
* A CHANGE WITH NOTHING PENDING NEVER QUERIES either — the call sits inside the trigger
  branch, so a wave that is purely polling in-flight targets does not touch the graph.
```

Unlike the declarations, this cannot be read off the change's properties: an edge is graph state, and the whole point is that it may have been written by something other than this change.

## §6. THE FREEZE HOLD

THE FREEZE HOLD (M25.2) — resolved ONCE per change per tick, for the WHOLE wave, and memoised exactly like the edge set beside it.

ONE CALL FOR THE WAVE, NOT ONE PER TARGET, and that is what keeps the cost honest: the whole point of `freezesByTarget` is that it asks "does this org have ANY active freeze right now?" once, on an indexed window read, and returns every target unfrozen without walking a single containment chain when the answer is no. Calling it per target would issue that read per target instead. See `governance/freeze-scope.ts`'s inertness property, which has its own counting test.

LAZY, for the same reason `loadInTargetSetEdges` is: the call sits inside the trigger branch, so a wave that is purely POLLING in-flight targets does not consult freezes at all. A freeze cannot withdraw a trigger already made (`ExecutorPlugin` has no pause verb — ADR-0008), so there is nothing for it to say about a target already in flight.

RESOLVED EVERY TICK, never once at the wave boundary. That is the second half of what M25.2 fixes: `evaluateWaveGate` fires exactly once on `pending -> running`, so a freeze DECLARED MID-WAVE was previously never seen at all. Memoisation is per tick, so the next tick asks again — which is also how a freeze CLEARS, in one second, with no scheduler and no status flip.

## §7. THE CONTINUOUS-TEST HOLD

THE CONTINUOUS-TEST HOLD (increment 8) — resolved ONCE per change per tick, for the WHOLE wave, and memoised exactly like the freeze holds above it, for the same three reasons.

ONE CALL FOR THE WAVE, NOT ONE PER TARGET. `evaluateContinuousHolds` opens with a single indexed existence read ("does this org declare any `continuous` hook at all?") and returns an empty map before resolving a single placement when the answer is no. Calling it per target would issue that read per target instead.

LAZY: the call sits inside the trigger branch, so a wave that is purely POLLING in-flight targets does not consult hooks at all. A probe going stale cannot withdraw a trigger already made — `ExecutorPlugin` has no pause verb (ADR-0008) — so there is nothing for it to say about a target already in flight. What it withholds is the NEXT trigger.

RESOLVED EVERY TICK, never once at the wave boundary. `evaluateWaveGate` fires exactly once on `pending -> running`, so a probe that goes stale MID-WAVE would never be seen there — and freshness is a read-time comparison redone every tick by construction (ADR-0033), which is the whole point of `maxAgeSeconds`. Memoisation is per tick, so the next tick asks again, which is also how a hold CLEARS the second fresh green evidence lands.

## §8. THE ONE QUALIFIER ON D7'S ROLLBACK EXEMPTION

THE ONE QUALIFIER ON D7'S ROLLBACK EXEMPTION — see `originalChangeDispatchedTarget`.

`false` for every non-rollback change WITHOUT touching the database, so the ordinary path pays nothing; and for a rollback it is asked ONLY about a target a freeze is actually holding, which is the rarest shape on this loop. Memoised per target per tick alongside the hold map itself, because a rollback whose whole wave is frozen would otherwise re-ask once per target per tick for the length of the window.

## §9. THE FREEZE HOLD

THE FREEZE HOLD — M25.2's ACTUATOR (docs/proposals/campaigns-rework.md §1.2)
THIS `continue` IS THE REFUSAL. Delete it and the target triggers into an active freeze, and every test in `freeze-admission.integration.test.ts` that asserts an executor was never called goes red. Nothing else in this file withholds a trigger for a freeze: the wave gate above now only blocks the ALL-frozen wave.

FIVE INVARIANTS, each with a named prior incident. Every one is load-bearing:

```text
1. COUNTED FIRST. `nonTerminalTargets++` happened at the top of this branch, BEFORE this
   `continue`. A frozen target is still in flight. Copied verbatim from the backoff gate
   and from ADR-0028's hold below, and for the same reason: without it a wave whose only
   remaining target is frozen marks itself `succeeded` and the change completes green
   with a target that never ran — silent-success masking, the class ADR-0006 exists to
   prevent.
2. BEFORE `triggerWaveTarget`. No advisory trigger-claim lock is taken and no executor
   binding is re-read for a call we are not going to make. `attempt` therefore stays 0 on
   a target held from its first tick, which is what the actuator test measures.
3. THE ROLLBACK EXEMPTION (owner decision D7), AND ITS ONE QUALIFIER.
   `evaluateLifecycleGate` already exempts rollbacks (`gates.ts` — DESIGN §9.4, "no
   human-review step to wait for"), but `EvaluateWaveGateContext` carried no `isRollback`
   at all, so a rollback's wave targets were freeze-blocked. Holding a rollback pins a
   BROKEN RELEASE in place for the whole window — the one change a freeze most wants to
   let through. This is a change that newly permits, which is why it is an owner decision
   and gets a test in both directions.
```

```text
   The qualifier is `rollbackHasSomethingToUndoAt` below: D7's reasoning is about a
   target the broken release ACTUALLY REACHED, and per-target admission makes the other
   case reachable for the first time (freeze holds `amer`, a sibling ships and fails,
   `autoRollbackOnFailure` mints a rollback over ALL FOUR original targets). Exempting
   `amer` there would dispatch an unattended executor call into a declared freeze to undo
   a release that never happened. See that function for the full chain.
4. BEFORE THE STAGE-DEPENDENCY HOLD. Only one `continue` can fire, so the two hold sets
   are DISJOINT BY CONSTRUCTION — which is exactly what the terminalization arithmetic at
   the bottom of this loop depends on. Stated consequence: a target that is both frozen
   and dependency-held records only the freeze this tick, and resumes producing
   `stage_dependency` verdicts the tick the freeze lifts. A frozen target should also not
   spend a graph read per tick on a coupling it cannot act on either way.
5. AFTER THE BACKOFF GATE. A `triggering` target has ALREADY been handed to its executor.
   `ExecutorPlugin` is observe/trigger/status/abort and nothing else (ADR-0008 forbids
   adding a pause verb), so a freeze cannot un-ring that bell. What it withholds here is
   the RETRY, not the original call. That is the honest boundary of what a freeze buys,
   and for a `pending` target — every first trigger, the case this is about — `backoffMs`
   is 0 and the two orders are identical anyway.
```

```text
   AND ITS SECOND QUALIFIER, `rollbackExemptible` (M25.3 review finding 1). D7 is an
   ORG-TIER decision: a PLATFORM freeze is never stood aside for a rollback. Shipped
   tier-blind, this line was the CHEAPEST of the two routes past a freeze that `checkFreeze`
   tells the caller "no tenant role can override, however privileged" — `POST
   /v1/changes/{id}/rollback` requires `object:write` at the org and nothing else, so it
   needed neither `freeze:override`, nor a reason, nor the operator token. It is the same
   one predicate `gate-orchestrator.ts`'s `freezeExemptRollback` consults, deliberately: two
   seams enforcing one rule must not be two copies of it. Reading `frozen.freezes` (which
   already carries every freeze HOLDING this target, including one that only reaches it
   because a SIBLING is covered by an `atomic` freeze) is what makes the atomic case fall
   out with no extra branch.
```

## §10. THE CONTINUOUS-TEST HOLD

THE CONTINUOUS-TEST HOLD (increment 8, D21) — THIS `continue` IS THE REFUSAL
Delete it and a target whose canary probe has gone stale, has never reported, or last reported FAILED triggers anyway, and every test in `pipeline-hook-admission.integration.test.ts` that asserts a held target's status stays `pending` goes red. Nothing else in this file withholds a trigger for probe freshness: the wave gate deliberately never sees `continuous` at all (`pipeline-hook-gate.ts` asserts it).

WHY A HOLD AND NOT A GATE, in one sentence, because it is the entire design: `pipeline-behaviors.ts`'s mechanism table — "a stale canary probe on target A says nothing about target B, so blocking B would be a lie about what is known". SIBLINGS MUST PROCEED, and that has its own integration test rather than being left as an emergent property.

THREE INVARIANTS, each copied verbatim from the two holds above and each load-bearing:

```text
1. COUNTED FIRST. `nonTerminalTargets++` happened at the top of this branch, BEFORE this
   `continue`. A held target is still in flight; without that, a wave whose only remaining
   target is held marks itself `succeeded` and the change completes green with a target
   that never ran — silent-success masking, the class ADR-0006 exists to prevent.
2. BEFORE `triggerWaveTarget`. No advisory trigger-claim lock is taken and no executor
   binding is re-read for a call we are not going to make, so `attempt` stays 0 on a
   target held from its first tick.
3. LAST OF THE THREE HOLDS — after the freeze `continue` and after the stage-dependency
   one. Only one `continue` can fire per target, so the three hold sets stay DISJOINT BY
   CONSTRUCTION, which is exactly what the terminalization arithmetic at the bottom of
   this loop depends on. Stated consequence, the same one the freeze hold states: a
   target that is both frozen and probe-held records only the freeze this tick, and
   starts producing `continuous_test` verdicts the tick the freeze lifts. Ordering it
   before the freeze would also spend a hook read per tick on a target no evidence could
   release, and would make a frozen target's Decision name the wrong reason.
```

AND AFTER THE BACKOFF GATE, for the reason both holds above state: a `triggering` target has already been handed to its executor and no hold can un-ring that bell. For a `pending` target — every first trigger, the case this is about — `backoffMs` is 0 and the orders are identical anyway.

## §11. BOUNDED BEFORE IT BECOMES A ROW

BOUNDED BEFORE IT BECOMES A ROW. `ExecutionStatus.detail` is free-form `string` supplied by ANY executor plugin — including third-party ones this repository does not compose the string for — and this `inputContext` is a `Decision`, i.e. permanent governed state. An unbounded `detail` here is an unbounded DATABASE row per poll, the same family as the 1.44 GB/day Decision growth incident. The managed plugins already bound their own (`@scp/runner-launcher`'s `boundDetail`, enforced by their stores' types), so for them this is the IDENTITY — that is the property that makes a second application safe rather than a fourth different slice: one bound, applied at each trust boundary, keeping both ends.

## §12. TERMINALIZATION, IN TWO RULES RATHER THAN ONE

TERMINALIZATION, IN TWO RULES RATHER THAN ONE — because a held target is in flight (invariant 1 above) and a single `if (!allTerminal) return` therefore kept an already-FAILED wave alive forever. A wave with one failed target and one held one never reached `markWaveTerminal`, so the `failed` branch at the top of this function never ran: no `autoRollbackOnFailure`, no park, no epitaph, no failure recorded on the change, while the hold's cursor bump re-served the change every tick and occupied a `BATCH_LIMIT` slot permanently. That was a REGRESSION on the loud 400 the compile-time same-wave refusal used to give this exact shape (ADR-0028 decision 6).

Holding a dependant on a doomed wave buys nothing — its dependency is not going to arrive in THIS wave, and the wave's verdict is already decided — so the hold stops keeping it open. The test is `anyFailed`, NOT the `failed` literal, so `aborted` and `no_executor` (both of which mark a wave failed, and neither of which ever ran) are covered by the same line.

The held target is still NEVER TRIGGERED on the way there, which is the whole point of the hold: it is left `pending` on a terminal wave — the truthful record, since no executor was ever handed it — and from the next tick on the `failed` branch returns before this loop is reached at all. Its hold Decision was written just above, so what kept it from running stays on record beside the failure that ended the wave.

M25.2 ADDS A SECOND HOLD SET TO BOTH LINES, and getting either one wrong is the sharpest regression risk in that increment:

```text
* Miss it in the FIRST guard and `nonTerminalTargets - heldCount` goes NEGATIVE (a frozen
  target is counted in `nonTerminalTargets` but not in the subtrahend, or the reverse), the
  guard passes, and a wave with genuinely live targets terminalizes.
* Miss it in the SECOND and a wave whose only remaining targets are frozen falls through to
  `markWaveTerminal(..., "succeeded")` — the wave completes GREEN with a target that was
  never deployed. Silent-success masking, the class ADR-0006 exists to prevent.
```

The two sets are DISJOINT BY CONSTRUCTION: the freeze `continue` in the loop above fires before the stage-dependency evaluation can run, so no target can appear in both. That is a property of the ordering, not of the data, which is why it is stated at both places. INCREMENT 8 ADDS A THIRD HOLD SET TO BOTH LINES, and the two failure modes M25.2 named for the second one apply unchanged to it: miss it here and `nonTerminalTargets - heldCount` goes wrong, the guard passes, and a wave with genuinely live targets terminalizes; miss it in the SECOND guard below and a wave whose only remaining targets are probe-held falls through to `markWaveTerminal(..., "succeeded")` — the wave completes GREEN with a target that was never deployed. All three sets are DISJOINT BY CONSTRUCTION (one `continue` per target, in a fixed order), which is a property of the ordering rather than of the data — which is why it is stated at all four places.

## §13. THE EXPLAINABILITY HALF OF THE FREEZE HOLD

THE EXPLAINABILITY HALF OF THE FREEZE HOLD (M25.2, charter principle 6) — and the anti-write-amplification contract that makes it safe to write from a 1 s loop.

Four properties, each defending a named prior incident. All four are copied from `recordStageDependencyHold` above, which is the point: this is the same seam one mechanism over, and it is the seam that produced this project's worst production incident.

`kind: "freeze_admission"`, DISTINCT FROM `"gate"`. `insertDecisionIfChanged` compares against the LATEST row of the same `(subject_id, kind)`. Sharing `gate` would make these rows and the wave gate's own rows for the same change ALTERNATE — each differing from the one before it — and suppression would never fire once. That is ADR-0024's measured 1.44 GB/day rebuilt from parts.

`verdict: "hold"`, NEVER `"block"`. `latestBlockDecisionForSubject` selects the newest row with `verdict = 'block'` for a subject, filtered on the VERDICT ALONE — no kind, no recency, no change-state gate — and `service-board.ts` feeds it straight into a component row's `attention.blocked`. Nothing ever writes a clearing row. A `block` here would mark the component blocked permanently: after the freeze lifted, after the change was accepted, forever. And unlike the nineteen other `block` writers, this one fires on EVERY release into a frozen window BY DESIGN, so it would make the attention signal permanently wrong for exactly the orgs that use freezes.

ONE ROW PER CHANGE, NOT PER TARGET. Per-target rows for a four-region wave would alternate under the same `(subject_id, kind)` comparison and suppression would never fire. `subjectId` is the CHANGE, and the held set is an array inside one `inputContext`.

`endsAt`, NEVER `now`. The freeze's own window boundary is in the context and the clock is not — `gate-orchestrator.ts`'s trick, copied exactly. Every field written here is a uuid, a small integer, a type-id string, a freeze name, or an ISO instant read straight off `freezes.ends_at`; none is derived from `Date.now()`, `attempt`, or an observed weight. BOTH SORTS (targets by `targetObjectId` here, freezes by id in `freeze-hold.ts`) are load-bearing for the same reason: a reordered `activeWave.targets` must not make an unchanged situation look new. So tick N+1 produces a byte-identical candidate, `restatesDecision` is true, and nothing is written. A three-week freeze over a held change is ONE row, not 1.8 million.

THE `reconcile_cursor_at` BUMP IS NOT OPTIONAL, and it goes in the SAME transaction as the Decision so a hold can never be recorded without its change also moving to the back of the queue. A change whose targets are all frozen stays `executing` with its wave `running`, so nothing else writes its row; `listChangeRowsInStates` serves oldest-`reconcile_cursor_at`-first capped at `BATCH_LIMIT`, so more than `BATCH_LIMIT` frozen changes would own every slot of every tick and every change queued behind them would never be evaluated even once. That is not hypothetical: the identical property stopped all coordination on the homelab for 13 days behind green health checks. This is bump 6 of 6, and `candidate-loop-registry.test.ts` is the CI gate that notices if it goes missing — its `advanceExecutingChanges` entry names this function and counts this bump. `state_entered_at` and `updated_at` are deliberately untouched (migration 0058's split): the watchdog's stall SLA must keep measuring from when the change entered `executing`, and a frozen change must not advertise itself to an operator as freshly updated every second it waits.

## §14. THE FAIL-OPEN, MADE VISIBLE

THE FAIL-OPEN, MADE VISIBLE (ADR-0028 decision 4, unreadable/unscopeable branch). A wave target that is not a live `placement` — a legacy-shaped topology whose waves name the change's own targets, or NO resolvable topology at all, which puts the plan on `compilePlan`'s toposort path — has no place for a stage-scoped hold to be scoped by. The declaration is not enforced, and the release proceeds, which is the right call: failing closed on a shape the coupling cannot express would strand every legacy plan behind a dependency it can never evaluate.

WHAT WAS WRONG WAS THE SILENCE, NOT THE VERDICT. The branch returned `satisfied: true`, so `held` was false, `recordStageDependencyHold` never ran, and the seam's only `console.warn` fires exclusively on `weightUnreadable` — a change whose CI declared a coupling and got NONE was invisible in every surface an operator has. This records it, at `warn` (not `block`: nothing is being withheld), so `scp decision list` answers "was my coupling enforced here?" with a row.

The guarantee is not lost so much as never this mechanism's to keep — `plan-compiler.ts`'s LEGACY path still refuses to schedule two components joined by a `depends_on` edge into one wave, and only the STAGE path's copy of that check was replaced by the hold (ADR-0028 decision 6). What it does not cover is the QUALIFIED declaration: a `minWeight` or a cross-change dependency on a component this change does not target orders nothing here.

SAME THREE PROPERTIES AS THE HOLD, for the same ADR-0024 reason. One Decision per CHANGE, not per target (`insertDecisionIfChanged` compares against the latest row of the same `(subject_id, kind)`, so per-target rows would alternate and suppression would never fire). Content-stable inputs — ids and branch names only, no clock. Persist on change. It also converges on its own: this branch only evaluates a `pending`/`triggering` target, and a target this records is triggering on this very tick, so the ordinary single-target case writes exactly one row ever.

NO CURSOR BUMP, unlike the hold, and the asymmetry is deliberate: nothing is being withheld here, so the change keeps moving through the loop on its own and has no way to freeze in the round-robin.

## §15. (0) IS THE TARGET OBJECT STILL THERE?

(0) IS THE TARGET OBJECT STILL THERE? — checked FIRST, before any binding is resolved, and this ordering is the fix rather than an accident of layout. See `target-liveness.ts` for the property; three things downstream of this line go wrong when a tombstoned target reaches them, and every one of them fails OPEN:

```text
* `listVisibleBindingsForTarget` (case (a)/(b) below) IS live-filtered, so a tombstoned
  target with real bindings returns ZERO of them and reads as case (a) INTENDED-FAKE. The
  target is then handed to the shared default fake executor and the change goes GREEN with
  nothing deployed — the exact masking failure ADR-0006 exists to prevent, arriving
  through the tombstone door instead of the binding door.
* `evaluateRegionalDeployGate` (case (c)) resolves a placement's deployment-target with a
  `deleted_at IS NULL` filter, so a tombstoned region target reads as "not a region" and
  the M15.6 silent-region-deploy gate simply STOPS FIRING — case (c) collapsing into case
  (a), which its own comment says must never happen.
* the stage-dependency hold (ADR-0028) resolves the placement pair the same way, gets
  `null`, and records every declared dependency as `unscopeable` -> satisfied. The
  coupling silently evaporates and the target triggers on that very tick.
```

In other words: every guard between here and the executor already asks "is this object live?", gets "no", and interprets it as "nothing to enforce". Absence read as permission, three times over. Asking the question FIRST — and answering it with a refusal — is what turns all three fail-opens into one explainable stop.

WHY HERE AND NOT IN THE PER-TARGET LOOP: this is inside `triggerWaveTarget`'s advisory trigger-claim lock and shares `blockWaveTarget`'s exactly-once status guard, so the Decision and the audit event are emitted once no matter how many ticks or replicas arrive. A check in the loop would need its own transaction and its own idempotency, and would be the second place that decides whether a target may be driven.

A THROWN read is NOT a deletion: `readTargetLiveness` has no catch, so a database blip propagates out of this tx, through the caller's per-target try/catch, and the target is retried next tick with nothing terminalized. See that module's "fail direction" note.

## §16. The executor-specific target id

The executor-specific target id (e.g. an Argo CD Application name) this object maps to. Falls back to the object id for legacy bindings — so a binding whose object id already IS the external name (pre-M12) is unaffected. This is what lets Mode A / imported objects trigger the right external resource when their SCP id differs from their external name. P3: a target may hold several Types of binding, so "the" binding no longer exists — reconcile must NAME the pipeline it drives. P4A supplies that name: the routing `type` (ADR-0007) rides in on the wave target, snapshotted at plan time from the change (and thence from the source mapping that matched the release), which is what makes a non-default binding TRIGGERABLE rather than merely registerable and readable. MUST use the same resolver as the gap analysis above. If this stayed a literal lookup while that one fell back, a component whose binding had moved to its placement would pass the gate and then trigger with a NULL externalRef — deploying against the wrong external resource, or none, with nothing blocked and nothing logged. Two resolution paths for one decision is how that class of bug happens; there is one path.

## §17. M25.4 — THE CHANNEL THAT WAS NEVER WIRED

M25.4 — THE CHANNEL THAT WAS NEVER WIRED. `TriggerIntent.parameters` has been on the plugin interface since M3 and every adapter reads it, but until now the only server call sites that populated it were `bump-dispatch.ts`, `bump-gate.ts` and `promotion-scan-step.ts` — the generic release path constructed `{kind, targetRef, priorStateRef, idempotencyKey}` and nothing else. Spread conditionally so a change with no recipe produces the exact same object it did before.

## §18. One org's tick

One org's tick. Each step below opens its own transaction(s) — see the module doc comment for why this no longer wraps the whole tick in one `withTenantTx` the way it used to (PR #7 review, CRITICAL #2). `processChangeSourceEvents` is pure DB work (correlation matching + proposing Changes — no external plugin calls), so it keeps its single-transaction-per-tick shape; it's still wrapped in try/catch here so one bad webhook row can never take down the rest of the tick.

## §19. ADR-0046 §4 — THE DOMAIN-LOCAL BINDING RECONCILER

ADR-0046 §4 — THE DOMAIN-LOCAL BINDING RECONCILER. Joins the federated WHAT (placements a team declared, which arrive over the journal) against this domain's own HOW (`executorBinding` policy effects) and materialises `executor_bindings` rows, so teams never file per-outpost binding tickets and credentials never leave the domain that owns them.

ON THIS TICK rather than a loop of its own, for the reason the hook-run observation below it gives: a second `boss.work()` would be a COMPETING CONSUMER on the reconcile queue. It runs BEFORE the advance* steps so a change reaching a wave this tick dispatches against bindings that already reflect the current policy, rather than one tick behind it.

ITS FAILURE IS CAUGHT AND LOGGED, never allowed to abort the tick: a malformed binding policy must not stop changes advancing. The gaps it reports are the loud half of §14 res 2 and are surfaced through the config-source/pipeline status surfaces, not through this loop's return.

## §20. ADR-0046 §2 — DRAIN THE CONFIG-SOURCE SYNC QUEUE

ADR-0046 §2 — DRAIN THE CONFIG-SOURCE SYNC QUEUE. The webhook pass recorded that a registered repo moved; this is where the manifest is read and applied, and it is what finally gives `syncConfigSourceCommit` a production caller.

ON THIS TICK, but with its own transactions inside: the drain reads manifests over the plugin RPC with NO transaction open, then opens one per entry to apply. That is why it takes `db` rather than a `tx` — see `config-source/drain-sync-queue.ts` for the three-phase shape and why one transaction would be wrong twice over.

Caught and logged, like the change-source processing above it: a config repo whose manifest cannot be applied must not stop changes advancing.

## §21. OUTPOST-RUN CONTINUOUS PROBES

OUTPOST-RUN CONTINUOUS PROBES — declare every `continuous` hook's schedule to the executor that will run it, and re-declare on every tick so a schedule deleted out-of-band is restored. SCP never fires the probe: it hands the executor a cadence and the executor's own scheduler runs it (`everySeconds` is descriptive in three places, all unchanged by this).

Beside the poll rather than on a loop of its own, for the reason stated above it: a second `boss.work()` would be a competing consumer on the reconcile queue.
