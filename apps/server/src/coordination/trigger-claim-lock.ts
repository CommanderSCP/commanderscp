import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

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
 * HOW / WHY THIS DOESN'T REGRESS CRASH-RECOVERY LATENCY / COST: see `advisory-lock.ts`'s module
 * doc — this is now a thin, wave-target-namespaced wrapper around that shared primitive (a SECOND
 * call site, `reconcile.ts`'s `advanceEvaluatedChanges`, needed the identical mechanism for the
 * `evaluated -> coordinated` plan-compilation race, so the underlying lock logic now lives there).
 */

const NAMESPACE = "trigger-claim";

export type TriggerClaimLock = AdvisoryLock;

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
  return tryAcquireAdvisoryLock(db, NAMESPACE, waveTargetId);
}
