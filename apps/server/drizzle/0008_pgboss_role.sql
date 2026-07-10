-- M3 Coordination Engine: pg-boss schema-scoped role (tracked security follow-up, now due — M3
-- wires the first real pg-boss subscriber, coordination/*'s job handlers). Until now pg-boss
-- connected on the admin/bootstrap (superuser in dev/compose/Testcontainers) URL to manage its
-- own `pgboss` schema — main.ts's former "documented deviation" comment described exactly this
-- gap. This migration closes it: a role that owns the `pgboss` schema alone (plus the
-- database-level `CREATE` pg-boss's own idempotent schema guard needs — see §1's long comment for
-- why that turned out to be unavoidable) and has NO access to `public` (where tenant data lives)
-- at all.
--
-- Same idiom as `scp_app` (0002 §1) and `scp_relay` (0003): the role's privilege SHAPE is fixed
-- here as NOLOGIN — a role that can never authenticate fails closed if boot-time provisioning is
-- ever skipped or broken, rather than silently staying passwordless-but-connectable. LOGIN +
-- password are granted at boot by src/db/provision.ts's `provisionPgBossRole` (mirrors
-- `provisionRuntimeRole` exactly), because a password cannot live in committed SQL.

-- ===========================================================================================
-- 1. `scp_pgboss` role + ownership of the `pgboss` schema + database-level CREATE.
--
--    pg-boss's own `.start()` (node_modules/pg-boss) issues `CREATE SCHEMA IF NOT EXISTS`,
--    `CREATE TYPE ... AS ENUM`, `CREATE TABLE`, `CREATE FUNCTION`, `CREATE INDEX` — all
--    schema-qualified to `pgboss.*` — to build and later migrate its own job tables. Once the
--    schema exists, owning it is sufficient for every one of those statements: Postgres grants a
--    schema's OWNER implicit CREATE + USAGE on that schema, including inside its dynamic
--    `CREATE TABLE pgboss.<partition>` calls for per-queue job partitions
--    (create_queue()/delete_queue() functions it installs at start()). Because scp_pgboss is both
--    the schema's owner AND the role that creates every object inside it (pg-boss connects and
--    runs its migrations as scp_pgboss — see src/events/pgboss.ts), those future tables are
--    automatically owned by scp_pgboss too: `ALTER DEFAULT PRIVILEGES ... IN SCHEMA pgboss` is
--    NOT needed — default privileges only matter when the CREATOR and the intended GRANTEE of
--    future objects differ (e.g. scp_relay's read access to outbox in 0003), and here they're the
--    same role.
--
--    BUT: `.start()` re-issues `CREATE SCHEMA IF NOT EXISTS pgboss` on EVERY boot (contractor.js's
--    create(), unconditionally, before checking installed-version state), and Postgres's ACL
--    check for that statement is against database-level CREATE, evaluated regardless of whether
--    the schema already exists — verified empirically against the installed pg-boss@10.4.2 (this
--    was not obvious from reading the source alone: schema OWNERSHIP was not sufficient in
--    practice; scp_pgboss with only schema ownership and no database CREATE failed at boot with
--    `permission denied for database <db>` on this exact statement, even though `pgboss` already
--    existed and was already owned by scp_pgboss). So scp_pgboss also needs `CREATE` on the
--    database itself. This is a real, if narrow, widening beyond pure schema-scoping — Postgres
--    has no finer-grained "may CREATE SCHEMA IF NOT EXISTS this one specific name" privilege — but
--    it grants only the ability to create NEW schemas, never any privilege on EXISTING objects
--    anywhere, least of all the tenant tables in `public` (§2 below). Verified end to end by
--    src/db/pgboss-role.integration.test.ts (pg-boss actually starts, creates its tables, and the
--    probe queries them — not just reasoned about here).
-- ===========================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'scp_pgboss') THEN
    CREATE ROLE scp_pgboss NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- Dynamic because the database name isn't fixed across dev/compose/Testcontainers/prod, and
  -- GRANT ... ON DATABASE doesn't accept an expression in identifier position.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO scp_pgboss', current_database());
END
$$;
--> statement-breakpoint

-- Idempotent on every re-run: CREATE SCHEMA ... AUTHORIZATION only assigns ownership on first
-- apply, so the ALTER is separate and unconditionally safe to repeat.
CREATE SCHEMA IF NOT EXISTS pgboss;
--> statement-breakpoint
ALTER SCHEMA pgboss OWNER TO scp_pgboss;

-- ===========================================================================================
-- 2. No grants on `public` (or anywhere else) for scp_pgboss — intentional, and this is the
--    whole point of the migration. Postgres denies table access by default; the absence of a
--    GRANT here IS the enforcement, not something that needs an explicit REVOKE. Even PUBLIC's
--    database-wide CONNECT and schema-wide USAGE-on-`public` (Postgres's own defaults) expose no
--    table privileges — SELECT/INSERT/UPDATE/DELETE on objects/relationships/role_bindings/
--    changes/etc. are only ever granted explicitly (0002 §1, 0007 §7), and never to scp_pgboss.
--    Defense-in-depth: if application code is ever mis-pointed at SCP_PGBOSS_DATABASE_URL, it
--    cannot read or write a single row of tenant data. Proven (not just asserted) by
--    src/db/pgboss-role.integration.test.ts, which connects as scp_pgboss directly and expects a
--    hard `permission denied` (42501) against objects/relationships/role_bindings/changes.
-- ===========================================================================================
