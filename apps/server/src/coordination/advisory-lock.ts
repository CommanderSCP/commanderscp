import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db/client.js";

/** Generic Postgres session-scoped advisory lock. See docs/coordination.md §1. */

function advisoryLockKeys(namespace: string, key: string): [number, number] {
  const digest = createHash("sha256").update(`${namespace}:${key}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface AdvisoryLock {
  /** Releases the advisory lock and returns the underlying connection to the pool. Idempotent —
   *  safe to call more than once (e.g. from a `finally` after an earlier explicit release). */
  release(): Promise<void>;
}

/** Try to take the advisory lock; never blocks. See docs/coordination.md §2. */
export async function tryAcquireAdvisoryLock(
  db: Db,
  namespace: string,
  key: string
): Promise<AdvisoryLock | undefined> {
  const [key1, key2] = advisoryLockKeys(namespace, key);
  const client: pg.PoolClient = await db.$client.connect();
  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
      [key1, key2]
    );
    acquired = result.rows[0]?.locked === true;
  } catch (err) {
    client.release();
    throw err;
  }

  if (!acquired) {
    client.release();
    return undefined;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [key1, key2]);
      } finally {
        client.release();
      }
    }
  };
}
