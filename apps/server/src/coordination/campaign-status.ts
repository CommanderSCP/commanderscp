import type { CampaignStatus, ChangeState } from "@scp/schemas";

/** Campaign status aggregation. See docs/coordination.md §221. */

export interface CampaignWaveTargetStatusInput {
  targetObjectId: string;
  /** `null` = the campaign reconciler has not yet proposed this target's member Change (still
   *  waiting on an earlier wave, or this wave's own boundary gate hasn't allowed it through yet). */
  memberChangeState: ChangeState | null;
}

export interface CampaignWaveStatusInput {
  waveIndex: number;
  /** Mirrors `campaign_waves.status` (db/schema.ts) — 'blocked' is campaign-specific: set when
   *  this wave's boundary gate returned a "block" verdict (a policy/control did not pass). */
  waveStatus: "pending" | "blocked" | "running" | "succeeded" | "failed" | "skipped";
  targets: CampaignWaveTargetStatusInput[];
  /** How many of this wave's targets a freeze withholds. See docs/coordination.md §222. */
  frozenTargetCount?: number;
  /** How many of this wave's targets the deadline withholds. See docs/coordination.md §223. */
  deadlineLockedTargetCount?: number;
}

export interface ComputeCampaignStatusInput {
  /** False before `coordination/campaign-reconcile.ts` has compiled+persisted this campaign's
   *  `campaign_plans` row at all. */
  hasPlan: boolean;
  waves: CampaignWaveStatusInput[];
}

/** Derives a campaign's status, checking rollback first. See docs/coordination.md §224. */
export function computeCampaignStatus(input: ComputeCampaignStatusInput): CampaignStatus {
  if (!input.hasPlan || input.waves.length === 0) return "proposed";

  const allTargets = input.waves.flatMap((w) => w.targets);
  const rolledBackCount = allTargets.filter((t) => t.memberChangeState === "rolled_back").length;
  const stillAcceptedCount = allTargets.filter((t) => t.memberChangeState === "accepted").length;
  if (rolledBackCount > 0) {
    return stillAcceptedCount > 0 ? "partially_rolled_back" : "rolled_back";
  }

  if (input.waves.some((w) => w.waveStatus === "failed")) return "failed";
  // `blocked` covers both ways a wave stops for governance. See docs/coordination.md §225.
  if (
    input.waves.some(
      (w) =>
        w.waveStatus === "blocked" ||
        (w.frozenTargetCount ?? 0) > 0 ||
        (w.deadlineLockedTargetCount ?? 0) > 0
    )
  ) {
    return "blocked";
  }
  if (input.waves.every((w) => w.waveStatus === "succeeded" || w.waveStatus === "skipped")) {
    return "completed";
  }
  return "active";
}
