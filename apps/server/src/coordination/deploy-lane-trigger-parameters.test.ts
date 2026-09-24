import { describe, expect, it } from "vitest";
import {
  AUTHORED_APPLICATION_PARAMETER as PLUGIN_PARAMETER,
  AUTHORED_IDENTITY_LABELS as PLUGIN_IDENTITY_LABELS,
  AUTHORED_MANIFEST_KINDS as PLUGIN_KINDS,
  PRIOR_AUTHORED_APPLICATION_KEY as PLUGIN_PRIOR_KEY,
  SCP_AUTHORED_LABEL_KEY as PLUGIN_LABEL_KEY
} from "@scp/plugin-argocd";
import { AUTHORED_MANIFEST_KINDS, SCP_AUTHORED_LABEL_KEY } from "@scp/schemas";
import {
  AUTHORED_APPLICATION_PARAMETER,
  AUTHORED_IDENTITY_LABELS,
  DeploymentAuthoringRefused,
  PRIOR_AUTHORED_APPLICATION_KEY,
  authoredRollbackTrigger,
  foldDns1123Label,
  nameWithIdentity,
  renderAuthoredDeployment,
  rolloutStrategyFor,
  type RenderAuthoredDeploymentInput
} from "./deploy-lane-trigger-parameters.js";

/** M28.4 (ADR-0055): the pure half of the deploy lane — what SCP authors. */

const AUTHORING = {
  repoURL: "https://gitea.example/gitops.git",
  path: "charts/scp",
  targetRevision: "v1",
  project: "scp-authored",
  namespaces: ["shop"]
};

function input(over: Partial<RenderAuthoredDeploymentInput> = {}): RenderAuthoredDeploymentInput {
  return {
    orgId: "org-1",
    applicationName: "checkout-gamma-1a2b3c4d",
    rolloutName: "checkout-5e6f7a8b",
    namespace: "shop",
    image: "ghcr.io/acme/checkout@sha256:" + "a".repeat(64),
    deployment: { image: "ghcr.io/acme/checkout:1.4.0", containerPort: 8080, replicas: 4 },
    strategy: {
      strategy: "canary",
      steps: [{ weightPercent: 20, pauseSeconds: 30 }, { weightPercent: 100 }]
    },
    rolloutSource: "wave:gamma",
    authoring: AUTHORING,
    destination: { server: "https://kubernetes.default.svc" },
    componentObjectId: "c",
    targetObjectId: "t",
    changeObjectId: "ch",
    ...over
  };
}

