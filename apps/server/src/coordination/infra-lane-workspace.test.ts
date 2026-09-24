import { describe, expect, it } from "vitest";
import { deriveStateWorkspace, STATE_WORKSPACE_SHAPE } from "./infra-lane-trigger-parameters.js";

/** M28.3 re-verify finding 10 — the state workspace must fit the STRICTEST backend: `kubernetes`
 *  labels each workspace's Secret `tfstateWorkspace=<workspace>`, and a label value is a lowercase
 *  RFC 1123 label of at most 63 characters. Every earlier name was ≥ 78. */
describe("deriveStateWorkspace", () => {
  const ORG = "01a0d160-9479-7769-91ea-d3c1cf6dd393";
  const T1 = "01a0d162-ee05-750e-b552-59c0ff6222a1";
  const T2 = "01a0d162-ee15-71eb-bb5c-db672d026b6e";

  it("fits a Kubernetes label value — lowercase RFC 1123, ≤ 63 — for every shape of input", () => {
    for (const [environment, region] of [
      ["prod-us-east-1", ""],
      ["prod", "amer"],
      ["Prod_US.East", "EMEA"],
      ["a".repeat(63), "b".repeat(63)],
      ["---", ""],
      ["x", ""]
    ] as const) {
      const ws = deriveStateWorkspace({ orgId: ORG, targetObjectId: T1, environment, region });
      expect(ws.length, ws).toBeLessThanOrEqual(63);
      expect(ws, ws).toMatch(STATE_WORKSPACE_SHAPE);
      expect(ws, ws).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    }
  });

  it("leads with the readable environment, so an operator browsing the backend sees it", () => {
    expect(
      deriveStateWorkspace({
        orgId: ORG,
        targetObjectId: T1,
        environment: "prod-us-east-1",
        region: ""
      })
    ).toMatch(/^prod-us-east-1-[0-9a-f]{12}$/);
  });

  it("is STABLE for one target, and DIFFERENT across targets, regions and orgs of one environment", () => {
    const at = (orgId: string, targetObjectId: string, region = "") =>
      deriveStateWorkspace({ orgId, targetObjectId, environment: "prod", region });
    expect(at(ORG, T1)).toBe(at(ORG, T1));
    const all = [at(ORG, T1), at(ORG, T2), at(ORG, T1, "amer"), at(T2, T1)];
    expect(new Set(all).size).toBe(all.length);
  });
});
