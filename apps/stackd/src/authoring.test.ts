import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STACK_AUTHORING,
  StackBackendSchema,
  type PutStackAuthoringRequest,
  type StackBackend,
  type StackBackendStatusReport,
  type StackSpecDocument
} from "@scp/schemas";
import type { BackendHttp, BackendHttpRequest, BackendHttpResponse } from "./backend-http.js";
import { KubeClient } from "./kube.js";
import type { KubeObject } from "./manifests.js";
import type { ControllerDeps } from "./reconcile.js";
import type { StackRelease } from "./release.js";
import { StateStore } from "./state.js";
import { FakeKube } from "./test-support/fake-kube.js";
import { installWiringHooks } from "./controller.js";
import {
  authoringFactsSha256,
  gitBlobSha,
  reconcileAuthoring,
  remoteClusters,
  rolloutsApplicationName
} from "./authoring.js";

/**
 * M29.3 — CANARY OUT OF THE BOX, every step against an in-memory API server, an in-memory Gitea and
 * Argo CD's cluster API (the kind suite, apps/server `stack-canary.kind.test.ts`, runs the same code
 * against a real Argo CD, Gitea and Rollouts controller). Each wiring step — the carrier push, the
 * authoring project, the Rollouts-to-target Application, the hand-off — is asserted by what reaches
 * Gitea, the cluster and scpd, so deleting any one of them turns a named test red.
 */

const ARGOCD_NS = "scp-argocd";
const ROLLOUTS_NS = "scp-argo-rollouts";
const GITEA_URL = "http://scp-gitea-http.scp-gitea.svc:3000";
const REPO_URL = `${GITEA_URL}/scp-stack/scp-authored-manifests.git`;

let chartDir: string;
beforeAll(async () => {
  chartDir = await mkdtemp(path.join(tmpdir(), "stackd-authoring-"));
  const carrier = path.join(chartDir, "authoring", "scp-authored-manifests");
  await mkdir(path.join(carrier, "templates"), { recursive: true });
  await writeFile(
    path.join(carrier, "Chart.yaml"),
    "apiVersion: v2\nname: scp-authored-manifests\n"
  );
  await writeFile(path.join(carrier, "values.yaml"), "manifests: []\n");
  await writeFile(path.join(carrier, "templates", "manifests.yaml"), "{{ toYaml .Values }}\n");
});
afterAll(async () => {
  await rm(chartDir, { recursive: true, force: true });
});

function release(): StackRelease {
  return {
    version: "1.0.0",
    chartDir,
    imageOverrides: {},
    chartValues: {
      bundledExecutor: {
        argocd: { namespace: ARGOCD_NS, scpAccount: "scp-coordinator" },
        argoWorkflows: { namespace: "scp-argo-workflows", scpAccount: "scp-coordinator" },
        argoEvents: { namespace: "scp-argo-events" },
        argoRollouts: { namespace: ROLLOUTS_NS },
        gitea: { namespace: "scp-gitea" }
      }
    }
  };
}

const service = (name: string, namespace: string, port: number, selector: Record<string, string>) =>
  ({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace },
    spec: { ports: [{ name: "http", port, targetPort: port }], selector }
  }) as KubeObject;

const ROLLOUTS_RENDER: KubeObject[] = [
  {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: ROLLOUTS_NS,
      labels: {
        "stack.commanderscp.io/managed-by": "scp-stackd",
        "stack.commanderscp.io/backend": "argo-rollouts"
      }
    }
  },
  {
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
    metadata: {
      name: "rollouts.argoproj.io",
      labels: { "stack.commanderscp.io/backend": "argo-rollouts" }
    }
  },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "argo-rollouts",
      namespace: ROLLOUTS_NS,
      annotations: { "stack.commanderscp.io/release": "1.0.0" }
    },
    spec: {
      template: {
        spec: {
          containers: [
            { name: "argo-rollouts", image: "reg.internal/argoproj/argo-rollouts:v1.10.0" }
          ]
        }
      }
    }
  }
];

