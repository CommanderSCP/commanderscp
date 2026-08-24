import { describe, expect, it, vi } from "vitest";
import { AdoptionEvidenceSchema, CampaignDeadlineAdoptionSignalSchema } from "@scp/schemas";
import type { CampaignRecipe } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { CampaignAdoptionResult } from "./campaign-adoption.js";

/**
 * ================================================================================================
 * M25.6a — THE PARTS OF THE DEADLINE PREDICATE THAT NEED NO DATABASE
 * ================================================================================================
 *
 *  1. `resolveCampaignDeadline` — every outcome, including the two that must NOT be reported as
 *     "no deadline": a document the strict schema refuses, and one whose `at` passes the ISO FORMAT
 *     check but is not an instant any clock can hold.
 *  2. NOT DUE => INERT, proven twice over: the transaction handed in is a Proxy that throws on any
 *     property access, AND the one resolution core is a recorder asserted to have been called ZERO
 *     times. The second is the one that actually bites, because every query this predicate can make
 *     goes through that function — so "the core was not called" IS "zero further queries", and
 *     deleting the early return turns the call count into 1.
 *  3. The DUE branches: `adopted` is the only exit; `not_adopted` and `unknown` both lock, and the
 *     two are recorded distinctly rather than collapsed.
 *  4. `describeLockedTargets`'s sort, against a deliberately DESCENDING input.
 *  5. The census pin between this feature's declared-signal vocabulary and `AdoptionEvidenceSchema`'s
 *     discriminator, so a fourth evidence kind cannot land on only one of them.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE ONE RESOLUTION CORE IS STUBBED HERE, AND WHAT STOPS THAT HIDING ANYTHING
 * ------------------------------------------------------------------------------------------------
 * `evaluateCampaignAdoption` reads three real tables and cannot produce `adopted` without a
 * database; the repo's rule is that a DB-reading predicate is exercised against real PostgreSQL and
 * never a mocked one. So what is stubbed here is a SIBLING MODULE, not a database — this file tests
 * the deadline predicate's own branch logic and nothing else.
 *
 * The thing that keeps that honest is `campaign-deadline.integration.test.ts`, which drives THIS
 * predicate over the REAL core against real PostgreSQL for all three verdicts (a component at 3.12
 * is `adopted` and not locked; one at 2.7 is `not_adopted` and locked; one never ingested is
 * `unknown` and locked). A stub that answered differently from the core would be caught there.
 */

/** Hoisted above the `vi.mock` factory below — a module-scope `const` would be in its temporal dead
 *  zone when the factory runs during import. */
const { adoptionCore } = vi.hoisted(() => ({
  adoptionCore: vi.fn<(...args: unknown[]) => Promise<CampaignAdoptionResult>>()
}));

vi.mock("./campaign-adoption.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./campaign-adoption.js")>();
  return { ...actual, evaluateCampaignAdoption: adoptionCore };
});

const {
  CAMPAIGN_DEADLINE_DECISION_KIND,
  CAMPAIGN_DEADLINE_SET_DECISION_KIND,
  describeLockedTargets,
  evaluateCampaignDeadlineLock,
  resolveCampaignDeadline
} = await import("./campaign-deadline-lock.js");

/** A `TenantTx` that cannot be used. The deadline predicate never reads through it directly — every
 *  read it can make goes through the one resolution core — so this catches a FUTURE edit that adds
 *  one, which would silently cost a query per candidate per tick on a 1 s loop. */
const FORBIDDEN_TX = new Proxy({} as object, {
  get(_target, property) {
    throw new Error(
      `the deadline predicate touched the transaction (.${String(property)}) directly. Every read ` +
        `it makes must go through evaluateCampaignAdoption — the ONE resolution core.`
    );
  }
}) as TenantTx;

const ORG_ID = "00000000-0000-4000-8000-000000000000";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_A = "22222222-2222-4222-8222-222222222222";
const TARGET_B = "33333333-3333-4333-8333-333333333333";

const DEADLINE_AT = "2026-12-31T23:59:59.000Z";
const DEADLINE = { at: DEADLINE_AT } as const;
const AT = new Date(DEADLINE_AT);

const DEPENDENCY_RECIPE: CampaignRecipe = {
  version: 1,
  trigger: { kind: "sync" },
  adoption: {
    kind: "dependency",
    ecosystem: "oci",
    coordinate: "docker.io/library/python",
    minVersion: "3.0"
  }
};

function adoption(verdict: CampaignAdoptionResult["verdict"]): CampaignAdoptionResult {
  return {
    verdict,
    evidence: null,
    inputContext: {},
    summary: `stubbed verdict: ${verdict}`,
    observations: []
  };
}

function evaluate(now: Date, targetObjectIds: string[] = [TARGET_A]) {
  return evaluateCampaignDeadlineLock(FORBIDDEN_TX, {
    orgId: ORG_ID,
    campaignObjectId: CAMPAIGN_ID,
    targetObjectIds,
    deadline: DEADLINE,
    at: AT,
    // A recipe that DECLARES adoption, deliberately: with `undefined` the core would be inert of its
    // own accord and the not-due case below would pass for the wrong reason.
    recipe: DEPENDENCY_RECIPE,
    now
  });
}

