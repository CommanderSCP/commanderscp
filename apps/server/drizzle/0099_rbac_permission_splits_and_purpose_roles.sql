-- ===========================================================================================
-- 0099 — the three permission splits, the deletion of `org:admin`, and the five purpose-shaped
--         roles. (docs/proposals/role-model.md §1.3d/§1.3e/§3/§4.3, build order §5 step 3.)
--
-- MIGRATION NUMBERING — RE-VERIFY AT MERGE TIME, AND THIS FILE IS THE PROOF THAT MATTERS. Authored
-- as `0098`; renumbered to `0099` because main merged `0098_pipeline_hook_runs` while this was being
-- built. That is the SECOND collision in this programme — `0096` was taken out from under the
-- previous increment the same way, with the same `idx` AND the same `when`. As of 2026-08-27
-- `git ls-tree origin/main apps/server/drizzle/` ends at `0098_pipeline_hook_runs`, and `0097` on
-- main is this branch's own parent (PR #300).
--
-- Numbering in this repo is strictly serial in MERGE order, not authoring order, and
-- `db/journal-ordering.test.ts` gates journal contiguity (`idx` contiguous, `when` strictly
-- increasing, one entry per `.sql` and no orphan of either kind). If anything lands on main before
-- this does, renumber this file, its `meta/_journal.json` entry and this header TOGETHER — the two
-- collisions above were both caught by re-running the census at merge time rather than trusting the
-- number the brief was written with.
--
-- WHAT THIS CHANGES ABOUT WHO CAN DO WHAT — the honest summary, because most of this migration is
-- deliberately inert and exactly two lines are not:
--
--   * `secret:write` SUBSTITUTES `object:write` at three doors, so an org-root `object:write`
--     holder who is not on the built-in ladder loses credential custody. BREAKING.
--   * `change:accept` is ADDED to the accept/rollback doors and is deliberately NOT granted to
--     Operator or Approver, so principals on those two rungs stop being able to accept or roll
--     back a change. BREAKING, AND THE ONE INTENTIONAL BREAKAGE IN THE DESIGN. §2c argues it.
--   * `scan:override` is ADDED to the scan-override decide door and granted to exactly the roles
--     that already hold the `policy:write` that door demands, so no live waiver decision starts
--     failing. A no-op today; what it buys is that it can be WITHHELD separately tomorrow.
--   * `org:admin` is removed from Owner. It gated nothing, ever. §1.
--   * Five new built-in roles are seeded. A role nobody is bound to changes nothing until the
--     role-binding write door (§5 step 5) ships, which per owner ruling D5 is the SAME PR.
--
-- THE ROLES SEEDED HERE ARE NOT YET BINDABLE THROUGH ANY API, AND `bindable_at` ENFORCES NOTHING.
-- `roles.bindable_at` (drizzle/0097 §5) is advisory metadata until the write door validates it.
-- Seeding the arrays now is what lets that door be written against data rather than against a
-- doc, and what lets a test assert the intended scopes before any binding exists in the field.
--
-- WHY `Administrator` IS NOT TOUCHED HERE. Owner ruling D5 deprecates it ON ARRIVAL, but that is a
-- REFUSAL AT THE ROLE-BINDING WRITE DOOR, not a data change: the row stays (`role_bindings.role_id`
-- is an FK and `scp_app` holds no DELETE on `roles`), every existing binding keeps resolving, and
-- the role must remain grantable until there is a door that can refuse it and name a purpose role
-- to use instead. A migration cannot express "no NEW bindings"; it can only remove authority from
-- principals who already have it, which is the opposite of what D5 asks for.
-- ===========================================================================================

