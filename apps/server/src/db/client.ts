import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

/**
 * `pg.Pool` does not connect eagerly — constructing it (and the drizzle wrapper around it) is
 * always safe to call even when no database is reachable, which is what lets
 * `openapi:emit` boot the app's route definitions without a DB (BUILD_AND_TEST.md §8 M0).
 *
 * THE ONE POOL FACTORY (proposal multi-region-instance-resilience.md §4-A6, §7.1 item 6). Every
 * `new pg.Pool(...)` in this codebase goes through here — a source-lint test
 * (pool-factory-census.test.ts) asserts it. `connectionTimeoutMillis` and `keepAlive` are applied
 * by default so a connect against a dead/failed-over host fails fast onto the promoted primary
 * instead of hanging at OS TCP patience; callers needing a different shape (e.g. `max: 1`
 * single-connection pools) pass `options` to override or extend the defaults, never construct
 * their own `pg.Pool`.
 */
export function createPool(connectionString: string, options?: Partial<pg.PoolConfig>): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    ...options
  });
  // FAILOVER SURVIVAL (§7.5 failover drill found this): a Postgres failover terminates every IDLE
  // pooled connection at once, and `pg.Pool` emits `'error'` for each. With NO listener attached,
  // Node treats it as an unhandledError and CRASHES the process — so a failover, the exact event this
  // milestone exists to survive, would take down every pod on the way back up. Log and swallow: the
  // pool discards the dead connection and re-establishes a fresh one on the next checkout (the
  // `connectionTimeoutMillis` above makes that checkout fast-fail onto the promoted primary, §4-A6).
  pool.on("error", (err) => {
    console.error("[db] idle pool connection error — discarded; pool reconnects on next use", err);
  });
  return pool;
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
