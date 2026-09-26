import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PutStackWiringRequest, StackBackend, StackBackendSpec } from "@scp/schemas";
import type { BackendHttp, BackendHttpRequest, BackendHttpResponse } from "./backend-http.js";
import { KubeClient } from "./kube.js";
import type { KubeObject } from "./manifests.js";
import type { ControllerDeps } from "./reconcile.js";
import type { StackRelease } from "./release.js";
import { StateStore } from "./state.js";
import { FakeKube } from "./test-support/fake-kube.js";
import { installWiringHooks } from "./controller.js";
import {
  GITEA_TOKEN_SCOPES,
  backendEndpoint,
  egressPolicyName,
  factsDigest,
  unwireBackend,
  wireBackend
} from "./wiring.js";

/**
 * M29.2 — THE AUTO-WIRE, every backend and every branch, against an in-memory API server and fake
 * backend APIs (the kind suite, apps/server `stack-wiring.kind.test.ts`, runs the same code against
 * a real Argo CD, Argo Workflows and Gitea). Each wiring step — egress, mint, CA, hand-off, revoke —
 * is asserted here by what reaches scpd and the cluster, and in the order that matters.
 */

const SCP_NS = "scp";
const POD_LABELS = {
  "app.kubernetes.io/name": "commanderscp",
  "app.kubernetes.io/instance": "scp"
};

function release(): StackRelease {
  return {
    version: "1.0.0",
    chartDir: "chart",
    imageOverrides: {},
    chartValues: {
      bundledExecutor: {
        argocd: { namespace: "scp-argocd", scpAccount: "scp-coordinator" },
        argoWorkflows: {
          namespace: "scp-argo-workflows",
          scpAccount: "scp-coordinator",
          tlsSecretName: "argo-server-tls"
        },
        argoEvents: { namespace: "scp-argo-events" },
        argoRollouts: { namespace: "scp-argo-rollouts" },
        gitea: { namespace: "scp-gitea" }
      }
    }
  };
}

const service = (
  name: string,
  namespace: string,
  port: number,
  targetPort: number | null,
  selector: Record<string, string>
): KubeObject => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name, namespace },
  spec: { ports: [{ name: "http", port, targetPort }], selector }
});

const RENDERS: Record<string, KubeObject[]> = {
  argocd: [
    service("argocd-server", "scp-argocd", 80, 8080, { "app.kubernetes.io/name": "argocd-server" })
  ],
  "argo-workflows": [
    service("argo-server", "scp-argo-workflows", 2746, 2746, { app: "argo-server" }),
    {
      apiVersion: "v1",
      kind: "Secret",
      type: "kubernetes.io/service-account-token",
      metadata: {
        name: "scp-coordinator-token",
        namespace: "scp-argo-workflows",
        annotations: { "kubernetes.io/service-account.name": "scp-coordinator" }
      }
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "argo-server", namespace: "scp-argo-workflows" },
      spec: { replicas: 1, template: { metadata: { labels: { app: "argo-server" } }, spec: {} } }
    }
  ],
  gitea: [
    service("scp-gitea-http", "scp-gitea", 3000, null, {
      "app.kubernetes.io/name": "gitea",
      "app.kubernetes.io/instance": "scp-gitea"
    })
  ],
  "argo-events": []
};

const b64 = (s: string) => Buffer.from(s).toString("base64");
const secret = (name: string, namespace: string, data: Record<string, string>): KubeObject => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name, namespace, uid: `uid-${name}-${Math.random()}` },
  data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)]))
});

