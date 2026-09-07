import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

/** THE CAMPAIGN-SIDE HALF OF `change-coordination-lock.ts`. See docs/coordination.md §78. */

const NAMESPACE = "campaign-coordinate";

export type CampaignCoordinationLock = AdvisoryLock;

export async function tryAcquireCampaignCoordinationLock(
  db: Db,
  campaignObjectId: string
): Promise<CampaignCoordinationLock | undefined> {
  return tryAcquireAdvisoryLock(db, NAMESPACE, campaignObjectId);
}
