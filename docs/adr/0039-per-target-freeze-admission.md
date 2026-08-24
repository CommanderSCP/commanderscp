# ADR-0039: Per-target freeze admission at a wave boundary — a freeze holds the targets it covers and admits their siblings

**Status:** Accepted (owner decisions **D2** and **D5**, 2026-08-23, recorded in [campaigns-rework.md](../proposals/campaigns-rework.md) §1; **D7** for the rollback exemption). Shipped as M25.2, `drizzle/0084`.

**Numbering note (2026-08-23):** `main` tops out at 0033; 0034 is reserved in prose by `docs/proposals/governance-label-namespace.md`; 0035 is M23's; 0036/0037/0038 are taken on the unmerged UI branch `claude/ui-review-worktree-efc42b` (confirmed with that session — that branch is invisible to `gh pr list`). 0039–0042 are reserved by campaigns-rework.md; this is 0039.

**Relates to:** [campaigns-rework.md §1](../proposals/campaigns-rework.md) (the design and every grounded fact behind it), [ADR-0028](0028-stage-scoped-component-coupling.md) (the per-target hold pattern this reuses verbatim), [ADR-0026](0026-placements-and-derived-stage-names.md) (containment route 4 — why a region freeze already resolved), [ADR-0024](0024-decision-and-audit-retention.md) (the measured 1.44 GB/day, and the `endsAt`-never-`now` contract), [ADR-0006](0006-fail-closed-on-missing-executor-binding-for-purpose.md) (silent-success masking — the class the terminalization arithmetic defends), [ADR-0008](0008-observe-enrichment-signals.md) (no pause/resume verb — the ceiling on what a freeze can buy), [ADR-0040](0040-platform-tier-freezes.md) (the platform tier, which this resolver carries with no per-tier branch), charter principles 6 and 7.

## Context

The owner's requirement was concrete: **a wave should deploy to three of four targets when only one of them is frozen.**

Grounding found that almost everything needed for that already existed and was mature. `freezes` is a first-class table with a time window and a scope object id; `checkFreeze` runs *first*, ahead of policy matching and ahead of the emergency-policy branch, so `emergency: true` does not bypass a freeze; the override loop iterates **every** active freeze and demands `freeze:override` at *that freeze's own* scope with a mandatory reason (checking only `active[0]` was a shipped bug, since fixed — this ADR calls that property **CRITICAL #2**); and containment routes 3 and 4 put a placement's component *and* its deployment-target on the chain, so **a freeze scoped at a region already resolved correctly** and had since 2026-08-02.

What was missing was not scope. It was **admission granularity**, and it had two distinct halves:

1. `evaluateWaveGate` resolved freezes by unioning *every* target's containment chain into one scope set and asking one question of it. One frozen region therefore parked all four. The verdict had no target dimension to express anything else.
2. The wave gate fires **exactly once**, on `pending → running`. A freeze declared *mid-wave* was never seen at all.

A fix that only addressed (1) — a smarter verdict at the same gate — would still miss (2) entirely, which is why the answer is a relocation rather than a refinement.

## Decision

### 1. Enforcement relocates to a read-time predicate consulted in the per-target trigger loop

`coordination/freeze-hold.ts` is a **predicate only**: `evaluateFreezeHolds(tx, { orgId, targetObjectIds, now? })` returns a `Map<targetObjectId, FreezeHoldVerdict>`. `coordination/reconcile.ts`'s per-target loop is the seam that **refuses**, and the refusal is a `continue` placed before `triggerWaveTarget`. This is ADR-0028's stage-dependency-hold pattern, taken verbatim, for the same reason it was adopted there: a predicate re-evaluated every tick sees a fact that arrives after the gate ran, and a gate cannot.

A target with **no** covering freeze is **absent from the map**, never present with an empty list. The caller's seam is `const frozen = holds.get(id); if (frozen) { … continue; }`, and a present-but-empty entry would make that `if` true for every target on the instance.

The five placement invariants of the `continue`, each defending a named prior incident, are stated at the seam itself. Two are load-bearing enough to restate here:

* **The target is counted in `nonTerminalTargets` *before* the `continue`.** A frozen target is still in flight.
* **The check sits *after* the backoff gate.** A `triggering` target has already been handed to its executor, so the freeze withholds the **retry**, not the original call. That is the honest boundary of what a freeze buys, and it follows from ADR-0008: `ExecutorPlugin` is exactly `observe`/`trigger`/`status`/`abort`/`describeCapabilities`, so **a freeze cannot pause an in-flight rollout** and nothing in this ADR promises it can.

### 2. The wave gate keeps a freeze check, narrowed to the all-frozen case

Deleting the gate's freeze check entirely is simpler, and its control-flow argument is correct — but it silently drops the **all-frozen** block as a side effect. Under a total org-root freeze every wave would transition to `running` with a non-null `started_at` while nothing ran, and today's whole-wave `gate`/`block` Decision — the surface an operator resolves with `scp change explain` — would disappear.

So `evaluateGovernanceGate` gains one guard:

```ts
const partiallyFrozen =
  ctx.gateKind === "wave_boundary" &&
  frozenIds.length > 0 &&
  frozenIds.length < ctx.targetObjectIds.length &&
  byTarget.every((e) => e.freezes.every((f) => !f.atomic));
```

Each conjunct does work. `gateKind === "wave_boundary"` is the one worth naming: **`lifecycle_edge` keeps any-target-frozen ⇒ block, deliberately.** Accepting a change is one atomic state change of one `changes` row — *there is no such thing as accepting three quarters of a change*. Partial admission is meaningful at a wave boundary and only there. That conjunct also covers `POST /policy-evaluate` (`routes/governance.ts`, `lifecycle_edge`) for free.

Charter priority 7 decides the trade: Operability sits above Maintainability, and discarding a working operator surface to buy one `if` is the wrong direction.

### 3. `checkFreeze`'s body is unchanged text — CRITICAL #2 is preserved *structurally*

```ts
const byTarget = await freezesByTarget(tx, ctx.orgId, ctx.targetObjectIds, now);
const active   = unionFreezes(byTarget);   // was activeFreezesForScopes(containmentScopeIds(...))
// …the per-freeze override loop, byte-for-byte unchanged
```

This is chosen deliberately over decomposing `checkFreeze` into an extracted quantifier. **`checkFreeze` never sees the per-target map's keys**, so a per-target early return or a `byTarget[0]` degradation is *not expressible* at that call site. The property is enforced by the shape of the code, not by a reviewer remembering it.

`unionFreezes(freezesByTarget(T))` is set-equal to `activeFreezesForScopes(containmentScopeIds(T))` **by construction**, because `containmentScopeIds` *is* the union of the per-target chains. That equality is pinned by its own test against real containment walks, not asserted.

One resolution call feeds both consumers, so the gate's quantifier and `partiallyFrozen` can never disagree about what is frozen.

### 4. One window predicate, one membership rule

`activeFreezesInWindow(tx, orgId, at)` is **the only place that knows the window predicate** (`startsAt <= at < endsAt`, and — after M25.1 — `lifted_at IS NULL`); `filterFreezesByScopes` is the pure, database-free membership rule. `activeFreezesForScopes` became the composition of the two, byte-identical in behaviour.

This is not tidiness. **Two copies of a window predicate is how the containment routes drifted until a service-scoped freeze failed OPEN** — silently, because a freeze that stops matching produces the same `allow` a freeze that never existed would. Keeping one copy is what let M25.1's soft lift retire a freeze on *every* path, including the release path, with a single `IS NULL`.

### 5. Inertness is structural, not a convention

`freezesByTarget` issues one indexed org-wide window read **first**; if it returns zero rows every target comes back with `freezes: []` **without walking a single containment chain**. This runs for every executing change on the instance every second, so the property has its own counting test rather than a comment.

### 6. `freezes.atomic` (D5) — and it is read at **both** seams, not only the gate

`atomic = false` (the default) is per-target admission. `atomic = true` restores the union: a covering freeze holds **every** target of the wave.

**The default is a change that newly PERMITS, and it applies retroactively.** Every service- and component-scoped freeze already authored on an estate became more permissive the day M25.2 shipped. That is owner decision D5, taken with the consequence stated; note the asymmetry with precedent — containment route 4 was escalated to the owner precisely because it newly **blocked**. This is its mirror image, and it needs a release note, not just this ADR.

