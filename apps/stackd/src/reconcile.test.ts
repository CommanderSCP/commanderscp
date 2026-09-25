import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
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
import {
  BACKEND_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  STACK_KINDS,
  type KubeObject
} from "./manifests.js";
import { reconcileStack, startStackController, type ControllerDeps } from "./reconcile.js";
import type { StackRelease } from "./release.js";
import { StateStore } from "./state.js";
import { FakeKube } from "./test-support/fake-kube.js";

/**
 * THE RECONCILE, EVERY BRANCH, against an in-memory API server. The same controller runs against a
 * real one in apps/server `stack-controller.kind.test.ts`; this suite is where each decision —
 * install, steady, prune, fall back, hold, remove, retain, purge, refuse a rewritten state — is
 * pinned down one at a time.
 */

/** The controller's own namespace, where its state lives. */
const STACKD_NS = "scp-stackd";

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
      const data =
        key === "gitea"
          ? [
              ...(chartDir === "chart-drops-pvc"
                ? []
                : [
                    `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\n  namespace: ${ns}\nspec:\n  accessModes: [ReadWriteOnce]`
                  ]),
              `apiVersion: v1\nkind: Secret\nmetadata:\n  name: gitea-admin-secret\n  namespace: ${ns}\nstringData:\n  password: ${(values as { gitea?: { adminPassword?: string } }).gitea?.adminPassword ?? "pw"}`
            ]
          : [];
      const evil =
        chartDir === "chart-evil"
          ? [`apiVersion: v1\nkind: Pod\nmetadata:\n  name: takeover\n  namespace: kube-system`]
          : [];
      return [
        ...data,
        ...evil,
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
  recorded: Map<StackBackend, { lastGoodSha256: string | null; inventorySha256: string | null }>;
  setRelease(r: StackRelease): void;
}

/** The fake chart's custom kinds, one group per backend, on top of the real allowlist. */
const KINDS = [
  ...STACK_KINDS,
  ...Object.keys(NAMESPACES).map((key) => ({
    group: `${key}.example.io`,
    kind: "Widget",
    namespaced: true
  }))
];