-- ===========================================================================================
-- 1. DELETE `org:admin` — the one deliberate subtraction in an otherwise additive design.
--
--    IT GATED NOTHING. Seeded to Owner alone by 0002 §7, demanded at ZERO call sites for its
--    entire life. A filterless census (`grep -rna`, no path filter, no include filter, the whole
--    tree including the NUL-carrying files CLAUDE.md warns every search tool silently drops)
--    re-run against this branch on 2026-08-27 finds it in six places, and not one of them is an
--    `authorize()`/`hasPermission()` call:
--      * `authz/resolve.ts` — the `Permission` union member (removed with this migration);
--      * `drizzle/0002_rls_rbac_seed.sql:223` — the seed literal, LEFT ALONE (see below);
--      * `authz/resolve.integration.test.ts` — a negative assertion that an unheld permission
--        fails closed (re-pointed at `secret:write`, which is a real permission a Viewer does not
--        hold, so the case keeps testing default-deny rather than testing a typo);
--      * `db/rbac-ddl-preconditions.integration.test.ts` — 0002's Owner literal, reproduced as a
--        fixture (left alone, for the same reason 0002 is);
--      * `docs/proposals/role-model.md` — the proposal, in three places.
--
--    WHY REMOVE IT RATHER THAN LEAVE IT LYING THERE. role-model.md §5 step 5 — the SAME PR, per
--    ruling D5 — ships `GET /roles`, which publishes these strings to the UI and the SDK. A
--    permission that advertises authority in a roles listing and gates nothing is worse than no
--    permission: it invites an operator to believe a grant means something, and it invites the
--    next author to "wire up the missing check" for a capability nobody ever specified.
--
--    WHY SUBTRACTION IS NORMALLY UNSAFE HERE, AND WHY IT IS SAFE FOR EXACTLY THIS ONE. Built-in
--    roles are SHARED SINGLETON rows (`org_id IS NULL`) read by every org on the deployment
--    through the `roles` RLS `USING (org_id = current_org OR org_id IS NULL)` clause and
--    unwritable by any org through its `WITH CHECK` (0002 §7). Removing a permission therefore
--    narrows EVERY ORG ON EVERY DEPLOYMENT SIMULTANEOUSLY, with no per-org opt-out and no
--    custom-role API to restore it — which is why all five prior grant migrations
--    (0010/0012/0083/0088/0094) are `array_append` and why role-model.md §2 concludes subtraction
--    has no safe shape here. It is safe for `org:admin` because the narrowing is provably empty:
--    no call site asks for it, so no request's outcome can change.
--
--    `array_remove`, not a rewritten literal, for the same reason the grants use `array_append`:
--    it touches only the element named and preserves everything nine later migrations appended.
--    It is idempotent by construction (removing an absent element is a no-op), so a re-run — a
--    restored dump re-migrated, a renumber, a hand-applied file — is safe.
--
--    `WHERE org_id IS NULL AND name = 'Owner'`: built-ins only, and only the one row that ever
--    carried it. An org's own custom role that happens to list the string is its own business.
--
--    0002's SEED LITERAL IS DELIBERATELY LEFT AS IT IS. A shipped migration is a historical
--    record of what the database was asked to do at that version, and editing one makes the file
--    on disk disagree with the hash recorded in `__drizzle_migrations` on every deployment that
--    has already run it. A fresh database runs 0002 and then this file in the same pending set, so
--    it never observes the permission; an existing database converges here. The cost is that the
--    string survives in two frozen literals (0002 and the fixture that reproduces it), which is
--    exactly what a historical record should look like.
-- ===========================================================================================

UPDATE roles SET permissions = array_remove(permissions, 'org:admin')
WHERE org_id IS NULL AND name = 'Owner';

-- ===========================================================================================
-- 2. Grant the three new permissions to the LEGACY LADDER.
--
--    THE IDIOM IS 0088's, VERBATIM (itself 0010 §4's, 0012 §6's, 0083 §3's and 0094's), and every
--    clause is load-bearing:
--      * `array_append` is ADDITIVE — existing role rows keep every permission they already had.
--        `roles.permissions` is a plain `text[]` with no CHECK or enum backing it (0002 §7), so a
--        new member costs no type change and no other DDL.
--      * `org_id IS NULL` selects the BUILT-IN roles only; an org's own custom roles are its
--        business and are untouched (a custom role that deliberately withholds one of these is
--        the whole point of the design).
--      * `NOT ('X' = ANY(permissions))` makes a re-run a no-op rather than appending a duplicate —
--        drizzle gates on the journal's `when`, never on idempotency, so a migration run twice by
--        any means must be safe.
--      * roles are targeted BY NAME because 0002 seeds their ids with `gen_random_uuid()`; there
--        are no fixed constants to reference.
--
--    ONLY `Administrator` AND `Owner` APPEAR BELOW. The five purpose roles seeded in §3 carry
--    these permissions in their own literals, so listing them here would be a no-op that invites
--    the two definitions to drift. If a name in §3 ever needs a LATER permission, it gets its own
--    `array_append` in its own migration — the same rule the ladder has always followed.
-- ===========================================================================================

