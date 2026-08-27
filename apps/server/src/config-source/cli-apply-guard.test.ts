import { describe, expect, it } from "vitest";
import { evaluateCliApplyOwnership } from "./cli-apply-guard.js";

describe("evaluateCliApplyOwnership (D7 single-ownership predicate)", () => {
  it("allows a direct CLI apply when the stack is not bound to a config source", () => {
    expect(evaluateCliApplyOwnership(null)).toEqual({ allowed: true });
  });

  it("refuses a direct CLI apply for a repo-owned stack, naming the owning config source", () => {
    const decision = evaluateCliApplyOwnership({
      configSourceId: "cs-1",
      configSourceName: "payments-fleet"
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("repo_owned");
    expect(decision.configSourceId).toBe("cs-1");
    expect(decision.configSourceName).toBe("payments-fleet");
    expect(decision.message).toContain("payments-fleet");
    expect(decision.message).toContain("cs-1");
  });

  it("returns to CLI-push once the binding is removed (binding becomes null)", () => {
    const bound = evaluateCliApplyOwnership({ configSourceId: "cs-1", configSourceName: "x" });
    expect(bound.allowed).toBe(false);
    const unbound = evaluateCliApplyOwnership(null);
    expect(unbound).toEqual({ allowed: true });
  });
});
