import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Vitest `globalSetup` (BUILD_AND_TEST.md §4.2): one real `postgres:16` Testcontainers instance
 * for the whole integration run — migrated once here, never mocked. `process.env` mutations in
 * globalSetup are visible to test workers, which is how `TEST_DATABASE_URL` reaches every
 * `*.integration.test.ts` file (test-support/harness.ts reads it).
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
  process.env.TEST_DATABASE_URL = connectionString;

  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  await pool.end();

  return async () => {
    await container.stop();
  };
}