-- --- 2a. `secret:write` — credential custody (role-model.md §1.3d). --------------------------
--
-- SUBSTITUTES `object:write` at `PUT`/`DELETE /api/v1/secrets/{key}` and
-- `PUT /api/v1/change-sources/{sourceKind}/webhook-secret`. Three unrelated blast radii shared one
-- grant: writing the tokens SCP uses to reach GitHub/ArgoCD/Terraform; DELETING them, which is an
-- availability kill switch for all coordination on the deployment; and rotating the HMAC secret
-- that authenticates inbound webhooks, where whoever sets the secret can thereafter forge signed
-- source events into the estate.
--
-- BREAKING. This is the one SUBSTITUTION of the three splits, so it takes a capability away rather
-- than adding a second bar. Administrator and Owner are the ladder rungs that keep it; the new
-- OrgAdmin gets it in §3. Every OTHER holder of org-root `object:write` — Operator, Approver, and
-- any custom role — is 403 at those three doors from this migration onward. ANNOUNCE IT.
--
-- WITHHELD FROM SecurityOfficer (§3A) ON PURPOSE: holding the org's outbound credentials is an
-- operations act, not a compliance one.
UPDATE roles SET permissions = array_append(permissions, 'secret:write')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner')
  AND NOT ('secret:write' = ANY(permissions));

-- --- 2b. `scan:override` — deciding a scan-override waiver (role-model.md §1.3e, ruling D3). ---
--
-- ADDED TO, never substituted for, the `policy:write` the scan-override DECIDE door already
-- demands at the derived tier object. Authoring a scan ceiling and waiving it were otherwise the
-- same permission string at the same scope — a separation-of-duty violation the route file itself
-- concedes, since its raiser≠approver check closes the one-actor shape and nothing else.
--
-- A BEHAVIOURAL NO-OP ON EVERY DEPLOYMENT THAT EXISTS TODAY, and that is why Administrator is on
-- this list: 0010 §4 grants `policy:write` to `('Administrator', 'Owner')` and to no other
-- built-in role, so the set of principals who can sign a waiver is IDENTICAL before and after.
-- No in-flight waiver decision starts 403ing on upgrade.
--
-- WHAT IT BUYS IS THAT IT IS SEPARATELY WITHHOLDABLE. The new OrgAdmin (§3C) holds `policy:write`
-- and NOT this, so an org can seat an estate administrator who authors org policy and a security
-- officer who owns the waiver, and neither is the other. That is impossible while one string
-- carries both acts, because the cumulative ladder welds a permission's blast radius to its rank.
-- Ruling D3 also settles that there is no sixth `ScanWaiverApprover` role: SecurityOfficer (§3A)
-- holds both `policy:write` and `scan:override`.
UPDATE roles SET permissions = array_append(permissions, 'scan:override')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner')
  AND NOT ('scan:override' = ANY(permissions));

-- --- 2c. `change:accept` — accepting or rolling back a release (§1.3f/§4.3/§8.4). --------------
--
-- ADDED TO, never substituted for, the `object:write` that `POST /api/v1/changes/{id}/accept` and
-- `POST /api/v1/changes/{id}/rollback` demand at EVERY target of the change. Same per-target loop,
-- same every-target quantifier, same org-root arm evaluated first.
--
-- ============================ THE ONE INTENTIONALLY BREAKING GRANT ============================
-- `Operator` AND `Approver` ARE DELIBERATELY ABSENT FROM THE LIST BELOW. Both hold `object:write`
-- (0002 §7) and can therefore accept and roll back changes on every deployment today; from this
-- migration onward they cannot. That is the intent, not an oversight: accepting a release into
-- production is not the same authority as editing the graph, and it was only ever the same
-- permission string because the cumulative ladder had no way to say otherwise (role-model.md §0).
--
-- The migration path for a principal who genuinely needs it is a purpose role from §3 —
-- ComponentAdmin at the component or assembly, ServiceAdmin at the service or domain, OrgAdmin at
-- the org root — each of which carries `change:accept` and each of which is bindable at a scope
-- the cumulative ladder could not express. Until the role-binding write door ships in this same PR
-- (ruling D5), the only remedy is a ladder rung that holds it.
--
-- CANCEL IS NOT AFFECTED and must never be: `POST /changes/{id}/cancel` keeps `object:write` at
-- every target alone. Cancelling STOPS a release rather than authorizing one, and folding it in
-- would make a cancel-only incident-responder role inexpressible — so an Operator who can no
-- longer accept can still stop a bad release, which is the capability an on-call rota needs most.
-- =============================================================================================
UPDATE roles SET permissions = array_append(permissions, 'change:accept')
WHERE org_id IS NULL AND name IN ('Administrator', 'Owner')
  AND NOT ('change:accept' = ANY(permissions));

