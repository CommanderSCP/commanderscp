import type { CampaignStatus, ChangeState } from "@scp/schemas";

/**
 * Campaign/initiative status aggregation (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — PURE
 * functions, zero I/O, per BUILD_AND_TEST.md §4.1 ("anything testable as a pure function must be
 * written as a pure function") and §7's explicit M5 unit-test requirement ("status-aggregation
 * logic (pure, table-driven); initiative roll-up derivation (pure)").
 *
 * A campaign is deliberately NOT given its own transition-guarded state machine (see
 * `db/schema.ts`'s M5 section doc comment / `drizzle/0011_campaigns.sql`'s header) — its status is
 * always RE-DERIVED from its compiled plan's wave statuses and its member Changes' CURRENT states,
 * the same way an initiative's roll-up is derived from its member campaigns' statuses one level up
 * (DESIGN §9.5: "roll-up status derived by traversal... not stored/duplicated state" — applied
 * here to the campaign layer too, not just the initiative layer).
 */

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
}

export interface ComputeCampaignStatusInput {
  /** False before `coordination/campaign-reconcile.ts` has compiled+persisted this campaign's
   *  `campaign_plans` row at all. */
  hasPlan: boolean;
  waves: CampaignWaveStatusInput[];
}

/**
 * Derives a campaign's overall status from its waves + member-change states. Rollback is checked
 * FIRST and, if any target has been rolled back, wins over every forward-progress signal (a
 * rollback is deliberately visible in status even while an earlier wave is still `blocked` or
 * `failed` — DESIGN §9.4: rollback is "always available", independent of the campaign's own
 * forward state). Otherwise: `failed` > `blocked` > `completed` > `active`, in that priority —
 * matching the DoD's own scenario ("wave 1 promotes while wave 2 is blocked" — the campaign as a
 * whole reads `blocked`, the actionable fact, not `active`).
 */
export function computeCampaignStatus(input: ComputeCampaignStatusInput): CampaignStatus {
  if (!input.hasPlan || input.waves.length === 0) return "proposed";

  const allTargets = input.waves.flatMap((w) => w.targets);
  const rolledBackCount = allTargets.filter((t) => t.memberChangeState === "rolled_back").length;
  const stillPromotedCount = allTargets.filter((t) => t.memberChangeState === "promoted").length;
  if (rolledBackCount > 0) {
    return stillPromotedCount > 0 ? "partially_rolled_back" : "rolled_back";
  }

  if (input.waves.some((w) => w.waveStatus === "failed")) return "failed";
  if (input.waves.some((w) => w.waveStatus === "blocked")) return "blocked";
  if (input.waves.every((w) => w.waveStatus === "succeeded" || w.waveStatus === "skipped")) {
    return "completed";
  }
  return "active";
}

/**
 * Priority order for initiative roll-up (DESIGN §9.5) — the first tier with at least one member
 * campaign wins. Most-actionable-first: an operator scanning initiatives wants to see "something
 * needs me" (`blocked`/`failed`) before "some work is still in flight" (`active`/`proposed`)
 * before "nothing left to do" (`completed`/`rolled_back`).
 */
const ROLLUP_PRIORITY: readonly CampaignStatus[] = [
  "blocked",
  "failed",
  "partially_rolled_back",
  "active",
  "proposed",
  "rolled_back",
  "completed"
];

/** Derives an initiative's roll-up status (DESIGN §9.5: "grouping campaigns with roll-up status
 *  derived by traversal") from its member campaigns' own derived statuses. An initiative with no
 *  member campaigns yet reads `proposed` (nothing started). */
export function computeInitiativeRollup(campaignStatuses: readonly CampaignStatus[]): CampaignStatus {
  if (campaignStatuses.length === 0) return "proposed";
  for (const tier of ROLLUP_PRIORITY) {
    if (campaignStatuses.includes(tier)) return tier;
  }
  /* istanbul ignore next -- ROLLUP_PRIORITY is exhaustive over CampaignStatus; unreachable. */
  return "active";
}
