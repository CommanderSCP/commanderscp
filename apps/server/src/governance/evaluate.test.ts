import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { CelSandbox } from "./cel-sandbox.js";
import { evaluateGovernance, type PolicyEvaluationContext } from "./evaluate.js";
import type { EffectivePolicy, MatchedPolicy } from "./policy-model.js";
import { resolvePolicies } from "./policy-model.js";

function baseContext(overrides: Partial<PolicyEvaluationContext> = {}): PolicyEvaluationContext {
  return {
    change: { id: "change-1", emergency: false, targets: ["target-1"], sourceKind: "manual", correlationKey: null },
    subject: { id: "target-1", typeId: "service", name: "billing", labels: { env: "prod" } },
    graph: { ownerIds: [], dependentIds: [], domainIds: [] },
    controlOutcomes: {},
    approvals: {},
    time: "2026-07-10T00:00:00.000Z",
    actor: { id: "actor-1" },
    ...overrides
  };
}

function effective(overrides: Partial<EffectivePolicy> & { name: string }): EffectivePolicy {
  const contributor: MatchedPolicy = {
    policyObjectId: `policy-${overrides.name}`,
    policyVersion: 1,
    name: overrides.name,
    enforcement: overrides.enforcement ?? "required",
    condition: undefined,
    effects: [],
    matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
    emergencyPolicy: false
  };
  return {
    enforcement: "required",
    requireControls: [],
    requireApprovals: [],
    contributors: [contributor],
    emergencyPolicy: false,
    ...overrides
  };
}

