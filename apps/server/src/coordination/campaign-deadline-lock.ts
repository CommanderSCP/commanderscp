import {
  CAMPAIGN_DEADLINE_PROPERTY_KEY,
  CampaignDeadlineSchema,
  type CampaignAdoptionVerdict,
  type CampaignDeadline,
  type CampaignDeadlineOverride,
  type CampaignRecipe
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { describeRecipeIssues } from "./campaign-recipe.js";
import { evaluateCampaignAdoption } from "./campaign-adoption.js";

/** The deadline-triggered campaign lock, predicate half. See docs/coordination.md §96. */

/** `decisions.kind` for the lock. See docs/coordination.md §97. */
export const CAMPAIGN_DEADLINE_DECISION_KIND = "campaign_deadline";

/** `decisions.kind` for the AUTHORING act. See docs/coordination.md §98. */
export const CAMPAIGN_DEADLINE_SET_DECISION_KIND = "campaign_deadline_set";

/** A sixth decision kind, for minting a per-target waiver. See docs/coordination.md §99. */
export const CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND = "campaign_deadline_override";

/** The hash-chained audit action for "this campaign's deadline withheld its fan-out from targets".
 *  HIGH-SEVERITY and appended ONLY when `insertDecisionIfChanged` reports `created` — appending on
 *  a no-op tick would make the hash chain assert an occurrence that did not occur. */
export const CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION = "campaign.deadline.lock";

/** The hash-chained audit action for the authoring act. Its `reason` is the operator's own words and
 *  the Decision it cites carries the PREVIOUS value beside the new one — without that, "the deadline
 *  slipped four times" is unreconstructible from a chain of writes that each say only where it
 *  landed. */
export const CAMPAIGN_DEADLINE_SET_AUDIT_ACTION = "campaign.deadline.set";

/** The hash-chained audit action for a per-target waiver. See docs/coordination.md §100. */
export const CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION = "campaign.deadline.override";

export type CampaignDeadlineResolution =
  | { outcome: "none" }
  | { outcome: "deadline"; deadline: CampaignDeadline; at: Date }
  /** Present but unreadable. NOT "none" — see {@link resolveCampaignDeadline}. */
  | { outcome: "malformed"; detail: string };

/** Reads `properties.deadline` off a CAMPAIGN. See docs/coordination.md §101. */
export function resolveCampaignDeadline(
  properties: Record<string, unknown> | null | undefined
): CampaignDeadlineResolution {
  if (!properties) return { outcome: "none" };
  const raw = properties[CAMPAIGN_DEADLINE_PROPERTY_KEY];
  if (raw === undefined || raw === null) return { outcome: "none" };
  const parsed = CampaignDeadlineSchema.safeParse(raw);
  if (!parsed.success) {
    return { outcome: "malformed", detail: describeRecipeIssues(parsed.error.issues) };
  }
  const at = new Date(parsed.data.at);
  if (Number.isNaN(at.getTime())) {
    return {
      outcome: "malformed",
      detail: `at: '${parsed.data.at}' is not an instant any clock can hold`
    };
  }
  return { outcome: "deadline", deadline: parsed.data, at };
}

/** The waiver in force right now, expiring at read time. See docs/coordination.md §102. */
export function findEffectiveDeadlineOverride(
  deadline: CampaignDeadline,
  targetObjectId: string,
  now: Date
): CampaignDeadlineOverride | undefined {
  const overrides = deadline.overrides;
  if (overrides === undefined || overrides.length === 0) return undefined;
  return overrides.find(
    (override) =>
      override.targetObjectId === targetObjectId &&
      (override.until === undefined || Date.parse(override.until) >= now.getTime())
  );
}

/** One locked campaign wave target and why. Every field is an id or a small closed-vocabulary
 *  string — nothing derived from a clock — which is what lets the Decision this feeds dedup under
 *  the 1 s tick. */
export interface CampaignDeadlineLockVerdict {
  targetObjectId: string;
  /** The adoption verdict that failed to let this target out. See docs/coordination.md §103. */
  adoptionVerdict: CampaignAdoptionVerdict;
  /** One sentence from the adoption predicate naming what was (or was not) observed. Goes into the
   *  REASON TREE, never into `inputContext` — it is already stable and bounded, but the split keeps
   *  the machine-readable context to ids and the prose where an operator reads it, exactly as
   *  `freeze-hold.ts` splits `held[]` from `describeFreezeHold`. */
  summary: string;
}

export interface CampaignDeadlineLockResult {
  /** Every target the deadline withholds, in the order asked. See docs/coordination.md §104. */
  locked: CampaignDeadlineLockVerdict[];
}

/**
 * Which targets are withheld, and why `now` is required. See docs/coordination.md §105.
 * @param recipe the campaign's parsed recipe, or `undefined`. Passed in rather than re-read for the
 * reason `evaluateCampaignAdoption` states: the reconciler parses it once per campaign per tick,
 * and a caller that already refused a MALFORMED recipe must not silently get the absent-recipe
 * answer for it.
 */
export async function evaluateCampaignDeadlineLock(
  tx: TenantTx,
  input: {
    orgId: string;
    campaignObjectId: string;
    targetObjectIds: string[];
    deadline: CampaignDeadline;
    at: Date;
    recipe: CampaignRecipe | null | undefined;
    now: Date;
  }
): Promise<CampaignDeadlineLockResult> {
  // NOT DUE => INERT. See docs/coordination.md §106.
  if (input.now.getTime() <= input.at.getTime()) return { locked: [] };

  const locked: CampaignDeadlineLockVerdict[] = [];
  for (const targetObjectId of input.targetObjectIds) {
    // M25.6b — THE PER-TARGET WAIVER, CHECKED FIRST. See docs/coordination.md §107.
    if (findEffectiveDeadlineOverride(input.deadline, targetObjectId, input.now) !== undefined) {
      continue; // <- THE WAIVER
    }

    // THE ONE RESOLUTION CORE. See docs/coordination.md §108.
    const adoption = await evaluateCampaignAdoption(
      tx,
      input.orgId,
      input.campaignObjectId,
      targetObjectId,
      input.recipe
    );
    if (adoption.verdict === "adopted") continue;
    locked.push({
      targetObjectId,
      adoptionVerdict: adoption.verdict,
      summary: adoption.summary
    });
  }

  return { locked };
}

export interface LockedTargetRecord {
  targetObjectId: string;
  adoptionVerdict: CampaignAdoptionVerdict;
}

/** THE `locked` ARRAY OF THE DECISION. See docs/coordination.md §109. */
export function describeLockedTargets(locked: CampaignDeadlineLockVerdict[]): LockedTargetRecord[] {
  return [...locked]
    .sort((a, b) => a.targetObjectId.localeCompare(b.targetObjectId))
    .map((entry) => ({
      targetObjectId: entry.targetObjectId,
      adoptionVerdict: entry.adoptionVerdict
    }));
}

/** One line an operator can read, per locked target — the reason-tree half of the Decision. */
export function describeCampaignDeadlineLock(
  deadline: CampaignDeadline,
  verdict: CampaignDeadlineLockVerdict
): string {
  return (
    `target ${verdict.targetObjectId}: adoption is '${verdict.adoptionVerdict}' past the ` +
    `campaign's deadline of ${deadline.at} — this campaign proposes no further change for it. ` +
    `Unrelated releases, including security fixes, are unaffected. ${verdict.summary}`
  );
}
