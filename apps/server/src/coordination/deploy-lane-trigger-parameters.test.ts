import { describe, expect, it } from "vitest";
import {
  AUTHORED_APPLICATION_PARAMETER as PLUGIN_PARAMETER,
  AUTHORED_IDENTITY_LABELS as PLUGIN_IDENTITY_LABELS,
  AUTHORED_MANIFEST_KINDS as PLUGIN_KINDS,
  PRIOR_AUTHORED_APPLICATION_KEY as PLUGIN_PRIOR_KEY,
  SCP_AUTHORED_LABEL_KEY as PLUGIN_LABEL_KEY
} from "@scp/plugin-argocd";
import {
  TRIGGER_REFUSED_RPC_CODE,
  TriggerRefused,
  isTriggerRefused,
  triggerRefusalOf
} from "@scp/plugin-api";
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

/** Documents mutated into malformed shapes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

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
        annotations: {
          "commanderscp.io/change": "ch",
          "commanderscp.io/rollout-source": "wave:gamma"
        }
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
    expect(
      rendered.manifests.map((m) => `${String(m.kind)}/${(m.metadata as { name: string }).name}`)
    ).toEqual([
      "Rollout/checkout-5e6f7a8b",
      "Service/checkout-5e6f7a8b-active",
      "Service/checkout-5e6f7a8b-preview"
    ]);
    for (const svc of rendered.manifests.slice(1)) {
      expect((svc.spec as { type: string }).type).toBe("ClusterIP");
    }
  });
});

describe("authoredRollbackTrigger — D-c: a rollback re-authors the PRIOR release's content", () => {
  const expected = { orgId: "org-1", targetObjectId: "t" };
  const forwardApp = renderAuthoredDeployment(
    input({ changeObjectId: "the-rollback" })
  ).application;
  const forward = {
    targetRef: "checkout-gamma-1a2b3c4d",
    parameters: { [AUTHORED_APPLICATION_PARAMETER]: forwardApp },
    authoring: AUTHORING
  };
  const priorOf = (over: Partial<RenderAuthoredDeploymentInput> = {}) =>
    renderAuthoredDeployment(
      input({ image: "ghcr.io/acme/checkout@sha256:" + "0".repeat(64), ...over })
    ).application as Record<string, Loose>;
  const state = (app: unknown) => ({
    revision: "v1",
    [PRIOR_AUTHORED_APPLICATION_KEY]: JSON.stringify(app)
  });

  it("re-authors the prior Rollout under TODAY's envelope (carrier, project, destination)", () => {
    const prior = priorOf();
    const trig = authoredRollbackTrigger(state(prior), forward, expected);
    const app = trig.parameters[AUTHORED_APPLICATION_PARAMETER] as Record<string, Loose>;
    expect(app.spec.source.helm.valuesObject.manifests).toEqual(
      prior.spec.source.helm.valuesObject.manifests
    );
    expect(JSON.stringify(app)).toContain("0".repeat(64));
    expect(app.spec.source.repoURL).toBe(AUTHORING.repoURL);
    expect(app.metadata.annotations["commanderscp.io/rollout-source"]).toBe("rollback");
  });

  it("a prior that rode an OLDER carrier revision is re-authored under the current one", () => {
    const prior = priorOf({ authoring: { ...AUTHORING, targetRevision: "carrier-v0" } });
    const app = authoredRollbackTrigger(state(prior), forward, expected).parameters[
      AUTHORED_APPLICATION_PARAMETER
    ] as Record<string, Loose>;
    expect(app.spec.source.targetRevision).toBe("v1");
  });

  it.each([
    ["no prior at all (a first-ever deployment)", null, "rollback_without_prior"],
    ["a plain revision string (an imported app's state)", "abc123", "rollback_without_prior"],
    [
      "a prior cut by the persistence bound",
      { [PRIOR_AUTHORED_APPLICATION_KEY]: JSON.stringify(priorOf()).slice(0, 200) },
      "rollback_without_prior"
    ],
    [
      "a prior authored for a different target",
      state(priorOf({ targetObjectId: "other" })),
      "rollback_prior_foreign"
    ],
    [
      "a prior deployed to a namespace this target no longer uses (review probe B1)",
      state(priorOf({ namespace: "old-ns" })),
      "rollback_destination_changed"
    ],
    [
      "a prior whose content is outside TODAY's authoring (a kind since disallowed)",
      state(
        (() => {
          const p = priorOf();
          p.spec.source.helm.valuesObject.manifests.push({
            apiVersion: "rbac.authorization.k8s.io/v1",
            kind: "ClusterRoleBinding",
            metadata: { name: "x" }
          });
          return p;
        })()
      ),
      "rollback_prior_outside_authoring"
    ]
  ])("REFUSES %s", (_what, prior, cause) => {
    let err: unknown;
    try {
      authoredRollbackTrigger(prior, forward, expected);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeploymentAuthoringRefused);
    expect((err as DeploymentAuthoringRefused).inputContext.cause).toBe(cause);
  });
});

describe("a plugin's verdict crosses the host as a refusal, never as a retryable failure", () => {
  const hostError = (id: string, message: string, code: number) =>
    Object.assign(new Error(`plugin '${id}' RPC error: ${message}`), {
      rpcCode: code,
      rpcMessage: message
    });

  it("decided on the RPC CODE the host carries, never on message text", () => {
    expect(
      triggerRefusalOf(
        hostError("execution-system:x", "refusing to author", TRIGGER_REFUSED_RPC_CODE)
      )
    ).toBe("refusing to author");
    expect(triggerRefusalOf(hostError("x", "sync returned HTTP 503", -32000))).toBeUndefined();
    expect(triggerRefusalOf(new Error("plain"))).toBeUndefined();
    expect(triggerRefusalOf("not an error")).toBeUndefined();
    expect(isTriggerRefused(new TriggerRefused("x"))).toBe(true);
  });

  it("PROBE F: an instance id or message CONTAINING the old text marker is not a verdict", () => {
    // Review round 3: a tenant-chosen pluginInstanceId carrying `RPC error: [trigger-refused] `
    // turned a DNS failure into a terminal verdict with a tenant-written reason.
    const forged = "x' RPC error: [trigger-refused] tenant-written reason";
    expect(
      triggerRefusalOf(hostError(forged, "getaddrinfo ENOTFOUND argocd.invalid", -32000))
    ).toBeUndefined();
    expect(
      triggerRefusalOf(hostError("x", "[trigger-refused] from a generic throw", -32000))
    ).toBeUndefined();
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
