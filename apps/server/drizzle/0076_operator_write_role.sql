-- ===========================================================================================
-- M22.9 R3 — `scp_operator`: THE WRITE PRINCIPAL THE FOUR OPERATOR DOORS NEVER HAD.
--
-- This migration adds NO table. It adds the missing half of four tables that already exist
-- (0029 `scan_requirement_floors`, 0035 `scanner_assignments`, 0036 `scan_db_staleness_policy`,
-- 0074 `scan_exclusion_admissions`): all four are operator-write / tenant-read by design, and all
-- four shipped the READ half only. Nothing in the database could legally write them.
--
-- ===========================================================================================
-- THE MEASURED DEFECT, IN TWO INDEPENDENT LAYERS
--
-- 1. NO CONNECTION. Every one of the four PUT handlers opened
--    `new pg.Pool({ connectionString: deps.config.databaseUrl })`. `config.databaseUrl` is the
--    admin/bootstrap connection, and in the hardened Helm shape the api/worker pods DO NOT HAVE
--    ONE: `commanderscp.adminDbEnv` is included by `migrations-job.yaml` and by nothing else
--    (M8 — only the migrations Job ever holds admin credentials). With `DATABASE_URL` absent,
--    `loadConfig` fell back to its literal `postgres://scp:scp@localhost:5432/scp`, so the handler
--    dialed 127.0.0.1 INSIDE the api pod: ECONNREFUSED, surfaced as a bare 500.
--
-- 2. NO PRIVILEGE. Even handed a working connection, the write could not land. All four tables
--    `GRANT SELECT` to `scp_app`, `REVOKE INSERT, UPDATE, DELETE`, `ENABLE` + `FORCE` RLS, and
--    create exactly one policy — `tenant_read`, `FOR SELECT`. There is no write grant and no
--    write policy for any role at all.
--
-- WHY THE SUITE WAS GREEN THE WHOLE TIME, and this is the part worth remembering: the
-- Testcontainers/compose bootstrap user is a SUPERUSER, which bypasses grants and RLS
-- unconditionally. `buildTestServer` passes `DATABASE_URL: testDatabaseUrl()`, so every operator
-- write in the integration suite ran as that superuser and could not have observed either layer.
-- The tests were not weak about this; they were structurally incapable of seeing it.
--
-- WHAT IT COST M22 SPECIFICALLY. `scan_exclusion_admissions` is the ONLY source of the `platform`
-- and `trust_domain` admissions, and `buildScanExclusionTargetInputs` seeds every target's
-- `representedTiers` with both rungs UNCONDITIONALLY (0074's header). An empty table therefore
-- fails the monotone AND at the top rung for EVERY clause — so on a real deployment M22.2 through
-- M22.7 were inert, invisibly, and M22.9's write door (which exists precisely to fill that table)
-- could not execute.
--
-- ===========================================================================================
-- THREE ALTERNATIVES CONSIDERED AND REJECTED — read these before "simplifying" this file away
--
-- (a) MOUNT THE ADMIN `DATABASE_URL` INTO THE api/worker PODS. One line in `_helpers.tpl`, works
--     immediately. It is also exactly the posture M8 deliberately removed: the migrations Job is
--     the only workload that may hold a superuser-capable credential, and `config.ts`'s own doc
--     comment on `databaseUrl` says "never by request-serving code (PR #4 security review,
--     CRITICAL 3)". Restoring it for a governance write would undo that for every request handler
--     in the process, not just this one.
--
-- (b) `GRANT scp_operator TO scp_app WITH INHERIT FALSE` + `SET LOCAL ROLE scp_operator` IN THE
--     HANDLER — the 0003 `scp_relay` idiom, which needs no new credential and would work on every
--     deployment shape with zero operator action. Rejected on what the two roles are FOR: the
--     relay's work genuinely runs inside the request-serving process, so `scp_app` reaching it is
--     the design. An operator write is a different PRINCIPAL from the tenant traffic sharing that
--     pool, and granting the role would leave the write one `SET ROLE` away from every request
--     handler and from anything that can influence one. The whole authority argument for the
--     operator door (ADR-0033 §7a: "no RBAC permission can grant this") is that it is not
--     reachable from tenant-serving authority.
--
-- (c) COPY THE ADMIN'S SCRAM VERIFIER OUT OF `pg_authid` HERE, so a derived
--     `postgres://scp_operator:<admin password>@…` URL would authenticate with no provisioning
--     step at all. Reading `pg_authid` requires superuser — false on RDS/Cloud SQL/Azure Flexible,
--     where this migration would then fail outright and take the whole upgrade with it — and the
--     copied verifier silently stops matching the moment the admin password is rotated.
--
-- ===========================================================================================
-- NOLOGIN HERE, PASSWORD OUT OF BAND — AND THE FOLLOW-UP THAT CLOSES IT
--
-- Same idiom as `scp_app` (0002 §1), `scp_relay` (0003) and `scp_pgboss` (0008): this file fixes
-- the role's privilege SHAPE and leaves it NOLOGIN, because a role that cannot authenticate fails
-- closed if provisioning is ever skipped, rather than sitting connectable-without-a-password. A
-- password cannot live in committed SQL.
--
-- UNLIKE those three, there is as yet NO boot-time provisioner for this role: `src/db/provision.ts`
-- has `provisionRuntimeRole` and `provisionPgBossRole` and no operator twin, so `main.ts`'s Phase 1
-- and `migrate-bin.ts` do not set this password. Until that lands, `scp_operator`'s LOGIN and
-- password are set out of band — the SAME "the role is managed externally" path
-- `SCP_RUNTIME_DATABASE_URL`'s doc comment already describes — and the connection string is handed
-- to the pods as `SCP_OPERATOR_DATABASE_URL` (config.ts, deploy/helm/README.md "Operator write
-- surface"). The owed follow-up is a `provisionOperatorRole` in `src/db/provision.ts` called from
-- both entrypoints; it is three files this change did not own, not a design question.
--
-- Nothing degrades quietly in the meantime: the chart REFUSES TO RENDER an `operatorApi.enabled`
-- install that has no operator connection wired (tools/helm-verify asserts that refusal), and a
-- connection that cannot be opened is answered with a 503 naming the credential and this role
-- rather than a 500 (routes/operator-db.ts).
--
-- ===========================================================================================
-- ONE `FOR ALL` POLICY PER TABLE, NOT FOUR VERB-SPLIT ONES
--
-- A GRANT alone is NOT sufficient here and that is the whole reason policies appear below: all four
-- tables are `FORCE ROW LEVEL SECURITY`, and under RLS a role with no applicable policy sees every
-- statement denied no matter what it has been granted. The predicate is `true` in both directions
-- because these tables hold NO per-tenant rows at all — there is no row for an operator to be
-- restricted to — so splitting into FOR INSERT / FOR UPDATE / FOR DELETE would buy nothing except
-- four separate places to forget a `WITH CHECK` (an omitted `WITH CHECK` on an UPDATE policy is
-- silent: reads and matching pass, the write is refused). Both clauses are spelled out explicitly.
--
-- `scp_app`'s posture is UNCHANGED by every statement in this file. Grants and policies are checked
-- independently, and `scp_app` gains neither: it still holds SELECT only, and still has no write
-- policy. The two barriers 0029/0074 describe remain two barriers.
--
-- ===========================================================================================
-- NUMBERING (0074's header states the rule; this entry follows it)
--
-- drizzle gates on `when` ALONE — `idx` orders the array and decides nothing — and it SILENTLY
-- SKIPS an entry whose `when` does not exceed what a database has already applied. Both values here
-- were re-derived from `meta/_journal.json`'s current tail at write time (idx 75, when
-- 1788133003000) rather than from anything remembered: idx 76, when 1788133004000, strictly greater
-- than every entry ahead of it. `src/db/journal-ordering.test.ts` guards the file.
-- ===========================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scp_operator') THEN
    CREATE ROLE scp_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Deliberately NOT `GRANT scp_operator TO scp_app` in any form — see rejected alternative (b).
GRANT USAGE ON SCHEMA public TO scp_operator;
--> statement-breakpoint

-- SELECT is granted alongside the writes because three of the four handlers read their own write
-- back in the same statement (`RETURNING`, and the admissions handler's post-COMMIT re-read scoped
-- to the `(tier, origin)` it authored), and because `ON CONFLICT DO UPDATE` evaluates the existing
-- row. DELETE is needed by exactly one of them — the admissions REPLACE — but is granted uniformly
-- so the four doors do not diverge in privilege for a reason no reader could reconstruct.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  scan_requirement_floors,
  scanner_assignments,
  scan_db_staleness_policy,
  scan_exclusion_admissions
TO scp_operator;
--> statement-breakpoint

DROP POLICY IF EXISTS operator_write ON scan_requirement_floors;
--> statement-breakpoint
CREATE POLICY operator_write ON scan_requirement_floors
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

DROP POLICY IF EXISTS operator_write ON scanner_assignments;
--> statement-breakpoint
CREATE POLICY operator_write ON scanner_assignments
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

DROP POLICY IF EXISTS operator_write ON scan_db_staleness_policy;
--> statement-breakpoint
CREATE POLICY operator_write ON scan_db_staleness_policy
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
--> statement-breakpoint

DROP POLICY IF EXISTS operator_write ON scan_exclusion_admissions;
--> statement-breakpoint
CREATE POLICY operator_write ON scan_exclusion_admissions
  FOR ALL TO scp_operator USING (true) WITH CHECK (true);
