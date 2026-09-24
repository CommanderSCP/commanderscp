import { describe, expect, it } from "vitest";
import {
  AUTHORED_APPLICATION_PARAMETER as PLUGIN_PARAMETER,
  SCP_AUTHORED_LABEL_KEY as PLUGIN_LABEL_KEY
} from "@scp/plugin-argocd";
import { SCP_AUTHORED_LABEL_KEY } from "@scp/schemas";
import {
  AUTHORED_APPLICATION_PARAMETER,
  foldDns1123Label,
  renderAuthoredDeployment,
  rolloutStepsFor
} from "./deploy-lane-trigger-parameters.js";

/** M28.4 (ADR-0055): the pure half of the deploy lane — what SCP authors. */

describe("rolloutStepsFor — the wave plan's rollout, in Argo Rollouts' vocabulary", () => {
  it("a canary maps each weight to setWeight and each non-zero pause to a TIMED pause", () => {
    expect(
      rolloutStepsFor({
        strategy: "canary",
        steps: [
          { weightPercent: 10, pauseSeconds: 60 },
          { weightPercent: 50, pauseSeconds: 0 },
          { weightPercent: 100 }
        ]
      })
    ).toEqual({
      canary: {
        steps: [{ setWeight: 10 }, { pause: { duration: "60s" } }, { setWeight: 50 }, { setWeight: 100 }]
      }
    });
  });

  it("a rolling batch with no pause is Argo's step-less canary with a surge bound", () => {
    expect(rolloutStepsFor({ strategy: "rolling", batchPercent: 25 })).toEqual({
      canary: { maxSurge: "25%", maxUnavailable: 0 }
    });
  });

  it("a rolling batch WITH a pause climbs by the batch, pausing between", () => {
    expect(
      rolloutStepsFor({ strategy: "rolling", batchPercent: 40, pauseBetweenSeconds: 30 })
    ).toEqual({
      canary: {
        maxSurge: "40%",
        maxUnavailable: 0,
        steps: [
          { setWeight: 40 },
          { pause: { duration: "30s" } },
          { setWeight: 80 },
          { pause: { duration: "30s" } }
        ]
      }
    });
  });

  it("no declared rollout ⇒ a canary with no steps (an ordinary rolling update)", () => {
    expect(rolloutStepsFor(undefined)).toEqual({ canary: {} });
  });

  it("NEVER authors a pause only `promote` can release — for every strategy shape", () => {
    // ADR-0008 §3 forbids SCP the promote verb, so `pause: {}` would be a Rollout nobody may finish.
    const shapes = [
      rolloutStepsFor({ strategy: "canary", steps: [{ weightPercent: 5, pauseSeconds: 1 }] }),
      rolloutStepsFor({ strategy: "canary", steps: [{ weightPercent: 5 }] }),
      rolloutStepsFor({ strategy: "rolling", batchPercent: 10, pauseBetweenSeconds: 5 }),
      rolloutStepsFor({ strategy: "rolling", batchPercent: 10 })
    ];
    for (const shape of shapes) {
      for (const step of (shape.canary.steps as Record<string, unknown>[] | undefined) ?? []) {
        if ("pause" in step) expect(step.pause).toEqual({ duration: expect.stringMatching(/^\d+s$/) });
      }
    }
  });
});

describe("foldDns1123Label", () => {
  it("folds names deterministically into RFC 1123 labels", () => {
    expect(foldDns1123Label("Checkout API@prod (DOKS hosted)")).toBe("checkout-api-prod-doks-hosted");
    expect(foldDns1123Label("---")).toBe("scp");
  });
  it("keeps a hash of the whole when it must truncate, so two long names never collide", () => {
    const a = foldDns1123Label(`${"x".repeat(70)}-a`);
    const b = foldDns1123Label(`${"x".repeat(70)}-b`);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
  });
});

describe("renderAuthoredDeployment", () => {
  const rendered = renderAuthoredDeployment({
    applicationName: "checkout-gamma",
    rolloutName: "checkout",
    namespace: "shop",
    image: "ghcr.io/acme/checkout@sha256:" + "a".repeat(64),
    deployment: { image: "ghcr.io/acme/checkout:1.4.0", containerPort: 8080, replicas: 4 },
    strategy: { strategy: "canary", steps: [{ weightPercent: 20, pauseSeconds: 30 }, { weightPercent: 100 }] },
    source: { repoURL: "https://git.example/gitops.git", path: "charts/scp", targetRevision: "v1" },
    destination: { server: "https://kubernetes.default.svc" },
    componentObjectId: "c",
    targetObjectId: "t",
    changeObjectId: "ch"
  });

  it("carries the Rollout VERBATIM in the Application's values — what is asserted is what Argo CD applies", () => {
    const source = (rendered.application.spec as { source: Record<string, unknown> }).source;
    expect(source).toMatchObject({
      repoURL: "https://git.example/gitops.git",
      path: "charts/scp",
      targetRevision: "v1",
      helm: { valuesObject: { manifests: [rendered.rollout] } }
    });
    expect(rendered.application.spec).toMatchObject({
      project: "default",
      destination: { server: "https://kubernetes.default.svc", namespace: "shop" }
    });
    // SCP triggers every sync; an automated policy would let Argo CD release on its own.
    expect((rendered.application.spec as { syncPolicy: Record<string, unknown> }).syncPolicy).not.toHaveProperty(
      "automated"
    );
  });

  it("labels both manifests as SCP-authored — the plugin's only licence to update", () => {
    const appLabels = (rendered.application.metadata as { labels: Record<string, string> }).labels;
    const rolloutLabels = (rendered.rollout.metadata as { labels: Record<string, string> }).labels;
    expect(appLabels[SCP_AUTHORED_LABEL_KEY]).toBe("true");
    expect(rolloutLabels[SCP_AUTHORED_LABEL_KEY]).toBe("true");
  });

  it("pins the image and the wave plan's steps into the Rollout", () => {
    expect(rendered.rollout.spec).toMatchObject({
      replicas: 4,
      template: {
        spec: {
          containers: [
            {
              name: "checkout",
              image: "ghcr.io/acme/checkout@sha256:" + "a".repeat(64),
              ports: [{ containerPort: 8080 }]
            }
          ]
        }
      },
      strategy: {
        canary: { steps: [{ setWeight: 20 }, { pause: { duration: "30s" } }, { setWeight: 100 }] }
      }
    });
  });
});

describe("the plugin boundary's duplicated literals", () => {
  it("@scp/plugin-argocd's authored label is @scp/schemas' authored label", () => {
    expect(PLUGIN_LABEL_KEY).toBe(SCP_AUTHORED_LABEL_KEY);
  });
  it("the parameter the plugin reads is the one the deploy lane writes", () => {
    expect(PLUGIN_PARAMETER).toBe(AUTHORED_APPLICATION_PARAMETER);
  });
});
