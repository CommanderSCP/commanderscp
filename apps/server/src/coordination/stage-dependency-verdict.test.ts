import { describe, expect, it } from "vitest";
import { OBSERVED_WEIGHT_FRESHNESS_MS, stageDependencyVerdict } from "./stage-dependency-hold.js";

/**
 * ADR-0028 increment 3 — the branch matrix of decision 4, against a synthesised wave-target row.
 *
 * This is the half of the hold that decides; the integration suite pins which rows are read and what
 * is persisted. The case worth stating outright is the one this file exists for: an UNREADABLE weight
 * must never satisfy and must never be treated as a weight of zero either. Both mistakes produce a
 * plausible-looking verdict from the outside — one deploys ahead of a dependency the author named,
 * the other holds a release that a correct `minWeight` of 1 should have let through.
 *
 * `now` is injected rather than mocked, so the freshness boundary can be asserted from both sides
 * without a timer and without the test asserting that the machine is never busy.
 */

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo);

/**
 * A dependency's most recent wave target at the place under test.
 *
 * `lastObservedAt` is ALWAYS FRESH here, and that is the point rather than a convenience: it dates
 * the POLL, and a poll that reports nothing storable still refreshes it while leaving the reading
 * untouched. Anything about age therefore has to be said with `observedAt`, which dates the READING.
 * A helper that let the two move together would make the freshness tests pass for the wrong reason.
 */
function row(overrides: {
  status: string;
  weight?: number | string | null;
  /** `null` = a stored payload carrying no date at all (a row written before the field existed). */
  observedAt?: Date | null;
}) {
  const { status, weight } = overrides;
  const observedAt = overrides.observedAt === undefined ? at(1_000) : overrides.observedAt;
  return {
    status,
    observedState:
      weight === undefined
        ? {}
        : { rollout: { weight }, ...(observedAt ? { observedAt: observedAt.toISOString() } : {}) },
    lastObservedAt: at(1_000)
  };
}

describe("stageDependencyVerdict — the universal test", () => {
  it("holds `never_deployed` when the dependency is placed here but has no wave target here", () => {
    expect(stageDependencyVerdict({ dependsOn: "B" }, undefined, NOW)).toEqual({
      dependsOn: "B",
      branch: "never_deployed",
      satisfied: false
    });
  });

  it("satisfies on `succeeded` — the column every executor writes", () => {
    const verdict = stageDependencyVerdict({ dependsOn: "B" }, row({ status: "succeeded" }), NOW);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("succeeded");
    expect(verdict.dependencyStatus).toBe("succeeded");
  });

  it.each(["pending", "triggering", "triggered", "observing", "failed", "aborted", "no_executor"])(
    "holds `behind` while the dependency's latest deploy here is '%s'",
    (status) => {
      const verdict = stageDependencyVerdict({ dependsOn: "B" }, row({ status }), NOW);
      expect(verdict.satisfied).toBe(false);
      expect(verdict.branch).toBe("behind");
      expect(verdict.dependencyStatus).toBe(status);
    }
  );

  it("re-deployment re-holds: a dependency that succeeded before is judged on its LATEST row", () => {
    // The caller hands over the most recent row, not the most recent SUCCEEDED one — which is what
    // makes "B succeeded here last week and is mid-redeploy here right now" a hold rather than a
    // pass. Stated here because the alternative reads perfectly well and is wrong.
    expect(
      stageDependencyVerdict({ dependsOn: "B" }, row({ status: "observing" }), NOW).satisfied
    ).toBe(false);
  });
});

describe("stageDependencyVerdict — the minWeight qualifier (the owner's headline case)", () => {
  it("satisfies at a PARTIAL weight, without the dependency's deploy here finishing", () => {
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 10 },
      row({ status: "observing", weight: 10 }),
      NOW
    );
    expect(verdict).toEqual({
      dependsOn: "B",
      branch: "min_weight",
      satisfied: true,
      dependencyStatus: "observing",
      minWeight: 10
    });
  });

  it("is a >= test, not a > test", () => {
    expect(
      stageDependencyVerdict(
        { dependsOn: "B", minWeight: 50 },
        row({ status: "observing", weight: 49 }),
        NOW
      ).satisfied
    ).toBe(false);
    expect(
      stageDependencyVerdict(
        { dependsOn: "B", minWeight: 50 },
        row({ status: "observing", weight: 51 }),
        NOW
      ).satisfied
    ).toBe(true);
  });

  it("a READABLE weight below the minimum holds as `behind`, naming the declared minimum", () => {
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 50 },
      row({ status: "observing", weight: 10 }),
      NOW
    );
    expect(verdict.branch).toBe("behind");
    expect(verdict.minWeight).toBe(50);
    // Distinguishable from unreadable — ADR-0028 decision 4 requires the causes to be told apart,
    // and these two have opposite remedies (wait vs. fix the observe path).
    expect(verdict.weightUnreadable).toBeUndefined();
  });
});

