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

/**
 * Vitest `globalSetup` (BUILD_AND_TEST.md §4.2): one real `postgres:16` Testcontainers instance
 * for the whole integration run — migrated once here, never mocked. Mirrors main.ts's two-phase
 * boot (PR #4 security review, CRITICAL 3; pg-boss role added for the M3 tracked security
 * follow-up): the container's superuser runs migrations and provisions the `scp_app` and
 * `scp_pgboss` login roles; everything the tests' servers do afterwards runs on the
 * least-privileged runtime connection, and pg-boss (when a test opts into `withEventRelay`)
 * connects as `scp_pgboss`. `process.env` mutations in globalSetup are visible to test workers,
 * which is how all three URLs reach every `*.integration.test.ts` file
 * (test-support/harness.ts reads them).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

export default async function setup(): Promise<() => Promise<void>> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16")
    .withDatabase("scp")
    .withUsername("scp")
    .withPassword("scp")
    .start();

  const connectionString = container.getConnectionUri();
  const runtimeConnectionString = deriveRuntimeDatabaseUrl(connectionString);
  const pgBossConnectionString = deriveRuntimeDatabaseUrl(connectionString, "scp_pgboss");
  process.env.TEST_DATABASE_URL = connectionString;
  process.env.TEST_RUNTIME_DATABASE_URL = runtimeConnectionString;
  process.env.TEST_PGBOSS_DATABASE_URL = pgBossConnectionString;

  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  const creds = runtimeCredentials(runtimeConnectionString);
  await provisionRuntimeRole(pool, creds.user, creds.password);
  const pgBossCreds = runtimeCredentials(pgBossConnectionString);
  await provisionPgBossRole(pool, pgBossCreds.user, pgBossCreds.password);
  await pool.end();

  return async () => {
    await container.stop();
  };
}