-- ===========================================================================================
-- 3. Seed the five purpose-shaped roles (role-model.md §3), ALONGSIDE the ladder.
--
--    ALONGSIDE, NOT REPLACING. Viewer/Operator/Approver/Administrator/Owner stay byte-identical
--    apart from §1 and §2 above. A rename is blocked by three couplings and a re-cut is blocked by
--    the shared-singleton storage fact, both argued in role-model.md §2; the charter authorises
--    exactly this, calling the five "Example built-in roles" and committing that organizations
--    should be able to define additional ones.
--
--    `INSERT ... SELECT ... WHERE NOT EXISTS`, NOT `ON CONFLICT` — deliberately, and the
--    distinction is not stylistic. 0002 §7's seed ends `ON CONFLICT DO NOTHING` with
--    `gen_random_uuid()` ids and, until drizzle/0097, THERE WAS NO ARBITER INDEX FOR IT TO
--    CONFLICT AGAINST: `roles` had a PRIMARY KEY on `id` and nothing else, so that clause could
--    never fire and a re-executed seed silently forked 'Owner' into two rows. 0097's partial
--    unique index `roles(name) WHERE org_id IS NULL` finally makes `ON CONFLICT (name) WHERE
--    org_id IS NULL DO NOTHING` possible here — and `NOT EXISTS` is still preferred, because it
--    states the intent in the query itself instead of delegating it to an index whose existence
--    and whose exact partial predicate the reader has to go and verify. A guard that reads as
--    correct while doing nothing is the precise failure 0097 §1 exists to clean up after; this
--    form cannot have it.
--
--    Each role's `bindable_at` is the array `roles.bindable_at` (0097 §5) was added to hold. NOT
--    ENFORCED ANYWHERE YET — validation lands at the role-binding write door — so it is advisory
--    metadata that a test can assert and that door can be written against.
-- ===========================================================================================

-- --- 3A. SecurityOfficer ----------------------------------------------------------------------
--
-- Authors and enforces security/compliance rules — scan ceilings, exclusion clauses, controls,
-- control bindings — decides scan-override waivers, and can declare a stop-work freeze, WITHOUT
-- HOLDING ANY AUTHORITY TO CHANGE THE ESTATE.
--
-- HOLDS NO `object:write`. That is the entire point, and it is the role the cumulative ladder
-- cannot express: today the only way to give someone `scan:override`-shaped authority is to make
-- them Administrator, which also hands them `object:write`, `type_registry:write` and
-- `role_binding:write`.
--
-- NO `secret:write` either (§2a): custody of the org's outbound execution-system credentials is an
-- operations act, not a compliance one.
--
-- `bindable_at` IS `organization` ONLY, AND THIS IS MECHANICAL RATHER THAN CONVENTIONAL.
-- `OVERRIDE_APPROVAL_TIER_FLOOR = 'org'` (`governance/scan-requirements.ts`) and `tierForObjectType`
-- maps no graph object above org — so a SecurityOfficer bound BELOW the org root would mint waivers
-- that are approved, audited, and INERT. The design originally allowed `domain`; verification cut
-- it (role-model.md §3A, §4).
INSERT INTO roles (id, org_id, name, permissions, bindable_at)
SELECT gen_random_uuid(), NULL, 'SecurityOfficer',
       ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read',
             'policy:write','scan:override','freeze:write','federation:read'],
       ARRAY['organization']
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE org_id IS NULL AND name = 'SecurityOfficer');

