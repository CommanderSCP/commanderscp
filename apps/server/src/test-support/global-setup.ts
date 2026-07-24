import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  deriveRuntimeDatabaseUrl,
  provisionPgBossRole,
  provisionRuntimeRole,
  runtimeCredentials
} from "../db/provision.js";
import { TEMPLATE_DATABASE_NAME, withDatabaseName } from "./db-clone.js";

/**
 * Vitest `globalSetup` (BUILD_AND_TEST.md §4.2): one real `postgres:16` Testcontainers instance
 * for the whole integration run — migrated once here, never mocked. Mirrors main.ts's two-phase
 * boot (PR #4 security review, CRITICAL 3; pg-boss role added for the M3 tracked security
 * follow-up): the container's superuser runs migrations and provisions the `scp_app` and
 * `scp_pgboss` login roles.
 *
 * LEVER 3 — per-worker template-DB isolation (drops `singleFork`). Instead of migrating the
 * container's default `scp` database and running every test serially against it, we migrate a
 * dedicated TEMPLATE database (`scp_template`) once, here. Each Vitest worker then clones its own
 * private database (`CREATE DATABASE scp_w<id> TEMPLATE scp_template` — a fast file copy) in
 * test-support/per-worker-db.ts, so files in different workers never share the singleton scan
 * tables, the single `pgboss` schema, or the org-filter-less outbox relay (the three collision
 * classes that forced serial execution). The login roles `scp_app`/`scp_pgboss` are CLUSTER-GLOBAL,
 * so provisioning them once here is enough for every cloned database.
 *
 * `process.env` mutations in globalSetup are visible to test workers; the three URLs set here point
 * at the container's default `scp` database and act as the ADMIN/base connection (used by
 * per-worker-db.ts to issue `CREATE DATABASE`). Each worker then OVERRIDES all three env URLs to
 * point at its own cloned database, keeping the same host/port and the same `scp_app`/`scp_pgboss`
 * roles — only the database name changes. Because test-support/harness.ts's URL getters read
 * `process.env` lazily at call time, `buildTestServer` and the raw probes pick up the per-worker
 * database automatically, with no harness change.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

export default async function setup(): Promise<() => Promise<void>> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16")
    .withDatabase("scp")
    .withUsername("scp")
    .withPassword("scp")
    .start();

  // Superuser connection string against the container's default `scp` database. This is the
  // ADMIN/base connection: per-worker-db.ts connects here (a database that is neither the template
  // nor any worker clone) to run `CREATE DATABASE scp_w<id> TEMPLATE scp_template`.
  const baseConnectionString = container.getConnectionUri();

  // Create + migrate the template database. Migrations create the cluster-global roles
  // (scp_app/scp_pgboss/scp_relay — drizzle 0002/0003/0008) AND the per-database objects (table
  // grants, RLS policies, the `pgboss` schema, `GRANT CREATE ON DATABASE ... TO scp_pgboss`). The
  // per-database objects are copied into every `TEMPLATE`-cloned worker database; the roles persist
  // cluster-wide. The one database-level grant that is NOT copied by TEMPLATE (`GRANT CREATE ON
  // DATABASE`) is re-issued per worker in per-worker-db.ts.
  const adminPool = new pg.Pool({ connectionString: baseConnectionString });
  await adminPool.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DATABASE_NAME)}`);
  await adminPool.end();

  const templateConnectionString = withDatabaseName(baseConnectionString, TEMPLATE_DATABASE_NAME);
  const templatePool = new pg.Pool({ connectionString: templateConnectionString });
  const db = drizzle(templatePool);
  await migrate(db, { migrationsFolder });

  // Provision the (cluster-global) login roles: LOGIN + password, which cannot live in committed
  // SQL. The passwords match the superuser's (deriveRuntimeDatabaseUrl only swaps the username), so
  // the derived runtime/pgboss URLs authenticate against any database in the cluster.
  const runtimeConnectionString = deriveRuntimeDatabaseUrl(baseConnectionString);
  const pgBossConnectionString = deriveRuntimeDatabaseUrl(baseConnectionString, "scp_pgboss");
  const runtimeCreds = runtimeCredentials(runtimeConnectionString);
  await provisionRuntimeRole(templatePool, runtimeCreds.user, runtimeCreds.password);
  const pgBossCreds = runtimeCredentials(pgBossConnectionString);
  await provisionPgBossRole(templatePool, pgBossCreds.user, pgBossCreds.password);

  // Close the template pool so the template has NO active connections when workers clone it
  // (`CREATE DATABASE ... TEMPLATE` fails if any session is connected to the source).
  await templatePool.end();

  // Base (admin) URLs against the default `scp` database. per-worker-db.ts reads these to open its
  // admin connection and to derive the per-worker URLs, then overrides all three to the clone.
  process.env.TEST_DATABASE_URL = baseConnectionString;
  process.env.TEST_RUNTIME_DATABASE_URL = runtimeConnectionString;
  process.env.TEST_PGBOSS_DATABASE_URL = pgBossConnectionString;

  return async () => {
    await container.stop();
  };
}

/** Double-quotes a Postgres identifier (database name) for use in DDL that cannot be parameterized. */
function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
