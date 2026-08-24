import { describe, expect, it } from "vitest";
import type { CampaignRecipe } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { evaluateCampaignAdoption, positionAgainstFloor } from "./campaign-adoption.js";

/**
 * The parts of M25.5's adoption predicate that need no database:
 *
 *  1. `positionAgainstFloor` — the one place that decides whether a declared version satisfies a
 *     recipe's floor, and the one place a false `adopted` can be manufactured out of a string.
 *  2. INERTNESS — that a recipe declaring no `adoption` costs ZERO queries. Proven rather than
 *     asserted: the transaction handed in is a Proxy that throws on ANY property access, so a
 *     future edit that adds a read to that path fails here with a named error instead of quietly
 *     costing one query per campaign target per tick.
 *
 * Every verdict of every EVIDENCE KIND is exercised against real PostgreSQL in
 * `campaign-adoption.integration.test.ts` — the repo's rule is that a DB-reading predicate is tested
 * against a real database and never a mocked one, and the risky half of each kind (the coordinate
 * join, the "zero rows" test, "latest run wins") is precisely the half a stub would define away.
 */

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

  /**
   * THE MOTIVATING CASE. A real fleet writes `FROM python:3.12-slim`, `3.11-alpine` and `3.12` in a
   * mix, and `minVersion` is authored once. `compareVersions` REFUSES a differing-suffix pair (it
   * answers "is A an upgrade of B", for which a variant change is not an upgrade path) — so a bare
   * delegation would answer `unknown` for nearly every row in the estate this kind exists to serve.
   */
  it("compares the numeric CORE when both suffixes are variant-shaped (`-slim`, `-alpine`, `+build`)", () => {
    expect(positionAgainstFloor("3.12-slim", "3.0")).toBe("at_or_above");
    expect(positionAgainstFloor("3.11-alpine", "3.0")).toBe("at_or_above");
    expect(positionAgainstFloor("2.7-slim", "3.0")).toBe("below");
    expect(positionAgainstFloor("3.0.0+build.5", "3.0.0")).toBe("at_or_above");
  });

  /**
   * THE FALSE-`adopted` GENERATOR THIS GUARDS. `parseComparableVersion`'s own doc records that
   * roughly six git shas in ten begin with a digit and that `1a2b3c4d` parses as major 1 with suffix
   * `a2b3c4d`. A numeric-core comparison that ignored suffix shape would rank `3f2a1b9c` at or above
   * a floor of `3.0` and report a sha-pinned base image as MIGRATED — silence as a pass, wearing a
   * version number. A LETTER-introduced suffix means the numeric core is not reliably a version.
   */
  it("refuses a LETTER-introduced suffix — a git sha is never evidence of adoption", () => {
    expect(positionAgainstFloor("3f2a1b9c", "3.0")).toBe("incomparable");
    expect(positionAgainstFloor("3f2a1b9c", "3.0")).not.toBe("at_or_above");
    // ...including one whose core sits BELOW the floor: still not orderable, still not a verdict.
    expect(positionAgainstFloor("1a2b3c4d", "3.0")).toBe("incomparable");
    // PEP 440's `2rc1` is the same shape and gets the same refusal.
    expect(positionAgainstFloor("2rc1", "3.0")).toBe("incomparable");
  });

  /**
   * NULL means "the manifest pins no concrete version" (an open range), never "we did not look" —
   * `componentDependencies.resolvedVersion`'s own column doc is emphatic about that. It is a real
   * observation and it still cannot satisfy a floor: a range's floor is not what will be installed.
   */
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