/** Argo CD's and Gitea's APIs, enough to mint, list and revoke. */
class FakeBackends implements BackendHttp {
  readonly calls: BackendHttpRequest[] = [];
  argoTokens: string[] = ["old-token-id"];
  giteaTokens: { id: number; name: string }[] = [
    { id: 1, name: "scp-stack-r0-old" },
    { id: 2, name: "someone-elses" }
  ];
  minted = 0;
  failMint = false;
  async request(req: BackendHttpRequest): Promise<BackendHttpResponse> {
    this.calls.push(req);
    const url = new URL(req.url);
    const path = url.pathname;
    const auth = req.headers?.["authorization"] ?? "";
    if (url.host === "argocd-server.scp-argocd.svc") {
      if (req.method === "POST" && path === "/api/v1/session") {
        const body = req.json as { password?: string };
        return body.password === "admin-pw"
          ? { status: 200, body: { token: "admin-jwt" } }
          : { status: 401, body: {} };
      }
      if (auth !== "Bearer admin-jwt") return { status: 401, body: {} };
      if (req.method === "POST" && path === "/api/v1/account/scp-coordinator/token") {
        if (this.failMint) return { status: 403, body: {} };
        this.minted += 1;
        this.argoTokens.push((req.json as { id: string }).id);
        return { status: 200, body: { token: `ARGO-SECRET-${this.minted}` } };
      }
      if (req.method === "GET" && path === "/api/v1/account/scp-coordinator") {
        return { status: 200, body: { tokens: this.argoTokens.map((id) => ({ id })) } };
      }
      const del = /^\/api\/v1\/account\/scp-coordinator\/token\/(.+)$/.exec(path);
      if (req.method === "DELETE" && del) {
        this.argoTokens = this.argoTokens.filter((t) => t !== decodeURIComponent(del[1]!));
        return { status: 200, body: {} };
      }
    }
    if (url.host === "scp-gitea-http.scp-gitea.svc:3000") {
      if (auth !== `Basic ${b64("scp-gitea-admin:gitea-pw")}`) return { status: 401, body: {} };
      if (req.method === "GET" && path === "/api/v1/user") return { status: 200, body: {} };
      if (req.method === "POST" && path === "/api/v1/users/scp-gitea-admin/tokens") {
        this.minted += 1;
        const name = (req.json as { name: string }).name;
        this.giteaTokens.push({ id: 100 + this.minted, name });
        return {
          status: 201,
          body: { sha1: `GITEA-SECRET-${this.minted}`, id: 100 + this.minted }
        };
      }
      if (req.method === "GET" && path === "/api/v1/users/scp-gitea-admin/tokens") {
        return { status: 200, body: this.giteaTokens };
      }
      const del = /^\/api\/v1\/users\/scp-gitea-admin\/tokens\/(\d+)$/.exec(path);
      if (req.method === "DELETE" && del) {
        this.giteaTokens = this.giteaTokens.filter((t) => t.id !== Number(del[1]));
        return { status: 204, body: undefined };
      }
    }
    return { status: 404, body: {} };
  }
}

interface Rig {
  kube: FakeKube;
  http: FakeBackends;
  deps: ControllerDeps;
  handoffs: { backend: StackBackend; req: PutStackWiringRequest }[];
  withdrawals: StackBackend[];
  logs: string[];
  /** Every event in order: backend calls and scpd hand-offs, so ordering can be asserted. */
  events: string[];
}

