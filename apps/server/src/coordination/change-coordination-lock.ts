import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

/** The same single-flight lock, for change coordination. See docs/coordination.md §259. */

const NAMESPACE = "change-coordinate";

export type ChangeCoordinationLock = AdvisoryLock;

export async function tryAcquireChangeCoordinationLock(
  db: Db,
  changeObjectId: string
): Promise<ChangeCoordinationLock | undefined> {
  return tryAcquireAdvisoryLock(db, NAMESPACE, changeObjectId);
}
