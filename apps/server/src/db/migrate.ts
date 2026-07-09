import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/db/migrate.js -> ../../drizzle (repo-relative apps/server/drizzle, committed SQL)
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/** Runs the committed forward-only migrations. Auto-run on boot (dev + compose eval mode). */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
