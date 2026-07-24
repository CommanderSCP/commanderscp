import pg from "pg";
import { deriveRuntimeDatabaseUrl } from "../db/provision.js";

/**
 * LEVER 3 — per-worker template-DB isolation, pure helpers + the clone routine. Kept side-effect
 * free (no top-level `await`) so that test-support/global-setup.ts can import the constants/helpers
 * without triggering a clone in the main process; the actual clone is driven by the thin
 * `setupFiles` entry test-support/per-worker-db.ts, which runs inside each worker fork.
 *
 * WHY per-worker databases: the integration suite ran serially (`singleFork`) because two files
 * sharing one database collide on instance-scoped singleton tables (`scan_requirement_floors`,
 * `scanner_assignments` — no `org_id`, tests DELETE them wholesale), the single global `pgboss`
 * schema + reconcile queue, and the outbox relay's org-filter-less `SELECT ... FOR UPDATE SKIP
 * LOCKED`. A private database per worker neutralizes all three, so files in different workers run
 * truly in parallel. Files WITHIN a worker still run serially and share that worker's database —
 * exactly the (safe) isolation the suite already relied on under `singleFork`.
 */

/** The migrated template database globalSetup builds; every worker clones from it. */
export const TEMPLATE_DATABASE_NAME = "scp_template";

/**
 * Advisory-lock key that serializes `CREATE DATABASE ... TEMPLATE scp_template` across workers.
 * `CREATE DATABASE` from a template fails if ANY session (including another worker's concurrent
 * clone, which briefly connects to the template to copy it) is attached to the source, so workers
 * take this lock on the shared admin database before cloning. Arbitrary constant, unique to this use.
 */
const CLONE_ADVISORY_LOCK_KEY = 0x5c_70_c1_0e; // "SCP CLONE"

/** Returns the same connection URL with only the database name (URL path) swapped. */
export function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** The worker id Vitest assigns to this fork (1-based). Stable for the life of the worker. */
function workerId(): string {
  return process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
}

/**
 * Clones a private database for the current worker from `scp_template` and repoints the three
 * `TEST_*_DATABASE_URL` env vars at it. Idempotent per worker: keyed off `process.env`, which
 * persists across Vitest's per-file module-registry resets within the same fork, so re-imports of
 * the setup file skip the (expensive) re-clone while still inheriting the overridden env URLs.
 */
export async function provisionWorkerDatabase(): Promise<void> {
  const workerDatabase = `scp_w${workerId()}`;

  if (process.env.SCP_TEST_WORKER_DATABASE === workerDatabase) return;

  const baseAdminUrl = process.env.TEST_DATABASE_URL;
  if (!baseAdminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is unset — per-worker-db setup requires globalSetup (test-support/global-setup.ts) to have run first."
    );
  }

  // Admin connection against the base `scp` database (neither the template nor any worker clone —
  // you cannot drop/create a database you are connected to, and the template must stay unconnected).
  const admin = new pg.Client({ connectionString: baseAdminUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [CLONE_ADVISORY_LOCK_KEY]);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(workerDatabase)} WITH (FORCE)`);
      await admin.query(
        `CREATE DATABASE ${quoteIdent(workerDatabase)} TEMPLATE ${quoteIdent(TEMPLATE_DATABASE_NAME)}`
      );
      // Database-level grants are NOT copied by TEMPLATE (only in-database objects are), so re-issue
      // the one the template's migration 0008 granted: pg-boss re-runs `CREATE SCHEMA IF NOT EXISTS
      // pgboss` on every boot, whose ACL check is against database-level CREATE regardless of whether
      // the schema already exists. Without this, `withEventRelay` boots fail with "permission denied
      // for database scp_w<id>".
      await admin.query(`GRANT CREATE ON DATABASE ${quoteIdent(workerDatabase)} TO scp_pgboss`);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [CLONE_ADVISORY_LOCK_KEY]);
    }
  } finally {
    await admin.end();
  }

  // Repoint all three env URLs at the clone: superuser for privileged fixture surgery, and the
  // cluster-global scp_app/scp_pgboss roles for the runtime + pg-boss pools. Only the database name
  // changes — same host/port/roles as globalSetup provisioned. deriveRuntimeDatabaseUrl swaps the
  // role; withDatabaseName swaps the database.
  process.env.TEST_DATABASE_URL = withDatabaseName(baseAdminUrl, workerDatabase);
  process.env.TEST_RUNTIME_DATABASE_URL = withDatabaseName(
    deriveRuntimeDatabaseUrl(baseAdminUrl),
    workerDatabase
  );
  process.env.TEST_PGBOSS_DATABASE_URL = withDatabaseName(
    deriveRuntimeDatabaseUrl(baseAdminUrl, "scp_pgboss"),
    workerDatabase
  );
  process.env.SCP_TEST_WORKER_DATABASE = workerDatabase;
}

/** Double-quotes a Postgres identifier (database name) for use in DDL that cannot be parameterized. */
function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