Reading `atomic` **only** at the gate would have made it degrade silently to per-target admission for any freeze opening after the wave started — that is defect (2) from the Context, applied to one dimension and not the other. `freeze-hold.ts` reads it too. The consequence, stated because an operator will meet it: an `atomic` freeze declared **before** the gate parks the wave whole and writes no hold Decision; one declared **mid-wave** produces a hold Decision naming it.

Under `atomic`, a held target may be one **no freeze covers** — it is held because a *sibling* is covered. `atomic` is therefore carried per freeze in the Decision, so the record says *which* freeze did it rather than leaving an operator to work out why a scope nothing froze stopped moving.

### 7. The Decision is `freeze_admission` / `hold` — never `gate` / `block`

```
kind:      "freeze_admission"     // NOT "gate"
verdict:   "hold"                 // NOT "block"
subjectId: change.objectId        // ONE per change, never per target
```

Three of these are defences against a named prior incident, and none is stylistic:

* **`kind` distinct from `gate`.** `insertDecisionIfChanged` compares against the LATEST row of the same `(subject_id, kind)`. Sharing `gate` would make these rows and the wave gate's own rows alternate — each differing from the one before — and suppression would **never fire once**. That is ADR-0024's 1.44 GB/day flood rebuilt from parts.
* **`verdict: "hold"`, never `"block"`.** `latestBlockDecisionForSubject` selects on `verdict = 'block'` **alone** — no kind, no recency, no change-state gate — and the service board feeds it straight into `attention.blocked`. Nothing ever writes a clearing row. A `block` here would mark the component blocked permanently: after the freeze lifted, after the change was accepted, forever. And this writer fires on *every* release into a frozen window, by design.
* **One row per CHANGE, not per target.** Per-target rows for a four-region wave would alternate and suppression would never fire.

**`endsAt`, never `now`.** Every field is a uuid, a small integer, a type-id string, a freeze name, or an ISO instant read straight off `freezes.ends_at`. Both arrays are **sorted by a stable key**, because `restatesDecision` canonicalizes object *keys* but array *order* is significant and `activeFreezesInWindow` has no `ORDER BY` — an unsorted array would let a reordered query result make an unchanged situation look new. A three-week freeze over a held change is **one row**, not 1.8 million.

**Not a CEL condition.** CEL takes `time` as a caller-supplied snapshot, so a time-referencing condition is deterministic per invocation but flips at a wall-clock boundary with **no `inputContext` change** — the write-amplification hazard in the other direction, and invisible to `restatesDecision`.

### 8. The terminalization arithmetic, and the disjointness it rests on

```ts
const heldCount = heldTargets.length + frozenTargets.length;   // disjoint by construction
if (nonTerminalTargets - heldCount > 0) { /* cursor bump */ return; }
if (heldCount > 0 && !anyFailed) return;                        // the PURE hold
await markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded");
```

This is the sharpest regression risk in the increment, and both lines matter:

* Miss the **second** and a wave whose only remaining targets are frozen falls through to `markWaveTerminal(…, "succeeded")` — **the wave completes green with a target that was never deployed.** Silent-success masking, the class ADR-0006 exists to prevent.
* Miss the **disjointness** and `nonTerminalTargets - heldCount` goes negative, the first guard passes, and a wave with genuinely live targets terminalizes.

**The two hold sets are disjoint by construction, not by data:** the freeze `continue` fires *before* the stage-dependency evaluation can run, so no target can appear in both. It is a property of the ordering, which is why it is stated at both places. The consequence, stated: a target that is both frozen and dependency-held records only the freeze that tick, and resumes producing `stage_dependency` verdicts the tick the freeze lifts.

The `anyFailed` short-circuit is inherited unchanged: a frozen target on a doomed wave stops keeping it open, is left `pending` (the truthful record), and its hold Decision stays beside the failure.

### 9. It clears at read time, in about one second. There is no unlock verb

There is no scheduler — only the 1 s reconcile tick. `activeFreezesInWindow` filters the window, so on the first tick after `endsAt` the freeze is simply not in the org set; if the set is empty the module is not even called; the target falls through to `triggerWaveTarget` and fires. **No status flip, no job, no backfill** — the same ruling M22.6 already made for expiry.

