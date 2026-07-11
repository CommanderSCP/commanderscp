import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db/client.js";

/**
 * Generic Postgres session-scoped advisory lock (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6,
 * "Multi-replica coordination trigger concurrency", extended to the `evaluated -> coordinated`
 * plan-compilation race the SAME milestone's concurrency audit found next). Factored out of
 * `trigger-claim-lock.ts` (its original, wave-target-scoped home) once a SECOND call site needed
 * the identical pattern (`reconcile.ts`'s `advanceEvaluatedChanges` — see that function's doc
 * comment) — the underlying mechanism, and the reasoning for why it's the right tool, is IDENTICAL
 * regardless of what kind of row it's protecting.
 *
 * `pg_try_advisory_lock` never blocks: if another session already holds the exact key, this
 * returns `undefined` immediately — no polling, no timeout, no timing assumption. Session-scoped
 * (not `_xact_`) so it survives across however many short transactions the caller's critical
 * section needs, and is automatically released by Postgres itself the instant the holding
 * connection's backend dies (a genuine process crash), with zero heartbeat/lease-renewal
 * machinery. See `trigger-claim-lock.ts`'s doc comment for the full "why a lock, not a
 * status+timestamp heuristic" reasoning — it applies verbatim to every caller of this module.
 *
 * `namespace` keeps different callers' key spaces from colliding (a wave-target id and a change
 * object id are both UUIDs drawn from the same id-generation scheme; hashing them under different
 * namespace prefixes means a wave target and a change can never accidentally share a lock key).
 */

function advisoryLockKeys(namespace: string, key: string): [number, number] {
  const digest = createHash("sha256").update(`${namespace}:${key}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface AdvisoryLock {
  /** Releases the advisory lock and returns the underlying connection to the pool. Idempotent —
   *  safe to call more than once (e.g. from a `finally` after an earlier explicit release). */
  release(): Promise<void>;
}

/**
 * Attempts to acquire the advisory lock for `key` within `namespace`. Returns `undefined`
 * immediately (never blocks) if another session already holds it — the caller's correct response
 * is to back off and let a later tick try again, exactly like a failed row-level claim.
 */
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
