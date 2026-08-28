# Proposal — Purpose-shaped roles, and the permission review behind them

**Status:** Draft — proposed, pending owner review.
**Built and merged — the read surface is closed:** step 0 (§5) as **PR #286**; **2.5a** (the 23
get-by-id re-scopes plus `authz/org-root-arm.ts`) as **PR #288**; **2.5b** (LIST-door filtering, the
`readable-scope` → `list-door-scope` → `list-scope` stack, and the inverse-walk drift detector) as
**PR #291**.
**Built, not yet merged:** **step 1** (DDL hardening, `drizzle/0097_rbac_role_preconditions.sql`) and
**step 2** (the mutation-proven RBAC-across-assembly test), on branch `rbac-role-preconditions`.
Neither adds a role or a permission — they make the tables able to hold them safely, and pin the
`service → assembly → component` chaining the shared ComponentAdmin role depends on.
**Step 3** (the three permission splits, the deletion of `org:admin`, and the five role seeds —
`drizzle/0099_rbac_permission_splits_and_purpose_roles.sql`) is built on the stacked branch
`rbac-roles-and-write-door`, with `routes/rbac-permission-splits.integration.test.ts` pinning both
breaking changes and all five seeded permission sets, seven mutations proven. **Step 5** (the
role-binding write door) is the next round on that same branch and ships in the same PR.
**Not started:** steps 4 and 6–10. Per **D5** the role seed (step 3) and the role-binding write door
(step 5) are **one shippable unit**, since deprecating `Administrator` before any purpose-role
binding exists would 403 the obvious migration target from day one.
**Date:** 2026-08-25, last revised 2026-08-27
**Prompted by:** owner ask — *"review the permissions and create the proper roles for each. Generally
we'll want some for security/compliance (global scans and overrides), commander-wide admin, org
admin, service admin, assembly & component admin (share a role)."*

---

## 0. Summary

The five built-in roles are a **cumulative ladder** (Viewer ⊂ Operator ⊂ Approver ⊂ Administrator ⊂
Owner) seeded by `drizzle/0002_rls_rbac_seed.sql:207`. Because each is a superset of the last, a
permission's *blast radius* and its *rank* are welded together: the only way to give someone
`freeze:override` is to make them Owner, which also hands them `role_binding:write` and
`change:emergency`. Every archetype the owner asked for is a request to break that welding.

The review found the scope half of the model is **already correct and costs nothing** — but the
permission half has ten-plus defects, several of which are live security bugs independent of any role
work. Two of them (`role_binding:write` gating nothing; the SSE stream gating nothing) mean the
authority model is currently *unadministrable* and *unenforceable on the read side*.

**Recommendation:** seed five purpose-shaped roles **alongside** the ladder (not replacing it), split
three permissions out of the two generic write verbs, and ship the role-binding write door that makes
any of it real. Preconditions in §4 must land first.

---

## 1. What the permission review found

Census of **170 enforcement call sites** across `apps/server/src` (no enforcement in `packages/`; the
five NUL-byte files were opened individually and contain none).

The `Permission` union has **19** members, not the 17 its own docblock implies — the count predates
`governance:move` (0083) and `campaign:deadline-override` (0088).

### 1.1 Enforcement is concentrated in two generic verbs

| Permission | Call sites |
|---|---|
| `object:write` | 62 |
| `object:read` | 45 |
| `relationship:write` | 20 |
| `federation:write` | 18 |
| `policy:write` | 10 |
| everything else | ≤ 8 each |

`object:write` + `object:read` are **107 of 170**. Meanwhile every purpose-built high-consequence
permission — `freeze:override`, `change:emergency`, `campaign:deadline-override`, `approval:write`,
`audit:read` — is demanded *exactly once*. The care spent designing narrow permissions is not
reflected in what actually gates the estate.

### 1.2 Two seeded permissions gate nothing

- **`role_binding:write`** — seeded onto Administrator and Owner, checked at **zero** call sites.
  There is no role-binding API at all: the committed OpenAPI document has 177 paths and **zero**
  touching roles or bindings. The only two production writers of `role_bindings` are
  `auth/local-auth.ts:84` (bootstrap admin → Owner at org root) and `auth/oidc.ts:178` (JIT OIDC user
  → Viewer at org root). **A real deployment has exactly two authority levels, and every finer scope
  is reachable only by hand-written SQL** — outside RLS, outside the audit chain, with no Decision
  record. This is a whole-surface violation of charter principle 3 (API → SDK → CLI → IaC → UI) for
  the most security-relevant object in the system.

  It is worse than a plain omission: an Administrator's role listing *advertises*
  `role_binding:write`, so the surface reads as built. And `routes/governance.ts:735` leans on the
  absence as a **security argument** ("an Administrator cannot mint themselves Owner"). That is true
  today, but it is load-bearing safety resting on an unbuilt feature, and it expires the day anyone
  ships the obvious missing CRUD. Two more places do the same: `campaigns-rework.md:362` and
  `drizzle/0083 §3`.

- **`org:admin`** — seeded to Owner alone, checked at zero call sites. A filterless census finds
  exactly three occurrences tree-wide: the union member (`resolve.ts:39`), the seed (`0002:223`), and
  one negative test assertion.

### 1.3 Live defects the review surfaced

These are bugs today, with or without new roles.

**(a) The SSE stream has no permission check at all.**
`GET /api/v1/events/stream` calls `requireAuth` and then `sseHub.on(auth.orgId, send)` with no
`authorize()` — `routes/events.ts:44,58`. It is the **only read surface in the codebase with no
permission demand**, and it fans out every object's events, each carrying `subject` and a `data`
payload, to any authenticated principal *including one with zero role bindings*, filtered by org
alone. The hub's own comment names the **tenancy** boundary and is correct about it
(`events/sse-hub.ts:14-17`) — per CLAUDE.md's convention that is a signal to sweep to the next
boundary, not evidence it was handled. The RBAC boundary immediately below it is absent.

**(b) The campaign-deadline ladder is inverted, and the Owner-only gate is trivially bypassable.**
`POST /campaigns/:id/deadline-override` demands Owner-only `campaign:deadline-override`
(`campaigns.ts:503`) plus `object:write` at each named target (`:534`). But `POST
/campaigns/:id/deadline` demands plain `object:write` at the campaign (`:341`) — Operator tier. And
**clearing the deadline is a strict superset of waiving it**: it excuses *every* target, permanently,
with no reason, no `until` bound, and no per-target check. An Operator who cannot get an Owner to
sign a one-target waiver simply clears the deadline for the whole campaign.

`authz/resolve.ts:56-72` spends a long comment arguing `campaign:deadline-override` must not reuse
`freeze:override` because "one permission would then carry two unrelated blast radii" — that care is
spent while a strictly larger blast radius sits behind a strictly weaker permission one route over.

**(c) The same inversion on freeze lift.** `DELETE`/`PATCH /freezes/:id` takes Administrator-tier
`freeze:write`, while letting *one* change past a freeze takes Owner-only `freeze:override`. The
wider-reaching verb takes the narrower permission. It was carried in-code as an open owner ruling,
with the code, `drizzle/0010`'s comment and DESIGN §10.3 all disagreeing about it.
**Ruled and built** — see §7.1 D1(a-ii); shipped as M25.9.

**(d) Credential custody sits behind the most widely held write verb.** `PUT`/`DELETE
/secrets/:key` (`executors.ts:190,248`) and `PUT /change-sources/:kind/webhook-secret`
(`change-sources.ts:336`) all demand `object:write` at the org root. Three unrelated blast radii share
one grant: writing the tokens SCP uses to reach GitHub/ArgoCD/Terraform; **deleting** them, an
availability kill switch for all coordination on the deployment; and rotating the HMAC secret that
authenticates inbound webhooks — where whoever sets the secret can thereafter forge signed source
events. There is no way to give an operator ordinary org-root `object:write` without also handing
them every execution-system credential.

**(e) Authoring a scan rule and waiving it are the same permission.** Rule authoring is
`policy:write` (`typed-registries.ts:111`); deciding a scan-override waiver is `policy:write`
(`scan-override-grants.ts:288-293`). A textbook separation-of-duty violation, which the route file
itself concedes — its raiser≠approver check "survives intact the moment any SECOND principal holds
the same scoped `policy:write`."

**(f) `change` accept/cancel/rollback are scope-blind in both directions.** All three pass
`scopeObjectId: auth.orgId` (`changes.ts:429/482/540`) while *create* uses `declaredParent ??
auth.orgId` (`:169`). Because `scopeExpandCte` expands upward only, **only** an org-root binding ever
passes — so no service-scoped principal can accept a change for their own service — while **any**
org-root Operator can accept, cancel and roll back *every* change in the org.