const RENDERS: Partial<Record<StackBackend, KubeObject[]>> = {
  argocd: [service("argocd-server", ARGOCD_NS, 80, { "app.kubernetes.io/name": "argocd-server" })],
  gitea: [service("scp-gitea-http", "scp-gitea", 3000, { "app.kubernetes.io/name": "gitea" })],
  "argo-rollouts": ROLLOUTS_RENDER
};

const b64 = (s: string) => Buffer.from(s).toString("base64");
const secret = (name: string, namespace: string, data: Record<string, string>): KubeObject => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name, namespace },
  data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)]))
});
const crd = (group: string, plural: string, kind: string): KubeObject => ({
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: `${plural}.${group}` },
  spec: { group, scope: "Namespaced", names: { plural, kind }, versions: [{ name: "v1alpha1" }] }
});

/** Gitea (organizations, repositories, one branch, the tree and the multi-file contents API) and
 *  Argo CD (a session and its cluster registry), in memory. */
class FakeBackends implements BackendHttp {
  readonly calls: BackendHttpRequest[] = [];
  orgs = new Set<string>();
  repos = new Set<string>();
  files = new Map<string, Buffer>();
  head: string | null = null;
  pushes = 0;
  clusters: { name: string; server: string }[] = [
    { name: "in-cluster", server: "https://kubernetes.default.svc" }
  ];
  private commit(): string {
    const sorted = [...this.files.entries()].sort(([a], [b]) => a.localeCompare(b));
    return createHash("sha1")
      .update(JSON.stringify(sorted.map(([p, c]) => [p, gitBlobSha(c)])))
      .digest("hex");
  }
  async request(req: BackendHttpRequest): Promise<BackendHttpResponse> {
    this.calls.push(req);
    const url = new URL(req.url);
    const p = url.pathname;
    if (url.host === "argocd-server.scp-argocd.svc") {
      if (p === "/api/v1/session") return { status: 200, body: { token: "ADMIN-SESSION" } };
      if (p === "/api/v1/clusters") {
        expect(req.headers?.authorization).toBe("Bearer ADMIN-SESSION");
        return { status: 200, body: { items: this.clusters } };
      }
      return { status: 404, body: {} };
    }
    expect(req.headers?.authorization).toMatch(/^Basic /);
    const repo = "/api/v1/repos/scp-stack/scp-authored-manifests";
    if (p === "/api/v1/user") return { status: 200, body: { login: "gitea_admin" } };
    if (p === "/api/v1/orgs/scp-stack" && req.method === "GET")
      return { status: this.orgs.has("scp-stack") ? 200 : 404, body: {} };
    if (p === "/api/v1/orgs" && req.method === "POST") {
      this.orgs.add((req.json as { username: string }).username);
      return { status: 201, body: {} };
    }
    if (p === repo && req.method === "GET")
      return { status: this.repos.has("scp-authored-manifests") ? 200 : 404, body: {} };
    if (p === "/api/v1/orgs/scp-stack/repos" && req.method === "POST") {
      const body = req.json as { name: string; private: boolean };
      expect(body.private).toBe(false);
      this.repos.add(body.name);
      return { status: 201, body: {} };
    }
    if (p === `${repo}/branches/main`)
      return this.head
        ? { status: 200, body: { commit: { id: this.head } } }
        : { status: 404, body: {} };
    if (p.startsWith(`${repo}/git/trees/`)) {
      return {
        status: 200,
        body: {
          truncated: false,
          tree: [...this.files.entries()].map(([path, c]) => ({
            path,
            type: "blob",
            sha: gitBlobSha(c)
          }))
        }
      };
    }
    if (p === `${repo}/contents` && req.method === "POST") {
      const body = req.json as {
        branch: string;
        files: { operation: string; path: string; content?: string; sha?: string }[];
      };
      expect(body.branch).toBe("main");
      for (const f of body.files) {
        if (f.operation === "delete") this.files.delete(f.path);
        else this.files.set(f.path, Buffer.from(f.content!, "base64"));
      }
      this.pushes += 1;
      this.head = this.commit();
      return { status: 201, body: { commit: { sha: this.head } } };
    }
    return { status: 404, body: { path: p } };
  }
}

