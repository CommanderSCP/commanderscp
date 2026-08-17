# A reserved governance label namespace — the match key must be out of the subject's write reach

**Status:** v0.1 Draft — **proposed, pending review.** The code in the accompanying PR implements §5; §7 lists what it deliberately does not do and §8 the census instances left open. An ADR (0034) follows owner approval.
**Relates to:** [ADR-0003](../adr/0003-internal-egress-for-execution-systems.md) (the declaration-grants-nothing shape this copies), [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md) (the six-tier `scanThreshold` chain a selector-scoped policy can carry), [ADR-0031](../adr/0031-domain-local-objects-never-federate.md) ("authorization at the door, invariant at the repo"), [ADR-0032 §6a](../adr/0032-dependency-subscriptions.md) (the choke-point precedent this installs beside), [ADR-0033 §3](../adr/0033-scan-exclusions-and-overrides.md) ("**never key on `labels`** … already a live evasion path for selector-scoped policies — tracked separately"; this is that tracked item).

---

## 1. The defect

`governance/policy-resolve.ts` matches a policy whose `scope.selector.labels` equals a subset of `objects.labels` on **any** object in the target's containment chain.

Two permissions meet at that comparison, and they were not the same size:

| Act | Permission required, before this change |
|---|---|
| Author a `selector`-scoped policy | `policy:write` **at the org root** — `policy-scope-authz.ts` demands the widest bar there is, "precisely because a selector has org-wide blast radius" |
| Write the labels that selector matches on | `object:write` **at the object** — i.e. the object's own owner. No schema (`drizzle/0002` registers every type's `labels` with nothing at all), no reserved prefix, no validation of any kind |

So **the subject of a constraint could leave its reach by deleting one map entry.**

