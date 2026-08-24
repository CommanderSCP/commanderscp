import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

/**
 * §4-A2 (multi-region-instance-resilience.md §7.1 item 2) — the campaign-reconcile equivalent of
 * `change-coordination-lock.ts`. The campaign tick runs on the SAME 1s reconcile loop as the change
 * path, and `boss.work()` / the reconcile timer make every worker replica a COMPETING CONSUMER, so
 * two replicas' overlapping ticks can both reach `campaign-reconcile.ts`'s `reconcileOneCampaign`
 * for the SAME campaign before either commits. Without a lock they BOTH see "no plan yet" and both
 * `compileAndPersistCampaignPlan` — a fully-persisted DUPLICATE set of `campaign_waves` /
 * `campaign_wave_targets` — and both admit waves, exactly the class of bug the change path's
 * coordination lock was added to close (never ported to campaigns until now: proposal §4-A2).
 *
 * THE FIX (mirrors the change path exactly): acquire this advisory lock, keyed by `campaignObjectId`,
 * BEFORE reading/compiling/reconciling anything — a losing concurrent tick backs off immediately
 * (a clean no-op, retried next tick) and never compiles a plan. And because the plan is re-read
 * INSIDE the lock, a plan another tick just compiled in the window between the candidate read and
 * this acquisition is seen, so no duplicate is ever compiled.
 *
 * See `advisory-lock.ts`'s module doc for the mechanism (session-scoped `pg_try_advisory_lock`,
 * non-blocking, auto-released on connection death or explicit release). A DISTINCT namespace from
 * the change lock so a change and a campaign that happen to hash to the same key never collide.
 */
const NAMESPACE = "campaign-coordinate";

export type CampaignCoordinationLock = AdvisoryLock;

export async function tryAcquireCampaignCoordinationLock(
  db: Db,
  campaignObjectId: string
): Promise<CampaignCoordinationLock | undefined> {
  return tryAcquireAdvisoryLock(db, NAMESPACE, campaignObjectId);
}