`clearFreezeAdmissionHold` runs only on a tick where some target actually triggered and none is held. It reads the latest `freeze_admission` row and — **only if it exists and is a `hold`** — writes one `verdict: "allow"` row of the same kind with `held: []`. A change never held pays nothing; a change that was held gets exactly one release row, then suppressed forever. `scp change explain` therefore shows **hold → release**, which ADR-0028 does not provide today.

### 10. The second actuator: campaign fan-out

`campaign-reconcile.ts`'s `pending` branch takes the same lookup — after the liveness gate (a tombstoned target is dead regardless of any freeze, and terminalizing it is progress) and before `proposeChange`.

This is **operability, not correctness**: a member change fanned out into a freeze would be held at actuator 1 anyway. But without it, a 40-target campaign entering a two-week freeze mints 40 real Changes that each compile a plan, enter `executing`, and trip the watchdog's 30-minute SLA for two weeks. Hold the fan-out and the estate stays clean.

Campaign wave targets are **components**, so only org/domain/service/component-scoped freezes reach them; a region freeze correctly does *not* stop fan-out — it stops the member change's placement targets.

### 11. A dead target is not held

The change-side `continue` precedes `triggerWaveTarget` and therefore precedes its target-liveness gate. Without care, a tombstoned placement under a region freeze would sit `pending` for the whole window behind a Decision saying a freeze held it — while the truth was that the object was deleted — deferring the tombstone's own audit event for just as long. `evaluateFreezeHolds` checks liveness **for covered targets only**, which makes the change side agree with the ordering the campaign side already argues for.

### 12. The D7 rollback exemption, as narrowed by the build

D7 exempts rollbacks from freezes at the wave boundary. `evaluateLifecycleGate` had exempted them since M4; `EvaluateWaveGateContext` carried no `isRollback` at all — an oversight, not a decision, and the one that left `scp change rollback` as the documented exit from a stuck release while a freeze quietly closed that exit.

The shipped exemption is narrower than D7's literal wording in **two** ways, both added by adversarial review and both flagged to the owner as interpretation rather than new decision:

* **It stops at the platform tier.** `rollbackExemptible` is the single definition of "may D7 stand this covering set aside", shared verbatim by the gate and the per-target seam. A **platform** freeze is never stood aside for a rollback. Shipped tier-blind, the exemption handed any principal holding `object:write` — all `POST /v1/changes/{id}/rollback` requires: no `freeze:override`, no reason, no operator token — a route past the very freeze whose block sentence promises "no tenant role can override it, however privileged", and a *cheaper* route than the override it was contrasted with. (Recorded also as [ADR-0040](0040-platform-tier-freezes.md) §8.)
* **It requires the original release to have actually reached that target** (`rollbackHasSomethingToUndoAt`). Per-target admission makes a composition reachable that could not happen before it: the freeze holds `amer`, the siblings now **ship**, `apac` fails, the wave goes `failed`, and an `autoRollbackOnFailure` policy mints a rollback — unattended, as `SYSTEM_ACTOR_ID` — over **all** the original's targets, `amer` included. `findOriginalWaveTarget` returns a never-triggered row, so `priorStateRef` is `null`, and `trigger({kind:"rollback"})` would fire into a scope under a declared freeze to undo a release that never happened there. D7's stated rationale — *holding a rollback pins a broken release in place* — is about a target the broken release actually reached. This **refuses more** than D7's letter and permits nothing D7 does not; pre-M25.2 that target was freeze-blocked anyway, so it is not a regression on behaviour that ever shipped.

The exemption is also qualified on `wave_boundary` rather than on `isRollback` alone. `isRollback` lives on the **shared** `GateContext`; one future caller setting it on the lifecycle path would silently lift the freeze at `validating → accepted` *and* on `POST /policy-evaluate`. D7 is a wave-boundary decision.

## Rejected alternatives

**A fully-keyed gate — per-(wave × target) gate verdicts.** Foreclosed by storage that already exists: `approval_requests_dedup_key` is `UNIQUE (org_id, change_object_id, policy_object_id, policy_version, effect_index)` (`drizzle/0010_governance.sql:60`) — **it has no target dimension**. Giving the gate one means either a migration widening that key, or N gate evaluations colliding on one approval request. The gate is a whole-change instrument; the per-target question does not belong to it.