describe("stageDependencyVerdict — an unreadable weight degrades, it never satisfies", () => {
  it.each([
    ["no rollout snapshot at all (not ArgoCD)", row({ status: "observing" }), "no_weight"],
    [
      "a blue/green Rollout, which populates no canary weight",
      row({ status: "observing", weight: null }),
      "no_weight"
    ],
    [
      "a non-numeric weight from a future/other executor",
      row({ status: "observing", weight: "10%" }),
      "no_weight"
    ],
    [
      "a stored reading with nothing dating it (a row written before `observedAt`)",
      row({ status: "observing", weight: 90, observedAt: null }),
      "not_observed"
    ],
    [
      "a READING older than the freshness bound, however recently it was polled",
      row({
        status: "observing",
        weight: 90,
        observedAt: at(OBSERVED_WEIGHT_FRESHNESS_MS + 1)
      }),
      "stale"
    ]
  ])("holds with `weight_unreadable` when %s", (_label, latest, cause) => {
    const verdict = stageDependencyVerdict({ dependsOn: "B", minWeight: 10 }, latest, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.branch).toBe("weight_unreadable");
    expect(verdict.weightUnreadable).toBe(cause);
  });

  it("THE FRESHNESS BOUND DATES THE READING, NOT THE POLL — a vanished Application still goes stale", () => {
    // THE SHAPE THAT MADE THIS A FINDING. `updateWaveTargetObserved` refreshes `last_observed_at`
    // on EVERY poll but rewrites `observed_state` only when the poll carried something storable,
    // and `observedStateFrom` returns `undefined` for a status with no stateRef, no images and no
    // rollout — precisely the argocd plugin's 404 shape (`{phase:'pending', detail:"application
    // '<name>' not found (yet)"}`). So an Application deleted or renamed mid-canary leaves its last
    // weight frozen while every subsequent tick moves the poll timestamp: dated by the poll, this
    // row looks a second old forever, `stale` never fires, and the hold keeps RELEASING dependants
    // against a world that no longer exists.
    const polledOneSecondAgo = new Date(NOW - 1_000);
    const readTakenAnHourAgo = {
      status: "observing",
      observedState: {
        rollout: { weight: 90 },
        observedAt: new Date(NOW - 60 * 60_000).toISOString()
      },
      lastObservedAt: polledOneSecondAgo
    };
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 10 },
      readTakenAnHourAgo,
      NOW
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.weightUnreadable).toBe("stale");
  });

  it("an unreadable weight is NOT a weight of zero — a stale 90 does not satisfy minWeight 1", () => {
    // The two are different claims and only one of them is true. Reading absence as 0 would be the
    // milder-looking mistake and would still be wrong in the other direction.
    expect(
      stageDependencyVerdict(
        { dependsOn: "B", minWeight: 1 },
        row({ status: "observing", observedAt: null, weight: 90 }),
        NOW
      ).branch
    ).toBe("weight_unreadable");
  });

  it("falls back to the universal test and SATISFIES when that test passes — with the warning kept", () => {
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 10 },
      row({ status: "succeeded" }),
      NOW
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("succeeded");
    // Proceeded, but NOT for the reason its author asked for. Without this an operator whose Argo
    // RBAC silently blocks the rollout read would never learn that their qualifier does nothing.
    expect(verdict.weightUnreadable).toBe("no_weight");
  });

  it("a reading exactly ON the freshness bound is still fresh", () => {
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 10 },
      row({
        status: "observing",
        weight: 10,
        observedAt: at(OBSERVED_WEIGHT_FRESHNESS_MS)
      }),
      NOW
    );
    expect(verdict.branch).toBe("min_weight");
  });

  it("no minWeight declared ⇒ no weight is read and no warning is invented", () => {
    const verdict = stageDependencyVerdict(
      { dependsOn: "B" },
      row({ status: "succeeded", observedAt: null }),
      NOW
    );
    expect(verdict.weightUnreadable).toBeUndefined();
    expect(verdict.minWeight).toBeUndefined();
  });
});

describe("stageDependencyVerdict — a declaration may not WEAKEN the pair's edge (ADR-0028 decision 6)", () => {
  // The two sources compose asymmetrically: the EDGE asserts the universal `succeeded` test, and a
  // declaration's `minWeight` is a RELAXATION of it. For a pair carrying both, the strictest
  // applicable constraint is the edge's — otherwise the party being ordered could neutralise an
  // ordering somebody else wrote (an operator, a seed, an earlier change) for free, by adding
  // `minWeight: 1` to its own declaration.

  it("drops the qualifier when the pair is also edge-asserted — a weight above the minimum does NOT satisfy", () => {
    const dep = { dependsOn: "B", minWeight: 1 };
    const latest = row({ status: "observing", weight: 5 });
    // Without the edge this is the owner's headline case, and it passes.
    expect(stageDependencyVerdict(dep, latest, NOW).branch).toBe("min_weight");
    // With it, the pair falls back to the test the edge asserts, which this dependency fails.
    const verdict = stageDependencyVerdict(dep, latest, NOW, true);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.branch).toBe("behind");
  });

  it("still ECHOES the declared minWeight, and says it was superseded rather than ignored", () => {
    // "Why is my release held behind a dependency that is well past the weight I declared?" has to
    // have an answer in the record; a silently dropped qualifier looks identical to a broken one.
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 1 },
      row({ status: "observing", weight: 90 }),
      NOW,
      true
    );
    expect(verdict.minWeight).toBe(1);
    expect(verdict.minWeightSupersededByEdge).toBe(true);
  });

  it("the edge's own test still passes on its own terms: a succeeded dependency satisfies", () => {
    // Stricter, not unsatisfiable. The pair serialises; it does not deadlock.
    const verdict = stageDependencyVerdict(
      { dependsOn: "B", minWeight: 50 },
      row({ status: "succeeded" }),
      NOW,
      true
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.branch).toBe("succeeded");
    // And no weight was read at all, so no unreadable-weight warning is invented for a qualifier
    // that was never going to be consulted.
    expect(verdict.weightUnreadable).toBeUndefined();
    expect(verdict.minWeightSupersededByEdge).toBe(true);
  });

  it("leaves an UNQUALIFIED declaration exactly as it was — there is nothing to supersede", () => {
    const verdict = stageDependencyVerdict(
      { dependsOn: "B" },
      row({ status: "observing" }),
      NOW,
      true
    );
    expect(verdict).toEqual({
      dependsOn: "B",
      branch: "behind",
      satisfied: false,
      dependencyStatus: "observing"
    });
  });
});
