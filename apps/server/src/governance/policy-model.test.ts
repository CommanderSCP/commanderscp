import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isAtLeastAsStrict,
  resolvePolicies,
  type MatchedPolicy,
  type PolicyEnforcement
} from "./policy-model.js";

function matched(overrides: Partial<MatchedPolicy> & { name: string }): MatchedPolicy {
  return {
    policyObjectId: `policy-${overrides.name}-${overrides.matchedAt?.depth ?? 0}`,
    policyVersion: 1,
    enforcement: "advisory",
    condition: undefined,
    effects: [],
    matchedAt: { objectId: "org-root", depth: 0, via: "unscoped" },
    emergencyPolicy: false,
    ...overrides
  };
}

describe("isAtLeastAsStrict", () => {
  const order: PolicyEnforcement[] = ["advisory", "recommended", "required"];
  it.each(order.flatMap((a, i) => order.map((b, j) => [a, b, i >= j] as const)))(
    "%s >= %s is %s",
    (a, b, expected) => {
      expect(isAtLeastAsStrict(a, b)).toBe(expected);
    }
  );
});

describe("resolvePolicies — stricter-wins resolution matrix (table-driven)", () => {
  it("a single org-level policy applies as-is", () => {
    const [effective] = resolvePolicies([
      matched({
        name: "prod-security",
        enforcement: "required",
        effects: [{ requireControls: ["security-scan"] }],
        matchedAt: { objectId: "org", depth: 0, via: "unscoped" }
      })
    ]);
    expect(effective).toMatchObject({ name: "prod-security", enforcement: "required", requireControls: ["security-scan"] });
  });

  it("domain-level ADDS a control on top of org-level (union, local-adds-strictness)", () => {
    const [effective] = resolvePolicies([
      matched({
        name: "prod-security",
        enforcement: "required",
        effects: [{ requireControls: ["security-scan"] }],
        matchedAt: { objectId: "org", depth: 0, via: "objectRef" }
      }),
      matched({
        name: "prod-security",
        enforcement: "required",
        effects: [{ requireControls: ["integration-tests"] }],
        matchedAt: { objectId: "domain-1", depth: 1, via: "objectRef" }
      })
    ]);
    expect(effective!.requireControls.sort()).toEqual(["integration-tests", "security-scan"]);
  });

  it("CAN'T-WEAKEN: a domain-level 'advisory' instance never downgrades an org-level 'required' instance of the same policy", () => {
    const [effective] = resolvePolicies([
      matched({ name: "prod-security", enforcement: "required", matchedAt: { objectId: "org", depth: 0, via: "objectRef" } }),
      matched({ name: "prod-security", enforcement: "advisory", matchedAt: { objectId: "domain-1", depth: 1, via: "objectRef" } })
    ]);
    expect(effective!.enforcement).toBe("required");
  });

  it("CAN'T-WEAKEN, symmetric: order of matches passed in never changes the resolved enforcement", () => {
    const orgFirst = resolvePolicies([
      matched({ name: "p", enforcement: "required", matchedAt: { objectId: "org", depth: 0, via: "objectRef" } }),
      matched({ name: "p", enforcement: "advisory", matchedAt: { objectId: "domain", depth: 1, via: "objectRef" } })
    ]);
    const domainFirst = resolvePolicies([
      matched({ name: "p", enforcement: "advisory", matchedAt: { objectId: "domain", depth: 1, via: "objectRef" } }),
      matched({ name: "p", enforcement: "required", matchedAt: { objectId: "org", depth: 0, via: "objectRef" } })
    ]);
    expect(orgFirst[0]!.enforcement).toBe("required");
    expect(domainFirst[0]!.enforcement).toBe("required");
  });

  it("service-level raises recommended org policy to required (3-level chain: org -> domain -> service)", () => {
    const [effective] = resolvePolicies([
      matched({ name: "p", enforcement: "recommended", matchedAt: { objectId: "org", depth: 0, via: "objectRef" } }),
      matched({ name: "p", enforcement: "recommended", matchedAt: { objectId: "domain", depth: 1, via: "objectRef" } }),
      matched({ name: "p", enforcement: "required", matchedAt: { objectId: "service", depth: 2, via: "objectRef" } })
    ]);
    expect(effective!.enforcement).toBe("required");
  });

  it("component-level (deepest) contributes strictness in a full org->domain->service->component chain", () => {
    const [effective] = resolvePolicies([
      matched({
        name: "p",
        enforcement: "advisory",
        effects: [{ requireControls: ["a"] }],
        matchedAt: { objectId: "org", depth: 0, via: "objectRef" }
      }),
      matched({
        name: "p",
        enforcement: "advisory",
        effects: [{ requireControls: ["b"] }],
        matchedAt: { objectId: "domain", depth: 1, via: "objectRef" }
      }),
      matched({
        name: "p",
        enforcement: "advisory",
        effects: [{ requireControls: ["c"] }],
        matchedAt: { objectId: "service", depth: 2, via: "objectRef" }
      }),
      matched({
        name: "p",
        enforcement: "required",
        effects: [{ requireControls: ["d"] }],
        matchedAt: { objectId: "component", depth: 3, via: "objectRef" }
      })
    ]);
    expect(effective!.enforcement).toBe("required");
    expect(effective!.requireControls.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("requireApprovals count takes the MAX across the group for the same (fromRole, scope) pair", () => {
    const [effective] = resolvePolicies([
      matched({
        name: "p",
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole: "Approver", scope: "org" } }],
        matchedAt: { objectId: "org", depth: 0, via: "objectRef" }
      }),
      matched({
        name: "p",
        enforcement: "required",
        effects: [{ requireApprovals: { count: 2, fromRole: "Approver", scope: "org" } }],
        matchedAt: { objectId: "domain", depth: 1, via: "objectRef" }
      })
    ]);
    expect(effective!.requireApprovals).toEqual([{ count: 2, fromRole: "Approver", scope: "org" }]);
  });

  it("DIFFERENT (fromRole, scope) requireApprovals pairs stay as SEPARATE entries (not merged)", () => {
    const [effective] = resolvePolicies([
      matched({
        name: "p",
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole: "Operator", scope: "org" } }],
        matchedAt: { objectId: "org", depth: 0, via: "objectRef" }
      }),
      matched({
        name: "p",
        enforcement: "required",
        effects: [{ requireApprovals: { count: 2, fromRole: "Approver", scope: "domain" } }],
        matchedAt: { objectId: "domain", depth: 1, via: "objectRef" }
      })
    ]);
    expect(effective!.requireApprovals).toHaveLength(2);
  });

  it("policies with DIFFERENT names never merge — each resolves independently", () => {
    const effective = resolvePolicies([
      matched({ name: "prod-security", enforcement: "required", matchedAt: { objectId: "org", depth: 0, via: "objectRef" } }),
      matched({ name: "cost-control", enforcement: "advisory", matchedAt: { objectId: "org", depth: 0, via: "objectRef" } })
    ]);
    expect(effective).toHaveLength(2);
    expect(effective.find((e) => e.name === "prod-security")!.enforcement).toBe("required");
    expect(effective.find((e) => e.name === "cost-control")!.enforcement).toBe("advisory");
  });

  it("no matches resolves to an empty list", () => {
    expect(resolvePolicies([])).toEqual([]);
  });
});

