import type { Db } from "../db/client.js";
import { tryAcquireAdvisoryLock, type AdvisoryLock } from "./advisory-lock.js";

/**
 * THE CAMPAIGN-SIDE HALF OF `change-coordination-lock.ts` — the SECOND place that module's property
 * lived, found by censusing the PROPERTY rather than by hitting the symptom (CLAUDE.md, "census by
 * property, not by symptom": the M8 hardening pass fixed the change-side plan-compilation race and
 * `campaign-reconcile.ts` was left with zero advisory-lock coverage of the byte-for-byte identical
 * read -> compile -> persist -> write-back sequence).
 *
 * ## What was unguarded
 *
 * `reconcileOneCampaign` opens with `getLatestCampaignPlan(...)` in its OWN transaction, and on
 * `null` compiles and persists a plan in a SECOND one. Nothing sat between those two transactions.
 * The Helm chart's default is `worker replicaCount=2` (and `reconcileOrgTick` calls
 * `reconcileCampaignsOrgTick` on every 1 s tick), so two overlapping ticks could both read `null`
 * and both reach `compileAndPersistCampaignPlan`.
 *
 * ## Why it is WORSE here than the change-side original, not merely equivalent
 *
 * The change side had a backstop it did not deserve: `transitionChange`'s row-level `FOR UPDATE` on
 * `evaluated -> coordinated` made the loser THROW, which is what surfaced the bug at all (as a
 * wrongful cancel — see `change-coordination-lock.ts`'s docblock). The campaign path has NO such
 * backstop anywhere:
 *
 *  - `campaign_plans` carries only `campaign_plans_org_campaign`, a plain btree INDEX
 *    (drizzle/0011_campaigns.sql:40). There is no unique constraint on `campaign_object_id`, so a
 *    concurrent duplicate INSERT is simply accepted.
 *  - A campaign has no transition-guarded state machine and no status column of its own
 *    (`campaign-status.ts`'s module doc), so there is no `FOR UPDATE`-protected row anywhere in the
 *    sequence to serialise on.
 *
 * Both losers therefore COMMIT: two `campaign_plans` rows plus two full sets of
 * `campaign_waves`/`campaign_wave_targets`, silently. `getLatestCampaignPlan` then serves whichever
 * one wins its `(created_at DESC, id DESC)` tiebreak and the other set is orphaned — with its own
 * wave targets, which is a second fan-out surface for the same targets. Nothing throws, nothing
 * logs, and nothing is left to detect it after the fact.
 *
 * NOTE WHAT DOES *NOT* HAPPEN, stated plainly rather than implied: the campaign path has NO
 * equivalent of the change side's catch-and-cancel fallback. Its compile `catch` writes a
 * `plan_diff` block Decision through `insertDecisionIfChanged` and returns — a campaign has no
 * `cancelled` state to be wrongfully moved to. So the wrongful-cancel half of the change-side bug
 * has no twin here; the duplicate-plan half does, in a strictly worse form.
 *
 * ## The fix — both halves, exactly as on the change side
 *
 * (a) The lock is acquired in `reconcileCampaignsOrgTick` BEFORE `reconcileOneCampaign` is entered,
 *     so a loser never calls `compileAndPersistCampaignPlan` — nor the wave gate, nor `proposeChange`,
 *     nor any wave/target terminalisation — at all. It backs off immediately, exactly like
 *     `triggerWaveTarget` backing off on a failed trigger claim.
 *
 * (b) INSIDE the lock, `reconcileOneCampaign` re-reads the campaign object FRESH and re-reads the
 *     latest plan FRESH before compiling. If another tick already compiled one (in the window
 *     between the batch read and this lock's acquisition, then released), the plan read returns a
 *     row and this tick takes the ordinary drive path — a clean no-op with respect to compilation,
 *     NOT a compile failure. Skipping (b) is what turned the change-side race into a wrongful
 *     cancel; here it would ALSO make a stale `properties` snapshot re-write the campaign's own
 *     object (the URN-normalisation `updateObject`), bumping its version and audit trail for a
 *     normalisation the winner already performed.
 *
 * The round-robin `updated_at` bump at the bottom of `reconcileCampaignsOrgTick` stays UNCONDITIONAL
 * and stays outside this lock, deliberately. It is a fairness write on a row this domain owns, its
 * requirement is "took its turn" and not "made progress", and `candidate-loop-registry.test.ts`
 * pins it at exactly one bump in that function. Making it conditional on holding the lock would
 * create a fresh re-serve-without-writing path in a `ORDER BY objects.updated_at ASC LIMIT 25` loop
 * — instance 4 of the starvation class, reopened.
 *
 * See `advisory-lock.ts`'s module doc for the mechanism (session-scoped `pg_try_advisory_lock`,
 * non-blocking, auto-released on connection death or explicit release), and note the distinct
 * NAMESPACE below: a campaign object id and a change object id are drawn from the same UUID space,
 * and a campaign must never share a lock key with a change.
 */

const NAMESPACE = "campaign-coordinate";

export type CampaignCoordinationLock = AdvisoryLock;

export async function tryAcquireCampaignCoordinationLock(
  db: Db,
  campaignObjectId: string
): Promise<CampaignCoordinationLock | undefined> {
  return tryAcquireAdvisoryLock(db, NAMESPACE, campaignObjectId);
}