Concretely: SecOps authors `scope: {selector: {labels: {tier: "pci"}}}` carrying `requireApprovals` and a strict `scanThreshold`. The component's owner drops `tier` from the component's (or its service's) labels. `labelsMatch` stops matching, the policy stops contributing, and every gate it fed goes quiet. There is no error, no audit event, and no Decision recording that governance reach changed — a constraint that fails to match is a constraint that does not apply, and this one failed to match silently.

The attack does not even need a "remove label" API. `updateObject` replaces `labels` wholesale, so an ordinary full-replacement `PUT` that simply *does not mention* the key is the whole exploit.

## 2. The property, stated so it can be censused

> **A governance decision whose match key is writable by its own subject, at a strictly weaker permission than the one that authored the constraint.**

§8 reports every instance found. Two are fixed here; four are reported with their remedies, because their remedies are different and one of them is a separate design decision.

## 3. Options considered

### (a) Emit a high-severity audit event when a label change alters which policies match

Cheapest to build. Rejected on three counts:

1. **It is detection, not prevention.** The gate still stops firing. The operator learns about it from a promotion that sailed through, after the fact.
2. **It costs a full policy scan plus a containment walk on the hottest write path in the system.** Answering "did this change which policies match?" means resolving the before-and-after match sets. `createObject` already runs against a 5,000-sequential-create budget in the M1 DoD; this would add two `matchPoliciesForTargets` calls to every labelled write.
3. **It is not what charter principle 6 asks for.** A Decision explaining a verdict is explainability. A Decision explaining that a verdict silently stopped happening is a log line with better formatting.

### (b) Freeze whatever label keys the org's policies happen to name

No new namespace, no re-keying, no migration: at write time, collect the label keys any live policy selector names and require elevated authority to touch one.

Rejected because the blast radius is enormous and invisible. The day SecOps authors `selector: {env: "prod"}`, **every team in the org loses the ability to set `env` on anything** — including at create. Governance reach becomes a function of documents the writer cannot see, and describing your estate starts returning 403s for reasons no error message can usefully explain.

The tension it runs into is the real one: `env` is exactly the label a selector wants **and** exactly the label a team must be able to set. No rule that treats the two uses as one thing can resolve that.

### (c) A reserved namespace — **chosen**

Dissolve the tension by separating the two acts that were sharing one bag:

- `labels.tier` is a **description** the object's owner makes *about their own object*. Unchanged, as free as it is today.
- `labels["scp.governance/tier"]` is an **assertion an authority makes** about it. Out of the subject's reach, and the only thing a constraint may key on.

This is **ADR-0003's shape one layer up**. There, an execution system's `allowInternalEgress` property "is a per-system DECLARATION of intent, not a grant" and buys nothing unless an operator-set value outside tenant write reach (`SCP_INTERNAL_EGRESS_HOSTS`) independently agrees. Here the tenant's `tier: pci` likewise grants and relieves nothing; the operator-set `scp.governance/tier: pci` is the only thing the matcher sees.

**Against charter decision priority #1 (Simplicity):** (c) is one sentence — *a `scp.governance/` label is set by org-root `policy:write` and nothing else* — with one place to enforce it and one place to check the consumers. (a) is a second, weaker mechanism bolted beside a hole that stays open. (b) is a rule whose behaviour at any moment depends on documents elsewhere in the graph, which is the opposite of simple even though its diff is smaller.

## 4. Why the bar is org-root `policy:write`

Because that is the bar at the **other end of the same constraint**. `assertPolicyScopeWithinAuthority` already requires org-root `policy:write` to author a selector-scoped policy. If a governance label could be written with `policy:write` scoped at a *component*, a component-level administrator could clear the key an org-level SecOps policy matches on — which is the original evasion with one more permission and no more authority.

**Ergonomics, since org-root authority sounds heavier than it is.** `labelsMatch` runs over the whole containment chain, so an operator labels a **domain or a service once** and every component beneath it is governed. There is no per-component labelling chore, no new surface to learn, and no new place to look: a governance label is an ordinary entry in an ordinary `labels` map, readable by anyone who can read the object. `CASE A1`/`A5` in the integration test pin exactly this.

## 5. What the PR changes

**5a. The namespace.** `GOVERNANCE_LABEL_PREFIX = "scp.governance/"`. A literal prefix test with no case folding, no trimming and no normalisation — both readers of a label key compare with `===`, so any fuzziness would create a key that is reserved for the *write* check and a different key at *match* time, which is the evasion rebuilt inside the guard.

Deliberately **not** `scp:`, which `iac/plan-diff.ts` already uses for `scp:managed-by` / `scp:stack`. Those are stamped by IaC apply itself under `object:write`; reserving that prefix would break every apply. Their own exposure is §8.3.

**5b. The write rule** (`assertMayWriteGovernanceLabels`), installed at `graph/objects-repo.ts`'s `createObject`/`updateObject` and `graph/relationships-repo.ts`'s `createRelationship` — the choke points every local write door funnels through, never per route. `routes/*.ts` alone admits `labels` on eighteen handlers, and ADR-0032 §6a's own write-doors test already records three doors that reach `createObject` without passing through `typed-registries.ts` at all.

It compares a **delta over the stored row**, which matters twice: a `PATCH` that never mentions `labels` resolves no permission at all (so this is off the cost of the ordinary write path), and a full-replacement `PUT` that *omits* a governance label is a **removal** and is refused. Those two are the same bytes on the wire; only the stored row tells them apart.

A full-replacement write that omits the key is refused **loudly rather than silently repaired**. Merging the operator's keys back in would produce zero false positives and one bad true negative: an operator *with* `policy:write` doing a deliberate `PUT` to remove a governance label would be answered 200 and the label would still be there. Two behaviours where one will do, and the silent one is wrong for the actor who matters most.

**5c. The authoring rule** (`assertSelectorKeysAreGovernanceLabels`), at the same choke point: a `policy`'s `scope.selector.labels` may key **only** on governance labels.

Without this half the namespace is a feature, not a guard — an author who reaches for `{tier: "pci"}` (the obvious thing, and what `docs/DESIGN.md` §10.1's own example shows) gets a policy their subjects can still walk out of, with nothing to tell them so. `labels: {}` is left alone: it is an `every()` over zero entries, so it matches every ancestor unconditionally, keys on nothing, and cannot be evaded by editing anything.

**5d. The same rule for a peer's `custom` sync scope.** `federation/scope-filter.ts`'s `custom` mode decides which journal entries **leave this security domain**, and its own header says a scoped peer is scoped "precisely FOR confidentiality". The selector is authored under `federation:write`; the labels it matched were the object's own. A component owner setting `tier: gold` shipped their object across a domain boundary to a peer configured never to receive it — the same property, running in the *widening* direction and against confidentiality rather than a gate.

Enforced at peer-config **authoring** only (`pairPeer`, `updatePeerTransport`), keyed off the DECLARED scope. `entryMatchesScope` stays the pure synchronous predicate both ends apply to identical input, which is the entire basis of the import-side re-filter. An already-stored `custom` scope keeps filtering as it does today until someone edits it.

**5e. `assertPolicyScopeWithinAuthority` at the two doors it never reached.** Found while censusing: its own comment names a three-site census (typed `/policies`, `iac/plans-repo.ts` create, `iac/plans-repo.ts` update) and explains — correctly — that it stays at the doors rather than the repo because it is *authorization*, and pushing it down would run it for the federation importer's synthetic subject. But two doors were missing from that list:

- `POST /api/v1/federation/hand-fill` — free-form `typeId` + `properties`, `federation:write`;
- `POST /api/v1/federation/overlays` — free-form `typeId` + `properties`, plain **`object:write`**.

Either planted an org-wide `selector`/`group`/unscoped policy with **no `policy:write` anywhere**. `listPolicyCandidates` selects every live `type_id = 'policy'` row with no overlay exclusion, so an overlay policy is a first-class policy candidate the moment it exists; `assertPolicyOverlayOnlyAddsStrictness` reads `enforcement` and nothing else, by its own admission, and a `dependencySubscription` opt-out — whose entire effect is to turn something **off** — gets no protection from a strictest-wins merge.

Both now call it, with the real requesting operator, narrowed to `typeId === "policy"` exactly as the IaC calls are (a `control` carries no scope, so widening would impose an org-root bar the typed `/controls` route does not).

## 6. Behaviour changes an operator will notice

| Change | Who is affected | Migration |
|---|---|---|
| A `scp.governance/…` label needs org-root `policy:write` to add, change **or remove** | anyone doing a full-replacement `PUT` on a governed object | re-send the governance labels the object already carries, or use `PATCH` |
| A policy `scope.selector.labels` may only key on `scp.governance/…` | policy authors | re-key the selector and apply the label to the domain/service you mean to govern |
| A peer `custom` sync scope may only key on `scp.governance/…` | federation operators using `custom` (the exotic mode) | re-key; stored scopes are grandfathered until edited |
| Hand-fill / overlay of a `policy` now requires the same `policy:write` the typed route does | air-gapped operators hand-filling commander governance config; overlay authors | grant `policy:write`, or use the typed `/policies` route |

**Existing selector-scoped policies are grandfathered until edited** (nothing rewrites stored rows), and a federation import of one is accepted unchanged — the same grandfathering ADR-0032 §6a's guard took, and for the same reason: `import-repo.ts`'s `object_upsert` branch has no `try/catch`, so a refusal there aborts a whole signed bundle and wedges the channel.

## 7. What this deliberately does not do

**CEL conditions are not restricted.** `subject.labels` is in the CEL evaluation context (`evaluate.ts`'s `buildCelContext`), so `subject.labels.tier == "pci"` is exactly as evadable as the selector was. It is left alone for two reasons: statically restricting CEL text is fragile and would break legitimate *advisory* conditions that want tenant data ("warn if `labels.experimental`"); and the namespace already gives a condition author a tamper-proof key today — `subject.labels["scp.governance/tier"]` is now an operator-set fact. That is a documentation change, not a code one, and it is the honest scope. `cel-sandbox.ts` already documents the context as "partly attacker-controlled" for a different reason (complexity/DoS).

**Route-level write permissions are not changed.** Hand-fill still authorizes with `federation:write` and overlay with `object:write`, where `iac/plans-repo.ts`'s `writePermissionFor` demands `policy:write` for the same types. Raising that bar is a *new* decision with its own blast radius, not the completion of an existing one, so it is reported (§8.5) rather than taken.

### 7a. The residual that matters most — re-parenting, and it is MEASURED, not suspected

**A selector's reach is the containment chain, and the containment chain is tenant-writable.** This change makes the label immovable; it does not make the *chain* immovable, so a subject that cannot remove the assertion can still move out from under it.

Reproduced on a Testcontainers instance with the built-in **Operator** role at the org root (`object:write` + `relationship:write`, no `policy:write` anywhere), against a component governed by a service-anchored `scp.governance/tier: pci` label:

| Step | Result |
|---|---|
| `GET /api/v1/relationships?typeId=contains&toId={component}` | `200`, the edge is readable |
| `DELETE /api/v1/relationships/{edge}` | **`200`** — the containment edge is deleted |
| `POST /api/v1/relationships` re-attaching the component under an *ungoverned* service | **`201`** |
| `matchPoliciesForTargets({targets:[component]})` afterwards | **no selector match — the policy no longer reaches** |

`contains` is **not** in `SYSTEM_MANAGED_RELATIONSHIP_TYPE_IDS` (only `approves`, `coordinates`, `annotates` are), so the generic `/relationships` endpoint creates and deletes it freely. The `domainId` half is the same shape from the other side: `PUT /objects/{type}/{idOrUrn}` and `PUT /components/{urn}` both `authorize("object:write", scopeObjectId: found.id)` — **at the object being moved** — and then pass `domainId` straight to `updateObject`. **Nothing authorizes at the new parent, and nothing authorizes at the old one.**

This is deliberately **not** fixed here, for two reasons: it is a strictly larger decision (who may re-parent, and against whose authority — plausibly `object:write` at *both* the old and the new container, which changes every typed route), and it is *broader* than this defect, defeating `objectRef` scope, freeze scope and the ADR-0029 binding ladder as well as selectors. But it must be stated plainly rather than left implied: **after this change the label cannot be removed, and the object can still be moved.** Filed as its own task; it should be sequenced next, because it is the cheapest remaining route to the same outcome.

Two things make it materially different from the label escape rather than merely equivalent, and they are why shipping this first is still worth doing: re-parenting is **loud** (the object visibly moves, its service board entry changes, its placements and pipeline bindings follow it) where a dropped label was invisible; and it is **already audited** as a relationship delete plus a relationship create, where a label edit produced one indistinguishable `object.update`.

## 8. Census — every instance of the property, found filterlessly

> **A census hazard worth recording on its own.** Three source files in this repo contain **literal NUL bytes** used as join separators inside template literals — `apps/server/src/iac/plan-diff.ts`, `packages/iac/src/construct.ts`, `packages/sdk/src/response-validation.ts`. `file(1)` classifies them as `data`, and **`grep -r` silently skips them unless you pass `-a`**: `grep -rn labels` over `apps/server/src packages` returns 648 lines, `grep -arn` returns 670. The first of those files holds `isStackManaged`, the sole label test that makes a live object a *delete* candidate. CLAUDE.md's rule is "census with **no grep filters** — a filter is where the next instance hides"; here the filter is applied by grep itself, invisibly. Recommended follow-up: replace the raw NUL with `\0` so the files are text again.

| # | Instance | Decision it feeds | Status |
|---|---|---|---|
| 8.1 | `policy-resolve.ts` `scope.selector.labels` → `objects.labels` on the whole containment chain | which policies apply — `requireApprovals`, `requireControls`, `scanThreshold` ceilings, `emergencyPolicy`, `autoRollbackOnFailure`, `dependencySubscription` | **FIXED** (§5b, §5c) |
| 8.2 | `federation/scope-filter.ts` `custom` mode → `payload.labels` | whether a graph row **crosses a security-domain boundary** | **FIXED** (§5b, §5d) |
| 8.3 | `iac/plan-diff.ts` `isStackManaged` + `plans-repo.ts`'s `labels @> managedLabels(stack)` → `scp:managed-by` / `scp:stack` | the **prune pool**: which live objects and edges an apply *deletes* | **REPORTED.** Writing those two labels through `PUT /objects/{type}/{urn}` enrolls an arbitrary object in a stack's prune pool; removing them evades a prune. Not fixable with this namespace — IaC apply stamps them itself under `object:write`. The remedy is different in kind: stack ownership belongs in a server-side table (or a `managed_by_stack` column), not in the same tenant-writable bag it protects. |
| 8.4 | `coordination/regional-executors.ts` `readDeclaredRegionMembership` → `properties.environment` / `properties.region` | the **M15.6 no-silent-deploy gate**. Blank or absent ⇒ `null` ⇒ *the gate does not apply* | **REPORTED, and it is the sharpest of the four.** A `deployment-target` owner holding `object:write` removes `properties.region` and the gate silently stops firing — evasion by *deletion*, and the fail-open is the function's documented "SCOPE GUARD". Remedy: make un-declaring a region an explicit, audited act, or key the gate on something the subject does not write. |
| 8.5 | `assertPolicyScopeWithinAuthority` installed at 3 of 5 doors | may this actor author a policy this broad | **FIXED for the scope check** (§5e). The remaining half — those doors' *write* permission is `federation:write` / `object:write` rather than `policy:write` — is **REPORTED** (§7). |
| 8.6 | `coordination/correlation.ts` `labels ->> 'correlationKey'` | which `coordinated-change` group a change joins | **REPORTED, low severity.** An `object:write` holder can mint a `coordinated-change` carrying a chosen `correlationKey` and capture later correlations into it. Not a gate, but it does decide what is grouped with what. |
| 8.7 | `evaluate.ts` `buildCelContext` → `subject.labels` | any policy CEL condition | **NOT FIXED, by choice** — §7. The namespace gives condition authors a tamper-proof key; the tenant-writable half stays available and stays tenant-writable. |
| 8.8 | **The containment chain itself** — `contains` edges via `POST`/`DELETE /relationships`, and `domainId` via every typed `PUT`/`PATCH` | the reach of **every** scope kind: `selector`, `objectRef`, freeze scope, the ADR-0029 binding ladder | **REPORTED, measured, and the most important of the five** — §7a has the reproduction. A subject that cannot remove the assertion can still move out from under it, with `relationship:write` alone. Not fixed here because the remedy (authorize at both the old and the new container) touches every typed route and is a larger decision than this one. |

Checked and **clear**: waves/release topology (explicit `targets` refs), source mappings (real columns), controls, freezes (`scope_object_id`), scanner assignments, notification bindings, dependency-subscription selectors (`ecosystem`/`coordinate`/`major` on `properties.effects`), approval scope (object-type keywords on the chain).

## 9. How installation is proved

`governance-labels.test.ts` proves the guard *decides* correctly. It cannot prove the guard *runs*, and this project's dominant defect is a component built, unit-tested green and never installed — a suite that reaches the guard directly is exactly the shape that cannot tell the two apart.

So `governance-label-write-doors.integration.test.ts` drives **real doors** (HTTP requests, an IaC apply, the repo functions routes call) for all 28 cases, including the escape end-to-end: label removal is refused **and** `matchPoliciesForTargets` still returns the policy. Each of twelve mutations — deleting each call site, and two logic mutations — was applied alone against a green suite and the named cases watched to fail. The log is in the test file's header and in the PR body.
