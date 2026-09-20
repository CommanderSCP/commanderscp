# ADR-0034: A reserved governance label namespace — the match key must be out of the subject's write reach

**Status:** **Accepted** (owner sign-off 2026-09-20; the mechanism below is built and merged — the guards are wired at the graph write doors on `main`).
**Context doc:** [docs/proposals/governance-label-namespace.md](../proposals/governance-label-namespace.md) — the full census (§8), the measured re-parenting reproduction (§7a) and the withdrawn §5e.
**Relates to:** [ADR-0003](0003-internal-egress-for-execution-systems.md) (declaration-grants-nothing — the shape this copies, one layer up); [ADR-0016](0016-scoped-scan-requirement-policies.md) (the six-tier `scanThreshold` chain a selector-scoped policy carries); [ADR-0031](0031-domain-local-objects-never-federate.md) ("authorization at the door, invariant at the repo"); [ADR-0032 §6a](0032-dependency-subscriptions.md) (the choke-point precedent this installs beside); [ADR-0033 §3](0033-scan-exclusions-and-overrides.md) ("never key on `labels` … already a live evasion path" — this is that tracked item).

## Context

`governance/policy-resolve.ts` matches a policy whose `scope.selector.labels` is a subset of `objects.labels` on **any** object in the target's containment chain. Two permissions met at that comparison, and they were not the same size:

| Act | Permission required, before this change |
|---|---|
| Author a `selector`-scoped policy | `policy:write` **at the org root** — the widest bar there is, precisely because a selector has org-wide blast radius |
| Write the labels that selector matches on | `object:write` **at the object** — its own owner. No schema, no reserved prefix, no validation |

**The subject of a constraint could leave its reach by deleting one map entry.** SecOps authors `scope: {selector: {labels: {tier: "pci"}}}` carrying `requireApprovals` and a strict `scanThreshold`; the component's owner drops `tier`; `labelsMatch` stops matching and every gate it fed goes quiet — no error, no audit event, no Decision recording that governance reach changed. A constraint that fails to match is a constraint that does not apply, and this one failed to match silently.

It needed no "remove label" API: `updateObject` replaces `labels` wholesale, so an ordinary full-replacement `PUT` that simply does not mention the key was the whole exploit.

### The property, stated so it can be censused

> **A governance decision whose match key is writable by its own subject, at a strictly weaker permission than the one that authored the constraint.**

Censused filterlessly, that property had **eight** instances — see §8 of the context doc and the Consequences below.

## Decision

Separate the two acts that were sharing one bag:

- `labels.tier` is a **description** the object's owner makes about their own object. Unchanged, as free as it is today.
- `labels["scp.governance/tier"]` is an **assertion an authority makes** about it. Out of the subject's reach, and the only thing a constraint may key on.

This is [ADR-0003](0003-internal-egress-for-execution-systems.md)'s shape one layer up: there, a tenant's `allowInternalEgress` is a declaration that buys nothing unless an operator-set value outside tenant write reach independently agrees. Here the tenant's `tier: pci` grants and relieves nothing; the operator-set `scp.governance/tier: pci` is the only thing the matcher sees.

### 1. The namespace

`GOVERNANCE_LABEL_PREFIX = "scp.governance/"`. A literal prefix test with **no case folding, no trimming and no normalisation** — both readers compare with `===`, so any fuzziness would create a key that is reserved for the *write* check and a different key at *match* time, which is the evasion rebuilt inside the guard.

Deliberately **not** `scp:`, which `iac/plan-diff.ts` already uses for `scp:managed-by` / `scp:stack`. Those are stamped by IaC apply itself under `object:write`; reserving that prefix would break every apply.

### 2. The write rule

`assertMayWriteGovernanceLabels`, installed at the **choke points** every local write door funnels through — `graph/objects-repo.ts`'s `createObject`/`updateObject` and `graph/relationships-repo.ts`'s `createRelationship` — never per route. `labels` is named on 18 lines across 9 non-test route files, and three doors are already on record as reaching `createObject` without passing through `typed-registries.ts`; a per-route guard would have missed them.

It compares a **delta over the stored row**, which matters twice: a `PATCH` that never mentions `labels` resolves no permission at all, so this is off the cost of the ordinary write path; and a full-replacement `PUT` that *omits* a governance label is a **removal** and is refused. Those two are the same bytes on the wire — only the stored row tells them apart.

The omitting write is refused **loudly rather than silently repaired**. Merging the operator's keys back in would produce zero false positives and one bad true negative: an operator *with* `policy:write` doing a deliberate `PUT` to remove a governance label would be answered `200` with the label still there. Two behaviours where one will do, and the silent one is wrong for the actor who matters most.

### 3. The authoring rule

`assertSelectorKeysAreGovernanceLabels`, at the same choke point: a `policy`'s `scope.selector.labels` may key **only** on governance labels.

