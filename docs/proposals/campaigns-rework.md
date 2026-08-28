# Campaigns & Freezes Rework (M25)

**Status:** v0.1 Draft — proposed 2026-08-23, pending owner review. Owner decisions D1–D4 taken 2026-08-23; the mechanism below is proposal pending review.
**Relates to:** [ADR-0028](../adr/0028-stage-scoped-component-coupling.md) (the per-target hold this reuses), [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (containment route 4 — why a region freeze already resolves), [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) §3 + [ADR-0033](../adr/0033-scan-exclusions-and-overrides.md) §7a (the instance-scoped operator-write/tenant-read precedent), [ADR-0008](../adr/0008-observe-enrichment-signals.md) (no pause/resume verb — the ceiling on any lock), [ADR-0032](../adr/0032-dependency-subscriptions.md) (the actuator this rework must NOT absorb), [ADR-0031](../adr/0031-domain-local-objects-never-federate.md); [DESIGN.md](../DESIGN.md) §9.3, §9.5, §10.1, §10.3, §10.4; [coordination-ui-views.md](coordination-ui-views.md) (the UI counterpart — freeze authoring surfaces are specced there, not here); charter principles 1, 2, 4, 6, 7.
**Proposed ADRs:** ADR-0039 – ADR-0042 *(0033 is the highest on `main`; 0035 is M23's; 0036/0037/0038 are taken on the unmerged UI branch `claude/ui-review-worktree-efc42b`, confirmed with that session 2026-08-23 — so 0039+ is free)*
**Owner decisions this implements:** D1 (freeze reach), D2 (one scope axis), D3 (coordination lever), D4 (deadline lock radius), D5 (`atomic` default), D6 (org-tier freezes federate), D7 (rollbacks exempt), D8 (bump auto-merge blocked)

## Owner decisions — second round (2026-08-23), closing OQ-1, OQ-2, OQ-4 and the escalated bump gap

- **D5 — `atomic` defaults to `false`; per-target admission is the new default behaviour** (closes OQ-1, option (a)). Every existing service- and component-scoped freeze on the estate becomes more permissive the day M25.2 ships; a freeze that must stop a whole wave declares `atomic: true`. **This is a change that newly PERMITS, and it applies retroactively to freezes already authored** — it therefore needs a release note, not just an ADR, and the M25.2 DoD must include a test proving an `atomic` freeze still parks every sibling.
- **D6 — org-tier freezes federate** (closes OQ-2, option (b)). **M25.7 is in scope.** A freeze gains its own graph object so it can ride `object_upsert`; the `freezes` projection row stays and is rebuilt at the importing instance — the same object-plus-projection pattern `changes` and `campaigns` already use (`schema.ts:764` names `freezes.scopeObjectId` as that class already). This overturns a deliberate, tested absence, and the flip must carry the retired pin's reasoning plus a mutation proving the new pin non-vacuous. Three artefacts are rewritten: `service-board-precedence.integration.test.ts`, BUILD_AND_TEST M16.2, and `outpost-configuration.tsx:591-606`'s operator-facing copy (the last is the UI session's, coordinated).
  - **A platform-tier freeze still does not federate**, and this decision does not change that: the sync journal is org-scoped at every layer and a platform freeze has no `org_id` and is declared by no commander. Platform tier remains per-instance operator config. Only the **org tier and below** federates.
- **D7 — rollbacks are exempt from freezes at the wave boundary** (closes OQ-4). `evaluateLifecycleGate` already exempts them (`gates.ts:128-133`); `EvaluateWaveGateContext` carries no `isRollback`, which was an oversight rather than a decision. Holding a rollback pins a broken release in place for the whole window. Also a change that newly permits, so it gets its own explicit test in both directions.
- **D8 — a freeze blocks the dependency actuator's AUTO-MERGE, not its PR authoring.** The bump PR may still be opened during a freeze (the work stays visible and queued); merging it into the tenant's default branch is refused with a Decision. This closes the escalated gap where a declared freeze did not stop SCP from merging code into a tenant's repositories. **Tracked as M25.8** — it is a fix to an already-shipped path, not part of the campaigns design, and it lands as its own increment with its own test.

**Still open:** OQ-3 (commander-declares / outpost-adopts semantics — now partly forced by D6 and answered inside M25.7), OQ-5 (may a campaign drive the `managed-dep` actuator — **not built absent a ruling**, so M25 ships without it), OQ-6 (`declared` adoption evidence — **not shipped**, per the recommendation, until an above-component admission algebra exists).

---

## Summary

Freezes are already built, mature, and correct at the scope level the owner asked for — a freeze scoped at a `deployment-target` (a region) has worked since containment route 4 landed on 2026-08-02, and `checkFreeze` already requires every active freeze to be individually overridden by an actor holding `freeze:override` at *that freeze's own* scope. What is missing is **admission granularity**: `evaluateWaveGate` issues one verdict for the union of every target's containment chain, so one frozen region parks all four, and the gate fires exactly once on `pending -> running` so a freeze declared mid-wave is never seen at all. This rework relocates freeze enforcement from a whole-wave verdict to a **per-target admission seam inside reconcile's trigger loop** — the ADR-0028 stage-dependency-hold pattern, verbatim — while keeping today's whole-wave block for the all-frozen case; adds an **operator-owned platform tier** with no `org_id` for freezes that bind every tenant on a deployment (D1); gives campaigns a **recipe** that fans one trigger intent across N components through the executor interface's already-present-but-unwired `TriggerIntent.parameters` channel (D3); and adds a **read-time deadline lock** that withholds *this campaign's own* fan-out from unmigrated targets past a date (D4). Every mechanism names its actuator, and no mechanism promises to pause an in-flight rollout, because `ExecutorPlugin` cannot express it.

---

## What already works (and must not regress)

Read this section before proposing any change to the freeze path. Most of what a reviewer expects to be missing is present.

**Freezes as a mechanism**
- `freezes(id, orgId, scopeObjectId, name, startsAt, endsAt, reason, createdByActorId, createdAt)` — `schema.ts:1020-1037`, indexed `freezes_org_scope` and `freezes_org_window`. A dedicated projection table, justified in its own docblock: a freeze's whole state is a window + scope + reason, so the generic object model buys nothing.
- `checkFreeze` (`gate-orchestrator.ts:92-145`) runs **first**, before policy matching (`:827`), before the emergency-policy branch (`:870`) — so `emergency: true` does *not* bypass a freeze.
- It walks `containmentScopeIds(tx, orgId, ctx.targetObjectIds)`, which covers **both** containment routes. Its docblock records that a `domain_id`-only walk once made a service-scoped freeze fail **OPEN**, because `activeFreezesForScopes` is exact-set membership and does no walking of its own.
- **CRITICAL #2 is live and correct:** the override loop iterates *every* active freeze and requires `hasPermission("freeze:override", freeze.scopeObjectId)` for each one individually, with a mandatory non-empty reason. Checking only `active[0]` was a shipped bug. Verified at HEAD.
- A rejected override returns `blocked` rather than throwing, so the caller writes a Decision with a resolvable `decision_id` instead of a rolled-back raw 403.
- Determinism: `evaluateGovernanceGate` snapshots `const now = new Date()` once (`:825`) and the block's `inputContext` carries `freeze.id`, `scopeObjectId` and **`endsAt` — never `now`** (`:834-840`). That is what makes `insertDecisionIfChanged` dedup every tick, and violating it is what produced the measured 1.44 GB/day.

**Scope reach**
- Containment routes 3 and 4 (`graph/containment.ts:37-62, 146-190`) put a placement's **component** and its **deployment-target** on the chain. Route 4's own comment: *"a freeze scoped at a stage catches everything deploying there"* — owner decision 2026-08-02. **A region freeze already resolves correctly.** Nothing in D2 needs a new scope model; only per-target admission is missing.
- A region is an ordinary `deployment-target` carrying `properties.environment` + `properties.region` (M15.6 / ADR-0017 §3, read at `regional-executors.ts:86-97`). No new object type. Charter principle 2 intact.

**The rollback exemption**
- `evaluateLifecycleGate` returns an unconditional allow for `ctx.isRollback` **before** `evaluateGovernanceGate` runs (`gates.ts:128-133`, DESIGN §9.4 — "no human-review step to wait for"). Verified at HEAD.

**Campaigns**
- `campaign_plans` / `campaign_waves` / `campaign_wave_targets` (`schema.ts:1124-1180`). Campaign status is **derived, never stored**.
- Fan-out mints a real member `Change` with **exactly one** target (`campaign-reconcile.ts:406-419`), linked by a `coordinates` edge, with `sourceRef: { campaignObjectId, waveIndex }`. Each member change then gets its own full governance pass — so per-target freeze scoping already works correctly *after* fan-out, purely as a side effect of one-target-per-change.
- `campaign.properties` validates against an **open** JSON Schema (`0011_campaigns.sql:120-128`: `{"type":"object","required":["targets"],...}` with no `additionalProperties:false`) under `new Ajv({strict:false})`. `proposeCampaign` already writes `type`/`topologyObjectId`/`topologyVersion` into it. **A new `recipe` or `deadline` key validates today with zero schema work.**
- The generic `/objects/campaign` door already refuses every write verb (`campaign-scope-authz.ts:21-24`), so `campaign.properties` has exactly three write doors: `POST /campaigns`, IaC apply, federation import.

**Starvation discipline (do not "fix" what is already fixed)**
- `reconcileCampaignsOrgTick` **already** bumps `objects.updated_at` unconditionally for every locally-owned campaign it examines (`campaign-reconcile.ts:~548`), with a 40-line comment naming it instance 4 of the starvation class and pinning the replica case. **Verified.** One core design's claim that campaign holds are starvation-prone and need a migration is **false**; do not spend that migration.
- The change side has five cursor bumps today, each in the same transaction as its Decision, touching `reconcile_cursor_at` only (migration 0058 split it from `updated_at` and `state_entered_at` deliberately). `candidate-loop-registry.test.ts` is the CI gate that catches a missing one.

**Terminalization arithmetic (verified verbatim at `reconcile.ts:~1178` and `:~1236`)**
```ts
if (nonTerminalTargets - heldTargets.length > 0) { /* cursor bump */ return; }
if (heldTargets.length > 0 && !anyFailed) return;   // the PURE hold
await markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded");
```

**The executor channel already exists**
- `TriggerIntent.parameters` is on the interface and **every adapter already reads it** — `github`/`gitea` (`workflowId`, `ref`, `inputs`), `gitlab` (`ref`, `variables`), `argocd` (`targetRevision`), `pipeline-generic` (pass-through) — each falling back to its binding's `config.defaultWorkflowId` / `defaultRef`. The only server call sites that set it today are `bump-dispatch.ts:868`, `bump-gate.ts:465`, `promotion-scan-step.ts:861`. **`reconcile.ts`'s trigger call (`~:1872`) constructs `{ kind, targetRef, priorStateRef, idempotencyKey }` and nothing else — verified.** The channel is unwired on the generic release path. That is the single highest-leverage fact in pillar 3.

**Free wins the per-target hold inherits**
- `findLatestWaveTargetForObject` + `CHANGE_STANDS_BEHIND_ITS_TARGETS`: a held target left `pending` under an `executing`, unparked change is correctly read as "something is driving this", so dependants of a frozen component hold at that place with no new code.

---

## The four pillars

### 1. Per-target wave admission (the crux)

Three competing framings were designed and judged. All three converged on the *same* actuator — a `continue` in reconcile's per-target trigger loop, a `hold` Decision, a cursor bump, corrected terminalization — and differed only in what they did to the governance layer. Two of three judges ranked the "partition" framing first (in its corrected, read-time form); one ranked the "relocate wholesale" framing first on simplicity grounds. **The disagreement is real and it is about one question: should the wave gate keep any freeze check at all?**

**Ruling: keep the gate check, narrowed.** The "delete it entirely" framing is simpler and its control-flow proof is correct, but it silently drops the **all-frozen** block as a side effect and never argues that loss. Under a total org-root freeze every wave would transition to `running` with a non-null `started_at` while nothing runs, and today's whole-wave `gate`/`block` Decision — the surface an operator resolves with `scp change explain` — would disappear. Its own §6 concedes the block path *does* re-evaluate every tick (the wave stays `pending`, the change is re-served), so the gate is once-firing on the **allow** path and live-re-evaluating on the **block** path. Discarding the working half to buy one `if` is the wrong trade under charter priority 7 (Operability sits above Maintainability).

#### 1.1 The three code changes

**(a) `governance/freezes-repo.ts` — one window predicate, one membership rule.**

```ts
/** Every freeze whose window covers `at`, org-wide. NO scope filter. The ONLY place that knows
 *  the window predicate (startsAt <= at < endsAt). Served by `freezes_org_window`. */
export async function activeFreezesInWindow(tx, orgId, at: Date): Promise<FreezeRow[]>;

/** PURE. The membership rule, unit-testable with no database. */
export function filterFreezesByScopes(rows: FreezeRow[], scopeObjectIds: string[]): FreezeRow[];
```
`activeFreezesForScopes` becomes the composition of the two — byte-identical behaviour, same exact-set-membership contract, same warning docblock, existing callers untouched. Two copies of a window predicate is how the containment routes drifted until a service-scoped freeze failed open.

**(b) `governance/freeze-scope.ts` (new) — the per-target primitive.**

```ts
export interface TargetFreezes { targetObjectId: string; freezes: FreezeRow[] }

/** Per-target freeze resolution. Walks `containmentChain` PER TARGET — never a hand-rolled walk,
 *  never `[targetObjectId]` alone. Inert when the org has no active freeze. */
export async function freezesByTarget(tx, orgId, targetObjectIds, now): Promise<TargetFreezes[]>;

/** Union across targets, deduped by id, stable order. What whole-change semantics consume. */
export function unionFreezes(byTarget: TargetFreezes[]): FreezeRow[];
```

Two properties are load-bearing:

- **Inertness.** `activeFreezesInWindow` runs *first*; if it returns zero rows the function returns every target with `freezes: []` **without walking a single containment chain**. This runs for every executing change on the instance every second. Non-negotiable, and it gets its own test.
- **`unionFreezes(freezesByTarget(T))` is set-equal to `activeFreezesForScopes(containmentScopeIds(T))` by construction**, because `containmentScopeIds` *is* the union of per-target chains.

**(c) `gate-orchestrator.ts` — `checkFreeze`'s body is unchanged text.**

```ts
const byTarget = await freezesByTarget(tx, ctx.orgId, ctx.targetObjectIds, now);
const active   = unionFreezes(byTarget);   // ← was activeFreezesForScopes(containmentScopeIds(...))
// ...the per-freeze override loop from :110-141, byte-for-byte unchanged
```

This is the **structural** preservation of CRITICAL #2, and it is chosen deliberately over decomposing `checkFreeze` into an extracted quantifier: `checkFreeze` never sees the per-target map's keys, so a per-target early return or a `byTarget[0]` degradation is not expressible at that call site. Verified prerequisite: `EvaluateWaveGateContext` has **no `overrideFreeze` field** and `gates.ts:~200` passes none, so the override loop is unreachable on the wave path today and relocating the wave-path check removes *zero* override logic.

Then, in `evaluateGovernanceGate`:

```ts
const frozenIds = byTarget.filter(e => e.freezes.length > 0).map(e => e.targetObjectId);
const partiallyFrozen =
  ctx.gateKind === "wave_boundary" &&
  frozenIds.length > 0 &&
  frozenIds.length < ctx.targetObjectIds.length &&
  byTarget.every(e => e.freezes.every(f => !f.atomic));   // see §1.6

const freezeCheck = await checkFreeze(tx, ctx, now, byTarget);
if (freezeCheck.blocked && !partiallyFrozen) { /* existing block return, byte-identical */ }
```
`GateOutcome`/`GateVerdict` gain `frozenTargets?: TargetFreezes[]`, populated only at `wave_boundary`. These are internal TS types, not wire schemas.

**`lifecycle_edge` keeps ANY-target-frozen ⇒ block, deliberately.** Accepting a change is one atomic state change of one `changes` row; there is no such thing as accepting three quarters of a change. Partial admission is meaningful at a wave boundary and only there. Gating on `ctx.gateKind` also covers `POST /policy-evaluate` (`routes/governance.ts:605`, `lifecycle_edge`) for free.

**All-frozen stays a whole-wave block.** Today's Decision (`kind:"gate"`, `verdict:"block"`, `inputContext.freeze`) is written exactly as now, the wave stays `pending`, `started_at` stays null, and today's tick-by-tick re-evaluation lifts it when the window closes. Minimum regression surface.

#### 1.2 THE ACTUATOR

> **`reconcile.ts`'s per-target trigger loop is the seam that refuses. The refusal is a `continue` placed before `triggerWaveTarget`. If that statement is deleted, the target triggers into an active freeze.**

New predicate module `coordination/freeze-hold.ts` — **PREDICATE ONLY**, the same split `stage-dependency-hold.ts:34-36` states for itself:

```ts
export async function evaluateFreezeHolds(
  tx, input: { orgId: string; targetObjectIds: string[]; now?: Date }
): Promise<Map<string, FreezeHoldVerdict>>;
```
`now?: Date` is injected — precedent `watchdog.ts:77`, `stage-dependency-hold.ts:238`. The freeze path has no clock seam today (`gate-orchestrator.ts:825` hardcodes `new Date()`), which is why boundary tests would otherwise need real sleeps.

Wiring, memoised once per change per tick beside `loadInTargetSetEdges`:

```ts
let freezeHolds: Map<string, FreezeHoldVerdict> | undefined;
const loadFreezeHolds = async () =>
  (freezeHolds ??= await withTenantTx(db, orgId, tx =>
    evaluateFreezeHolds(tx, { orgId, targetObjectIds: activeWave.targets.map(t => t.targetObjectId) })));
```

and inside the `pending | triggering` branch — **after `nonTerminalTargets++`, after the backoff gate, before the stage-dependency hold, before `triggerWaveTarget`:**

```ts
if (!isRollback) {
  const frozen = (await loadFreezeHolds()).get(target.targetObjectId);
  if (frozen) { frozenTargets.push(frozen); continue; }   // ← THE REFUSAL
}
```

Five invariants, each with a named prior incident:

1. **Counted first.** `nonTerminalTargets++` happens before the `continue` — a frozen target is still in flight. Copied verbatim from the backoff gate and ADR-0028's hold.
2. **Before `triggerWaveTarget`.** No advisory trigger-claim lock is taken and no binding is re-read for a call we are not making.
3. **`!isRollback`** — `isRollback` is already in scope at `reconcile.ts:~875`. `evaluateLifecycleGate` already exempts rollbacks (`gates.ts:128-133`), but `EvaluateWaveGateContext` carries no `isRollback` at all, so **a rollback's wave targets are freeze-blocked today**. Holding a rollback pins a broken release in place for the window. This is a change that newly *permits* beyond D2's letter, so it is flagged as **OQ-4** rather than assumed — but it is the right behaviour and DESIGN §9.4 already argues for it.
4. **Before the stage-dependency hold.** A frozen target should not spend a graph read per tick on a coupling it cannot act on, and only one `continue` can fire. Consequence, stated: a target that is both frozen and dependency-held records only the freeze that tick and resumes producing `stage_dependency` verdicts the tick the freeze lifts. The two hold sets are **disjoint by construction**, which the arithmetic below depends on.
5. **After the backoff gate.** A `triggering` target has *already* been handed to its executor. So the freeze withholds the **retry**, not the original call. That is the honest boundary of what a freeze buys.

**Terminalization — the single sharpest regression risk.** Both lines change:
```ts
const heldCount = heldTargets.length + frozenTargets.length;   // disjoint by construction
if (nonTerminalTargets - heldCount > 0) { /* cursor bump */ return; }
if (heldCount > 0 && !anyFailed) return;                        // the PURE hold
await markWaveTerminal(tx, orgId, activeWave.id, anyFailed ? "failed" : "succeeded");
```
Miss the **second** line and a wave whose only remaining targets are frozen falls through to `markWaveTerminal(..., "succeeded")` — the wave completes green with a target never deployed. Silent-success masking, the class ADR-0006 exists to prevent. Miss the disjointness and `nonTerminalTargets - heldCount` goes negative, the first guard passes, and a wave with live targets terminalizes. The `anyFailed` short-circuit is inherited unchanged: a frozen target on a doomed wave stops keeping it open, is left `pending` (the truthful record), and its hold Decision stays beside the failure.

#### 1.3 The second actuator: campaign fan-out

`campaign-reconcile.ts:248` is the same `evaluateWaveGate` and gets the same `partiallyFrozen` treatment. But the campaign's *trigger* is `proposeChange` at `:406-418`, in a separate loop. Insert the same lookup inside `if (target.status === "pending")`, **after** the liveness gate (`:339-397` — a tombstoned target is dead regardless of any freeze, and terminalizing it is progress) and **before** `proposeChange`: `continue`, `allTerminal` already false.

This is **operability, not correctness** — a member change fanned out into a freeze would be held at actuator 1 anyway. But without it, a 40-target campaign entering a two-week freeze mints 40 real Changes that each compile a plan, enter `executing`, and trip the watchdog's 30-minute SLA for two weeks. Hold the fan-out and the estate stays clean. Pillar 4's deadline lock needs this exact seam regardless.

Campaign wave targets are **components**, so only org/domain/service/component-scoped freezes reach them; a region freeze correctly does not stop fan-out — it stops the member change's placement targets.

No cursor bump is needed here: the campaign loop already bumps unconditionally (verified above).

#### 1.4 The Decision shape

```ts
kind:      "freeze_admission"        // NOT "gate"
verdict:   "hold"                    // NOT "block"
subjectId: change.objectId           // ONE per change, never per target
inputContext: {
  waveId, waveIndex,
  held: [                            // sorted by targetObjectId
    { targetObjectId,
      componentObjectId, deploymentTargetObjectId,
      freezes: [ { id, scopeObjectId, name, endsAt } ] }   // sorted by id
  ]
}
reasonTree: {
  summary: "N wave target(s) held: an active freeze covers that scope — siblings proceed",
  held: [ "target X: freeze 'holiday-prod' at <scopeObjectId> until <endsAt> — <reason>" ]
}
```
Written with `insertDecisionIfChanged`, **in the same transaction as a `reconcile_cursor_at` bump** (bump 6 of 6, `reconcile_cursor_at` only — `state_entered_at` and `updated_at` untouched, per migration 0058's split).

Four properties, each defending a named prior incident:

- **`kind` distinct from `gate`.** `insertDecisionIfChanged` compares against the LATEST row of the same `(subject_id, kind)`. Sharing `gate` would make these rows and the wave gate's own rows alternate — each differing from the one before — and suppression would never fire once. That is ADR-0024's 1.44 GB/day flood rebuilt from parts.
- **`verdict: "hold"`, never `"block"`.** `latestBlockDecisionForSubject` selects on `verdict = 'block'` **alone** — no kind, no recency, no change-state gate — and `service-board.ts:~735` feeds it straight into `attention.blocked`. Nothing ever writes a clearing row. A `block` here would mark the component blocked permanently: after the freeze lifted, after the change was accepted, forever. And this writer fires on *every* release into a frozen window by design.
- **One row per CHANGE, not per target.** Per-target rows for a 4-region wave would alternate and suppression would never fire.
- **`endsAt`, never `now`.** The `gate-orchestrator.ts:834-840` trick, copied exactly: record the *boundary*, not the clock.

**Dedup proof under the 1 s tick.** Every field is a uuid, a small integer, a type-id string, a freeze name, or an ISO instant read straight off `freezes.ends_at`. None is derived from `Date.now()`, `attempt`, `last_observed_at`, or an observed weight. Both arrays are sorted by a stable key, so a reordered `activeWave.targets` cannot make an unchanged situation look new. Tick *N+1* produces a byte-identical candidate ⇒ `restatesDecision` true ⇒ zero writes. Row count is O(distinct freeze configurations over the change's life), not O(ticks): a three-week freeze over a held change is **1 row**, not 1.8 million.

**Not a CEL condition.** CEL takes `time` as a caller-supplied snapshot (`governance/evaluate.ts:58,130`), so a time-referencing condition is deterministic per invocation but flips at a wall-clock boundary with **no `inputContext` change** — the write-amplification hazard in the other direction, invisible to `restatesDecision`.

#### 1.5 How it clears

There is no scheduler — only the 1 s tick (`reconcile.ts:110`). Clearing is a **read-time predicate**: `activeFreezesInWindow` filters `starts_at <= now < ends_at`. The first tick after `endsAt`, the freeze is not in the org set; if the set is empty the module is not even called; the target falls through to `triggerWaveTarget` and fires. Median latency: **one second**. No status flip, no job, no backfill — the same ruling M22.6 already made for expiry (`BUILD_AND_TEST.md:793`).

`clearFreezeAdmissionHold` runs only on a tick where a target actually triggered and no target is held: it reads the latest `freeze_admission` row and, **only if it exists and is a `hold`**, writes one `verdict: "allow"` row of the same kind with `held: []`. A change never held pays nothing; a change that was held gets exactly one release row, which is then suppressed forever. `scp change explain` shows hold → release, which ADR-0028 does not provide today.

#### 1.6 Semantics: partial admission is a change that newly PERMITS

Stated plainly, because it is the strongest objection raised and it deserves an owner ruling rather than a quiet default.

An operator who freezes a *service* during an incident means "stop shipping this service." Today that is what happens: any wave touching it parks entirely. Afterwards, a change targeting that service plus three others ships to the three and defers the one — a **half-applied release, indefinitely**. For independent regions (the owner's literal 3-of-4 ask) that is exactly right. For *coupled* targets (a schema migration and the service that reads it) it is a broken deploy that the all-or-nothing behaviour was accidentally preventing. The defence — `depends_on` forces coupled targets into different waves — is only as strong as the edges people actually authored, and the estate has **0 `provides`/`requires` edges** and thin `depends_on` coverage.

Note the asymmetry with precedent: containment route 4 was escalated to the owner and approved on its own terms precisely because it was a change that newly **blocked**. This is its mirror image.

**Proposed resolution — one boolean, and it is the cheapest thing in this document:**

```sql
ALTER TABLE freezes ADD COLUMN atomic boolean NOT NULL DEFAULT false;
```

`atomic = false` (default) ⇒ per-target admission, the owner's D2 behaviour. `atomic = true` ⇒ any covering freeze freezes **every** target of the wave (the union is restored) — today's byte-identical behaviour, for the incident freeze where half-applied is worse than not-applied. Partial admission becomes a property of *the freeze*, decided by the person with the context, and the `partiallyFrozen` predicate becomes data-driven rather than call-site-driven.

**The default direction is OQ-1.** D2 authorises the region case; whether it authorises loosening every existing service-scoped freeze is the owner's call. If they want the conservative posture, invert the default to `atomic = true` and require regional freezes to opt in — but then flag the "component built, never installed" risk: an operator freezes `amer-prod`, does not set the flag, gets today's park-everything, and reports the feature does not work. Mitigate with a create-time default keyed on scope type (a `deployment-target`-scoped freeze defaults non-atomic) plus a loud CLI/UI affordance.

#### 1.7 When a freeze outlives the change

`freezes.ends_at` is `NOT NULL` and validated `> starts_at`, so every freeze ends — but `endsAt: "3000-01-01"` is accepted, and **there is no `DELETE` and no `PATCH` on `/api/v1/freezes`** (verified: POST `:442`, list `:496`, get `:532`, nothing else). A far-future freeze is unliftable through the API. Today that parks a wave; afterwards it holds targets indefinitely with three of four regions already shipped — a fleet split across two versions with no way to finish and no way to lift. The watchdog flags the change **once** at 30 min and is silent forever after. The only exits are `scp change cancel` / `scp change rollback`.

**`DELETE /api/v1/freezes/{id}` and `PATCH` of `endsAt` are a hard prerequisite of this milestone, not a follow-up.** Every design's "clears in one second" story is otherwise exercisable only by waiting out `endsAt` or by direct SQL. A governance object with no exit is an operability failure independent of this rework. Deleting or shortening a freeze changes the `held` array, which is exactly when a new Decision *should* be written; the dedup argument survives it unchanged.

A **bounded hold** — terminalizing a target as `frozen_out` past a horizon — was designed and is **not proposed**. It would introduce a new terminal wave-target status that must land in both `TERMINAL_WAVE_TARGET_STATUSES` and reconcile's terminal branch ("add to both or neither"), and it fails a wave because of a calendar window. If it is ever built, the determinism trick is to compare the freeze horizon against `change_waves.started_at` (a stored instant), **never** against `now` — comparing to `now` flips the verdict at a wall-clock boundary with no `inputContext` change, and would make hold-vs-refuse change its mind mid-hold.

#### 1.7a M25.2 build notes — what shipped, what did not, and the one narrowing (2026-08-23)

Recorded here rather than left in commit messages, because two of these change what a reader of §1.2
and §1.6 should expect from the code.

**D7 is narrowed by one qualifier, and the narrowing is load-bearing.** §1.2 invariant 3 exempts a
rollback from the per-target hold on `isRollback` alone. Per-target admission makes a composition
reachable that could not happen before it: the freeze holds `amer`, the siblings now **ship**, so
`apac` can fail, so the wave goes `failed`, so an `autoRollbackOnFailure` policy mints a rollback —
unattended, as `SYSTEM_ACTOR_ID` — over **all** of the original's targets, `amer` included.
`findOriginalWaveTarget` returns a never-triggered row, so `priorStateRef` is `null`, and
`client.trigger({kind: "rollback"})` fires into a scope under a declared freeze to undo a release
that never happened there. (`argocd` and `managed-iac` fail closed on the null ref; `pipeline-generic`
and `github` dispatch the workflow anyway.) D7's stated rationale — *holding a rollback pins a broken
release in place* — is about a target the broken release actually reached, so the exemption is now
qualified by `originalChangeDispatchedTarget`: `attempt > 0` **or** a non-null `executor_ref` on any
of the original change's wave targets for that object. This **refuses** more than D7's letter and
permits nothing D7 does not, and pre-M25.2 that target was freeze-blocked anyway — so it is not a
regression on behaviour that ever shipped. Flagged for the owner as an interpretation of D7, not a
new decision.

**`atomic` is read at BOTH seams, not only the gate.** §1.6 places the predicate in
`gate-orchestrator.ts`. The gate fires exactly once, on `pending -> running`, so a gate-only reader
makes `atomic` degrade silently to per-target admission for any freeze that opens after the wave
started — the second of the two defects §1 exists to fix, applied to one dimension and not the other.
`coordination/freeze-hold.ts` reads it too, and holds every target of the set when any covering freeze
is atomic. Consequence worth stating: an `atomic` freeze declared **before** the gate parks the wave
whole (no hold Decision), and one declared **mid-wave** produces a hold Decision naming it.

**A dead target is not held.** §1.2 places the change-side `continue` before `triggerWaveTarget`,
whose target-liveness gate it therefore precedes — so a tombstoned placement under a region freeze
would sit `pending` for the whole window behind a Decision saying a freeze held it, while the truth
was that the object was deleted, deferring the tombstone's own audit event for just as long.
`evaluateFreezeHolds` now checks liveness for covered targets only. This makes the change side agree
with the ordering §1.3 already argues for on the campaign side.

**`atomic`'s authoring door shipped in M25.2**, against the migration header's own note that it would
not: `CreateFreezeRequestSchema.atomic` (optional), `FreezeSchema.atomic` (required response, additive),
`scp freeze create --atomic`. D5 is retroactively permissive and `atomic` is the mitigation it was
approved on the strength of; shipping the loosening one increment before its escape hatch leaves a
window in which the escape hatch does not exist. This claims the freeze surface's codegen slot.

**§1.5's `clearFreezeAdmissionHold` shipped**; **§1.8's first two honesty defects shipped** (the
service board resolves freezes through containment over the service, its components *and their
placements*, which also deletes the third copy of the window predicate; the campaign's `blocked`
status is re-derived at read time rather than read off the Decision). **§1.8's wave-target `hold`
projection field did NOT** — it holds a codegen slot on the UI branch and the 2026-08-23 correction
below removes it from M25.2 explicitly.

**M25.1 (`DELETE` + `PATCH endsAt`) SHIPPED 2026-08-23**, out of order — M25.2 landed ahead of it,
which is what made it urgent: everything §1.7 says about a far-future freeze became true of a
*subset* of a wave's targets rather than of the whole wave, the worse shape, with `scp change
cancel` / `scp change rollback` (both of which discard the release rather than the freeze) as the
only exits. What landed, and the decisions taken to land it:

- **A SOFT lift** — `drizzle/0085` adds `lifted_at` + `lifted_by_actor_id` + `lift_reason`, not a
  hard `DELETE FROM freezes`. `gate-orchestrator.ts`'s block Decision carries
  `inputContext.freeze.id` and `recordFreezeAdmissionHold` carries
  `inputContext.held[].freezes[].id`, permanently; a hard delete dangles every one of them and
  `scp change explain` would name an id resolving to nothing (charter principle 6). The row stays
  readable by id and stays listed — **lifted is a field on the response, not an absence from it**.
  Follows `personal_access_tokens.revoked_at`, the house pattern for retiring a projection row.
- **Why not simply `ends_at = now()`**, which would have needed no migration: a freeze SCHEDULED
  for next week has `starts_at` in the future, so that assignment produces `ends_at < starts_at` —
  a row the window-order invariant refuses on both write paths — and a mistakenly-scheduled freeze
  is exactly one someone needs to retract. A lift is also durable where "ends_at is in the past" is
  clock-relative and silently reversible by a later PATCH.
- **The liveness filter is in `activeFreezesInWindow` and nowhere else** — the function §1.1(a)
  split out precisely because it is the one place that knows the window predicate. Every "is this
  freeze in force" consumer composes over it, so one `IS NULL` retires a freeze on every path at
  once, *including the release path*: reconcile's per-target loop stops seeing a hold and
  `clearFreezeAdmissionHold` writes its `allow` row on the next tick, with no lift-specific code in
  reconcile at all. A filterless census confirms `freezes-repo.ts` is the only non-test reader of
  the table.
- **`PATCH` moves `endsAt` in both directions and records which.** Shortening is a LOOSENING,
  extending a TIGHTENING; both `freeze:write`, both mandatory-reason, both writing a
  `freeze_window` Decision carrying the old *and* new instant (`audit_events` has no payload
  column) plus a high-severity audit event citing it — the `freeze.override` shape. **Shortening to
  a past instant is deliberately not re-labelled a lift**: same effect on admission, different and
  truthful record, and reversible where a lift is not. `startsAt` stays uneditable.
- **Authorization is `freeze:write` at the freeze's OWN `scopeObjectId`**, mirroring how
  `checkFreeze` authorizes overrides per freeze at that freeze's scope. `hasPermission` expands the
  checked scope upward, so an Administrator scoped to one service can lift that service's freeze
  and cannot touch the org-root freeze covering everyone. **Not `freeze:override`**, despite a lift
  reaching further than an override: requiring the Owner-only bypass permission to retract a
  declaration would mean an Administrator can create a governance object they cannot remove — the
  entrance-with-no-exit this increment exists to close — and reach is already bounded by the scope
  the permission is demanded at. *(As shipped in M25.1. Superseded in part by the 2026-08-25 ruling
  below: `freeze:override` is now demanded on top for a freeze you did not declare.)*

**OPEN DECISION — OWNER RULING NEEDED: does `freeze:write` now supersede the Owner-only
`freeze:override`?** Raised by the adversarial pass over M25.1 and *not* settled by the bullet
above, because the bullet argues the case from first principles while `drizzle/0010_governance.sql`
already states the opposite conclusion in writing: `freeze:override` and `change:emergency` are
there called "the two highest-blast-radius bypass permissions (DESIGN §10.3), **deliberately NOT
granted to Administrator by default**", and DESIGN.md §10.3 says getting past a freeze "requires an
explicit `freeze:override` permission". After M25.1 an Administrator bound at service S can
`scp freeze lift` an Owner-declared freeze at S — retracting it for *everyone* — using a permission
Administrator already holds, where before they needed an Owner to `freeze:override` and that
admitted exactly *one* change. **The strictly wider act now takes the strictly narrower
permission.** The scope bound is real and verified (an S-scoped Administrator genuinely cannot touch
the org-root freeze; `authz/resolve.ts`'s `scopeExpandCte` expands upward only), and there is no
route to self-escalation **so long as the no-escalation subset rule bounds every door that can confer
a role — which, since 2026-08-27, it does; see the note below for the second door it had to be
extended to** — so this is a deliberate widening, not a hole. But it is a widening of a gate a
migration comment calls deliberate, and reconciling the two is a governance call, not an
implementation one. Shipped as `freeze:write` pending the ruling; the three exits are:

> **The no-self-escalation half was re-founded on 2026-08-27, and the sentence above was corrected
> rather than left standing — TWICE, and the second correction is the interesting one.** It used to
> end *"— `role_binding:write` has no write API —"*, which was true when written and was load-bearing
> safety resting on an unbuilt feature. `role-model.md` §5 step 5 built it
> (`routes/role-bindings.ts`): there is now a `POST /api/v1/role-bindings`, and `role_binding:write`
> is held by Administrator, Owner and the new OrgAdmin. **The property survives on the NO-ESCALATION
> SUBSET RULE instead** (`authz/role-binding-door.ts` §2) — a binding may be written only if every
> permission the granted role carries is one the writer already holds at that scope, resolved through
> `hasPermission` per permission rather than read off the writer's role rows. Owner carries
> `freeze:override`, `change:emergency` and `campaign:deadline-override`; Administrator carries none
> of them; so Administrator granting itself Owner is refused, naming the three.
>
> **The first version of this note then closed with an exhaustiveness claim that was false, and the
> qualifier above exists so the main text no longer carries a bare unqualified assertion.** It said
> the only remaining breaker was "somebody grants Administrator `freeze:override`, a visible migration
> rather than an absence". There was a third breaker with no migration behind it: a role binding held
> by a GROUP resolves for every member (`authz/resolve.ts`'s `subject_expand` walks `member_of`), so
> binding a `freeze:override`-carrying role to a group and then joining it conferred the permission
> with no `role_bindings` row written for the joiner at all — and creating that edge needed only
> `relationship:write` at both endpoints, which **every org-root principal from Operator upward holds
> for every object in the org**. The escalation floor was four rungs below Administrator.
>
> **Addressed by `authz/role-binding-door.ts` §2a**, which applies the SAME subset rule at
> `graph/relationships-repo.ts`'s `createRelationship` — the choke point, so IaC apply and every other
> caller inherit it, with the federation-import carve-out this repo already takes at that function.
>
> **THIRD CORRECTION, SAME DAY, AND THIS ONE IS THE LESSON.** The paragraph above originally closed
> "so the accurate statement is: the subset rule now bounds BOTH doors … and what would break the
> property now is granting Administrator `freeze:override`". That was the SECOND exhaustiveness claim
> in the same note, and the REVERSED ORDERING of the same two requests disproved it: an Operator joins
> an *empty* team (201 — it is the common case and must stay one), an Owner then binds a
> `freeze:override`-carrying role to that team, and the Operator holds the permission. §2a guards the
> join; nothing guarded the grant. `role-binding-door.ts` §2b is the third door.
>
> **This note now states what is CHECKED and lists what is OPEN, and stops there.** Checked: a grant
> requires the actor to hold the role's permissions at that scope (§2); a `member_of` create requires
> the same of the edge's author (§2a); a grant whose subject is a group/team is refused when it would
> reach a principal this door will not bind directly (§2b). Open — the full list, with its reasoning
> and its measurements, is `authz/role-binding-door.ts` §8:
>
> - §2a applies the subset rule and **not** bar §1, so `relationship:write` alone chooses who is in a
>   group. That is an unauthorised delegation of authority the actor already has, never an elevation
>   of the actor.
> - **A grant to a group is blind to its members' standing.** §2b refuses on the membership's SHAPE
>   (a soft-deleted or non-bindable member) and measured that a standing-based refusal there can never
>   fire: every authority bar on the grant door is a question about the actor, the role and the scope,
>   so "could the granter have granted this to that principal directly" has the same answer for
>   everyone. Making the granter acknowledge the principals they empower is an API change and wants an
>   owner ruling.
> - `member_of` edges arriving on the federation-import path are exempt from §2a by design.
>
> Granting Administrator `freeze:override` would also break the property, and remains the loudest way
> to do it — a migration rather than an absence.

  a. **Accept it** — amend `0010`'s comment and DESIGN §10.3 to say that `freeze:override` gates
     *bypassing* a standing freeze and `freeze:write` gates *authoring and retracting* one.
  b. **`freeze:override` to loosen a freeze you did not declare** (`created_by_actor_id`), keeping
     `freeze:write` for your own. Preserves both properties — no entrance without an exit, and no
     Administrator undoing an Owner. Must cover PATCH-shortening too, or it is bypassed in one call.
  c. **`freeze:override` only while the freeze is actually holding something** — read-time,
     racy, and it makes the permission needed depend on fleet state; recorded for completeness.

**RULED 2026-08-25 (owner decision D1, option a-ii) — EXIT (b), and it is built (M25.9).**
`freeze:override` is required to **lift or shorten a freeze you did not declare**, compared on
`freezes.created_by_actor_id` against the acting subject; retracting or shortening **your own**
freeze stays `freeze:write`. Added, never substituted: `freeze:write` at the freeze's own
`scopeObjectId` is still demanded first on both verbs, and the override is demanded **at that same
scope**, so an Owner bound at one service still cannot reach the org-root freeze. The ruling covers
`PATCH` **shortening** — ending a protection early is the same act as retracting it, and gating only
the `DELETE` would leave the retraction one `PATCH` away, exit (b)'s own caveat. **Extending**
`endsAt` adds protection rather than removing it and stays `freeze:write`, as does a `PATCH` whose
direction is `unchanged`. The direction is read from `updateFreezeWindow`'s **locked** result, not
from the route's earlier unlocked read: under READ COMMITTED a stale read can call a shortening an
extension and admit it. `routes/governance.ts`'s lift docblock carries the full reasoning;
`drizzle/0010_governance.sql`'s comment and DESIGN §10.3 now agree with the code — **and the edits
that make that sentence true were made rather than assumed.** DESIGN §10.3's *retraction* bullet ("A
freeze can be retracted") stated the rule flatly as `freeze:write` at the freeze's own scope with no
mention of the override; it now carries the override clause, the actor comparison and the
shorten/extend split. BUILD_AND_TEST.md §8's **M25.1 definition of done** carried the identical
superseded wording and now carries the same clause, labelled in place as a deliberate post-ship
correction of a shipped milestone's DoD. §10.3's *Override* bullet already agreed and is untouched;
`drizzle/0010`'s comment needs no edit, since all it asserts is that the override is not granted to
Administrator by default — which is exactly what the new bar relies on. *(Caught by the adversarial
pass: the first cut of this work asserted the agreement in two code comments while both doc
sentences still stated the old rule.)*

**Post-review corrections (same day, adversarial pass):**

- **Both migrations renumbered `0077`/`0078` -> `0084`/`0085`, with new `when`s.** `main` gained
  seven migrations while this branch was open, topping out at `0083_governance_move_rungs`
  (`when` 1788141000000) — *above* `0077_freeze_atomic`'s authored `when` of 1788140000000 and
  below `0078_freeze_lift`'s 1788146000000. Merging as authored would have SPLIT the pair on every
  instance already carrying 0083: drizzle gates on `when` alone and skips silently, so `lifted_at`
  would have applied and `atomic` never, and `freezeResponse` reads both — every freeze read broken
  in production, invisible to CI, which migrates from empty. `db/journal-ordering.test.ts` is the
  guard that would have caught it at merge; the renumber is what makes the merge clean.
- **The window-edit direction has a third case, `unchanged`.** The comparison shipped as
  `endsAt < before.endsAt ? "shortened" : "extended"`, which folds equality into the extension arm:
  re-saving a form without touching the field wrote a hash-chained `freeze.window.extended` event
  and a Decision asserting an extension with `from === to`. `loosening` stays false.
- **Both write verbs read their row `FOR UPDATE`.** Each is a read-modify-write whose *read* decides
  what goes into a permanent record — `direction` and the Decision's `endsAt.from` for the PATCH,
  the "already lifted at …" instant for a refused second lift. Unlocked under READ COMMITTED, two
  concurrent PATCHes let the second compute both against a snapshot that was never live: with the
  original window at an hour, a first edit to one minute and a second to ten minutes, the second was
  audited as a *shortening* of a window it actually extended. Pinned by a deterministic two-
  transaction test at the repo seam (the `stampBoundaryBundleChecksum` precedent).

This unblocks the freeze-authoring UI session, whose gate M25.1 was.

#### 1.8 The aggregate-status honesty problem

While held:

| | value | why |
|---|---|---|
| frozen wave target `status` | `pending` | never handed to an executor — the truthful record |
| `executorRef` / `attempt` | `null` / `0` | proof the actuator fired |
| sibling targets | `triggered → observing → succeeded` | **3 of 4 regions ship — the owner's ask** |
| `change_waves.status` | `running` | the gate allowed; the wave is genuinely mid-flight |
| `changes.state` | `executing`, `reconcile_blocked_at IS NULL` | not parked; re-evaluated every tick |
| next wave | never starts | the wave never terminalizes |
| service board | `releasing` | honest — it *is* releasing |

**The change does not complete.** This is the distinction to put in front of an operator: the design delivers "deploy to 3 of 4 targets", not "the release is done".

Two honesty defects must be fixed **in the same increment** or the lever works and the signal is missing — the exact inverse of the postmortem that cost a previous proposal its approval:

- **`service-board.ts:~620` builds `activeFreezeByScope` as a `Map<scopeObjectId, FreezeRow>` looked up with `component.id` / `service.id` — exact-set membership, not containment (verified).** A domain-, org-root-, or **deployment-target**-scoped freeze appears on **no board row at all**. Freeze `amer-prod` and every affected component reports `activeFreeze: null`. Must resolve through `containmentScopeIds`.
- **`ChangeWaveTarget.status` cannot distinguish "frozen" from "queued".** ADR-0028 accepted the identical limitation. The fix is a **derived read-model field** — `hold: { kind: "freeze" | "stage_dependency", until?: string, decisionId: string }` — computed from the standing Decision, **not** a status column (per M22.6). Added as an optional response property; never a change to `status`'s required-ness.
- **`campaign_waves.status` no longer goes `blocked` on a partial freeze** (that status comes from the gate's `block` verdict), so `getCampaignStatus` loses its freeze signal. `campaign-status.ts` must learn to read the campaign-side `freeze_admission` Decision, or a frozen campaign reads as ordinarily `running`.

---

### 2. Above-org freeze tier + federation reach (D1)

#### 2.1 The instance-scoped tier

`containmentChain` is org-rooted and org-filtered on every join, so it structurally cannot reach above org. The above-org tier therefore comes from its own instance-scoped table, mirroring the ADR-0016 precedent.

**Grounding correction:** the precedent table is **`scan_requirement_floors`** (`drizzle/0029_scan_requirement_floors.sql`), not `instance_scan_floors`; it is not in `db/schema.ts` at all and is accessed by raw SQL. There are now four tables in that family (0029, 0035, 0036, 0074).

**New table `instance_freezes`, migration `0077_instance_freezes.sql`** (re-derive `_journal.json` `idx`/`when` on rebase):

```sql
CREATE TABLE IF NOT EXISTS "instance_freezes" (
  "key"               text NOT NULL,                    -- operator slug; the PUT/DELETE path segment
  "origin"            text NOT NULL DEFAULT 'local',    -- 'local' | 'federated' (no writer — see 2.3)
  "tier"              text NOT NULL DEFAULT 'platform', -- 'platform' | 'trust_domain'
  "name"              text,
  "starts_at"         timestamptz NOT NULL,
  "ends_at"           timestamptz NOT NULL,
  "reason"            text NOT NULL,
  "match_environment" text,                             -- NULL = every environment
  "match_region"      text,                             -- NULL = every region in that environment
  "atomic"            boolean NOT NULL DEFAULT false,   -- §1.6, same semantics
  "overridable"       boolean NOT NULL DEFAULT false,   -- §2.2
  "note"              text,
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "instance_freezes_pk"        PRIMARY KEY ("key","origin"),
  CONSTRAINT "instance_freezes_tier_ck"   CHECK ("tier"   IN ('platform','trust_domain')),
  CONSTRAINT "instance_freezes_origin_ck" CHECK ("origin" IN ('local','federated')),
  CONSTRAINT "instance_freezes_window_ck" CHECK ("ends_at" > "starts_at"),
  -- a region without an environment is a coordinate with no origin
  CONSTRAINT "instance_freezes_match_ck"  CHECK ("match_region" IS NULL OR "match_environment" IS NOT NULL)
);
CREATE INDEX instance_freezes_window ON instance_freezes (starts_at, ends_at);

GRANT SELECT ON instance_freezes TO scp_app;
REVOKE INSERT, UPDATE, DELETE ON instance_freezes FROM scp_app;
ALTER TABLE instance_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_freezes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON instance_freezes FOR SELECT USING (true);

-- THE HALF 0029/0035/0036/0074 ALL FORGOT UNTIL 0076. Without BOTH of these there is no database
-- principal that can write this table on a real deployment — and the suite stays green because
-- Testcontainers connects as a superuser, which bypasses grants and RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON instance_freezes TO scp_operator;
CREATE POLICY operator_write ON instance_freezes FOR ALL TO scp_operator USING (true) WITH CHECK (true);
```

**No `org_id`** — the documented exception to DESIGN §4.2, quoted from ADR-0033 §7a: an operator statement about the *deployment*, not tenant data. `USING (true)` leaks nothing because the table holds no per-tenant rows, and tenant read is required by charter principle 6: a blocked tenant must be able to read *why*.

**Scope: stage coordinate, not object id.** A platform freeze cannot carry a `scopeObjectId` — object ids are per-org rows and `containmentChain` is org-filtered, so a single id would name at most one tenant's object. It addresses targets by the coordinate SCP already defines: `properties.environment` (+ optional `properties.region`), read never inferred. `match_environment IS NULL` = deployment-wide. **This is not D2's rejected two-axis model** — both fields together are the *one* coordinate containment route 4 already gives org-tier freezes, expressed as a match because ids do not exist across orgs. There is no domain axis at this tier.

Reader: a new sibling of `containmentScopeIds` in `graph/containment.ts` —
```ts
export async function containmentStageCoordinates(tx, orgId, targetObjectIds)
  : Promise<Array<{ environment: string; region: string }>>
```
walking the same route-4 fragment, and called **only when at least one active instance freeze carries a non-null `match_environment`**.

**Merge semantics: union (OR), not MIN.** A freeze has no numeric dimension; its value is a predicate. The analogue of most-restrictive-wins for a predicate is disjunction:
```
frozen(target,t) ≡ ∃f ∈ instanceFreezes: covers(f,target,t)  ∨  ∃f ∈ orgFreezes: scope ∈ chain(target) ∧ window
```
Three consequences a reviewer will guess wrong: (i) when the org declares nothing, the platform freeze still blocks — the empty org set contributes `false`; (ii) **nothing an org can author subtracts from the union**, so the floor property does not live in the merge — it lives entirely in the override rule; (iii) the table ships empty and empty is byte-identical to today.

#### 2.2 Who can override a platform freeze

`hasPermission` builds `scopeExpandCte(orgId, scopeObjectId)` and joins `role_bindings` filtered `rb.org_id = orgId` — **every id in that query is org-scoped**. The three natural fakes are all wrong: `scopeObjectId = orgRootId` lets any org Administrator lift a platform freeze (the floor is gone, and this is the *natural* implementation); a synthetic sentinel makes the freeze un-overridable **by accident**, holding until somebody "fixes" it; an operator token on the request is structurally impossible for the case that matters, because wave-boundary gates run under `SYSTEM_ACTOR_ID` with no HTTP request in scope.

**Decision: not overridable by any tenant role by default.** `checkFreeze` gains a tier-aware first pass ahead of the existing org loop:

```ts
for (const f of instanceActive) {
  if (!f.overridable) return { blocked: { freeze: asFreezeView(f), reason:
      `active platform freeze '${f.key}' (${f.reason}) — declared by this deployment's operator; `
    + `no tenant role can override it. Lift or shorten via DELETE/PUT /v1/instance/freezes/${f.key}` },
    overrides: null };
  // overridable === true: the operator has ADMITTED tenant override for THIS freeze.
  // Required authority: `freeze:override` at the ORG ROOT + the same mandatory non-empty reason.
}
// then the EXISTING org-tier loop, unchanged — CRITICAL #2 intact
```

`overridable` is a column rather than a sibling admissions table because admission and freeze are one-to-one. Both authorities remain independent and both are required: the **operator** sets the bit (tenant-unwritable, two barriers), the **tenant** must hold `freeze:override` at its org root and supply a reason. Default `false` — a loosening never defaults on.

**`freeze:write` is not added at this tier and no role, including Owner, can author an instance freeze** — verbatim the `instance-scan-floors.ts` posture. The `Permission` union is unchanged.

**Honest limit:** because `evaluateWaveGate` passes no `overrideFreeze`, an admitted-overridable platform freeze is exercisable only on the lifecycle `accept` edge. Pre-existing, not created here, but it means `overridable: true` does not unblock a change already `executing`.

#### 2.2a SHIPPED — M25.3, 2026-08-23 (`drizzle/0086`, [ADR-0040](../adr/0040-platform-tier-freezes.md))

§2.1 and §2.2 are built. What landed matches D1's substance; **three things are expressed differently from the sketch above, each argued in ADR-0040 §7 and flagged for owner confirmation**:

1. **An unset `environment` is NOT deployment-wide.** Shipped as an explicit `match_all_environments` boolean, mutually exclusive with `match_environment` under a DB CHECK and a request-schema refinement; a body carrying neither form is a 400. The deployment-wide freeze stops every release for every tenant, and reaching it by *omitting* a field means a dropped empty string or a typo'd key authors maximum blast radius with no error. The widest tightening gets the same "never by default" treatment a loosening gets.
2. **No `origin` column.** §2.3's own finding is that a platform freeze cannot ride the journal *at all*, so `origin: 'federated'` here would be a value no writer can ever produce — a field that lies, which is worse than an absent one.
3. **No `tier` column, so no `trust_domain` literal.** 0029 needs `tier` because two above-org rungs contribute separate per-severity MINs; a freeze merges by OR and a `trust_domain` freeze would behave identically to a `platform` one in every code path. **Consequence for the §10.3 replacement drafted below: as shipped the ladder is SIX tiers, not seven** — platform → org → containment domain → service → component → deployment target. That draft is therefore *not applied*; correcting it is an owner call.

Other shipped facts worth carrying forward:

* **`§2.4`'s single reader is `freezesByTarget`, not a new `activeFreezesFor`.** Folding the instance tier into the existing per-target resolver gave `checkFreeze`, `freeze-hold.ts`, the `atomic` union and the service board the platform tier with no per-tier plumbing — so **D5 per-target admission is not tier-specific**, which is asserted rather than assumed. `activeFreezesForScopes` was therefore *kept*, not deleted: it is no longer on the resolution path (`freezesByTarget` is), and it is still the subject of the set-equality test M25.2 pinned. Deleting it is a separate cleanup with its own test consequence.
* **The tier is a discriminated union (`EffectiveFreeze`), and that is the enforcement mechanism.** TypeScript refuses to compile a consumer that reads `scopeObjectId` without asking which tier it holds — which is exactly the field §2.2's three fakes are about.
* **`checkFreeze`'s tier branch is INSIDE the universal quantifier**, not a pass ahead of it as sketched. A separate platform pass would have re-created the `active[0]` shape that loop exists to make inexpressible.
* **The window predicate is still known in one place** (`freezeWindowCovers`, factored out of `activeFreezesInWindow` and consumed by both tiers).
* **`instance_freezes.id` is a real uuid**, because it travels into `ServiceBoardFreezeSchema.id` (published as `z.string().uuid()`). A synthetic `platform:<key>` would have forced an oasdiff response change; with a uuid the service board shows a platform freeze with no schema change at all.
* **Soft lift, and a retraction is final.** `DELETE /v1/instance/freezes/{key}` sets `lifted_at`/`lift_reason` (0085's ruling one tier up — a block Decision cites the id forever); a re-`PUT` of a lifted key is refused 409.
* **`pnpm gen` was purely additive**: two new paths, zero changed paths, zero changed or removed schemas.
* **Owed and not done here** (ADR-0040's closing section): the DESIGN.md §10.3/§10.1 replacements below, the charter "Freeze Scope" amendment (needs owner sign-off), and the BUILD_AND_TEST M16.2 correction (depends on D6/M25.7).

#### 2.3 Federation — **THIS HALF IS AN ASSUMPTION, NOT AN OWNER DECISION**

D1's option was presented as a ladder ("above-org **too**"), so sync-down was treated as in scope. Two findings change the shape of the answer and must be surfaced before anything here is built.

**Finding 1 — a platform freeze structurally cannot ride the sync journal.** `SyncJournalEntrySchema` carries `orgId: z.string().uuid()` as a **required** field; `appendJournalEntry` takes `input.orgId`; the hash chain is keyed `(orgId, originDomainId)` under an advisory lock on that pair; `exportSyncBundle` runs inside `withTenantTx(db, orgId, …)`. Every layer is org-scoped. A platform freeze has no org and no non-arbitrary way to acquire one. Re-expressing it as N per-org entries would require the commander to enumerate the outpost's tenants (which it does not know) and would turn an instance-scoped fact back into tenant data.
**Recommendation: the platform tier does not federate.** It is declared per instance by that instance's operator — the exact posture ADR-0016 already recorded, where `origin: 'federated'` was designed and **deliberately left with no writer**. Carry the `origin` column for the same forward-compatibility reason and say in the header, in those words, that it has no writer — or it becomes a field that lies. For multi-site operators this is deployment tooling: the same Ansible/Helm path that distributes `SCP_OPERATOR_TOKEN` can `PUT` the same freeze to each instance.

**Finding 2 — a new `JournalEntryKind` is a fail-closed cliff, twice.** `POST /federation/imports` validates against `SyncBundleSchema` whose `entryKind` is a nine-literal `z.enum`; an unknown kind fails Zod **at the route boundary → 400, whole bundle refused**, every unrelated entry lost. `import-repo.ts`'s tolerant `default: return;` is never reached. And `entryKind`'s enum also appears in the **200 response** of `POST /federation/exports`, so widening it is an oasdiff `response-property-one-of-added` break — a price this repo already paid once and worked around with a permissive response view.

**Recommendation for the org tier, if the owner confirms sync-down:** a commander-declared org-tier freeze federates as a **graph object** on the existing `object_upsert`, exactly as ADR-0022 solved the identical problem for outpost config. Register a builtin `freeze` object type in the migration (`object_types` never journals — it is a migration seed on both sides). The commander authors it through `POST /v1/freezes` with `federate: true`, gated on **`federation:write`** rather than `freeze:write` (declaring a freeze that binds another security domain is categorically different from describing your own estate). Zero new journal kind, zero enum widening, zero oasdiff exposure, zero new importer branch.
**And the precedence rule comes free:** `objects-repo.ts`'s single-writer read-only-replica guard already refuses any local write to a row with a foreign `origin_domain_id`, proven end-to-end by `federation/outpost-config-sync.integration.test.ts` case 2. An outpost cannot lift a commander freeze; its remedy is `freeze:override` at the replica's own scope — per-change, reasoned, audited — not deletion. An **outpost-declared** freeze should be authored `domainLocal: true` (ADR-0031: locality is declared, never inferred), which `scope-filter.ts` withholds in both directions even under `full` scope.

**Three shipped artefacts assert the opposite of this and would need rewriting:** `apps/web/e2e/service-board-honesty.spec.ts` (pins `"freezes never ride the sync journal"`), `apps/web/src/routes/outpost-configuration.tsx` (`"freezes are TESTED never to ride the journal"`), and `services.ts`'s `unknownFields` doc (a null `activeFreeze` means "no freeze declared in THIS domain"). That is a real cost and a reason to keep §2.3 out of M25's first increment.

##### As BUILT (M25.7, 2026-08-24) — the owner confirmed **(b)**; [ADR-0043](../adr/0043-federated-org-tier-freezes.md) records it

Built as recommended above — graph object on the existing `object_upsert`, projection rebuilt on import, `federate` defaulting **false**, gated on `federation:write` **in addition to** `freeze:write`, no new `JournalEntryKind`, no oasdiff break, platform tier untouched. Four things this section did not anticipate:

* **THE CENSUS WAS WIDER THAN THREE.** Run filterless (`grep -rna`), the claim was asserted at **nine** source sites, plus four this section and every prior handoff missed: `packages/schemas/src/services.ts` in **three** places (including the *published* `unknownFields` contract), `coordination/service-board.ts`'s own **file header**, `service-board-staleness.integration.test.ts`, `service-board-federation.integration.test.ts`, `apps/web/src/routes/service-board.tsx` — including a **rendered operator-facing tooltip** saying freezes "are never replicated between federated instances" — and `apps/web/src/routes/outpost-configuration.test.tsx`, which *pinned the stale copy by string*. Standing lesson: a census assembled from a prior handoff's list inherits that list's blind spots.
* **`freeze` needed the governance-managed-type treatment, and this section did not name it.** A `freeze` object is the wire form of a *blocking* freeze at every downstream instance, so any door taking a caller-supplied `typeId` could otherwise mint one on plain `object:write` — a wider blast radius than the `policy` hole that set exists for. Adding the id to `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` was **necessary and not sufficient** — this bullet first said it "closes all five doors at once", which was the third copy of a claim that is false. It closes **two**. At the other three (`POST /plans`+apply, `/federation/overlays`, `/federation/hand-fill`) membership means *demand `policy:write` instead of `object:write`*, a permission **upgrade** rather than a refusal, and `policy:write` is neither of the permissions a freeze requires: measured, an actor holding it at a narrow domain with `freeze:write`/`federation:write` nowhere minted a federating freeze through all three, with the declared `scopeObjectId` bound to no authority and no `freezes` row locally — unliftable at both ends. Those three now refuse the type outright through a second set, `PROJECTION_BOUND_OBJECT_TYPE_IDS` ([ADR-0043](../adr/0043-federated-org-tier-freezes.md) §4). And `governance-managed-write-doors.integration.test.ts`'s layer-3 source scan **went red on the new write site by itself** — the census mechanism working, for the second time.
* **The replica guard had to reach the PROJECTION ROW, not just the object.** `objects-repo.ts`'s single-writer guard protects the wire form; `freezes.lifted_at` — the column `activeFreezesInWindow` actually filters on — would have stayed locally writable, so an outpost could have lifted a commander freeze without ever touching the object. The check went into `freezes-repo.ts`'s **`lockFreezeRow`**, the read half *both* write verbs already share, because a guard on the lift path alone leaves `PATCH endsAt` as an unguarded route to the same retraction.
* **A lift has to propagate downstream.** Both write routes re-snapshot the object, or a commander declares a freeze at an outpost and can never retract it there — M25.1's "entrance with no exit" rebuilt one boundary over, and worse, because the guard above deliberately denies the outpost a local exit.

#### 2.4 One reader, three sources

Three storage shapes now answer one question — the "divergent copies of one idea" hazard that already cost a service-scoped freeze failing open.

```ts
// governance/freezes-repo.ts — REPLACES activeFreezesForScopes as the only entry point
export async function activeFreezesFor(
  tx, orgId, scopeObjectIds: string[],
  stageCoords: Array<{ environment: string; region: string }>, at: Date
): Promise<EffectiveFreeze[]>   // { tier: 'platform'|'trust_domain'|'org', …, atomic, overridable }
```
**`activeFreezesForScopes` is deleted, not left beside it.** Its own docblock warns that any id the caller omits is a freeze that silently does not block; leaving it exported leaves the trap armed for the next caller.

---

### 3. Campaign recipes — the coordination lever (D3)

#### 3.1 What "1-click" can and cannot mean

Under coordination-not-execution, **SCP never writes the python3 patch**. "1-click" means: *one authored intent, fanned across N components, wave-ordered, gated, with per-component binding resolution, adoption tracking, explainability and rollback.* It does not mean SCP knows how to port Python. If a tenant has no migration workflow, a campaign has nothing to trigger and the honest outcome is a refusal, not a managed migration.

What it **is** is unblocked by a single fact: `TriggerIntent.parameters` exists on the interface, every adapter already reads it with its own key vocabulary, and `reconcile.ts`'s trigger call has never populated it.

#### 3.2 The recipe

**A document at `campaign.properties.recipe`. No new object type, no new table, no migration to the property schema.**

Rejected alternatives, with the measured reason:
- **A new `migration-recipe` object type.** `import-repo.ts`'s `object_upsert` branch resolves `typeId` with no try/catch, and `createObject` 404s on an unregistered type — so one such object aborts a peer's **entire signed bundle**. A runtime custom type federates to nobody. This also rules out *tightening* the campaign property schema, for the same wedge reason on an older receiver.
- **A `campaign_recipes` projection table.** The `freezes` precedent is real and earns its table on window semantics queried on a hot gate path; a recipe has no window, no lifecycle, one read per trigger. But the decisive argument is reach: ADR-0022 clause 2 — config that must cross a boundary rides `object_upsert` as a graph object. Nothing table-shaped travels.
  - **PREMISE CORRECTED (M25.7, 2026-08-24); the conclusion is unchanged and is now better supported.** This bullet used to end *"`freezes` gets away with it precisely because freezes do not federate today"* — which §2.3's own owner decision **D6** made false inside this same document: an org-tier freeze **does** federate ([ADR-0043](../adr/0043-federated-org-tier-freezes.md)). What happened is the opposite of getting away with it. The moment a freeze had to cross a boundary it had to acquire a **graph object** to cross on (drizzle/0089), and the table survived only for the part that does *not* cross — the window predicate `activeFreezesInWindow` evaluates on a hot gate path. So `freezes` is now a worked example of the ADR-0022 rule rather than an exception to it: **object for reach, projection row for enforcement.** A recipe has no enforcement-side reader to earn the second half — one read per trigger, no window, no lifecycle — so it stays properties on the `campaign` object, which is what this bullet already concluded on the two independent grounds above.

```ts
// packages/schemas/src/campaigns.ts — z.strictObject throughout
CampaignRecipeSchema = {
  version: 1,
  trigger: {
    kind: "sync" | "workflow_dispatch" | "custom",   // TriggerIntent["kind"] minus "rollback"
    parameters: Record<string, JsonValue>            // VERBATIM -> TriggerIntent.parameters
  },
  adoption: AdoptionEvidenceSchema,                  // §3.4
  guidance?: { title, summary, docsUrl }             // display-only; NEVER fetched (principle 5)
}
```

**Strict at the author's door, open in the registry** — the 0043/0075 rule. `assertValidCampaignRecipe` is installed at `graph/objects-repo.ts`'s create/update **choke point**, not at the campaign route: `component-declaration-guard.ts:29-40` records that installing the equivalent guard at one typed route left three other doors (IaC apply, federation hand-fill, the overlay route) reaching `createObject` with free-form properties. Same census, same answer.

**Reuse:** `CreateCampaignRequestSchema.recipeFrom?: string` (a campaign idOrUrn) resolved and **inlined at create time**. Reuse without a new type, and the running campaign's recipe is immutable by value — editing the template later cannot retroactively re-narrate what a past campaign did (the `control_runs.plugin_module` rule).

**No secrets, ever.** `objects.properties` is readable at `object:read`. The strict schema refuses `secret*`/`token*`/`password*` keys with a 400 saying why. Secrets stay in `executor_bindings.secret_refs`.

#### 3.3 What SCP hands the executor

**Parameters pass through verbatim. SCP does not translate between provider vocabularies** — inventing a normalisation layer means re-rendering a declaration SCP does not fully model. The per-module key table ships as documentation; the author picks their keys.

The exact diff at `reconcile.ts:~1872`:
```ts
ref = await client.trigger({
  kind: recipe ? recipe.trigger.kind : claim.kind,   // rollback ALWAYS wins (isRollback overrides)
  targetRef: claim.externalRef ?? targetObjectId,
  priorStateRef: claim.priorStateRef,
  idempotencyKey,
  ...(recipeParameters ? { parameters: recipeParameters } : {})   // absent ⇒ byte-identical to today
});
```
`recipe.trigger.kind` may not be `"rollback"`, and `isRollback` overrides it unconditionally — otherwise a campaign author could turn a restore into a forward change.

**Per-component variance is already solved and must not be re-solved.** The python3 recipe omits `workflowId`; `github`/`gitea` resolve `intent.parameters?.workflowId ?? config.defaultWorkflowId`, and the 47 bindings already carry their own. The recipe supplies the *migration parameters*; the *which-workflow* answer stays where it lives. A genuine outlier overrides on its binding, not in a 47-entry map on the campaign.

Each of the 47 components then gets, with zero further authoring: its own member Change with one target; wave ordering from the release topology; its own full governance pass (freezes, policies, controls, approvals) at both the campaign wave boundary and the member change's own accept edge; its own binding resolution; its own `idempotencyKey`; its own ADR-0006 `no_executor` fail-closed refusal; its own adoption evidence and Decision; its own rollback path.

**Capability refusal (actuator A2):** if `describeCapabilities().triggerKinds` omits the recipe's kind, `blockWaveTarget(status: "recipe_unsupported")` — block Decision with `decision_id`, hash-chained audit event, target terminal, wave failed. **`trigger()` is never called.**

#### 3.4 Adoption tracking

**The honest answer first: SCP cannot know in general whether a component has been migrated.** There is no per-component standing state store; `observed_state` is per-wave-target and `control_runs` is per-change. The only standing, component-scoped, independently-refreshed fact table is `component_dependencies`. So a recipe must **name its own evidence source**, and where it cannot, the verdict is `unknown` — **never `adopted`**. That is `boundary-segment.ts`'s honesty rule R3 ("silence is never a pass") applied unchanged.

```ts
AdoptionEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("delivered") }),
  z.strictObject({ kind: z.literal("dependency"), ecosystem, coordinate, minVersion }),
  z.strictObject({ kind: z.literal("declared"), key, value }),
  z.strictObject({ kind: z.literal("control"), controlObjectId })
]);
```

1. **`delivered`** — this campaign's own wave target is `succeeded`. Zero machinery. The verdict string is `"delivered"`, never `"migrated"`: it means SCP triggered the tenant's pipeline and the change was accepted, not that the code is on python3.
2. **`dependency`** — the one that actually works for python2→python3. `component_dependencies` carries `declared_version` verbatim and a parsed `resolved_version` per `(component, line, manifest_path)`, joined to `dependency_lines` for `(ecosystem, coordinate)`. It is refreshed by **re-reading the repo**: `inventory-ingestion-loop.ts` fires on `isAcceptedChangeEvent` and re-ingests manifests at the new ref, so after the migration workflow's push lands, the inventory reads `FROM python:3.12-slim` from the actual file. `adopted` iff no live row for this `(ecosystem, coordinate)` resolves below `minVersion`; `unknown` iff the component has **zero** inventory rows (never ingested ≠ nothing declared).
3. **`declared`** — a `component.properties.adoption.declarations` bag on the M22.5 / ADR-0033 §6 pattern, strict at the door, capped keys, re-parsed through the same schema the write door uses, pinned verbatim into the Decision's `inputContext`. **Never `labels`** (tenant-writable, unnamespaced, already a live evasion path). Note the asymmetry that makes this safer than its precedent: a declaration here buys exit from *this campaign's* deadline lock, whose entire radius is that campaign's own changes — **the blast radius of the lie is the liar**.
4. **`control`** — latest `control_runs` row for `(member change, controlObjectId)` is `pass`. Strongest kind; `plugin_module` is stamped at insert so re-pointing a binding cannot retroactively relabel a historical pass.

**The predicate:** `coordination/campaign-adoption.ts::evaluateCampaignAdoption(tx, orgId, campaignObjectId, targetObjectId) → { verdict, evidence, inputContext }`. Read-time, no stored status column, no scheduler.

**Consumers (the census, because this is where the "incomplete call-site" class hides):**

| # | Consumer | Effect |
|---|---|---|
| 1 | `campaign-reconcile.ts`, per-target loop before `proposeChange` | `adopted` ⇒ terminalize `succeeded` with **no member change proposed**, plus one deduped Decision. Makes a campaign idempotent against a component that migrated on its own. |
| 2 | `GET /campaigns/{id}/adoption` (new, purely additive) | per-target verdict + evidence |
| 3 | `GET /campaigns/{id}/explain` | adoption alongside plan + Decisions |
| 4 | **Pillar 4's deadline lock** | reads this function and nothing else — ONE resolution core |
| 5 | `scp campaign adoption <id>` (CLI via generated SDK) | |
| 6 | apps/web campaign page | |

Consumer 1 runs every tick, so its `inputContext` carries **the evidence, never the clock** — declared value, resolved version, control run id — with **sorted** arrays, through `insertDecisionIfChanged`. `campaign-decision-write-amplification.integration.test.ts` is extended, not paralleled.

#### 3.5 Reaching an outpost

**Path 1 — works today, needs nothing on the wire. Build this.** `importPromotionBundle` re-proposes the change **locally** at the receiver with `properties: { ...promotedProperties, importedControlOutcomes }`, stripping exactly two keys (`requires`, `stageDependencies`). A recipe on `change.properties` arrives intact, and the outpost's own reconcile resolves the **outpost's** binding and triggers through its own local gates. Commander-declared intent, outpost-local execution, single-writer clean. It needs a **regression test** pinning the strip list — a future third key would silently drop the recipe and the campaign would go green having triggered a bare sync.

**Path 2 — already half-true, deliberately inert. Do not "fix" it.** The campaign object federates (`object_upsert` is type-agnostic) and lands at the outpost as a real local row with a foreign `origin_domain_id`, recipe and all. `listActiveCampaignObjectIds` filters it out of the candidate set. That filter is **not an oversight** — without it the outpost compiles a plan for another domain's campaign and proposes member Changes from it (a single-writer violation with real side effects, pinned by `foreign-origin-campaign.integration.test.ts`). The recipe already reaches the outpost as data; what is missing is a local actuator, not a channel.

**Path 3 — commander-declares / outpost-adopts. Named, scoped out, flagged.** An outpost minting its **own local** campaign from a replicated recipe is a new federation semantic — an *instruction*, not a *replica*. It is the **same shape as D1's freeze sync-down assumption**, and the two should be decided in one owner ruling rather than invented twice.

#### 3.6 Relationship to dependency subscriptions (M21)

**A subscription-driven bump must not become a campaign.** Three verified blockers: (i) `plan-compiler.ts` does `new Set(input.targets)`, so campaign targets are deduped by object id, but a bump's unit of work is `(component, manifest_path, coordinate, toVersion)` — ADR-0032 §8a records that collapsing the first two was a **shipped bug** in which the second subscribed component silently received nothing, forever; (ii) `bump-dispatch.ts:788` mints `changeObjectId` *before* the change exists because that id is simultaneously the authorship key, the plugin `idempotencyKey`, and the branch name — reconciling this with campaign fan-out would put a tenant-reachable id on the merge path; (iii) cardinality — bumps are an unbounded stream, and one campaign object per bump means a graph write plus an Ed25519 signature each, in a `LIMIT 25` loop that would starve real campaigns.

**The productive direction is the reverse and it is an owner question (OQ-5).** A campaign whose recipe is dependency-shaped could **delegate to the already-built bump actuator**, making "bump `FROM python:2.7` → `python:3.12` across 47 Dockerfiles" genuinely one click with no new authoring code. But it sits exactly on D3's edge: the M21 amendment grants repo-write for *dependency bumps*, and a `FROM` line is a dependency declaration, while a python2→python3 migration in general is code. Whether a campaign is a new initiator needing its own sign-off is the owner's call. **Flag it; ship M25 without it.**

What M25 *should* do with no decision needed: make the `dependency` adoption kind read the inventory the subscription feature already populates — joining the two features on the **read** side only.

---

### 4. Deadline-triggered campaign lock (D4)

D4's radius is **the campaign's own targets**. An unmigrated component stops receiving *this campaign's* changes; unrelated releases including security fixes keep flowing. It is **not** a freeze on the component, and it must not be implemented as one.

#### 4.1 Storage

`campaign.properties.deadline` — no new table, no stored status, no migration beyond a property-schema restatement:

```jsonc
"deadline": {
  "at": "2026-12-31T23:59:59.000Z",
  "adoptionSignal": "campaign_target_succeeded",   // | "dependency" | "declared" | "control"
  "overrides": [ { "targetObjectId": "…", "reason": "…", "actorId": "…", "at": "…", "until": "…"? } ]
}
```
This does **not** violate "campaign status is derived, never stored": the deadline is *configuration* (an input), not *status* (an output). Nothing ever writes "locked" anywhere. It survives `campaign-reconcile.ts`'s own properties rewrite, which spreads `...properties`. The property-schema fragment is **typed but open** (`at` gets `format: date-time`; `adoptionSignal` is `"type":"string"`, **not** an enum) for the federation-wedge reason; wire-side strictness lives in Zod, which is where a local authoring refusal belongs.

#### 4.2 The predicate

`coordination/campaign-deadline-lock.ts` — **predicate only**, same split as ADR-0028.

```ts
if (now <= deadline.at) return { locked: [] };   // NOT DUE — inert, zero further queries
```
Then per candidate, cheapest first: **override** (unexpired) ⇒ not locked; **adopted** (via pillar 3's `evaluateCampaignAdoption` — one resolution core) ⇒ not locked; otherwise locked.

**Fail OPEN on a malformed bag, loudly.** This departs deliberately from `stage-dependency-hold.ts`'s fail-closed `undeclarable` branch: that guards a *safety* coupling where dropping it deploys ahead of a named dependency. A deadline is a *coercion* mechanism, and failing closed would park an entire campaign on a typo. A malformed bag locks nothing and records one `verdict: "warn"` Decision.

**Clock injection:** `reconcileCampaignsOrgTick(..., opts: { now?: Date } = {})`, resolved **once per tick for the whole batch** so two campaigns straddling the same deadline cannot disagree within a tick. `reconcileOrgTick` is untouched; `foreign-origin-campaign.integration.test.ts` already drives the campaign tick directly, so the seam exists.

#### 4.3 THE ACTUATOR

> **`reconcileOneCampaign`'s per-target `pending` branch is the function that refuses. The refusal is: it does not call `proposeChange`.**

Not `checkFreeze` (scope-based, campaign-blind, and all-or-nothing across the wave — routing a per-target deadline through it would relock the crux this rework just fixed). Not `evaluateWaveGate` (one verdict, no target dimension, fires once — `reconcile.ts:999-1006` already wrote down both halves).

Placement: after the liveness gate, before `proposeChange` — the **same seam** as pillar 1's campaign-side hold, evaluated in the same pass. `allTerminal` is already false. **Nothing is written to the target row**: the lock is re-derived from `(deadline.at, adoption, overrides)` on every subsequent tick, which is what makes a late adoption, a moved deadline, or an override clear it **with no unlock verb**.

Decision: `kind: "campaign_deadline"`, `verdict: "block"` (verified safe — `latestBlockDecisionForSubject` is keyed on the **change** object id, so a campaign-subject Decision does not pollute the board's sticky `attention.blocked`), `subjectId: campaignObjectId`, `inputContext` carrying `deadline.at` as the only clock-shaped value plus a sorted `locked[]`. Banned from that object: `now`, `evaluatedAt`, `overdueMs`, `daysLate`, `lockedSince`, any remaining-TTL. A high-severity `campaign.deadline.lock` audit event is appended **only when `insertDecisionIfChanged` reports `created`** — appending on a no-op tick would make the hash chain assert an occurrence that did not occur.

#### 4.4 Dependency on pillar 3, stated plainly

**Under the default `campaign_target_succeeded` signal the lock is very nearly a no-op**, and this must be documented rather than sold. A target is a lock candidate only while `pending`, which means its member Change was never proposed, which means it can only be un-adopted. "Locked" degenerates to "the campaign hasn't reached you yet, and now it never will" — self-defeating, since the campaign *is* the migration.

The lock acquires force in exactly two situations: (i) **adoption observed outside the campaign's own fan-out** — pillar 3's `dependency` / `control` evidence — so a long-lived campaign genuinely cuts a laggard out of a stream that was still flowing; (ii) **the record is the product** — a Decision plus a hash-chained audit event making "component X missed campaign Y's deadline on date Z" a durable, signed, queryable fact. Even with the weak signal that is worth building, but it should be called a **tripwire**, not a lock.

**If the evidence is `declared`, it is an honour system** — the beneficiary of "I have migrated" is the party the deadline exists to coerce, at plain `object:write` scoped at their own component, with none of M22's admission algebra above it. Three mitigations, only the first strong: prefer a machine-observed signal; if declared, require a tier holding `policy:write` on the campaign's chain to admit that declaration (M22.2's algebra, a pillar-3 design item); pin the value verbatim into the Decision. **Recommendation: do not ship `"declared"` until an above-component admission exists.** A self-attested deadline lock produces a governance record asserting compliance nobody verified — worse than no lock.

#### 4.5 Override and escape

`POST /api/v1/campaigns/{id}/deadline-override` — `{ targets?, reason (min 1), until? }`, on the `freeze.override` shape.
- **New permission `campaign:deadline-override`**, granted to Owner only via an additive `array_append` migration. Not `freeze:override` — borrowing it would let a freeze-override holder waive migration deadlines and vice versa.
- **Checked at the campaign object**, not the target: the thing being waived is *this campaign's* deadline. A target-scoped check would hand the laggard their own waiver. Plus `object:write` at each named target so an override cannot be minted over a target the actor has no standing on.
- One transaction: the `overrides[]` entry via `updateObject` (versioned, content-hashed, audited on the ordinary graph path); a Decision (`verdict: "allow"`, `inputContext` carrying sorted target ids and `until` as a boundary — `at`/`actorId` excluded as clock-shaped, the audit event carries them); and **one high-severity audit event per target**, mandatory reason, `decisionId` linked (CRITICAL #2's per-scope rule applied to the same shape).
- Effect is immediate on the next tick. **No unlock verb** — that is the payoff of a read-time predicate.

`POST /campaigns/{id}/deadline` sets, moves, or clears (`object:write` + mandatory reason, audit `campaign.deadline.set` **recording the previous value**, or "the deadline slipped four times" is unreconstructible). Campaigns have no PATCH and no DELETE today — the same gap as freezes — and a deadline that cannot be moved is a deadline that gets worked around by deleting the campaign.

**A real hole to name:** deleting the campaign removes the surface entirely. The Decisions and hash-chained audit events survive (keyed on the campaign's object id), so the record is reconstructible, but nothing surfaces it. Out of M25 scope; belongs with pillar 3's adoption reporting surface.

#### 4.6 Wave semantics consequence

A locked target keeps `allTerminal = false`, so **siblings ship and reach `accepted`**, but the wave never terminalizes and **later waves never start**. Both alternatives are worse: terminalizing locked targets `failed` parks the campaign anyway *and* makes the lock irreversible (a terminal wave is never re-served); terminalizing `skipped` produces a campaign that "completed" while a target it was created for never migrated — a lie in the one record the feature exists to produce. This is the shape of the existing campaign wave engine; changing it is a separate decision.

**One defect this creates and which must be fixed in the same increment or the feature is invisible:** `computeCampaignStatus` derives `blocked` only from `waveStatus === "blocked"`, which we deliberately never write. Thread a read-time `deadlineLocked` flag into `ComputeCampaignStatusInput`, report the **existing** `blocked` enum value (do **not** widen `CampaignStatusSchema` — a response-enum widening is oasdiff risk with no upside), and expose detail as a new **required** response property `deadline: CampaignDeadlineStatusSchema.nullable()`. Guard the cost: `getCampaignStatus` runs per campaign inside `listCampaigns`'s already-N+1 loop, so the predicate must short-circuit on `deadline === null` **before any query**.

#### 4.7 Federation

A campaign object federates via `object_upsert` with `properties.deadline` riding along and **no new journal kind**. The replica never acts on it: `listActiveCampaignObjectIds` filters foreign-origin campaigns out in SQL and the S10 guard `continue`s before the bump. **The lock is evaluated only at the campaign's origin domain, which is where fan-out happens.** No sync-down design, no clock-skew-across-domains question. D1's federation assumption does not reach pillar 4 — worth stating in the ADR so a reviewer does not go looking for the freeze-shaped journal problem here.

---

## Data model delta

| Object | Delta | Migration? |
|---|---|---|
| `freezes` | `+ atomic boolean NOT NULL DEFAULT false` (§1.6) | **Yes** — one column, additive. The only migration pillar 1 needs, and the one to cut if OQ-1 rules against it |
| `change_wave_targets.status` | **unchanged.** A `frozen` value is additive (plain `text`, no enum, no CHECK) and still wrong: it is a materialized copy of a time-window predicate, needs a job to un-flip, and as the newest non-terminal row under an `executing` change it would **mask the dependency's genuinely successful earlier deploy at that place** for the whole window (`CHANGE_STANDS_BEHIND_ITS_TARGETS`) | No |
| `campaign_wave_targets.status` | **unchanged.** A new value falls through `campaign-reconcile.ts`'s `else` and casts `memberChangeObjectId as string` on a `null` — a live bug, not a free extension | No |
| `decisions.kind` | new values `freeze_admission`, `campaign_deadline`, `campaign_adoption`. `kind` is unconstrained `text`; read schemas are `z.string()` | No |
| `campaign.properties` | `+ recipe`, `+ deadline`. Schema is **open** and Ajv is `strict:false` — validates today | **Restatement only** — retype the fragment typed-but-open; no data change |
| `instance_freezes` | **new table**, no `org_id`, operator-write / tenant-read, `+ index`, `+ scp_operator` GRANT **and** policy | **Yes** — `0077` |
| `object_types` | builtin `freeze` type seed — **only if OQ-2 confirms federated org-tier freezes** | Yes, conditional |
| `Permission` union | `+ campaign:deadline-override`, granted to Owner via `array_append` | **Yes** — additive |
| `GateOutcome` / `GateVerdict` | `+ frozenTargets?: TargetFreezes[]` | No — internal TS types |
| campaign cursor column | **not needed** — the loop already bumps unconditionally (verified) | No |

---

## API surface

Every capability follows API → SDK → CLI → IaC → UI; nothing bypasses the public API.

| Endpoint | Status | oasdiff risk |
|---|---|---|
| `POST /api/v1/freezes` | existing; `+ atomic?: boolean` (optional request field) | none — request widening |
| `DELETE /api/v1/freezes/{id}` | **NEW — prerequisite, not follow-up** (`freeze:write`; soft delete) | none |
| `PATCH /api/v1/freezes/{id}` | **NEW** — `endsAt` only (`freeze:write`) | none |
| `GET /api/v1/freezes` | existing; must include platform freezes tagged `tier`, or CLI/UI contradict the board | `+ tier` as a **required** response property = additive. **Never make an existing required field optional** |
| `GET /api/v1/instance/freezes` | **NEW** — `requireAuth` only, inside `withTenantTx` under `tenant_read` | none |
| `PUT /api/v1/instance/freezes/{key}` | **NEW** — `requireAuth` + `requireOperator` (constant-time `x-scp-operator-token`), executed via `withOperatorDb` | none |
| `DELETE /api/v1/instance/freezes/{key}` | **NEW** — same auth | none |
| `POST /api/v1/campaigns` | `+ recipe?`, `+ recipeFrom?`, `+ deadline?` | none — request widening |
| `POST /api/v1/campaigns/{id}/deadline` | **NEW** — set/move/clear, `object:write` + mandatory reason | none |
| `POST /api/v1/campaigns/{id}/deadline-override` | **NEW** — `campaign:deadline-override` + mandatory reason | none |
| `GET /api/v1/campaigns/{id}/adoption` | **NEW** — purely additive, dodges response-optionality entirely | none |
| `GET /api/v1/campaigns/{id}` | `+ deadline: …\|null` as a **required** response property | additive; safe |
| `GET /api/v1/changes/{id}` wave targets | `+ hold?: { kind, until?, decisionId }` optional field; `status` untouched | additive |
| `ServiceBoardFreezeSchema` | `+ tier` required response property; `unknownFields` prose rewritten | additive |
| CLI | `scp freeze rm/edit`; `scp instance freeze put/list/rm`; `scp campaign adoption/deadline/deadline-override`. Fix `--scope` help text (currently omits deployment-target) | — |

**Standing oasdiff rule:** a second addressing must be a **qualifier on** the existing required field, never an alternative to it. Predict the gate by diffing `openapi.v1.json` in Python after `pnpm gen` — the binary is linux-only.

**Deliberately NOT widened:** `JournalEntryKindSchema` (nine kinds) — its `entryKind` enum appears in the **200 response** of `POST /federation/exports`, so widening it is a breaking response change *and* a fail-closed cliff that aborts whole bundles at older peers.

---

## Actuator table

*Mandatory. One row per new refusal. This is the standing check against shipping a signal with no lever.*

| # | Mechanism | The function that refuses | Decision kind / verdict | Test that fails if the wiring is deleted |
|---|---|---|---|---|
| 1 | **Per-target freeze hold (change side)** | `reconcile.ts` per-target loop: `if (frozen) { frozenTargets.push(...); continue; }` — before `triggerWaveTarget` | `freeze_admission` / `hold` | `freeze-admission.integration.test.ts` **Test A**: 4 placements, freeze at `amer` deployment-target; assert `apac/emea/govcloud` have non-null `executorRef`, `amer` is `pending` with `executorRef === null` **and `attempt === 0`**. Delete the `continue` → assertion fails |
| 2 | **Wave keeps siblings honest** | terminalization: `nonTerminalTargets - (heldTargets.length + frozenTargets.length)` and `heldCount > 0 && !anyFailed` | — (arithmetic) | **Test C**: after the unfrozen siblings succeed with `amer` held, assert the wave is **not** terminal. Drop the second line → wave marks `succeeded` with a target never deployed |
| 3 | **All-frozen still blocks the wave** | `evaluateGovernanceGate`'s `if (freezeCheck.blocked && !partiallyFrozen)` | `gate` / `block` (unchanged) | **Test E**: every target frozen ⇒ wave stays `pending`, `started_at` null, today's `gate`/`block` Decision present. Delete `partiallyFrozen`'s length guard → wave runs |
| 4 | **CRITICAL #2 preserved** | `checkFreeze`'s per-freeze `hasPermission(freeze:override, freeze.scopeObjectId)` loop over `unionFreezes(byTarget)` | `gate` / `block` | **Test H**: targets `[T1,T2]`, freeze scoped only to T2's service; override held at T1's scope ⇒ **blocked**; held at T2's freeze scope ⇒ allowed. Replace with `byTarget[0].freezes` → fails |
| 5 | **Campaign fan-out hold** | `campaign-reconcile.ts` `pending` branch: `continue` before `proposeChange` | `freeze_admission` / `hold` (subject = campaign) | **Test F**: 2 component targets, one component-scoped freeze ⇒ exactly one member Change minted; frozen row still `pending` with null `memberChangeObjectId` |
| 6 | **Platform freeze blocks** | `checkFreeze`'s tier-aware first pass (`instance_freezes`, stage-coordinate match) | `gate` / `block` with `inputContext.freeze.tier === "platform"` | `instance-freeze-gate.integration.test.ts`: seed one row, run a wave, assert blocked. Delete the pass → the wave runs |
| 7 | **No tenant may author a platform freeze** | `routes/instance-freezes.ts` `requireOperator` **plus** two DB barriers (no INSERT grant to `scp_app`, no non-SELECT policy for it) | — (403) | `instance-freeze-rls.integration.test.ts` using the **`RawScpAppClient`** harness (authenticates as `scp_app`, not the Testcontainers superuser). **Non-negotiable** — 0029/0035/0036/0074 all shipped with no writable principal at all and the suite was green throughout |
| 8 | **No tenant may override a platform freeze** | `if (!f.overridable) return { blocked … }`, before the org loop | `gate` / `block` | `instance-freeze-not-overridable.integration.test.ts`, **both directions**: Owner with `freeze:override` at org root is refused; flip `overridable = true` and the same actor succeeds |
| 9 | **Recipe kind the plugin cannot serve** | `reconcile.ts`: `describeCapabilities().triggerKinds` check ⇒ `blockWaveTarget(status: "recipe_unsupported")` | `gate` / `block` with `decision_id` | **T5**: assert **zero** `trigger()` calls recorded by the plugin |
| 10 | **Recipe author's door** | `graph/objects-repo.ts` create/update choke point: `assertValidCampaignRecipe` | — (400) | **T6**: bad key via `POST /campaigns` **and** via **IaC apply** ⇒ both 400. The IaC case is the one a route-level census misses |
| 11 | **Already-adopted target is not re-served** | `campaign-reconcile.ts`: `adopted` ⇒ terminalize `succeeded`, no `proposeChange` | `campaign_adoption` / `allow` | **T3**: inventory at `3.12` ⇒ no member Change minted; inventory at `2.7` ⇒ minted; **zero rows ⇒ `unknown`, explicitly `!== "adopted"`** |
| 12 | **Deadline lock** | `reconcileOneCampaign` `pending` branch `continue` before `proposeChange` | `campaign_deadline` / `block` | **W**: two targets, past deadline, B adopted; assert B's member change exists, A has **no** `changes` row, one Decision naming A not B, one audit event. Delete the seam **or** the `opts.now` thread → fails |
| 13 | **Deadline override needs authority + reason** | `POST …/deadline-override`: `campaign:deadline-override` at the campaign + `reason.min(1)` + `object:write` per target | `campaign_deadline` / `allow` | Missing reason ⇒ 400; missing permission ⇒ 403; `until` in the past ⇒ **not** effective (read-time expiry) |
| 14 | **Outpost cannot lift a commander freeze** (only if OQ-2 confirms) | `objects-repo.ts` single-writer read-only-replica guard ⇒ 409 | — | **already built**, `federation/outpost-config-sync.integration.test.ts` case 2 |

**Cross-cutting tests that are not refusals but are load-bearing:**
- **Dedup (the anti-1.44 GB gate):** with a hold standing, 30 more ticks ⇒ **exactly one** `freeze_admission` row. Adding `now`, or dropping either sort, fails it.
- **Inertness:** a change with no active freeze in the org performs **zero** `containmentChain` walks in the per-target loop (spy/count). This runs on the hottest path every second; it must not be prose-only.
- **Starvation:** `BATCH_LIMIT + 1` fully-frozen changes; assert change #26 receives a `freeze_admission` Decision within N ticks. Plus: `candidate-loop-registry.test.ts`'s `BUMPED` count for `reconcileExecutingChange` **must be incremented** — that registry is the one CI gate that catches a missing cursor bump.
- **Relocation, not deletion:** the two existing tests at `placement-governance.integration.test.ts:192` (service-scoped) and `:327` (deployment-target-scoped) must be **rewritten** to assert *both* halves — the gate's new verdict AND that the per-target resolver reports that scope as covering. **Flipping their expectations green is the vacuous-test failure**, and they are the only live coverage of containment routes 3 and 4 on the freeze path.
- **Promotion survival:** export/import a promotion bundle for a change carrying `properties.recipe`; assert it arrives byte-for-byte. Pins `promotion-repo.ts`'s two-key strip list against a future third key.
- **Census guard:** `sourceKind: "campaign"` occurs in exactly one `src/` file and that file imports both `evaluateCampaignDeadlineLock` and `evaluateFreezeHolds`. A second fan-out site fails CI until classified.

**Standing mutation gate** (per "delete the wiring, watch a test die"): before this milestone is called done, run rows 1, 2, 4 and 12 as deliberate mutations. Also flip `every` → `some` in the freeze override quantifier: **both** the accept-edge test and the wave-path test must go red. If only one does, the second caller has no coverage — *that* is the check, not the pass.

All integration tests run with `--config vitest.integration.config.ts` under **`withPluginHost`, never `withReconcileLoop`** (a competing consumer; `SKIP LOCKED` makes an inline call a silent no-op), and **read the printed file list** — a scoped `vitest run` excludes integration files by default and reports a confident green having executed none of them.

---

## Documents to change

### DESIGN.md §10.3 — current (verbatim)
> - **Freezes** are a built-in policy effect with time windows and scope (org / containment domain / service / component) — **org-rooted; the above-org tiers ADR-0016 adds are scan-requirement-only and do not extend freeze scoping**. Override requires an explicit `freeze:override` permission **and a mandatory reason**, producing a high-severity audit event + Decision.

### DESIGN.md §10.3 — replacement
> - **Freezes** are a first-class governance mechanism (their own table, their own scope column, their own override permission — *not* a CEL policy effect; see §10.4's Decision `kind` enum, which lists `policy` and `freeze` as coordinate kinds). Scope spans **seven tiers**: **platform (instance) → trust domain → org → containment domain → service → component → deployment target**. The five org-and-below tiers are ordinary graph objects resolved by `containmentChain` (routes 3 and 4 put a placement's component *and* its deployment target on the chain, which is what makes "freeze `amer-prod`" expressible — owner decision 2026-08-02). **The two above-org tiers come from a single instance-scoped table** (`instance_freezes`, no `org_id`, operator-write / tenant-read — the §4.2 exception, a third instance after ADR-0016 §3 and ADR-0033 §7a), because `containmentChain` is org-rooted and org-filtered on every join and structurally cannot reach above org. An instance freeze addresses targets by the **stage coordinate** (`properties.environment`, optionally `properties.region` — the M15.6/ADR-0017 §3 convention), never by object id, because object ids do not exist across orgs.
> - **This overturns the previous clause** ("org-rooted; the above-org tiers ADR-0016 adds are scan-requirement-only and do not extend freeze scoping"), by owner decision 2026-08-23, recorded in **ADR-0040**.
> - **Merging is union, not MIN.** A freeze is a predicate, not a threshold: the effective verdict is the OR of every applicable window, so an instance freeze blocks even when the org declared nothing and no org-tier authoring can subtract from it. The floor property therefore lives entirely in the override rule.
> - **Admission is per target at a wave boundary** (ADR-0039): a freeze covering one of four regions holds that region and admits the other three, unless the freeze is declared `atomic`. At the `validating -> accepted` lifecycle edge admission stays whole-change — there is no such thing as accepting three quarters of a change.
> - **Override** at org tier and below requires `freeze:override` **at that freeze's own scope**, held individually for **every** active freeze over the target, **and a mandatory reason**, producing a high-severity audit event + Decision. **An instance-tier freeze is not overridable by any tenant role**; the authoring operator may mark it `overridable`, admitting override by an actor holding `freeze:override` at the org root under the same reason requirement. Default off. Instance freezes are authored, shortened and lifted only through the operator door.

### DESIGN.md §10.1 (`:484`) — current (verbatim)
> **This widening applies to scan-requirements only** — it deliberately does **not** widen freeze scoping or any other policy effect (§10.3), which stay org-rooted.

### DESIGN.md §10.1 — replacement
> **This widening now also covers freezes** (owner decision 2026-08-23, ADR-0040): freeze scoping resolves over the same two above-org tiers, from its own instance-scoped table built to the identical operator-write / tenant-read shape. It still does **not** widen any *other* policy effect — `requireControls`, `requireApprovals` and emergency policy remain org-rooted, because they resolve through `matchPoliciesForTargets` over the org-rooted containment chain and have no instance-scoped substrate.

### DESIGN.md §9.5 — current
> Both are in MVP scope per the charter; **neither introduces new engine machinery**.

### DESIGN.md §9.5 — replacement
> Both are in MVP scope per the charter. **M25 adds one new engine mechanism to the campaign path**: a per-(campaign × target) admission predicate evaluated before fan-out, which carries both the per-target freeze hold (ADR-0039) and the deadline lock (ADR-0042).

### BUILD_AND_TEST.md M16.2 — correction
Current: *"per-outpost Configuration (poke-mode M14, local Gitea registry M15, **freezes**, bundled backends). **Commander-origin, syncs down**."* — false the moment the platform tier ships: that tier is operator-write, has no `org_id`, is declared by no commander, and cannot ride the per-org outbox-derived journal. Rewrite to name which freeze tier (if any) syncs, pending OQ-2.

### PROJECT_CHARTER.md — "Freeze Scope" amendment (`:2086-2093`)

Current is a four-item list (Organization / Domain / Service / Component). **This needs a named, dated charter amendment**, not a doc tweak — the only precedent for widening a charter enumeration this way is the Managed Execution Exception. Replacement:

> **# Freeze Scope**
> - **Platform (this deployment)** — declared by the deployment's operator; binds every organization hosted here. Optionally narrowed to a stage coordinate (an environment, and optionally a region within it). No tenant role can author, edit, or lift one.
> - **Trust domain (partition)** — the same instance-scoped tier, labelled for the ambient federation partition.
> - Entire Organization
> - Domain (containment domain)
> - Service
> - Component
> - **Deployment target (stage / region)** — a freeze here catches every placement deploying at that target. This is how "freeze `amer-prod`" is said, and it is why a wave may proceed to three of four targets when only one is frozen.
>
> **# Freeze Exceptions**
> Authorized users may bypass freezes **at organization tier and below**: the actor must hold `freeze:override` at that freeze's own scope and supply a mandatory reason, and **every** active freeze covering the target must be overridden individually.
> **A platform- or trust-domain-tier freeze is not bypassable by any tenant role, however privileged.** The authoring operator may mark it overridable, admitting bypass by an actor holding `freeze:override` at the organization root under the same reason requirement; off unless declared.

*(The deployment-target bullet is a correction of already-shipped behaviour — route 4 landed 2026-08-02 and the charter has been behind the code since.)*

### GLOSSARY.md — entries to add

| Term | Content |
|---|---|
| **freeze** | Time-windowed block on a scope. Seven tiers (platform → trust domain → org → containment domain → service → component → deployment target). Not a CEL policy effect — its own table, its own scope column, its own override permission. Override needs `freeze:override` at that freeze's own scope plus a mandatory reason, per freeze. Cross-ref **campaign deadline lock** to prevent conflation. |
| **campaign** | Graph object that `coordinates` many member Changes in waves. Status is **derived, never stored**. Carries `targets`, `topologyObjectId`, `type`, and (M25) an optional `recipe` and `deadline`. |
| **platform-tier freeze** | Instance-scoped freeze with no `org_id`, operator-authored, binding every tenant on the deployment, addressed by stage coordinate. |
| **per-target admission** | The wave-boundary property that a freeze covering one target holds that target and admits its siblings. Not a scope model — a granularity of the same verdict. |
| **coordination lever** | A campaign recipe: one authored trigger intent fanned across N components, gated and tracked. **Not** an authoring lever — SCP never writes the patch (deferred, explicitly). |
| **campaign deadline lock** | A per-(campaign × target) admission gate. An unmigrated target stops receiving **this campaign's** changes; unrelated releases including security fixes keep flowing. **Not** a freeze on the component and not a pipeline lock. |
| **adoption evidence** | The named source a recipe declares for "has this component migrated": `delivered`, `dependency`, `declared`, `control`. Absent evidence yields `unknown`, never `adopted`. |

### ADRs to write

*Numbering confirmed 2026-08-23:* `main` tops out at 0033 (verified on this branch), 0034 is reserved in prose by `governance-label-namespace.md`, 0035 is M23's, and 0036/0037/0038 are taken on the unmerged UI branch `claude/ui-review-worktree-efc42b` (confirmed directly with that session — that branch is invisible to `gh pr list`, so it cannot be checked with the usual tooling). **0039–0042 are free.**

- **ADR-0039 — Per-target freeze admission at a wave boundary.** The relocation, the `partiallyFrozen` guard, the `hold`-not-`block` verdict, the disjointness invariant, the `unionFreezes` preservation of CRITICAL #2, the `atomic` opt-out, the `!isRollback` exemption, and the rejected alternatives (fully-keyed gate — foreclosed by `approval_requests_dedup_key`; compile-time partition — foreclosed by `gate_bindings.wave_index` and the release ladder).
- **ADR-0040 — Platform-tier freezes.** The instance-scoped table, the §4.2 `org_id` exception (third instance), the operator-write pattern **including 0076's grant+policy**, stage-coordinate addressing, the non-overridability ruling, and the federation finding that the journal is org-scoped at every layer.
- **ADR-0041 — Campaign recipes and adoption evidence.** Properties-not-table (with the `freezes` counter-precedent weighed and the ADR-0022 reach argument that decides it), verbatim parameter pass-through, the four evidence kinds, "silence is never a pass", and why subscription bumps must not become campaigns.
- **ADR-0042 — Deadline-triggered campaign lock.** Read-time predicate, D4's radius, the fail-open-on-malformed departure from ADR-0028, the honour-system warning on `declared`, the wave-stall consequence and its rejected alternatives.

### BUILD_AND_TEST.md §8 — M25 entry (after M24)

**M25 — Campaigns & freezes rework.** Machine-checked DoD per increment:
- **M25.1** — freeze API completion: `DELETE` + `PATCH endsAt`. *Prerequisite for everything else.*
- **M25.2** — per-target freeze admission (ADR-0039): `freezes-repo` split, `freeze-scope.ts`, `freeze-hold.ts`, both actuators, terminalization, Decision + cursor bump, `candidate-loop-registry` count, the two rewritten placement tests, `service-board` containment fix, wave-target `hold` read field.
- **M25.3** — platform tier (ADR-0040): `0077`, routes, `activeFreezesFor` as the single reader, RLS test under `RawScpAppClient`, both override directions.
- **M25.4** — campaign recipes (ADR-0041): schema, choke-point guard, `parameters` wiring, capability refusal, promotion-survival test.
- **M25.5** — adoption predicate (ADR-0041): `campaign-adoption.ts`, the four evidence kinds, the skip-already-adopted actuator, `GET /campaigns/{id}/adoption`.
- **M25.6** — deadline lock (ADR-0042): predicate, actuator, clock seam, override route + permission, `computeCampaignStatus` thread.
- **M25.7** *(confirmed in scope by D6)* — federated org-tier freeze as a graph object: a `freeze` object type, the projection rebuilt on import, the commander-vs-local precedence rule, the read-only-replica guard proving an outpost cannot lift a commander freeze, and the deliberate flip of `service-board-precedence.integration.test.ts` carrying its retired reasoning plus a non-vacuity mutation. Platform tier explicitly does NOT federate.
- **M25.8** *(D8)* — the dependency actuator's freeze gap: `bump-dispatch.ts` / `bump-gate.ts` consult freezes before AUTO-MERGE (never before PR authoring), writing a Decision on refusal. A fix to an already-shipped path, sequenced last so it does not entangle the campaigns design.
- **M25.9** *(D1, ruled 2026-08-25 — §1.7 exit (b))* — `freeze:override` on top of `freeze:write` to LIFT or SHORTEN a freeze you did not declare, compared on `freezes.created_by_actor_id` and demanded at the freeze's own scope. **Not the same increment as M25.8 above** — that number belongs to D8 and is already shipped under it; this one carries its own. A correction to M25.1's authorization rule, so DESIGN §10.3's retraction bullet and BUILD_AND_TEST's M25.1 DoD are edited to match rather than left stating the superseded rule.

---

## Pre-existing contradictions this rework must settle

1. **Initiatives: removed on the UI branch, live on `main`. This is a merge-order coordination fact, not a disagreement.** Both statements are true of different trees, and each session verified its own. On the unmerged UI branch `claude/ui-review-worktree-efc42b`, Initiatives were removed by owner instruction 2026-08-10 (ADR-0036 there: `POST /initiatives` deleted, IaC constructs removed, no shim). On `main` — the base this work lands on — they are **live and verified so here**: `apps/server/src/routes/initiatives.ts` exists and is registered at `app.ts:44`; `containment-parent-doors-census.integration.test.ts` POSTs `/api/v1/initiatives` and asserts `201`; `PROJECT_CHARTER.md:2242-2269`, `DESIGN.md:456-458,666`, `GLOSSARY.md:570` and BUILD_AND_TEST M5 all describe them as live.
   **Ruling: design M25 against Campaigns as they exist on `main`, and touch nothing Initiative-shaped.** M25 adds no Initiative surface and removes none, so it merges cleanly in either order — but any M25 increment that reaches for the Initiative roll-up would break the moment the UI branch lands. The proposal deliberately does not. *(This is also a standing lesson: a removal reported by a peer session is true of that session's branch until verified on yours.)*

2. **Charter freeze-scope list vs. ADR-0026 (both Accepted).** The charter lists four tiers; ADR-0026 §"consequences" records that a stage-scoped freeze became expressible for the first time. They already disagree, independent of this rework. **Ruling: settle both gaps in one charter amendment** (the deployment-target correction and the two new above-org tiers).

3. **DESIGN §10.3 "freeze is a built-in policy effect" vs. §10.4's own Decision `kind` enum, nine lines apart.** `kind text NOT NULL, -- gate|policy|freeze|…` lists them as coordinate kinds (verified at `schema.ts:596`), and `freezes` is a dedicated table with no link to any policy object, no CEL condition, and no presence in `PolicySchema.effects[]`. **Ruling: fix the phrasing in the §10.3 rewrite** — freeze is first-class, not a species of policy effect. Every one of D1–D4 relies on that reading.

4. **Freeze sync-down: an aspiration that was already found false at build time and corrected honestly — not a live contradiction.** BUILD_AND_TEST M16.2 and `federation-outposts-ui.md:21` both list freezes in per-outpost Configuration as *"commander-origin, syncs down"*. That was the **M16.2 proposal's aspiration**. At build time it was found false and handled the right way rather than shipped as a half-truth: `apps/web/src/routes/outpost-configuration.tsx:591-606` renders the correction to the operator verbatim — *a freeze is a local projection row, it does not ride the sync journal, so a freeze declared at the commander is not a freeze at the outpost* — and points at where freezes actually live.
   Confirmed at the schema level: `JournalEntryKindSchema` has nine kinds, none freeze-shaped, and **a freeze is not a graph object** (it is a dedicated projection table — `db/schema.ts`'s "M4 Governance Engine" banner states outright that the generic object model has no place for control-run evidence, approval quorum, or freezes), so it cannot ride `object_upsert` either. That is *why* no freeze journal kind exists: freezes were never objects. *(Cited by section, not by line: that banner has since been rewritten to carry both halves of the narrowed claim — see SETTLED below — and a line number here would have gone on pointing at the retracted sentence.)*
   **The absence is pinned by a test.** `coordination/service-board-precedence.integration.test.ts` asserts that freezes never ride the journal.
   **Ruling: sync-down is net-new work that OVERTURNS A DELIBERATE, TESTED ABSENCE — not a gap to be quietly filled.** It is gated on OQ-2. If OQ-2 says yes, the flip must take the shape this repo uses for a deliberate inversion (as in #244's past-the-bound case and the domain-delete orphan-guard control): the retired pin's reasoning stays in the comment, and the new pin records the mutation that proves it non-vacuous. It also makes `outpost-configuration.tsx:604-606`'s copy stale the moment it lands — a named UI consequence, already coordinated with the UI session, not a discovery for integration time. Correct M16.2's wording either way, since the sentence is false today regardless of OQ-2.
   **SETTLED (M25.7, 2026-08-24).** OQ-2 answered **(b)**; built as [ADR-0043](../adr/0043-federated-org-tier-freezes.md), and the inversion took exactly the prescribed shape — the retired pin's reasoning is quoted verbatim in `service-board-precedence.integration.test.ts` above the two cases that replace it, and the new pin carries the measured mutation (deleting `rebuildFreezeProjectionFromObject` from `import-repo.ts`'s `object_upsert` branch turns the admission case red, with the object still replicating, so an existence-only assertion would have stayed green). M16.2's wording, `federation-outposts-ui.md:21`, `outpost-ui.md:48` and the outpost-configuration copy are all corrected. **What did NOT change:** freezes are org-scoped and never per-outpost, so §"Pre-existing contradictions" #5's ruling stands and that surface keeps its read-only note rather than gaining a form; and a platform-tier freeze still does not federate.

5. **"Per-outpost freeze configuration" is structurally wrong.** `freezes.scopeObjectId` points into the org's containment graph; there is no "the outpost this freeze belongs to", and a service-scoped freeze reaches every placement under it regardless of which outpost executes which region. **Ruling: freezes are org-scoped or instance-scoped, never outpost-scoped. Rewrite the outpost-configuration framing.**

6. **`freeze` and `campaign` have no GLOSSARY entries** despite 30+ live references and a shipped M5 concept. **Ruling: add both plus the five new terms above.** GLOSSARY is authoritative for vocabulary.

7. **M23 collision.** If the coordination lever ever routes through the M21 bump dispatcher (OQ-5), it inherits M23's live defect: `scp-managed-dep` terminates in `docker create`, which `ENOENT`s under `helm install` today. **Ruling: name the dependency now; do not discover it at integration time.**

8. **M22.0a precedent.** Any memoisation of the adoption or freeze predicate must key on target + campaign + gate identity. M22.0a exists because a control run computed during `validating` silently authorised a wave three weeks later on a cache key that omitted gate identity.

---

## What this design does NOT do

1. **It cannot pause an in-flight rollout.** `ExecutorPlugin` is exactly `observe`/`trigger`/`status`/`abort`/`describeCapabilities`, and ADR-0008 forbids a pause/resume verb. `stage-dependency-hold.ts:41-47` states the ceiling: *"the finest grain enforceable here is 'is A triggered at this place at all'."* A freeze declared while a target is `triggered`/`observing` does not stop it; SCP watches it finish. A target already past backoff in `triggering` has been handed to its executor, so the freeze withholds the **retry**, not the original call. **Any UI or spec sentence promising "freeze pauses the rollout" or "the campaign stops mid-rollout at the deadline" is promising something the interface cannot express and should be struck.** `abort` exists, but aborting a healthy or half-applied in-flight release at an arbitrary instant is a different and far more dangerous decision, and nothing authorises it.
2. **SCP does not author the migration.** D3 is a coordination lever. The recipe *triggers*; the tenant's workflow does the edit. A tenant with no such workflow has nothing to trigger, and the honest outcome is a refusal. No charter amendment is sought.
3. **No cross-provider parameter translation.** A recipe written for `github` keys will not drive a `gitlab`-bound target, and SCP will not guess. Mixed-module campaigns use the binding-level `defaultWorkflowId`/`defaultRef` fallback, or two campaigns.
4. **Adoption is unknowable without evidence.** No manifest, no control, no declaration ⇒ `unknown`. **Never `adopted` from silence.**
5. **The deadline lock is not a pipeline lock.** D4's radius is this campaign's own targets. "The laggard cannot ship anything" is a freeze at that target's scope, which D4 explicitly excludes.
6. **A platform freeze cannot name an object.** No `scopeObjectId` exists across orgs. "Freeze this one tenant's service" is not expressible at platform tier and must not be faked; that is an org-tier freeze.
7. **A platform freeze does not federate.** The sync journal is org-scoped at every layer. Multi-instance distribution is a deployment-tooling problem. The `origin` column will have **no writer** and the header must say so, or it becomes a field that lies.
8. **No timezone support, ever.** There is no timezone library and no vendored IANA data, and air-gap (principle 5) forecloses fetching any. All windows and deadlines are **UTC instants**; `timestamptz` storage, UTC ISO on the wire. *"Freeze prod Dec 20 – Jan 2, local time"* and *"end of business Dec 31 in each region"* are **not expressible** — the latter means N different instants for N regions, which is a multi-axis model D2 rejects. The answer under D2 is **N freezes / N campaigns**, one per region, each with its own UTC instant. Also not expressible: recurring windows, business-day calendars, and relative deadlines ("30 days after onboarding" — that needs a per-target anchor column, which is the stored-status prohibition). The UI may render in the viewer's browser timezone via client-side `Intl`; that never feeds back into any predicate.
9. **A change does not complete when a target is held.** Three of four regions ship and the change stays `executing` until the fourth catches up. Later waves do not start.
10. **This rework does not close the dependency-subscription freeze hole.** See below — it is escalated, not folded in.

---

## Open questions for the owner

**OQ-1 — Default direction of `freezes.atomic`.** Per-target admission is a change that newly **PERMITS**: it loosens the meaning of every service- and component-scoped freeze already on the estate, and containment route 4 was escalated to you precisely because it newly **BLOCKED**. D2 authorises the *region* case. Options: (a) `atomic DEFAULT false` — per-target admission is the default, incident freezes opt into all-or-nothing (**recommended**: matches your requirement 5 directly, and the coupled-target risk is mitigated by `depends_on` waves); (b) `atomic DEFAULT true` — every existing freeze keeps its exact meaning and regional freezes opt in (safest, but risks the feature reading as broken when an operator forgets the flag); (c) no column at all, universal per-target admission (smallest, no migration, but no escape for a genuinely coupled wave).

**OQ-2 — Federation reach. THIS IS AN ASSUMPTION OF MINE, NOT SOMETHING YOU DECIDED.** D1 was worded as a ladder ("above-org **too**"), so I treated commander→outpost sync-down as in scope. On investigation it is a materially separate chunk of work, so I am asking rather than proceeding.
What was found: a platform freeze **cannot** ride the journal at all (it is org-scoped at every layer, and a platform freeze has no `org_id` and is declared by no commander). An org-tier commander freeze **could**, but only by becoming a graph object so it can ride `object_upsert` — a new journal kind is both an oasdiff response break and a fail-closed cliff that aborts whole bundles at older peers. And the absence is not merely unimplemented: it is **pinned by a test** (`service-board-precedence.integration.test.ts`) and already **explained to operators in the UI** (`outpost-configuration.tsx:591-606`), because M16.2's "syncs down" aspiration was found false at build time and corrected rather than shipped.
Confirm: **(a) no freeze federates in M25** — the platform tier is per-instance operator config, distributed by deployment tooling (**recommended**: smallest, and the rest of this proposal does not depend on it); **(b) org-tier commander freezes federate as graph objects** (M25.7) — which means restructuring how a freeze is stored, overturning a deliberate tested absence, and rewriting three shipped artefacts.
**This proposal is severable at exactly this seam.** Pillars 1, 3 and 4 and the platform tier all stand without it, so answering (a) costs nothing already designed.

**OQ-3 — Same shape, two features: commander-declares / outpost-adopts.** An outpost *acting on* a commander-declared thing rather than mirroring it is a new federation semantic, and it is needed identically by the freeze sync-down (OQ-2) and by campaign recipes reaching an outpost (path 3). **Recommendation: rule on both in one decision, or defer both.** Do not let one be invented twice.

**OQ-4 — Rollback exemption from freezes at the wave boundary.** `evaluateLifecycleGate` already exempts rollbacks; `EvaluateWaveGateContext` carries no `isRollback`, so a rollback's wave targets **are** freeze-blocked today. Adding the exemption is right (holding a rollback pins a broken release in place for the window, contradicting DESIGN §9.4) but it is a change that newly permits. Confirm.

**OQ-5 — May a campaign drive the `managed-dep` actuator?** A dependency-shaped recipe could delegate to the already-built bump actuator, making "bump `FROM python:2.7` → `python:3.12` across 47 Dockerfiles" genuinely one click. The M21 charter amendment grants repo-write for *dependency bumps*, and a `FROM` line is a dependency declaration — but a python2→python3 migration in general is code, and a campaign is arguably a new initiator needing its own sign-off. **Not built in M25 absent a ruling.** If granted, the boundary is: manifest-declared portions only, and the `managed-dep` plugin's existing refusal of any intent parameter that could hold authored file content stays untouched.

**OQ-6 — `declared` adoption evidence.** Should it ship at all? The beneficiary of "I have migrated" is the party the deadline exists to coerce, writing at plain `object:write` scoped at their own component, with none of M22's admission algebra above it. **Recommendation: do not ship it until an above-component admission exists.** (Mitigating asymmetry: unlike ADR-0033's exclusions, the blast radius of the lie is the liar — a component that falsely claims migration stops receiving the migration it claims to have done.)

---

## Escalated separately — not folded into M25

> **The dependency-subscription actuator consults no freeze and no governance gate at all.**
> Verified filterlessly: `grep -rna "freeze" apps/server/src/dependencies/*.ts` returns **one unrelated word in a comment** (`inventory-ingestion.ts:434`), and `evaluateGovernanceGate` has exactly two callers, both in `gates.ts`. `bump-dispatch.ts:~858` and `bump-gate.ts:~458` call `executor.trigger()` on a self-minted `changeObjectId`, writing their own bespoke Decisions and never entering the gate. `prewarmGovernanceForChange` is called first but never calls `checkFreeze`. The bookkeeping Change this path creates is documented as "deliberately never advanced", so it never reaches the wave gate that would otherwise catch it.
>
> **Today, a declared change freeze over an org does not stop SCP from opening and auto-merging a version bump into that org's repositories.** Merging code into a tenant repo during a declared freeze is arguably the single most freeze-relevant act on the instance, and it is unguarded on `main`.
>
> This is the "incomplete call-site census" class, live in production. **It should be escalated on its own terms and given its own decision** (does a freeze block PR-authoring, auto-merge, or both?), not slipped into an M25 PR. When it is closed, `freezesByTarget` / `activeFreezesFor` is the right shared function for it.

---

## The wave-target hold projection — shape fixed by reading the component (2026-08-23)

The per-target hold Decision (pillar 1 §1.4) is **not** what the UI renders. The UI session read
`PipelineWaveCard` rather than describing it from memory, and the correction matters: the card reads a
**wave-target projection field** via `holdFor(target)` — shaped like `ChangeStageDependencyTarget`
(`dependencies[]`, each `{ dependsOn, dependsOnName, summary, satisfied, source }`). The Decision is
only the `WhyLink` target behind "Why?".

So the additive read field on the wave-target projection is the actual feed, and it must satisfy four
properties. **This field is NOT part of M25.2** (which is internal-only and holds no codegen slot); it
lands with the codegen slot, which means these are design inputs before the field is written rather
than change requests after it.

1. **It carries the covering freezes themselves, never a boolean.** A `frozen: true` flag would force
   the client to join back to something to say anything useful.
2. **Each covering freeze carries a server-composed `summary` sentence**, rendered verbatim. This is
   the established idiom: `describeStageDependencyHold`'s sentence is both the rendered line and what
   the Decision's `reasonTree` carries. **The UI composes no copy from raw fields** (charter principle
   6 — explainability is the server's return value, not a client's reconstruction).
3. **`scopeObjectId` is enriched to `{ objectId, name }`** server-side — the same ruling as
   dependency producers §12.6 Q1. A bare id renders as a UUID; an N+1 client join is worse.
4. **`endsAt` is carried and `now` is not.** The client's own clock contextualizes it. This is the
   dedup contract from §1.4 and a render need must never push `now` into the record.

**The raw status stays beside the hold.** A held target's status is still `pending` — the hold line
*explains* that status rather than replacing it. The same rule governs the wave aggregate: a mixed
wave must be nameable without overwriting what each target individually is, and the aggregate value is
computed server-side (it feeds `wave-status.ts`'s `waveStatusTone`/`waveStatusBorder` plus
`PipelineWaveCard`'s wave-level badge — the only two render sites, and never recomputed client-side).

---

## Coordination with the UI session

UI work for this rework is owned by the session on `claude/ui-review-worktree-efc42b`, which is **98 commits ahead of `main` with no open PR** and is the correct base for UI work. Agreed with that session on 2026-08-23:

**What already exists there, and must be designed *for* rather than around:**
- **Campaign UI is live** — `apps/web/src/routes/campaign-list.tsx`, `campaign-detail.tsx`, nav `{ to: "/campaigns", icon: Flag }` on `COMMANDER_NAV` only (outposts deliberately do not carry it).
- **Freeze *rendering* is already an idiom** — "freeze/frozen" renders in `PromotionArrow.tsx`, `service-board.tsx`, `dashboard.tsx`, `change-pipeline.tsx`, `component-pipeline.tsx`, `outpost-configuration.tsx`, fed by `WhyLink`/`ReasonDialog` keyed on `decision_id`.
- **The per-target hold render already exists** — `PipelineWaveCard` renders a wave-level badge *and* per-target rows each with its own badge, plus a `HeldTargetLine` precedent (*"Never triggered — held by a stage dependency"*, listing only unsatisfied dependencies, **server projection, never recomputed client-side**). A freeze-held target fits that exact slot. This is why pillar 1's per-target Decision shape lists `held[]` per target: it feeds a component that already exists.
- **Freeze *authoring* is net-new** — there is no freeze-authoring UI and no policies page at all; freezes are CLI/API-authored today. M16.3 applies (offer the write, render the server's refusal verbatim).

**Constraints this proposal accepts from that session:**
1. **M25.1 (freeze `DELETE` + `PATCH endsAt`) is that session's gate for starting.** It is already sequenced first here for its own reasons, and it must stay first: a "manageable from commander down to component" surface is unusable while a freeze cannot be lifted or shortened. If it slips out of increment one, that session must be told — it changes *when* their round can start, not just its scope.
2. **The mixed-wave aggregate value must be computed server-side.** `wave.status` is rendered by `apps/web/src/components/pipeline/wave-status.ts` (`waveStatusTone`/`waveStatusBorder`) plus `PipelineWaveCard`'s wave-level badge — the only two render sites, and cheap to change. But per-target statuses stay authoritative and the aggregate must never be recomputed client-side. Pillar 1's "aggregate-status honesty" requirement is therefore a **server** requirement.
3. **Sequence with that session before touching `PipelineWaveCard.tsx`** — M23.1g's truncated-vs-absent render lands there when PR #264 reaches `main`.
4. **Slot discipline:** one API-surface-changing session and one migration-adding session at a time. That session holds the codegen slot and carries migrations 0073–0079 (renumbered at merge; `main` tops at 0076). **This round claims neither slot** — it is docs-only. Slots will be announced before any server increment starts.
5. If OQ-2 lands sync-down, `outpost-configuration.tsx:604-606` goes stale in the same round; that session has agreed to fix the copy alongside the freeze-authoring UI.

---

## Marked-unverified claims

Everything load-bearing above was read at HEAD on `campaigns-rework`. The following were **not** verified in this session and are carried from inputs:

- ADR-0022's exact clause numbering and the `outpost-config-sync.integration.test.ts` case-2 assertion text (the mechanism — the single-writer replica guard — is well attested across inputs but the test was not read here).
- ~~The `RawScpAppClient` harness's location.~~ **Verified 2026-08-23:** `apps/server/src/graph/rls.integration.test.ts:7,60` — *"a raw `pg.Client` running as the same least-privileged"* role. Use it directly.
- ~~`promotion-repo.ts`'s strip list.~~ **Verified 2026-08-23:** exactly two keys, `requires` (M12 P4B) and `stageDependencies` (ADR-0028), at `promotion-repo.ts:915-916`. The M25.4 regression test still earns its place — it pins the list against a future third key, which is the failure it exists to catch.
- ~~`service-board-precedence.integration.test.ts` pinning the freeze/journal absence.~~ **Verified present 2026-08-23** at `apps/server/src/coordination/service-board-precedence.integration.test.ts`.
- The per-adapter parameter key table (`github`/`gitea`/`gitlab`/`argocd`) — attested by one input from a direct read of each adapter, not re-read here.
- ADR numbers 0036/0037/0038 being taken on the unmerged UI branch. **Confirm against `claude/ui-review-worktree-efc42b` before claiming 0039–0042** — that branch is invisible to `gh pr list`.