import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

/** `pg.Pool` does not connect eagerly. See docs/db.md §1. */
export function createPool(connectionString: string, options?: Partial<pg.PoolConfig>): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    ...options
  });
  // FAILOVER SURVIVAL (§7.5 failover drill found this). See docs/db.md §2.
  pool.on("error", (err) => {
    console.error("[db] idle pool connection error — discarded; pool reconnects on next use", err);
  });
  return pool;
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