function spec(enabled: StackBackend[], authoringSha: string | null = null): StackSpecDocument {
  return {
    settings: { updatePolicy: "automatic", upgradeGeneration: 0 },
    backends: StackBackendSchema.options.map((backend) => ({
      backend,
      enabled: enabled.includes(backend),
      sizeTier: "small" as const,
      purgeGeneration: 0,
      rotateGeneration: 0
    })),
    integrity: [],
    wiring: [],
    authoring: { factsSha256: authoringSha }
  };
}

const readyReport = (backend: StackBackend): StackBackendStatusReport => ({
  backend,
  phase: "ready",
  runningVersion: "1.0.0",
  targetVersion: null,
  lastError: null,
  needs: [],
  detail: [],
  lastGoodSha256: null,
  inventorySha256: null
});

function harness() {
  const kube = new FakeKube();
  kube.seed(crd("argoproj.io", "applications", "Application"));
  kube.seed(crd("argoproj.io", "appprojects", "AppProject"));
  kube.seed(secret("argocd-initial-admin-secret", ARGOCD_NS, { password: "admin-pw" }));
  kube.seed(secret("gitea-admin-secret", "scp-gitea", { username: "gitea_admin", password: "pw" }));
  const http = new FakeBackends();
  const handoffs: PutStackAuthoringRequest[] = [];
  let withdrawals = 0;
  const client = new KubeClient(kube);
  const deps: ControllerDeps = {
    api: {
      spec: async () => {
        throw new Error("unused");
      },
      putStatus: async () => undefined,
      putWiring: async () => undefined,
      deleteWiring: async () => undefined,
      putAuthoring: async (req) => {
        handoffs.push(structuredClone(req));
      },
      deleteAuthoring: async () => {
        withdrawals += 1;
      }
    },
    kube: client,
    helm: { binary: "helm", version: "v3", template: async () => "" },
    release: release(),
    store: new StateStore(client, "scp-stackd"),
    scpNamespace: "scp",
    federationRole: "commander",
    readyTimeoutMs: 1_000,
    crdTimeoutMs: 1_000,
    removeTimeoutMs: 1_000,
    pollMs: 1,
    resyncMs: 60_000,
    log: () => undefined,
    sleep: async () => undefined
  };
  installWiringHooks(deps, { http, scpPodLabels: { "app.kubernetes.io/name": "commanderscp" } });
  const input = (
    enabled: StackBackend[] = ["argocd", "gitea", "argo-rollouts"],
    sha: string | null = null
  ) => ({
    spec: spec(enabled, sha),
    reports: new Map(enabled.map((b) => [b, readyReport(b)] as const)),
    renders: new Map(
      Object.entries(RENDERS).filter(([b]) => enabled.includes(b as StackBackend)) as [
        StackBackend,
        KubeObject[]
      ][]
    )
  });
  return { kube, http, handoffs, withdrawals: () => withdrawals, deps, input };
}

const APP = (kube: FakeKube, name: string) => kube.find("Application", name, ARGOCD_NS);
const PROJECT = (kube: FakeKube, name: string) => kube.find("AppProject", name, ARGOCD_NS);

