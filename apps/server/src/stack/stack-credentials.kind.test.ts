import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject, StackBackend, StackBackendView } from "@scp/schemas";
import {
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
 * M29.5 DoD, AGAINST REAL BACKENDS (ADR-0062): A REGISTRY TOKEN ENTERED THROUGH THE API LETS A REAL
 * BUILD PUSH.
 *
 * A real scpd (Testcontainers Postgres, real `scp_operator`), the real stack controller with the
 * chart's own stackd identity, and a kind cluster in which it installs a REAL Argo Workflows and
 * a REAL Gitea. The registry push token — minted on the bundled Gitea, as a customer would mint
 * one on their registry — is entered through SCP's API ONLY: scpd seals it to the controller, the
 * controller writes it into `scp-build-registry` in the Argo Workflows namespace, and SCP's own
 * plugin path submits the SHIPPED `scp-build-image-v1` template: rootless BuildKit builds the
 * image and pushes it to the bundled Gitea's container registry with that token. Then the value is
 * searched for everywhere SCP keeps anything — every row of every table, every line scpd and the
 * controller logged, the audit rows, and the logs of the backend pods — and found nowhere.
 *
 * No kubectl, no Secret made by hand: the only credential write is the API's. FIXTURES (the source
 * repository, the token minted on Gitea, the node's admission to argo-server — see the wiring
 * suite) use a separate identity and never touch a credential step.
 *
 * ONE DEPLOYMENT VALUE differs from the chart default, said plainly: `buildImage.sourceHost` names
 * the bundled Gitea (`http://scp-gitea-http.scp-gitea.svc:3000`) instead of github.com, set in a
 * copy of the chart the way an operator sets a deployment value. Making the bundled forge the
 * default source is a forge-choice setting (D6), not a credential.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const HARNESS_FILE =
  process.env.SCP_KIND_HARNESS ??
  path.join(
    process.env.SCP_KIND_WORKDIR ?? path.join(homedir(), ".cache/scp-kind-runner-harness"),
    "harness.json"
  );
const OPERATOR_TOKEN = "m29-5-kind-operator-token";
const READY_MS = 900_000;
const GITEA = "http://scp-gitea-http.scp-gitea.svc:3000";
const GITEA_HOST = "scp-gitea-http.scp-gitea.svc:3000";
const WF_NS = "scp-argo-workflows";

interface Harness {
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

describe("M29.5 a registry token entered through SCP lets a REAL build push (kind, real Argo Workflows + Gitea)", () => {
  let harness: Harness;
  let server: ListeningTestServer;
  let org: TestOrg;
  let people: ScpClient;
  let fixtures: KubeTransport;
  let workdir: string;
  let controller: StackControllerHandle | undefined;
  let admin: pg.Pool;
  const scpdLog: string[] = [];
  const controllerLog: string[] = [];
  let pushToken = "";

  const view = async (b: StackBackend): Promise<StackBackendView> =>
    (await people.stack.get()).backends.find((x) => x.backend === b)!;
  const wiredAndReady = (b: StackBackend) =>
    waitFor(`${b} ready and wired`, READY_MS, async () => {
      const v = await view(b);
      if (v.status?.phase === "failed") throw new Error(`${b} failed: ${v.status.lastError}`);
      return v.status?.phase === "ready" && v.wiring?.wired ? v : undefined;
    });
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

  beforeAll(async () => {
    if (process.env.SCP_KIND_IN_CLUSTER_NET !== "1") {
      throw new Error(
        "the credentials suite dials in-cluster Service names — run it through `scripts/kind-runner-harness.sh in-cluster-net …` (CI job 4e does). It has no skip path on purpose."
      );
    }
    harness = JSON.parse(await readFile(HARNESS_FILE, "utf8")) as Harness;
    workdir = await mkdtemp(path.join(tmpdir(), "stackd-credentials-"));
    const ca = await readFile(harness.caFile);
    const transport = httpsTransport({
      apiBase: harness.netnsApiBase,
      ca,
      readToken: async () => harness.stackdToken
    });
    fixtures = httpsTransport({
      apiBase: harness.netnsApiBase,
      ca,
      readToken: async () => harness.fixturesToken
    });

    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl(),
      withPluginHost: true,
      logSink: { write: (line: string) => scpdLog.push(line) }
    });
    org = await createTestOrg(server, "m29-5-kind");
    server.deps.config.bootstrapOrgName = org.orgName;
    people = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    await admin.query(
      "TRUNCATE stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations, stack_credentials"
    );
    await admin.query(
      "UPDATE stack_settings SET served_orgs_initialized = false, credential_sealing_key = NULL, credential_sealing_key_sha256 = NULL WHERE id = 'instance'"
    );
    const tokenId = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_CREDENTIAL_TOKEN_ID: tokenId,
      SCP_STACKD_CREDENTIAL_SHA256: createHash("sha256").update(secret).digest("hex")
    });

