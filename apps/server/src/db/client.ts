import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

/**
 * `pg.Pool` does not connect eagerly — constructing it (and the drizzle wrapper around it) is
 * always safe to call even when no database is reachable, which is what lets
 * `openapi:emit` boot the app's route definitions without a DB (BUILD_AND_TEST.md §8 M0).
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
