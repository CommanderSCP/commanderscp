import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { StackBackend, StackBackendView } from "@scp/schemas";
import {
  KubeClient,
  buildControllerDeps,
  httpsTransport,
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
import { changePlans, changeWaveTargets, changeWaves, decisions } from "../db/schema.js";
import { upsertComponentRollout } from "../coordination-as-code/rollout-convergence-repo.js";
import { nameWithIdentity } from "../coordination/deploy-lane-trigger-parameters.js";

/**
 * M29.3 DoD, ON A REAL ROLLOUTS CONTROLLER (ADR-0062). A real scpd (Testcontainers Postgres, the
 * real reconcile loop and plugin host), the real stack controller with the chart's own stackd
 * identity, and a kind cluster in which the controller installs a REAL Argo CD, Gitea and Argo
 * Rollouts. Enabling the three THROUGH THE API ALONE must let a component's canary advance through
 * its steps on the real Rollouts controller — no kubectl, no values edit, no carrier hosted by
 * anyone, no project or authoring declared by anyone:
 *
 *   - the controller pushes the carrier into the bundled Gitea, applies the authoring AppProject
 *     and hands scpd the commit; scpd derives the registered Argo CD's authoring;
 *   - a component declaring a deployment and a CanaryRollout is released twice through SCP: the
 *     second release walks setWeight 50 -> timed pause -> 100 on the real controller, and SCP's own
 *     observation follows it to Healthy;
 *   - a cluster registered with Argo CD gets a Rollouts-to-target Application in the controller's
 *     project, and is not handed over (a place naming it is refused) until that install is healthy;
 *   - disabling Argo Rollouts withdraws authoring, and the next canary is REFUSED with a Decision —
 *     the Rollout is not touched, never replaced by a plain rolling update.
 *
 * The FIXTURES (reads of the cluster to watch the steps, the second cluster registered with Argo CD
 * as an Argo CD administrator would) use a separate cluster-admin identity and never touch a
 * wiring step. Runs inside the kind node's network namespace, like the wiring suite. NO SKIP PATH.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const HARNESS_FILE =
  process.env.SCP_KIND_HARNESS ??
  path.join(
    process.env.SCP_KIND_WORKDIR ?? path.join(homedir(), ".cache/scp-kind-runner-harness"),
    "harness.json"
  );
const OPERATOR_TOKEN = "m29-3-kind-operator-token";
const READY_MS = 900_000;
const BACKENDS = ["argocd", "gitea", "argo-rollouts"] as const;

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
  probe: () => Promise<T | undefined>,
  intervalMs = 3_000
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
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The digest the harness registry holds for `repo:tag` (what a pull by digest resolves). */
function registryDigest(registry: string, repo: string, tag: string): Promise<string> {
  const [host, port] = registry.split(":");
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host,
        port: Number(port),
        method: "HEAD",
        path: `/v2/${repo}/manifests/${tag}`,
        headers: {
          accept: [
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.index.v1+json"
          ].join(", ")
        }
      },
      (res) => {
        res.resume();
        const d = res.headers["docker-content-digest"];
        if (res.statusCode === 200 && typeof d === "string") resolve(d);
        else reject(new Error(`HEAD ${repo}:${tag}: ${res.statusCode}`));
      }
    );
    r.on("error", reject);
    r.end();
  });
}

interface RolloutStatus {
  phase?: string;
  currentStepIndex?: number;
  canary?: { weights?: { canary?: { weight?: number } } };
  stableRS?: string;
  currentPodHash?: string;
}