describe("resolveCampaignDeadline — a refusal is never an absence", () => {
  it("reports `none` for a campaign that declares no deadline, without parsing anything", () => {
    expect(resolveCampaignDeadline(null).outcome).toBe("none");
    expect(resolveCampaignDeadline(undefined).outcome).toBe("none");
    expect(resolveCampaignDeadline({ targets: [TARGET_A] }).outcome).toBe("none");
    expect(resolveCampaignDeadline({ deadline: null }).outcome).toBe("none");
  });

  it("parses a valid document and hands back the instant beside it", () => {
    const resolved = resolveCampaignDeadline({
      deadline: { at: DEADLINE_AT, adoptionSignal: "dependency" }
    });
    expect(resolved.outcome).toBe("deadline");
    if (resolved.outcome !== "deadline") throw new Error("unreachable");
    expect(resolved.deadline.at).toBe(DEADLINE_AT);
    expect(resolved.deadline.adoptionSignal).toBe("dependency");
    expect(resolved.at.toISOString()).toBe(DEADLINE_AT);
  });

  it("refuses an unknown key — the schema is STRICT at the door", () => {
    const resolved = resolveCampaignDeadline({ deadline: { at: DEADLINE_AT, until: "whenever" } });
    expect(resolved.outcome).toBe("malformed");
  });

  /**
   * §4.1's `overrides[]` is M25.6b. Until its authoring door and its `campaign:deadline-override`
   * permission exist, a document carrying one is refused rather than silently accepted and ignored —
   * an accepted-but-unread waiver list is an unauthenticated waiver channel that LOOKS enforced.
   */
  it("refuses an `overrides` array — that is M25.6b and there is no writer for it yet", () => {
    const resolved = resolveCampaignDeadline({
      deadline: { at: DEADLINE_AT, overrides: [{ targetObjectId: TARGET_A, reason: "later" }] }
    });
    expect(resolved.outcome).toBe("malformed");
  });

  /**
   * A DEADLINE THAT COULD NEVER COME DUE IS REFUSED AT THE PARSE, whichever bar catches it.
   *
   * MEASURED, and recorded because it decides which of the two bars is load-bearing: this repo's
   * zod validates the CALENDAR, not merely the shape — month 13, 30 February, 31 April, day 32 and
   * leap-second 23:59:60 are all refused by `z.string().datetime()` itself. So
   * `resolveCampaignDeadline`'s own `Invalid Date` guard is a SECOND bar that nothing reaches today.
   * It is asserted here as an OUTCOME ("this never becomes a live deadline") rather than as a claim
   * about which line did the refusing, so the case keeps its meaning if the wire schema is ever
   * loosened toward the bare string §4.1's federation argument pushes for.
   */
  it("refuses every instant no clock can hold, so a deadline can never silently fail to come due", () => {
    for (const at of [
      "2026-13-01T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-04-31T00:00:00.000Z",
      "2026-01-32T00:00:00.000Z",
      "2026-12-31T23:59:60.000Z"
    ]) {
      expect(resolveCampaignDeadline({ deadline: { at } }).outcome, at).toBe("malformed");
    }
  });

  it("names four distinct decision kinds so no two writers about a campaign can alternate", () => {
    // `insertDecisionIfChanged` dedupes against the LATEST row of a `(subject_id, kind)` pair, and
    // the wave gate, the freeze hold, the adoption shortcut, the lock and the authoring act all
    // write about the SAME subject. Any two sharing a kind is ADR-0024's 1.44 GB/day flood.
    const kinds = new Set([
      "gate",
      "freeze_admission",
      "campaign_adoption",
      CAMPAIGN_DEADLINE_DECISION_KIND,
      CAMPAIGN_DEADLINE_SET_DECISION_KIND
    ]);
    expect(kinds.size).toBe(5);
  });
});