describe("evaluateGovernance", () => {
  const sandboxes: CelSandbox[] = [];
  function sandbox(): CelSandbox {
    const s = new CelSandbox();
    sandboxes.push(s);
    return s;
  }
  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((s) => s.stop()));
  });

  it("allows when there are no effective policies at all", async () => {
    const result = await evaluateGovernance(sandbox(), [], baseContext());
    expect(result.verdict).toBe("allow");
  });

  it("allows when a required policy's requireControls effect is satisfied (control passed)", async () => {
    const policy = effective({ name: "scan", enforcement: "required", requireControls: ["security-scan"] });
    const ctx = baseContext({ controlOutcomes: { "security-scan": "pass" } });
    const result = await evaluateGovernance(sandbox(), [policy], ctx);
    expect(result.verdict).toBe("allow");
    expect(result.policies[0]!.satisfied).toBe(true);
  });

  it("blocks when a required policy's requireControls effect is unsatisfied", async () => {
    const policy = effective({ name: "scan", enforcement: "required", requireControls: ["security-scan"] });
    const ctx = baseContext({ controlOutcomes: { "security-scan": "fail" } });
    const result = await evaluateGovernance(sandbox(), [policy], ctx);
    expect(result.verdict).toBe("block");
  });

  it("a control that never ran (absent from controlOutcomes) counts as unsatisfied, not silently passing", async () => {
    const policy = effective({ name: "scan", enforcement: "required", requireControls: ["security-scan"] });
    const result = await evaluateGovernance(sandbox(), [policy], baseContext());
    expect(result.verdict).toBe("block");
  });

  it("advisory unmet effects WARN, never BLOCK", async () => {
    const policy = effective({ name: "nice-to-have", enforcement: "advisory", requireControls: ["lint"] });
    const result = await evaluateGovernance(sandbox(), [policy], baseContext());
    expect(result.verdict).toBe("warn");
  });

  it("recommended unmet effects WARN, never BLOCK", async () => {
    const policy = effective({ name: "should-have", enforcement: "recommended", requireControls: ["lint"] });
    const result = await evaluateGovernance(sandbox(), [policy], baseContext());
    expect(result.verdict).toBe("warn");
  });

  it("a policy whose CEL condition evaluates false does not fire — its unmet effects don't count", async () => {
    const contributor: MatchedPolicy = {
      policyObjectId: "policy-conditional",
      policyVersion: 1,
      name: "conditional",
      enforcement: "required",
      condition: 'subject.labels.env == "staging"', // false — subject is env=prod in baseContext
      effects: [{ requireControls: ["scan"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false
    };
    const [policy] = resolvePolicies([contributor]);
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(result.verdict).toBe("allow");
    expect(result.policies[0]!.fired).toBe(false);
  });

  it("a policy whose CEL condition evaluates true DOES fire and its effects are checked", async () => {
    const contributor: MatchedPolicy = {
      policyObjectId: "policy-conditional",
      policyVersion: 1,
      name: "conditional",
      enforcement: "required",
      condition: 'subject.labels.env == "prod"', // true
      effects: [{ requireControls: ["scan"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false
    };
    const [policy] = resolvePolicies([contributor]);
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(result.verdict).toBe("block");
    expect(result.policies[0]!.fired).toBe(true);
  });

  it("a malformed CEL condition fails safe: does not fire, verdict allows (no block on a broken expression)", async () => {
    const contributor: MatchedPolicy = {
      policyObjectId: "policy-broken",
      policyVersion: 1,
      name: "broken",
      enforcement: "required",
      condition: "this is : not valid CEL {{",
      effects: [{ requireControls: ["scan"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false
    };
    const [policy] = resolvePolicies([contributor]);
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(result.policies[0]!.fired).toBe(false);
    expect(result.policies[0]!.conditionResult).toBe("error");
  });

  it("requireApprovals is satisfied only when the approvals lookup says so", async () => {
    const contributor: MatchedPolicy = {
      policyObjectId: "policy-approval",
      policyVersion: 1,
      name: "needs-approval",
      enforcement: "required",
      condition: undefined,
      effects: [{ requireApprovals: { count: 2, fromRole: "Approver", scope: "org" } }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false
    };
    const [policy] = resolvePolicies([contributor]);
    const key = "policy-approval::1::0";

    const unsatisfied = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(unsatisfied.verdict).toBe("block");

    const satisfied = await evaluateGovernance(
      sandbox(),
      [policy!],
      baseContext({ approvals: { [key]: { satisfied: true, count: 2, required: 2 } } })
    );
    expect(satisfied.verdict).toBe("allow");
  });

  // ---------------------------------------------------------------------------------------
  // BUILD_AND_TEST.md §8 M4 unit DoD: "CEL policy evaluation is a PURE function — same context
  // snapshot ⇒ same verdict + reason tree (property-tested)".
  // ---------------------------------------------------------------------------------------
  it("PURITY: repeated evaluation of the identical (policies, context) snapshot always yields an identical verdict + reason tree", async () => {
    const policies: EffectivePolicy[] = [
      effective({ name: "scan", enforcement: "required", requireControls: ["security-scan"] }),
      effective({ name: "advisory-lint", enforcement: "advisory", requireControls: ["lint"] })
    ];
    const ctx = baseContext({ controlOutcomes: { "security-scan": "pass" } });
    const s = sandbox();

    const results = await Promise.all(Array.from({ length: 8 }, () => evaluateGovernance(s, policies, ctx)));
    const first = JSON.stringify(results[0]);
    for (const r of results) {
      expect(JSON.stringify(r)).toBe(first);
    }
  });

  it("PURITY (property-tested): for randomized control-outcome maps, evaluating the same snapshot twice always agrees", async () => {
    const s = sandbox();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"pass" | "fail" | "warning" | "skipped" | "timed_out" | "expired">(
          "pass",
          "fail",
          "warning",
          "skipped",
          "timed_out",
          "expired"
        ),
        fc.constantFrom<"advisory" | "recommended" | "required">("advisory", "recommended", "required"),
        async (outcome, enforcement) => {
          const policy = effective({ name: "p", enforcement, requireControls: ["c1"] });
          const ctx = baseContext({ controlOutcomes: { c1: outcome } });
          const a = await evaluateGovernance(s, [policy], ctx);
          const b = await evaluateGovernance(s, [policy], ctx);
          expect(a.verdict).toBe(b.verdict);
          expect(a.policies[0]!.satisfied).toBe(b.policies[0]!.satisfied);
          // pass is the only outcome that satisfies; required+unsatisfied blocks, else warn/allow.
          const shouldSatisfy = outcome === "pass";
          expect(a.policies[0]!.satisfied).toBe(shouldSatisfy);
          if (!shouldSatisfy && enforcement === "required") expect(a.verdict).toBe("block");
          if (!shouldSatisfy && enforcement !== "required") expect(a.verdict).toBe("warn");
          if (shouldSatisfy) expect(a.verdict).toBe("allow");
        }
      ),
      { numRuns: 20 }
    );
  });
});
