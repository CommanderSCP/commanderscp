import {
  CAMPAIGN_DEADLINE_PROPERTY_KEY,
  CampaignDeadlineSchema,
  type CampaignAdoptionVerdict,
  type CampaignDeadline,
  type CampaignRecipe
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { describeRecipeIssues } from "./campaign-recipe.js";
import { evaluateCampaignAdoption } from "./campaign-adoption.js";

/**
 * ================================================================================================
 * M25.6a — THE DEADLINE-TRIGGERED CAMPAIGN LOCK, PREDICATE HALF
 * ================================================================================================
 *
 * `docs/proposals/campaigns-rework.md` §4 is the design of record; owner decision D4 is the line
 * that shapes every one of them:
 *
 *   > The lock's radius is **the campaign's own targets**. An unmigrated component stops receiving
 *   > *that campaign's* changes; unrelated releases **including security fixes** keep flowing.
 *
 * It is NOT a freeze on the component and it is not implemented as one. Two routes were available
 * and both are refused by construction, not by convention — this module imports neither:
 *
 *   * NOT `checkFreeze`. Scope-based, campaign-blind, and all-or-nothing across the wave. A
 *     per-target deadline routed through it would re-lock the crux M25.2 just fixed, and it would
 *     stop the component's UNRELATED releases — the precise thing D4 says must keep flowing.
 *   * NOT `evaluateWaveGate`. One verdict for the union of a wave's targets, no target dimension,
 *     and it fires exactly once on `pending -> running` (`reconcile.ts:999-1006` already wrote both
 *     halves down). A deadline that passes mid-wave would never be seen at all.
 *
 * The seam that refuses is `campaign-reconcile.ts`'s per-target `pending` branch: it does not call
 * `proposeChange`. This module only READS — the same split `freeze-hold.ts` and
 * `stage-dependency-hold.ts` state for themselves (ADR-0028), and for the same reason: the
 * predicate is a read a test can drive directly, and the seam is three lines whose ordering
 * invariants are copied verbatim from the two seams already above it.
 *
 * ------------------------------------------------------------------------------------------------
 * CALL IT A TRIPWIRE, NOT A LOCK — §4.4, stated rather than sold
 * ------------------------------------------------------------------------------------------------
 * UNDER THE DEFAULT `delivered` SIGNAL THIS IS VERY NEARLY A NO-OP, and that must be documented
 * rather than oversold. A target is a lock candidate only while `pending`; `pending` means its
 * member Change was never proposed; so under `delivered` ("this campaign's own wave target is
 * `succeeded`") it can only ever be un-adopted. "Locked" degenerates to *"the campaign hasn't
 * reached you yet, and now it never will"* — self-defeating, since the campaign IS the migration.
 *
 * It acquires force in exactly two situations:
 *
 *   1. **Adoption observed OUTSIDE the campaign's own fan-out** — the `dependency` or `control`
 *      evidence kinds. A long-lived campaign then genuinely cuts a laggard out of a stream that was
 *      still flowing to everybody else.
 *   2. **The record is the product.** A Decision plus a hash-chained audit event making "component X
 *      missed campaign Y's deadline" a durable, signed, queryable fact. Even with the weak signal
 *      that is worth building; it is just not a lock.
 *
 * ------------------------------------------------------------------------------------------------
 * FAIL **OPEN** ON A MALFORMED BAG, LOUDLY — and the departure is deliberate
 * ------------------------------------------------------------------------------------------------
 * `stage-dependency-hold.ts` fails CLOSED on its `undeclarable` branch. This one does the opposite,
 * and the difference is what the two mechanisms ARE (§4.2): that one guards a SAFETY coupling, where
 * dropping the hold deploys a component ahead of a dependency it was declared to stand behind. A
 * deadline is a COERCION mechanism. Failing closed on it parks an entire campaign on a typo — every
 * target of a 47-component migration withheld because someone wrote `"at": "2026-13-01"` — and the
 * remedy would be invisible, because the document that cannot be read is also the document that
 * cannot explain itself. So a malformed bag locks NOTHING and the reconciler records one
 * `verdict: "warn"` Decision naming what did not parse.
 *
 * ------------------------------------------------------------------------------------------------
 * INERTNESS IS STRUCTURAL
 * ------------------------------------------------------------------------------------------------
 * `evaluateCampaignDeadlineLock` returns `{ locked: [] }` before touching `tx` when the deadline is
 * not yet due. That is the overwhelmingly common case for a campaign that has one at all, and it
 * runs inside a per-target loop on a 1 s tick AND inside `getCampaignStatus`, which itself runs
 * per-campaign inside `listCampaigns`'s already-N+1 loop. A campaign with NO deadline never reaches
 * this module: `resolveCampaignDeadline` answers `none` on a pure key-absence check.
 */

/**
 * `decisions.kind` for the lock. `kind` is unconstrained `text` and the read schemas are
 * `z.string()`, so this new value costs no migration (the proposal's data-model table records it
 * alongside `freeze_admission` and `campaign_adoption`).
 *
 * A DEDICATED KIND, for the reason `recordCampaignFreezeAdmissionHold` and
 * `CAMPAIGN_ADOPTION_DECISION_KIND` both record: `insertDecisionIfChanged` dedupes against the
 * LATEST row of a `(subject_id, kind)` pair, so two writers sharing a kind make their rows alternate
 * under one another and suppression never fires once — ADR-0024's measured 1.44 GB/day rebuilt from
 * parts. The campaign wave gate (`gate`), the freeze hold (`freeze_admission`), the adoption
 * shortcut (`campaign_adoption`) and this all write about the SAME subject, so all four kinds must
 * stay distinct.
 */
export const CAMPAIGN_DEADLINE_DECISION_KIND = "campaign_deadline";

/**
 * `decisions.kind` for the AUTHORING act — setting, moving or clearing the deadline.
 *
 * A FIFTH KIND, distinct from {@link CAMPAIGN_DEADLINE_DECISION_KIND}, on the `freeze_window`
 * precedent (M25.1 gave the freeze's own lift/window edits their own kind rather than reusing
 * `gate`). Sharing the lock's kind would interleave a human's one-per-API-call `allow` row with the
 * tick-driven `block` rows under the same `(subject_id, kind)` comparison: bounded rather than
 * catastrophic, because a human presses a button far less often than 86,400 times a day, but it
 * would still make every deadline edit cost an extra lock row on the next tick, and it would put
 * the authoring record and the enforcement record in one undifferentiated stream that
 * `scp campaign explain` cannot separate.
 */
export const CAMPAIGN_DEADLINE_SET_DECISION_KIND = "campaign_deadline_set";

/** The hash-chained audit action for "this campaign's deadline withheld its fan-out from targets".
 *  HIGH-SEVERITY and appended ONLY when `insertDecisionIfChanged` reports `created` — appending on
 *  a no-op tick would make the hash chain assert an occurrence that did not occur. */
export const CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION = "campaign.deadline.lock";

/** The hash-chained audit action for the authoring act. Its `reason` is the operator's own words and
 *  the Decision it cites carries the PREVIOUS value beside the new one — without that, "the deadline
 *  slipped four times" is unreconstructible from a chain of writes that each say only where it
 *  landed. */
export const CAMPAIGN_DEADLINE_SET_AUDIT_ACTION = "campaign.deadline.set";

export type CampaignDeadlineResolution =
  | { outcome: "none" }
  | { outcome: "deadline"; deadline: CampaignDeadline; at: Date }
  /** Present but unreadable. NOT "none" — see {@link resolveCampaignDeadline}. */
  | { outcome: "malformed"; detail: string };

/**
 * Reads `properties.deadline` off a CAMPAIGN.
 *
 * THREE OUTCOMES, NOT `CampaignDeadline | undefined`, and the third is the point. A document the
 * schema refuses is a REFUSAL, never an absence: degrading it to "no deadline" would make a typo
 * indistinguishable from a deliberate decision not to set one, in the one record the feature exists
 * to produce. It is reported so the reconciler can write a `warn` Decision naming it — the loud half
 * of "fail open, loudly".
 *
 * `at` IS PARSED HERE AND RETURNED BESIDE THE DOCUMENT, so exactly one place in this feature turns
 * an ISO string into an instant.
 *
 * THE `Invalid Date` GUARD BELOW IS A SECOND BAR AND IS UNREACHABLE TODAY — stated plainly rather
 * than left implying it catches something. MEASURED against this repo's zod at HEAD:
 * `z.string().datetime()` validates the CALENDAR, not merely the shape, and refuses `2026-13-01`,
 * `2026-02-30`, `2026-04-31`, `2026-01-32` and `23:59:60` alike. So nothing that parses can reach
 * `new Date` and come back `Invalid Date`. The guard stays because the failure it would catch is
 * silent and total — every comparison against `Invalid Date` is `false`, so the deadline would
 * simply never come due, with no lock, no warn and nothing in the record to look at — and because
 * §4.1's whole federation-wedge argument pushes this field's REGISTRY type toward a bare string. If
 * the wire schema is ever loosened to match, this line is what stops that from becoming a deadline
 * that quietly does nothing.
 *
 * The doors this can arrive through unvalidated are the two the authoring schema deliberately does
 * not cover — IaC apply and federation import, both of which reach `campaign.properties` without
 * passing through a typed route (`campaign-recipe-guard.ts` records the same census). Refusing them
 * at the write door would wedge a peer's whole signed bundle on a key an older receiver has never
 * heard of; refusing them HERE costs one `warn` row and nothing else.
 */
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

/** One locked campaign wave target and why. Every field is an id or a small closed-vocabulary
 *  string — nothing derived from a clock — which is what lets the Decision this feeds dedup under
 *  the 1 s tick. */
export interface CampaignDeadlineLockVerdict {
  targetObjectId: string;
  /**
   * The adoption verdict that failed to let this target out: `not_adopted` (observed a laggard) or
   * `unknown` (the named evidence source had nothing to say, or the recipe named none).
   *
   * RECORDED RATHER THAN COLLAPSED TO A BOOLEAN, because the two are different facts and the
   * operator-facing remedy differs: `not_adopted` says migrate it, `unknown` says the platform
   * cannot see whether you did — wire the evidence source. Collapsing them would reproduce, inside
   * this feature's own record, exactly the conflation `campaign-adoption.ts` exists to refuse.
   */
  adoptionVerdict: CampaignAdoptionVerdict;
  /** One sentence from the adoption predicate naming what was (or was not) observed. Goes into the
   *  REASON TREE, never into `inputContext` — it is already stable and bounded, but the split keeps
   *  the machine-readable context to ids and the prose where an operator reads it, exactly as
   *  `freeze-hold.ts` splits `held[]` from `describeFreezeHold`. */
  summary: string;
}

export interface CampaignDeadlineLockResult {
  /** Every target this campaign's deadline is withholding fan-out from, in the order they were
   *  asked about. The ordering rule that matters lives at {@link describeLockedTargets}, which is
   *  the one thing that feeds a permanent record — the same split `freeze-hold.ts` uses
   *  (`evaluateFreezeHolds` returns a Map; `describeHeldTargets` is where the sort is, and where its
   *  own unit test drives a deliberately descending list). */
  locked: CampaignDeadlineLockVerdict[];
}

/**
 * WHICH OF `targetObjectIds` THIS CAMPAIGN'S DEADLINE IS WITHHOLDING FAN-OUT FROM.
 *
 * `now` IS REQUIRED, not optional, and that is a departure from `evaluateFreezeHolds` /
 * `stage-dependency-hold.ts` / `watchdog.ts`, which all default it. Those resolve a clock per call
 * because each call answers about one change. This one is called once per target inside a loop
 * over a BATCH of campaigns, and the batch must agree with itself: two campaigns straddling the same
 * deadline instant, evaluated 40 ms apart inside one tick, must not disagree about whether it has
 * passed. `reconcileCampaignsOrgTick` resolves the instant ONCE for the whole batch and threads it
 * down; making the parameter required is what stops a future call site from quietly re-reading the
 * clock here and reintroducing the disagreement.
 *
 * @param recipe the campaign's parsed recipe, or `undefined`. Passed in rather than re-read for the
 *   reason `evaluateCampaignAdoption` states: the reconciler parses it once per campaign per tick,
 *   and a caller that already refused a MALFORMED recipe must not silently get the absent-recipe
 *   answer for it.
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
  // ============================================================================================
  // NOT DUE => INERT. `tx` IS UNTOUCHED ON THIS PATH.
  // ============================================================================================
  // `<=`, not `<`: the deadline instant itself is still inside the window an author was given. The
  // boundary is exercised in `campaign-deadline-lock.test.ts` in both directions, because an
  // off-by-one here locks a fleet a second early and nothing in the record would say so.
  if (input.now.getTime() <= input.at.getTime()) return { locked: [] };

  const locked: CampaignDeadlineLockVerdict[] = [];
  for (const targetObjectId of input.targetObjectIds) {
    // ==========================================================================================
    // THE ONE RESOLUTION CORE. `evaluateCampaignAdoption` AND NOTHING ELSE (§3.4 consumer 4).
    // ==========================================================================================
    // A second implementation of "has this component migrated?" is how two surfaces come to
    // disagree about whether a component is compliant — and here the disagreement would be between
    // a page saying "adopted" and a hash-chained audit event asserting the component missed a
    // deadline. There is exactly one.
    //
    // ONLY `adopted` IS AN EXIT. `not_adopted` and `unknown` are different facts and BOTH keep the
    // target locked — R3 ("silence is never a pass") in its operational form. The asymmetry is the
    // whole safety property of the pair: an `unknown` costs a component staying in a campaign it
    // may already have left, while an `adopted` conjured out of an absent fact would waive a
    // governance deadline nobody observed being met.
    //
    // NOT MEMOISED, deliberately, and this is the M22.0a lesson rather than an oversight: each
    // `(campaign, target)` is asked exactly once per tick by the reconciler's loop and once per
    // request by the read surface, so a cache would buy nothing and would introduce the one thing
    // that failure was made of — a key coarser than the question.
    //
    // WORTH STATING PLAINLY: from the RECONCILER this call is very nearly always redundant, and the
    // redundancy is the price of the seam being correct in isolation. When the recipe declares
    // adoption, M25.5's seam sits directly above this one and has already terminalized every
    // `adopted` target, so only non-adopted targets ever arrive here; when it declares none, this
    // call returns `unknown` before issuing a single query. The branch is not dead — the read
    // surface and the unit tests reach it, and the day the two seams are ever reordered it is the
    // only thing standing between an adopted component and a signed record saying it missed a
    // deadline — but nobody should expect to see it fire from the tick.
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

/** One entry of a `campaign_deadline` Decision's `inputContext.locked`. */
export interface LockedTargetRecord {
  targetObjectId: string;
  adoptionVerdict: CampaignAdoptionVerdict;
}

/**
 * THE `locked` ARRAY OF THE DECISION — ids and verdicts only, SORTED, and the sort is the point.
 *
 * `insertDecisionIfChanged` compares a candidate against the latest row of the same
 * `(subject_id, kind)`, and `restatesDecision` canonicalizes object KEYS while deliberately
 * preserving array ORDER ("a reordered array is a genuinely different input set and MUST write a new
 * row"). The order this receives is the order the reconciler's per-target loop pushed, which comes
 * from `loadWavesWithTargets`'s `ORDER BY created_at` with NO TIEBREAK over rows that all carry the
 * same transaction timestamp on a table those rows are UPDATEd in every tick. So the input order is
 * genuinely not stable, and an unstable `locked[]` is one new Decision row per second for the whole
 * life of the campaign — ADR-0024's measured 1.44 GB/day rebuilt from parts.
 *
 * NOTHING CLOCK-SHAPED, AND THE BAN IS BY NAME: `now`, `evaluatedAt`, `overdueMs`, `daysLate`,
 * `lockedSince`, any remaining-TTL. The only clock-shaped value the whole `inputContext` may carry
 * is `deadline.at`, which is a stored BOUNDARY rather than a reading of the clock — the
 * `gate-orchestrator.ts` freeze trick, copied exactly. That single distinction is what makes a
 * six-month lock ONE Decision row instead of 15.7 million.
 *
 * A SEPARATE EXPORTED FUNCTION, exactly like `describeHeldTargets`, because the integration fixture
 * cannot perturb the input order on demand (a wave's targets are created monotonically, so loop
 * order and id order coincide) — and a sort tested only against input that is already sorted is not
 * tested. Its unit test hands it a deliberately descending list.
 */
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
