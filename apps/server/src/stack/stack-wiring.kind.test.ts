import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { GraphObject, StackBackend, StackBackendView } from "@scp/schemas";
import {
  KubeClient,
  buildControllerDeps,
  httpsTransport,
  nodeBackendHttp,
  startStackController,
  type KubeTransport,
  type StackControllerHandle
} from "@scp/stackd";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { resolveExecutorPluginInstance } from "../coordination/executor-bindings-repo.js";

/**
 * M29.2 DoD, AGAINST REAL BACKENDS (ADR-0060). A real scpd (Testcontainers Postgres, real
 * `scp_operator` writes), the real stack controller with the chart's own stackd identity, and a kind
 * cluster in which the controller installs a REAL Argo CD, Argo Workflows, Argo Events and Gitea.
 * For each, enabling it THROUGH THE API ALONE must yield a registered execution system and a real
 * read against it — through SCP's own plugin path, with the token, CA, endpoint and egress the
 * controller handed over:
 *
 *   argocd          a discovery run (POST /discovery/run) lists its Applications;
 *   argo-workflows  a trigger submits a trivial workflow, which runs, and observe() lists it;
 *   gitea           a discovery run reads a PRIVATE repository's contents;
 *   argo-events     registered, with no endpoint (SCP never calls it).
 *
 * No kubectl, no values edit, no command copied from a log: the only calls are the API's. The
 * FIXTURES a read needs something to read (an Application, a WorkflowTemplate, a repository) are
 * arranged with a separate cluster-admin identity and never touch a wiring step.
 *
 * WHERE IT RUNS. The plugin subprocess dials in-cluster Service names, so the suite runs inside the
 * kind node's network namespace (`scripts/kind-runner-harness.sh in-cluster-net`, which also points
 * DNS at CoreDNS with a pod's search path). NetworkPolicy is NOT enforced by kindnet: the egress
 * POLICY the controller writes is asserted as an object here and against the real render in
 * helm-verify; the APP-LAYER egress (the SSRF guard, which blocks private addresses by default) is
 * what these reads actually cross. NO SKIP PATH.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const HARNESS_FILE =
  process.env.SCP_KIND_HARNESS ??
  path.join(
    process.env.SCP_KIND_WORKDIR ?? path.join(homedir(), ".cache/scp-kind-runner-harness"),
    "harness.json"
  );
const OPERATOR_TOKEN = "m29-2-kind-operator-token";
const READY_MS = 900_000;

interface Harness {
  apiBase: string;
  netnsApiBase: string;
  caFile: string;
  stackdNamespace: string;
  stackdToken: string;
  stackRegistry: string;
  stackReleaseNamespace: string;
  fixturesToken: string;
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? `: ${String(last)}` : ""}`
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

describe("M29.2 the stack controller wires every backend it installs into SCP (kind, real backends)", () => {
  let harness: Harness;
  let server: ListeningTestServer;
  let org: TestOrg;
  let tenant: ScpClient;
  let stackdKube: KubeClient;
  let fixtures: KubeTransport;
  let workdir: string;
  let controller: StackControllerHandle | undefined;
  let admin: pg.Pool;

  const view = async (b: StackBackend): Promise<StackBackendView> =>
    (await tenant.stack.get()).backends.find((x) => x.backend === b)!;

  const wiredAndReady = (b: StackBackend) =>
    waitFor(`${b} ready and wired`, READY_MS, async () => {
      const v = await view(b);
      if (v.status?.phase === "failed") throw new Error(`${b} failed: ${v.status.lastError}`);
      return v.status?.phase === "ready" && v.wiring?.wired ? v : undefined;
    });

  const registration = async (b: StackBackend): Promise<GraphObject> =>
    waitFor(`the ${b} execution system in the org`, 120_000, async () =>
      (await tenant.object("execution-system").list()).items.find(
        (o) => (o.properties as { stack?: { backend?: string } }).stack?.backend === b
      )
    );

  const fixture = async (method: "POST" | "GET", p: string, body?: unknown) => {
    const res = await fixtures.request({
      method,
      path: p,
      ...(body ? { body: JSON.stringify(body), contentType: "application/json" } : {})
    });
    if (res.status >= 300 && res.status !== 409) {
      throw new Error(`fixture ${method} ${p}: ${res.status} ${res.body.slice(0, 300)}`);
    }
    return res;
  };

  const resolveFor = async (targetObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      resolveExecutorPluginInstance(tx, {
        orgId: org.orgId,
        targetObjectId,
        masterKey: server.deps.config.secretsMasterKey
      })
    );

  beforeAll(async () => {
    if (process.env.SCP_KIND_IN_CLUSTER_NET !== "1") {
      throw new Error(
        "the wiring suite dials in-cluster Service names — run it through `scripts/kind-runner-harness.sh in-cluster-net …` (CI job 4e does). It has no skip path on purpose."
      );
    }
    let raw: string;
    try {
      raw = await readFile(HARNESS_FILE, "utf8");
    } catch {
      throw new Error(
        `no kind harness at ${HARNESS_FILE} — run scripts/kind-runner-harness.sh up first`
      );
    }
    harness = JSON.parse(raw) as Harness;
    if (!harness.fixturesToken || !harness.netnsApiBase) {
      throw new Error(
        `${HARNESS_FILE} predates the M29.2 harness — re-run scripts/kind-runner-harness.sh up`
      );
    }
    workdir = await mkdtemp(path.join(tmpdir(), "stackd-wiring-"));
    const ca = await readFile(harness.caFile);
    const transport = httpsTransport({
      apiBase: harness.netnsApiBase,
      ca,
      readToken: async () => harness.stackdToken
    });
    stackdKube = new KubeClient(transport);
    fixtures = httpsTransport({
      apiBase: harness.netnsApiBase,
      ca,
      readToken: async () => harness.fixturesToken
    });

    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl(),
      withPluginHost: true
    });
    org = await createTestOrg(server, "m29-2-kind");
    // This org is the deployment's bootstrap org, so the stack serves it BY DEFAULT on the first
    // wiring — the single-org install, with no attach step.
    server.deps.config.bootstrapOrgName = org.orgName;
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    await admin.query(
      "TRUNCATE stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations"
    );
    await admin.query(
      "UPDATE stack_settings SET served_orgs_initialized = false WHERE id = 'instance'"
    );
    const tokenId = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_CREDENTIAL_TOKEN_ID: tokenId,
      SCP_STACKD_CREDENTIAL_SHA256: createHash("sha256").update(secret).digest("hex")
    });

    const reg = harness.stackRegistry;
    const overrides = path.join(workdir, "images.json");
    await writeFile(
      overrides,
      JSON.stringify({
        "argocd.image": `${reg}/argoproj/argocd:v3.4.5`,
        "argocd.dexImage": `${reg}/dexidp/dex:v2.45.0`,
        "argocd.valkeyImage": `${reg}/valkey/valkey:8-alpine`,
        "argoWorkflows.serverImage": `${reg}/argoproj/argocli:v4.0.7`,
        "argoWorkflows.controllerImage": `${reg}/argoproj/workflow-controller:v4.0.7`,
        "argoWorkflows.executorImage": `${reg}/argoproj/argoexec:v4.0.7`,
        "argoEvents.image": `${reg}/argoproj/argo-events:v1.9.10`,
        "gitea.image": `${reg}/gitea/gitea:1.26.1-rootless`
      })
    );
    const deps = await buildControllerDeps(
      {
        apiUrl: server.baseUrl,
        operatorCredential: `scp_op_${tokenId}.${secret}`,
        scpNamespace: harness.stackReleaseNamespace,
        stackdNamespace: harness.stackdNamespace,
        release: "kind-wiring",
        chartDir: path.join(REPO, "deploy/helm-bundled"),
        helmPinFile: path.join(REPO, "tools/helm/pin.env"),
        helmBinary: "helm",
        imageOverridesFile: overrides,
        federationRole: "commander",
        intervalMs: 3_000,
        readyTimeoutMs: READY_MS,
        resyncMs: 600_000,
        scpPodLabels: {
          "app.kubernetes.io/name": "commanderscp",
          "app.kubernetes.io/instance": "scp"
        }
      },
      transport,
      {
        pollMs: 3_000,
        crdTimeoutMs: 120_000,
        removeTimeoutMs: 240_000,
        log: (line) => console.log(`[stackd wiring] ${line}`)
      }
    );
    controller = startStackController(deps, { intervalMs: 3_000 });

    // Everything the suite exercises, through the API alone. The controller installs them one at a
    // time in its own order; each `it` below waits for its own backend.
    for (const b of ["argocd", "argo-workflows", "argo-events", "gitea"] as const) {
      await tenant.stack.putBackend(b, { enabled: true }, OPERATOR_TOKEN);
    }
  });

  afterAll(async () => {
    if (tenant) {
      for (const b of ["argocd", "argo-workflows", "argo-events", "gitea"] as const) {
        await tenant.stack.putBackend(b, { enabled: false }, OPERATOR_TOKEN).catch(() => undefined);
      }
      await waitFor("every wired backend removed", 600_000, async () => {
        const v = await tenant.stack.get();
        return v.backends.every((b) => !b.enabled && (b.status?.phase ?? "disabled") === "disabled")
          ? true
          : undefined;
      }).catch((err) => console.warn(String(err)));
    }
    await controller?.stop();
    await server?.close();
    await admin?.end();
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("Argo CD: enabled through the API alone -> registered, wired, egress opened, and a real discovery lists its Applications", async () => {
    const v = await wiredAndReady("argocd");
    expect(v.wiring).toMatchObject({
      wired: true,
      serverUrl: "http://argocd-server.scp-argocd.svc",
      account: "scp-coordinator"
    });
    const sys = await registration("argocd");
    expect(sys.properties).toMatchObject({
      kind: "argocd",
      serverUrl: "http://argocd-server.scp-argocd.svc",
      allowInternalEgress: true
    });
    // The network half of egress, written by the controller into SCP's namespace from the render.
    const np = await stackdKube.get({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      name: "scp-stack-egress-argocd",
      namespace: harness.stackReleaseNamespace
    });
    expect(np, "the controller wrote no egress NetworkPolicy into SCP's namespace").not.toBeNull();
    expect(JSON.stringify(np?.["spec"] ?? null)).toContain('"port":8080');

    // A fixture for the read to find: an Application (arranged with the fixtures identity).
    await fixture("POST", "/apis/argoproj.io/v1alpha1/namespaces/scp-argocd/applications", {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Application",
      metadata: { name: "kind-proof", namespace: "scp-argocd" },
      spec: {
        project: "default",
        source: {
          repoURL: "https://example.invalid/kind-proof.git",
          path: ".",
          targetRevision: "HEAD"
        },
        destination: { server: "https://kubernetes.default.svc", namespace: "default" }
      }
    });
    // THROUGH THE API: the plugin runs with the wiring's endpoint, token and egress allowance.
    const proposal = await waitFor("Argo CD to list kind-proof", 120_000, async () => {
      const p = await tenant.discovery.run({
        pluginModule: "argocd-discovery",
        pluginInstanceId: `kind-argocd-${randomUUID().slice(0, 8)}`,
        config: { executionSystemId: sys.id }
      });
      return p.objects.some((o) => o.name === "kind-proof") ? p : undefined;
    });
    expect(proposal.objects.map((o) => o.name)).toContain("kind-proof");

    // …and the executor's own observe(), through the production resolver and plugin host.
    const comp = await createTestComponent(tenant, { name: "kind-argocd-comp" });
    await tenant.executors.putBinding(comp.id, {
      executionSystemId: sys.id,
      externalRef: "kind-proof"
    });
    const resolved = (await resolveFor(comp.id))!;
    await server.pluginHost!.start([resolved.instanceConfig]);
    const events = await server.pluginHost!.executor(resolved.instanceConfig.id).observe();
    expect(Array.isArray(events)).toBe(true);
  });

  it("Argo Workflows: registered with its CA and namespace; a trivial workflow is SUBMITTED through SCP, runs, and observe() lists it", async () => {
    const v = await wiredAndReady("argo-workflows");
    expect(v.wiring?.serverUrl).toBe("https://argo-server.scp-argo-workflows.svc:2746");
    expect(v.wiring?.caSha256).toMatch(/^[0-9a-f]{64}$/);
    const sys = await registration("argo-workflows");
    expect(sys.properties).toMatchObject({
      kind: "argo-workflows",
      namespace: "scp-argo-workflows"
    });

    await fixture(
      "POST",
      "/apis/argoproj.io/v1alpha1/namespaces/scp-argo-workflows/workflowtemplates",
      {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "WorkflowTemplate",
        metadata: { name: "scp-kind-hello", namespace: "scp-argo-workflows" },
        spec: {
          entrypoint: "hello",
          serviceAccountName: "scp-build",
          templates: [
            {
              name: "hello",
              container: {
                image: `${harness.stackRegistry}/library/alpine:3.20`,
                command: ["sh", "-c", "echo wired by scp-stackd"]
              }
            }
          ]
        }
      }
    );
    // THE ONE FIXTURE THAT IS NETWORK: kind's kindnet ENFORCES NetworkPolicy (v0.24+; measured
    // here — without this, every call to argo-server hangs), and the bundle admits ingress to
    // argo-server only from scpd's pods in SCP's namespace (argo-workflows-networkpolicy.yaml,
    // scpNamespace from the controller). This suite's "scpd" is not a pod: it runs in the kind
    // node's own network namespace, so the node's address is admitted beside that rule — the
    // production rule itself is not changed, and helm-verify holds its selector to scpd's pods.
    const nodes = JSON.parse((await fixture("GET", "/api/v1/nodes")).body) as {
      items: { status: { addresses: { type: string; address: string }[] } }[];
    };
    const nodeIps = nodes.items.flatMap((n) =>
      n.status.addresses.filter((a) => a.type === "InternalIP").map((a) => a.address)
    );
    await fixture("POST", "/apis/networking.k8s.io/v1/namespaces/scp-argo-workflows/networkpolicies", {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "kind-harness-admit-node", namespace: "scp-argo-workflows" },
      spec: {
        podSelector: { matchLabels: { app: "argo-server" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: nodeIps.map((ip) => ({ ipBlock: { cidr: `${ip}/32` } })),
            ports: [{ protocol: "TCP", port: 2746 }]
          }
        ]
      }
    });
    const comp = await createTestComponent(tenant, { name: "kind-wf-comp" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sys.id });
    const resolved = (await resolveFor(comp.id))!;
    // The CA the controller published is this instance's trust anchor, and nothing else is.
    expect(resolved.instanceConfig.trustedCaPem).toContain("BEGIN CERTIFICATE");
    await server.pluginHost!.start([resolved.instanceConfig]);
    const client = server.pluginHost!.executor(resolved.instanceConfig.id);
    const ref = await client.trigger({
      kind: "workflow_dispatch",
      targetRef: "scp-kind-hello",
      idempotencyKey: randomUUID()
    });
    const done = await waitFor("the workflow to finish", 300_000, async () => {
      const s = await client.status(ref);
      return s.phase === "succeeded" || s.phase === "failed" ? s : undefined;
    });
    expect(done.phase, done.detail).toBe("succeeded");
    const events = await client.observe();
    const name = ref.externalId.split("::")[0]!;
    expect(events.map((e) => e.correlation?.correlationKey)).toContain(name);
  });

  it("Gitea: registered and wired; a discovery run reads a PRIVATE repository with the minted token", async () => {
    const v = await wiredAndReady("gitea");
    expect(v.wiring?.serverUrl).toBe("http://scp-gitea-http.scp-gitea.svc:3000");
    const sys = await registration("gitea");
    const owner = v.wiring!.account!;
    // Fixture: a private repository with a component directory, made with Gitea's admin login.
    const secret = JSON.parse(
      (await fixture("GET", "/api/v1/namespaces/scp-gitea/secrets/gitea-admin-secret")).body
    ) as { data: Record<string, string> };
    const pw = Buffer.from(secret.data["password"]!, "base64").toString();
    const auth = `Basic ${Buffer.from(`${owner}:${pw}`).toString("base64")}`;
    const http = nodeBackendHttp();
    const base = "http://scp-gitea-http.scp-gitea.svc:3000/api/v1";
    await http.request({
      method: "POST",
      url: `${base}/user/repos`,
      headers: { authorization: auth },
      json: { name: "kind-proof", private: true, auto_init: true }
    });
    await http.request({
      method: "POST",
      url: `${base}/repos/${owner}/kind-proof/contents/svc/package.json`,
      headers: { authorization: auth },
      json: { content: Buffer.from('{"name":"svc"}').toString("base64"), message: "fixture" }
    });
    // A private repository: anonymously it is invisible, so what follows proves the token.
    expect(
      (await http.request({ method: "GET", url: `${base}/repos/${owner}/kind-proof/contents/` }))
        .status
    ).toBe(404);
    const proposal = await tenant.discovery.run({
      pluginModule: "gitea-discovery",
      pluginInstanceId: `kind-gitea-${randomUUID().slice(0, 8)}`,
      config: { executionSystemId: sys.id, owner, repo: "kind-proof" }
    });
    expect(proposal.objects.map((o) => o.name)).toContain("svc");
  });

  it("Argo Events: registered as an execution system with no endpoint — SCP never calls it", async () => {
    await wiredAndReady("argo-events");
    const sys = await registration("argo-events");
    expect(sys.properties).toEqual({
      kind: "argo-events",
      stack: { backend: "argo-events", managedBy: "scp-stackd" }
    });
  });

  it("a tenant cannot re-point or re-trust a wired system: the write is refused", async () => {
    const sys = await registration("argocd");
    const refuse = async (properties: Record<string, unknown>) => {
      try {
        await tenant
          .object("execution-system")
          .update(sys.id, { properties, version: sys.version });
      } catch (err) {
        if (err instanceof ScpApiError) return err.status ?? -1;
        throw err;
      }
      return 200;
    };
    expect(await refuse({ ...sys.properties, serverUrl: "http://evil.attacker.svc" })).toBe(409);
    expect(await refuse({ ...sys.properties, caPem: "-----BEGIN CERTIFICATE-----" })).toBe(409);
  });

  it("rotation through the API: Argo CD's token and Argo Workflows' certificate are re-minted, and the reads still work", async () => {
    const before = (await view("argo-workflows")).wiring!;
    await tenant.stack.rotate("argocd", OPERATOR_TOKEN);
    await tenant.stack.rotate("argo-workflows", OPERATOR_TOKEN);
    await waitFor("both rotations handed over", READY_MS, async () => {
      const [a, w] = [await view("argocd"), await view("argo-workflows")];
      return a.wiring?.rotationGeneration === 1 && w.wiring?.rotationGeneration === 1
        ? true
        : undefined;
    });
    const after = (await view("argo-workflows")).wiring!;
    expect(after.caSha256).not.toBe(before.caSha256);
    // The rotated CA is the one scpd now trusts: a read over TLS against the rolled argo-server.
    const sys = await registration("argo-workflows");
    const comp = await createTestComponent(tenant, { name: "kind-wf-rotated" });
    await tenant.executors.putBinding(comp.id, { executionSystemId: sys.id });
    const resolved = (await resolveFor(comp.id))!;
    await server.pluginHost!.start([resolved.instanceConfig]);
    await waitFor("observe over the rotated certificate", 180_000, async () => {
      await server.pluginHost!.executor(resolved.instanceConfig.id).observe();
      return true;
    });
    const argo = await registration("argocd");
    const proposal = await tenant.discovery.run({
      pluginModule: "argocd-discovery",
      pluginInstanceId: `kind-argocd-rot-${randomUUID().slice(0, 8)}`,
      config: { executionSystemId: argo.id }
    });
    expect(proposal.objects.map((o) => o.name)).toContain("kind-proof");
  });

  it("disabling unwires: the token and egress go, and the registration refuses to resolve", async () => {
    await tenant.stack.putBackend("gitea", { enabled: false }, OPERATOR_TOKEN);
    await waitFor("gitea disabled and unwired", 600_000, async () => {
      const v = await view("gitea");
      return v.status?.phase === "disabled" && v.wiring?.wired === false ? v : undefined;
    });
    expect(
      await stackdKube.get({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        name: "scp-stack-egress-gitea",
        namespace: harness.stackReleaseNamespace
      })
    ).toBeNull();
    const sys = await registration("gitea");
    let status = 0;
    try {
      await tenant.discovery.run({
        pluginModule: "gitea-discovery",
        pluginInstanceId: `kind-gitea-off-${randomUUID().slice(0, 8)}`,
        config: { executionSystemId: sys.id, owner: "x", repo: "y" }
      });
    } catch (err) {
      status = err instanceof ScpApiError ? (err.status ?? -1) : -1;
    }
    expect(status).toBe(409);
  });
});
