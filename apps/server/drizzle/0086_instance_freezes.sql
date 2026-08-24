-- ===========================================================================================
-- M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER
--         (docs/proposals/campaigns-rework.md §2, owner decision D1, 2026-08-23)
--
-- Freezes today resolve over the ORG-ROOTED containment chain: org -> containment domain ->
-- service -> component -> deployment-target (`graph/containment.ts`, routes 1-4). The owner
-- extended freeze scoping ABOVE org: an instance-scoped tier with no `org_id`, operator-write /
-- tenant-read, binding EVERY organization hosted on this deployment.
--
-- THIS KNOWINGLY OVERTURNS DESIGN.md §10.3, which said freeze scoping is "org-rooted; the
-- above-org tiers ADR-0016 adds are scan-requirement-only and do not extend freeze scoping".
-- That sentence is now false by owner decision. DESIGN.md §10.3 STILL SAYS IT AT THE TIME THIS
-- MIGRATION SHIPPED, and that is stated rather than glossed: the proposal's "Documents to change"
-- carries a drafted replacement, but the draft counts SEVEN tiers including `trust_domain` and
-- this table deliberately has no such rung (see below), so applying it verbatim would trade one
-- false clause for another. ADR-0040 §7c and its closing section carry the correction as an owner
-- call, together with the charter "Freeze Scope" amendment, which needs owner sign-off and which
-- this change does not have. Called out here because the next person to read §10.3 will read it
-- as an invariant, and on this branch it is not one.
--
-- `containmentChain` is org-rooted and org-FILTERED on every join, so it structurally cannot
-- reach above org. The above-org tier therefore gets its own table — exactly the shape ADR-0016
-- §3 already chose for `scan_requirement_floors` (0029), `scanner_assignments` (0035),
-- `scan_db_staleness_policy` (0036), `scan_exclusion_admissions` (0074) and
-- `governance_move_instance_rung` (0083 §2).
--
-- ===========================================================================================
-- NO `org_id` — the documented exception to DESIGN §4.2
-- ===========================================================================================
-- An operator statement about the DEPLOYMENT, not tenant data (ADR-0033 §7a's words). Per-org
-- rows would encode a fact already true of every org on the instance and would invite a
-- tenant-writable surface. Tenant READ is required by charter principle 6: a change blocked by a
-- freeze must be able to say WHICH freeze, and a tenant that cannot read the row cannot be told
-- why it is blocked. `USING (true)` leaks nothing because the table holds no per-tenant row.
--
-- ===========================================================================================
-- ADDRESSING: A STAGE COORDINATE, NEVER A `scope_object_id`
-- ===========================================================================================
-- An org freeze names an OBJECT (`freezes.scope_object_id`) and the containment walk decides what
-- it covers. A platform freeze cannot: object ids are per-org rows, `containmentChain` is
-- org-filtered, and there is no object every tenant shares — a single id would name at most one
-- tenant's object. So it addresses by the coordinate SCP already defines and already reads, the
-- M15.6 / ADR-0017 §3 convention: `properties.environment` (+ optional `properties.region`) on a
-- LIVE `deployment-target` object. `coordination/regional-executors.ts` owns that reading
-- (`readStageCoordinate`, which is also what `readDeclaredRegionMembership` now composes over, so
-- there is exactly ONE place that knows the convention) INCLUDING the placement ->
-- deployment-target hop: a stage-shaped wave target is a PLACEMENT, which carries no
-- environment/region of its own, and without the hop a stage-shaped wave would silently not
-- match.
--
--   `match_environment = 'prod'`, `match_region = NULL`  -> every region of prod
--   `match_environment = 'prod'`, `match_region = 'amer'` -> that one stage
--
-- AN UNSET ENVIRONMENT IS NOT "EVERYTHING", AND THAT IS A DELIBERATE DEPARTURE FROM THE PROPOSAL,
-- WHICH SAID `match_environment IS NULL` = deployment-wide. Reasons, in order of weight:
--
--   1. A deployment-wide freeze is the widest governance act this table can express — it stops
--      every release for every tenant on the instance. Reaching it by OMITTING a field means a
--      client that drops empty strings, a typo'd JSON key, or a `PUT` built from a partially
--      filled form authors the maximum blast radius with no error anywhere. "A loosening never
--      defaults on" is a rule this repo already keeps (0083 §3, `freezes.atomic`, `overridable`
--      below); the widest TIGHTENING deserves the same treatment for the same reason — an
--      operator who means the whole instance should have to say so.
--   2. It makes the CHECK constraint able to state the rule. With NULL overloaded as "all", a row
--      with no environment is indistinguishable from a row whose environment was lost.
--
-- `match_all_environments = true` is therefore the explicit deployment-wide form, and it is the
-- ONLY form that also covers a target with no stage coordinate at all (a legacy component-shaped
-- wave target, or a placement whose deployment-target declares no `environment`). That asymmetry
-- is real and is documented at the matcher: an environment-addressed freeze can only reach
-- targets that DECLARE where they run.
--
-- ===========================================================================================
-- WHAT THIS TABLE DELIBERATELY DOES NOT CARRY
-- ===========================================================================================
-- * NO `origin` COLUMN. 0029/0035/0036/0074 all carry `origin IN ('local','federated')` for a
--   federated writer that ADR-0016 designed and never built. A platform freeze structurally
--   CANNOT federate: `SyncJournalEntrySchema.orgId` is a required uuid, `appendJournalEntry`
--   takes `input.orgId`, the hash chain is keyed `(orgId, originDomainId)` under an advisory lock
--   on that pair, and `exportSyncBundle` runs inside `withTenantTx(db, orgId, ...)`. Every layer
--   is org-scoped and a platform freeze has no org and no non-arbitrary way to acquire one. It is
--   per-instance operator config, distributed by the same deployment tooling that distributes
--   `SCP_OPERATOR_TOKEN`. A column with no writer and no possible writer is a field that lies;
--   the honest shape is its absence. (Org-tier freeze federation is D6 / M25.7 and is a different
--   question with a different answer — a graph object on the existing `object_upsert`, never a
--   new `JournalEntryKind`, which would fail-close a whole bundle at the import route's Zod
--   boundary.)
-- * NO `tier` COLUMN. 0029 carries `tier IN ('platform','trust_domain')` because ADR-0016's two
--   above-org rungs contribute SEPARATE per-severity MINs. A freeze is a predicate, its merge is
--   an OR (below), and a `trust_domain` freeze would behave identically to a `platform` one in
--   every code path — the literal would be a stored label that changes nothing. Same argument as
--   `origin`. THIS TABLE IS THE PLATFORM TIER; the tier is the table.
--
-- ===========================================================================================
-- MERGING IS UNION (OR), NOT MIN
-- ===========================================================================================
-- ADR-0016's floors merge by per-severity MIN because a threshold is a NUMBER. A freeze is a
-- PREDICATE, and the analogue of most-restrictive-wins for a predicate is disjunction:
--
--   frozen(target,t) = (SOME instance freeze covers target at t) OR (SOME org freeze's scope is
--                       on target's containment chain and its window covers t)
--
-- Three consequences a reader will guess wrong: (i) when the org has declared nothing at all, a
-- platform freeze still blocks — the empty org set contributes FALSE to an OR; (ii) NOTHING an
-- org can author SUBTRACTS from the union, so the "floor" property does not live in the merge at
-- all, it lives entirely in the override rule (`overridable` below); (iii) this table ships
-- EMPTY, and empty is byte-identical to today for every existing deployment and test.
--
-- ===========================================================================================
-- THE TWO BARRIERS (DESIGN §4.2: cross-tenant leakage requires two independent failures)
-- ===========================================================================================
--   1. GRANT — `scp_app` (the request-serving login role, NOSUPERUSER/NOBYPASSRLS) gets SELECT
--      only; INSERT/UPDATE/DELETE are explicitly REVOKEd.
--   2. RLS — ENABLE + FORCE, with a `FOR SELECT USING (true)` tenant-read policy and NO write
--      policy for `scp_app` in any verb. Even a future migration that mistakenly re-granted the
--      write privilege would still be denied by RLS.
--
-- AND THE WRITE PRINCIPAL, WHICH 0029/0035/0036/0074 ALL FORGOT UNTIL 0076 AND WHICH 0083 §2
-- FORGOT AGAIN: `scp_operator` needs BOTH a grant and a `FOR ALL ... USING (true) WITH CHECK
-- (true)` policy, because under FORCE RLS a role with no applicable policy has every statement
-- denied no matter what it was granted. Both are below, and both are asserted by a test running
-- as a real least-privileged principal (`RawScpAppClient`) plus a direct
-- `has_table_privilege`/`pg_policies` probe — because the Testcontainers bootstrap user is a
-- SUPERUSER, which bypasses grants and RLS unconditionally, and that is exactly why four tables
-- shipped with no writable principal at all behind a green suite.
--
-- DELIBERATELY NOT `GRANT scp_operator TO scp_app` in any form — 0076's rejected alternative (b):
-- it would leave every operator write one `SET ROLE` away from request-serving code, and the
-- whole authority argument for the operator door is that it is NOT reachable from tenant-serving
-- authority. The operator connection is opened separately (`routes/operator-db.ts`,
-- `withOperatorDb`) and the door is gated on `SCP_OPERATOR_TOKEN`; unset => 403, never a
-- credential fallback.
--
-- ===========================================================================================
-- NUMBERING
-- ===========================================================================================
-- drizzle gates on `when` ALONE — `idx` orders the array and decides nothing — and it SILENTLY
-- SKIPS an entry whose `when` does not exceed what a database has already applied, which is
-- un-applied-but-green. Both values were re-derived from `meta/_journal.json`'s tail at write
-- time (idx 85, when 1788143000000): idx 86, when 1788144000000. `src/db/journal-ordering.test.ts`
-- guards the file.
--
-- Hand-authored (the convention of 0002/0007/0010/0011/0014/0017/0028/0029/0035/0036/0061/0062/
-- 0076/0083): RLS, grants and policies are never expressible in drizzle-kit's schema diffing.
-- ===========================================================================================

CREATE TABLE IF NOT EXISTS "instance_freezes" (
  -- A REAL uuid, not a synthetic `platform:<key>` string, and the reason is load-bearing rather
  -- than cosmetic: this id travels into `ServiceBoardFreezeSchema.id`, which is published in
  -- `openapi.v1.json` as `z.string().uuid()`. A non-uuid identity would either violate the
  -- shipped response contract or force widening it — an oasdiff response change this repo has
  -- already paid for once. Generated by the route (uuidv7, the convention `freezes.id` follows)
  -- and STABLE across a `PUT` upsert of the same key, so a Decision recorded weeks ago still
  -- names the row that is still in force.
  "id" uuid NOT NULL,
  -- The operator slug — the `PUT`/`DELETE` path segment, and the name an operator recognises.
  -- UNIQUE, not the primary key, so the id above can be the identity everything downstream reads.
  "key" text NOT NULL,
  "name" text,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "reason" text NOT NULL,
  -- The EXPLICIT deployment-wide form. See the header: absence must not mean "everything".
  "match_all_environments" boolean NOT NULL DEFAULT false,
  "match_environment" text,
  "match_region" text,
  -- Same column, same semantics, same owner decision D5 as `freezes.atomic` (0084): `true` parks
  -- EVERY target of a wave once it covers any one of them; `false` (the default) holds only the
  -- covered targets and lets their uncovered siblings ship.
  "atomic" boolean NOT NULL DEFAULT false,
  -- Proposal §2.2. `false` (the default): NO tenant role can override this freeze, however
  -- privileged — not an org-root Owner holding `freeze:override`. `true`: the OPERATOR has
  -- admitted tenant override for THIS freeze, and an actor holding `freeze:override` AT THE ORG
  -- ROOT may then override it under the same mandatory-reason rule every other override obeys.
  -- Both authorities stay independent and both are required. Default false because a loosening
  -- never defaults on.
  "overridable" boolean NOT NULL DEFAULT false,
  "note" text,
  -- The SOFT retraction, for exactly the reason 0085 gave the org tier: the freeze-block Decision
  -- carries this row's id in `inputContext.freeze.id` FOREVER, and a hard DELETE would make
  -- `scp change explain` name an id that resolves to nothing — precisely the question charter
  -- principle 6 exists to keep answerable. `DELETE /v1/instance/freezes/{key}` sets these.
  -- No `lifted_by_actor_id`: this door authenticates by DEPLOYMENT TOKEN, not by a graph actor,
  -- and stamping the tenant subject who happened to hold the token would name the wrong
  -- principal in a permanent record.
  "lifted_at" timestamp with time zone,
  "lift_reason" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "instance_freezes_pk" PRIMARY KEY ("id"),
  CONSTRAINT "instance_freezes_key_uq" UNIQUE ("key"),
  CONSTRAINT "instance_freezes_key_ck" CHECK (length(btrim("key")) > 0),
  CONSTRAINT "instance_freezes_reason_ck" CHECK (length(btrim("reason")) > 0),
  -- The SAME window-order invariant `assertWindowOrdered` enforces on both org-tier write paths.
  -- In the DB as well as in the code because a row with `ends_at <= starts_at` reads as
  -- permanently inactive to the half-open window predicate, with nobody having lifted it.
  CONSTRAINT "instance_freezes_window_ck" CHECK ("ends_at" > "starts_at"),
  -- EXACTLY ONE addressing form, stated in the database so a future writer cannot store the
  -- ambiguous shape: either explicitly deployment-wide (and then no coordinate at all), or an
  -- environment (optionally narrowed to one region). A region without an environment is a
  -- coordinate with no origin; an empty-string environment is an environment nothing declares.
  CONSTRAINT "instance_freezes_match_ck" CHECK (
    ("match_all_environments" AND "match_environment" IS NULL AND "match_region" IS NULL)
    OR (
      NOT "match_all_environments"
      AND "match_environment" IS NOT NULL
      AND length(btrim("match_environment")) > 0
      AND ("match_region" IS NULL OR length(btrim("match_region")) > 0)
    )
  )
);
--> statement-breakpoint

-- The one query the read path runs: "every live instance freeze covering this instant". Mirrors
-- `freezes_org_window` minus the org column. It is a handful of rows in the worst case and zero
-- rows nearly always, which is what makes `freeze-scope.ts`'s INERTNESS property survive this
-- change: one extra indexed read per change per tick, and no containment walk added anywhere.
CREATE INDEX IF NOT EXISTS "instance_freezes_window"
  ON "instance_freezes" USING btree ("starts_at", "ends_at");
--> statement-breakpoint

-- Barrier 1 — the request-serving role may only READ.
GRANT SELECT ON instance_freezes TO scp_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON instance_freezes FROM scp_app;
--> statement-breakpoint

-- Barrier 2 — RLS. The tenant policy is SELECT-only; the ABSENCE of any tenant write policy is
-- the write denial, independent of the grant above.
ALTER TABLE instance_freezes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE instance_freezes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON instance_freezes;
--> statement-breakpoint
CREATE POLICY tenant_read ON instance_freezes FOR SELECT USING (true);
--> statement-breakpoint

-- THE WRITE PRINCIPAL — the half 0029/0035/0036/0074 shipped without and 0076 had to come back
-- for, and that 0083 §2's `governance_move_instance_rung` then shipped without AGAIN. Both
-- statements are required: under FORCE RLS the grant alone is denied by the absent policy, and
-- the policy alone is denied by the absent grant. `WITH CHECK` is spelled out explicitly because
-- an omitted `WITH CHECK` on a FOR ALL policy is silent — reads and matching pass, the write is
-- refused.
GRANT SELECT, INSERT, UPDATE, DELETE ON instance_freezes TO scp_operator;
--> statement-breakpoint
DROP POLICY IF EXISTS operator_write ON instance_freezes;
--> statement-breakpoint
CREATE POLICY operator_write ON instance_freezes
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

COMMENT ON TABLE instance_freezes IS
  'campaigns-rework §2 / owner decision D1: the INSTANCE-SCOPED (platform) freeze tier, above org. No org_id (the DESIGN §4.2 exception): one row binds every organization hosted on this deployment. Addresses targets by STAGE COORDINATE (properties.environment + optional properties.region on a deployment-target, the M15.6/ADR-0017 §3 convention) because object ids do not exist across orgs; match_all_environments is the explicit deployment-wide form and absence of an environment is NOT it. Merges with org-tier freezes by UNION (a freeze is a predicate, not a number) — an org can never subtract from it. Not overridable by any tenant role unless the operator sets overridable, which admits override by freeze:override AT THE ORG ROOT. Does not federate and cannot: every layer of the sync journal is org-scoped. Tenant-read, operator-write (SCP_OPERATOR_TOKEN + the scp_operator connection).';
