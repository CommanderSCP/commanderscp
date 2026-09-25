import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { StackBackendView } from "@scp/schemas";
import {
  KubeClient,
  buildControllerDeps,
  httpsTransport,
  startStackController,
  type KubeObject,
  type KubeTransport,
  type StackControllerHandle
} from "@scp/stackd";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";

/**
 * M29.4 DoD, AGAINST A REAL API SERVER (ADR-0058). A real scpd (Testcontainers Postgres, real
 * `scp_operator` writes), the real stack controller (`@scp/stackd`, the same code the scp-stackd
 * image bundles), the real vendored chart rendered by the pinned helm, and a kind cluster — with the
 * controller authenticating to Kubernetes as the ServiceAccount the MAIN CHART's own
 * `stackd-rbac.yaml` creates (applied by `scripts/kind-runner-harness.sh up`). So:
 *
 *   - enabling a backend THROUGH THE API ALONE installs it, and its status reaches `ready`;
 *   - disabling it removes it;
 *   - a release whose image never becomes ready falls back to the last good set;
 *   - its state lives in its OWN namespace, and scpd holds the digests of it;
 *   - the runner's identity — which may create Jobs where it runs — can neither run a pod as the
 *     controller nor read its credential or state (review B1: the takeover Job is refused);
 *   - and every Kubernetes call it made was one the chart's RBAC permits.
 *
 * Argo Events is the backend: three CRDs, cluster RBAC and a Deployment — every step the controller
 * has (CRDs first, cluster-scoped roles, workloads, readiness, prune) at ~12 objects. Its image is
 * served from a registry inside the cluster's network (the harness's), retargeted with
 * `stackd.imageOverrides` exactly as the air-gap install does, because the vendored manifest says
 * `imagePullPolicy: Always` and CI has no route to quay.io.
 *
 * NO SKIP PATH. Without `harness.json` this fails, naming the script to run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const HARNESS_FILE =
  process.env.SCP_KIND_HARNESS ??
  path.join(
    process.env.SCP_KIND_WORKDIR ?? path.join(homedir(), ".cache/scp-kind-runner-harness"),
    "harness.json"
  );
const OPERATOR_TOKEN = "m29-4-kind-operator-token";

interface Harness {
  apiBase: string;
  /** M29.2: the API server as seen from inside the kind node's network namespace. */
  netnsApiBase?: string;
  caFile: string;
  /** The runner namespace and the runner ServiceAccount's token (the chart's runner Role). */
  namespace: string;
  token: string;
  stackdNamespace: string;
  stackdToken: string;
  stackRegistry: string;
}

const STACKD_SA = "scp-commanderscp-stackd";

/** CI runs the server's kind suites inside the kind node's network namespace (M29.2 — the wiring
 *  suite dials in-cluster Services), where the API server is the node's own :6443. */
const apiBaseOf = (h: Harness): string =>
  process.env.SCP_KIND_IN_CLUSTER_NET === "1" && h.netnsApiBase ? h.netnsApiBase : h.apiBase;

const EVENTS_NS = "scp-argo-events";

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
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

