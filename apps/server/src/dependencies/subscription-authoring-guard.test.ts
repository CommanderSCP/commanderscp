import { describe, expect, it } from "vitest";
import { ProblemError } from "../errors.js";
import { assertEnforceableDependencySubscriptionScope } from "./subscription-authoring-guard.js";

/**
 * The guard's whole value is that it is NARROW: it refuses exactly one authoring SCOPE and leaves
 * everything else alone. So the negative controls below carry as much weight as the refusal — a
 * guard that rejected more than it should would be indistinguishable, from the refusal test alone,
 * from one that works.
 *
 * M21.4 WIDENED IT BY ONE AXIS AND ONE ONLY (ADR-0032 §6a, 2026-08-15): the refusal now covers a
 * group-scoped ENABLE as well as a group-scoped opt-out, because the jobs that act on a subscription
 * resolve as the system sentinel, which belongs to no group, so such an enable is permanently inert
 * while still reading `enabled: true` in the API for a team member. Every OTHER narrowing is
 * unchanged and is still pinned below — the scope narrowing especially, since widening the direction
 * axis is exactly the kind of edit that quietly widens a second one.
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

/** The thrown ProblemError, so a test can assert WHICH refusal fired rather than merely that one
 *  did. Both directions throw a 400 from the same loop, so a bare `toThrow(ProblemError)` on a
 *  policy carrying both effects proves nothing about the one it names. */
function refusalFrom(properties: Record<string, unknown>): ProblemError {
  try {
    check(properties);
  } catch (err) {
    if (err instanceof ProblemError) return err;
    throw err;
  }
  throw new Error("expected a ProblemError, but the guard permitted this document");
}

describe("group-scoped dependency-subscription effects are refused at authoring time", () => {
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
    // The opt-out is deliberately the ONLY dependencySubscription effect here. With an `enable()`
    // beside it this assertion would be satisfied by the enable's own refusal and would say nothing
    // about the opt-out — green for the wrong reason, which is the whole point of asserting on
    // `detail` below rather than on the exception class.
    const err = refusalFrom({
      scope: { group: "team-platform" },
      effects: [{ requireControls: ["scan"] }, optOut({ coordinate: "acme-lib" })]
    });
    expect(err.detail).toMatch(/opt-out \(enabled: false\)/);
  });

  it("REFUSES an ENABLE scoped to a group — the acting job belongs to no group, so it never fires", () => {
    // M21.4 (ADR-0032 §6a). This case was PERMITTED by M21.3 on the reasoning that failing to match
    // leaves it not-enabled, which is safe. The half that reasoning missed: the background jobs
    // resolve as `SYSTEM_ACTOR_ID`, which has no `objects` row at all
    // (`coordination/system-actor.ts:9`) and is therefore `member_of` nothing — so the enable is
    // permanently inert on every path that fetches or bumps, while a human team member reading the
    // API sees `enabled: true`. A subscription that silently never fires is its own footgun.
    const err = refusalFrom({ scope: { group: "team-platform" }, effects: [enable()] });
    expect(err.status).toBe(400);
    expect(err.detail).toMatch(/enable \(enabled: true\)/);
    // The message must state the ACTUAL failure, not just "not allowed": the author needs to know
    // it would look enabled and do nothing, or the refusal reads as arbitrary.
    expect(err.detail).toMatch(/system actor/);
    expect(err.detail).toMatch(/objectRef/);
  });

  // ----------------------------------------------------------------------------------------
  // NEGATIVE CONTROLS — everything the guard must NOT touch.
  // ----------------------------------------------------------------------------------------

  it("PERMITS an opt-out AND an enable at objectRef or selector scope — those do not depend on who is asking", () => {
    // The direction axis widened; the SCOPE axis did not. Both of these are the ordinary way to
    // author either direction, and a guard that took them too would make the feature unusable.
    for (const effect of [optOut(), enable()]) {
      expect(() =>
        check({ scope: { objectRef: "urn:scp:o:component:checkout" }, effects: [effect] })
      ).not.toThrow();
      expect(() =>
        check({ scope: { selector: { labels: { tier: "gold" } } }, effects: [effect] })
      ).not.toThrow();
    }
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

  it("PERMITS a group-scoped effect that ALSO carries an objectRef — the objectRef branch matches for everyone", () => {
    // Asserted for BOTH directions since M21.4: the objectRef route runs for the system actor too,
    // so an enable carrying one is neither inert nor fail-open and must stay permitted.
    for (const effect of [optOut({ coordinate: "acme-lib" }), enable({ coordinate: "acme-lib" })]) {
      expect(() =>
        check({
          scope: { group: "team-platform", objectRef: "urn:scp:o:component:checkout" },
          effects: [effect]
        })
      ).not.toThrow();
    }
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

  it("PERMITS an unscoped effect in either direction", () => {
    for (const effect of [optOut(), enable()]) {
      expect(() => check({ effects: [effect] })).not.toThrow();
      expect(() => check({ scope: {}, effects: [effect] })).not.toThrow();
    }
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
