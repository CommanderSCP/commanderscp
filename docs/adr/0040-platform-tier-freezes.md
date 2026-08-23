# ADR-0040: Platform-tier freezes — an instance-scoped freeze tier above org, addressed by stage coordinate, overridable by no tenant role

**Status:** Accepted for the tier itself (owner decision **D1**, 2026-08-23, recorded in [campaigns-rework.md](../proposals/campaigns-rework.md) §2). **§7 lists three implementation departures from the proposal's §2.1 sketch that the implementer took and that are flagged for owner confirmation** — none changes what D1 decided, each changes how it is expressed.

**Numbering note (2026-08-23):** `main` tops out at 0033; 0034 is reserved in prose by `docs/proposals/governance-label-namespace.md`; 0035 is M23's; 0036/0037/0038 are taken on the unmerged UI branch `claude/ui-review-worktree-efc42b` (confirmed with that session — that branch is invisible to `gh pr list`). 0039–0042 are reserved by campaigns-rework.md; this is 0040.

**Relates to:** [campaigns-rework.md §2](../proposals/campaigns-rework.md) (the design and every grounded fact behind it), [ADR-0016](0016-scoped-scan-requirement-policies.md) (the six-tier scan model and the instance-scoped-table precedent this reuses), [ADR-0033 §7a](0033-scan-exclusions-and-overrides.md) (the DESIGN §4.2 `org_id` exception, stated), `drizzle/0076` (the `scp_operator` write principal that ADR-0016's four tables shipped without), [ADR-0026](0026-placements-and-derived-stage-names.md) (a wave target is a placement), [ADR-0031](0031-domain-local-objects-never-federate.md) (locality is declared, never inferred), charter principles 3, 6 and 7.

## Context

`freezes.scope_object_id` names a graph object and `graph/containment.ts`'s `containmentChain` decides what that freeze covers, across five tiers: org root → containment domain → service → component → deployment target. That walk is **org-rooted and org-filtered on every join**, so it structurally cannot reach above org. DESIGN.md §10.3 recorded that limit as a decision: freeze scoping is *"org-rooted; the above-org tiers ADR-0016 adds are scan-requirement-only and do not extend freeze scoping."*

Owner decision D1 (2026-08-23) overturns that clause. A deployment operator — the person who runs the instance, not any tenant on it — needs to be able to stop releases across every organization hosted on it: a platform incident, a maintenance window, a change-freeze imposed on the whole estate. There is today no way to express that at all, and the workaround (asking each tenant to author their own freeze) is exactly the shape a freeze exists to make unnecessary, because it depends on every tenant complying.

## Decision

### 1. Its own instance-scoped table, not a widening of `freezes`

`instance_freezes` (`drizzle/0086`), with **no `org_id`** — the DESIGN §4.2 exception ADR-0016 §3 and ADR-0033 §7a already take, for the same stated reason: it is an operator statement about the *deployment*, not tenant data. Per-org rows would encode a fact already true of every org and would invite a tenant-writable surface.

Adding an `org_id`-nullable row to `freezes` was rejected on the same grounds ADR-0016 §3 rejected it for scan floors: the `objects`/tenant RLS policies deliberately carry no `OR org_id IS NULL` escape, and adding one widens the tenant-isolation blast radius of every row in the table it is added to.

### 2. Addressed by stage coordinate, never by object id

A platform freeze **cannot** carry a `scope_object_id`: object ids are per-org rows, `containmentChain` is org-filtered, and there is no object every tenant shares — one id would name at most one tenant's object. It therefore addresses the coordinate SCP already defines and already reads (M15.6 / ADR-0017 §3): `properties.environment`, optionally narrowed by `properties.region`, on a live `deployment-target`.

The reader is `coordination/regional-executors.ts`'s `readStageCoordinate`, **including the placement → deployment-target hop**. Under ADR-0026 a wave target is a *placement*, which carries no environment or region of its own; without the hop every stage-shaped target reads as coordinate-less and an environment-addressed freeze silently matches nothing — indistinguishable, from the verdict, from a freeze that was never declared. `readDeclaredRegionMembership` now composes over the same property reader, so exactly one function knows the convention.

Coverage semantics, with the two a reviewer guesses wrong stated explicitly:

| freeze | covers |
|---|---|
| `environment` only | every region of it, **including a stage that declares no region** |
| `environment` + `region` | that one stage; **not** a stage of that environment that declares no region |
| `allEnvironments` | every target, **including one that declares no coordinate at all** |

The two `null`-region readings pull in opposite directions from the same absent value, which is why both are pinned by their own unit case. "Freeze prod" means prod, not "the parts of prod that named themselves"; but a target that has not said it is `amer` is not `amer` (ADR-0031: locality is declared, never inferred).

### 3. Merging is UNION (OR), not MIN

ADR-0016's floors merge by per-severity MIN because a threshold is a **number**. A freeze is a **predicate**, and the analogue of most-restrictive-wins for a predicate is disjunction:

```
frozen(target, t) ≡ (∃ instance freeze covering target at t) ∨ (∃ org freeze whose scope is on target's chain, window covering t)
```

Three consequences: (i) when the org has declared nothing, a platform freeze still blocks — the empty org set contributes `false` to an OR; (ii) **nothing an org can author subtracts from the union**, so the floor property does not live in the merge; (iii) the table ships empty and empty is byte-identical to pre-M25.3 behaviour everywhere.

### 4. Overridable by no tenant role, unless the operator says otherwise

`hasPermission` builds `scopeExpandCte(orgId, scopeObjectId)` and joins `role_bindings` filtered `rb.org_id = orgId` — **every id in that query is org-scoped**, and a platform freeze has none. The three natural fakes are each wrong in a different direction:

* `scopeObjectId = orgRootId` unconditionally lets any org Administrator lift a platform freeze — the floor is gone, and this is the *natural* implementation;
* a synthetic sentinel id makes the freeze un-overridable **by accident**, holding until somebody "fixes" it and silently reintroducing the first fake;
* an operator token on the request is structurally impossible for the case that matters, because wave-boundary gates run under `SYSTEM_ACTOR_ID` with no HTTP request in scope.

**Ruling: an instance-tier freeze is not overridable by any tenant role, however privileged — not by an org-root Owner.** The authoring operator may set `overridable = true` on one freeze, which admits override by an actor holding `freeze:override` **at the org root** under the same mandatory non-empty-reason rule every override obeys. Default `false`: a loosening never defaults on. The two authorities are independent and **both** are required — the operator sets the bit (tenant-unwritable, behind two barriers), the tenant must still hold the permission and still must give a reason.

`freeze:write` is **not** added at this tier and no role, including Owner, can author an instance freeze. The `Permission` union is unchanged.

**CRITICAL #2 spans the tier boundary.** `checkFreeze`'s loop is a universal quantifier over the union of *both* tiers, and the tier branch lives **inside** it rather than as a pass ahead of it (which is what the proposal sketched). A change covered by an org freeze and a platform freeze must satisfy both, and neither tier can short-circuit the other — a separate "platform pass first" would have re-created the `active[0]` shape that loop exists to make inexpressible, one tier up.

### 5. Operator-write / tenant-read, with the write principal that four tables shipped without

Two barriers, verbatim the 0029 shape: `scp_app` gets `SELECT` and has `INSERT/UPDATE/DELETE` explicitly `REVOKE`d; RLS is `ENABLE`d **and `FORCE`d** with a `FOR SELECT USING (true)` tenant-read policy and no tenant write policy in any verb. Tenant read is required by charter principle 6 — the one freeze a tenant can neither author nor (by default) override is the one it most needs to be able to see.

And the half `0029/0035/0036/0074` all forgot until `0076`, and that `0083 §2` then forgot **again**: `GRANT SELECT, INSERT, UPDATE, DELETE ... TO scp_operator` **plus** a `FOR ALL TO scp_operator USING (true) WITH CHECK (true)` policy. Under `FORCE ROW LEVEL SECURITY` either half alone is a refusal, and the suite cannot see it because the Testcontainers bootstrap user is a superuser that bypasses grants and RLS unconditionally. This is asserted by a test running as a real least-privileged `scp_app` principal plus a `has_table_privilege`/`pg_policies` probe.

Deliberately **not** `GRANT scp_operator TO scp_app` in any form — 0076's rejected alternative (b): the whole authority argument for the operator door is that it is not reachable from tenant-serving authority.

### 6. It does not federate, and cannot

`SyncJournalEntrySchema.orgId` is a **required** uuid; `appendJournalEntry` takes `input.orgId`; the hash chain is keyed `(orgId, originDomainId)` under an advisory lock on that pair; `exportSyncBundle` runs inside `withTenantTx(db, orgId, …)`. Every layer of the journal is org-scoped, and a platform freeze has no org and no non-arbitrary way to acquire one. Re-expressing it as N per-org entries would require the commander to enumerate the outpost's tenants (which it does not know) and would turn an instance-scoped fact back into tenant data.

A new `JournalEntryKind` is separately a fail-closed cliff: `POST /federation/imports` validates against a nine-literal `z.enum`, so an unknown kind fails Zod **at the route boundary → 400, whole bundle refused**, every unrelated entry lost; and `entryKind` also appears in `POST /federation/exports`'s 200 response, making it an oasdiff `response-property-one-of-added` break.

**Distribution to a fleet is deployment tooling** — the same Ansible/Helm path that distributes `SCP_OPERATOR_TOKEN` PUTs the same freeze to each instance. Org-tier freeze federation is a separate question (D6, M25.7) with a separate answer.

### 7. Three departures from the proposal's §2.1 sketch — flagged for owner confirmation

None changes what D1 decided; each changes how it is expressed, and each was taken under the standing rule that **a field that lies is worse than an absent one**.

**(a) An unset environment is NOT deployment-wide.** The proposal read `match_environment IS NULL` as "every environment". Shipped: an explicit `match_all_environments` boolean, mutually exclusive with `match_environment` under a DB CHECK, a request-schema refinement, and a 400 on a body carrying neither. *Why:* a deployment-wide freeze is the widest governance act this table can express — every release, every tenant — and reaching it by **omitting** a field means a client that drops empty strings, a typo'd JSON key, or a partially filled form authors maximum blast radius with no error anywhere. This repo already refuses to let a *loosening* default on (`freezes.atomic`, `overridable`, 0083 §3); the widest *tightening* earns the same treatment for the same reason. It also lets the CHECK constraint state the rule, where NULL-as-everything makes "no environment" and "environment lost" indistinguishable.

**(b) No `origin` column.** The proposal carried `origin IN ('local','federated')` for forward compatibility, following 0029. *Why not:* 0029's federated writer was designed and never built; §6 above shows a platform freeze's federated writer cannot be built at all. A column whose only documented value is one no writer can ever produce is a field that lies. Its absence is the honest shape, and it lets `key` carry a plain UNIQUE constraint.

**(c) No `tier` column, so no `trust_domain` literal.** The proposal carried `tier IN ('platform','trust_domain')`, mirroring 0029. *Why not:* 0029 needs it because ADR-0016's two above-org rungs contribute **separate per-severity MINs**; a freeze merges by OR, and a `trust_domain` freeze would behave identically to a `platform` one in every code path — a stored label that changes nothing. **This table is the platform tier; the tier is the table.** *Consequence, stated so the owner can weigh it:* the drafted DESIGN.md §10.3 replacement in the proposal says "seven tiers … platform (instance) → trust domain → …". As shipped it is **six**: platform → org → containment domain → service → component → deployment target. If the owner wants a distinct trust-domain freeze rung, it needs a semantic that distinguishes it — otherwise the honest count is six.

**A fourth, non-departure, worth recording:** `instance_freezes.id` is a real uuid rather than a synthetic `platform:<key>`. `ServiceBoardFreezeSchema.id` is published in `openapi.v1.json` as `z.string().uuid()`, so a synthetic identity would either violate that shipped response contract or force widening it — an oasdiff response change this repo has already paid for once. With a real uuid the service board shows a platform freeze with **no schema change and no oasdiff exposure at all**, which also avoids re-creating the "the lever works and the signal is missing" defect M25.2 had to come back and fix.

## Consequences

* **The instance tier is resolved in exactly one place.** `governance/freeze-scope.ts`'s `freezesByTarget` returns `EffectiveFreeze`, a **discriminated union** of the org row and the instance row, so `checkFreeze`, `freeze-hold.ts`, the `atomic` union and the service board all receive the platform tier with no per-tier plumbing — and D5 per-target admission is therefore not tier-specific. The union is the enforcement mechanism, not decoration: TypeScript refuses to compile a consumer that reads `scopeObjectId` without first asking which tier it holds, which is precisely the field §4's three fakes are about.
* **The window predicate is still known in one place.** A second table cannot share the first table's `where` clause, so `starts_at <= at < ends_at AND lifted_at IS NULL` was factored into `freezeWindowCovers` and both tiers' reads are built from it. Deliberately not parameterised on the org filter — an optional org predicate could be omitted by passing `undefined`, which at the org tier is a cross-tenant read.
* **Inertness survives, measured.** M25.3 costs a deployment with nothing frozen exactly **one extra indexed read per change per tick**, zero graph walks, and zero coordinate reads. A `matchAllEnvironments` freeze is the *cheapest* form, because it consults no coordinate at all.
* **A block Decision now carries `tier` and `match`.** Additive, and load-bearing for principle 6: without `tier` a reader would resolve the id through `GET /v1/freezes/{id}`, which is org-scoped, and get a 404 for a freeze that is in force. `scopeObjectId` is `null` at the platform tier and `match` carries what it actually matched.
* **No Decision and no audit event are written by the operator door itself.** Both tables are `org_id NOT NULL` and the audit chain is hash-chained per org; attributing an instance-wide act to whichever tenant held the token would write a false record into one org's chain, and fanning it across every org would forge N records for one act. The record is the row plus the org-scoped block Decisions the freeze causes. The three operator doors that came before this one behave the same way.
* **No IaC and no UI representation**, matching `instance-scan-floors` and `instance-scan-exclusion-admissions`: `scp-iac` plans tenant graph state under a tenant credential and the UI is a tenant surface, so an IaC file would carry a deployment secret into a tenant's plan and the UI would advertise a button no tenant principal can press.
* **An admitted-overridable platform freeze is exercisable only on the lifecycle `accept` edge**, because `evaluateWaveGate` passes no `overrideFreeze`. Pre-existing and not created here, but it means `overridable: true` does not unblock a change already `executing`.
* **A target that declares no stage coordinate is reachable only by `allEnvironments`.** A legacy component-shaped wave target has no `deployment-target` on its chain, so an environment-addressed freeze cannot reach it. This is the honest consequence of declared-not-inferred addressing, not a gap to be closed by guessing.

## Owed, and deliberately not done here

* **DESIGN.md §10.3 and §10.1** carry drafted replacements in the proposal's "Documents to change". They are **not applied**: §10.3's draft says seven tiers including `trust_domain`, which is not what shipped (§7c), and the correction is an owner call rather than an editing one.
* **PROJECT_CHARTER.md's "Freeze Scope" four-item list** needs a **named, dated charter amendment** with owner sign-off — the proposal says so, and the only precedent for widening a charter enumeration this way is the Managed Execution Exception.
* **BUILD_AND_TEST.md M16.2** currently says per-outpost freezes are *"Commander-origin, syncs down"*, which §6 makes false for this tier. Its rewrite depends on D6/M25.7's answer for the org tier.
