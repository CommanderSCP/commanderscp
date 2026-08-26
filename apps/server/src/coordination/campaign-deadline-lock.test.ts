import { describe, expect, it, vi } from "vitest";
import {
  AdoptionEvidenceSchema,
  CampaignDeadlineAdoptionSignalSchema,
  CampaignDeadlineInputSchema,
  CampaignDeadlineSchema
} from "@scp/schemas";
import type { CampaignDeadline, CampaignRecipe } from "@scp/schemas";
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
  CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND,
  CAMPAIGN_DEADLINE_SET_DECISION_KIND,
  describeLockedTargets,
  evaluateCampaignDeadlineLock,
  findEffectiveDeadlineOverride,
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
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

const DEADLINE_AT = "2026-12-31T23:59:59.000Z";
const DEADLINE = { at: DEADLINE_AT } as const;
const AT = new Date(DEADLINE_AT);

/** One stored waiver, as `POST /campaigns/{id}/deadline-override` writes it. */
function waiver(targetObjectId: string, until?: string) {
  return {
    targetObjectId,
    reason: "the vendor image is not out yet",
    actorId: ACTOR_ID,
    at: "2026-06-01T00:00:00.000Z",
    ...(until !== undefined ? { until } : {})
  };
}

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
   * §4.1's `overrides[]` — M25.6a REFUSED this key outright, and this case is the same case flipped
   * rather than a new one, because what changed is a fact about the system rather than about the
   * test: THERE IS NOW A WRITER. `POST /campaigns/{id}/deadline-override` mints entries behind the
   * Owner-only `campaign:deadline-override` (drizzle/0088) checked at the campaign plus
   * `object:write` at each named target, so an `overrides` array on a stored document is now an
   * AUTHORIZED artefact rather than an unauthenticated waiver channel sitting in the schema.
   *
   * THE MEMBERS ARE STILL STRICT, and that half is asserted directly below rather than assumed. The
   * accepted-but-unread hazard M25.6a named did not go away; it moved down one level. A waiver whose
   * unknown key was silently dropped would be a document an operator believes says one thing while
   * the predicate reads another — and this document is the input to a governance record.
   */
  it("accepts an `overrides` array now that M25.6b has a writer for it", () => {
    const resolved = resolveCampaignDeadline({
      deadline: {
        at: DEADLINE_AT,
        overrides: [
          {
            targetObjectId: TARGET_A,
            reason: "the vendor image is not out yet",
            actorId: ACTOR_ID,
            at: "2026-06-01T00:00:00.000Z"
          }
        ]
      }
    });
    expect(resolved.outcome).toBe("deadline");
    if (resolved.outcome !== "deadline") throw new Error("unreachable");
    expect(resolved.deadline.overrides).toHaveLength(1);
    expect(resolved.deadline.overrides![0]!.targetObjectId).toBe(TARGET_A);
  });

  it("still refuses a MEMBER of `overrides` that is short a field or carries an unknown one", () => {
    const complete = {
      targetObjectId: TARGET_A,
      reason: "the vendor image is not out yet",
      actorId: ACTOR_ID,
      at: "2026-06-01T00:00:00.000Z"
    };
    // The M25.6a shape — `{targetObjectId, reason}` alone — is now missing `actorId`/`at`, the two
    // fields that make the stored waiver say WHO excused this target and WHEN.
    const cases: Record<string, unknown>[] = [
      { targetObjectId: TARGET_A, reason: "later" },
      { ...complete, actorId: undefined },
      { ...complete, at: undefined },
      { ...complete, reason: "" },
      { ...complete, until: "next Tuesday" },
      { ...complete, forever: true }
    ];
    for (const override of cases) {
      expect(
        resolveCampaignDeadline({ deadline: { at: DEADLINE_AT, overrides: [override] } }).outcome,
        JSON.stringify(override)
      ).toBe("malformed");
    }
  });

  /**
   * THE AUTHORING DOORS CANNOT MINT ONE. `POST /campaigns` runs at plain `object:write`, always — a
   * create is always a FIRST set. `POST /campaigns/{id}/deadline` runs at plain `object:write` for a
   * first set or a SHORTENING, and adds the Owner-only `campaign:deadline-override` only on its
   * widening acts (a clear, or a move to a later instant — owner ruling 2026-08-25, D1 b-i). The
   * waiver ALWAYS takes `campaign:deadline-override` at the campaign, and — the part neither
   * authoring door pays at any price — `object:write` AT EACH NAMED TARGET, plus a per-target audit
   * event. So if the two shared one schema, `POST /campaigns` would be the expensive permission's
   * outright bypass and the deadline route would be its bypass for the per-target bar even where the
   * permissions coincide. The split is the authority check and this is what holds it in place — a
   * 400 at the door, never a key silently dropped.
   */
  it("the AUTHORING schema omits `overrides` entirely — the cheap door cannot mint a waiver", () => {
    expect("overrides" in CampaignDeadlineSchema.shape).toBe(true);
    expect("overrides" in CampaignDeadlineInputSchema.shape).toBe(false);
    const attempt = CampaignDeadlineInputSchema.safeParse({
      at: DEADLINE_AT,
      overrides: [
        {
          targetObjectId: TARGET_A,
          reason: "let me out",
          actorId: ACTOR_ID,
          at: "2026-06-01T00:00:00.000Z"
        }
      ]
    });
    expect(attempt.success).toBe(false);
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

  it("names six distinct decision kinds so no two writers about a campaign can alternate", () => {
    // `insertDecisionIfChanged` dedupes against the LATEST row of a `(subject_id, kind)` pair, and
    // the wave gate, the freeze hold, the adoption shortcut, the lock, the authoring act and
    // M25.6b's waiver all write about the SAME subject — a campaign object. Any two sharing a kind
    // is ADR-0024's 1.44 GB/day flood: a human `allow` row interleaving with the tick's `block`
    // rows means suppression never fires once.
    const kinds = new Set([
      "gate",
      "freeze_admission",
      "campaign_adoption",
      CAMPAIGN_DEADLINE_DECISION_KIND,
      CAMPAIGN_DEADLINE_SET_DECISION_KIND,
      CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND
    ]);
    expect(kinds.size).toBe(6);
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
 * ================================================================================================
 * M25.6b — THE PER-TARGET WAIVER, INSIDE THE SAME PREDICATE
 * ================================================================================================
 */
describe("evaluateCampaignDeadlineLock — the M25.6b override branch", () => {
  function evaluateWith(
    deadline: CampaignDeadline,
    now: Date,
    targetObjectIds: string[] = [TARGET_A]
  ) {
    return evaluateCampaignDeadlineLock(FORBIDDEN_TX, {
      orgId: ORG_ID,
      campaignObjectId: CAMPAIGN_ID,
      targetObjectIds,
      deadline,
      at: AT,
      recipe: DEPENDENCY_RECIPE,
      now
    });
  }

  /**
   * THE WAIVER EXITS BEFORE THE RESOLUTION CORE IS ASKED — §4.2's "cheapest first", asserted by CALL
   * COUNT rather than by reading the source. That is the same non-vacuity trick the not-due case
   * uses: every query this predicate can make goes through `evaluateCampaignAdoption`, so "the core
   * was not called" IS "this cost no evidence query". Moving the override check BELOW the adoption
   * call leaves `locked` correct and turns this count into 1.
   */
  it("a live waiver excuses the target AND costs no evidence query — the core is not called ONCE", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));

    const result = await evaluateWith(
      { at: DEADLINE_AT, overrides: [waiver(TARGET_A)] },
      new Date(AT.getTime() + 60_000)
    );

    expect(result.locked).toEqual([]);
    expect(adoptionCore).toHaveBeenCalledTimes(0);
  });

  /**
   * THE WAIVER IS PER TARGET, not per campaign — the whole reason this exists rather than
   * `deadline --clear`. B is excused; A is not, and A is still asked about.
   */
  it("waives only the named target — its unoverridden sibling stays locked", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));

    const result = await evaluateWith(
      { at: DEADLINE_AT, overrides: [waiver(TARGET_B)] },
      new Date(AT.getTime() + 60_000),
      [TARGET_A, TARGET_B]
    );

    expect(result.locked.map((l) => l.targetObjectId)).toEqual([TARGET_A]);
    expect(adoptionCore).toHaveBeenCalledTimes(1);
  });

  /**
   * READ-TIME EXPIRY, WHICH IS THE WHOLE DESIGN. `until` is a stored BOUNDARY compared against the
   * caller's `now` on every evaluation; there is no job, nothing to un-flip, and an `until` in the
   * past is simply not effective. The two rows here are one document read at two instants — which is
   * exactly how production sees it, since nothing rewrites the waiver as it lapses.
   */
  it("an `until` in the PAST is not effective — the target is locked again, with no job to run", async () => {
    const past = new Date(AT.getTime() + 60_000);
    const deadline: CampaignDeadline = {
      at: DEADLINE_AT,
      // Expires 30 s after the deadline; `past` above is 60 s after it.
      overrides: [waiver(TARGET_A, new Date(AT.getTime() + 30_000).toISOString())]
    };

    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));
    const lapsed = await evaluateWith(deadline, past);
    expect(lapsed.locked.map((l) => l.targetObjectId)).toEqual([TARGET_A]);

    // ...and the SAME document, read one instant before its own expiry, still waives.
    adoptionCore.mockClear();
    const live = await evaluateWith(deadline, new Date(AT.getTime() + 20_000));
    expect(live.locked).toEqual([]);
    expect(adoptionCore).toHaveBeenCalledTimes(0);
  });
});