function rig(): Rig {
  const kube = new FakeKube();
  const http = new FakeBackends();
  const handoffs: Rig["handoffs"] = [];
  const withdrawals: StackBackend[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const recording: BackendHttp = {
    request: async (req) => {
      events.push(`${req.method} ${new URL(req.url).pathname}`);
      return http.request(req);
    }
  };
  kube.seed(secret("argocd-initial-admin-secret", "scp-argocd", { password: "admin-pw" }));
  kube.seed(secret("argocd-secret", "scp-argocd", {}));
  kube.seed(
    secret("gitea-admin-secret", "scp-gitea", { username: "scp-gitea-admin", password: "gitea-pw" })
  );
  kube.seed({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: "gitea-shared-storage", namespace: "scp-gitea", uid: "pvc-1" }
  });
  kube.seed(
    secret("argo-server-tls", "scp-argo-workflows", {
      "tls.crt": "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
    })
  );
  kube.seed(secret("scp-coordinator-token", "scp-argo-workflows", { token: "SA-TOKEN-1" }));
  kube.seed(RENDERS["argo-workflows"]![2]!);
  const deps: ControllerDeps = {
    api: {
      spec: async () => {
        throw new Error("unused");
      },
      putStatus: async () => undefined,
      putSealingKey: async () => undefined,
      credentialDeliveries: async () => ({ items: [] }),
      ackCredentialDelivery: async () => undefined,
      putWiring: async (backend, req) => {
        events.push(`putWiring ${backend}`);
        handoffs.push({ backend, req: structuredClone(req) });
      },
      deleteWiring: async (backend) => {
        events.push(`deleteWiring ${backend}`);
        withdrawals.push(backend);
      }
    },
    kube: new KubeClient(kube),
    helm: { binary: "none", version: "v0", template: async () => "" },
    release: release(),
    store: new StateStore(new KubeClient(kube), "scp-stackd"),
    scpNamespace: SCP_NS,
    federationRole: "commander",
    readyTimeoutMs: 200,
    crdTimeoutMs: 200,
    removeTimeoutMs: 200,
    pollMs: 1,
    resyncMs: 600_000,
    sleep: async () => undefined,
    log: (line) => logs.push(line),
    wiring: { http: recording, scpPodLabels: POD_LABELS }
  };
  return { kube, http, deps, handoffs, withdrawals, logs, events };
}

const spec = (backend: StackBackend, rotateGeneration = 0): StackBackendSpec => ({
  backend,
  enabled: true,
  sizeTier: "small",
  purgeGeneration: 0,
  rotateGeneration
});

const wire = (r: Rig, backend: StackBackend, rotate = 0, recorded?: PutStackWiringRequest) =>
  wireBackend(r.deps, backend, RENDERS[backend]!, {
    spec: spec(backend, rotate),
    recorded: recorded
      ? {
          backend,
          factsSha256: recorded.factsSha256,
          rotationGeneration: recorded.rotationGeneration
        }
      : undefined
  });