describe("resolvePolicies — property: order-independence and can't-weaken (fast-check)", () => {
  const enforcementArb = fc.constantFrom<PolicyEnforcement>("advisory", "recommended", "required");

  it("resolved enforcement is invariant under permutation of the input matches", () => {
    fc.assert(
      fc.property(
        fc.array(enforcementArb, { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 8 }),
        (enforcements, depths) => {
          const n = Math.min(enforcements.length, depths.length);
          const group: MatchedPolicy[] = Array.from({ length: n }, (_, i) =>
            matched({ name: "p", enforcement: enforcements[i]!, matchedAt: { objectId: `o${i}`, depth: depths[i]!, via: "objectRef" } })
          );
          const expectedMax = enforcements.slice(0, n).includes("required")
            ? "required"
            : enforcements.slice(0, n).includes("recommended")
              ? "recommended"
              : "advisory";

          // Try a handful of shuffles rather than all permutations (factorial blowup) — still a
          // strong order-independence property test.
          for (const shuffled of [group, [...group].reverse(), [...group].sort(() => 0.5)]) {
            const [effective] = resolvePolicies(shuffled);
            expect(effective!.enforcement).toBe(expectedMax);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("the effective enforcement is NEVER weaker than any single contributor's own enforcement", () => {
    fc.assert(
      fc.property(fc.array(enforcementArb, { minLength: 1, maxLength: 8 }), (enforcements) => {
        const group = enforcements.map((e, i) => matched({ name: "p", enforcement: e, matchedAt: { objectId: `o${i}`, depth: i, via: "objectRef" } }));
        const [effective] = resolvePolicies(group);
        for (const e of enforcements) {
          expect(isAtLeastAsStrict(effective!.enforcement, e)).toBe(true);
        }
      }),
      { numRuns: 50 }
    );
  });

  it("the effective requireControls set is a SUPERSET of every contributor's own controls (can never drop one)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 4 }), { minLength: 1, maxLength: 6 }),
        (controlLists) => {
          const group = controlLists.map((controls, i) =>
            matched({
              name: "p",
              enforcement: "required",
              effects: [{ requireControls: controls }],
              matchedAt: { objectId: `o${i}`, depth: i, via: "objectRef" }
            })
          );
          const [effective] = resolvePolicies(group);
          for (const controls of controlLists) {
            for (const c of controls) expect(effective!.requireControls).toContain(c);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
