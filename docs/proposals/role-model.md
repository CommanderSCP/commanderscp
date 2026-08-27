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
**Not started:** steps 3–10 — the roles themselves. Per **D5** the role seed (step 3) and the
role-binding write door (step 5) are **one shippable unit**, since deprecating `Administrator` before
any purpose-role binding exists would 403 the obvious migration target from day one.
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
`federation:write`

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

### 4.4 Notable non-blockers

- The no-escalation subset rule is **bypassable via `member_of`** — the design never mentions group
  membership — and is **unsound for `effect='deny'` rows**.
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
| 4 | **Permission drift test in CI** — exported `PERMISSIONS` array vs seeded role arrays vs a filterless call-site census, failing in **both** directions. | No such array exists today |
| 5 | **Role + role-binding API** — `GET /roles`, `GET/POST/DELETE /role-bindings`, gated on `role_binding:write` at-or-above the binding's scope, **plus** the no-escalation subset rule, **plus** `bindable_at` validation, **plus** an audit event per grant/revoke. | Voids the three in-tree safety arguments (§1.2) |
| 6 | **Effective-permissions read surface** — roles+permissions on `GET /auth/me`, plus `GET /authz/effective?scopeObjectId=`. Plus `fromRole` authoring-time validation. | With five purpose roles the UI is unusable without it |
| 7 | **SSE per-event `object:read` at fan-out** (§1.3a) | Must land before any scoped binding exists in the field |
| 8 | The two inversions | **Blocked on owner decision #1** |
| 9 | *Separate milestone* — instance-tier credential redesign. Plus fixing `governance-move.ts:371` and `dependency-subscriptions.ts:287`, which still `createPool` inline instead of `withOperatorDb`. | Archetype A stays half-delegable until this lands |
| 10 | *Later* — custom roles, gated behind closing the `hasRoleAtScope` name-collision quorum bypass. | Charter commitment, unsatisfied by this design |

**Do not ship custom roles in the same increment as the binding door.** `hasRoleAtScope` joins `roles`
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