-- --- 3B. FederationAdmin ----------------------------------------------------------------------
--
-- Operates this org's federation link — identity, journal, outpost topology, imports and exports.
-- DOES NOT ESTABLISH NEW TRUST RELATIONSHIPS.
--
-- HOLDS `federation:write` BUT NOT `federation:pair` (owner ruling D4, drizzle/0094), and NOT
-- `object:write`. Those two facts are one fact. `federation:write` alone WAS a graph-write
-- permission by a chain adversarial verification found: `POST /federation/peers` took the peer's
-- Ed25519 `publicKey` verbatim from the request body, and `POST /federation/imports` — same single
-- permission — handed every entry of a bundle signed with that key to `applyEntry`, whose
-- `object_upsert` branch resolves ANY registered `typeId`. Pair a peer with a keypair you
-- generated, import a bundle you signed with it, and you hold estate write authority having never
-- held `object:write`. 0094 gates PAIRING behind `federation:pair`, which this role does not have;
-- the import path stays ungated by design, because a throw there wedges a legitimately paired
-- peer's whole signed bundle. Withholding `federation:pair` here is what makes this role's stated
-- invariant TRUE rather than aspirational.
--
-- `bindable_at` IS `organization` ONLY, AND THIS TOO IS MECHANICAL: all 14 federation doors in
-- `routes/federation.ts` pass `scopeObjectId: auth.orgId`, so a narrower binding would hold every
-- permission this role grants and fail the SCOPE check on every single door — a trap, not a
-- narrower grant.
INSERT INTO roles (id, org_id, name, permissions, bindable_at)
SELECT gen_random_uuid(), NULL, 'FederationAdmin',
       ARRAY['object:read','relationship:read','type_registry:read','graph:query','audit:read',
             'federation:read','federation:write'],
       ARRAY['organization']
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE org_id IS NULL AND name = 'FederationAdmin');

-- --- 3C. OrgAdmin -----------------------------------------------------------------------------
--
-- Full administrative authority inside ONE organization — the rung the permission census showed is
-- missing between Administrator (a grab-bag) and the scoped purpose roles.
--
-- DELIBERATELY WITHOUT THE FOUR BYPASSES: no `freeze:override`, no `change:emergency`, no
-- `campaign:deadline-override`, no `scan:override`. It RUNS the org; it cannot excuse the org from
-- the controls the platform is enforcing.
--
-- WITHHOLDING `scan:override` IS THE REAL SEPARATION OF DUTY IN THIS DESIGN (ruling D3): an org can
-- seat an estate administrator who authors org policy (`policy:write`, which this role has) and a
-- security officer who owns the waiver (`scan:override`, which it does not), and NEITHER IS THE
-- OTHER. Administrator cannot express that, because it holds `policy:write` and — from §2b —
-- `scan:override` too.
--
-- `federation:pair` IS PRESENT. The proposal disagreed with itself: §4.1 and §7.1 D4 both say the
-- permission is "granted to Administrator, Owner and OrgAdmin", while §3C's explicit list — the one
-- this literal is copied from — omitted it. A first draft of this migration withheld it fail-closed
-- and escalated. RULED 2026-08-27: OrgAdmin HOLDS it, and §3C was corrected to match.
--
-- WHY THAT WAY ROUND. D4 is the later and more specific ruling, and it is the one that reasoned
-- about this permission rather than merely listing a role. Its point was never that pairing is rare
-- — it is that ESTABLISHING a trust relationship is a different act from OPERATING one, so the role
-- that operates the link (FederationAdmin, §3B) must not also decide whose signature this instance
-- believes. OrgAdmin is the organization's full administrator; deciding the org's federation trust
-- anchors is squarely that job, and withholding it would leave an org whose only federation-pairing
-- principals are Owner and the deprecated Administrator (D5) — i.e. it would make the org
-- unadministrable in exactly the dimension OrgAdmin exists to cover.
--
-- FederationAdmin remains the deliberate withholding, and it is the ONLY one: §3B holds
-- `federation:write` and NOT `federation:pair`, which is the whole content of D4.
INSERT INTO roles (id, org_id, name, permissions, bindable_at)
SELECT gen_random_uuid(), NULL, 'OrgAdmin',
       ARRAY['object:read','object:write','relationship:read','relationship:write',
             'type_registry:read','type_registry:write','graph:query','audit:read',
             'approval:write','policy:write','freeze:write','secret:write','change:accept',
             'governance:move','role_binding:write','federation:read','federation:write',
             'federation:pair'],
       ARRAY['organization']
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE org_id IS NULL AND name = 'OrgAdmin');