    // The chart the controller carries, with the one deployment value above changed.
    const chartDir = path.join(workdir, "helm-bundled");
    await cp(path.join(REPO, "deploy/helm-bundled"), chartDir, { recursive: true });
    const valuesFile = path.join(chartDir, "values.yaml");
    const values = await readFile(valuesFile, "utf8");
    if (!values.includes("sourceHost: github.com")) throw new Error("values.yaml moved sourceHost");
    await writeFile(valuesFile, values.replace("sourceHost: github.com", `sourceHost: ${GITEA}`));

    const reg = harness.stackRegistry;
    const overrides = path.join(workdir, "images.json");
    await writeFile(
      overrides,
      JSON.stringify({
        "argoWorkflows.serverImage": `${reg}/argoproj/argocli:v4.0.7`,
        "argoWorkflows.controllerImage": `${reg}/argoproj/workflow-controller:v4.0.7`,
        "argoWorkflows.executorImage": `${reg}/argoproj/argoexec:v4.0.7`,
        "argoWorkflows.catalog.buildImage.builderImage": `${reg}/moby/buildkit:v0.33.0-rootless`,
        "argoWorkflows.catalog.buildImage.gitImage": `${reg}/alpine/git:2.47.2`,
        "gitea.image": `${reg}/gitea/gitea:1.26.1-rootless`
      })
    );
    const deps = await buildControllerDeps(
      {
        apiUrl: server.baseUrl,
        operatorCredential: `scp_op_${tokenId}.${secret}`,
        scpNamespace: harness.stackReleaseNamespace,
        stackdNamespace: harness.stackdNamespace,
        release: "kind-credentials",
        chartDir,
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
        log: (line) => {
          controllerLog.push(line);
          console.log(`[stackd credentials] ${line}`);
        }
      }
    );
    controller = startStackController(deps, { intervalMs: 3_000 });
    for (const b of ["argo-workflows", "gitea"] as const) {
      await people.stack.putBackend(b, { enabled: true }, OPERATOR_TOKEN);
    }
  });

  afterAll(async () => {
    // The backends are left installed for the wiring suite that follows in the same job (it
    // enables all four and removes them in its own afterAll); the controller and scpd stop here.
    await controller?.stop();
    await server?.close();
    await admin?.end();
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("the token is entered through the API alone, lands in scp-build-registry, a real scp-build-image-v1 run pushes with it, and the value is in no SCP table, log or audit row", async () => {
    const giteaView = await wiredAndReady("gitea");
    await wiredAndReady("argo-workflows");
    // A clean slate on a reused cluster (a local re-run): no push Secret left by an earlier run.
    await fixtures.request({
      method: "DELETE",
      path: `/api/v1/namespaces/${WF_NS}/secrets/scp-build-registry`
    });
    // Before any credential: the Stack page names what the build templates still need.
    await waitFor("the credentials need reported", 120_000, async () =>
      (await view("argo-workflows")).status?.needs.some((n) => n.code === "credentials")
        ? true
        : undefined
    );

    // FIXTURE: a public source repository on the bundled Gitea, and a push token minted there —
    // what a customer would mint on their own registry. Gitea's admin login, not a credential step.
    const giteaAdmin = JSON.parse(
      (await fixture("GET", "/api/v1/namespaces/scp-gitea/secrets/gitea-admin-secret")).body
    ) as { data: Record<string, string> };
    const owner = giteaView.wiring!.account!;
    const pw = Buffer.from(giteaAdmin.data["password"]!, "base64").toString();
    const basic = `Basic ${Buffer.from(`${owner}:${pw}`).toString("base64")}`;
    const http = nodeBackendHttp();
    const api = `${GITEA}/api/v1`;
    const repo = `kind-build-${randomUUID().slice(0, 8)}`;
    const created = await http.request({
      method: "POST",
      url: `${api}/user/repos`,
      headers: { authorization: basic },
      json: { name: repo, private: false, auto_init: true, default_branch: "main" }
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dockerfile = "FROM scratch\nCOPY Dockerfile /Dockerfile\n";
    const commit = await http.request({
      method: "POST",
      url: `${api}/repos/${owner}/${repo}/contents/Dockerfile`,
      headers: { authorization: basic },
      json: { content: Buffer.from(dockerfile).toString("base64"), message: "fixture" }
    });
    expect(commit.status, JSON.stringify(commit.body)).toBe(201);
    const sourceCommit = (commit.body as { commit: { sha: string } }).commit.sha;
    const minted = await http.request({
      method: "POST",
      url: `${api}/users/${owner}/tokens`,
      headers: { authorization: basic },
      json: { name: `m29-5-push-${randomUUID().slice(0, 8)}`, scopes: ["write:package"] }
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    pushToken = (minted.body as { sha1: string }).sha1;
    expect(pushToken.length).toBeGreaterThan(20);

    // THROUGH THE API — the only credential write in this suite.
    const target = {
      backend: "argo-workflows" as const,
      secretName: "scp-build-registry" as const
    };
    await people.stack.setCredential({ ...target, key: "registryUsername" }, owner, OPERATOR_TOKEN);
    await people.stack.setCredential(
      { ...target, key: "registryHost" },
      GITEA_HOST,
      OPERATOR_TOKEN
    );
    await people.stack.setCredential(
      { ...target, key: "registryPassword" },
      pushToken,
      OPERATOR_TOKEN
    );
    await waitFor("the three keys delivered", 180_000, async () => {
      const v = await people.stack.credentials(OPERATOR_TOKEN);
      const keys = v.secrets.find((s) => s.secretName === "scp-build-registry")!.keys;
      const bad = keys.find((k) => k.state === "failed");
      if (bad) throw new Error(`${bad.key} failed: ${bad.error}`);
      return ["registryUsername", "registryHost", "registryPassword"].every(
        (k) => keys.find((x) => x.key === k)?.state === "set"
      )
        ? true
        : undefined;
    });
    // …and the build's need is gone from the Stack page.
    await waitFor("the credentials need cleared", 120_000, async () =>
      (await view("argo-workflows")).status?.needs.some((n) => n.code === "credentials")
        ? undefined
        : true
    );

    // The node's admission to argo-server — the wiring suite's one network fixture, for the same
    // reason (this suite's scpd is not a pod).
    const nodes = JSON.parse((await fixture("GET", "/api/v1/nodes")).body) as {
      items: { status: { addresses: { type: string; address: string }[] } }[];
    };
    const nodeIps = nodes.items.flatMap((n) =>
      n.status.addresses.filter((a) => a.type === "InternalIP").map((a) => a.address)
    );
    await fixture("POST", `/apis/networking.k8s.io/v1/namespaces/${WF_NS}/networkpolicies`, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "kind-harness-admit-node", namespace: WF_NS },
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

    // THE REAL BUILD, through SCP's own plugin path: the shipped template, the registration the
    // controller wired, parameters as a build trigger carries them.
    const sys = await waitFor("the argo-workflows execution system", 120_000, async () =>
      (await people.object("execution-system").list()).items.find(
        (o: GraphObject) =>
          (o.properties as { stack?: { backend?: string } }).stack?.backend === "argo-workflows"
      )
    );
    const comp = await createTestComponent(people, { name: `kind-build-${repo}` });
    await people.executors.putBinding(comp.id, { executionSystemId: sys.id });
    const resolved = (await withTenantTx(server.deps.db, org.orgId, (tx) =>
      resolveExecutorPluginInstance(tx, {
        orgId: org.orgId,
        targetObjectId: comp.id,
        masterKey: server.deps.config.secretsMasterKey
      })
    ))!;
    await server.pluginHost!.start([resolved.instanceConfig]);
    const client = server.pluginHost!.executor(resolved.instanceConfig.id);
    const ref = await client.trigger({
      kind: "workflow_dispatch",
      targetRef: "scp-build-image-v1",
      idempotencyKey: randomUUID(),
      parameters: {
        sourceRepo: `${owner}/${repo}`,
        sourceCommit,
        imageRepository: `${owner}/${repo}`,
        imageDestination: `${GITEA_HOST}/${owner}/${repo}`,
        registryUrl: GITEA
      }
    });
    const done = await waitFor("the build to finish", 600_000, async () => {
      const s = await client.status(ref);
      return s.phase === "succeeded" || s.phase === "failed" ? s : undefined;
    });
    const workflow = ref.externalId.split("::")[0]!;
    const pods = JSON.parse(
      (
        await fixture(
          "GET",
          `/api/v1/namespaces/${WF_NS}/pods?labelSelector=${encodeURIComponent(`workflows.argoproj.io/workflow=${workflow}`)}`
        )
      ).body
    ) as { items: { metadata: { name: string }; spec: { containers: { name: string }[] } }[] };
    const podLogs: string[] = [];
    for (const p of pods.items) {
      for (const c of p.spec.containers) {
        const res = await fixtures.request({
          method: "GET",
          path: `/api/v1/namespaces/${WF_NS}/pods/${p.metadata.name}/log?container=${c.name}`
        });
        podLogs.push(`--- ${p.metadata.name}/${c.name}\n${res.body}`);
      }
    }
    expect(done.phase, `${done.detail}\n${podLogs.join("\n").slice(-4000)}`).toBe("succeeded");

    // THE PUSH HAPPENED: the image is in the bundled Gitea's container registry, at the commit.
    const packages = await http.request({
      method: "GET",
      url: `${api}/packages/${owner}?type=container&q=${repo}`,
      headers: { authorization: basic }
    });
    const listed = packages.body as { name: string; version: string }[];
    expect(listed.map((p) => `${p.name}:${p.version}`)).toContain(`${repo}:${sourceCommit}`);

    // THE VALUE IS NOWHERE SCP KEEPS ANYTHING: every row of every table, every scpd and controller
    // log line, the audit rows, and the backend pods' logs (argo-server, the controller, the build).
    const tables = (
      await admin.query<{ s: string; t: string }>(
        `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
          WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`
      )
    ).rows;
    expect(tables.length).toBeGreaterThan(50);
    let dump = "";
    for (const { s, t } of tables) {
      const rows = await admin.query(`SELECT to_jsonb(x)::text AS j FROM "${s}"."${t}" x`);
      dump += rows.rows.map((r: { j: string }) => r.j).join("\n");
    }
    expect(dump).toContain(org.orgName); // known-positive: this IS the database
    for (const ns of [WF_NS, "scp-gitea"]) {
      const list = JSON.parse((await fixture("GET", `/api/v1/namespaces/${ns}/pods`)).body) as {
        items: { metadata: { name: string }; spec: { containers: { name: string }[] } }[];
      };
      for (const p of list.items) {
        for (const c of p.spec.containers) {
          const res = await fixtures.request({
            method: "GET",
            path: `/api/v1/namespaces/${ns}/pods/${p.metadata.name}/log?container=${c.name}`
          });
          podLogs.push(res.body);
        }
      }
    }
    const audit = JSON.stringify(
      (await admin.query("SELECT * FROM instance_audit_events ORDER BY seq")).rows
    );
    expect(audit).toContain("stack.credential.delivered");
    const forms = [
      pushToken,
      Buffer.from(pushToken).toString("base64"),
      Buffer.from(pushToken).toString("base64").replace(/=+$/, ""),
      Buffer.from(pushToken).toString("hex")
    ];
    for (const f of forms) {
      expect(dump.includes(f), "a database row contains the token").toBe(false);
      expect(scpdLog.join("\n").includes(f), "an scpd log line contains the token").toBe(false);
      expect(controllerLog.join("\n").includes(f), "a controller log line contains the token").toBe(
        false
      );
      expect(audit.includes(f), "an audit row contains the token").toBe(false);
      expect(podLogs.join("\n").includes(f), "a backend pod log contains the token").toBe(false);
    }
  });
});
