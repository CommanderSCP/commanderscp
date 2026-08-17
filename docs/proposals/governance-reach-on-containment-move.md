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

Both containment routes are now two-ended (route 1's move authorization is `feat/m21-7-authz-and-pr-url`'s `resolveDeclaredContainmentParent`; route 2's has always been). **But two-endedness protects the CONTAINERS' holders, not the POLICY AUTHOR.** Nobody who holds `policy:write` is consulted, and nothing tells them afterwards. That is the whole of the gap, and it is real without being dramatic.

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
- **`updateObject` never validates the destination.** There is no `resolveDomainId`/`resolveContainmentParent` on the update path, unlike `createObject`, so a new `domain_id` is written verbatim with no proof it names a live object in this org. The *authorization* half of this is `feat/m21-7-authz-and-pr-url`'s and is landing; the *validation* half appears to be nobody's.

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
- **It does not authorize route 1's move.** That is `feat/m21-7-authz-and-pr-url`'s `resolveDeclaredContainmentParent`, landing separately; this change adds no authorization to any path and does not touch `routes/relationships.ts`.
- **It does not record reach changes from non-containment match keys** — labels, ownership edges, CEL conditions. Same property, different key, owned by the label-namespace proposal.
- **It does not fix the two authorization defects in §3**, which are reported with their remedies because each is a separate decision with its own blast radius.
