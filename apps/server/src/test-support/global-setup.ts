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

/** Vitest `globalSetup` (BUILD_AND_TEST.md §4.2). See docs/test-support.md §7. */
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

  // Create + migrate the template database. See docs/test-support.md §8.
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
