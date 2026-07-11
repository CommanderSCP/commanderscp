import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

/**
 * M8 hardening (BUILD_AND_TEST.md §8 M8 item 6, "Multi-replica coordination trigger
 * concurrency") — the SAME class of bug as `trigger-claim-lock.ts`, one pipeline stage earlier,
 * found while proving the trigger-claim fix under genuine multi-replica concurrency: two worker
 * REPLICAS' overlapping ticks can both reach `reconcile.ts`'s `advanceEvaluatedChanges` for the
 * SAME freshly-`evaluated` change before either commits.
 *
 * THE BUG (confirmed against a real Postgres via a deliberate 2-concurrent-tick race): both ticks
 * call `compileAndPersistPlan(tx, ...)` inside their own `withTenantTx`, THEN
 * `transitionChange(..., toState: "coordinated")`. The loser's `transitionChange` throws
 * (fromState mismatch — the winner already committed), caught by `advanceEvaluatedChanges`'s
 * `catch`, which used to unconditionally fall back to `transitionChange(..., toState:
 * "cancelled")` IN THE SAME TRANSACTION — a transition that, from `coordinated`, is LEGAL, so the
 * loser's whole transaction (including its own already-inserted DUPLICATE `change_waves`/
 * `change_wave_targets` rows) commits: a fully-persisted second plan for the same change, and the
 * change wrongfully flipped back to `cancelled` even though the winner legitimately coordinated
 * (and may already be executing) it.
 *
 * THE FIX: acquire this advisory lock, keyed by `changeObjectId`, BEFORE compiling or
 * transitioning anything — a losing concurrent attempt now backs off immediately (exactly like
 * `triggerWaveTarget` backing off on a failed trigger-claim lock) and NEVER calls
 * `compileAndPersistPlan` at all, so no duplicate plan is ever persisted and nothing gets
 * wrongfully cancelled. Additionally, INSIDE the lock, the change's current state is re-checked
 * fresh before compiling: if it's no longer `evaluated` (another tick got there first, in the
 * window between the initial batch read and this lock's acquisition), that is the SAME "lost the
 * race" case and is a clean no-op — not a compilation failure, so never a cancel.
 *
 * See `advisory-lock.ts`'s module doc for the underlying mechanism (session-scoped
 * `pg_try_advisory_lock`, non-blocking, auto-released on connection death or explicit release).
 */

const NAMESPACE = "change-coordinate";

export type ChangeCoordinationLock = AdvisoryLock;

export async function tryAcquireChangeCoordinationLock(
  db: Db,
  changeObjectId: string
): Promise<ChangeCoordinationLock | undefined> {
  return tryAcquireAdvisoryLock(db, NAMESPACE, changeObjectId);
}
