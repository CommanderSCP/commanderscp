# Governance reach is tenant-writable — recording the move, and the open question of refusing it

**Status:** v0.1 Draft — **proposed, pending review.** The code in the accompanying PR implements §5 (detection). §4 is the owner decision this document exists to ask for; nothing in §4 is implemented. An ADR follows owner approval.

**Relates to:** [governance-label-namespace.md](governance-label-namespace.md) §7a/§8.8 — this is the task that document filed and said "should be sequenced next"; [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) ("authorization at the door, invariant at the repo" — this lands on the other side of that split, and §6 says why); [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (the placement pair, containment routes 3 and 4); [ADR-0028](../adr/0028-decision-retention.md) (persist-on-change, the constraint §5c is built to satisfy).

---

## 1. The defect

`governance/policy-resolve.ts` matches **every** policy scope kind — `objectRef`, `selector`, `group`, `ownerGroup`, and unscoped — over the target's **containment chain** (`graph/containment.ts`). `authz/resolve.ts`'s `scopeExpandCte` expands authority upward over the same edges. Containment is therefore the reach of all governance.

It is also ordinary tenant-writable graph data. Two permissions meet at that fact, and they are not the same size:

| Act | Permission | Held by |
|---|---|---|
| Author the policy | `policy:write` | `Administrator`, `Owner` (`drizzle/0010_governance.sql:174`) |
| Move the object out from under it | `relationship:write` / `object:write` | `Operator` and up (`drizzle/0002_rls_rbac_seed.sql:210`) |

**So the subject of a constraint can leave its reach without ever touching the constraint** — and until this change, nothing recorded that governance reach had changed at all. The move produced an `object.update`, or a relationship create plus a delete, indistinguishable from any other.

## 2. Scope: what was already true, and what the residual actually is

Two claims in the original framing of this task were **overstated and are corrected here**, because the fix is much narrower than they implied and a proposal that oversells its own defect is worse than useless.

**Delete is not weaker than create.** `routes/relationships.ts` authorizes `relationship:write` at **both** `found.fromId` and `found.toId` on DELETE (`:218-229`), symmetric with create at `:86-97`. An earlier hypothesis that delete needed only `relationship:read` at the org root was a misreading of the LIST handler.

**A component-scoped Operator cannot do this.** Authority expands strictly upward, so a binding at a component satisfies neither endpoint check at a service. "Any component owner can re-parent" is false. Pinned as `CASE 2`.

**The residual, stated exactly:**

> An actor holding `relationship:write` (or `object:write`) at a **service or broader** scope, but **not** `policy:write`, can move a component from a governed container to an ungoverned one. Both endpoint checks pass **legitimately** — that is an ordinary platform-team Operator, not an escalation.

Both containment routes are now two-ended (route 1's move authorization is `graph/containment-parent-authz.ts`'s `resolveDeclaredContainmentParent`, **merged as #244**; route 2's has always been). **But two-endedness protects the CONTAINERS' holders, not the POLICY AUTHOR.** Nobody who holds `policy:write` is consulted, and nothing tells them afterwards. That is the whole of the gap, and it is real without being dramatic.

## 3. The census — and the third door, which had not been named

The property, stated so it can be censused:

> **A write that changes which policies reach an object, authorized by a permission weaker than the one that authored those policies.**

Censused filterlessly over `apps/server/src`, `packages`, `tools`, `scripts` — every `.insert`/`.update` against `objects` and `relationships`, and every call site of the four repo functions — not by grepping for `contains`.

| # | Route | How containment changes | Status |
|---|---|---|---|
| 3.1 | `objects.domain_id` | every typed `PUT`/`PATCH`, IaC apply, federation import | **RECORDED** (§5) |
| 3.2 | `objects.domain_id`, **second write site** | `upsertObjectByUrn`'s hand-fill reconciliation branch, which deliberately does **not** delegate to `updateObject` | **RECORDED** (§5) |
| 3.3 | the `contains` edge | `POST`/`DELETE /relationships`, IaC apply, `components-repo.ts`'s `setComponentService`, `POST /discovery/accept`, federation import | **RECORDED** (§5) |
| 3.4 | **tombstoning a container** — writes no containment field at all | `DELETE` on any object that contains others | **RECORDED** (§5) — see below |

### 3.4 is the third door, and it is the widest of the three

Routes 1 and 2 are both a write to a containment *value*. This one is neither.

Every containment route in `graph/containment.ts` joins `parent.deleted_at IS NULL` — deliberately, so "a deleted service must not go on governing live components". The consequence had not been stated: **soft-deleting a container silently detaches everything beneath it**, under `object:write` at the container, while every child's own `domain_id` still reads as correct. One delete moves an unbounded number of objects out of reach of every policy anchored at or above the container, and unlike a re-parent nothing about the children changes, so there is nothing to notice.

**It is not covered by the edge cascade it appears to share.** `deleteObject` tombstones the row and *then* cascades `deleteRelationship` over its edges. By the time a cascaded `contains` delete runs, the container is already tombstoned, so route 2's before-reach has already lost it and the diff is empty. The per-child recorder is **inert** on this path — measured, and the reason route 3 is instrumented separately with its capture taken *before* the tombstone. Pinned as `CASE 4`.

### Verified clear, or out of scope

- **Placement properties (containment routes 3+4)** — `componentId` / `deploymentTargetId`. There is **no update door**: `placements.ts` offers no `PATCH` by design ("a placement's properties ARE its identity"), and `PAIR_BOUND_OBJECT_TYPE_IDS` refuses the type at the generic `/objects` route, the federation overlay route, IaC apply and discovery accept. Write-once, so there is nothing to instrument. Their *deletion* is covered by 3.4, which counts placements naming the deleted object.
- **Direct table writes that bypass the four repo functions** — `approvals-repo.ts:317` (hardcoded `approves`), `publish-domain-local.ts:205` (locality columns), `campaign-reconcile.ts:465` (`updatedAt`), `load-test/graph-scale.ts` (dev-only, `depends_on`). None touches `domain_id` or writes a `contains` edge. No migration does DML on either table; nothing in `packages/`, `apps/web`, `tools/` or `scripts/` writes them.
- **Labels, ownership edges, CEL `subject.labels`, IaC stack labels, `properties.region`** — the *same property* through a non-containment match key. Owned by [governance-label-namespace.md](governance-label-namespace.md) §8; not re-litigated here.

### Two authorization defects found while censusing, reported not fixed

Neither is a reach-recording problem, and both are someone else's decision:

- **`POST /api/v1/discovery/accept` is the widest relationship door in the codebase.** It mints a relationship with a `typeId` taken **straight from the request body** — `contains` included, and the three system-managed types the generic route and IaC apply both refuse — on nothing but `object:write` at the org root (`routes/executors.ts:884-889`, `:954`). No `relationship:write`, no both-endpoint check, no system-managed refusal. The *recording* half is covered (it calls `createRelationship`); the authorization half is not, and it should be brought to parity with `routes/relationships.ts`.
- **`updateObject` never validates the destination.** There is no `resolveDomainId`/`resolveContainmentParent` on the update path, unlike `createObject`, so a new `domain_id` is written verbatim with no proof it names a live object in this org. The *authorization* half is #244's `resolveDeclaredContainmentParent`, now merged; the *validation* half appears to be nobody's.

## 4. THE OWNER DECISION — prevention, and why it is not taken here

Detection (§5) changes no write ergonomics and is shipped. Prevention does, and this section asks for a ruling rather than taking one.

### (a) Require `policy:write` when a move drops a policy

The symmetric-sounding answer: if the act changes what governance reaches, hold it to the bar that authored the governance.

Rejected as an implementer's default, for the reason that sank option (b) of the label proposal:

1. **Its trigger is *computed*, so no operator can predict it.** "You may move this component" becomes a function of policy documents the mover may not be able to read. The same reorganisation succeeds on Monday and 403s on Tuesday because SecOps authored a document in between, and no error message can usefully explain that.
2. **`policy:write` is `Administrator`/`Owner` only.** Ordinary estate reorganisation — the daily work of a platform team — would start requiring an administrator whenever it crossed a governed boundary. That is a large ergonomics regression to close a gap whose actor is, by §2, already trusted at both containers.
3. **It is asymmetric in the wrong place.** A move that *adds* governance is tightening and harmless, but "changes the matching set" catches both. Refusing only reductions is possible (§4c) but makes the trigger even harder to predict.

### (b) A new `governance:move` permission

Avoids conflating "may author policy" with "may move a governed object", and could be granted to `Operator` by default (making it a no-op until an org tightens it) or withheld (making it §4a with a better name). Costs a new permission in the enum, in the built-in roles, and in every org's mental model.

**This is the option worth an owner's attention**, because it is the only one that lets an org *choose* its posture without the platform choosing for everyone.

### (c) Refuse only a move that drops a `required` policy

The narrowest prevention: `enforcement: "required"` is already the "this blocks" tier, so dropping one is the only case with teeth. `advisory` policies moving in and out would stay free.

Cheapest to reason about and the smallest ergonomic hit, but it still has §4a's unpredictability, and it makes `enforcement` load-bearing for authorization in a way it has never been.

### Recommendation

**Ship detection now (§5); take (b) if the owner wants prevention at all, defaulting the new permission to `Operator` so nothing changes until an org opts in.** The gate-1 flip is then the org's, not the platform's.

The honest case for detection-only being *enough for now*: the actor is already trusted at both containers, the act is loud (the object visibly moves; its service board entry, placements and pipeline bindings all follow it), and the record now names the policies and the actor. That is a materially different situation from the label escape, which was invisible and produced one indistinguishable `object.update`.

## 5. What the PR changes

**5a. `governance/governance-reach.ts`** — `policyReachFor` (the set of policies matching an object, keyed by policy id) and two recorders: `recordGovernanceReachChange` for a move, and `recordContainerDeletionReachChange` for route 3.4, which needs its own because a deleted container's *own* reach is unchanged by construction (`containmentChain` filters ancestors on `deleted_at` but deliberately not the target), so the generic diff would be empty, run, and look installed.

Keyed by **policy**, not by (policy, matched object): a move that keeps a policy but changes where it attaches has not changed what governs the object, and recording it would bury the cases that did.

**5b. Installed at the REPO choke points**, not the routes — the opposite side of ADR-0031's split, and deliberately. Authorization belongs at the door because it needs a real requesting subject; a **recording** has the opposite requirement — it must happen on every write regardless of actor, precisely so a reach change arriving through a federation import or an IaC apply is as visible as one arriving through `DELETE /relationships/{id}`. Five sites: `updateObject`, `upsertObjectByUrn`'s hand-fill branch, `createRelationship`, `deleteRelationship`, `deleteObject`. That covers every door — typed routes, generic routes, IaC apply, discovery accept, federation import, hand-fill, overlays — without enumerating any of them.

**5c. Persist-on-change, which is the whole contract and not an optimisation.** A recorder that wrote a row per containment write would reproduce a defect already paid for in production: a gate re-writing a byte-identical Decision every tick, 1.44 GB/day, 99.94% duplicates. "Reach changed" is a genuine edge, so row count is bounded by real reorganisations.

**5d. Cost, confined to genuine reorganisations.** The label proposal rejected a detection remedy partly on cost — two `matchPoliciesForTargets` calls on `createObject`, which the M1 DoD budgets at 5,000 sequential creates. That objection does not transfer, and the difference is structural:

- a **create is never a move**, and is not instrumented at all;
- an **update** pays nothing unless `domain_id` changes value — a `PATCH` that renames, or a `PUT` restating the parent it already has, short-circuits before any query (`CASE 3b`);
- a **relationship write** pays nothing unless its type is `contains` (`CASE 6`);
- a **delete** pays one indexed count, and nothing more unless the object actually contained something (`CASE 4b`);
- an **org with no policies** pays one indexed `SELECT`, because `matchPoliciesForTargets` returns early on an empty candidate list.

**5e. Blast radius is stated, not implied.** The delta is computed for the moved object, not its descendants — walking a subtree is unbounded work on a write path. It is not a gap in what the record *means*, because every scope kind is anchored on the containment chain: a policy that stops reaching the moved node stops reaching everything beneath it by the same edge. The Decision says so in `inputContext.appliesToDescendants` rather than leaving a reader to assume. For route 3.4 the record additionally carries `dependentCount`, and names the policies as `mayNoLongerReach` rather than `lost` — a descendant reachable by a second route keeps its policy, and calling that a loss would make the record wrong rather than conservative.

## 6. What an operator will notice

Nothing about what they may do. Two new artefacts appear:

| Artefact | Where | When |
|---|---|---|
| `Decision` `kind: "governance.reach.changed"`, verdict `reach_reduced` \| `reach_extended` | `decisions`, subject = the moved object (or the deleted container) | only when the matching policy set actually differs |
| Audit event `action: "governance.reach.changed"`, `reason` naming the policies, linked by `decisionId` | the org's hash chain | same |

The audit `reason` names the policies in full, so the hash-chained log is readable without joining to `decisions` — an operator must be able to see *which* gate stopped applying, not merely that something did.

## 7. How installation is proved

`governance-reach.integration.test.ts` drives **real doors** for all nine cases — HTTP, or the repo function a route calls — never `recordGovernanceReachChange` directly. A suite that reaches the guard directly cannot distinguish "decides correctly" from "actually runs", and this project's dominant defect is a component that is unit-tested green and inert.

Each of the five call sites was deleted alone against a green suite, and exactly one named case was watched to fail:

| Mutation | Case that died |
|---|---|
| `updateObject` (route 1) | CASE 3 |
| `deleteObject` (route 3.4) | CASE 4 |
| `createRelationship` (route 2) | CASE 5 |
| `deleteRelationship` (route 2) | CASE 1 |
| `upsertObjectByUrn` hand-fill (route 3.2) | CASE 7 |

Three cases pin the **negative** half — `3b` (a non-move), `4b` (a leaf delete), `6` (a non-`contains` edge) — because a suite made only of positives cannot tell a correctly-scoped recorder from one that fires on everything.

## 8. What this deliberately does not do

- **It does not prevent anything.** §4 is the open question.
- **It does not authorize route 1's move.** That is #244's `resolveDeclaredContainmentParent`, already merged; this branch is rebased on it, adds no authorization to any path, and does not touch `routes/relationships.ts`. All 78 of #244's containment tests pass alongside this change.
- **It does not record reach changes from non-containment match keys** — labels, ownership edges, CEL conditions. Same property, different key, owned by the label-namespace proposal.
- **It does not fix the two authorization defects in §3**, which are reported with their remedies because each is a separate decision with its own blast radius.

---

## 9. Owner rulings of 2026-08-17/18 — the design, in ask form (2026-08-18)

**Status:** v0.1 — written on `claude/ui-review-worktree-efc42b` (main through #261 merged) by the UI session, which was handed both rulings by the M24 (#244) session and confirmed ownership across sessions; **the asks in §9.6 confirm the relayed rulings with the owner directly** before anything is built. Grounded by a filterless read of the code at branch tip (file:line below are at HEAD `b9b38ca1`).

The two rulings as relayed (owner's words where they exist):

1. **§4(b) is taken:** a new `governance:move` permission, and its enforcement is a **top-down monotone lattice** — *"flipped on/off at the commander level; if enabled there, orgs can't disable it; same with the next layer … if an org enables it, a service can't disable it."*
2. **Deleting a container that still has containment children is refused** (using the `dependentCount` `deleteObject` already computes), with the same carve-outs the edge cascade has (`federationImport`, `removedForeignShadow`).

### 9.1 What is real (measured)

- **Move authorization today (#244):** `graph/containment-parent-authz.ts` `resolveDeclaredContainmentParent` (:125-303) authorizes the DESTINATION then the SOURCE with the caller's permission (`object:write`, or `policy:write` for governance-managed types); two **org-root exemptions** — destination (:173-235, "the org root is not a destination that gains custody") and source (:249-300, "the org root cannot lose custody of anything that stays inside the org"). Doors: every typed/generic `PATCH`/`PUT` that writes `domainId` on an existing row; **`POST /plans/{id}/apply` authorizes at APPLY time with the REAL applying principal** through a drained `ScopeCheck[]` (`iac/plans-repo.ts` :863-1020, the containment twin at :993-1004 mirroring both exemptions) — so a new authorization must be added there too or it ships inert on IaC; the `contains` route has its own doors — `PUT /components/{id}/service` (`graph/components-repo.ts` `setComponentService` :159-244, `relationship:write` at both services) and generic `/relationships` `POST`/`DELETE` of type `contains`. Discovery accept / overlay / hand-fill / federation import reach `createObject` directly (creates, no move question) or carry a synthetic subject.
- **Roles:** `Permission` union at `authz/resolve.ts:29-48`; built-in templates seeded by migration (`0002:207-224`, `0010:174-184`); **there are no custom roles and no route that authors roles or bindings** (`insert(roleBindings)` only in org bootstrap). **Operator, Approver, Administrator and Owner all hold `object:write`**; `policy:write` is Administrator/Owner only. `deny` bindings exist (`effect` column, deny-override at `resolve.ts:216`).
- **The unlock precedent to reuse:** `dependency_subscription_unlock` (`0062:97-125`): instance singleton (`CHECK id = 'default'`), `FORCE ROW LEVEL SECURITY`, tenant SELECT-only policy, no write policy; `PUT` is operator-token only (`routes/dependency-subscriptions.ts` `requireOperator` :192-203, raw admin pool for the write :268-319); tiers `instance | org | containment_domain | service | component` derived from each chain entry's own `typeId` (`subscription-resolution.ts` `tierForObjectType` :199-211, `gatherSubscriptionCandidates` :705-739 over `containmentChain`).
- **Delete today:** `objects-repo.ts` `deleteObject` (:1432-1680) — route-1 orphan guard (live `domain_id` children → refuse, before the tombstone, skipped under `federationImport`; :1520-1543), then `countContainmentDependents` (:1553 — used only to decide whether to record a reach Decision, **never to refuse**), tombstone (:1560), cascade over relationship EDGES (`!federationImport && !removedForeignShadow`, :1600-1625; **edges only — a service's components stay live and orphaned**), audit, `recordContainerDeletionReachChange`, journal (skipped for `federationImport` / `removedForeignShadow` / `domainLocal`). `countContainmentDependents` (`governance/governance-reach.ts` :197-219) counts **three** things: `domain_id` children, `contains` children, and **placements naming the row as component or target**. **Deleting a component today leaves its placements live and dangling** (placements reference the component by JSON property, not by an edge the cascade sees). `graph/domain-delete-orphan-guard.integration.test.ts` carries a **control** asserting `contains`-container deletes are NOT refused ("so this guard cannot quietly widen") — ruling 2 inverts that control, with the reason written in.
- **Detection (#249):** `governance.reach.changed` Decisions at five repo sites (`objects-repo.ts` :1105/:1372/:1640, `relationships-repo.ts` :496/:663) — untouched by this design.
- **Web:** no object-delete UI exists anywhere in `apps/web`; `registry-detail.tsx` is the one generic detail page; Admin nav = Identity · Plugins · Access Tokens · Dependencies.
- **Protected (byte-unedited, must stay green):** `routes/containment-move-authz`, `routes/containment-move-cycle-and-source-authz`, `governance/governance-managed-write-doors` (the `policy:write` door census — about doors that mint a `policy` object from a caller-supplied `typeId`; a projection-table write does not enter it), `dependencies/subscription-authoring-guard`. Every enforcement below is OFF until a rung is set, so those suites' outcomes do not move.

### 9.2 Ruling 1 — `governance:move` as a top-down monotone lattice

**Semantics (uniform, predictable — the §4(a) trap avoided):** enforcement is a set of **enabled rungs**; a rung is *the instance* or *one container object* (org root, containment domain, service, assembly). Enforcement **applies to a move** iff the instance rung is enabled or **any object on the moved object's containment chain (source) or on the destination container's chain has an enabled rung** — the monotone OR: an upper rung's enable cannot be undone below it. When enforcement applies, the actor must hold **`governance:move` at-or-above the moved object AND at-or-above the destination container** (the mirror of #244's `object:write` pair, so an operator learns one rule) — **with no org-root exemption**, written as a decision beside #244's two: leaving a governed subtree for the org root is exactly the reach reduction this permission gates, so the org root as a destination is *not* custody-neutral for governance. There is **no computed trigger**: whether a move needs the permission depends only on which rungs are set, never on which policies happen to match. Nothing changes until a rung is enabled (default: none).

**Storage (peer-suggested shape, taken):** `governance_move_rungs (org_id, subject_object_id PK, tier text — the literal at write time, org|containment_domain|service|assembly — enabled_by_object_id, enabled_at, decision_id)`; the instance rung is a separate singleton `governance_move_instance_rung (id='default' CHECK, enabled bool, updated_at)` with the unlock table's RLS/grant shape (tenant SELECT-only, FORCE RLS, operator-token `PUT`, raw admin pool). One migration, `0079` (`when` > 1788139911505; renumbered at merge by the second-to-merge rule).

**Resolution (one function, reused by doors, read route, CLI, UI):** `resolveGovernanceMoveEnforcement(tx, orgId, {objectId})` → `{ enforced, instance: {enabled}, rungs: [{tier, subjectObjectId, name, enabledAt, enabledBy}] }` walking `containmentChain` (loud, ADR-0035) and joining the rung table by id; tier labels read from the stored literal (explainability only, never recomputed). Doors call it for source and destination and OR the two.

**Doors (authorize at the door — the invariant/authorization split M24 settled):** (a) `resolveDeclaredContainmentParent` — after its `object:write` pair, if enforcement applies, `authorize(governance:move)` at the moved object and at the destination (no exemptions); (b) the **apply-path twin** in `plans-repo.ts` adds the same two `ScopeCheck`s (a door-only fix ships inert on IaC — proven by mutation in #244); (c) `setComponentService` and generic `/relationships` `POST`/`DELETE` of type `contains` — the moved object is the `to` (child), the destination the `from` (container); on `DELETE` the destination is the org root (the child falls back to its `domain_id` route). Federation import / overlay / hand-fill are **carved out and commented** (synthetic or drained subjects; the receiver does not referee). Detection stays where it is.

> **AS BUILT (2026-08-18), the door list is longer than this paragraph was, and the correction is the point.** Review found two live bypasses after the first round shipped, both of the same shape: the twin had been added where the hole was found rather than to the class. (i) `plans-repo.ts`'s **relationship** loop mints and prunes `contains` from a manifest with `relationship:write` alone — and a manifest's `component.service` change compiles to exactly that pair — so door (b) needed a route-2 twin as well as the route-1 one. (ii) **`POST /discovery/accept` is a door, not a carve-out**: it reads its proposal from the REQUEST BODY under `requireAuth`, and both endpoints may resolve to live rows, so it mints a containment parent with a real principal (§3's own census called it "the widest relationship door in the codebase"). Both now call `assertGovernanceMoveAdmits`. In both, an object **created in the same request** is exempt — a create has no prior reach to leave, and no door gates a create.

**Writes (the rung API):** `PUT /governance/move-enforcement/rungs/{idOrUrn}` (enable; `policy:write` at-or-above the subject — a governance-authoring act, same bar as authoring a policy) → 200 with the resolved state and a `decision_id`; `DELETE …/rungs/{idOrUrn}` (disable) → **409 when an upper rung is enabled**, naming it (*"orgs can't disable it"* — the state must not silently stay enforced after a "successful" disable); `GET /governance/move-enforcement/rungs` (list, `object:read` at org); `GET /objects/{idOrUrn}/governance-move-enforcement` (the explain read: enforced + why); instance rung `GET`/`PUT /instance/governance-move-enforcement` (operator token, exactly the unlock shape). Every write records a Decision (`kind: governance.move_enforcement`) and an audit event in the same transaction (principle 6). SDK + CLI (`scp governance move-enforcement status <object> | enable <object> | disable <object> | rungs | instance get|set`).

**Refusal shape (one sentence, both doors):** *"moving '<X>' is governed here — governance:move enforcement is enabled at <tier '<name>'> (and above); '<subject>' lacks 'governance:move' at <the object | the destination>. Ask an Administrator to move it, or disable enforcement at that rung (policy:write)."* 403 with `decision_id`.

> **SHIPPED WITHOUT `decision_id` — an open deviation, not a settled decision (2026-08-18).** Every door
> throws from inside the caller's `withTenantTx`, so a Decision written there is rolled back with the
> refusal it explains and the id would name a row that does not exist. The refusal instead carries the
> whole explanation in its sentence (which rung, which tier and name, which END the actor lacks the
> permission at), which is also what #244's existing move refusals do. This is a charter-principle-6
> deviation and is **awaiting an owner ruling**: either thread a `Db` handle to the doors and persist
> the Decision out-of-band before throwing (`federation/promotion-repo.ts` does exactly that — record
> in a fresh committed transaction, then throw), or accept sentence-only for door refusals and say so
> in an ADR. Until then this paragraph and `governance/move-enforcement.ts`'s header disagree with the
> line above on purpose, and the code is the honest one.

**Who holds `governance:move` — the lever that decides whether the switch does anything (§9.6 Q2).** With today's built-in roles and no custom roles: if Operator-and-above hold it, **every principal who can move can also move under enforcement — the lattice is inert until custom roles exist**; if Administrator/Owner only, enabling a rung makes "moving a governed object" an Administrator act under that rung — teeth today, at the cost §4(a) named, but opt-in per rung and predictable.

### 9.3 Ruling 2 — refuse deleting a container that still has containment children

**Rule:** before the tombstone, if `countContainmentDependents` > 0, refuse **409** naming the blockers (type, name, route) — the exact shape of the route-1 orphan guard, widened from `domain_id` children to **all three routes** (`domain_id` children · `contains` children · placements naming the row) — §9.6 Q3 decides whether placements are in. Carve-outs mirror the cascade: `federationImport` (a peer's tombstone arrives by journal; the receiver applies it) and `removedForeignShadow` (local cleanup of a foreign shadow row). Remedy in the message: move or delete the children first (a service's components: `PUT /components/{id}/service` to another service, or delete them; placements: `DELETE /placements/{id}`). The `domain-delete-orphan-guard` control test flips from "contains-children deletes are NOT refused" to "ARE refused", with the reason written where the old reason was.

**Why the widening is not the "quiet widening" that control guarded against:** the old asymmetry was deliberate (route-2 children were meant to survive as orphans); the owner ruling retires it. What the control now protects is the carve-out set — a `federationImport` delete with children must still land, or a peer's bundle wedges.

**Consequence worth stating:** deleting a component with placements is refused too (today those placements are left live and dangling — a pre-existing gap this closes by refusal rather than by cascade; §9.6 Q3 offers the cascade alternative).

### 9.4 UI (this session's rung)

No delete UI exists, so ruling 2 has no web surface (CLI/API/IaC render the 409). For ruling 1: an **Admin › Governance** page (commander site — the tenant's org config; outpost sites carry it too, since enforcement is per-instance and an outpost's local moves are real moves): instance rung (read-only + CLI pointer, unlock precedent), the org rung as a switch, and the list of enabled rungs with **Enable at… (container picker) / Disable** — every write offered, the 403 (`policy:write`) and the 409 (upper rung) rendered verbatim with a Why link. Optional (Q4): a read-only "moves here are governed — enabled at <rung>" line on domain/service detail pages.

**Built (2026-08-18):** SDK facade `client.governanceMove.{enforcement,rungs,enable,disable,instance,setInstance}` in `packages/sdk/src/client.ts` (built by the server round, confirmed generated and typechecked here). CLI: `scp governance move-enforcement status <type> <idOrUrn> | rungs | enable <idOrUrn> [--note] | disable <idOrUrn> | instance get | instance set --enabled <bool>` in `packages/cli/src/cli.ts` (the `status` verb takes `<type>` explicitly — the server's explain read binds under `/objects/:type/:idOrUrn/…`, so there is no id-only resolution to hang a single-argument form off); exported row formatters `governanceMoveRungRow`/`governanceMoveEnforcementRow`/`governanceMoveInstanceRow`/`governanceMoveRungWriteRow`; pinned in `governance-move-cli.test.ts` (closed verb lists, formatter negative controls) and `governance-move-cli-wire.test.ts` (action bodies driven through `buildProgram().parseAsync`, mutation-sensitive per the M21 "component built, never installed" lesson). Web: `apps/web/src/routes/admin-governance.tsx` (`AdminGovernancePage` — three reads: rungs list, instance rung, the three container-picker lists at `limit: 100`; the org rung switch on `useAuth()`'s `orgId`; the enabled-rungs table, `org` tier excluded since the switch already represents it; Disable fires on one click with no confirm dialog, deliberately — the 409 sentence already explains the consequence a confirm step would preview; Enable at… opens a container-picker dialog over `client.domains/services/assemblies.list`) and its test `admin-governance.test.tsx` (26 cases: no role/wire gate, instance write absent from the DOM by exhaustive scan, empty state pending-safe, 403/409 rendered verbatim with conditional Why link, picker query validated against `ObjectListQuerySchema`). Route `/admin/governance` in `apps/web/src/router.tsx`, pinned in `router-paths.test.ts` with a component-identity pin. `COMMANDER_NAV` **and** `OUTPOST_NAV` Admin sections both gain `{ to: "/admin/governance", label: "Governance", icon: Scale }` in `apps/web/src/components/layout/AppShell.tsx`, both pinned in `app-shell-nav.test.tsx`. Query keys `governanceMoveRungsKey`/`governanceMoveInstanceKey` in `apps/web/src/lib/query-client.ts`. `docs/design-system.md` §3.1 icon table gains the Governance/`Scale` row. Not built (IaC rungs, per-object "governed here" lines): explicitly deferred to a follow-up per §9.6 Q4-A.

### 9.5 Tests / gates

Protected four byte-unedited (their outcomes cannot move: no rung set). New `governance/move-enforcement.integration.test.ts`: lattice resolution (instance ⇒ all; org ⇒ services can't disable → 409; disable at the enabling rung → moves free again); every door refuses under enforcement for an Operator (typed PATCH, generic PATCH, PUT upsert, apply twin, `PUT …/service`, `/relationships` contains POST+DELETE) and admits an Administrator; org root as destination NOT exempt; import/hand-fill carve-outs land; the explain read names the rung; mutation log (each door check removed → its case red; the apply twin removed → only the IaC case red — the M24 lesson). **Extended after review (2026-08-18):** an IaC `contains` create AND prune case (m2b — removing only the relationship-loop call reddens it alone), a discovery-accept case on a PRE-EXISTING child (m9), and the created-in-this-batch SUCCESS half that keeps the carve-out honest (m9b). `graph/container-delete-guard.integration.test.ts`: service with components → 409 naming them; assembly; component with placements; `federationImport` + `removedForeignShadow` land; empty container deletes fine; domain guard unchanged. Migration journal-ordering test; RLS pin for the instance table (tenant cannot write). CLI unit pins for the printers.

### 9.6 Questions (ask form) — **owner decisions 2026-08-18: every recommendation taken** (Q1 A activates; Q2 A Administrator + Owner; Q3 A all three routes; Q4 A API+SDK+CLI+Admin › Governance page, IaC + per-object lines follow-up)

1. **The instance (commander) rung — does it ACTIVATE or PERMIT?** Your words: *"flipped on/off at the commander level; if enabled there, orgs can't disable it."* **(A, recommended)** **Activates**: instance enabled ⇒ enforced for every org and every object on this instance; orgs may additionally enable for themselves when the instance is off. **(B)** Permits (the M21 unlock precedent — the peer's inference, not your words): instance enabled only allows orgs to enable; nothing is enforced until an org does. (A) is what the quoted sentence says; (B) is the dependency-subscription shape, which is different because there the instance is unlocking automation that writes to tenants' repositories.
2. **Who holds `governance:move` by default?** **(A, recommended)** Administrator + Owner (the roles that already hold `policy:write`) — enabling a rung then means "moves under here are an Administrator act"; the daily Operator reorganisation continues everywhere no rung is set. **(B)** Operator and above — nothing changes for anyone today (every writer role holds it), the switch becomes meaningful only when custom roles exist (there is no way to author one yet). **(C)** Owner only.
3. **Ruling 2 — which children block a delete?** **(A, recommended)** All three routes: `domain_id` children, `contains` children, and placements naming the row (closes today's dangling-placement gap by refusal; one rule, blockers named). **(B)** `domain_id` + `contains` children refuse; placements CASCADE with their component/target (a placement is pair-derived, so deleting an endpoint deletes it — a behaviour change beyond the ruling, but the tidier end state). **(C)** `domain_id` + `contains` only; placements stay dangling as today (not recommended).
4. **Scope this round.** **(A, recommended)** API + SDK + CLI + the Admin › Governance page (§9.4) now; IaC rungs and per-object "governed here" lines as a follow-up. **(B)** Also IaC (a manifest entry for rungs through the plans-repo door, the producer-declaration precedent) and the per-object lines now. **(C)** API/SDK/CLI only; UI later.