-- --- 3D. ServiceAdmin -------------------------------------------------------------------------
--
-- Full authority over one service and every assembly, component and placement beneath it,
-- including the governance policy that applies to that subtree.
--
-- `bindable_at` IS `service`, `domain`. BOUND AT A DOMAIN IT IS THE SAME PURPOSE AT WIDER REACH —
-- route 1 of `scopeExpandCte` walks `objects.domain_id` and handles nested domains — WHICH IS WHY
-- NO SEPARATE `DomainAdmin` IS SEEDED. One role, two scopes, rather than two roles that would have
-- to be kept in step by hand forever.
--
-- Holds `policy:write` and `governance:move`, which ComponentAdmin (§3E) does not: a service
-- administrator authors the governance that binds their subtree and may re-parent within it.
INSERT INTO roles (id, org_id, name, permissions, bindable_at)
SELECT gen_random_uuid(), NULL, 'ServiceAdmin',
       ARRAY['object:read','object:write','relationship:read','relationship:write',
             'type_registry:read','graph:query','audit:read','approval:write','policy:write',
             'freeze:write','change:accept','governance:move'],
       ARRAY['service','domain']
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE org_id IS NULL AND name = 'ServiceAdmin');

-- --- 3E. ComponentAdmin -----------------------------------------------------------------------
--
-- The one shared role the owner asked for: full authority over one unit of software and everything
-- it is deployed as.
--
-- "ASSEMBLY & COMPONENT SHARE A ROLE" COSTS NOTHING STRUCTURALLY, and this is a measured property
-- of the resolver rather than a design aspiration. `scopeExpandCte`'s route 2 joins the `contains`
-- edge with NO predicate on either endpoint's type, and migration 0055 set that edge's
-- `from_types = ['service','assembly']` and `to_types = ['assembly','component']` — so
-- `service -> assembly -> component` chains for free at depths 1 and 2. A binding at an assembly
-- reaches that assembly's components with no resolver change at all. (That two-hop was UNTESTED at
-- the authz layer until step 2's mutation-proven test on this branch's parent commit, which proves
-- it by deleting route 2's `contains` join and watching the assertion fail.)
--
-- NO `policy:write` AND NO `governance:move`: a component administrator OPERATES their component,
-- they do not author the governance that binds it, and they do not move it out from under the
-- governance reach it sits in.
--
-- `bindable_at` IS `assembly`, `component` — `placement` and `deployment-target` are DELIBERATELY
-- OFF in this increment. A deployment-target binding reaches the PLACEMENTS at that target and NOT
-- the components placed there (route 4 of the scope walk goes placement -> deployment-target, not
-- deployment-target -> component), so it would be a half-expressible "operator of prod" that reads
-- as a bug the first time someone tries to use it.
--
-- ⚠️ RECORDED CONSEQUENCE, from owner ruling D2's re-examination: this role makes "the principal
-- who benefits from a scan exclusion" a NAMED, BINDABLE role for the first time. D2 (do not split
-- `security:declare` out of `object:write`) still stands, but if the estate later runs scan
-- exclusions under delegated component admins, that is the decision to revisit — and the split
-- gets more expensive once ComponentAdmin bindings exist in the field.
INSERT INTO roles (id, org_id, name, permissions, bindable_at)
SELECT gen_random_uuid(), NULL, 'ComponentAdmin',
       ARRAY['object:read','object:write','relationship:read','relationship:write',
             'type_registry:read','graph:query','audit:read','approval:write','freeze:write',
             'change:accept'],
       ARRAY['assembly','component']
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE org_id IS NULL AND name = 'ComponentAdmin');
