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

/** The parts of the deadline predicate that need no database. See docs/coordination.md §83. */

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

  /** The same refusal flipped, not a new case. See docs/coordination.md §84. */
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

  /** THE AUTHORING DOORS CANNOT MINT ONE. See docs/coordination.md §85. */
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

  /** A deadline that can never come due is refused. See docs/coordination.md §86. */
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
    // Dedupe is against the latest row of a subject and kind. See docs/coordination.md §87.
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
  /** Not due means inert, and the call count proves it. See docs/coordination.md §88. */
  it("is INERT before the deadline: no lock, and the resolution core is not called ONCE", async () => {
    adoptionCore.mockClear();
    adoptionCore.mockResolvedValue(adoption("not_adopted"));

    const result = await evaluate(new Date(AT.getTime() - 60_000));

    expect(result.locked).toEqual([]);
    expect(adoptionCore).toHaveBeenCalledTimes(0);
  });

  /** THE BOUNDARY, IN BOTH DIRECTIONS. See docs/coordination.md §89. */
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

  /** BOTH ABSENCES LOCK, AND THEY ARE RECORDED DISTINCTLY. See docs/coordination.md §90. */
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

/** M25.6b — THE PER-TARGET WAIVER, INSIDE THE SAME PREDICATE */
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

  /** THE WAIVER EXITS BEFORE THE RESOLUTION CORE IS ASKED. See docs/coordination.md §91. */
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

  /** READ-TIME EXPIRY, WHICH IS THE WHOLE DESIGN. See docs/coordination.md §92. */
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

  /** AN UNREADABLE `until` IS NOT A WAIVER. See docs/coordination.md §93. */
  it("does not waive on an unparseable `until` — NaN falls out as NOT effective", () => {
    const broken = {
      at: DEADLINE_AT,
      overrides: [{ ...waiver(TARGET_A), until: "next Tuesday" }]
    } as unknown as CampaignDeadline;
    expect(findEffectiveDeadlineOverride(broken, TARGET_A, NOW)).toBeUndefined();
  });
});

/** THE SORT, AGAINST A DELIBERATELY DESCENDING INPUT. See docs/coordination.md §94. */
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

/** THE CENSUS PIN. See docs/coordination.md §95. */
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
