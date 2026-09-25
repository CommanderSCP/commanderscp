import { describe, expect, it } from "vitest";
import type {
  PutStackStatusRequest,
  StackBackend,
  StackSettings,
  StackSpecDocument
} from "@scp/schemas";
import { StackBackendSchema } from "@scp/schemas";
import type { HelmRenderer } from "./helm.js";
import { KubeClient } from "./kube.js";
import { BACKEND_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE, type KubeObject } from "./manifests.js";
import { reconcileStack, startStackController, type ControllerDeps } from "./reconcile.js";
import { backendNamespace, type StackRelease } from "./release.js";
import { StateStore } from "./state.js";
import { FakeKube } from "./test-support/fake-kube.js";

/**
 * THE RECONCILE, EVERY BRANCH, against an in-memory API server. The same controller runs against a
 * real one in apps/server `stack-controller.kind.test.ts`; this suite is where each decision —
 * install, steady, prune, fall back, hold, remove — is pinned down one at a time.
 */

const NAMESPACES: Record<string, string> = {
  argocd: "scp-argocd",
  argoWorkflows: "scp-argo-workflows",
  argoRollouts: "scp-argo-rollouts",
  argoEvents: "scp-argo-events",
  gitea: "scp-gitea"
};

function chartValues(): Record<string, unknown> {
  const be: Record<string, unknown> = { scpNamespace: "" };
  for (const [key, namespace] of Object.entries(NAMESPACES)) {
    be[key] = {
      enabled: false,
      namespace,
      image: `upstream/${key}:1`,
      resources: {
        main: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "1Gi" } }
      }
    };
  }
  return { federationRole: "commander", bundledExecutor: be };
}

function release(version: string, chartDir: string): StackRelease {
  return { version, chartDir, chartValues: chartValues(), imageOverrides: {} };
}

/**
 * The fake chart. `chart-a` renders a CRD, a ConfigMap `old-cm` and a Deployment; `chart-b` swaps
 * `old-cm` for `new-cm` (a prune); `chart-broken` renders an image the fake API never makes ready.
 */
function fakeHelm(): HelmRenderer & { renders: number } {
  const helm = {
    binary: "fake-helm",
    version: "v0.0.0",
    renders: 0,
    async template(chartDir: string, values: unknown): Promise<string> {
      helm.renders += 1;
      const be = (values as { bundledExecutor: Record<string, { resources?: unknown }> })
        .bundledExecutor;
      const key = Object.keys(be).find((k) => k !== "scpNamespace")!;
      const ns = NAMESPACES[key]!;
      const image = chartDir === "chart-broken" ? `upstream/${key}:broken` : `upstream/${key}:1`;
      const cm = chartDir === "chart-b" ? "new-cm" : "old-cm";
      const cpu = JSON.stringify(
        (be[key]!.resources as { main: { requests: { cpu: string } } }).main.requests.cpu
      );
      return [
        `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}`,
        `apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: widgets.${key}.example.io\nspec:\n  group: ${key}.example.io\n  scope: Namespaced\n  names: { plural: widgets, kind: Widget }\n  versions: [{ name: v1 }]`,
        `apiVersion: ${key}.example.io/v1\nkind: Widget\nmetadata:\n  name: w\n  namespace: ${ns}`,
        `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${cm}\n  namespace: ${ns}`,
        `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: controller\n  namespace: ${ns}\nspec:\n  replicas: 1\n  template:\n    metadata:\n      labels: { app: controller }\n    spec:\n      containers:\n        - name: main\n          image: ${image}\n          resources: { requests: { cpu: ${cpu} } }`
      ].join("\n---\n");
    }
  };
  return helm;
}

const imageOf = (o: KubeObject | undefined): string | undefined =>
  (o?.["spec"] as { template: { spec: { containers: { image: string }[] } } } | undefined)?.template
    .spec.containers[0]!.image;

