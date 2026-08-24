import type { CampaignStatus, ChangeState } from "@scp/schemas";

/**
 * Campaign status aggregation (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — PURE
 * functions, zero I/O, per BUILD_AND_TEST.md §4.1 ("anything testable as a pure function must be
 * written as a pure function") and §7's explicit M5 unit-test requirement ("status-aggregation
 * logic (pure, table-driven)").
 *
 * A campaign is deliberately NOT given its own transition-guarded state machine (see
 * `db/schema.ts`'s M5 section doc comment / `drizzle/0011_campaigns.sql`'s header) — its status is
 * always RE-DERIVED from its compiled plan's wave statuses and its member Changes' CURRENT states,
 * (DESIGN §9.5: "roll-up status derived by traversal... not stored/duplicated state" — applied
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
  /** M25.2 — how many of this wave's targets an ACTIVE FREEZE is currently withholding from fan-out
   *  (`coordination/freeze-hold.ts`, re-evaluated at read time by `campaign-repo.ts`).
   *
   *  WHY IT IS A SEPARATE INPUT rather than something derivable from `waveStatus`: before per-target
   *  admission, a freeze over any campaign target produced a whole-wave `block` verdict, so
   *  `waveStatus` went `blocked` and this function reported `blocked` for free. M25.2 stands the
   *  gate aside for a PARTIALLY frozen wave — 39 of 40 components fan out and one is held — so the
   *  wave is `running` and the campaign would read as ordinarily `active` indefinitely, silently
   *  losing a status it used to report. That is a regression this increment introduces, not a
   *  pre-existing gap, so it is closed in the same increment (proposal §1.8). Optional and defaulted
   *  to 0 so every existing caller and table-driven case is unchanged. */
  frozenTargetCount?: number;
  /** M25.6a — how many of this wave's targets THIS CAMPAIGN'S OWN DEADLINE is currently withholding
   *  from fan-out (`coordination/campaign-deadline-lock.ts`, re-evaluated at read time by
   *  `campaign-repo.ts`).
   *
   *  A SEPARATE INPUT for the same reason `frozenTargetCount` is, and the defect it closes is named
   *  in the proposal (§4.6): `computeCampaignStatus` derives `blocked` only from
   *  `waveStatus === "blocked"`, which the deadline lock deliberately NEVER writes — the wave stays
   *  `running` so unlocked siblings keep shipping. Without this input a campaign whose deadline has
   *  locked out half its estate reads as ordinarily `active`, and the lever works while the signal
   *  is missing — the exact inverse of the postmortem that cost a previous proposal its approval.
   *
   *  It is a COUNT, re-derived at read time, and NEVER read off the standing Decision: a status
   *  derived from the Decision would keep saying `blocked` after the deadline was moved or the
   *  component migrated, which is the stale-hold defect `routes/changes.ts` documents against
   *  ADR-0028's `stage_dependency` row.
   *
   *  Optional and defaulted to 0, so every existing caller and table-driven case is unchanged. */
  deadlineLockedTargetCount?: number;
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
 * matching the DoD's own scenario ("wave 1 accepts while wave 2 is blocked" — the campaign as a
 * whole reads `blocked`, the actionable fact, not `active`).
 */
export function computeCampaignStatus(input: ComputeCampaignStatusInput): CampaignStatus {
  if (!input.hasPlan || input.waves.length === 0) return "proposed";

  const allTargets = input.waves.flatMap((w) => w.targets);
  const rolledBackCount = allTargets.filter((t) => t.memberChangeState === "rolled_back").length;
  const stillAcceptedCount = allTargets.filter((t) => t.memberChangeState === "accepted").length;
  if (rolledBackCount > 0) {
    return stillAcceptedCount > 0 ? "partially_rolled_back" : "rolled_back";
  }

  if (input.waves.some((w) => w.waveStatus === "failed")) return "failed";
  // `blocked` covers BOTH ways a campaign wave stops moving for a governance reason: the gate's own
  // `block` verdict (a policy or control did not pass), and M25.2's per-target freeze hold, which
  // deliberately leaves the wave `running` so its unfrozen siblings can proceed. Same tier, because
  // the operator-facing fact is the same one — something needs a human before this finishes.
  //
  // M25.6a adds a THIRD way into the same tier, and it reports the EXISTING `blocked` value rather
  // than a new enum member deliberately: `CampaignStatusSchema` is a RESPONSE enum, so widening it
  // is an oasdiff break with no upside — every consumer already renders `blocked`, and the detail an
  // operator needs ("which targets, and why") is on the campaign's `deadline` field and its
  // `campaign_deadline` Decision, not in a status string. The operator-facing fact is the same one
  // all three share: something needs a human before this campaign finishes.
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