describe("M29.3 canary authoring — the controller sets it up end to end", () => {
  it("the installed hook IS the authoring step (built AND wired: deleting the hook turns this red)", async () => {
    const h = harness();
    expect(h.deps.afterStack).toBeDefined();
    const needs = await h.deps.afterStack!(h.input());
    expect(needs).toEqual([]);
    expect(h.handoffs).toHaveLength(1);
  });

  it("CARRIER: pushes the carrier chart and the Rollouts install into a PUBLIC repository only it writes, pinned by commit", async () => {
    const h = harness();
    await reconcileAuthoring(h.deps, h.input());
    expect(h.http.orgs.has("scp-stack")).toBe(true);
    expect(h.http.repos.has("scp-authored-manifests")).toBe(true);
    const paths = [...h.http.files.keys()].sort();
    expect(paths).toContain("scp-authored-manifests/Chart.yaml");
    expect(paths).toContain("scp-authored-manifests/templates/manifests.yaml");
    expect(paths.filter((p) => p.startsWith("argo-rollouts/"))).toHaveLength(
      ROLLOUTS_RENDER.length + 1
    );
    // The stack labels come off, the retargeted image stays.
    const deploy = JSON.parse(
      h.http.files.get(`argo-rollouts/deployment.${ROLLOUTS_NS}.argo-rollouts.json`)!.toString()
    );
    expect(deploy.metadata.annotations).toEqual({});
    expect(deploy.spec.template.spec.containers[0].image).toBe(
      "reg.internal/argoproj/argo-rollouts:v1.10.0"
    );
    const ns = JSON.parse(h.http.files.get("argo-rollouts/namespace.scp-apps.json")!.toString());
    expect(ns.kind).toBe("Namespace");
    expect(h.handoffs[0]!.carrierRevision).toBe(h.http.head);
  });

  it("CARRIER is idempotent, and a push by anyone else is overwritten — never handed over", async () => {
    const h = harness();
    await reconcileAuthoring(h.deps, h.input());
    const first = h.http.head;
    await reconcileAuthoring(h.deps, h.input(undefined, h.handoffs[0]!.factsSha256));
    expect(h.http.pushes).toBe(1);
    expect(h.handoffs).toHaveLength(1);
    // Someone with a Gitea token rewrites the carrier: the controller restores its own content.
    h.http.files.set("scp-authored-manifests/templates/manifests.yaml", Buffer.from("evil"));
    h.http.files.set("argo-rollouts/extra.json", Buffer.from("{}"));
    h.http.head = "f".repeat(40);
    await reconcileAuthoring(h.deps, h.input(undefined, h.handoffs[0]!.factsSha256));
    expect(h.http.pushes).toBe(2);
    expect(h.http.files.has("argo-rollouts/extra.json")).toBe(false);
    expect(h.http.head).toBe(first);
    expect(h.handoffs.at(-1)!.carrierRevision).toBe(first);
  });

  it("PROJECT: the authoring AppProject is ADR-0055 D10's shape, over every target cluster", async () => {
    const h = harness();
    h.http.clusters.push({ name: "edge-1", server: "https://edge-1.example:6443" });
    await reconcileAuthoring(h.deps, h.input());
    const p = PROJECT(h.kube, STACK_AUTHORING.project)!;
    expect(p, "the authoring AppProject").toBeDefined();
    expect(p["spec"]).toEqual({
      description: expect.any(String),
      sourceRepos: [REPO_URL],
      destinations: [
        { server: "https://kubernetes.default.svc", namespace: "scp-apps" },
        { server: "https://edge-1.example:6443", namespace: "scp-apps" },
        { name: "edge-1", namespace: "scp-apps" }
      ],
      clusterResourceWhitelist: [],
      namespaceResourceWhitelist: [
        { group: "argoproj.io", kind: "Rollout" },
        { group: "", kind: "Service" }
      ]
    });
    const s = PROJECT(h.kube, STACK_AUTHORING.stackProject)!;
    expect((s["spec"] as { destinations: unknown }).destinations).toEqual([
      { server: "https://edge-1.example:6443", namespace: ROLLOUTS_NS }
    ]);
  });

  it("ROLLOUTS REACHES EVERY TARGET: one pinned Application per registered cluster besides in-cluster; a cluster is handed over only once Rollouts is healthy there", async () => {
    const h = harness();
    const edge = { name: "edge-1", server: "https://edge-1.example:6443" };
    h.http.clusters.push(edge);
    await reconcileAuthoring(h.deps, h.input());
    const name = rolloutsApplicationName(edge);
    const app = APP(h.kube, name)!;
    expect(app, "the Rollouts-to-target Application").toBeDefined();
    const revision = h.http.head!;
    expect(app["spec"]).toMatchObject({
      project: STACK_AUTHORING.stackProject,
      source: { repoURL: REPO_URL, path: "argo-rollouts", targetRevision: revision },
      destination: { server: edge.server, namespace: ROLLOUTS_NS }
    });
    expect(app.metadata.finalizers, "never cascades to the CRDs").toBeUndefined();
    // Not healthy yet: in-cluster only, and a need says so.
    expect(h.handoffs[0]!.clusters).toEqual([]);
    // Argo CD reports it Synced + Healthy at the pinned revision: now the cluster is handed over.
    h.kube.seed({
      ...app,
      status: { sync: { status: "Synced", revision }, health: { status: "Healthy" } }
    } as KubeObject);
    const needs = await reconcileAuthoring(h.deps, h.input(undefined, h.handoffs[0]!.factsSha256));
    expect(needs).toEqual([]);
    expect(h.handoffs.at(-1)).toEqual({
      carrierRevision: revision,
      clusters: ["edge-1"],
      factsSha256: authoringFactsSha256(revision, ["edge-1"])
    });
    // The cluster is deregistered from Argo CD: its Application goes (never its CRDs).
    h.http.clusters.pop();
    await reconcileAuthoring(h.deps, h.input(undefined, h.handoffs.at(-1)!.factsSha256));
    expect(APP(h.kube, name)).toBeUndefined();
    expect(h.handoffs.at(-1)!.clusters).toEqual([]);
  });

  it("HAND-OFF: only when what scpd holds differs", async () => {
    const h = harness();
    await reconcileAuthoring(h.deps, h.input());
    expect(h.handoffs).toHaveLength(1);
    await reconcileAuthoring(h.deps, h.input(undefined, h.handoffs[0]!.factsSha256));
    expect(h.handoffs).toHaveLength(1);
  });

  it("WITHDRAW: Rollouts (or Gitea) disabled -> scpd first, then the Rollouts-to-target Applications; the projects stay", async () => {
    const h = harness();
    h.http.clusters.push({ name: "edge-1", server: "https://edge-1.example:6443" });
    await reconcileAuthoring(h.deps, h.input());
    const sha = h.handoffs[0]!.factsSha256;
    const needs = await reconcileAuthoring(h.deps, h.input(["argocd", "argo-rollouts"], sha));
    expect(h.withdrawals()).toBe(1);
    expect(needs[0]?.message).toMatch(/needs gitea enabled/);
    expect(
      h.kube.calls.filter((c) => c.kind === "Application" && c.method === "DELETE")
    ).toHaveLength(1);
    expect(PROJECT(h.kube, STACK_AUTHORING.project)).toBeDefined();
  });

  it("waits, and hands nothing over, until all three are ready and wired", async () => {
    const h = harness();
    const input = h.input();
    input.reports.set("gitea", {
      ...readyReport("gitea"),
      needs: [{ code: "wiring", message: "x" }]
    });
    const needs = await reconcileAuthoring(h.deps, input);
    expect(needs[0]?.message).toMatch(/waiting for gitea/);
    expect(h.handoffs).toEqual([]);
    expect(h.http.pushes).toBe(0);
  });

  it("the target cluster set is Argo CD's own: in-cluster and malformed names are never handed over", () => {
    expect(
      remoteClusters({
        items: [
          { name: "in-cluster", server: "https://kubernetes.default.svc" },
          { name: "Bad Name", server: "https://x" },
          { name: "edge-2", server: "https://edge-2:6443" },
          { name: "edge-1", server: "https://edge-1:6443" }
        ]
      }).map((c) => c.name)
    ).toEqual(["edge-1", "edge-2"]);
  });
});