/**
 * `findEffectiveDeadlineOverride` — the boundary and the unreadable case, driven directly because
 * neither is reachable through the predicate without a second document.
 */
describe("findEffectiveDeadlineOverride", () => {
  const NOW = new Date("2027-01-01T00:00:00.000Z");

  it("treats the `until` INSTANT as still inside the waiver, and one millisecond later as past it", () => {
    const exact: CampaignDeadline = {
      at: DEADLINE_AT,
      overrides: [waiver(TARGET_A, NOW.toISOString())]
    };
    // INCLUSIVE, matching `now <= deadline.at` one level up. Two comparisons in one predicate
    // disagreeing about who owns the boundary instant is how an off-by-one becomes invisible.
    expect(findEffectiveDeadlineOverride(exact, TARGET_A, NOW)).toBeDefined();
    expect(
      findEffectiveDeadlineOverride(exact, TARGET_A, new Date(NOW.getTime() + 1))
    ).toBeUndefined();
  });

  it("never expires an `until`-less waiver — the common case an Owner cannot put a date on", () => {
    const forever: CampaignDeadline = { at: DEADLINE_AT, overrides: [waiver(TARGET_A)] };
    expect(findEffectiveDeadlineOverride(forever, TARGET_A, new Date(8.64e15))).toBeDefined();
  });

  it("answers `undefined` for an absent, empty or other-target list without scanning further", () => {
    expect(findEffectiveDeadlineOverride({ at: DEADLINE_AT }, TARGET_A, NOW)).toBeUndefined();
    expect(
      findEffectiveDeadlineOverride({ at: DEADLINE_AT, overrides: [] }, TARGET_A, NOW)
    ).toBeUndefined();
    expect(
      findEffectiveDeadlineOverride(
        { at: DEADLINE_AT, overrides: [waiver(TARGET_B)] },
        TARGET_A,
        NOW
      )
    ).toBeUndefined();
  });

  /**
   * AN UNREADABLE `until` IS NOT A WAIVER. Two doors refuse it before this ever runs
   * (`CampaignDeadlineOverrideSchema` at the route, `resolveCampaignDeadline` at the read), so this
   * is a third bar nothing reaches today — asserted anyway because `Date.parse` returns `NaN` and
   * every comparison against `NaN` is `false`, so getting the direction wrong here would silently
   * waive a deadline forever rather than fail loudly. The one place fail-CLOSED is right in this
   * fail-open module: the failure withholds a WAIVER, never a change.
   */
  it("does not waive on an unparseable `until` — NaN falls out as NOT effective", () => {
    const broken = {
      at: DEADLINE_AT,
      overrides: [{ ...waiver(TARGET_A), until: "next Tuesday" }]
    } as unknown as CampaignDeadline;
    expect(findEffectiveDeadlineOverride(broken, TARGET_A, NOW)).toBeUndefined();
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