interface Harness {
  kube: FakeKube;
  deps: ControllerDeps;
  statuses: PutStackStatusRequest[];
  spec: StackSpecDocument;
  helm: ReturnType<typeof fakeHelm>;
  setRelease(r: StackRelease): void;
}

function harness(): Harness {
  const kube = new FakeKube((o) => !imageOf(o)?.includes("broken"));
  const client = new KubeClient(kube);
  const statuses: PutStackStatusRequest[] = [];
  const spec: StackSpecDocument = {
    settings: { updatePolicy: "automatic", upgradeGeneration: 0 },
    backends: StackBackendSchema.options.map((backend) => ({
      backend,
      enabled: false,
      sizeTier: "small"
    }))
  };
  const helm = fakeHelm();
  let rel = release("1.0.0", "chart-a");
  const deps: ControllerDeps = {
    api: {
      spec: async () => structuredClone(spec),
      putStatus: async (req) => void statuses.push(structuredClone(req))
    },
    kube: client,
    helm,
    get release() {
      return rel;
    },
    store: new StateStore(client, (b) => backendNamespace(rel, b)),
    scpNamespace: "scp",
    federationRole: "commander",
    readyTimeoutMs: 30,
    crdTimeoutMs: 30,
    removeTimeoutMs: 30,
    pollMs: 1,
    resyncMs: 60_000,
    log: () => undefined,
    sleep: async () => undefined
  };
  return { kube, deps, statuses, spec, helm, setRelease: (r) => (rel = r) };
}

function enable(
  h: Harness,
  backend: StackBackend,
  on = true,
  sizeTier: "small" | "medium" | "large" = "small"
): void {
  const b = h.spec.backends.find((x) => x.backend === backend)!;
  b.enabled = on;
  b.sizeTier = sizeTier;
}

const last = (h: Harness, backend: StackBackend) =>
  h.statuses.at(-1)!.backends.find((b) => b.backend === backend)!;

