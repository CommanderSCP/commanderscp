/** M28.4 (ADR-0055): the create half of import-or-create, and ADR-0008 §3 as a standing test. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { startArgoCdStandIn, type ArgoCdStandIn } from "@scp/plugin-testkit";
import {
  AUTHORED_APPLICATION_PARAMETER,
  PRIOR_AUTHORED_APPLICATION_KEY,
  SCP_AUTHORED_LABEL_KEY,
  createArgoCdExecutorPlugin
} from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

/** Test documents are deliberately mutated into every malformed shape the guard must refuse. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const AUTHORING = {
  repoURL: "https://gitea.example/platform/gitops.git",
  path: "charts/scp-authored-manifests",
  targetRevision: "v1",
  project: "scp-authored",
  namespaces: ["shop"]
};

const IDENTITY = {
  "commanderscp.io/org": "org-1",
  "commanderscp.io/component": "component-1",
  "commanderscp.io/target": "target-1"
};

/** A FRESH Rollout per call — tests mutate what they are handed (finding 10). */
function rollout(
  steps: unknown[] = [{ setWeight: 10 }, { pause: { duration: "60s" } }, { setWeight: 100 }]
) {
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    metadata: { name: "checkout", namespace: "shop", labels: { [SCP_AUTHORED_LABEL_KEY]: "true" } },
    spec: {
      selector: { matchLabels: { "app.kubernetes.io/name": "checkout" } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "checkout" } },
        spec: { containers: [{ name: "app", image: "ghcr.io/acme/checkout:1.4.0" }] }
      },
      strategy: { canary: { steps } }
    }
  };
}

function authoredApplication(
  name: string,
  opts: { labels?: Record<string, string>; manifests?: unknown[]; tweak?: (d: Loose) => void } = {}
) {
  const doc: Loose = {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name,
      labels: { [SCP_AUTHORED_LABEL_KEY]: "true", ...IDENTITY, ...(opts.labels ?? {}) } as Record<
        string,
        string
      >
    },
    spec: {
      project: "scp-authored",
      destination: { server: "https://kubernetes.default.svc", namespace: "shop" },
      source: {
        repoURL: AUTHORING.repoURL,
        path: AUTHORING.path,
        targetRevision: AUTHORING.targetRevision,
        helm: { valuesObject: { manifests: opts.manifests ?? [rollout()] } }
      },
      syncPolicy: {}
    }
  };
  opts.tweak?.(doc);
  return doc;
}

let standIn: ArgoCdStandIn;
let stateDir: string;
let ctx: PluginContext;

function ctxWith(authoring: unknown): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config: {
      serverUrl: standIn.url,
      token: "t",
      statePath: join(stateDir, "state.json"),
      ...(authoring !== undefined ? { authoring } : {})
    }
  };
}

beforeEach(async () => {
  standIn = await startArgoCdStandIn();
  stateDir = await mkdtemp(join(tmpdir(), "argocd-authored-"));
  ctx = ctxWith(AUTHORING);
});

afterEach(async () => {
  await standIn.close();
  await rm(stateDir, { recursive: true, force: true });
});

const writes = () => standIn.requests.filter((r) => r.method !== "GET");

async function authorAndSync(doc: unknown, key = "wt-1", c: PluginContext = ctx) {
  return createArgoCdExecutorPlugin().trigger(c, {
    kind: "sync",
    targetRef: "checkout-gamma",
    idempotencyKey: key,
    parameters: { [AUTHORED_APPLICATION_PARAMETER]: doc }
  });
}