describe("evaluateCampaignDeadlineLock — the predicate", () => {
  /**
   * NOT DUE => INERT, and the assertion that makes it non-vacuous is the CALL COUNT. Every read this
   * predicate can make goes through the one resolution core, so "the core was not called" is exactly
   * "zero further queries". Deleting the `now <= at` early return makes this call count 1.
   */
  it("is INERT before the deadline: no lock, and the resolution core is not called ONCE", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));

    const result = await evaluate(new Date(AT.getTime() - 60_000));

    expect(result.locked).toEqual([]);
    expect(adoptionCore).toHaveBeenCalledTimes(0);
  });

  /**
   * THE BOUNDARY, IN BOTH DIRECTIONS. `<=`, not `<`: the deadline instant itself is still inside the
   * window the author granted. An off-by-one here locks a fleet a millisecond early and nothing in
   * the record would say so.
   */
  it("treats the deadline INSTANT as still inside the window, and one millisecond later as past it", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));

    expect((await evaluate(new Date(AT.getTime()))).locked).toEqual([]);
    expect(adoptionCore).toHaveBeenCalledTimes(0);

    const past = await evaluate(new Date(AT.getTime() + 1));
    expect(past.locked).toHaveLength(1);
    expect(past.locked[0]!.targetObjectId).toBe(TARGET_A);
  });

  it("does NOT lock an adopted target — `adopted` is the only exit", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("adopted"));

    const result = await evaluate(new Date(AT.getTime() + 60_000));

    expect(result.locked).toEqual([]);
    // ...and it genuinely asked, rather than short-circuiting past the deadline.
    expect(adoptionCore).toHaveBeenCalledTimes(1);
  });

  /**
   * BOTH ABSENCES LOCK, AND THEY ARE RECORDED DISTINCTLY. `not_adopted` ("we looked, it is a
   * laggard") and `unknown` ("the named evidence source had nothing to say") are different facts
   * with different remedies — migrate it, versus wire up the evidence source. Collapsing them to a
   * boolean would reproduce, inside this feature's own permanent record, the conflation
   * `campaign-adoption.ts` exists to refuse.
   */
  it("locks on `not_adopted` AND on `unknown`, recording which", async () => {
    adoptionCore.mockClear();
    adoptionCore
      .mockResolvedValueOnce(adoption("not_adopted"))
      .mockResolvedValueOnce(adoption("unknown"));

    const result = await evaluate(new Date(AT.getTime() + 60_000), [TARGET_A, TARGET_B]);

    expect(result.locked.map((l) => [l.targetObjectId, l.adoptionVerdict])).toEqual([
      [TARGET_A, "not_adopted"],
      [TARGET_B, "unknown"]
    ]);
  });

  it("asks for nothing when there are no candidates", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));

    expect((await evaluate(new Date(AT.getTime() + 60_000), [])).locked).toEqual([]);
    expect(adoptionCore).toHaveBeenCalledTimes(0);
  });
});

/**
 * THE SORT, AGAINST A DELIBERATELY DESCENDING INPUT — `describeHeldTargets`'s own test's reason,
 * unchanged: the integration fixture cannot perturb the loop's input order on demand (a wave's
 * targets are created monotonically, so loop order and id order coincide), and a sort tested only
 * against already-sorted input is not tested.
 *
 * It is load-bearing because this array goes verbatim into a Decision's `inputContext` and
 * `restatesDecision` canonicalizes object KEYS while deliberately preserving array ORDER. An
 * unstable `locked[]` is one new Decision row per second for the life of the campaign.
 */
describe("describeLockedTargets", () => {
  it("sorts by targetObjectId and carries ids and verdicts only — nothing clock-shaped", () => {
    const record = describeLockedTargets([
      { targetObjectId: TARGET_B, adoptionVerdict: "unknown", summary: "b" },
      { targetObjectId: TARGET_A, adoptionVerdict: "not_adopted", summary: "a" }
    ]);

    expect(record).toEqual([
      { targetObjectId: TARGET_A, adoptionVerdict: "not_adopted" },
      { targetObjectId: TARGET_B, adoptionVerdict: "unknown" }
    ]);
    // AN EXACT KEY CENSUS, not "does not contain `now`": a census fails when a NEW clock-shaped key
    // is added, which is how this defect actually arrives (ADR-0024's measured 1.44 GB/day).
    expect(Object.keys(record[0]!).sort()).toEqual(["adoptionVerdict", "targetObjectId"]);
  });
});

/**
 * THE CENSUS PIN. `CampaignDeadlineAdoptionSignalSchema` is declarative — it names WHICH evidence
 * kind a deadline was authored against, and the verdict always comes from the recipe's own
 * `adoption` document through the one core. But two vocabularies for one concept is how the two
 * drift, so a fourth evidence kind must not be able to land on only one of them: this asserts the
 * signal enum is exactly the evidence union's discriminator set, and fails the day either grows
 * without the other.
 */
describe("the declared-signal vocabulary IS the adoption evidence vocabulary", () => {
  it("has exactly the members AdoptionEvidenceSchema discriminates on", () => {
    const evidenceKinds = AdoptionEvidenceSchema.options
      .map((option) => option.shape.kind.value as string)
      .sort();
    expect([...CampaignDeadlineAdoptionSignalSchema.options].sort()).toEqual(evidenceKinds);
  });

  /** The proposal's §4.1 sketch predates M25.5 and spells the first value `campaign_target_succeeded`.
   *  The shipped name is `delivered`, chosen precisely to stop anyone reading it as "migrated". */
  it("spells the campaign's own signal `delivered`, never `campaign_target_succeeded`", () => {
    expect(CampaignDeadlineAdoptionSignalSchema.options).toContain("delivered");
    expect(CampaignDeadlineAdoptionSignalSchema.options).not.toContain("campaign_target_succeeded");
  });
});
