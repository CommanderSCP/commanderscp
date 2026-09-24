/** M28.4 (ADR-0055): the create half of import-or-create, and ADR-0008 §3 as a standing test. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { startArgoCdStandIn, type ArgoCdStandIn } from "@scp/plugin-testkit";
import {
  AUTHORED_APPLICATION_PARAMETER,
  SCP_AUTHORED_LABEL_KEY,
  createArgoCdExecutorPlugin
} from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";

const ROLLOUT = {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Rollout",
  metadata: { name: "checkout", namespace: "shop", labels: { [SCP_AUTHORED_LABEL_KEY]: "true" } },
  spec: {
    selector: { matchLabels: { "app.kubernetes.io/name": "checkout" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "checkout" } },
      spec: { containers: [{ name: "checkout", image: "ghcr.io/acme/checkout:1.4.0" }] }
    },
    strategy: {
      canary: {
        steps: [{ setWeight: 10 }, { pause: { duration: "60s" } }, { setWeight: 100 }]
      }
    }
  }
};

function authoredApplication(name: string, labels: Record<string, string> = {}) {
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name,
      labels: { [SCP_AUTHORED_LABEL_KEY]: "true", ...labels } as Record<string, string>
    },
    spec: {
      project: "default",
      destination: { server: "https://kubernetes.default.svc", namespace: "shop" },
      source: {
        repoURL: "https://git.example/platform/gitops.git",
        path: "charts/scp-authored-manifests",
        targetRevision: "v1",
        helm: { valuesObject: { manifests: [ROLLOUT] } }
      }
    }
  };
}

let standIn: ArgoCdStandIn;
let stateDir: string;
let ctx: PluginContext;

beforeEach(async () => {
  standIn = await startArgoCdStandIn();
  stateDir = await mkdtemp(join(tmpdir(), "argocd-authored-"));
  ctx = {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config: { serverUrl: standIn.url, token: "t", statePath: join(stateDir, "state.json") }
  };
});

afterEach(async () => {
  await standIn.close();
  await rm(stateDir, { recursive: true, force: true });
});

const writes = () => standIn.requests.filter((r) => r.method !== "GET");

describe("argocd trigger — an SCP-authored Application", () => {
  it("CREATES an Application that does not exist, then syncs it — and the Rollout reaches the cluster only through Argo CD", async () => {
    const plugin = createArgoCdExecutorPlugin();
    await plugin.trigger(ctx, {
      kind: "sync",
      targetRef: "checkout-gamma",
      idempotencyKey: "wt-1",
      parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("checkout-gamma") }
    });

    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/applications",
      "POST /api/v1/applications/checkout-gamma/sync"
    ]);
    expect(standIn.applications.get("checkout-gamma")?.spec?.source?.repoURL).toBe(
      "https://git.example/platform/gitops.git"
    );
    // Written by the stand-in's CONTROLLER on sync, from the Application's values — never by SCP.
    expect(standIn.cluster.get("Rollout/shop/checkout")?.spec).toEqual(ROLLOUT.spec);
    expect(standIn.violations).toEqual([]);
  });

  it("UPDATES an Application SCP authored earlier (a new release), through the same door", async () => {
    standIn.seed(authoredApplication("checkout-gamma"));
    await createArgoCdExecutorPlugin().trigger(ctx, {
      kind: "sync",
      targetRef: "checkout-gamma",
      idempotencyKey: "wt-2",
      parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("checkout-gamma") }
    });
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/applications?upsert=true",
      "POST /api/v1/applications/checkout-gamma/sync"
    ]);
  });

  it("REFUSES to overwrite an Application somebody else authored — no write reaches Argo CD", async () => {
    const theirs = authoredApplication("checkout-gamma");
    delete theirs.metadata.labels[SCP_AUTHORED_LABEL_KEY];
    standIn.seed(theirs);
    await expect(
      createArgoCdExecutorPlugin().trigger(ctx, {
        kind: "sync",
        targetRef: "checkout-gamma",
        idempotencyKey: "wt-3",
        parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("checkout-gamma") }
      })
    ).rejects.toThrow(/was not authored by CommanderSCP/);
    expect(writes()).toEqual([]);
  });

  it("refuses an authored document that does not name the trigger's Application, or lacks the label", async () => {
    const plugin = createArgoCdExecutorPlugin();
    await expect(
      plugin.trigger(ctx, {
        kind: "sync",
        targetRef: "checkout-gamma",
        parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("someone-else") }
      })
    ).rejects.toThrow(/named 'checkout-gamma'/);
    const unlabelled = authoredApplication("checkout-gamma");
    unlabelled.metadata.labels = {};
    await expect(
      plugin.trigger(ctx, {
        kind: "sync",
        targetRef: "checkout-gamma",
        parameters: { [AUTHORED_APPLICATION_PARAMETER]: unlabelled }
      })
    ).rejects.toThrow(/must carry commanderscp.io\/authored=true/);
    expect(standIn.requests).toEqual([]);
  });

  it("a rollback never carries an authored Application", async () => {
    await expect(
      createArgoCdExecutorPlugin().trigger(ctx, {
        kind: "rollback",
        targetRef: "checkout-gamma",
        priorStateRef: "v0",
        parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("checkout-gamma") }
      })
    ).rejects.toThrow(/never carries an authored Application/);
    expect(standIn.requests).toEqual([]);
  });

  it("declares D12 rollout authority `triggerParams` for clusters — never `authoritative`", () => {
    expect(createArgoCdExecutorPlugin().describeCapabilities().rollout).toEqual({
      authority: "triggerParams",
      targetClasses: ["cluster"]
    });
  });
});

describe("ADR-0008 §3 — after creation, SCP ONLY READS a Rollout (standing test)", () => {
  it("every verb the plugin has, driven against an authored Rollout, writes nothing but the four allowed shapes", async () => {
    const plugin = createArgoCdExecutorPlugin();
    const ref = await plugin.trigger(ctx, {
      kind: "sync",
      targetRef: "checkout-gamma",
      idempotencyKey: "wt-4",
      parameters: { [AUTHORED_APPLICATION_PARAMETER]: authoredApplication("checkout-gamma") }
    });
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