describe("argocd trigger — an SCP-authored Application", () => {
  it("CREATES an Application that does not exist, sends EXACTLY the document it was given, then syncs", async () => {
    const doc = authoredApplication("checkout-gamma");
    await authorAndSync(structuredClone(doc));

    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/applications",
      "POST /api/v1/applications/checkout-gamma/sync"
    ]);
    // EXACT, not toMatchObject: a plugin that rewrote one field of the Rollout (paused, steps) on
    // its way out is caught here even if the stand-in's own content check misses it.
    expect(standIn.authoredBodies).toEqual([doc]);
    // Written by the stand-in's CONTROLLER on sync, from the Application's values — never by SCP.
    expect(standIn.cluster.get("Rollout/shop/checkout")?.spec).toEqual(rollout().spec);
    expect(standIn.violations).toEqual([]);
  });

  it("UPDATES an Application SCP authored earlier for the SAME org/component/target, through the same door", async () => {
    standIn.seed(authoredApplication("checkout-gamma"));
    await authorAndSync(authoredApplication("checkout-gamma"), "wt-2");
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/applications?upsert=true",
      "POST /api/v1/applications/checkout-gamma/sync"
    ]);
  });

  it("REFUSES to overwrite an Application somebody else authored — no write reaches Argo CD", async () => {
    const theirs = authoredApplication("checkout-gamma");
    delete theirs.metadata.labels[SCP_AUTHORED_LABEL_KEY];
    standIn.seed(theirs);
    await expect(authorAndSync(authoredApplication("checkout-gamma"), "wt-3")).rejects.toThrow(
      /was not authored by CommanderSCP/
    );
    expect(writes()).toEqual([]);
  });

  it.each(["commanderscp.io/org", "commanderscp.io/component", "commanderscp.io/target"])(
    "REFUSES to overwrite an Application SCP authored for a different %s (a name collision)",
    async (label) => {
      standIn.seed(authoredApplication("checkout-gamma", { labels: { [label]: "someone-else" } }));
      await expect(authorAndSync(authoredApplication("checkout-gamma"), "wt-4")).rejects.toThrow(
        /for a different org, component or target/
      );
      expect(writes()).toEqual([]);
    }
  );

  it("refuses an authored document that does not name the trigger's Application, or lacks the labels", async () => {
    await expect(authorAndSync(authoredApplication("someone-else"))).rejects.toThrow(
      /named 'checkout-gamma'/
    );
    const unlabelled = authoredApplication("checkout-gamma");
    unlabelled.metadata.labels = {};
    await expect(authorAndSync(unlabelled, "wt-5")).rejects.toThrow(
      /must carry commanderscp.io\/authored=true/
    );
    const anonymous = authoredApplication("checkout-gamma");
    delete anonymous.metadata.labels["commanderscp.io/target"];
    await expect(authorAndSync(anonymous, "wt-6")).rejects.toThrow(
      /must name its org, component and target/
    );
    expect(standIn.requests).toEqual([]);
  });

  it("declares D12 rollout authority `triggerParams` for clusters — never `authoritative`", () => {
    expect(createArgoCdExecutorPlugin().describeCapabilities().rollout).toEqual({
      authority: "triggerParams",
      targetClasses: ["cluster"]
    });
  });
});