describe("rolloutStrategyFor — the declared rollout, in Argo Rollouts' vocabulary", () => {
  it("a canary maps each weight to setWeight and each non-zero pause to a TIMED pause", () => {
    expect(
      rolloutStrategyFor({
        strategy: "canary",
        steps: [
          { weightPercent: 10, pauseSeconds: 60 },
          { weightPercent: 50, pauseSeconds: 0 },
          { weightPercent: 100 }
        ]
      })
    ).toEqual({
      canary: {
        steps: [
          { setWeight: 10 },
          { pause: { duration: "60s" } },
          { setWeight: 50 },
          { setWeight: 100 }
        ]
      }
    });
  });

  it("a rolling batch with no pause is Argo's step-less canary with a surge bound", () => {
    expect(rolloutStrategyFor({ strategy: "rolling", batchPercent: 25 })).toEqual({
      canary: { maxSurge: "25%", maxUnavailable: 0 }
    });
  });

  it("a rolling batch WITH a pause climbs by the batch, pausing between", () => {
    expect(
      rolloutStrategyFor({ strategy: "rolling", batchPercent: 40, pauseBetweenSeconds: 30 })
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

  it("blue-green ALWAYS auto-promotes (owner D-b) — SCP never promotes", () => {
    expect(
      rolloutStrategyFor(
        { strategy: "blueGreen", autoPromotionSeconds: 120 },
        { active: "a", preview: "p" }
      )
    ).toEqual({
      blueGreen: {
        activeService: "a",
        previewService: "p",
        autoPromotionEnabled: true,
        autoPromotionSeconds: 120
      }
    });
  });

  it("no declared rollout ⇒ a canary with no steps (an ordinary rolling update)", () => {
    expect(rolloutStrategyFor(undefined)).toEqual({ canary: {} });
  });

  it("NEVER authors a pause only `promote` can release — for every canary/rolling shape", () => {
    const shapes = [
      rolloutStrategyFor({ strategy: "canary", steps: [{ weightPercent: 5, pauseSeconds: 1 }] }),
      rolloutStrategyFor({ strategy: "canary", steps: [{ weightPercent: 5 }] }),
      rolloutStrategyFor({ strategy: "rolling", batchPercent: 10, pauseBetweenSeconds: 5 }),
      rolloutStrategyFor({ strategy: "rolling", batchPercent: 10 })
    ];
    for (const shape of shapes) {
      const steps = (shape.canary as { steps?: Record<string, unknown>[] }).steps ?? [];
      for (const step of steps) {
        if ("pause" in step) {
          expect(step.pause).toEqual({ duration: expect.stringMatching(/^[1-9]\d*s$/) });
        }
      }
    }
  });
});

describe("names are collision-free (finding 6)", () => {
  it("folds deterministically into RFC 1123 labels", () => {
    expect(foldDns1123Label("Checkout API@prod (DOKS hosted)")).toBe(
      "checkout-api-prod-doks-hosted"
    );
  });

  it("two component/place pairs whose display names fold EQUAL get DIFFERENT names", () => {
    // `ca-eu` at `west` and `ca` at `eu-west` both fold to `ca-eu-west`.
    expect(foldDns1123Label("ca-eu-west")).toBe(foldDns1123Label("ca-eu-west"));
    const a = nameWithIdentity("ca-eu-west", "component-A:placement-1");
    const b = nameWithIdentity("ca-eu-west", "component-B:placement-2");
    expect(a).not.toBe(b);
    expect(a.startsWith("ca-eu-west-")).toBe(true);
  });

  it("stays within the length bound and starts with a letter (a valid Service name)", () => {
    const long = nameWithIdentity("9".repeat(80), "x", 55);
    expect(long.length).toBeLessThanOrEqual(55);
    expect(long).toMatch(/^[a-z][-a-z0-9]*[a-z0-9]$/);
    expect(`${long}-preview`.length).toBeLessThanOrEqual(63);
  });
});

describe("renderAuthoredDeployment", () => {
  it("renders EXACTLY this Application — every field pinned, nothing inferred", () => {
    const rendered = renderAuthoredDeployment(input());
    const rolloutLabels = {
      "app.kubernetes.io/name": "checkout-5e6f7a8b",
      "app.kubernetes.io/managed-by": "commanderscp",
      [SCP_AUTHORED_LABEL_KEY]: "true"
    };
    const rollout = {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Rollout",
      metadata: {
        name: "checkout-5e6f7a8b",
        namespace: "shop",
        labels: rolloutLabels,
        annotations: { "commanderscp.io/change": "ch" }
      },
      spec: {
        replicas: 4,
        revisionHistoryLimit: 3,
        selector: { matchLabels: { "app.kubernetes.io/name": "checkout-5e6f7a8b" } },
        template: {
          metadata: { labels: { "app.kubernetes.io/name": "checkout-5e6f7a8b" } },
          spec: {
            containers: [
              {
                name: "app",
                image: "ghcr.io/acme/checkout@sha256:" + "a".repeat(64),
                ports: [{ containerPort: 8080 }]
              }
            ]
          }
        },
        strategy: {
          canary: { steps: [{ setWeight: 20 }, { pause: { duration: "30s" } }, { setWeight: 100 }] }
        }
      }
    };
    // toEqual on the WHOLE document: an added `paused: true`, an extra annotation or a
    // CreateNamespace option anywhere turns this red (finding 4, the server-side half).
    expect(rendered.application).toEqual({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Application",
      metadata: {
        name: "checkout-gamma-1a2b3c4d",
        labels: {
          "app.kubernetes.io/managed-by": "commanderscp",
          [SCP_AUTHORED_LABEL_KEY]: "true",
          "commanderscp.io/org": "org-1",
          "commanderscp.io/component": "c",
          "commanderscp.io/target": "t"
        },
        annotations: { "commanderscp.io/change": "ch", "commanderscp.io/rollout-source": "wave:gamma" }
      },
      spec: {
        project: "scp-authored",
        destination: { server: "https://kubernetes.default.svc", namespace: "shop" },
        source: {
          repoURL: "https://gitea.example/gitops.git",
          path: "charts/scp",
          targetRevision: "v1",
          helm: { valuesObject: { manifests: [rollout] } }
        },
        syncPolicy: {}
      }
    });
    expect(rendered.manifests).toEqual([rollout]);
  });

  it("blue-green carries the Rollout AND its two ClusterIP Services, nothing else", () => {
    const rendered = renderAuthoredDeployment(
      input({ strategy: { strategy: "blueGreen", autoPromotionSeconds: 60 } })
    );
    expect(rendered.manifests.map((m) => `${String(m.kind)}/${(m.metadata as { name: string }).name}`)).toEqual([
      "Rollout/checkout-5e6f7a8b",
      "Service/checkout-5e6f7a8b-active",
      "Service/checkout-5e6f7a8b-preview"
    ]);
    for (const svc of rendered.manifests.slice(1)) {
      expect((svc.spec as { type: string }).type).toBe("ClusterIP");
    }
  });
});

describe("authoredRollbackTrigger — D-c: a rollback re-authors the PRIOR manifest", () => {
  const forward = { targetRef: "app-x", parameters: { [AUTHORED_APPLICATION_PARAMETER]: {} } };
  const expected = { orgId: "org-1", targetObjectId: "t" };
  const prior = renderAuthoredDeployment(input({ changeObjectId: "earlier" })).application;

  it("re-authors exactly the recorded prior Application", () => {
    const trig = authoredRollbackTrigger(
      { revision: "v1", [PRIOR_AUTHORED_APPLICATION_KEY]: JSON.stringify(prior) },
      forward,
      expected
    );
    expect(trig.targetRef).toBe("checkout-gamma-1a2b3c4d");
    expect(trig.parameters[AUTHORED_APPLICATION_PARAMETER]).toEqual(prior);
  });

  it.each([
    ["no prior at all (a first-ever deployment)", null],
    ["a plain revision string (an imported app's state)", "abc123"],
    ["a prior cut by the persistence bound", { [PRIOR_AUTHORED_APPLICATION_KEY]: JSON.stringify(prior).slice(0, 200) }]
  ])("REFUSES with %s", (_what, state) => {
    expect(() => authoredRollbackTrigger(state, forward, expected)).toThrow(DeploymentAuthoringRefused);
    try {
      authoredRollbackTrigger(state, forward, expected);
    } catch (err) {
      expect((err as DeploymentAuthoringRefused).inputContext.cause).toBe("rollback_without_prior");
    }
  });

  it("REFUSES a prior authored for a different target", () => {
    const foreign = renderAuthoredDeployment(input({ targetObjectId: "other" })).application;
    expect(() =>
      authoredRollbackTrigger(
        { [PRIOR_AUTHORED_APPLICATION_KEY]: JSON.stringify(foreign) },
        forward,
        expected
      )
    ).toThrow(/not authored by CommanderSCP for this target/);
  });
});

describe("the plugin boundary's duplicated literals", () => {
  it("label, parameter, prior-state key, identity labels and kinds are the same on both sides", () => {
    expect(PLUGIN_LABEL_KEY).toBe(SCP_AUTHORED_LABEL_KEY);
    expect(PLUGIN_PARAMETER).toBe(AUTHORED_APPLICATION_PARAMETER);
    expect(PLUGIN_PRIOR_KEY).toBe(PRIOR_AUTHORED_APPLICATION_KEY);
    expect([...PLUGIN_IDENTITY_LABELS]).toEqual([...AUTHORED_IDENTITY_LABELS]);
    expect(PLUGIN_KINDS).toEqual(AUTHORED_MANIFEST_KINDS);
  });
});
