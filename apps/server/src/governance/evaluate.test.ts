import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { CelSandbox } from "./cel-sandbox.js";
import { evaluateGovernance, type PolicyEvaluationContext } from "./evaluate.js";
import type { EffectivePolicy, MatchedPolicy, PolicyEffect } from "./policy-model.js";
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

/** Builds a single-contributor EffectivePolicy. Since the condition-aware evaluator
 *  (`resolveFiredPolicies`) reads effects from each CONTRIBUTOR (never the summary merged fields),
 *  the contributor here carries the `requireControls` effect — not just the summary field. */
function effective(overrides: Partial<EffectivePolicy> & { name: string }): EffectivePolicy {
  const enforcement = overrides.enforcement ?? "required";
  const requireControls = overrides.requireControls ?? [];
  const effects: PolicyEffect[] = requireControls.length > 0 ? [{ requireControls }] : [];
  const contributor: MatchedPolicy = {
    policyObjectId: `policy-${overrides.name}`,
    policyVersion: 1,
    name: overrides.name,
    enforcement,
    condition: undefined,
    effects,
    matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
    emergencyPolicy: false,
    autoRollbackOnFailure: false
  };
  return {
    enforcement,
    requireControls,
    requireApprovals: overrides.requireApprovals ?? [],
    emergencyPolicy: false,
    autoRollbackOnFailure: false,
    ...overrides,
    // `contributors` after the spread: callers pass only summary overrides (requireControls/
    // enforcement); the condition-aware contributor built above is authoritative.
    contributors: [contributor]
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
      emergencyPolicy: false,
    autoRollbackOnFailure: false
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
      emergencyPolicy: false,
    autoRollbackOnFailure: false
    };
    const [policy] = resolvePolicies([contributor]);
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(result.verdict).toBe("block");
    expect(result.policies[0]!.fired).toBe(true);
  });

  it("MAJOR #3 fail-closed: a REQUIRED policy whose CEL condition ERRORS blocks (never allows) and carries a conditionError effect", async () => {
    const contributor: MatchedPolicy = {
      policyObjectId: "policy-broken",
      policyVersion: 1,
      name: "broken",
      enforcement: "required",
      condition: "this is : not valid CEL {{",
      effects: [{ requireControls: ["scan"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };
    const [policy] = resolvePolicies([contributor]);
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    // Fail CLOSED — a broken required condition can never silently disable the policy.
    expect(result.verdict).toBe("block");
    expect(result.policies[0]!.fired).toBe(true);
    expect(result.policies[0]!.conditionResult).toBe("error");
    expect(result.policies[0]!.effects.some((e) => e.kind === "conditionError" && !e.satisfied)).toBe(true);
  });

  it("MAJOR #3 advisory annotate: an ADVISORY policy whose CEL condition errors does NOT block (annotate-and-continue)", async () => {
    const contributor: MatchedPolicy = {
      policyObjectId: "policy-adv-broken",
      policyVersion: 1,
      name: "adv-broken",
      enforcement: "advisory",
      condition: "this is : not valid CEL {{",
      effects: [{ requireControls: ["lint"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };
    const [policy] = resolvePolicies([contributor]);
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(result.verdict).toBe("allow"); // advisory error never blocks
    expect(result.policies[0]!.fired).toBe(false);
    expect(result.policies[0]!.conditionResult).toBe("error");
  });

  it("CRITICAL #1a: a same-named contributor whose condition is FALSE does NOT drop a firing required contributor's effects", async () => {
    // Org-level required contributor, unconditional (always fires), requires `security-scan`.
    const orgRequired: MatchedPolicy = {
      policyObjectId: "policy-org",
      policyVersion: 1,
      name: "prod-security",
      enforcement: "required",
      condition: undefined,
      effects: [{ requireControls: ["security-scan"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };
    // A second same-named policy (e.g. planted by a lower-scope actor) with a false condition.
    // Under the OLD AND-of-conditions logic this zeroed out the org's effects; it must not now.
    const plantedFalse: MatchedPolicy = {
      policyObjectId: "policy-planted",
      policyVersion: 1,
      name: "prod-security",
      enforcement: "advisory",
      condition: "1 == 2", // always false
      effects: [{ requireControls: ["neutralize-me"] }],
      matchedAt: { objectId: "component", depth: 3, via: "objectRef" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };
    const [policy] = resolvePolicies([orgRequired, plantedFalse]);
    // security-scan never ran → the org's required effect is still enforced → block.
    const result = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(result.verdict).toBe("block");
    const controlEffect = result.policies[0]!.effects.find(
      (e) => e.kind === "requireControls" && e.detail.controlObjectId === "security-scan"
    );
    expect(controlEffect?.satisfied).toBe(false);
    // The planted false contributor's own effect ('neutralize-me') must NOT be enforced (it didn't fire).
    expect(
      result.policies[0]!.effects.some((e) => e.detail.controlObjectId === "neutralize-me")
    ).toBe(false);
  });

  it("CRITICAL #1a: a same-named contributor whose condition ERRORS does NOT drop a firing required contributor's effects (block still stands, satisfy the real control ⇒ allow)", async () => {
    const orgRequired: MatchedPolicy = {
      policyObjectId: "policy-org2",
      policyVersion: 1,
      name: "prod-security",
      enforcement: "required",
      condition: undefined,
      effects: [{ requireControls: ["security-scan"] }],
      matchedAt: { objectId: "org", depth: 0, via: "unscoped" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };
    const plantedBroken: MatchedPolicy = {
      policyObjectId: "policy-planted2",
      policyVersion: 1,
      name: "prod-security",
      enforcement: "advisory", // advisory broken condition annotates, never neutralizes
      condition: "this is : not valid CEL {{",
      effects: [{ requireControls: ["neutralize-me"] }],
      matchedAt: { objectId: "component", depth: 3, via: "objectRef" },
      emergencyPolicy: false,
      autoRollbackOnFailure: false
    };
    const [policy] = resolvePolicies([orgRequired, plantedBroken]);
    const blocked = await evaluateGovernance(sandbox(), [policy!], baseContext());
    expect(blocked.verdict).toBe("block"); // org required effect still enforced
    const allowed = await evaluateGovernance(
      sandbox(),
      [policy!],
      baseContext({ controlOutcomes: { "security-scan": "pass" } })
    );
    expect(allowed.verdict).toBe("allow");
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
      emergencyPolicy: false,
    autoRollbackOnFailure: false
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