describe("the second layer — only a carrier render the operator declared is ever written (finding 1/2)", () => {
  const cases: [string, (d: Loose) => void, RegExp][] = [
    [
      "a foreign source repository",
      (d) => (d.spec.source.repoURL = "https://evil.example/x.git"),
      /not the registered carrier/
    ],
    [
      "a floating carrier revision",
      (d) => (d.spec.source.targetRevision = "HEAD"),
      /not the registered carrier/
    ],
    [
      "the unscoped default project",
      (d) => (d.spec.project = "default"),
      /not the authoring project/
    ],
    [
      "kube-system",
      (d) => (d.spec.destination.namespace = "kube-system"),
      /not in the authoring allowlist/
    ],
    [
      "an un-allowlisted namespace",
      (d) => (d.spec.destination.namespace = "payments"),
      /not in the authoring allowlist/
    ],
    [
      "CreateNamespace",
      (d) => (d.spec.syncPolicy = { syncOptions: ["CreateNamespace=true"] }),
      /syncPolicy must be empty/
    ],
    [
      "an automated sync policy",
      (d) => (d.spec.syncPolicy = { automated: {} }),
      /syncPolicy must be empty/
    ],
    [
      "helm.values text beside valuesObject",
      (d) => (d.spec.source.helm.values = "x: 1"),
      /helm.values is not a field/
    ],
    [
      "a finalizer",
      (d) => (d.metadata.finalizers = ["resources-finalizer.argocd.argoproj.io"]),
      /metadata.finalizers is not a field/
    ],
    [
      "a ClusterRoleBinding in the values",
      (d) =>
        d.spec.source.helm.valuesObject.manifests.push({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "ClusterRoleBinding",
          metadata: { name: "pwn" },
          roleRef: { kind: "ClusterRole", name: "cluster-admin" }
        }),
      /ClusterRoleBinding .* carries only Rollout and Service/
    ],
    [
      "a manifest in another namespace",
      (d) => (d.spec.source.helm.valuesObject.manifests[0].metadata.namespace = "kube-system"),
      /lands in namespace 'kube-system'/
    ],
    [
      "spec.paused",
      (d) => (d.spec.source.helm.valuesObject.manifests[0].spec.paused = true),
      /would pause the Rollout/
    ],
    [
      "an indefinite pause",
      (d) =>
        (d.spec.source.helm.valuesObject.manifests[0].spec.strategy.canary.steps[1] = {
          pause: {}
        }),
      /indefinite pause waits for `promote`/
    ],
    [
      "a status block",
      (d) => (d.spec.source.helm.valuesObject.manifests[0].status = { abort: true }),
      /status is not a field/
    ],
    [
      "an analysis step",
      (d) =>
        d.spec.source.helm.valuesObject.manifests[0].spec.strategy.canary.steps.push({
          analysis: {}
        }),
      /analysis is not a field/
    ],
    [
      "a privileged pod",
      (d) => (d.spec.source.helm.valuesObject.manifests[0].spec.template.spec.hostNetwork = true),
      /hostNetwork is not a field/
    ],
    [
      "blue-green that waits for promote",
      (d) =>
        (d.spec.source.helm.valuesObject.manifests[0].spec.strategy = {
          blueGreen: { activeService: "a", previewService: "b", autoPromotionEnabled: false }
        }),
      /must auto-promote/
    ],
    [
      "a LoadBalancer Service",
      (d) =>
        d.spec.source.helm.valuesObject.manifests.push({
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "x", namespace: "shop" },
          spec: { type: "LoadBalancer", ports: [] }
        }),
      /must be ClusterIP/
    ]
  ];

  it.each(cases)("refuses %s — before any write", async (_what, tweak, message) => {
    await expect(authorAndSync(authoredApplication("checkout-gamma", { tweak }))).rejects.toThrow(
      message
    );
    expect(standIn.requests).toEqual([]);
  });

  it("refuses to author at all into an Argo CD that declares no authoring (import-and-coordinate only)", async () => {
    await expect(
      authorAndSync(authoredApplication("checkout-gamma"), "wt-7", ctxWith(undefined))
    ).rejects.toThrow(/declares no usable `authoring`/);
    expect(standIn.requests).toEqual([]);
  });

  it("refuses an authoring declaration naming the unscoped `default` project", async () => {
    await expect(
      authorAndSync(
        authoredApplication("checkout-gamma"),
        "wt-8",
        ctxWith({ ...AUTHORING, project: "default" })
      )
    ).rejects.toThrow(/declares no usable `authoring`/);
  });
});