**A compile-time partition — split the frozen targets into their own wave at plan time.** Foreclosed by the gate's own addressing: a gate binding's `gate_ref` is `{waveIndex, topologyObjectId}` (`db/schema.ts:971`), so re-partitioning waves after the fact renumbers the coordinate that already-written gate records are keyed on. It is also wrong on its own terms: the plan is compiled once and a freeze can be declared, lifted or shortened at any point afterwards, so a compile-time answer is stale by construction — defect (2) again.

**A `frozen` value on `change_wave_targets.status`.** Additive and cheap (plain `text`, no enum, no CHECK) and still wrong: it is a materialized copy of a **time-window predicate**, it needs a job to un-flip it, and as the newest non-terminal row under an `executing` change it would **mask the dependency's genuinely successful earlier deploy at that place** for the whole window under `CHANGE_STANDS_BEHIND_ITS_TARGETS`. The read-model answer is a derived `hold` field, per M22.6.

**A bounded hold — terminalizing a target `frozen_out` past a horizon.** Designed and not proposed: it introduces a new terminal wave-target status that must land in *both* `TERMINAL_WAVE_TARGET_STATUSES` and reconcile's terminal branch ("add to both or neither"), and it fails a wave because of a calendar window. If it is ever built, the determinism trick is to compare the horizon against `change_waves.started_at` — a **stored** instant — never against `now`.

## Consequences

**A change does not complete when a target is held.** Three of four regions ship; the change stays `executing`; the wave never terminalizes; **later waves never start**. This is the distinction to put in front of an operator: the design delivers *"deploy to 3 of 4 targets"*, not *"the release is done"*.

While held, the truthful record is: the frozen target's `status` stays `pending` with `executorRef` null and `attempt` 0 (proof the actuator fired); siblings run `triggered → observing → succeeded`; `change_waves.status` is `running` (the gate allowed — the wave *is* genuinely mid-flight); `changes.state` is `executing` with `reconcile_blocked_at IS NULL`; the service board reads `releasing`, which is honest.

**Two honesty defects had to be fixed in the same increment**, or the lever would work while the signal was missing:

* The service board built `activeFreezeByScope` as exact-set membership on `component.id` / `service.id`, so a domain-, org-root- or **deployment-target**-scoped freeze appeared on **no board row at all** — freeze `amer-prod` and every affected component reported `activeFreeze: null`. It now resolves through containment over the service, its components *and their placements*, which also deleted the third copy of the window predicate.
* `campaign_waves.status` no longer goes `blocked` on a partial freeze (that value came from the gate's `block` verdict), so the campaign's `blocked` status is re-derived at read time rather than read off the Decision.

**The wave-target `hold` projection field is not part of M25.2.** It holds a codegen slot on the UI branch; its four required properties are specified in campaigns-rework.md's closing section. M25.2 is internal-only.

**Per-target admission is not tier-specific.** M25.3 folded the platform tier into `freezesByTarget` itself, so `checkFreeze`, `freeze-hold.ts`, the `atomic` union and the service board all got the platform tier with no per-tier plumbing. That is asserted by construction rather than assumed.

**`activeFreezesForScopes` was kept, not deleted.** It is no longer on the resolution path — `freezesByTarget` is — but it remains the subject of the set-equality test that pins §3. Deleting it is a separate cleanup with its own test consequence.

## The standing mutation gate

Per this repo's rule that a claimed property is proven by deleting the wiring and watching a named test die, four mutations must be run deliberately before this decision is treated as kept:

1. Delete the `continue` before `triggerWaveTarget` → the 4-placement case must fail on `amer` acquiring a non-null `executorRef`.
2. Drop `frozenTargets.length` from the **second** terminalization line → the wave must mark `succeeded` with a target never deployed.
3. Replace `unionFreezes(byTarget)` with `byTarget[0].freezes` in `checkFreeze` → the per-freeze override case must fail.
4. Flip `every` → `some` in the freeze override quantifier → **both** the accept-edge test and the wave-path test must go red. **If only one does, the second caller has no coverage — that is the check, not the pass.**
