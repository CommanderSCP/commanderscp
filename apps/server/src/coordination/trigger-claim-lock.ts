import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

/** The claim lock for multi-replica trigger concurrency. See docs/coordination.md §1014. */

const NAMESPACE = "trigger-claim";

export type TriggerClaimLock = AdvisoryLock;

/** Attempts to acquire the advisory lock for `waveTargetId`. See docs/coordination.md §1015. */
export async function tryAcquireTriggerClaimLock(
  db: Db,
  waveTargetId: string
): Promise<TriggerClaimLock | undefined> {
  return tryAcquireAdvisoryLock(db, NAMESPACE, waveTargetId);
}