describe("M29.2 the auto-wire (wiring.ts)", () => {
  it("the endpoint comes from the RENDERED Service — name, port, container port, selector", () => {
    const r = rig();
    expect(backendEndpoint(r.deps.release, "argocd", RENDERS["argocd"]!)).toEqual({
      serverUrl: "http://argocd-server.scp-argocd.svc",
      namespace: "scp-argocd",
      service: "argocd-server",
      podSelector: { "app.kubernetes.io/name": "argocd-server" },
      targetPort: 8080
    });
    expect(
      backendEndpoint(r.deps.release, "argo-workflows", RENDERS["argo-workflows"]!)?.serverUrl
    ).toBe("https://argo-server.scp-argo-workflows.svc:2746");
    expect(backendEndpoint(r.deps.release, "gitea", RENDERS["gitea"]!)?.targetPort).toBe(3000);
    // A render without the Service is an error, never a guessed URL.
    expect(() => backendEndpoint(r.deps.release, "argocd", [])).toThrow(/has no Service/);
    expect(backendEndpoint(r.deps.release, "argo-events", [])).toBeNull();
    expect(backendEndpoint(r.deps.release, "argo-rollouts", [])).toBeNull();
  });

  it("Argo CD: egress first, then a scoped token minted, handed over, and only THEN the old tokens revoked", async () => {
    const r = rig();
    expect(await wire(r, "argocd")).toEqual([]);
    const np = r.kube.find("NetworkPolicy", egressPolicyName("argocd"), SCP_NS);
    expect(np, "the egress NetworkPolicy was not written into SCP's namespace").toBeDefined();
    expect(np?.["spec"]).toEqual({
      podSelector: { matchLabels: POD_LABELS },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "scp-argocd" } },
              podSelector: { matchLabels: { "app.kubernetes.io/name": "argocd-server" } }
            }
          ],
          ports: [{ protocol: "TCP", port: 8080 }]
        }
      ]
    });
    expect(r.handoffs).toHaveLength(1);
    const req = r.handoffs[0]!.req;
    expect(req).toMatchObject({
      serverUrl: "http://argocd-server.scp-argocd.svc",
      namespace: null,
      caPem: null,
      account: "scp-coordinator",
      token: "ARGO-SECRET-1",
      rotationGeneration: 0
    });
    // Revoked after the hand-off, and only what is not the new one.
    const handoffAt = r.events.indexOf("putWiring argocd");
    const revokeAt = r.events.findIndex((e) => e.startsWith("DELETE /api/v1/account/"));
    expect(handoffAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(handoffAt);
    expect(r.http.argoTokens).toHaveLength(1);
    expect(r.http.argoTokens[0]).toMatch(/^scp-stack-r0-/);
    // The token is in the hand-off and nowhere else the controller writes.
    expect(r.logs.join("\n")).not.toContain("ARGO-SECRET");
    expect(JSON.stringify([...r.kube.objects.values()])).not.toContain("ARGO-SECRET");
  });

  it("is idempotent: facts unchanged and no rotation requested mints nothing", async () => {
    const r = rig();
    await wire(r, "argocd");
    const first = r.handoffs[0]!.req;
    expect(await wire(r, "argocd", 0, first)).toEqual([]);
    expect(r.http.minted).toBe(1);
    expect(r.handoffs).toHaveLength(1);
  });

  it("a rotation request re-mints and revokes the previous token", async () => {
    const r = rig();
    await wire(r, "argocd");
    const first = r.handoffs[0]!.req;
    await wire(r, "argocd", 1, first);
    expect(r.handoffs).toHaveLength(2);
    expect(r.handoffs[1]!.req).toMatchObject({ token: "ARGO-SECRET-2", rotationGeneration: 1 });
    expect(r.http.argoTokens).toHaveLength(1);
    expect(r.http.argoTokens[0]).toMatch(/^scp-stack-r1-/);
  });

  it("a REINSTALLED backend (a new argocd-secret) has forgotten its tokens, so it is re-wired", async () => {
    const r = rig();
    await wire(r, "argocd");
    const first = r.handoffs[0]!.req;
    await r.deps.kube.delete({
      apiVersion: "v1",
      kind: "Secret",
      name: "argocd-secret",
      namespace: "scp-argocd"
    });
    r.kube.seed(secret("argocd-secret", "scp-argocd", {}));
    await wire(r, "argocd", 0, first);
    expect(r.handoffs).toHaveLength(2);
    expect(r.handoffs[1]!.req.factsSha256).not.toBe(first.factsSha256);
  });

  it("Argo Workflows: the ServiceAccount token, the namespace, and the CA argo-server's certificate chains to", async () => {
    const r = rig();
    expect(await wire(r, "argo-workflows")).toEqual([]);
    const req = r.handoffs[0]!.req;
    expect(req).toMatchObject({
      serverUrl: "https://argo-server.scp-argo-workflows.svc:2746",
      namespace: "scp-argo-workflows",
      account: "scp-coordinator",
      token: "SA-TOKEN-1"
    });
    expect(req.caPem ?? "(no CA handed over)").toContain("BEGIN CERTIFICATE");
    const np = r.kube.find("NetworkPolicy", egressPolicyName("argo-workflows"), SCP_NS);
    expect(JSON.stringify(np?.["spec"] ?? "no egress policy")).toContain('"port":2746');
  });

  it("Argo Workflows rotation: a new certificate (argo-server rolled onto it) and a new token Secret", async () => {
    const r = rig();
    await wire(r, "argo-workflows");
    const first = r.handoffs[0]!.req;
    // The kubelet's token controller: fill in a token once the Secret is re-created.
    const kube = r.kube;
    const origApply = r.deps.kube.apply.bind(r.deps.kube);
    r.deps.kube.apply = async (o: KubeObject) => {
      await origApply(o);
      if (o.kind === "Secret" && o.metadata.name === "scp-coordinator-token") {
        const stored = kube.find("Secret", "scp-coordinator-token", "scp-argo-workflows")!;
        stored["data"] = { token: b64("SA-TOKEN-2") };
      }
    };
    expect(await wire(r, "argo-workflows", 1, first)).toEqual([]);
    const second = r.handoffs[1]!.req;
    expect(second.token).toBe("SA-TOKEN-2");
    expect(second.caPem).not.toBe(first.caPem);
    expect(second.rotationGeneration).toBe(1);
    expect(r.kube.merges.map((m) => `${m.kind}/${m.name}`)).toEqual(["Deployment/argo-server"]);
    expect(r.kube.merges[0]!.body).toContain('"stack.commanderscp.io/credentials-rotation":"1"');
  });

  it("Gitea: a write:repository + write:package token for the admin account; only scp-stack- tokens are revoked", async () => {
    const r = rig();
    expect(await wire(r, "gitea")).toEqual([]);
    const mint = r.http.calls.find((c) => c.method === "POST" && c.url.endsWith("/tokens"))!;
    expect((mint.json as { scopes: string[] }).scopes).toEqual(GITEA_TOKEN_SCOPES);
    expect(r.handoffs[0]!.req).toMatchObject({
      serverUrl: "http://scp-gitea-http.scp-gitea.svc:3000",
      account: "scp-gitea-admin",
      token: "GITEA-SECRET-1"
    });
    expect(r.http.giteaTokens.map((t) => t.name).sort()).toEqual(
      [expect.stringMatching(/^scp-stack-r0-/), "someone-elses"].sort()
    );
  });

  it("Argo Events: registered with no endpoint, account or token, and no egress opened", async () => {
    const r = rig();
    expect(await wire(r, "argo-events")).toEqual([]);
    expect(r.handoffs[0]!.req).toMatchObject({
      serverUrl: null,
      namespace: null,
      caPem: null,
      account: null,
      token: null
    });
    expect(r.kube.find("NetworkPolicy", egressPolicyName("argo-events"), SCP_NS)).toBeUndefined();
  });

  it("Argo Rollouts is never wired", async () => {
    const r = rig();
    expect(await wire(r, "argo-rollouts")).toEqual([]);
    expect(r.handoffs).toHaveLength(0);
  });

  it("a step that fails is a 'wiring' need on the Stack page, not a thrown tick", async () => {
    const r = rig();
    r.http.failMint = true;
    const needs = await wire(r, "argocd");
    expect(needs).toEqual([
      { code: "wiring", message: expect.stringMatching(/not wired into SCP yet: minting a token/) }
    ]);
    expect(r.handoffs).toHaveLength(0);
  });

  it("with no labels for scpd's pods there is no egress policy to write — a need, never a policy that selects nothing", async () => {
    const r = rig();
    r.deps.wiring = { ...r.deps.wiring!, scpPodLabels: {} };
    const needs = await wire(r, "argocd");
    expect(needs[0]!.message).toMatch(/SCP_STACKD_SCP_POD_LABELS/);
    expect(r.kube.find("NetworkPolicy", egressPolicyName("argocd"), SCP_NS)).toBeUndefined();
  });

  it("unwiring a backend SCP does not call touches no egress policy — the RBAC names only the three (found on kind: a 403)", async () => {
    const r = rig();
    // stackd-rbac.yaml holds delete to the three called backends' policy names.
    r.kube.forbidden.add("DELETE NetworkPolicy/scp-stack-egress-argo-events");
    await unwireBackend(r.deps, "argo-events", { wasWired: true });
    expect(r.withdrawals).toEqual(["argo-events"]);
    expect(r.kube.calls.some((c) => c.kind === "NetworkPolicy")).toBe(false);
  });

  it("unwiring: scpd first, then the egress policy, then (if it was wired) the backend's tokens", async () => {
    const r = rig();
    await wire(r, "argocd");
    // Unwiring reads the backend's Service live (it still runs), as the wiring derived it.
    for (const o of RENDERS["argocd"]!) if (o.kind === "Service") r.kube.seed(o);
    r.events.length = 0;
    await unwireBackend(r.deps, "argocd", { wasWired: true });
    expect(r.events[0]).toBe("deleteWiring argocd");
    expect(r.kube.find("NetworkPolicy", egressPolicyName("argocd"), SCP_NS)).toBeUndefined();
    expect(r.http.argoTokens).toEqual([]);
  });

  it("the facts digest covers endpoint, namespace, CA, account and backend identity — never the token", () => {
    const f = {
      serverUrl: "http://a.b.svc",
      namespace: null,
      caPem: null,
      account: "x",
      instanceUid: "u1"
    };
    const d = factsDigest("argocd", f);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(factsDigest("argocd", { ...f, instanceUid: "u2" })).not.toBe(d);
    expect(factsDigest("argocd", { ...f, serverUrl: "http://c.d.svc" })).not.toBe(d);
    expect(factsDigest("argocd", { ...f, caPem: "pem" })).not.toBe(d);
    expect(d).not.toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("M29.2 review fixes", () => {
  it("the controller's installed hooks CALL the wiring and the unwiring (not merely reference them)", async () => {
    const r = rig();
    installWiringHooks(r.deps, r.deps.wiring!);
    expect(
      await r.deps.afterReady!("argo-events", RENDERS["argo-events"]!, {
        spec: spec("argo-events"),
        recorded: undefined
      })
    ).toEqual([]);
    expect(r.handoffs.map((h) => h.backend)).toEqual(["argo-events"]);
    await r.deps.unwire!("argo-events", { wasWired: false });
    expect(r.withdrawals).toEqual(["argo-events"]);
  });

  it("a hand-off whose RESPONSE failed after scpd stored it still revokes the old token on the next tick", async () => {
    const r = rig();
    const put = r.deps.api.putWiring;
    let failOnce = true;
    r.deps.api.putWiring = async (backend, req) => {
      await put(backend, req); // scpd committed it ...
      if (failOnce) {
        failOnce = false;
        throw new Error("409 after commit"); // ... and the response was an error
      }
    };
    const needs = await wire(r, "argocd");
    expect(needs).toHaveLength(1);
    expect(r.http.argoTokens).toContain("old-token-id"); // not revoked: the hand-off "failed"
    const stored = r.handoffs[0]!.req;
    // Next tick: scpd reports exactly the stored hand-off, so nothing is re-minted ...
    expect(await wire(r, "argocd", 0, stored)).toEqual([]);
    expect(r.http.minted).toBe(1);
    // ... and the token it left valid is revoked now.
    expect(r.http.argoTokens).not.toContain("old-token-id");
    expect(r.http.argoTokens).toHaveLength(1);
  });

  it("a NAMED targetPort resolves to the selected container's port, and an unresolvable one throws", () => {
    const r = rig();
    const svc: KubeObject = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "argocd-server", namespace: "scp-argocd" },
      spec: {
        selector: { app: "argocd-server" },
        ports: [{ name: "http", port: 80, targetPort: "server" }]
      }
    };
    const deploy = (portName: string): KubeObject => ({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "argocd-server", namespace: "scp-argocd" },
      spec: {
        template: {
          metadata: { labels: { app: "argocd-server" } },
          spec: { containers: [{ name: "s", ports: [{ name: portName, containerPort: 8080 }] }] }
        }
      }
    });
    expect(backendEndpoint(r.deps.release, "argocd", [svc, deploy("server")])!.targetPort).toBe(
      8080
    );
    expect(() => backendEndpoint(r.deps.release, "argocd", [svc, deploy("other")])).toThrow(
      /named port 'server'/
    );
  });
});
