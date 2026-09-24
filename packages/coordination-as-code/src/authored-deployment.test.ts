import { describe, expect, it } from "vitest";
import { Component, ReleaseTopology, Service, Stack } from "./index.js";
import { normalizeWaveItems } from "./waves.js";

/** M28.4 (ADR-0055): the IaC door for an SCP-authored deployment and its wave-plan steps. */
describe("Coordination as Code — authored deployments", () => {
  it("Component `deployment` lands on properties.deployment, beside the component's own properties", () => {
    const stack = new Stack("shop");
    const svc = new Service(stack, "shop", { name: "Shop" });
    new Component(stack, "checkout", {
      name: "checkout",
      service: svc,
      properties: { tier: "critical" },
      deployment: { image: "ghcr.io/acme/checkout:1.4.0", containerPort: 8080, replicas: 4 }
    });
    const obj = stack.synth().objects.find((o) => o.typeId === "component");
    expect(obj?.properties).toEqual({
      tier: "critical",
      deployment: { image: "ghcr.io/acme/checkout:1.4.0", containerPort: 8080, replicas: 4 }
    });
  });

  it("a Component with no `deployment` emits none — import-and-coordinate is the default", () => {
    const stack = new Stack("shop");
    const svc = new Service(stack, "shop", { name: "Shop" });
    new Component(stack, "checkout", { name: "checkout", service: svc });
    const obj = stack.synth().objects.find((o) => o.typeId === "component");
    expect(obj?.properties ?? {}).not.toHaveProperty("deployment");
  });

  it("ReleaseTopology carries each wave's `rollout` verbatim", () => {
    const stack = new Stack("shop");
    const rollout = {
      strategy: "canary" as const,
      steps: [{ weightPercent: 10, pauseSeconds: 60 }, { weightPercent: 100 }]
    };
    new ReleaseTopology(stack, "gamma-then-prod", {
      name: "gamma-then-prod",
      waves: [
        { name: "gamma", mode: "parallel", targets: ["urn:scp:x:deployment-target:gamma"] },
        { name: "prod", mode: "parallel", targets: ["urn:scp:x:deployment-target:prod"], rollout }
      ]
    });
    const topo = stack.synth().objects.find((o) => o.typeId === "release-topology");
    const waves = (topo?.properties as { waves: Record<string, unknown>[] }).waves;
    expect(waves[0]).not.toHaveProperty("rollout");
    expect(waves[1]!.rollout).toEqual(rollout);
  });

  it("a pipeline's wave item keeps `rollout` through normalisation", () => {
    const rollout = { strategy: "rolling" as const, batchPercent: 25 };
    expect(normalizeWaveItems([{ name: "prod", targets: ["p"], rollout }])).toEqual([
      { name: "prod", mode: "parallel", targets: ["p"], rollout }
    ]);
  });
});
