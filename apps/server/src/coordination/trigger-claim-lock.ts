import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db/client.js";

/**
 * M8 hardening (BUILD_AND_TEST.md §8 M8 item 6, "Multi-replica coordination trigger
 * concurrency"): the real mutual-exclusion boundary around `coordination/reconcile.ts`'s
 * `triggerWaveTarget` three-step claim/trigger/record sequence.
 *
 * THE PROBLEM this closes: `wave-targets-repo.ts`'s `claimWaveTargetForTriggering` alone cannot
 * tell "a `triggering` row abandoned by a crashed prior attempt" (safe, indeed REQUIRED, to
 * reclaim immediately) apart from "a `triggering` row another worker REPLICA's overlapping tick
 * is, this very instant, still genuinely mid-`trigger()`-call for" (must NOT be reclaimed — that
 * would fire the executor's `trigger()` a second time, concurrently, for the same wave target). A
 * status column plus a timestamp cannot express "is the process that set this status still
 * alive and working" without either a fixed staleness window (which either reopens the race for
 * slow `trigger()` calls, or stalls fast crash recovery — the M3 crash-resumption tests need
 * retry on the VERY NEXT ~1s tick) or a real distributed lock. This is the real lock.
 *
 * HOW: a Postgres **session-scoped advisory lock** (`pg_try_advisory_lock` / `pg_advisory_unlock`,
 * NOT the `_xact_` variant), keyed by a stable hash of the wave target's id, acquired on a
 * DEDICATED connection checked out directly from the pool (`db.$client` — bypassing the
 * request-scoped `withTenantTx` transaction machinery, since this lock must outlive any single
 * short transaction). `pg_try_advisory_lock` never blocks: if another session already holds this
 * exact key, it returns `false` immediately — no polling, no timeout, no timing assumption
 * anywhere. That gives `triggerWaveTarget` a PROVABLE single-flight guarantee: at most one process
 * anywhere (any worker replica, any tick) can be inside the locked section for a given wave target
 * id at any instant.
 *
 * WHY THIS DOESN'T REGRESS CRASH-RECOVERY LATENCY: the lock is released the instant the holder's
 * `triggerWaveTarget` call finishes — success OR a caught error (a `finally` in the caller) — so a
 * simulated/real failure that keeps the process alive is retryable on the very next tick, exactly
 * as before this fix. And because it is SESSION-scoped (bound to the raw connection, not any one
 * transaction), Postgres itself releases it automatically the instant that connection's backend
 * dies — a genuine process crash (the "kill the worker" class of test) drops the connection and
 * the lock is gone with it, so a freshly started worker's next tick can reclaim immediately. No
 * heartbeat, no lease-renewal, no operator-tunable timeout to get wrong.
 *
 * Cost: one pool connection held (idle, no open transaction, no row locks) for the duration of the
 * external `trigger()` call. Cheap compared to the alternative (holding a live transaction open
 * across an arbitrary-length external HTTP call, which PR #7's review explicitly ruled out) and
 * bounded by however many wave targets are triggering concurrently in this process — the same
 * order of magnitude as the plugin-host's own per-instance concurrency.
 */

/** Hashes `waveTargetId` (a UUID string) into the two signed-32-bit-int key `pg_try_advisory_lock`
 *  accepts — the two-int overload sidesteps any bigint/wire-precision handling for a 64-bit key. */
function advisoryLockKeys(waveTargetId: string): [number, number] {
  const digest = createHash("sha256").update(waveTargetId).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface TriggerClaimLock {
  /** Releases the advisory lock and returns the underlying connection to the pool. Idempotent —
   *  safe to call more than once (e.g. from a `finally` after an earlier explicit release). */
  release(): Promise<void>;
}

/**
 * Attempts to acquire the advisory lock for `waveTargetId`. Returns `undefined` immediately
 * (never blocks) if another session already holds it — the caller's correct response is exactly
 * what it already does when `claimWaveTargetForTriggering` reports "not claimed": back off, let a
 * later tick try again.
 */
export async function tryAcquireTriggerClaimLock(
  db: Db,
  waveTargetId: string
): Promise<TriggerClaimLock | undefined> {
  const [key1, key2] = advisoryLockKeys(waveTargetId);
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