describe("M29.4 the stack controller installs, removes and falls back on a real cluster (kind)", () => {
  let harness: Harness;
  let server: ListeningTestServer;
  let tenant: ScpClient;
  let transport: KubeTransport;
  let kube: KubeClient;
  let credential: string;
  let workdir: string;
  let controller: StackControllerHandle | undefined;

  const events = async (): Promise<StackBackendView> =>
    (await tenant.stack.get()).backends.find((b) => b.backend === "argo-events")!;

  async function startController(opts: {
    release: string;
    image: string;
    readyTimeoutMs: number;
  }): Promise<StackControllerHandle> {
    const overrides = path.join(workdir, `images-${opts.release}.json`);
    await writeFile(overrides, JSON.stringify({ "argoEvents.image": opts.image }));
    const deps = await buildControllerDeps(
      {
        apiUrl: server.baseUrl,
        operatorCredential: credential,
        scpNamespace: "scp-release-harness",
        stackdNamespace: harness.stackdNamespace,
        release: opts.release,
        chartDir: path.join(REPO, "deploy/helm-bundled"),
        helmPinFile: path.join(REPO, "tools/helm/pin.env"),
        helmBinary: "helm",
        imageOverridesFile: overrides,
        federationRole: "commander",
        intervalMs: 2_000,
        readyTimeoutMs: opts.readyTimeoutMs,
        resyncMs: 600_000,
        scpPodLabels: {
          "app.kubernetes.io/name": "commanderscp",
          "app.kubernetes.io/instance": "scp"
        }
      },
      transport,
      {
        pollMs: 2_000,
        crdTimeoutMs: 60_000,
        removeTimeoutMs: 180_000,
        log: (line) => console.log(`[stackd ${opts.release}] ${line}`)
      }
    );
    return startStackController(deps, { intervalMs: 2_000 });
  }

  const deployment = () =>
    kube.get({
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "controller-manager",
      namespace: EVENTS_NS
    });
  const imageOf = (d: KubeObject | null) =>
    (d?.["spec"] as { template: { spec: { containers: { image: string }[] } } } | undefined)
      ?.template.spec.containers[0]?.image;
  const available = (d: KubeObject | null) =>
    Number((d?.["status"] as { availableReplicas?: number } | undefined)?.availableReplicas ?? 0);

  beforeAll(async () => {
    let raw: string;
    try {
      raw = await readFile(HARNESS_FILE, "utf8");
    } catch {
      throw new Error(
        `no kind harness at ${HARNESS_FILE} — run scripts/kind-runner-harness.sh up first. This suite has no skip path on purpose.`
      );
    }
    harness = JSON.parse(raw) as Harness;
    if (!harness.stackdToken || !harness.stackRegistry) {
      throw new Error(
        `${HARNESS_FILE} predates the stack controller harness (M29.4) — re-run scripts/kind-runner-harness.sh up`
      );
    }
    workdir = await mkdtemp(path.join(tmpdir(), "stackd-kind-"));
    const ca = await readFile(harness.caFile);
    // THE CHART'S identity: a token for the ServiceAccount stackd-rbac.yaml created.
    transport = httpsTransport({
      apiBase: apiBaseOf(harness),
      ca,
      readToken: async () => harness.stackdToken
    });
    kube = new KubeClient(transport);

    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl()
    });
    const org = await createTestOrg(server, "m29-4-kind");
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // What the migrations Job does on a Helm install: record the controller's credential from the
    // id and sha256 the chart hands it — the Job never holds the credential itself.
    const tokenId = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    credential = `scp_op_${tokenId}.${secret}`;
    const admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      await provisionInstallTimePrincipals(admin, server.deps.config, {
        SCP_STACKD_CREDENTIAL_TOKEN_ID: tokenId,
        SCP_STACKD_CREDENTIAL_SHA256: createHash("sha256").update(secret).digest("hex")
      });
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    await controller?.stop();
    await server?.close();
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  const goodImage = () => `${harness.stackRegistry}/argoproj/argo-events:v1.9.10`;

  it("enabling Argo Events through the API alone installs it, and its status reaches ready", async () => {
    controller = await startController({
      release: "kind-a",
      image: goodImage(),
      readyTimeoutMs: 240_000
    });
    expect((await events()).enabled).toBe(false);
    await tenant.stack.putBackend("argo-events", { enabled: true }, OPERATOR_TOKEN);

    const ready = await waitFor("argo-events ready", 300_000, async () => {
      const b = await events();
      return b.status?.phase === "ready" ? b : undefined;
    });
    expect(ready.status).toMatchObject({
      runningVersion: "kind-a",
      targetVersion: "kind-a",
      lastError: null
    });
    const view = await tenant.stack.get();
    expect(view.controller.reporting).toBe(true);
    expect(view.controller.release).toBe("kind-a");

    const dep = await deployment();
    expect(imageOf(dep)).toBe(goodImage());
    expect(available(dep)).toBeGreaterThanOrEqual(1);
    expect(dep?.metadata.labels?.["stack.commanderscp.io/managed-by"]).toBe("scp-stackd");
    const crd = await kube.get({
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      name: "eventbus.argoproj.io"
    });
    expect(crd).not.toBeNull();
    // Server-side apply, under the controller's own field manager.
    const managers = (
      (dep?.metadata as { managedFields?: { manager: string; operation: string }[] })
        .managedFields ?? []
    ).map((f) => `${f.manager}:${f.operation}`);
    expect(managers).toContain("scp-stackd:Apply");

    // Its memory is in ITS namespace, and scpd holds the digests of it (review S1).
    const state = await kube.get({
      apiVersion: "v1",
      kind: "Secret",
      name: "scp-stackd-argo-events-state",
      namespace: harness.stackdNamespace
    });
    expect(state).not.toBeNull();
    const spec = await tenant.stack.spec(OPERATOR_TOKEN);
    const integrity = spec.integrity.find((i) => i.backend === "argo-events")!;
    expect(integrity.lastGoodSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(integrity.inventorySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("B1: the runner's identity cannot run a pod as the controller, nor read its secrets", async () => {
    const ca = await readFile(harness.caFile);
    const runner = httpsTransport({
      apiBase: apiBaseOf(harness),
      ca,
      readToken: async () => harness.token
    });
    const can = async (namespace: string, group: string, resource: string, verb: string) => {
      const res = await runner.request({
        method: "POST",
        path: "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
        contentType: "application/json",
        body: JSON.stringify({
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: { resourceAttributes: { namespace, group, resource, verb } }
        })
      });
      expect(res.status, res.body).toBe(201);
      return (JSON.parse(res.body) as { status: { allowed: boolean } }).status.allowed;
    };
    // Known-positive control: where the runner runs, it CAN create Jobs — the very right that,
    // in the controller's namespace, would be a takeover.
    expect(await can(harness.namespace, "batch", "jobs", "create")).toBe(true);
    for (const [group, resource, verb] of [
      ["batch", "jobs", "create"],
      ["", "pods", "create"],
      ["apps", "deployments", "create"],
      ["", "secrets", "get"],
      ["", "secrets", "list"],
      ["", "serviceaccounts/token", "create"]
    ] as const) {
      expect(await can(harness.stackdNamespace, group, resource, verb), `${verb} ${resource}`).toBe(
        false
      );
    }
    // And the takeover itself, as the review wrote it: a Job running as the controller.
    const takeover = await runner.request({
      method: "POST",
      path: `/apis/batch/v1/namespaces/${harness.stackdNamespace}/jobs`,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: "takeover" },
        spec: {
          template: {
            spec: {
              serviceAccountName: STACKD_SA,
              restartPolicy: "Never",
              containers: [{ name: "t", image: "busybox", command: ["true"] }]
            }
          }
        }
      })
    });
    expect(takeover.status, takeover.body).toBe(403);
  });

  it("disabling it through the API removes it (the CRDs, like helm's, are kept)", async () => {
    await tenant.stack.putBackend("argo-events", { enabled: false }, OPERATOR_TOKEN);
    await waitFor("argo-events disabled", 240_000, async () => {
      const b = await events();
      return b.status?.phase === "disabled" ? b : undefined;
    });
    expect(await deployment()).toBeNull();
    expect(
      await kube.get({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRole",
        name: "argo-events-role"
      })
    ).toBeNull();
    // Nothing left to fall back to; the state records nothing installed.
    expect(
      await kube.get({
        apiVersion: "v1",
        kind: "Secret",
        name: "scp-stackd-argo-events-lastgood-0",
        namespace: harness.stackdNamespace
      })
    ).toBeNull();
    const state = await kube.get({
      apiVersion: "v1",
      kind: "Secret",
      name: "scp-stackd-argo-events-state",
      namespace: harness.stackdNamespace
    });
    const recorded = JSON.parse(
      Buffer.from((state!["data"] as Record<string, string>)["state.json"]!, "base64").toString()
    ) as { inventory: unknown[]; lastGood: unknown };
    expect(recorded).toMatchObject({ inventory: [], lastGood: null });
    expect(
      await kube.get({
        apiVersion: "apiextensions.k8s.io/v1",
        kind: "CustomResourceDefinition",
        name: "eventbus.argoproj.io"
      })
    ).not.toBeNull();
  });

  it("an upgrade whose image never becomes ready falls back to the last good set", async () => {
    await tenant.stack.putBackend("argo-events", { enabled: true }, OPERATOR_TOKEN);
    await waitFor("argo-events ready again", 300_000, async () => {
      const b = await events();
      return b.status?.phase === "ready" ? b : undefined;
    });
    await controller!.stop();

    // A NEW SCP RELEASE whose Argo Events image does not exist: what an upgrade to a broken build
    // looks like from the cluster. The controller must not leave the backend down.
    controller = await startController({
      release: "kind-b",
      image: `${harness.stackRegistry}/argoproj/argo-events:never-pushed`,
      readyTimeoutMs: 45_000
    });
    const rolledBack = await waitFor("the fallback to kind-a", 300_000, async () => {
      const b = await events();
      return b.status?.phase === "degraded" && b.status.targetVersion === "kind-b" ? b : undefined;
    });
    expect(rolledBack.status).toMatchObject({ runningVersion: "kind-a", targetVersion: "kind-b" });
    expect(rolledBack.status?.needs.map((n) => n.code)).toContain("upgrade-rolled-back");
    expect(rolledBack.status?.lastError).toMatch(/rolled back to kind-a/);

    const dep = await waitFor("the restored Deployment to be available", 180_000, async () => {
      const d = await deployment();
      return imageOf(d) === goodImage() && available(d) >= 1 ? d : undefined;
    });
    expect(imageOf(dep)).toBe(goodImage());

    // And the diagnostics bundle carries the evidence of the failed attempt.
    const diag = await tenant.stack.diagnostics(OPERATOR_TOKEN);
    const detail = diag.backends.find((b) => b.backend === "argo-events")?.detail ?? [];
    expect(detail.some((d) => d.startsWith("(failed attempt)"))).toBe(true);

    // Clean up through the API, as an operator would.
    await tenant.stack.putBackend("argo-events", { enabled: false }, OPERATOR_TOKEN);
    await waitFor("argo-events removed", 240_000, async () => {
      const b = await events();
      return b.status?.phase === "disabled" ? b : undefined;
    });
  });
});