describe("the stack controller's reconcile", () => {
  it("enabling a backend installs it — CRDs first, Established, then the rest — and reports ready", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    const order = h.kube
      .applied()
      .filter((c) => c.kind !== "Secret")
      .map((c) => c.kind);
    expect(order[0]).toBe("CustomResourceDefinition");
    expect(order.indexOf("Namespace")).toBe(1);
    expect(order).toContain("Widget");
    expect(order).toContain("Deployment");
    const r = last(h, "argo-events");
    expect(r).toMatchObject({
      phase: "ready",
      runningVersion: "1.0.0",
      targetVersion: "1.0.0",
      lastError: null
    });
    // Every other backend is reported, disabled.
    expect(h.statuses.at(-1)!.backends.map((b) => b.backend)).toEqual(StackBackendSchema.options);
    expect(last(h, "gitea").phase).toBe("disabled");
    // An interim "installing" report was published before the wait.
    expect(
      h.statuses.some((s) =>
        s.backends.some((b) => b.backend === "argo-events" && b.phase === "installing")
      )
    ).toBe(true);
  });

  it("every applied object carries the controller's labels; pod templates are untouched", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    const dep = h.kube.find("Deployment", "controller", "scp-argo-events")!;
    expect(dep.metadata.labels).toMatchObject({
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [BACKEND_LABEL]: "argo-events"
    });
    expect(
      (dep["spec"] as { template: { metadata: { labels: Record<string, string> } } }).template
        .metadata.labels
    ).toEqual({
      app: "controller"
    });
  });

  it("an unchanged healthy set is not re-applied every tick", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    const before = h.kube.applied().length;
    await reconcileStack(h.deps);
    expect(h.kube.applied().length).toBe(before);
    expect(last(h, "argo-events").phase).toBe("ready");
  });

  it("the sizing tier reaches the rendered resources, and changing it rolls the backend", async () => {
    const h = harness();
    enable(h, "argo-events", true, "large");
    await reconcileStack(h.deps);
    const cpu = () =>
      (
        h.kube.find("Deployment", "controller", "scp-argo-events")!["spec"] as {
          template: { spec: { containers: { resources: { requests: { cpu: string } } }[] } };
        }
      ).template.spec.containers[0]!.resources.requests.cpu;
    expect(cpu()).toBe("400m");
    enable(h, "argo-events", true, "medium");
    await reconcileStack(h.deps);
    expect(cpu()).toBe("200m");
  });

  it("disabling removes it: workloads and config deleted, CRDs and the Namespace kept, state cleared", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    enable(h, "argo-events", false);
    await reconcileStack(h.deps);
    expect(h.kube.find("Deployment", "controller", "scp-argo-events")).toBeUndefined();
    expect(h.kube.find("ConfigMap", "old-cm", "scp-argo-events")).toBeUndefined();
    expect(h.kube.find("Widget", "w", "scp-argo-events")).toBeUndefined();
    expect(h.kube.find("CustomResourceDefinition", "widgets.argoEvents.example.io")).toBeDefined();
    expect(h.kube.find("Namespace", "scp-argo-events")).toBeDefined();
    expect(h.kube.find("Secret", "scp-stackd-state", "scp-argo-events")).toBeUndefined();
    expect(last(h, "argo-events").phase).toBe("disabled");
    expect(
      h.statuses.some((s) =>
        s.backends.some((b) => b.backend === "argo-events" && b.phase === "removing")
      )
    ).toBe(true);
  });

  it("removal never deletes an object that lacks this backend's labels", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    // Someone else took the ConfigMap over (labels rewritten): it must survive the disable.
    const cm = h.kube.find("ConfigMap", "old-cm", "scp-argo-events")!;
    h.kube.seed({ ...cm, metadata: { ...cm.metadata, labels: { owner: "someone-else" } } });
    enable(h, "argo-events", false);
    await reconcileStack(h.deps);
    expect(h.kube.find("ConfigMap", "old-cm", "scp-argo-events")).toBeDefined();
    expect(h.kube.find("Deployment", "controller", "scp-argo-events")).toBeUndefined();
  });

  it("an upgrade that becomes healthy prunes what the new set no longer renders", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    h.setRelease(release("1.1.0", "chart-b"));
    await reconcileStack(h.deps);
    expect(h.kube.find("ConfigMap", "new-cm", "scp-argo-events")).toBeDefined();
    expect(h.kube.find("ConfigMap", "old-cm", "scp-argo-events")).toBeUndefined();
    expect(last(h, "argo-events")).toMatchObject({ phase: "ready", runningVersion: "1.1.0" });
    expect(
      h.statuses.some((s) =>
        s.backends.some((b) => b.backend === "argo-events" && b.phase === "upgrading")
      )
    ).toBe(true);
  });

  it("an upgrade that never becomes healthy falls back to the last good set, and is not retried", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(h.deps);
    const dep = h.kube.find("Deployment", "controller", "scp-argo-events");
    expect(imageOf(dep)).toBe("upstream/argoEvents:1");
    const r = last(h, "argo-events");
    expect(r.phase).toBe("degraded");
    expect(r.runningVersion).toBe("1.0.0");
    expect(r.targetVersion).toBe("2.0.0");
    expect(r.lastError).toMatch(/did not become healthy.*rolled back to 1\.0\.0/);
    expect(r.needs.map((n) => n.code)).toEqual(["upgrade-rolled-back"]);
    expect(r.detail.some((d) => d.includes("(failed attempt)"))).toBe(true);

    // The next tick does NOT apply the broken set again.
    const applies = h.kube.applied().length;
    await reconcileStack(h.deps);
    expect(h.kube.applied().length).toBe(applies);
    expect(last(h, "argo-events").phase).toBe("degraded");

    // An upgrade request retries it (and it fails again, and falls back again).
    h.spec.settings.upgradeGeneration = 1;
    await reconcileStack(h.deps);
    expect(h.kube.applied().length).toBeGreaterThan(applies);
    expect(imageOf(h.kube.find("Deployment", "controller", "scp-argo-events"))).toBe(
      "upstream/argoEvents:1"
    );
  });

  it("a fixed release after a rolled-back one proceeds without being asked", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(h.deps);
    h.setRelease(release("2.0.1", "chart-b"));
    await reconcileStack(h.deps);
    expect(last(h, "argo-events")).toMatchObject({
      phase: "ready",
      runningVersion: "2.0.1",
      needs: []
    });
  });

  it("a failed first install stays failed, then becomes ready when its workloads come up", async () => {
    let healthy = false;
    const h = harness();
    const kube = new FakeKube(() => healthy);
    const client = new KubeClient(kube);
    h.deps.kube = client;
    h.deps.store = new StateStore(client, (b) => backendNamespace(h.deps.release, b));
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    expect(last(h, "argo-events").phase).toBe("failed");
    expect(last(h, "argo-events").lastError).toMatch(/did not become healthy/);
    healthy = true;
    await reconcileStack(h.deps);
    expect(last(h, "argo-events")).toMatchObject({ phase: "ready", runningVersion: "1.0.0" });
  });

  it("under manual updates a new release waits for an upgrade request", async () => {
    const h = harness();
    enable(h, "argo-events");
    h.spec.settings = { updatePolicy: "manual", upgradeGeneration: 0 } satisfies StackSettings;
    await reconcileStack(h.deps); // first install is not held
    expect(last(h, "argo-events").phase).toBe("ready");
    h.setRelease(release("1.1.0", "chart-b"));
    await reconcileStack(h.deps);
    expect(last(h, "argo-events")).toMatchObject({
      phase: "ready",
      runningVersion: "1.0.0",
      targetVersion: "1.1.0"
    });
    expect(last(h, "argo-events").needs.map((n) => n.code)).toEqual(["upgrade-approval"]);
    expect(h.kube.find("ConfigMap", "new-cm", "scp-argo-events")).toBeUndefined();
    h.spec.settings.upgradeGeneration = 1;
    await reconcileStack(h.deps);
    expect(last(h, "argo-events")).toMatchObject({
      phase: "ready",
      runningVersion: "1.1.0",
      needs: []
    });
  });

  it("the last good set survives a controller restart (it is read back from the cluster)", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    // A new controller process: same cluster, nothing in memory.
    const fresh: ControllerDeps = {
      ...h.deps,
      store: new StateStore(h.deps.kube, (b) => backendNamespace(h.deps.release, b))
    };
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(fresh);
    expect(imageOf(h.kube.find("Deployment", "controller", "scp-argo-events"))).toBe(
      "upstream/argoEvents:1"
    );
  });

  it("a missing Kubernetes right is reported on that backend, and the others still reconcile", async () => {
    const h = harness();
    enable(h, "argo-events");
    enable(h, "gitea");
    h.kube.forbidden.add("PATCH CustomResourceDefinition/widgets.argoEvents.example.io");
    await reconcileStack(h.deps);
    const events = last(h, "argo-events");
    expect(events.phase).toBe("failed");
    expect(events.lastError).toMatch(/rights do not cover|forbidden/);
    expect(last(h, "gitea").phase).toBe("ready");
  });

  it("the loop reconciles on its own until stopped", async () => {
    const h = harness();
    enable(h, "argo-events");
    const controller = startStackController(h.deps, { intervalMs: 5 });
    await controller.firstTick;
    await controller.stop();
    expect(controller.lastTickAt()).not.toBeNull();
    expect(last(h, "argo-events").phase).toBe("ready");
  });

  it("an unreachable API is survived: the tick fails, the loop continues", async () => {
    const h = harness();
    let calls = 0;
    h.deps.api = {
      spec: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      },
      putStatus: async () => undefined
    };
    const controller = startStackController(h.deps, { intervalMs: 1 });
    await controller.firstTick;
    await new Promise((r) => setTimeout(r, 20));
    await controller.stop();
    expect(calls).toBeGreaterThan(1);
  });
});