function harness(): Harness {
  const kube = new FakeKube((o) => !imageOf(o)?.includes("broken"));
  const client = new KubeClient(kube);
  const statuses: PutStackStatusRequest[] = [];
  const spec: StackSpecDocument = {
    settings: { updatePolicy: "automatic", upgradeGeneration: 0 },
    backends: StackBackendSchema.options.map((backend) => ({
      backend,
      enabled: false,
      sizeTier: "small",
      purgeGeneration: 0
    })),
    integrity: []
  };
  // scpd's side: the status row keeps the digests of the latest report, and the spec hands them
  // back as `integrity` (apps/server routes/stack.ts).
  const recorded = new Map<
    StackBackend,
    { lastGoodSha256: string | null; inventorySha256: string | null }
  >();
  const helm = fakeHelm();
  let rel = release("1.0.0", "chart-a");
  const deps: ControllerDeps = {
    api: {
      spec: async () => ({
        ...structuredClone(spec),
        integrity: StackBackendSchema.options.map((backend) => ({
          backend,
          lastGoodSha256: recorded.get(backend)?.lastGoodSha256 ?? null,
          inventorySha256: recorded.get(backend)?.inventorySha256 ?? null
        }))
      }),
      putStatus: async (req) => {
        statuses.push(structuredClone(req));
        for (const b of req.backends) {
          recorded.set(b.backend, {
            lastGoodSha256: b.lastGoodSha256,
            inventorySha256: b.inventorySha256
          });
        }
      }
    },
    kube: client,
    helm,
    get release() {
      return rel;
    },
    store: new StateStore(client, STACKD_NS),
    kinds: KINDS,
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
  return {
    kube,
    deps,
    statuses,
    spec,
    helm,
    recorded,
    setRelease: (r) => (rel = r)
  };
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

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

interface StoredState {
  inventory: { apiVersion: string; kind: string; name: string; namespace?: string }[];
  retained: { apiVersion: string; kind: string; name: string; namespace?: string }[];
  lastGood: { sha256: string; chunks: number; release: string } | null;
  purgedGeneration: number;
}

function stateOf(h: Harness, backend: StackBackend): StoredState {
  const sec = h.kube.find("Secret", `scp-stackd-${backend}-state`, STACKD_NS)!;
  return JSON.parse(unb64((sec["data"] as Record<string, string>)["state.json"]!).toString());
}

/** Rewrites the stored state, as someone with write access to the controller's namespace could. */
function writeState(h: Harness, backend: StackBackend, next: StoredState): void {
  const sec = h.kube.find("Secret", `scp-stackd-${backend}-state`, STACKD_NS)!;
  h.kube.seed({ ...sec, data: { "state.json": b64(JSON.stringify(next)) } });
}

/** Rewrites the stored last good set AND the state's record of its sha256 — a consistent forgery
 *  that only scpd's copy of the digest can catch. */
function forgeLastGood(
  h: Harness,
  backend: StackBackend,
  edit: (objs: KubeObject[]) => KubeObject[],
  opts: { alsoState: boolean } = { alsoState: true }
): void {
  const name = `scp-stackd-${backend}-lastgood-0`;
  const sec = h.kube.find("Secret", name, STACKD_NS)!;
  const objs = JSON.parse(
    gunzipSync(unb64((sec["data"] as Record<string, string>)["part"]!)).toString()
  ) as KubeObject[];
  const gz = gzipSync(Buffer.from(JSON.stringify(edit(objs))));
  h.kube.seed({ ...sec, data: { part: gz.toString("base64") } });
  if (!opts.alsoState) return;
  const st = stateOf(h, backend);
  writeState(h, backend, {
    ...st,
    lastGood: { ...st.lastGood!, sha256: createHash("sha256").update(gz).digest("hex") }
  });
}

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
    // Forgotten: nothing to fall back to, nothing in the inventory, nothing retained.
    expect(h.kube.find("Secret", "scp-stackd-argo-events-lastgood-0", STACKD_NS)).toBeUndefined();
    expect(stateOf(h, "argo-events")).toMatchObject({
      inventory: [],
      retained: [],
      lastGood: null
    });
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
    h.deps.store = new StateStore(client, STACKD_NS);
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
      store: new StateStore(h.deps.kube, STACKD_NS)
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
    expect(h.statuses.length, "the loop published no status: it never reconciled").toBeGreaterThan(
      0
    );
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

  it("state lives in the controller's own namespace, never in a backend's", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    const stateSecrets = h.kube
      .applied()
      .filter((c) => c.kind === "Secret" && c.name.startsWith("scp-stackd-"));
    expect(stateSecrets.length).toBeGreaterThan(0);
    expect(new Set(stateSecrets.map((c) => c.namespace))).toEqual(new Set([STACKD_NS]));
  });

  it("every report hands scpd the digests of the state it leaves", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    const r = last(h, "argo-events");
    expect(r.lastGoodSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.lastGoodSha256).toBe(stateOf(h, "argo-events").lastGood!.sha256);
    expect(r.inventorySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---- S3: disable keeps data, purge deletes it -----------------------------------------------

  it("disabling keeps the data (volumes, generate-once secrets); enabling again reuses them", async () => {
    const h = harness();
    enable(h, "gitea");
    await reconcileStack(h.deps);
    const pw = h.kube.find("Secret", "gitea-admin-secret", "scp-gitea")!;
    enable(h, "gitea", false);
    await reconcileStack(h.deps);
    expect(h.kube.find("Deployment", "controller", "scp-gitea")).toBeUndefined();
    expect(h.kube.find("PersistentVolumeClaim", "data", "scp-gitea")).toBeDefined();
    expect(h.kube.find("Secret", "gitea-admin-secret", "scp-gitea")).toBeDefined();
    const r = last(h, "gitea");
    expect(r.phase).toBe("disabled");
    expect(r.needs.map((n) => n.code)).toEqual(["data-retained"]);
    expect(r.needs[0]!.message).toMatch(/PersistentVolumeClaim data/);
    expect(
      stateOf(h, "gitea")
        .retained.map((x) => x.kind)
        .sort()
    ).toEqual(["PersistentVolumeClaim", "Secret"]);
    enable(h, "gitea");
    await reconcileStack(h.deps);
    expect(last(h, "gitea").phase).toBe("ready");
    expect(h.kube.find("Secret", "gitea-admin-secret", "scp-gitea")!["stringData"]).toEqual(
      pw["stringData"]
    );
    expect(stateOf(h, "gitea").retained).toEqual([]);
  });

  it("a purge of a disabled backend deletes its data once, and is not repeated", async () => {
    const h = harness();
    enable(h, "gitea");
    await reconcileStack(h.deps);
    enable(h, "gitea", false);
    await reconcileStack(h.deps);
    h.spec.backends.find((b) => b.backend === "gitea")!.purgeGeneration = 1;
    await reconcileStack(h.deps);
    expect(h.kube.find("PersistentVolumeClaim", "data", "scp-gitea")).toBeUndefined();
    expect(h.kube.find("Secret", "gitea-admin-secret", "scp-gitea")).toBeUndefined();
    expect(last(h, "gitea")).toMatchObject({ phase: "disabled", needs: [] });
    expect(stateOf(h, "gitea").purgedGeneration).toBe(1);
    const deletes = h.kube.calls.filter((c) => c.method === "DELETE").length;
    await reconcileStack(h.deps);
    expect(h.kube.calls.filter((c) => c.method === "DELETE").length).toBe(deletes);
  });

  it("a purge overtaken by an enable is spent: a later disable keeps the data", async () => {
    const h = harness();
    enable(h, "gitea");
    await reconcileStack(h.deps);
    const g = h.spec.backends.find((b) => b.backend === "gitea")!;
    g.purgeGeneration = 1; // requested, then enabled before the controller acted
    await reconcileStack(h.deps);
    enable(h, "gitea", false);
    await reconcileStack(h.deps);
    expect(h.kube.find("PersistentVolumeClaim", "data", "scp-gitea")).toBeDefined();
  });

  it("an upgrade that stops rendering a volume keeps it, retained, instead of pruning it", async () => {
    const h = harness();
    enable(h, "gitea");
    await reconcileStack(h.deps);
    h.setRelease(release("1.1.0", "chart-drops-pvc"));
    await reconcileStack(h.deps);
    expect(last(h, "gitea")).toMatchObject({ phase: "ready", runningVersion: "1.1.0" });
    expect(h.kube.find("PersistentVolumeClaim", "data", "scp-gitea")).toBeDefined();
    expect(stateOf(h, "gitea").retained.map((x) => x.name)).toEqual(["data"]);
  });

  // ---- S1: what is read back is verified before it is acted on --------------------------------

  it("a render outside the backend's kinds or namespace is refused, and nothing is applied", async () => {
    const h = harness();
    h.setRelease(release("1.0.0", "chart-evil"));
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    expect(last(h, "argo-events").phase).toBe("failed");
    expect(last(h, "argo-events").lastError).toMatch(/refused.*Pod kube-system\/takeover/);
    expect(h.kube.applied().filter((c) => c.kind !== "Secret")).toEqual([]);
  });

  it("a forged last good set (bytes and state rewritten together) is NOT applied: scpd's digest disagrees", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    forgeLastGood(h, "argo-events", (objs) =>
      objs.map((o) =>
        o.kind === "Deployment"
          ? {
              ...o,
              spec: {
                ...(o["spec"] as object),
                template: {
                  spec: { containers: [{ name: "main", image: "attacker/miner:1" }] }
                }
              }
            }
          : o
      )
    );
    const forged = stateOf(h, "argo-events").lastGood!.sha256;
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(h.deps);
    const r = last(h, "argo-events");
    expect(r.phase).toBe("failed");
    expect(r.needs.map((n) => n.code)).toContain("state-integrity");
    expect(r.needs.find((n) => n.code === "state-integrity")!.message).toMatch(
      /last good set.*will not be applied/
    );
    const images = h.kube
      .applied()
      .filter((c) => c.kind === "Deployment")
      .map(() => imageOf(h.kube.find("Deployment", "controller", "scp-argo-events")));
    expect(images).not.toContain("attacker/miner:1");
    // scpd's record never becomes the forgery's digest.
    expect(h.recorded.get("argo-events")!.lastGoodSha256).not.toBe(forged);
  });

  it("with no digest on record, a stored set is still held to the backend's kinds and namespace, and re-stamped", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    // A stored set with an object outside the backend: refused even trusted-on-first-use.
    forgeLastGood(h, "argo-events", (objs) => [
      ...objs,
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "planted", namespace: "kube-system" }
      }
    ]);
    h.recorded.clear();
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(h.deps);
    expect(last(h, "argo-events").lastError).toMatch(/outside the backend's namespace/);
    expect(h.kube.find("ConfigMap", "planted", "kube-system")).toBeUndefined();
  });

  it("stored bytes that no longer hash to the state's own record are not applied, even with no digest on record", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    forgeLastGood(h, "argo-events", (objs) => objs.filter((o) => o.kind !== "ConfigMap"), {
      alsoState: false
    });
    h.recorded.clear();
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(h.deps);
    expect(last(h, "argo-events").phase).toBe("failed");
    expect(last(h, "argo-events").lastError).toMatch(/bytes hash to/);
  });

  it("a stored set whose labels were stripped is re-stamped before it is applied", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    forgeLastGood(h, "argo-events", (objs) =>
      objs.map((o) => ({ ...o, metadata: { ...o.metadata, labels: {} } }))
    );
    h.recorded.clear(); // trusted on first use: only the stamp is under test
    h.setRelease(release("2.0.0", "chart-broken"));
    await reconcileStack(h.deps);
    expect(last(h, "argo-events").phase).toBe("degraded");
    const dep = h.kube.find("Deployment", "controller", "scp-argo-events")!;
    expect(imageOf(dep)).toBe("upstream/argoEvents:1");
    expect(dep.metadata.labels).toMatchObject({
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [BACKEND_LABEL]: "argo-events"
    });
  });

  it("a rewritten inventory is not pruned from; the disable follows the render instead", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    // Something the controller never made, labelled as if it had, planted in the inventory.
    h.kube.seed({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "victim",
        namespace: "scp-argo-events",
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [BACKEND_LABEL]: "argo-events" }
      }
    });
    const st = stateOf(h, "argo-events");
    writeState(h, "argo-events", {
      ...st,
      inventory: [
        ...st.inventory,
        { apiVersion: "v1", kind: "ConfigMap", name: "victim", namespace: "scp-argo-events" }
      ]
    });
    const anchor = h.recorded.get("argo-events")!.inventorySha256;
    enable(h, "argo-events", false);
    await reconcileStack(h.deps);
    expect(h.kube.find("ConfigMap", "victim", "scp-argo-events")).toBeDefined();
    expect(h.kube.find("Deployment", "controller", "scp-argo-events")).toBeUndefined();
    expect(last(h, "argo-events").phase).toBe("disabled");
    // The controller rewrote its state itself after the removal, so the record moves on — to the
    // digest of what IT wrote, not of the forgery.
    expect(h.recorded.get("argo-events")!.inventorySha256).not.toBe(anchor);
    expect(h.recorded.get("argo-events")!.inventorySha256).toBe(
      last(h, "argo-events").inventorySha256
    );
  });

  it("a mismatch that is only reported leaves scpd's record where it was", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    const anchor = { ...h.recorded.get("argo-events")! };
    const st = stateOf(h, "argo-events");
    writeState(h, "argo-events", {
      ...st,
      retained: [{ apiVersion: "v1", kind: "Secret", name: "x", namespace: "scp-argo-events" }]
    });
    // A fresh process: no memory of what it wrote.
    const fresh: ControllerDeps = { ...h.deps, store: new StateStore(h.deps.kube, STACKD_NS) };
    await reconcileStack(fresh);
    expect(last(h, "argo-events").needs.map((n) => n.code)).toContain("state-integrity");
    expect(h.recorded.get("argo-events")).toEqual(anchor);
  });

  it("a prune never deletes a ref outside the backend's namespace, even from a trusted inventory", async () => {
    const h = harness();
    enable(h, "argo-events");
    await reconcileStack(h.deps);
    h.kube.seed({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "elsewhere",
        namespace: "scp",
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [BACKEND_LABEL]: "argo-events" }
      }
    });
    const st = stateOf(h, "argo-events");
    writeState(h, "argo-events", {
      ...st,
      inventory: [
        ...st.inventory,
        { apiVersion: "v1", kind: "ConfigMap", name: "elsewhere", namespace: "scp" }
      ]
    });
    h.recorded.clear();
    enable(h, "argo-events", false);
    await reconcileStack(h.deps);
    expect(h.kube.find("ConfigMap", "elsewhere", "scp")).toBeDefined();
  });
});