**(g) `roles` and `role_bindings` have no unique constraint of any kind.** `roles` has a PK on `id`
only (`drizzle/0001_graph_core.sql:70-75`) — which means the seed's `INSERT ... ON CONFLICT DO
NOTHING` with `gen_random_uuid()` **can never fire**, and a re-run silently creates duplicate role
rows. `role_bindings` likewise (`:76-85`), and its `effect` is a bare `text` column with no CHECK, so
anything that is not literally `'deny'` is silently treated as not-a-deny. `scp_app` holds
SELECT/INSERT/UPDATE but **no DELETE** on `role_bindings` (`0002:27-31`) — a revoke verb could not
revoke.

> **Closed by step 1 — `drizzle/0097_rbac_role_preconditions.sql`.** The paragraph above describes
> the state on main *before* 0097 and is kept as the statement of the defect; it is no longer a
> description of the schema. 0097 adds the partial unique index `roles(name) WHERE org_id IS NULL`,
> `UNIQUE (org_id, subject_id, role_id, scope_object_id, effect)` on `role_bindings`,
> `CHECK (effect IN ('allow','deny'))`, and `GRANT DELETE ON role_bindings TO scp_app`; it cleans
> pre-existing duplicates and illegal-effect rows first, since each constraint would otherwise
> hard-fail on a populated database. **Two things the constraint does not do**, both still live:
> the resolver's exact-string classification remains the inner layer for rows that pre-date it
> (§8.3), and duplicate built-in roles whose `permissions` have **diverged** are *not* collapsed —
> 0097 §1a aborts the upgrade naming the ids and the delta, because either survivor choice changes
> some subject's authority and a migration must not invent that answer. Divergence is not exotic:
> a re-executed 0002 seed writes the M1-era 11-permission `Owner` beside today's 20-permission one,
> and `gen_random_uuid()` decides which holds the lower id.

**(h) No validation that a binding's scope is a sensible object type.** `role_bindings.scope_object_id`
is `uuid NOT NULL REFERENCES objects(id)` with no type constraint, no `scope_kind` column, and no
CHECK. A binding at a `user`, a `change` or a `group` is accepted and silently **inert** — and because
`objects.domain_id` carries no type constraint either (`containment.ts:432-434` says so explicitly),
an object parented under a group would make such a binding *suddenly confer authority*.

> **Still open after step 1.** 0097 adds the `roles.bindable_at text[]` column this will be
> validated against, NULL on every existing built-in row (= "any scope", their behaviour today), and
> deliberately **enforces nothing**: the check belongs at the role-binding write door, which is step
> 5. Until then a binding at a nonsensical scope is still accepted and still inert.

**(i) `requireApprovals.fromRole` is an unvalidated free-form string.**
`packages/schemas/src/governance.ts:131` types it as bare `z.string()`; nothing validates it, and
`governance.integration.test.ts:554/621` assert `'NonexistentRole'` is **accepted**. A typo
materializes approval requests nobody can ever vote on — a permanently wedged change whose 403 reads
as if the voter lacks standing rather than as if the policy is malformed.

### 1.4 The scope half is already right

`scopeExpandCte` (`authz/resolve.ts:124`) walks **four** upward routes: `objects.domain_id`, the
`contains` edge, placement→component, and placement→deployment-target. Route 2 joins `contains` with
**no predicate on either endpoint's type** (`resolve.ts:142-147`), and migration 0055 set
`from_types = ['service','assembly']`, `to_types = ['assembly','component']`.

**Consequence: `service → assembly → component` chains for free at depths 1 and 2.** This is exactly
why 0055 shipped no resolver edit, and exactly why *"assembly & component share a role"* costs nothing
structurally. It is, however, **untested at the authz layer** — a filterless census finds one role
binding in any assembly-bearing test and it is checked at the assembly itself, a depth-0 self-match
that would pass even if route 2 were deleted.

### 1.5 There is no authority tier above an org

`role_bindings` rows are org-scoped. Everything deployment-wide — instance freezes, instance scan
floors (tiers 1–2 of the scan lattice), scan-exclusion admissions, scanner assignments, scan-db
administration, the `governance:move` instance rung, the dependency-subscription unlock,
`/doctor/instance` — is gated by **one static shared secret**, `SCP_OPERATOR_TOKEN`, presented as
`x-scp-operator-token` and timing-safe compared (`operator-db.ts:107-113`).

One secret opens all eight doors. So *"let SecOps set the deployment's scan floors"* necessarily also
grants *"stop every release on the deployment"*, with no identity, no per-capability split, no
revocation short of rotation, and no attribution of an instance-wide act to a person.

**This half of "commander-wide admin" cannot be a role without a credential redesign.** Binding a role
at every org root is *not* a substitute: the eight instance tables carry no `org_id` for a binding to
reach, and a role present in every org reconstructs exactly the platform-freeze escalation ADR-0040
rejected as "the natural implementation."

---

## 2. Why the ladder is kept, not replaced

**Verdict: ALONGSIDE.** Seed new roles as additional `org_id IS NULL` rows; leave
Viewer/Operator/Approver/Administrator/Owner byte-identical.

**A rename is blocked by three couplings:**
1. `hasRoleAtScope` matches `rl.name = ${check.roleName}` as a free-form string
   (`resolve.ts:299-303`) against `approval_requests.from_role`. So `requireApprovals.fromRole:
   "Approver"` is authored policy **data on live deployments** — renaming Approver makes every such
   policy permanently unsatisfiable, fail-closed, with a 403 that reads as missing standing.
2. `auth/local-auth.ts:78` does `eq(roles.name, "Owner")` and `auth/oidc.ts:173` does
   `eq(roles.name, "Viewer")` — both throw at boot / first OIDC login if the row is absent.
3. 178 `role: "<BuiltIn>"` literals across 53 files, plus 40 `fromRole:` literals reaching into
   `apps/web` tests, `packages/cli/src/cli.ts:1360`, and `scripts/e2e-m4.sh`.

**A re-cut is blocked by a storage fact:** built-in roles are **shared singletons** (`org_id IS
NULL`), read by every org through the `roles` RLS `USING (org_id = current_org OR org_id IS NULL)`
clause and unwritable by any org through its `WITH CHECK` (`0002:64-69`). Removing `federation:read`
from Viewer, or `object:write` from Approver, narrows **every org on every deployment
simultaneously**, with no per-org opt-out and no custom-role API to restore it. That is why all four
prior grant migrations (0010/0012/0083/0088) are `array_append` — **subtraction has no safe shape
here.**

The charter authorises exactly this: it calls the five *"Example built-in roles"* and commits that
*"Organizations should be able to define additional roles."*

**One deliberate exception to additive-only:** delete `org:admin` (0 call sites). A dead permission
that advertises authority in a roles listing is worse than no permission — and the increment that
seeds these roles is precisely when a roles READ endpoint starts publishing those strings.

---

## 3. The proposed role set

Five new roles. `bindable_at` is a new `roles.bindable_at text[] NULL` column (NULL = any, for
compatibility with the five existing rows), enforced at the write door.

### A — `SecurityOfficer` · tier: org · bindable_at: `organization`

> Authors and enforces security/compliance rules — scan ceilings, exclusion clauses, controls, control
> bindings — decides scan-override waivers, and can declare a stop-work freeze, **without holding any
> authority to change the estate**.

`object:read`, `relationship:read`, `type_registry:read`, `graph:query`, `audit:read`,
`policy:write`, **`scan:override`**, `freeze:write`, `federation:read`

Holds **no** `object:write`. This is the role the cumulative ladder cannot express today.

> ⚠️ **Org root only.** `OVERRIDE_APPROVAL_TIER_FLOOR = 'org'` (`scan-requirements.ts:778-790`) and
> `tierForObjectType` maps no graph object above org — so a SecurityOfficer bound *below* the org root
> mints waivers that are approved, audited, and **inert**. (The design originally allowed `domain`;
> verification cut it. See §4.)

### B — `FederationAdmin` · tier: org · bindable_at: `organization`

> Operates this org's federation link — identity, journal, outpost topology, imports and exports.
> **Does not establish new trust relationships.**

`object:read`, `relationship:read`, `type_registry:read`, `graph:query`, `audit:read`,
`federation:read`, `federation:write`

Holds **no** `object:write` and **no `federation:pair`** — see §4.1. Pairing is the trust-anchor
decision, and it is what made this role's invariant false; day-to-day link operation is what remains.

Org-root-only is **mechanical, not conventional**: all 14 federation doors in `routes/federation.ts`
pass `scopeObjectId: auth.orgId`, so a narrower binding holds every permission and fails the scope
check on every door — a trap.

### B (instance half) — **no role.** `SCP_OPERATOR_TOKEN` stands, pending credential redesign.

Deployment-wide authority across all tenant orgs is not expressible as a role binding (§1.5). This is
owner decision #2.

### C — `OrgAdmin` · tier: org · bindable_at: `organization`

> Full administrative authority inside one organization — the rung the census showed is missing.

`object:read`, `object:write`, `relationship:read`, `relationship:write`, `type_registry:read`,
`type_registry:write`, `graph:query`, `audit:read`, `approval:write`, `policy:write`, `freeze:write`,
**`secret:write`**, **`change:accept`**, `governance:move`, `role_binding:write`, `federation:read`,
`federation:write`, **`federation:pair`**

> **`federation:pair` corrected 2026-08-27.** This list originally omitted it while §4.1 and §7.1 D4
> both granted it to "Administrator, Owner and OrgAdmin" — the doc contradicting itself, caught when
> `drizzle/0099` tried to copy this list verbatim. D4 governs: it is the later ruling and the one that
> reasoned about the permission. Establishing the org's federation trust anchors is org administration;
> **FederationAdmin is the deliberate withholding, and the only one.**

Deliberately **without** `freeze:override`, `change:emergency`, `campaign:deadline-override`,
`scan:override` — runs the org, cannot use the four bypasses. That withholding of `scan:override` is
the real separation of duty in this design: an org can seat an estate administrator who authors org
policy and a security officer who owns the waiver, and **neither is the other**.

### D — `ServiceAdmin` · tier: service · bindable_at: `service`, `domain`

> Full authority over one service and every assembly, component and placement beneath it, including
> the governance policy that applies to that subtree.

`object:read`, `object:write`, `relationship:read`, `relationship:write`, `type_registry:read`,
`graph:query`, `audit:read`, `approval:write`, `policy:write`, `freeze:write`, **`change:accept`**,
`governance:move`

Bound at a domain it is the same purpose at wider reach (route 1 handles nested domains), which is why
**no separate `DomainAdmin` is seeded**.

### E — `ComponentAdmin` · tier: assembly-component · bindable_at: `assembly`, `component`

> The one shared role: full authority over one unit of software and everything it is deployed as.

`object:read`, `object:write`, `relationship:read`, `relationship:write`, `type_registry:read`,
`graph:query`, `audit:read`, `approval:write`, `freeze:write`, **`change:accept`**

Bound at an assembly it reaches that assembly's components via `contains` route 2 (§1.4) — **this is
what makes "assembly & component share a role" free.** No `policy:write` and no `governance:move`: a
component administrator operates their component, they do not author the governance that binds it.

`placement` and `deployment-target` are deliberately **off** `bindable_at` in increment 1: a
deployment-target binding reaches the *placements* at that target and **not** the components placed
there, so it is a half-expressible "operator of prod" that will read as a bug.

### 3.1 Answering the question the ask contains

**Do D and E need new roles, or are they Administrator bound narrowly?** They are genuinely new roles,
but new **only in the permission dimension**. The scope dimension already works and costs zero code.
Administrator-bound-narrowly is insufficient for two reasons: Administrator-at-a-service **cannot
accept a change for its own service** (§1.3f) until `change:accept` exists and is checked at the
change's scope; and Administrator carries `role_binding:write` and `type_registry:write`, which are
inert-by-scope *today* only because the write door does not exist — and it ships in this same
programme.

---

## 4. Blockers found by adversarial verification

Three independent lenses (escalation, coverage/SoD, buildability) checked the design against source.
All three returned **sound-with-fixes**. The structural verdict (ALONGSIDE), the DDL gaps, and the
assembly two-hop all independently confirmed. Three blockers:

### 4.1 `federation:write` **is** a graph-write permission — FederationAdmin's invariant is false

Found independently by two lenses. FederationAdmin is specified as "operates the link, does not edit
the estate." That difference **does not exist at runtime**.

`POST /api/v1/federation/hand-fill` authorizes only `federation:write` at `auth.orgId`
(`routes/federation.ts:1363-1364`) and takes a **free-form `typeId`** plus free-form `properties`,
`urn`, `name`, `labels` (`federation/handfill-repo.ts:44-67`). Its own module doc says so in as many
words (`:231-233`). `assertHandFillableType` refuses only pair-bound, peer-bound and projection-bound
types; `assertGovernanceAuthorityForHandFill` refuses only governance-managed types. **`service`,
`component`, `assembly`, `deployment-target`, `change`, `campaign`, `executor` are all admitted.**

**And hand-fill is only half of it.** A second review pass traced a chain the hand-fill fix does not
close: `POST /federation/peers` authorizes `federation:write` alone (`routes/federation.ts:290-295`)
and takes the peer's Ed25519 `publicKey` **verbatim from the request body**; `POST
/federation/imports` takes the same single permission (`:820-826`); and `applyEntry`'s `object_upsert`
branch resolves **any** registered `typeId` through `upsertObjectByUrn`
(`import-repo.ts:215-275`). Pair a peer with a keypair you generated, import a bundle you signed with
it, and you have estate write authority without `object:write`.

*Not live today* — `drizzle/0012` grants `federation:write` only to Administrator and Owner, both of
which already hold `object:write`. It matters only because FederationAdmin withholds `object:write`.

**RULED 2026-08-25 (D4) — a second bar on PAIRING.** Both halves close:
1. **Hand-fill** — demand `object:write` at the resolved containment scope as a second, independent
   bar (the "added, never substituted" idiom, and the shape hand-fill's governance guard already
   uses). *Built on branch `permission-review-security-fixes`.*
2. **Pairing** — a new `federation:pair` permission gates adding or re-keying a peer. Import, export,
   status, outposts, resync and poke stay on `federation:write`, so the link keeps working. Granted to
   Administrator, Owner and OrgAdmin; **withheld from FederationAdmin**.

**The import path is deliberately NOT gated.** A throw there wedges a peer's whole signed bundle —
that carve-out is correct and must survive. Closing pairing is what closes the chain: an import from a
*legitimately paired* peer writing what that peer sent is the federation contract working as designed.

`federation:pair` granted to Administrator + Owner **narrows nothing that exists today** (they are the
only `federation:write` holders), so the migration is a behavioural no-op on every live deployment.

### 4.2 Every scoped role is 403'd on the read surface

The design's entire premise is bindings *below* the org root. But `scopeExpandCte` walks **upward
only**, so any `authorize()` pinned at `scopeObjectId: auth.orgId` passes for an org-root binding and
**nothing else**. A filterless count finds **80 such sites** in `apps/server/src/routes`, of which
**30 demand `object:read`**, plus `relationship:read`, `audit:read` and `graph:query`.

Concretely: a ComponentAdmin bound at a component holds `change:accept` but **cannot GET the change it
is accepting** (`changes.ts:276-277`, `:310-311`), cannot list changes (`:251-252`), cannot list
components (`components.ts:275-276`).

Relatedly: `audit:read` is granted to four of the five new roles and is **unreachable from every
scoped binding**.

*Fix — a new build step before the role seed.* Two shapes, both needed: (a) get-by-id doors still
pinned at org root switch `scopeObjectId` to the resolved object's own id — the pattern
`components.ts:310-311` and `typed-registries.ts:311-315` already use; (b) LIST doors need scope
*filtering*, not a blanket org-root demand.

### 4.3 `change:accept` re-scoped to the containment parent is inert

The design re-scopes accept/rollback from `auth.orgId` to the change's declared containment parent. In
practice **that parent is the org root for essentially every change**:
`resolveDeclaredContainmentParent` returns `undefined` when nothing is declared
(`containment-parent-authz.ts:130`), and `changes.ts:169` falls back to `declaredParent ??
auth.orgId`. A filterless census of `proposeChange` callers finds six — the five internal ones
(`bump-actuator.ts:527`, `webhook-processor.ts:581`, `campaign-reconcile.ts:824`, `rollback.ts:84`,
`promotion-repo.ts:921`) pass **no `domainId` at all**.

*Fix:* check `change:accept` **per target**, the way `campaigns.ts:534` already checks `object:write`
at each named target. Needs no schema change and covers all five internal creation paths untouched.
(Alternative: infer `domainId` from the nearest common containment ancestor of `targets` and backfill.)

### 4.3a The `member_of` CREATE census (filterless, 2026-08-27) — every path that can create the edge

> ⚠️ **THIS TABLE IS SCOPED TO EDGE CREATION, AND THAT SCOPING IS ITSELF A FINDING.** It answers "who
> can write a `member_of` row", which is the right census for §2a's escalation guard and the WRONG
> one for the administrator floor — a narrowing that hid three live bricking paths for a round. The
> floor's census, by the property *"a write that can reduce the set of live principals reaching an
> administrative binding"*, is **§4.3b**. Read them together.

Censused by PROPERTY — *"code that can cause a `relationships` row with `type_id = 'member_of'` to
exist"* — not by the string `member_of`, using `grep -rna` throughout. Two passes: every caller of
`createRelationship`, and every raw `INSERT INTO relationships` / `tx.insert(relationships)` in the
tree.

| Path | Can it write `member_of`? | Verdict |
|---|---|---|
| `POST /relationships` (`routes/relationships.ts`) | Yes — free-form `typeId` | **Covered.** Calls `createRelationship`; the guard is inside it. |
| **IaC apply** (`iac/plans-repo.ts:1495`) | Yes — the manifest diff's free-form `typeId` | **Covered, and PINNED** by `iac/iac-member-of-role-escalation.integration.test.ts`. Its own `prepareApplyChecks` mirrors only the both-endpoint `relationship:write`, so this was a live second door. |
| **Discovery accept** (`routes/executors.ts:1168`) | Yes — `proposedRelationship.typeId` is free-form | **Covered** by the choke point. Not separately pinned: reaching it needs a discovery provider that proposes a `member_of`, which no shipped provider does. |
| **Federation import** (`federation/import-repo.ts:420`) | Yes — `String(payload.typeId)` | **DELIBERATELY EXEMPT.** `if (!input.federationImport)`, the mechanism `assertMayWriteGovernanceLabels` and `assertValidCampaignRecipe` already use: that replay branch skips a 400 per entry but re-throws anything else, so a 403 would abort a peer's whole signed bundle. A replicated membership was decided at the authoring domain's own door. **Not pinned by a test.** |
| **`routes/ownership.ts:156`** (`POST {base}/{id}/owners`) | **No** — `typeId: "owns"`, a literal | Out of reach by construction. **MISSED BY THE FIRST PASS OF THIS CENSUS** — see the re-run note below. |
| **`routes/ownership.ts:348`** (`POST {base}/{id}/{consumes\|depends-on}`) | **No** — `typeId: relTypeId`, whose TypeScript type is the closed union `"consumes" \| "depends_on"` and whose two call sites (`:478`, `:484`) pass those literals | Out of reach by construction. **MISSED BY THE FIRST PASS.** |
| `graph/components-repo.ts` (2 sites), `graph/placements-repo.ts`, `coordination/changes-repo.ts`, `coordination/campaign-reconcile.ts`, `coordination/correlation.ts`, `federation/overlay-repo.ts` | **No** — each passes a hard-coded `typeId` (`contains`, `places`/`placed_at`, `depends_on`, `coordinates`, `correlates`, `annotates`) | Out of reach by construction. |
| `governance/approvals-repo.ts:317` — the one raw `tx.insert(relationships)` outside the repo | **No** — `const relTypeId = "approves"` | Out of reach by construction. It bypasses `createRelationship` entirely, which is worth knowing; it cannot write this edge. |
| **Plugin host** (`plugin-host/`) | **No** | A filterless search finds no relationship write of any kind in that directory. |
| **Seed / bootstrap** (`seed.ts`, `scripts/seed-*.mjs`) | Through the API only | `seed.ts` drives `@scp/sdk` against the real server, so it inherits the guard. `auth/local-auth.ts` and `auth/oidc.ts` write `role_bindings` and no edges; `oidc.ts` has **zero group handling**, so there is no IdP-group→`member_of` sync to cover. |
| Raw `INSERT INTO relationships` in `load-test/graph-scale.ts` and three integration tests | Yes, trivially | Out of scope — not production paths, and the test harness writing state the door refuses is what makes the pre-deprecation fixtures possible at all. |

**CENSUS RE-RUN 2026-08-27, and the first pass was incomplete.** It reported 12 of the 14 production
`createRelationship` call sites and silently omitted both of `routes/ownership.ts`'s. Neither can
write `member_of` — so the *verdict* was unaffected — but that is precisely the reasoning that makes
an incomplete census invisible: a site left out of the table is indistinguishable from a site that was
examined and cleared. The re-run command, with no filters, is

```
grep -rna "createRelationship(" apps/server/src | grep -v createRelationshipType
```

which lists 13 call sites plus the definition in `graph/relationships-repo.ts:309` (14 lines). Every
one is now a row above. The omission is recorded rather than quietly patched because the property that
produced it — censusing from the *previous table* instead of from the tree — is the one that produces
the next one.

**Still open after this change**, all stated in `authz/role-binding-door.ts` §8 rather than implied:
the federation-import path (by design, and now pinned in both directions by
`federation/federation-member-of-exemption.integration.test.ts`); the fact that §2a applies the subset
rule but **not** bar §1, so a delegation without `role_binding:write` is possible for an actor who
already holds the authority being delegated; and the blind grant §2b bounds and §2c witnesses but
neither closes.

### 4.3b The ADMINISTRATOR-FLOOR census (filterless, 2026-08-27) — every write that can falsify it

The property, stated before the search rather than inferred from it: ***a write that can reduce the
set of live principals reaching an org-root `allow` role binding whose role carries
`role_binding:write`.***

The predicate reads exactly four things, so the census is the census of writers to those four:
`role_bindings` rows at the org root; `roles.permissions`; live `member_of` rows in `relationships`;
and `objects.deleted_at` / `objects.type_id`. Commands, no filters, `grep -rna` throughout:

```
grep -rna "update(objects)\|UPDATE objects"           apps/server/src
grep -rna "update(relationships)\|UPDATE relationships" apps/server/src
grep -rna "update(roles)\|UPDATE roles"                apps/server/src
grep -rna "\.delete(objects)\|\.delete(relationships)\|DELETE FROM objects\|DELETE FROM relationships\|DELETE FROM role_bindings" apps/server/src
grep -rna "roleBindings)\|role_bindings"               apps/server/src
grep -rna "deleteObject(\|deleteRelationship("         apps/server/src
```

| Write | Can it reduce the set? | Verdict |
|---|---|---|
| `deleteRoleBindingById` (`authz/roles-repo.ts:217`) — the ONLY `role_bindings` DELETE in the tree, one caller | Yes — door A | **Covered.** `routes/role-bindings.ts` calls `assertOrgRetainsAdministrativeFloor` AFTER the delete, gated by `revokeAffectsAdministrativeFloor`. |
| `deleteRelationship` (`graph/relationships-repo.ts:687`) — the only `UPDATE relationships SET deleted_at` in the tree | Yes — door B, and door C's cascade | **Covered at the choke point,** for `type_id = 'member_of'`, non-federation. Pinned through the HTTP door AND through IaC prune (`iac/iac-administrative-floor.integration.test.ts`). Its 12 callers (routes, IaC apply, `deleteObject`'s cascade, ownership, placements, components, component-merge, federation import) all inherit it. |
| `deleteObject` (`graph/objects-repo.ts:1840`) — the only `UPDATE objects SET deleted_at` in the tree | Yes — doors C and C′ | **Covered at the choke point,** after the tombstone AND after the edge cascade, gated by `objectTouchesRoleAuthority`. Its 9 callers (generic object route, components, typed registries, placements, component merge, outposts, IaC apply, federation import) all inherit it. |
| **IaC apply** (`iac/plans-repo.ts:1490` relationship prune, `:1950` object prune) | Yes — it calls both functions directly, never through a route | **Covered** by the choke-point placement; the relationship arm is PINNED, the object arm is not (named in the IaC suite). |
| **Federation import** (`federation/import-repo.ts:376`, `:457`) | Yes | **DELIBERATELY EXEMPT**, `!input.federationImport`, the mechanism §2a already uses: `import-repo.ts`'s replay branch re-throws anything but a 400, so a 409 would abort a peer's whole signed bundle over a replica this instance has no authority to keep. **Not pinned by a test.** |
| Foreign-shadow removal (`deleteObject`'s `removedForeignShadow` arm) | Yes | **DELIBERATELY EXEMPT**, same carve-out the edge cascade and the orphan guard take. **Not pinned.** |
| `roles.permissions` | Yes — dropping `role_binding:write` from the last administrative role empties the candidate set | **No runtime writer exists.** A filterless `UPDATE roles` search returns ZERO hits in `apps/server/src`; only migrations write it. Recorded as open in `role-binding-door.ts` §8: **step 10's custom-role authoring API is a fourth door onto this invariant** and must call the predicate. |
| `objects.type_id` | Would matter (a `user` becoming something else stops counting) | **Not writable.** No `update(objects)` site sets it — `updateObject`, `artifacts-repo`, `stack-ownership`, `campaign-reconcile`, `publish-domain-local` set name/domain/properties/labels/provenance/`managed_by_stack`/`domain_local`/`updated_at` only. |
| `upsertObjectByUrn`'s hand-fill reconciliation (`objects-repo.ts:1526`) — the one `UPDATE objects` that changes `id` | Yes in principle: `role_bindings.subject_id` has NO FK, so a re-identified principal would strand its binding | **FEDERATION-IMPORT ONLY** (the branch is inside `if (input.federationImport)`), so it inherits the exemption above. Recorded because it is the only id-rewriting write in the tree and a census by table alone would miss it. |
| `createRelationship`, `insertRoleBinding`, `auth/local-auth.ts:84`, `auth/oidc.ts:178` | **No** — they only ADD reachability | Out of reach by construction. The grant door deliberately takes NO floor check. |
| `iac/stack-ownership.ts:85`/`:133`, `graph/artifacts-repo.ts:292`, `coordination/campaign-reconcile.ts:1309`, `federation/publish-domain-local.ts:220` | **No** — none sets `deleted_at`, `type_id` or any `role_bindings`/`roles` column | Out of reach by construction. Each was opened and read, not inferred from its filename. |
| Hard `DELETE FROM objects` / `relationships` / `role_bindings` | **No such statement in production code.** The only hits are three integration tests and `graph/rls.integration.test.ts`'s negative assertion | Out of reach by construction. |
| `test-support/harness.ts:462`/`:555`/`:582`, `load-test/graph-scale.ts` | Yes, trivially | Out of scope — not production paths, and the harness writing state the doors refuse is what makes the pre-guard fixtures possible at all. |

**What this census does NOT claim.** It is complete over the four inputs *as the predicate reads them
today*. It says nothing about a future writer, and the honest guard against that is not this table but
the after-the-write placement: a new caller of `deleteObject` or `deleteRelationship` inherits the
check without being enumerated here, and only a brand-new writer of these tables (step 10's role
authoring API is the known one) would escape it.

### 4.4 Notable non-blockers

- The no-escalation subset rule is **bypassable via `member_of`** — the design never mentions group
  membership — and is **unsound for `effect='deny'` rows**.

  > **CLOSED 2026-08-27, in step 5's own PR, on an owner ruling to fix it there.** A role binding held
  > by a group resolves for every member (`authz/resolve.ts`'s `subject_expand`), so writing a
  > `member_of` edge into a role-bearing group conferred that role with no `role_bindings` row for the
  > joiner. Creating the edge takes `relationship:write` at both endpoints — a check designed for
  > exactly this and load-bearing only against a NARROW holder — so **the escalation floor was
  > Operator**, four rungs below Administrator. Pre-existing, but step 5 makes the precondition
  > routine: it ships `group`/`team` as first-class binding subjects and 0099's purpose roles exist
  > partly to be bound to teams.
  >
  > **The fix:** `authz/role-binding-door.ts` §2a applies the identical subset rule (composing the
  > same `missingPermissionsFor` helper, so there is one definition of "a subset") at
  > `graph/relationships-repo.ts`'s `createRelationship` — the CHOKE POINT, so IaC apply, discovery
  > accept and every other edge writer inherit it — under the `federationImport` carve-out that
  > function already takes for `assertMayWriteGovernanceLabels`. **Removal is untouched**: leaving a
  > group is a narrowing. Pinned by `routes/rbac-role-binding-door.integration.test.ts` (the exploit
  > chain, its admission pair, and the binding-free common case) and by
  > `iac/iac-member-of-role-escalation.integration.test.ts`, which is the only case that goes red when
  > the guard is moved from the repo function to the route.
  >
  > **THE FIX ABOVE CLOSED ONE ORDERING. The reversed one was measured the same day and needed a
  > third door.** §2a guards the JOIN; nothing guarded the GRANT. Measured on a fresh org with one
  > org-root Operator: the Operator joins an EMPTY team (201 — that is the common case and must stay
  > one), an Owner then binds `Owner` to that team (201 — the canonical documented action, and the
  > grant door never looked at who was in the group), and the Operator resolves as Owner.
  >
  > **What that ordering is, measured rather than asserted: a BLIND GRANT, not an escalation.** Step 2
  > clears §1 and §2 in full — its actor must hold `role_binding:write` at the org root and every
  > permission Owner carries there. **Every authority bar on the grant door is a question about the
  > ACTOR, the ROLE and the SCOPE; none reads the subject's identity.** So "could the granter have
  > granted this role to that principal directly?" has the same answer for every principal in the org,
  > and a guard phrased that way admits every request it is ever asked — a refusal that can never fire,
  > which reads as coverage and is worse than none. What is real is that the granter is empowering a
  > membership list somebody else authored (here, the beneficiary) and the API shows them nothing.
  >
  > **`authz/role-binding-door.ts` §2b** is what shipped: when a grant's subject is a `group` or
  > `team`, the door walks the membership DOWNWARD (`memberExpandCte` — the inverse of the walk §2a
  > and `hasPermission` use, emitted by the same `memberOfClosureCte` definition so the two directions
  > cannot disagree about a live edge, the bound, or cycle termination) and applies the two refusals
  > that ARE subject-dependent: a member that is **soft-deleted** (a direct grant to one is a 404,
  > through a group it was a 201 — the permission walk joins `relationships.deleted_at`, never
  > `objects.deleted_at`) and a member whose type cannot hold a binding. Transitive both ways; an
  > empty group stays a 201.
  >
  > **Still open, and stated rather than implied** — the full list is `role-binding-door.ts` §8:
  > §2a applies the subset rule and NOT bar §1, so an actor holding everything a group's bindings
  > carry may add a THIRD party without `role_binding:write` — a delegation the actor is not
  > authorised for, never an elevation. Demanding `role_binding:write` on every `member_of` write
  > would make ordinary team-membership management a role-administration privilege for any group
  > holding a binding; wider than the escalation being closed, and it wants an owner ruling. **The
  > blind grant itself** — **owner-ruled 2026-08-27 as D7 (§7.1) and BUILT in the same PR: informed,
  > not refused.** `acknowledgedPrincipalIds` on `POST /role-bindings`, verified as a SET against the
  > closure under §0's lock, 409 on any mismatch, `GET /role-bindings/grant-preview` to learn the
  > value. **The `deny`
  > unsoundness** above, unchanged — §2a reads `effect = 'allow'` rows only, because inheriting a deny
  > NARROWS the joiner. **Soft-deleting a principal revokes nothing** — the tombstoned object keeps
  > every `role_bindings` row naming it and `hasPermission` never joins `objects`, so it still
  > resolves and the principal can re-login. That belongs to the DELETE door (it has its own audit and
  > Decision records to write and its own undelete question), NOT to this one, which governs writes to
  > `role_bindings`; what this door does is refuse to make it worse — §2b will not write a new binding
  > that reaches a tombstoned principal and §7 will not count one as an administrator.
  >
  > **§7's 409 USED TO CONTRADICT THIS, and was corrected 2026-08-27.** It told the operator that a
  > binding "on a group whose only members are soft-deleted, empowers nobody" — measurably false for
  > exactly the reason above. The message now says what is true: those principals do still resolve and
  > soft-delete revokes nothing today; they are excluded from the floor because the estate has
  > recorded them as removed and this door refuses to write a new binding reaching one, so they are
  > not an administrator an operator can be told to rely on.
  >
  > **The ROLE-NAME half — ONE SHAPE closed with §2b, and the general property left OPEN.**
  > `hasRoleAtScope` resolves approval quorums by matching `rl.name` with no `org_id` predicate, so a
  > zero-permission org row named `'Approver'` confers quorum eligibility while being vacuously a
  > subset of everything. The grant door already refused binding such a row; §2a's permissions-only
  > test did not refuse INHERITING one. Both now call the one `builtInNameCollisionReason` predicate.
  >
  > **CORRECTED 2026-08-27 — this bullet used to end "for built-in roles name and permissions travel
  > together, so … no name check is added there", which reads as the whole story and is not.** Quorum
  > eligibility is a property of the NAME for EVERY role, built-in included, and it is independent of
  > the permission array. MEASURED: `Approver` is a strict permission-subset of `OrgAdmin`, so an
  > OrgAdmin may grant it — and the grantee then resolves `hasRoleAtScope('Approver')` where the
  > OrgAdmin who granted it does not. So a permissions-subset actor can seat a quorum voter for every
  > policy naming a role it is not itself eligible for. Recorded as open in
  > `authz/role-binding-door.ts` §2a and §8 and pinned as a MEASUREMENT (not a guard) in
  > `routes/rbac-role-binding-door.integration.test.ts`, so the statement changes colour if anyone
  > closes it. **Not closed here, and it wants an owner ruling:** the obvious bar — "the actor must
  > itself hold role NAME R at that scope" — refuses OrgAdmin granting ServiceAdmin and
  > ComponentAdmin, which is the delegation §3 is built around, and every narrower rule picks which
  > delegations survive.
  >
  > **§2b's 422 was also reordered** to run AFTER both authority bars (2026-08-27). It was placed with
  > the shape refusals "because it IS one"; its body names the ids, names and types of the principals
  > inside a group, so ahead of bar §1 it answered "who is in this group?" for a caller with no
  > standing at all. §7's 409 was already after the bars for the same reason; the rule is now "a
  > refusal whose body is derived from rows the request does not name goes after the authority bars",
  > and both follow it.

- **The subset rule is a WRITE-time test and a granted role can outgrow its granter.** Confirmed by
  measurement, not projected: OrgAdmin grants ComponentAdmin (a proper subset — admitted), a later
  migration `array_append`s `governance:move` to ComponentAdmin, and the untouched binding now confers
  a permission the granter may not hold at that scope. Five migrations (0010, 0012, 0083, 0088, 0094)
  have appended to a built-in, so this is how the schema normally evolves. **Not fixable in the door**
  — re-testing at resolve time would put ~20 `hasPermission` probes on every authorization in the
  system and would make a subject's authority depend on the current authority of a granter who may
  since have been revoked. **Recorded in `authz/role-binding-door.ts` §6, and it belongs to step 4:**
  the permission-drift gate is the only place that observes a role's array CHANGE, which is the event.
  The assertion worth adding there is that a migration widening built-in role R must state which
  existing bindings of R it widens — computable, because every grant's Decision persists
  `grantedPermissions` as the array stood at the grant.

- **No last-administrator floor on revoke.** Measured on a fresh org with only its bootstrap admin:
  `DELETE /role-bindings/<own Owner binding>` returned 200 and left ZERO bindings, after which every
  endpoint 403s (`GET /roles` and `GET /role-bindings` included) with no recovery through the API,
  because restoring a binding needs the `role_binding:write` nobody now holds. Both authority bars
  pass legitimately, so it is an availability defect rather than an authz one. **Closed in step 5**:
  `assertNotLastAdministrativeBinding` refuses with 409 when the row is the last `effect='allow'`
  org-root binding of a role carrying `role_binding:write`, inside the same `withTenantTx` as the
  delete.

  > **CORRECTED 2026-08-27 (second time) — "inside the same `withTenantTx` … so the count and the
  > delete cannot race" was FALSE, and the same sentence appeared in two code comments.** One
  > transaction is necessary and is not sufficient: PostgreSQL's default READ COMMITTED gives every
  > STATEMENT a fresh snapshot, so two concurrent revokes each read a survivor and both commit.
  > MEASURED — fresh org, two actors, `Promise.all` of two `DELETE /role-bindings` for the last two
  > org-root administrative bindings: `[200, 200]` with zero administrative bindings left and
  > `GET /roles` 403 (attempt 1), `[200, 409]` (attempt 2), `[409, 200]` (attempt 3). **Strictly
  > easier to reach than the two-request empty-group bypass the reachable-principal rewrite closed**,
  > because it needs no group and no second grant.
  >
  > **The same unserialized shape defeated §2a/§2b**, and differently: a `member_of` write and a
  > `POST /role-bindings` touch different tables and each reads rows the other has not written yet,
  > so no `SELECT ... FOR UPDATE` can serialize them — a row lock cannot lock a row that does not
  > exist, and there is no predicate locking outside SERIALIZABLE.
  >
  > **Closed with one instrument: `lockOrgRoleAuthority`**, a transaction-scoped advisory lock on
  > `hashtext(org_id)` — deliberately the SAME key `audit/audit-repo.ts` already takes per org, since
  > a second per-org key would be acquired authority-then-audit by these doors and audit-then-
  > authority by any transaction that audits before writing a `member_of` edge (an IaC apply), which
  > is a deadlock. Taken at three entry points: both role-binding handlers, as the first statement of
  > their transaction (a read taken before the lock is a read the lock does not protect), and inside
  > `assertMayJoinRoleBearingSubject` itself, because `createRelationship` has thirteen callers.
  > Pinned by two `Promise.all` cases in `routes/rbac-role-binding-door.integration.test.ts`, each
  > mutation-proven from BOTH sides; the sequential cases that already pinned §7 and §2a/§2b all
  > stayed green against the racy code, which is why a sequential test cannot be the pin. Full
  > reasoning, cost, and what it does not cover: `authz/role-binding-door.ts` §0.

  > **CORRECTED 2026-08-27 — the first version counted ROWS and was bypassable in two requests.**
  > A binding on an EMPTY group is a row that resolves for nobody, so: bind a `role_binding:write`
  > role to a team nobody is in, then revoke the real Owner. The floor saw two rows, permitted the
  > delete, and left the org unadministrable — recoverable only by hand-written SQL, verbatim the
  > failure mode the guard exists to eliminate. It now counts **reachable principals**: a surviving
  > binding counts only when some live principal actually resolves through it, walked with the shared
  > `memberExpandCte` (one walk per surviving subject, short-circuiting on the first live hit, still
  > inside the delete's transaction). A tombstoned member does not count, for the same reason §2b
  > refuses to write a binding that reaches one. (The *reachable-principal* test as first written
  > asked for a live `user` or `service-account`; the correction four paragraphs down replaces that
  > type test with the credential.)

  > **CORRECTED 2026-08-27 (third time) — THE FLOOR GUARDED ONE OF FOUR DOORS, AND THE OTHER THREE
  > NEEDED NO CONCURRENCY.** `assertNotLastAdministrativeBinding` was a REVOKE-TIME rule owned by
  > `routes/role-bindings.ts` and phrased as "what would be left if I removed THIS binding". Measured,
  > four plain sequential requests each:
  >
  > | Door | What it does | Before |
  > |---|---|---|
  > | `DELETE /role-bindings/{id}` | revoke the binding | **guarded** |
  > | `DELETE /relationships/{id}` | remove the `member_of` edge under a group's administrative binding — **the binding row survives**, so the revoke-time rule never runs and counts a row that resolves for nobody | **200, org bricked** |
  > | `DELETE /objects/team/{id}` | tombstone the group holding it; the edge cascade is the row above, in bulk, from a door that never mentions RBAC | **200, org bricked** |
  > | `DELETE /objects/user/{id}` | tombstone the principal holding it DIRECTLY — removes no edge at all, so even a cascade-aware guard misses it | **200, org bricked** |
  >
  > **The fix makes the floor an INVARIANT OF THE ORG, enforced wherever it can be falsified, from
  > ONE predicate.** `assertOrgRetainsAdministrativeFloor` — "does at least one LIVE principal THAT
  > CAN AUTHENTICATE resolve an org-root `allow` binding of a role carrying `role_binding:write`" —
  > is evaluated **AFTER** the write, inside the write's transaction, at the CHOKE POINTS
  > (`graph/objects-repo.ts`'s `deleteObject`, `graph/relationships-repo.ts`'s `deleteRelationship`,
  > and the revoke handler), taking the same `lockOrgRoleAuthority` key. The after-the-write ordering
  > is the design: a before-check must MODEL the write, and every door then needs its own model — which
  > is exactly what produced three disagreeing rules. An after-check asks the database what is true and
  > is blind to which verb ran, so a CASCADE, a bulk path or a door nobody has written yet is covered by
  > construction rather than by a census staying complete. Pinned by
  > `routes/rbac-administrative-floor.integration.test.ts` (eleven mutations) and, for the
  > choke-point placement, by `iac/iac-administrative-floor.integration.test.ts`: moving the guard up
  > into `routes/relationships.ts` leaves the route suite 8/8 green while `POST /plans/{id}/apply`
  > goes on pruning the membership. Federation import stays exempt by the same mechanism §2a uses.
  > Accepted consequence, stated in `role-binding-door.ts` §7: an org ALREADY below the floor is
  > refused a floor-relevant write; it is not wedged, because a soft-deleted principal still resolves
  > and can still grant.

  > **CORRECTED 2026-08-27 (fourth time) — THE PREDICATE COUNTED GRAPH OBJECTS, NOT PRINCIPALS THAT
  > CAN AUTHENTICATE.** Measured with three plain sequential requests, all 2xx, no concurrency and no
  > privilege beyond the bootstrap admin's:
  >
  > | # | Request | Result |
  > |---|---|---|
  > | 1 | `POST /api/v1/objects/user {"name":"phantom"}` | **201** — a `user` GRAPH object with **no row in `users`**, so no credential exists and none can be created |
  > | 2 | `POST /api/v1/role-bindings {phantom, Owner, org root}` | **201** — correctly; D7 exempts a `user` subject from the acknowledgement by design |
  > | 3 | `DELETE /api/v1/role-bindings/{the bootstrap admin's own}` | **200** — the floor ran, found the phantom, and PASSED |
  > | 4 | `GET /api/v1/roles` | **403. ORG BRICKED**, hand-written SQL the only recovery |
  >
  > **This predicate had then been bypassable three times in the same direction** — binding ROWS (an
  > empty group satisfied it), live OBJECTS OF A PRINCIPAL TYPE (the phantom above) — so the fix
  > states the PROPERTY rather than another test of it: *at least one live principal **that can
  > authenticate** resolves an org-root `allow` binding of a role carrying `role_binding:write`*.
  >
  > **THE ANCHOR IS `users.object_id`,** joined per reached principal inside the same
  > `memberExpandCte` walk (so the credential fact and the liveness fact cannot disagree about a
  > concurrent write). A filterless census of every way an `AuthContext` is produced:
  > `auth/require-auth.ts` is the one seam, its two branches (`auth/pat.ts`, `auth/local-auth.ts`)
  > both end at `resolveAuthContext`, which reads a `users` row and returns
  > `subjectObjectId = users.object_id`; the four credential kinds — password, OIDC, PAT, device flow
  > — all funnel through it. No `users` row for an object ⇒ that object can never be the actor of any
  > request at any door.
  >
  > **THE TYPE TEST IS GONE, and dropping it is what keeps a SERVICE ACCOUNT counting.**
  > `resolveAuthContext` reads no `type_id`, so a `users` row naming a `service-account` object
  > authenticates and resolves RBAC exactly like one naming a `user`. Measured: **a service account
  > has no credential shape of its own** — `POST /api/v1/service-accounts` is a plain typed registry
  > that creates the graph object and nothing else, there is no service-account token table, and
  > `personal_access_tokens` is keyed on `users.id`. A `user`/`service-account` type test is therefore
  > wrong in BOTH directions: it counts a phantom of the right type, and it refuses a real
  > administrator of any other. Both directions are pinned by separate cases in
  > `routes/rbac-administrative-floor.integration.test.ts` and mutation-proven against each other's
  > bug (mutations 12 and 13).
  >
  > **KNOWN LIMIT, deliberately not closed:** `credentialed` means "a `users` row names this object",
  > not "a usable secret exists for it". A row with no password, no `oidc_subject` and no live PAT
  > counts. Every tighter anchor is time-varying — an expiring PAT would drop an org below the floor
  > with no write involved, and the floor is only ever evaluated ON a write — so the secret half
  > belongs to a credential-lifecycle door. `authz/role-binding-door.ts` §8 records it.
- **`OrgAdmin` is a strict subset of Administrator** after the proposed Migration B, so four of the
  five points in its rationale are false as written. It still earns its place via what it *withholds*,
  but the justification needs rewriting.
- **Migration A is not "zero behaviour change" and is not safe to merge alone** — three of its four
  pieces can hard-fail on a populated database (duplicate rows already present).
- No **proposer ≠ accepter** separation on `change:accept`, while both comparable doors have one.
- The build order **contradicts itself** on the campaign-deadline fix (step 3 ships it; step 8 says it
  is blocked on an owner ruling).
- **API-first parity is absent from the plan for four new surfaces** (charter principle 3).

---

## 5. Build order

Preconditions first; roles are inert until step 5.

**Step 0 is the owner-ruled sequencing decision (§7.1): the live defects are fixed first, as their own
work, before any role increment.** They are exploitable now and independent of the role design.

| # | Increment | Notes |
|---|---|---|
| **0a** ✅ | **SSE per-event `object:read` at fan-out** (§1.3a), on an isolated `max:4` pool | Null subject fails closed; one allowlisted resync type, rebuilt with an empty `data` |
| **0b** ✅ | **Campaign-deadline inversion** (§1.3b) — at the `updateObject` choke point, **and** as a delta over `deadline.overrides[]` | Ruling D1(b-i). The route-only fix was bypassable through IaC apply *twice* |
| **0c** ✅ | **Freeze-lift inversion** (§1.3c) — `freeze:override` to lift or shorten a freeze you did not declare | Ruling D1(a-ii), shipped as **M25.9**; supersedes the in-code open note |
| **0d** ✅ | **Hand-fill *and publish* doors** — `object:write` at the resolved scope (§4.1) | Publish had the identical property and was found by census, not by report |
| **0e** ✅ | **`federation:pair`** — gates adding or re-keying a peer (§4.1), migration **0094** | Ruling D4. Narrows nothing today; makes FederationAdmin's invariant true |

All of step 0 is built, mutation-proven and pushed on branch
`permission-review-security-fixes` — 9 commits, `pnpm check` green, 199 tests passing across the 11
affected suites. Steps 1–10 below are the role work proper and are **not** started.
| 1 | **DDL hardening** — partial unique index `roles(name) WHERE org_id IS NULL`; UNIQUE on `role_bindings`; `CHECK (effect IN ('allow','deny'))`; `GRANT DELETE ON role_bindings TO scp_app`; add `roles.bindable_at`. | Must handle pre-existing duplicates — see §4.4 |
| 2 | **Mutation-proven RBAC-across-assembly test** — a SERVICE binding reaches a component under an assembly. Prove it by deleting route 2's `contains` join and watching it fail. | Passes today; pure addition |
| 2.5 | **Re-scope the read surface** (§4.2) | **New — blocker fix** |
| 3 | **Permission splits + role seed** — `change:accept` / `secret:write` / `scan:override`; rewire six call sites; re-scope accept/cancel/rollback; `GET /decisions` → `audit:read`; close the campaign-deadline inversion; delete `org:admin`; seed the five roles. | **Breaking:** 403s live Operator accept/rollback. Announce. |
| 4 | **Permission drift test in CI** — exported `PERMISSIONS` array vs seeded role arrays vs a filterless call-site census, failing in **both** directions. **Plus the post-grant widening assertion (§4.4):** a migration that `array_append`s to a built-in must state which existing bindings of that role it widens. | No such array exists today |
| 5 | **Role + role-binding API** — `GET /roles`, `GET/POST/DELETE /role-bindings`, gated on `role_binding:write` at-or-above the binding's scope, **plus** the no-escalation subset rule, **plus** `bindable_at` validation, **plus** an audit event per grant/revoke. | Voids the three in-tree safety arguments (§1.2) |
| 6 | **Effective-permissions read surface** — roles+permissions on `GET /auth/me`, plus `GET /authz/effective?scopeObjectId=`. Plus `fromRole` authoring-time validation. | With five purpose roles the UI is unusable without it |
| ~~7~~ ✅ | ~~**SSE per-event `object:read` at fan-out** (§1.3a)~~ | **SUPERSEDED BY 0a — the same item.** The owner ruling that live defects be fixed first moved it into step 0, where it shipped; this row was never struck. Implemented in `routes/events.ts`, pinned by `routes/events-authz.integration.test.ts`. |
| ~~8~~ ✅ | ~~The two inversions~~ | **SUPERSEDED BY 0b + 0c**, and no longer blocked: decision #1 was ruled as D1(b-i) and D1(a-ii). Also never struck. |
| 9 ✅ | **Instance-tier credential redesign** — done, not deferred. `SCP_OPERATOR_TOKEN` replaced by named, argon2-hashed, individually revocable, optionally expiring credentials (migration **0104**, `auth/operator-auth.ts`); the env token is kept as the BOOTSTRAP credential so upgrades do not lock out and the first credential can be minted. The eight hand-written `requireOperator` copies collapse into one definition. Plus the two `createPool` residuals and the grants they needed (migration **0102**). | Owner ruled 2026-08-27 to implement rather than defer |
| 10 ✅ | **Custom roles** — `POST`/`PATCH`/`DELETE /roles` (migration **0103**). The `hasRoleAtScope` quorum bypass is CLOSED first, in its own commit: a role NAME now resolves against built-ins only, so a custom role can carry permissions and be bound but can never satisfy an approval quorum. `fromRole` is validated at policy-authoring time so a policy naming a non-built-in is refused where it is fixable rather than blocking forever. | Charter commitment, now satisfied |

**Do not ship custom roles in the same increment as the binding door.** (Honoured: the door shipped in
#307, and custom roles only after the bypass below was closed in its own commit.) `hasRoleAtScope` joins `roles`
with **no `org_id` predicate on the roles row** (`resolve.ts:299-303`) while the binding is
org-filtered — so an org creating a zero-permission role named `'Approver'` instantly makes its holders
eligible quorum voters everywhere a policy names Approver. A self-service quorum bypass.

**Migration numbering:** current tail is 0093. Numbering across open PRs is strictly serial in merge
order and journal contiguity is unit-tested — **re-run the census against main and renumber at merge
time.**

---

## 6. Doc corrections this work forces

- **DESIGN §7** describes the chain as `component -> service -> domain -> organization`. The shipped
  walk is **four routes**, covering assembly, placement and deployment-target.
- **DESIGN.md:355-366**'s `roles` / `role_bindings` DDL snippet is stale as of step 1: it shows
  `effect text NOT NULL DEFAULT 'allow'` with no CHECK, no `roles.bindable_at`, and neither unique
  constraint. Bring it in line with `drizzle/0097` (and with `db/schema.ts`, which the
  `rbac-ddl-preconditions` suite holds to the live DDL from both sides).
- **DESIGN.md:358** names `change:accept` in its one and only "example role bindings" comment. A
  filterless census finds it at exactly one place in the tree — **that line itself** — while
  `resolve.ts:41` claims to implement that example *"exactly."*
- **DESIGN.md:369**'s deny wording ("at a narrower scope") contradicts the implementation: deny at
  **any** matching scope wins (`resolve.ts:241-242`). Correct one or the other.
- **Charter Permission Scope list** must drop **Group** (a group is only ever a *subject*, expanded
  through `member_of`; no code path treats one as a containment scope) and add assembly, placement,
  deployment-target.
- `overlay-repo.ts:184` documents its census as `grep -rn` — the NUL-blind form CLAUDE.md forbids.

---

## 7. Owner decisions

### 7.1 Ruled 2026-08-25

**Sequencing — security fixes first.** The live defects in §1.3 are fixed as their own work, ahead of
any role increment: the SSE gap (§1.3a), the campaign-deadline inversion (§1.3b), the freeze-lift
inversion (§1.3c), and the hand-fill door (§4.1). They are exploitable now and do not depend on the
role design. Build order §5 steps 1–10 resume after.

**D1 — the two inversions: rule (a-ii) + (b-i).** `freeze:override` is required to LIFT or SHORTEN a
freeze **you did not declare** (compared on `created_by_actor_id`), covering `PATCH endsAt` too;
retracting your own freeze stays `freeze:write`, preserving the "entrance with no exit" ergonomic fix.
`campaign:deadline-override` is demanded on `POST /campaigns/:id/deadline` when the request **clears
the deadline or moves it later**; setting or shortening stays `object:write`. This supersedes the
"OPEN, PENDING AN OWNER RULING" note at `routes/governance.ts:709-741` and settles the three-way
disagreement between the code, `drizzle/0010`'s comment, and DESIGN §10.3.

**D3 — SecurityOfficer holds both `policy:write` and `scan:override`.** No sixth
`ScanWaiverApprover` role. The separation of duty that matters is between the estate administrator and
the security officer, and it is delivered by **OrgAdmin deliberately lacking `scan:override`**. The
existing compensating controls stand: `assertOverrideTierStanding` stops a requester self-selecting
the approving tier, the raiser≠approver check stops the one-actor shape, and the org-tier floor stops
a junior tier defeating a senior one.

**D2 — stands (not reopened).** `security:declare` is **not** split out of `object:write` in this
programme. The admission algebra is a real bound: a `declared_fact` clause has effect only if every
tier strictly above admits its class, `assertDeclaredFactClauseIsNarrowed` refuses an unnarrowed
clause, and the resolved value is pinned verbatim into the gate Decision. Recorded consequence:
**ComponentAdmin makes "the principal who benefits from a scan exclusion" a named, bindable role for
the first time** — materially new since D2 was taken on 2026-07-23. If the estate later runs scan
exclusions under delegated component admins, this is the decision to revisit, and the split gets more
expensive once ComponentAdmin bindings exist in the field.

**D4 — a second bar on federation PAIRING.** A new `federation:pair` permission gates adding or
re-keying a peer; import, export, status, outposts, resync and poke stay on `federation:write` so the
link keeps working. Granted to Administrator, Owner and OrgAdmin; withheld from FederationAdmin.
Full reasoning and the attack chain in §4.1. FederationAdmin's purpose narrows accordingly: it
**operates** the federation link, it does not **establish** trust relationships. The import path stays
ungated by design — a throw there wedges a peer's signed bundle.

**D5 — Administrator is DEPRECATED on arrival.** When the role-binding write door ships it refuses
**new** bindings to the built-in `Administrator`. The row stays (`role_bindings.role_id` is an FK and
`scp_app` holds no DELETE on `roles`) and every existing binding resolves unchanged — this is a
refusal at the write door, not a removal. Chosen over "leave grantable", so the purpose roles are
**the** migration path rather than a parallel option: Administrator's grab-bag is exactly what makes
"SecOps implies type-registry authority" true today, and leaving it grantable would keep it the path
of least resistance and the least-privilege story aspirational.

*Consequence to build for:* the write door needs a clear refusal message naming the purpose role to
use instead, and `GET /roles` should mark it deprecated so the UI can grey it. Deprecating before any
purpose-role binding exists means the obvious migration target 403s from day one — so **D5 makes the
role seed and the write door a single shippable unit**, not two increments.

**Sequencing, ruled 2026-08-26:** after step 0, the next work is the **read-surface blocker** (§4.2) —
not the cheap preconditions. Steps 1 and 2 follow it rather than preceding it.

**D6 — `OrgAdmin` HOLDS `federation:pair` (2026-08-27).** This document contradicted itself and the
contradiction was caught by `drizzle/0099` trying to copy §3C's list verbatim: §4.1 and D4 both grant
the permission to "Administrator, Owner **and OrgAdmin**", while §3C's list omitted it. **D4 governs**
— it is the later ruling and the one that reasoned about the permission rather than merely listing a
role. Its content was that *establishing* a trust relationship differs from *operating* one, so the
role that operates the link must not decide whose signature this instance believes. That names
**FederationAdmin** as the withholding, and it is the only one. Withholding it from OrgAdmin as well
would leave an org whose only pairing principals are Owner and the D5-deprecated Administrator —
unadministrable in exactly the dimension OrgAdmin exists to cover. §3C corrected to match.

*Process note worth keeping:* a first draft of 0099 withheld it **fail-closed** and escalated rather
than guessing, which was the right instinct — adding a permission later is an `array_append`, whereas
removing one from a shared singleton row narrows every org on every deployment at once and has no safe
shape (§2). When two clauses of this document disagree, fail-closed and escalate; do not let a seed
literal silently pick a side.

**D7 — THE BLIND GRANT IS MADE INFORMED, NOT REFUSED (owner ruling 2026-08-27).** Binding a role to a
group empowers whoever is in it, including a principal who self-joined while it was empty. That is
**not** an escalation — the granter already holds the role — and a previous round measured that no
membership-shape-blind rule separates it from the legitimate "bind SecurityOfficer to the security
team", while edge-authorship would refuse the legitimate case. **The owner ruled: make the grant
informed.**

`POST /api/v1/role-bindings` takes **`acknowledgedPrincipalIds`** — the granter's statement of whom
the binding will empower. What was decided, and why:

- **AN ID LIST, not a count and not a digest.** A count is producible without ever reading the
  membership (the exact blindness being fixed) and is unchanged by a substitution. A digest needs the
  same input an id list needs and destroys the server's ability to name the DIFFERENCE. An id list is
  the only shape in which the caller has demonstrably handled every principal, and it lets the
  mismatch be reported in both directions.
- **THE VALUE IS THE FULL `member_of` CLOSURE at `depth > 0`** — nested groups included, since a
  nested group is itself empowered — computed by the same `memberExpandCte` walk §2b uses, so the
  field can never mean something different from what the binding does.
- **409 ON MISMATCH, NAMING BOTH DIRECTIONS:** reached-but-not-acknowledged (a member joined between
  the caller's read and its write — the case the field exists for) and acknowledged-but-not-reached.
  409 rather than 422 because the body is well formed and re-reading fixes it. The ONE 422 is the
  absent field, which no retry of the same body fixes.
- **OPTIONAL IN THE CONTRACT, REQUIRED AT THE DOOR.** The requirement is conditional on the subject
  being a `group`/`team`, which a schema-level `required` cannot express — it would force `[]` on
  every grant to a user, the common case the ruling says not to burden. It is additive either way
  here (the operation is new in this PR, so oasdiff sees a path addition), but optional-with-refusal
  is the shape that stays true if the operation is ever cut and re-landed.
- **THE EMPTY GROUP: `[]` IS EXPRESSIBLE AND MEANS "I looked and it is empty".** `undefined` means "I
  did not look" and is refused. `[]` is admitted because acknowledging zero is TRUE at the moment of
  the grant, and because seating the team afterwards runs §2a's subset rule at the choke point — an
  empty group can only be filled by a principal who already holds everything it carries.
- **`GET /api/v1/role-bindings/grant-preview?subjectId=…`** returns the value ready to paste, plus
  per-principal detail (`deleted`, `bindable`, `depth`) for a UI. Without it the field is unusable
  from a CLI: the closure is transitive, so `GET /relationships` cannot answer it and a client would
  have to re-implement the walk. Gated on `audit:read` from the same `checkAtOrgRootOrScopes`
  disjunction `GET /role-bindings` uses — group membership is the same class of accountability data.

  **THE AFFORDANCE LEAKED TWICE, AND BOTH FIXES ARE PART OF D7 RATHER THAN FOOTNOTES TO IT.** The
  bar is *the preview must not tell a caller anything they could not already read.*
  1. **THE GATE.** It shipped taking a caller-chosen `scopeObjectId` and authorizing at it, so any
     holder of a scoped `audit:read` anywhere could name their own service and read any group's
     transitive membership. The parameter is GONE and the check is anchored to the SUBJECT.
  2. **THE PROJECTION, which anchoring could never have fixed — the principals disclosed are not the
     subject.** A member is a separate graph object on its own containment chain and the scope walk
     expands upward, so `audit:read` at a TEAM says nothing about that team's members. MEASURED: a
     team-scoped Viewer got a **200** carrying a member's id, type and name while the same token's
     `GET /objects/user/{id}` answered **403**. `principals` and `acknowledgedPrincipalIds` now
     contain only principals the caller holds `object:read` at (composed from
     `authz/readable-scope.ts`, not re-derived), and the rest is a bare `withheldPrincipalCount`.

  **D7 STILL WORKS, AND WHO IT WORKS FOR IS MEASURED.** Every built-in role carrying `audit:read`
  also carries `object:read` (asserted against the live catalogue), so a caller admitted by the
  ORG-ROOT arm — the granter who binds an administrative role at the org root — reads every rooted
  object and gets `acknowledgementComplete: true`. The residual population is a caller admitted only
  by the SCOPED arm whose `object:read` does not reach the members; they get
  `acknowledgementComplete: false`, and they are **not** handed a field that 409s forever, because
  `POST /role-bindings`'s own 409 names every id missing from the acknowledgement — behind
  `role_binding:write` plus the full subset rule, a strictly stronger bar than this operation's
  `audit:read`. Pinned end to end (403 on the member, filtered preview, 409 naming the member, 201
  on the retry) in `routes/rbac-administrative-floor.integration.test.ts`.
- **THE ACKNOWLEDGED SET IS PERSISTED** on the grant's Decision alongside `grantedPermissions`, so the
  estate can afterwards say not just what authority was handed over but to whom the granter believed
  they were handing it.

**What it is not:** it refuses nothing an informed granter may do, and it is a point-in-time witness —
somebody joining the group tomorrow is empowered by this binding and no acknowledgement is asked for,
because the JOIN door (§2a) judges that, by the subset rule rather than by consent. Recorded in
`role-binding-door.ts` §8 rather than implied.

**Operations touched (for the oasdiff gate — `pnpm gen` NOT run in this round).** MEASURED by
building the document from the live `routeRegistry` — the same `buildOpenApiDocument` path `pnpm gen`
writes `tools/openapi/openapi.v1.json` from — and diffing it against the committed file, rather than
listed from the source diff. **The source diff would have said "four routes", and the answer is 18
operations**, because `routes/typed-registries.ts`'s DELETE is one template behind ten resources:

- **5 NEW operations**, absent from the committed document entirely, so additive by construction:
  `listRoles` (`GET /roles`), `listRoleBindings` (`GET /role-bindings`), `previewRoleBindingGrant`
  (`GET /role-bindings/grant-preview`), `createRoleBinding` (`POST /role-bindings`),
  `deleteRoleBinding` (`DELETE /role-bindings/{id}`).
- **13 EXISTING operations, each gaining exactly `409` and nothing else** — no response code removed,
  **no request body changed and no parameter changed on any of them** (diffed field by field):
  `deleteObject`, `deleteRelationship`, `deleteComponent`, and the ten typed-registry deletes
  `deleteDomain`, `deleteService`, `deleteAssembly`, `deleteDeploymentTarget`, `deleteTeam`,
  `deleteGroup`, `deleteUser`, `deleteServiceAccount`, `deletePolicy`, `deleteControl`. An added
  response code is additive on this repo's gate. Declared because they can now return the
  administrator floor's 409, and pinned by `routes/rbac-administrative-floor.integration.test.ts`'s
  contract case.
- **`acknowledgedPrincipalIds` IS OPTIONAL IN THE EMITTED SCHEMA — confirmed from the document, not
  from the Zod source.** `POST /role-bindings`'s request `required` array is
  `["subjectId","roleId","scopeObjectId","reason"]`; the field is absent from it. No existing client
  breaks even if the operation is later cut and re-landed.
- No existing response field changed, and nothing was made optional.

### 7.3 Still open
1. **Instance-tier credential redesign in this programme, or does `SCP_OPERATOR_TOKEN` stand?**
   *Recommend:* keep the token for now, schedule the redesign as its own milestone — but **record it
   as a decision with consequences named, not inherited as a default.** Explicitly reject "bind
   FederationAdmin at every org root" as a substitute.
2. **Do custom roles ship at all?** The charter carries two flat imperatives — *"Roles should be
   customizable"* and *"Organizations should be able to define additional roles"* — and this design
   satisfies neither. *Recommend:* later, gated. "Never" means amending the charter, which is a
   charter-level act and should be made deliberately rather than by omission.
   **D5 sharpens this:** with Administrator deprecated, an org that wants a broad general-purpose role
   has no built-in to bind and no API to author one.
*(Item 3 — whether `OrgAdmin` holds `federation:pair` — is **closed**; see D6 in §7.1.)*

---

## 8. The read-surface blocker (§4.2), scoped

Analysis 2026-08-26, three parallel passes. Costs below were **measured** on a purpose-built
20,910-object estate (18,500 components / 1,900 assemblies / 500 services / 5 domains, 20,400
`contains` edges) on PostgreSQL 16 with all migrations applied and `ANALYZE`d — not estimated.

### 8.1 The census was wrong, in the way this repo keeps being wrong

`grep -rna 'scopeObjectId: auth.orgId' apps/server/src/routes/*.ts` returns 81 lines; one
(`governance-move.ts:142`) is inside a comment. So 80 real sites. **But the string census misses the
surface entirely in two places:**

- **`routes/objects.ts` contains ZERO `authorize(` calls.** Its four routes — `POST`/`GET
  /api/v1/objects/service` and the `/orgs/:org/` variants — delegate to `services/objects-service.ts`,
  where the check is spelled `scopeObjectId: orgId` (`:116` a LIST, `:70`/`:77` a CREATE). Same
  property, different spelling, one directory away.
- **9 further create doors carry it latently** as `X ?? auth.orgId`: `objects-generic.ts:229,235`,
  `typed-registries.ts:211,218`, `campaigns.ts:152`, `changes.ts:169,183`, `objects-service.ts:70,77`.

Census by property — *"this check can only be satisfied by an org-root binding"* — not by string.

### 8.2 The LIST fork is settled by pagination, not by cost

**Per-row filtering (shape 1) is disqualified, and it fails silently.** Every list repo is
keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from the last *unfiltered*
row. Post-filtering shrinks a page **after** the LIMIT.

Measured: an assembly-bound ComponentAdmin's 5 readable components sit at cursor ranks 97, 140, 254,
339 and 440 of 18,500. At `limit=100` that is **one readable row on page 1, one each on pages 2–5, and
zero on pages 6 through 185 — each with a non-null `nextCursor`.** And **27 of 30** `apps/web` list
call sites fetch exactly one page. So the Components view renders 1 of their 5 components and stops:
wrong, silent, and worse than the 403 it replaces. (Cost is also bad — 0.96–1.08 ms/row, so 96 ms per
100-row page against 1.05 ms today — but pagination is what kills it.)

**Recommendation: query-side intersection (shape 2), two-query form, with an org-root short-circuit.**

1. Export `containmentChildrenSql(orgId, parentIdSql)` from `graph/containment.ts` — the three
   downward arms — and refactor `containmentSubtreeExceeds`'s `down` CTE to compose it.
2. `authz/readable-scope.ts` → `readableRootsFor(tx, {orgId, subjectObjectId, permission})`, one query
   returning `{rootId, effect}`. Measured **0.3–0.5 ms**, uses the existing
   `role_bindings_subject (org_id, subject_id)` index.
3. `readableObjectFilterSql(orgId, allowRoots, denyRoots)` → **`null` when `allowRoots` contains
   `auth.orgId`** (the short-circuit: today's query verbatim), else a recursive descend seeded from
   `unnest($allowRoots::uuid[])`, **minus a second descend from `denyRoots`**.
4. Push it **inside** the repo functions, **before the LIMIT**. `listObjects` has exactly four callers,
   so this covers `/objects/{type}`, `/components`, `/objects/service` and every typed registry at once.
5. **Keep the org-root `authorize()` at the top of each door unchanged**, so a subject with no allow
   binding anywhere still gets today's 403. That makes the change a **pure widening** — everything that
   works today still works, identically.

> **The drift objection is the reason for step 1, not an argument against shape 2.**
> `containmentSubtreeExceeds` already mirrors the four upward routes by hand, and its own docblock
> names the drift that produced a service-scoped freeze failing **open** and a service-scoped approval
> failing **closed**. Hand-writing a new descend would make routes 1 and 2 exist in **four** places.
> Exporting the fragment turns today's third hand-typed copy into the second consumer of one definition.

> **Correction, 2026-08-26 — the copy count above was wrong, and wrong in the way this repo keeps
> being wrong.** There were **five**, not three. Two more hand-typed copies of the same three arms
> exist as **single-level** queries — `governance/governance-reach.ts`'s `countContainmentDependents`
> and `graph/objects-repo.ts`'s container-delete guard — so a census run for the downward *walk*
> (`WITH RECURSIVE`, "the descend") returns two hits and concludes there is one definition. That is
> exactly what happened: after 2.5b landed, `graph/containment.ts`'s header asserted "the downward
> direction has exactly one definition too" while two copies sat in the tree.
>
> **And they had already drifted, in both directions at once.** `countContainmentDependents` counted
> `contains` **edges** without joining the child object, so a live edge to a *tombstoned* child
> counted as a dependent and produced a governance Decision claiming it had detached a row that was
> already gone. Both single-level copies compared the placement pair as **raw text**
> (`properties ->> 'componentId' = $id`) with no `UUID_TEXT_PATTERN` guard and no cast, while the
> exported fragment casts to `uuid` — and `uuid` equality is case-insensitive where `text` equality
> is not (measured, PostgreSQL 16). An upper-case-hex `componentId` was therefore a containment
> **parent** going up and **not a child** coming down, which is the precise failure class §8.3 names.
>
> Both are now composed, and the delete guard's refusal widened as a result (a behaviour change to a
> write door, pinned by `governance/containment-dependents-drift.integration.test.ts`). **The lesson
> for the remaining increments: census the PROPERTY — "code that enumerates the rows contained by a
> given row" — not the recursive shape.** A single-level copy of a recursive idea is invisible to
> every search phrased in terms of the walk.

### 8.3 A new invariant nobody has named

**Upward and downward must be exact inverses**, or get-by-id and LIST disagree: an object `authorize()`
admits at its own id would be absent from the list, which reads as a cache bug rather than an authz
bug. This needs its own test — over a random sample, `hasPermission(o)` **iff** `o ∈ readableSet(subject)`.
That test is the drift detector.

Three corollaries that are each a silent-failure class:

- **Truncation fails silently downward.** ADR-0037's probe converts an untrustworthy *upward* deny at
  depth > 10 into a loud `walkDepthExceeded`. Downward there is no such conversion: a component 11
  levels below its binding just does not appear, and the two walks then disagree — one throwing, one
  returning an empty list.
- **A `role_bindings.effect` that is neither `'allow'` nor `'deny'`.** `hasPermission` tests
  `effects.includes('deny')` then `includes('allow')` in JS, so `'ALLOW'` grants nothing. A SQL filter
  written `effect <> 'deny'` would silently **widen** authority relative to the function it mirrors.
  It must be `effect = 'allow'` exactly. **Step 1 added `role_bindings_effect_check`** (drizzle/0097),
  which refuses such a row on INSERT and UPDATE and deletes the ones the upgrade finds — but that is
  the outer layer only. A CHECK constrains writes, not reads: a database restored from a pre-0097
  `pg_dump` carries the pre-0097 schema with its illegal rows intact, and a superuser/table-owner
  path that is not `scp_app` can write one at any time — either way the row reaches the resolver
  unchanged, so the exact-string classification stays load-bearing and stays tested.
  `readable-scope.integration.test.ts` and `inverse-walk-drift.integration.test.ts` build the row the
  only way it can now arise, via `test-support/harness.ts`'s `insertMalformedEffectRoleBinding`,
  which read-backs the row it wrote — without that guard the same fixture no-ops silently and both
  suites go green with no binding in the table at all (measured: 0 failed / 15 passed in
  `inverse-walk-drift`).
- **Deny is a subtraction, not an absence.** Omitting the second descend makes a deny binding inert on
  list doors while still working on get-by-id — a deny that fails **open**.

### 8.4 `change:accept` — per target, and the alternative is actively dangerous

Re-scoping a change door to the change is **inert**: `objects.domain_id` for a change is the org root
for every one of the five internal `proposeChange` callers, `scp change propose` has **no `--domain`
flag at all**, and the only caller in the tree that ever sets a change's `domainId` is one test file.
Re-scoping to `change.id` is equally inert — route 1 walks straight back to that same `domain_id`.

**Check per target**: read `targetObjectIdsOf(change.properties)`, dedupe, `authorize` at each.
**EVERY target for the write doors** (reusing `assertCoordinationTargetsWithinAuthority`'s loop, so the
two cannot drift) — otherwise a ComponentAdmin over one target of a five-target change accepts the
release into the four they have no standing on. **ANY ONE target for the read doors.**

> ⚠️ **Do not copy `assertCoordinationTargetsWithinAuthority`'s guard shape.**
> `campaign-scope-authz.ts:39` opens `if (!Array.isArray(input.targets)) return;` — a silent **pass**.
> That is safe at propose (the schema pins `.min(1)`) but on accept the array is read back off a
> *persisted* row, making the same line a total authorization bypass. Refuse explicitly instead.

**Nearest-common-ancestor + backfill is rejected**, for four measured reasons — chiefly that
`objects.domain_id` is simultaneously the authority chain, the governance-reach chain, domain-locality
inheritance, and the input to the route-1 orphan guard. A backfill re-parenting every change row would
**start refusing deletion of any service that has ever had a change proposed against it**, on every
deployment.

### 8.5 There is no test safety net — this is the biggest risk

All 334 `403` occurrences across `apps/server` tests were enumerated and their doors resolved.
**Zero depend on the org-root pin of any re-scope candidate.** That is worse than a breakage list: all
54 pins are entirely unpinned, so the change would ship with nothing holding it to anything. The only
tests that *do* assert an org-root pin (`federation/outposts-rbac.integration.test.ts:117,150,155`)
cover `federation:read`, which is not being re-scoped.

**Behavioural tests must be written before the re-scope, not after.**

### 8.6 Doors that must NOT be swept

> **Correction, 2026-08-26 — the pure-widening invariant is scoped to the 21 doors that were
> RE-SCOPED, and never governed the two that were TIGHTENED.**
>
> The federation overlay pair (`POST /federation/overlays`, `GET /federation/overlays/{idOrUrn}`) is
> not a re-scope: the org-root bar was **kept** and a base-scoped bar **added** beside it — the same
> "added, never substituted" shape as the hand-fill and publish fixes in PR #286. Adding a bar is a
> deliberate **narrowing**, so by construction it refuses some principals the single bar admitted.
> Judging it against a widening invariant was a category error on my part, and it nearly cost a real
> security property: the "obvious fix" (give the second bar an org-root arm) makes that bar satisfied
> by everyone who already cleared the first — inert — which measurably deletes the deny-at-base
> refusal two mutation-proven cases pin.
>
> **Accepted consequence, now pinned by a test rather than discovered later:** an overlay whose base
> object has tombstoned containment ancestors cannot be created or read by anyone, org-root Owner
> included, until the base's chain is repaired. Fixing that properly needs an authz primitive that
> distinguishes "explicitly denied" from "nothing reached" — a separate decision, not a comment.
>
> Same section, same date: `GET /decisions/:id`'s wide arm ships as `audit:read` at the org root, not
> the `object:read` it replaced. That is a narrowing with **no possible holder today** — a roles-table
> test asserts every built-in role carrying `object:read` also carries `audit:read`, so it goes red
> the day a migration or a custom-role API creates a victim.

A mechanical rewrite of every `object:write` + `auth.orgId` pair is wrong. Explicitly excluded:

| Door | Why |
|---|---|
| `PUT`/`DELETE /secrets/:key`, `PUT /change-sources/:kind/webhook-secret` | §1.3d wants these **split into `secret:write`**, not widened. A sweep hands every future ComponentAdmin the org's execution-system credentials. |
| `POST /discovery/run`, `/accept`, `/backfill-source-mappings` | Discovery makes SCP dial an execution system with stored credentials. |
| `POST /change-sources/:kind/webhook`, `/report` | CI ingress is org-root **deliberately** — the principal is a robot with no per-object standing, and an existing test rests its whole argument on that. |
| `policy-scope-authz.ts:111`, `governance-labels.ts:163`, `handfill-repo.ts:208,322`, `overlay-repo.ts:197` | Four **deliberate** org-root escalation bars, two of them added by this very branch. |
| `POST /plans` | Re-scoping downward **widens**: the manifest is caller-supplied and the persisted `diff` reports each named object's current state. |
| `GET /freezes` | Needs the **upward** closure, not a downward filter — a freeze blocking a ComponentAdmin is declared *above* them. A downward filter returns only the freezes that are **not** blocking them: the page reads green while the release is held. |
| `GET /decisions/:id` | Re-scoping to `decision.subjectId` hands the accountability record to the party being held accountable. Ship as a **disjunction**: `audit:read` at the org root **OR** `object:read` at the subject. |

Also flagged, out of scope here: **`/graph/traverse` and `/graph/subgraph` are an enumeration
bypass** — they authorize `graph:query` at one `objectId` and then return many objects with no row
filtering.

### 8.6a The same property, 138 times, pre-existing — tracked, not swept

**Owner ruling 2026-08-26: track it, fix opportunistically.** A filterless census
(`grep -rna 'scopeObjectId'` over `apps/server/src`, 300 assignment sites) found **138 non-test checks
scoped at something other than the org id**, all carrying the tombstoned-ancestor property
([[scp-rescoping-tombstoned-ancestor]]) **independently of 2.5a**. Confirmed by `git blame` as
pre-existing: `PUT /controls/{idOrUrn}/binding` at `control.id` (2026-07-10), the freeze write doors
at `freeze.scopeObjectId`, five target-scoped executor doors,
`assertCoordinationTargetsWithinAuthority` at propose time, `triggerCampaignRollback`'s per-member
check.

This is **existing behaviour, not a regression** — nobody has hit it — which is why it does not block
the role programme. `authz/org-root-arm.ts`'s `checkAtOrgRootOrScopes` is the instrument that fixes
any of them; apply it when a site is touched for another reason.

> ⚠️ **Two sites compound the trap and are worth fixing first if anyone is in that file:** the
> campaign deadline pair scopes at `request.params.id` — a **raw, unresolved path param** — so it
> carries the 404-becomes-403 trap (§8.7) *as well as* the tombstone one. `scopeExpandCte` seeds the
> CTE with the raw uuid and never checks existence, so a nonexistent id expands to a one-row set
> matching no binding.

### 8.7 Sequencing

**Split step 2.5 at the LIST boundary.**

- **2.5a** — the get-by-id re-scopes. A mechanical parameter change against an in-tree pattern
  (`components.ts:310-311`, `typed-registries.ts:311-315`), no new query, no new traversal. Most fixes
  need a *reorder* only, and cost nothing because the object is loaded on the very next line.
  ⚠️ Scoping at a path param **without resolving the object first turns 404 into 403** —
  `scopeExpandCte` seeds the CTE with the raw uuid and never checks existence.
- **2.5b** — the LIST filtering. Needs the exported children fragment, the readable-scope module, the
  deny subtraction, the inverse-walk test, and a downward truncation story. Its own increment.