Without this half the namespace is a feature, not a guard — an author who reaches for `{tier: "pci"}` (the obvious thing, and what `docs/DESIGN.md` §10.1's own example shows) gets a policy their subjects can still walk out of, with nothing to tell them so.

`labels: {}` is left alone: it is an `every()` over zero entries, so it matches every ancestor unconditionally, keys on nothing, and cannot be evaded by editing anything.

### 4. The same rule for a peer's `custom` sync scope

`federation/scope-filter.ts`'s `custom` mode decides which journal entries **leave this security domain**. The selector is authored under `federation:write`; the labels it matched were the object's own — so a component owner setting `tier: gold` shipped their object across a domain boundary to a peer configured never to receive it. The same property, running in the **widening** direction and against confidentiality rather than a gate.

Enforced at peer-config **authoring** only (`pairPeer`, `updatePeerTransport`), keyed off the declared scope. `entryMatchesScope` stays the pure synchronous predicate both ends apply to identical input, which is the entire basis of the import-side re-filter; an already-stored `custom` scope keeps filtering as it does today until someone edits it.

### 5. The bar is org-root `policy:write`

Because that is the bar at the **other end of the same constraint**. If a governance label could be written with `policy:write` scoped at a *component*, a component-level administrator could clear the key an org-level SecOps policy matches on — the original evasion with one more permission and no more authority.

Org-root authority sounds heavier than it is: `labelsMatch` runs over the whole containment chain, so an operator labels a **domain or a service once** and every component beneath it is governed. No per-component labelling chore, and a governance label remains an ordinary entry in an ordinary `labels` map, readable by anyone who can read the object.

## Alternatives considered

**(a) Emit a high-severity audit event when a label change alters which policies match.** Cheapest to build, rejected on two counts: it is **detection, not prevention** — the gate still stops firing and the operator learns from a promotion that sailed through; and it costs a full policy scan plus a containment walk on the hottest write path in the system, against an existing 5,000-sequential-create budget.

**(b) Freeze whatever label keys the org's policies happen to name.** No new namespace and no migration, but the blast radius is enormous and invisible: the day SecOps authors `selector: {env: "prod"}`, every team loses the ability to set `env` on anything, including at create. Governance reach becomes a function of documents the writer cannot see. It runs into the real tension — `env` is exactly the label a selector wants *and* exactly the label a team must be able to set — and no rule treating the two uses as one thing can resolve it.

**(c) A reserved namespace — chosen.** Against charter decision priority #1 (Simplicity): (c) is one sentence — *a `scp.governance/` label is set by org-root `policy:write` and nothing else* — with one place to enforce it and one place to check the consumers. (a) is a second, weaker mechanism bolted beside a hole that stays open. (b) is a rule whose behaviour at any moment depends on documents elsewhere in the graph.

## Consequences

**The census, and where it stands.** Of the eight instances of the property: **8.1** (policy selector labels) and **8.2** (federation `custom` sync scope) are closed by this ADR; **8.3** (IaC stack ownership, a *delete* decision its own subject could rewrite) by PR #252; **8.4** (the M15.6 region gate, evadable by deleting its match key) by PR #251; **8.5** (policy-scope doors) by PR #244; **8.8** (the containment chain) by PR #249. Two remain, both stated rather than fixed: **8.6** (`correlation.ts`'s `correlationKey` — not a gate, but it decides what is grouped with what) and **8.7** (CEL `subject.labels`, below).

**CEL conditions are not restricted.** `subject.labels.tier == "pci"` is exactly as evadable as the selector was. Statically restricting CEL text is fragile and would break legitimate *advisory* conditions over tenant data. The namespace already gives condition authors a tamper-proof key — `subject.labels["scp.governance/tier"]` is now an operator-set fact — so this is a documentation change, not a code one.

**Route-level write permissions are not changed.** Hand-fill still authorizes with `federation:write` and overlay with `object:write` where `plans-repo.ts` demands `policy:write` for the same types. Raising that bar is a new decision with its own blast radius, not the completion of this one (§8.5).

**The label cannot be removed, and the object can still be moved.** A selector's reach is the containment chain, and the chain is tenant-writable. Measured, not suspected: with Operator bound at the org root (no `policy:write` anywhere), deleting a `contains` edge and re-attaching the component under an ungoverned service made a service-anchored `scp.governance/tier: pci` policy stop reaching it. This needs `relationship:write` at a **service or broader** — both relationship doors are two-ended and authority expands upward, so a component owner cannot do it. Shipped as PR #249, which records a governance-reach change on every containment write: detection, with prevention left for a decision that touches every typed route. It is materially different from the label escape in two ways that made shipping this first worthwhile — re-parenting is **loud** (the object visibly moves) and **already audited** as two relationship acts, where a dropped label produced one indistinguishable `object.update`.

**A withdrawn guard, kept as a lesson.** An earlier revision also added `assertPolicyScopeWithinAuthority` at the hand-fill and overlay doors. PR #244 had closed both by a stronger route in the interim, so the added calls could no longer refuse anything. Re-measured on the rebased tree: deleting the call from `handFillObject` made its case fail *even unmutated*, and deleting it from `createOverlay` left the case **still passing** — an inert guard behind a vacuous test. The calls were removed and a comment at each door records the condition under which the scope check must come back: it rests entirely on that org-root bar staying org-root and continuing to cover `policy`.
