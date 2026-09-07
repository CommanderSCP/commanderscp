import { describe, expect, it } from "vitest";
import type { CampaignRecipe } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { evaluateCampaignAdoption, positionAgainstFloor } from "./campaign-adoption.js";

/** The parts of the adoption predicate that need no database. See docs/coordination.md §61. */

/** A `TenantTx` that cannot be used. Touching it at all is the failure this proves cannot happen. */
const FORBIDDEN_TX = new Proxy({} as object, {
  get(_target, property) {
    throw new Error(
      `INERTNESS VIOLATED: the adoption predicate touched the transaction (.${String(property)}) ` +
        `for a recipe that declares no adoption evidence. That path must cost zero queries — see ` +
        `campaign-adoption.ts's "INERTNESS IS A REQUIREMENT" note.`
    );
  }
}) as TenantTx;

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

describe("positionAgainstFloor — where one declaration sits relative to a recipe's floor", () => {
  it("orders an ordinary suffix-free pair through the shared comparator", () => {
    expect(positionAgainstFloor("3.12.0", "3.0.0")).toBe("at_or_above");
    expect(positionAgainstFloor("3.0.0", "3.0.0")).toBe("at_or_above");
    expect(positionAgainstFloor("2.7.18", "3.0.0")).toBe("below");
  });

  it("orders a pair whose suffixes are IDENTICAL through the shared comparator untouched", () => {
    expect(positionAgainstFloor("3.12-slim", "3.0-slim")).toBe("at_or_above");
    expect(positionAgainstFloor("2.7-slim", "3.0-slim")).toBe("below");
  });

  /** THE MOTIVATING CASE. See docs/coordination.md §62. */
  it("compares the numeric CORE when both suffixes are variant-shaped (`-slim`, `-alpine`, `+build`)", () => {
    expect(positionAgainstFloor("3.12-slim", "3.0")).toBe("at_or_above");
    expect(positionAgainstFloor("3.11-alpine", "3.0")).toBe("at_or_above");
    expect(positionAgainstFloor("2.7-slim", "3.0")).toBe("below");
    expect(positionAgainstFloor("3.0.0+build.5", "3.0.0")).toBe("at_or_above");
  });

  /** THE FALSE-`adopted` GENERATOR THIS GUARDS. See docs/coordination.md §63. */
  it("refuses a LETTER-introduced suffix — a git sha is never evidence of adoption", () => {
    expect(positionAgainstFloor("3f2a1b9c", "3.0")).toBe("incomparable");
    expect(positionAgainstFloor("3f2a1b9c", "3.0")).not.toBe("at_or_above");
    // ...including one whose core sits BELOW the floor: still not orderable, still not a verdict.
    expect(positionAgainstFloor("1a2b3c4d", "3.0")).toBe("incomparable");
    // PEP 440's `2rc1` is the same shape and gets the same refusal.
    expect(positionAgainstFloor("2rc1", "3.0")).toBe("incomparable");
  });

  /** NULL means "the manifest pins no concrete version". See docs/coordination.md §64. */
  it("reports a NULL resolved_version as `unpinned` — which never satisfies a floor", () => {
    expect(positionAgainstFloor(null, "3.0")).toBe("unpinned");
    expect(positionAgainstFloor(null, "3.0")).not.toBe("at_or_above");
  });

  it("refuses a version string the single parser cannot understand, in either position", () => {
    expect(positionAgainstFloor("latest", "3.0")).toBe("incomparable");
    expect(positionAgainstFloor("stable", "3.0")).toBe("incomparable");
    // A `minVersion` the parser refuses makes EVERY row incomparable — the verdict degrades to
    // `unknown` for the whole component, never to `adopted`.
    expect(positionAgainstFloor("3.12", "not-a-version")).toBe("incomparable");
  });
});

describe("evaluateCampaignAdoption — a recipe that names no evidence source", () => {
  /** A recipe with a trigger and no `adoption` — the shape of every campaign authored before M25.5. */
  const recipeWithoutAdoption: CampaignRecipe = {
    version: 1,
    trigger: { kind: "workflow_dispatch" }
  };

  it("returns `unknown` — and explicitly NOT `adopted` — with ZERO queries", async () => {
    const result = await evaluateCampaignAdoption(
      FORBIDDEN_TX,
      "00000000-0000-4000-8000-000000000000",
      CAMPAIGN_ID,
      TARGET_ID,
      recipeWithoutAdoption
    );
    expect(result.verdict).toBe("unknown");
    expect(result.verdict).not.toBe("adopted");
    expect(result.evidence).toBeNull();
    expect(result.observations).toEqual([]);
    expect(result.summary).toContain("names no adoption evidence source");
  });

  it("returns `unknown` with ZERO queries for a campaign carrying no recipe at all", async () => {
    for (const recipe of [undefined, null]) {
      const result = await evaluateCampaignAdoption(
        FORBIDDEN_TX,
        "00000000-0000-4000-8000-000000000000",
        CAMPAIGN_ID,
        TARGET_ID,
        recipe
      );
      expect(result.verdict).toBe("unknown");
      expect(result.verdict).not.toBe("adopted");
    }
  });

  it("records the target but NOTHING CLOCK-SHAPED in the context it hands the Decision", async () => {
    const result = await evaluateCampaignAdoption(
      FORBIDDEN_TX,
      "00000000-0000-4000-8000-000000000000",
      CAMPAIGN_ID,
      TARGET_ID,
      recipeWithoutAdoption
    );
    expect(Object.keys(result.inputContext).sort()).toEqual([
      "evidenceKind",
      "observations",
      "targetObjectId"
    ]);
  });
});
