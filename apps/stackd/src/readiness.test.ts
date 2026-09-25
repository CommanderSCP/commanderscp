import { describe, expect, it } from "vitest";
import type { KubeObject } from "./manifests.js";
import { workloadVerdict } from "./readiness.js";

/** `kubectl rollout status`'s rules — including the shape the kind suite caught a looser rule on. */

function dep(status: Record<string, unknown>, replicas = 1, generation = 2): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "controller-manager", namespace: "scp-argo-events", generation },
    spec: { replicas },
    status
  };
}

describe("workloadVerdict", () => {
  it("a completed rollout is ready", () => {
    expect(
      workloadVerdict(
        dep({ observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1 })
      ).ready
    ).toBe(true);
  });

  it("MEASURED ON KIND: a stalled rollout over a still-available old pod is NOT ready", () => {
    // One replica rolling to an image that never pulls: maxUnavailable rounds to 0, so the old pod
    // keeps serving (available 1) while the new one (updated 1) sits in ImagePullBackOff.
    const v = workloadVerdict(
      dep({ observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1 })
    );
    expect(v.ready).toBe(false);
    expect(v.line).toContain("1 old pending termination");
  });

  it("an unobserved generation is not ready, whatever the counts say", () => {
    expect(
      workloadVerdict(
        dep({ observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 })
      ).ready
    ).toBe(false);
  });

  it("updated but not yet available is not ready", () => {
    expect(
      workloadVerdict(
        dep({ observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 0 })
      ).ready
    ).toBe(false);
  });

  it("a StatefulSet mid-revision is not ready even with every replica ready", () => {
    const sts: KubeObject = {
      ...dep({
        observedGeneration: 2,
        replicas: 1,
        readyReplicas: 1,
        updatedReplicas: 1,
        currentRevision: "a",
        updateRevision: "b"
      }),
      kind: "StatefulSet"
    };
    expect(workloadVerdict(sts).ready).toBe(false);
    (sts["status"] as { currentRevision: string }).currentRevision = "b";
    expect(workloadVerdict(sts).ready).toBe(true);
  });

  it("a DaemonSet is ready when every scheduled pod is updated and available", () => {
    const ds: KubeObject = {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name: "d", namespace: "n", generation: 1 },
      status: {
        observedGeneration: 1,
        desiredNumberScheduled: 2,
        updatedNumberScheduled: 2,
        numberAvailable: 1
      }
    };
    expect(workloadVerdict(ds).ready).toBe(false);
    (ds["status"] as { numberAvailable: number }).numberAvailable = 2;
    expect(workloadVerdict(ds).ready).toBe(true);
  });
});