describe("M29.3 canary out of the box (kind, a real Argo CD, Gitea and Argo Rollouts)", () => {
  let harness: Harness;
  let server: ListeningTestServer;
  let org: TestOrg;
  let tenant: ScpClient;
  let fixtures: KubeTransport;
  let stackdKube: KubeClient;
  let workdir: string;
  let controller: StackControllerHandle | undefined;
  let admin: pg.Pool;
  let argocdSystemId: string;
  let componentId: string;
  let rolloutName: string;
  const digests: { v1: string; v2: string } = { v1: "", v2: "" };

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);
  const view = async (b: StackBackend): Promise<StackBackendView> =>
    (await tenant.stack.get()).backends.find((x) => x.backend === b)!;
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
  const rollout = async (): Promise<{ status: RolloutStatus; image?: string } | undefined> => {
    const res = await fixtures.request({
      method: "GET",
      path: `/apis/argoproj.io/v1alpha1/namespaces/scp-apps/rollouts/${rolloutName}`
    });
    if (res.status !== 200) return undefined;
    const o = JSON.parse(res.body) as {
      status?: RolloutStatus;
      spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
    };
    return { status: o.status ?? {}, image: o.spec?.template?.spec?.containers?.[0]?.image };
  };
  const waveTargets = (changeId: string) =>
    inOrg((tx) =>
      tx
        .select({ t: changeWaveTargets })
        .from(changeWaveTargets)
        .innerJoin(changeWaves, eq(changeWaves.id, changeWaveTargets.waveId))
        .innerJoin(changePlans, eq(changePlans.id, changeWaves.planId))
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            eq(changeWaveTargets.targetObjectId, componentId),
            eq(changePlans.changeObjectId, changeId)
          )
        )
    ).then((rows) => rows.map((r) => r.t));
  const release = (digest: string, name: string) =>
    tenant.changes.propose({
      name,
      targets: [componentId],
      sourceRef: { artifact_digest: digest }
    });

  beforeAll(async () => {
    if (process.env.SCP_KIND_IN_CLUSTER_NET !== "1") {
      throw new Error(
        "the canary suite dials in-cluster Service names — run it through `scripts/kind-runner-harness.sh in-cluster-net …` (CI job 4e does). It has no skip path on purpose."
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
    workdir = await mkdtemp(path.join(tmpdir(), "stackd-canary-"));
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
    const reg = harness.stackRegistry;
    digests.v1 = await registryDigest(reg, "scp-canary/app", "v1");
    digests.v2 = await registryDigest(reg, "scp-canary/app", "v2");
    expect(digests.v1).not.toBe(digests.v2);

    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl(),
      withEventRelay: true,
      withReconcileLoop: true
    });
    org = await createTestOrg(server, "m29-3-kind");
    server.deps.config.bootstrapOrgName = org.orgName;
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    await admin.query(
      "TRUNCATE stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations"
    );
    await admin.query(
      `UPDATE stack_settings SET served_orgs_initialized = false, authoring_revision = NULL,
              authoring_clusters = '[]'::jsonb, authoring_facts_sha256 = NULL WHERE id = 'instance'`
    );
    const tokenId = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_CREDENTIAL_TOKEN_ID: tokenId,
      SCP_STACKD_CREDENTIAL_SHA256: createHash("sha256").update(secret).digest("hex")
    });
    const overrides = path.join(workdir, "images.json");
    await writeFile(
      overrides,
      JSON.stringify({
        "argocd.image": `${reg}/argoproj/argocd:v3.4.5`,
        "argocd.dexImage": `${reg}/dexidp/dex:v2.45.0`,
        "argocd.valkeyImage": `${reg}/valkey/valkey:8-alpine`,
        "argoRollouts.image": `${reg}/argoproj/argo-rollouts:v1.10.0`,
        "gitea.image": `${reg}/gitea/gitea:1.26.1-rootless`
      })
    );
    const deps = await buildControllerDeps(
      {
        apiUrl: server.baseUrl,
        operatorCredential: `scp_op_${tokenId}.${secret}`,
        scpNamespace: harness.stackReleaseNamespace,
        stackdNamespace: harness.stackdNamespace,
        release: "kind-canary",
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
        log: (line) => console.log(`[stackd canary] ${line}`)
      }
    );
    controller = startStackController(deps, { intervalMs: 3_000 });
    // THE ONLY INPUT: three switches, through the API.
    for (const b of BACKENDS) await tenant.stack.putBackend(b, { enabled: true }, OPERATOR_TOKEN);
  });

  afterAll(async () => {
    if (tenant) {
      for (const b of BACKENDS) {
        await tenant.stack.putBackend(b, { enabled: false }, OPERATOR_TOKEN).catch(() => undefined);
      }
      await waitFor("every backend removed", 600_000, async () => {
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

  it("enabling Rollouts, Argo CD and Gitea through the API alone configures authoring end to end", async () => {
    for (const b of BACKENDS) {
      await waitFor(`${b} ready`, READY_MS, async () => {
        const v = await view(b);
        if (v.status?.phase === "failed") throw new Error(`${b} failed: ${v.status.lastError}`);
        return v.status?.phase === "ready" ? v : undefined;
      });
    }
    const authoring = await waitFor("canary authoring configured", READY_MS, async () => {
      const s = await tenant.stack.get();
      const a = s.authoring;
      if (!a.configured) {
        const needs = s.backends.find((b) => b.backend === "argo-rollouts")?.status?.needs ?? [];
        if (needs.length) console.log(`[canary] argo-rollouts needs: ${JSON.stringify(needs)}`);
      }
      return a.configured ? a : undefined;
    });
    expect(authoring).toMatchObject({
      project: "scp-authored",
      namespace: "scp-apps",
      clusters: []
    });
    expect(authoring.carrierRevision).toMatch(/^[0-9a-f]{40}$/);
    // The authoring AppProject the controller applied — ADR-0055 D10's shape.
    const project = await stackdKube.get({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "AppProject",
      name: "scp-authored",
      namespace: "scp-argocd"
    });
    expect(project?.["spec"]).toMatchObject({
      sourceRepos: [
        "http://scp-gitea-http.scp-gitea.svc:3000/scp-stack/scp-authored-manifests.git"
      ],
      clusterResourceWhitelist: [],
      namespaceResourceWhitelist: [
        { group: "argoproj.io", kind: "Rollout" },
        { group: "", kind: "Service" }
      ]
    });
    argocdSystemId = (
      await admin.query<{ object_id: string }>(
        "SELECT object_id FROM stack_backend_registrations WHERE org_id = $1 AND backend = 'argocd'",
        [org.orgId]
      )
    ).rows[0]!.object_id;
  });

  it("a component's canary advances through its steps on the REAL Rollouts controller, released through SCP", async () => {
    const reg = harness.stackRegistry;
    const component = await createTestComponent(tenant, {
      name: `canary-${randomUUID().slice(0, 6)}`,
      properties: { deployment: { image: `${reg}/scp-canary/app:v1`, replicas: 2 } }
    });
    componentId = component.id;
    rolloutName = nameWithIdentity(component.name, component.id, 55);
    await tenant.executors.putBinding(component.id, { executionSystemId: argocdSystemId });
    await inOrg((tx) =>
      upsertComponentRollout(tx, org.orgId, {
        componentObjectId: component.id,
        targetClass: "cluster",
        rollout: {
          strategy: "canary",
          steps: [{ weightPercent: 50, pauseSeconds: 20 }, { weightPercent: 100 }]
        }
      })
    );

    // Release 1: the Rollout's first revision (Argo runs no steps for the first one).
    const first = await release(digests.v1, "canary v1");
    await waitFor("release 1 accepted", 600_000, async () => {
      const c = await tenant.changes.get(first.id);
      if (["failed", "rejected", "cancelled"].includes(c.state)) {
        throw new Error(`release 1 ${c.state}: ${JSON.stringify(await waveTargets(first.id))}`);
      }
      return ["validating", "accepted"].includes(c.state) ? c : undefined;
    });
    const r1 = await rollout();
    expect(r1?.image).toBe(`${reg}/scp-canary/app@${digests.v1}`);
    expect(r1?.status.phase).toBe("Healthy");

    // Release 2: the canary. Watch the REAL controller walk the steps, and SCP's observation.
    const second = await release(digests.v2, "canary v2");
    const seen: string[] = [];
    const observedSteps = new Set<number>();
    let pausedAtFifty = false;
    await waitFor(
      "release 2 Healthy at the last step",
      600_000,
      async () => {
        const r = await rollout();
        if (r) {
          const w = r.status.canary?.weights?.canary?.weight;
          seen.push(`${r.status.phase}:${r.status.currentStepIndex}:${w ?? "-"}`);
          // No traffic router, so no weight in status: step 1's timed pause (after setWeight 50) is
          // the evidence the controller walked the steps rather than replacing every pod at once.
          if (r.status.currentStepIndex === 1 && r.status.phase === "Paused") pausedAtFifty = true;
        }
        for (const t of await waveTargets(second.id)) {
          const s = (t.observedState as { rollout?: { step?: number } } | null)?.rollout?.step;
          if (typeof s === "number") observedSteps.add(s);
        }
        const c = await tenant.changes.get(second.id);
        return r?.image === `${reg}/scp-canary/app@${digests.v2}` &&
          r.status.phase === "Healthy" &&
          r.status.currentStepIndex === 3 &&
          ["validating", "accepted"].includes(c.state)
          ? r
          : undefined;
      },
      1_000
    );
    console.log(
      `[canary] rollout states seen: ${[...new Set(seen)].join(" -> ")}; SCP observed steps ${[...observedSteps].join(",")}`
    );
    expect(
      pausedAtFifty,
      `the canary held 50% during its timed pause (${[...new Set(seen)].join(", ")})`
    ).toBe(true);
    // SCP followed the steps through Argo CD's resource tree, and only then finished the release.
    expect(
      observedSteps.size,
      `SCP observed steps ${[...observedSteps].join(",")}`
    ).toBeGreaterThan(0);
  });

  it("a cluster registered with Argo CD gets a Rollouts-to-target Application, and is not handed over until it is healthy", async () => {
    // An Argo CD administrator registers a cluster (this is Argo CD's own registry; SCP's account
    // cannot). It is unreachable, so its Rollouts install never becomes healthy.
    await fixture("POST", "/api/v1/namespaces/scp-argocd/secrets", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: "cluster-edge-unreachable",
        namespace: "scp-argocd",
        labels: { "argocd.argoproj.io/secret-type": "cluster" }
      },
      stringData: {
        name: "edge-unreachable",
        server: "https://10.255.255.1:6443",
        config: JSON.stringify({ bearerToken: "x", tlsClientConfig: { insecure: true } })
      }
    });
    const app = await waitFor("the Rollouts-to-target Application", 300_000, async () => {
      const res = await fixture(
        "GET",
        "/apis/argoproj.io/v1alpha1/namespaces/scp-argocd/applications?labelSelector=stack.commanderscp.io%2Fauthoring%3Drollouts-target"
      );
      const items = (
        JSON.parse(res.body) as { items: { metadata: { name: string }; spec: unknown }[] }
      ).items;
      return items.find((i) => JSON.stringify(i.spec).includes("10.255.255.1")) ?? undefined;
    });
    expect(app.spec).toMatchObject({
      project: "scp-stack",
      source: {
        path: "argo-rollouts",
        targetRevision: (await tenant.stack.get()).authoring.carrierRevision
      },
      destination: { server: "https://10.255.255.1:6443", namespace: "scp-argo-rollouts" }
    });
    const stackProject = await stackdKube.get({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "AppProject",
      name: "scp-stack",
      namespace: "scp-argocd"
    });
    expect(JSON.stringify(stackProject?.["spec"])).toContain("10.255.255.1");
    // Never handed over: a place naming it is refused, never deployed where no Rollouts runs.
    expect((await tenant.stack.get()).authoring.clusters).toEqual([]);
  });

  it("disabling Argo Rollouts withdraws authoring: the next canary is REFUSED with a Decision, and the Rollout is not touched", async () => {
    await tenant.stack.putBackend("argo-rollouts", { enabled: false }, OPERATOR_TOKEN);
    expect((await tenant.stack.get()).authoring.configured).toBe(false);
    const before = await rollout();
    const third = await release(digests.v1, "canary back to v1, authoring off");
    const refused = await waitFor("release 3 refused", 120_000, async () => {
      const rows = await waveTargets(third.id);
      return rows.find((r) => r.status === "deployment_authoring_refused");
    });
    expect(refused.executorRef, "trigger() was never called").toBeNull();
    const ds = await inOrg((tx) =>
      tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.orgId, org.orgId), eq(decisions.subjectId, third.id)))
    );
    expect(
      ds.find((d) => d.verdict === "block")?.inputContext,
      "a block Decision naming the cause"
    ).toMatchObject({ cause: "no_authoring" });
    const after = await rollout();
    expect(after?.image, "no plain rolling update happened").toBe(before?.image);
  });
});