describe("a Rollout that is not fully promoted is NOT a finished deploy (finding 5)", () => {
  async function deployed() {
    const plugin = createArgoCdExecutorPlugin();
    const ref = await authorAndSync(authoredApplication("checkout-gamma"));
    return { plugin, ref };
  }

  it("paused at step 1 of 3 ⇒ running", async () => {
    const { plugin, ref } = await deployed();
    standIn.setRolloutProgress("checkout-gamma", { phase: "Paused", step: 1 });
    const s = await plugin.status(ctx, ref);
    expect(s.phase).toBe("running");
    expect(s.observed?.rollout).toMatchObject({ step: 1, stepCount: 3, phase: "Paused" });
  });

  it("Progressing ⇒ running; Degraded (also an aborted Rollout) ⇒ failed", async () => {
    const { plugin, ref } = await deployed();
    standIn.setRolloutProgress("checkout-gamma", { phase: "Progressing", step: 2 });
    expect((await plugin.status(ctx, ref)).phase).toBe("running");
    standIn.setRolloutProgress("checkout-gamma", { phase: "Degraded", step: 2 });
    expect((await plugin.status(ctx, ref)).phase).toBe("failed");
  });

  it("Healthy but short of the last step ⇒ still running; Healthy at full promotion ⇒ succeeded", async () => {
    const { plugin, ref } = await deployed();
    standIn.setRolloutProgress("checkout-gamma", { phase: "Healthy", step: 2 });
    expect((await plugin.status(ctx, ref)).phase).toBe("running");
    standIn.setRolloutProgress("checkout-gamma", undefined);
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });

  it("a FORWARD re-author waits while the prior canary is in flight; a ROLLBACK does not", async () => {
    await deployed();
    standIn.setRolloutProgress("checkout-gamma", { phase: "Paused", step: 1 });
    const before = writes().length;
    await expect(authorAndSync(authoredApplication("checkout-gamma"), "wt-next")).rejects.toThrow(
      /still in flight/
    );
    expect(writes().length).toBe(before);

    await createArgoCdExecutorPlugin().trigger(ctx, {
      kind: "rollback",
      targetRef: "checkout-gamma",
      idempotencyKey: "wt-rollback",
      parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("checkout-gamma") }
    });
    const rollbackWrites = writes().slice(before);
    expect(rollbackWrites.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/applications?upsert=true",
      "POST /api/v1/applications/checkout-gamma/sync"
    ]);
    // The re-authored manifest is what gets applied — the sync names no revision to go back to.
    expect(rollbackWrites[1]!.body).toEqual({});
  });

  it("an authored Application reports its own manifest as state, so the next trigger can record it for rollback (D-c)", async () => {
    const { plugin, ref } = await deployed();
    const s = await plugin.status(ctx, ref);
    const state = s.stateRef as Record<string, unknown>;
    expect(state.revision).toBe("v1");
    expect(JSON.parse(state[PRIOR_AUTHORED_APPLICATION_KEY] as string)).toEqual(
      authoredApplication("checkout-gamma")
    );
  });
});

describe("ADR-0008 §3 — after creation, SCP ONLY READS a Rollout (standing test)", () => {
  it("every verb the plugin has, driven against an authored Rollout, writes nothing but the four allowed shapes", async () => {
    const plugin = createArgoCdExecutorPlugin();
    const ref = await authorAndSync(authoredApplication("checkout-gamma"), "wt-9");
    const writesAtCreation = writes().length;

    // Everything SCP does with a Rollout once it exists: observe it, poll its status (which fetches
    // the LIVE Rollout manifest for step/weight), and abort the sync operation.
    await plugin.observe(ctx);
    const observed = await plugin.status(ctx, ref);
    await plugin.status(ctx, ref);
    await plugin.abort(ctx, ref);
    plugin.describeCapabilities();

    // It really did read the Rollout — otherwise "no write" would be vacuous.
    expect(observed.observed?.rollout).toMatchObject({ step: 3, stepCount: 3, weight: 100 });
    expect(
      standIn.requests.some((r) => r.method === "GET" && /\/resource\?.*kind=Rollout/.test(r.path))
    ).toBe(true);

    // THE INVARIANT: no request after creation other than a read, and no violation at all.
    expect(standIn.violations).toEqual([]);
    expect(writes().length).toBe(writesAtCreation);
  });
});
