import { describe, expect, it } from "vitest";
import { ProblemError } from "../errors.js";
import { assertEnforceableDependencySubscriptionScope } from "./subscription-authoring-guard.js";

/**
 * The guard's whole value is that it is NARROW: it refuses exactly one authoring shape and leaves
 * everything else alone. So the negative controls below carry as much weight as the refusal — a
 * guard that rejected more than it should would be indistinguishable, from the refusal test alone,
 * from one that works.
 */

const optOut = (extra: Record<string, unknown> = {}) => ({
  dependencySubscription: { enabled: false, ...extra }
});
const enable = (extra: Record<string, unknown> = {}) => ({
  dependencySubscription: { enabled: true, ...extra }
});

function check(properties: Record<string, unknown> | undefined, typeId = "policy"): void {
  assertEnforceableDependencySubscriptionScope({ typeId, properties });
}

describe("group-scoped dependency-subscription opt-outs are refused at authoring time", () => {
  it("REFUSES an opt-out scoped to a group — it would silently fail to subtract", () => {
    expect(() => check({ scope: { group: "team-platform" }, effects: [optOut()] })).toThrow(
      ProblemError
    );
    // The refusal must name the REMEDY, not just the rule: an author hitting this needs to know
    // that `objectRef`/`selector` is how to express what they meant. Asserted on `detail`, not on
    // `message` — a ProblemError's `message` is the status text ("Bad Request") and carries none of
    // the explanation, so a `toThrow(/objectRef/)` here would silently pass against any 400.
    let caught: unknown;
    try {
      check({ scope: { group: "team-platform" }, effects: [optOut()] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProblemError);
    expect((caught as ProblemError).status).toBe(400);
    expect((caught as ProblemError).detail).toMatch(/objectRef/);
    expect((caught as ProblemError).detail).toMatch(/silently fail to apply/);
  });

  it("refuses when the group-scoped opt-out is one effect among several", () => {
    expect(() =>
      check({
        scope: { group: "team-platform" },
        effects: [enable(), { requireControls: ["scan"] }, optOut({ coordinate: "acme-lib" })]
      })
    ).toThrow(ProblemError);
  });

  // ----------------------------------------------------------------------------------------
  // NEGATIVE CONTROLS — everything the guard must NOT touch.
  // ----------------------------------------------------------------------------------------

  it("PERMITS a group-scoped ENABLE — failing to match leaves it not-enabled, the safe direction", () => {
    expect(() => check({ scope: { group: "team-platform" }, effects: [enable()] })).not.toThrow();
  });

  it("PERMITS an opt-out at objectRef or selector scope — those do not depend on who is asking", () => {
    expect(() =>
      check({ scope: { objectRef: "urn:scp:o:component:checkout" }, effects: [optOut()] })
    ).not.toThrow();
    expect(() =>
      check({ scope: { selector: { labels: { tier: "gold" } } }, effects: [optOut()] })
    ).not.toThrow();
  });

  // ----------------------------------------------------------------------------------------
  // THE NARROWING: `group` must be the ONLY scope for the refusal to fire.
  //
  // `matchPoliciesForTargets` runs the three scope branches INDEPENDENTLY — `objectRef`
  // (policy-resolve.ts:161-169) and `selector` (:171-181) each record a match before the
  // actor-dependent `group` branch (:183-193) is reached. So a policy carrying group AND one of
  // the others contributes for every caller through that other route, the hazard is absent, and
  // the 400 was telling the author to do what they had already done.
  // ----------------------------------------------------------------------------------------

  it("PERMITS a group-scoped opt-out that ALSO carries an objectRef — the objectRef branch matches for everyone", () => {
    expect(() =>
      check({
        scope: { group: "team-platform", objectRef: "urn:scp:o:component:checkout" },
        effects: [optOut({ coordinate: "acme-lib" })]
      })
    ).not.toThrow();
  });

  it("PERMITS a group-scoped opt-out that ALSO carries a label selector", () => {
    expect(() =>
      check({
        scope: { group: "team-platform", selector: { labels: { tier: "gold" } } },
        effects: [optOut({ coordinate: "acme-lib" })]
      })
    ).not.toThrow();
    // `labels: {}` is a LIVE selector, not an empty one: `labelsMatch` is an `every()` over zero
    // entries, so it returns true for every ancestor and records a match. Mirroring the matcher's
    // own truthiness here rather than guessing is the difference between a narrowing and a hole.
    expect(() =>
      check({ scope: { group: "g", selector: { labels: {} } }, effects: [optOut()] })
    ).not.toThrow();
  });

  it("STILL REFUSES when the companion scope is one the matcher would never act on", () => {
    // Each of these looks like a second scope and is not one: `selector` with no `labels` fails
    // the matcher's `scope.selector?.labels` test, an empty `objectRef` fails its truthiness test,
    // and a non-string `objectRef` resolves to nothing. In every case `group` is the only live
    // route, so the hazard is exactly as present as with `group` alone.
    expect(() => check({ scope: { group: "g", selector: {} }, effects: [optOut()] })).toThrow(
      ProblemError
    );
    expect(() => check({ scope: { group: "g", objectRef: "" }, effects: [optOut()] })).toThrow(
      ProblemError
    );
    expect(() => check({ scope: { group: "g", objectRef: 42 }, effects: [optOut()] })).toThrow(
      ProblemError
    );
  });

  it("applies to the `policy` TYPE ONLY — no other type is ever resolved as a policy", () => {
    // `listPolicyCandidates` (policy-resolve.ts:41-57) selects `type_id = 'policy'`, so a
    // dependencySubscription effect on any other type contributes to nothing and carries no
    // hazard. The type gate lives INSIDE the guard so the free-form-`typeId` doors (hand-fill,
    // overlay, IaC manifests) are correct without each remembering to check.
    const groupOptOut = { scope: { group: "team-platform" }, effects: [optOut()] };
    expect(() => check(groupOptOut, "control")).not.toThrow();
    expect(() => check(groupOptOut, "service")).not.toThrow();
    expect(() => check(groupOptOut, "policy")).toThrow(ProblemError);
  });

  it("PERMITS an unscoped opt-out", () => {
    expect(() => check({ effects: [optOut()] })).not.toThrow();
    expect(() => check({ scope: {}, effects: [optOut()] })).not.toThrow();
  });

  it("does not become a second validator of the effect's shape — a malformed effect passes through", () => {
    // Malformed effects contribute nothing at RESOLUTION time and are reported there. Rejecting
    // them here would duplicate that validation and the two copies would drift.
    expect(() =>
      check({ scope: { group: "g" }, effects: [{ dependencySubscription: "not-an-object" }] })
    ).not.toThrow();
    expect(() =>
      check({ scope: { group: "g" }, effects: [{ dependencySubscription: { enabled: "no" } }] })
    ).not.toThrow();
  });

  it("ignores policies carrying no dependencySubscription effect at all", () => {
    expect(() =>
      check({ scope: { group: "g" }, effects: [{ requireApprovals: { count: 2 } }] })
    ).not.toThrow();
    expect(() => check({ scope: { group: "g" }, effects: [] })).not.toThrow();
  });

  it("tolerates absent or malformed properties without throwing", () => {
    expect(() => check(undefined)).not.toThrow();
    expect(() => check({})).not.toThrow();
    expect(() => check({ scope: { group: "g" } })).not.toThrow();
    // `effects` not an array, and a non-string group — neither is this guard's business.
    expect(() => check({ scope: { group: "g" }, effects: "nope" })).not.toThrow();
    expect(() => check({ scope: { group: 42 }, effects: [optOut()] })).not.toThrow();
    expect(() => check({ scope: { group: "" }, effects: [optOut()] })).not.toThrow();
  });
});
