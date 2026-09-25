import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { PutStackAuthoringRequest, PutStackWiringRequest } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  testOperatorDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { provisionInstallTimePrincipals } from "../db/provision-install.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, decisions } from "../db/schema.js";
import {
  resolveExecutorPluginInstance,
  upsertExecutorBinding
} from "../coordination/executor-bindings-repo.js";
import { upsertComponentRollout } from "../coordination-as-code/rollout-convergence-repo.js";
import {
  AUTHORED_APPLICATION_PARAMETER,
  deployLaneTriggerParameters
} from "../coordination/deploy-lane-trigger-parameters.js";

/**
 * M29.3 — CANARY AUTHORING, server side (ADR-0062). A real scpd on Testcontainers Postgres writing
 * through a real `scp_operator`; the stack controller is played by its install-time credential.
 * What this file proves, each against the M28 class:
 *
 *   - only the controller's credential hands authoring over, and only while Argo CD, Gitea and Argo
 *     Rollouts are enabled and Argo CD and Gitea are wired;
 *   - the registered Argo CD's `authoring` — carrier repository, project, namespace, clusters — is
 *     DERIVED from that hand-off and release constants: the plugin config and the deploy lane both
 *     get it, and a tenant `authoring` written onto the registration's properties (by raw SQL, past
 *     every door) is never read;
 *   - disabling any of the three backends, or unwiring Gitea, withdraws it in the same transaction,
 *     and a canary asked for from then on is REFUSED (`no_authoring`);
 *   - REFUSAL, NOT SILENT DEGRADATION: a component that asks for a canary where nothing can author
 *     it — bound to another executor, or to Argo CD with no deployment declared — is refused with a
 *     Decision before any trigger, where before M29.3 it was deployed as whatever the executor does.
 */

const OPERATOR_TOKEN = "m29-3-authoring-operator-token";
const STACKD_TOKEN = "scp_op_stackdAuthorTok01." + "a".repeat(43);
const ARGOCD_URL = "http://argocd-server.scp-argocd.svc";
const GITEA_URL = "http://scp-gitea-http.scp-gitea.svc:3000";
const CARRIER = `${GITEA_URL}/scp-stack/scp-authored-manifests.git`;
const REV = "0123456789abcdef0123456789abcdef01234567";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function apiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected an ScpApiError, but the call succeeded");
}

const wiring = (backend: "argocd" | "gitea"): PutStackWiringRequest => ({
  serverUrl: backend === "argocd" ? ARGOCD_URL : GITEA_URL,
  namespace: null,
  caPem: null,
  account: backend === "argocd" ? "scp-coordinator" : "gitea_admin",
  token: `${backend}-token`,
  factsSha256: sha(`${backend}-facts`),
  rotationGeneration: 0
});

const handoff = (clusters: string[] = []): PutStackAuthoringRequest => ({
  carrierRevision: REV,
  clusters,
  factsSha256: sha(JSON.stringify(clusters))
});

describe("M29.3 canary authoring through the Standard Stack (Testcontainers, real scp_operator)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let tenant: ScpClient;
  let controller: ScpClient;
  let admin: pg.Pool;
  let argocdSystemId: string;

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);
  const enable = (b: "argocd" | "gitea" | "argo-rollouts", enabled = true) =>
    tenant.stack.putBackend(b, { enabled }, OPERATOR_TOKEN);
  const configure = async (clusters: string[] = []) => {
    await controller.stack.putWiring("argocd", wiring("argocd"), STACKD_TOKEN);
    await controller.stack.putWiring("gitea", wiring("gitea"), STACKD_TOKEN);
    await controller.stack.putAuthoring(handoff(clusters), STACKD_TOKEN);
  };
  const auditActions = async () =>
    (
      await admin.query<{ action: string }>("SELECT action FROM instance_audit_events ORDER BY seq")
    ).rows.map((r) => r.action);

  /** A component bound to the registered Argo CD, declaring a deployment (and, optionally, a place). */
  async function authoredComponent(place?: { cluster?: string; namespace?: string }) {
    const component = await createTestComponent(tenant, {
      name: `web-${randomUUID().slice(0, 6)}`,
      properties: { deployment: { image: "registry.example/web:1.0.0", containerPort: 8080 } }
    });
    let target = component.id;
    if (place) {
      const dt = await tenant.deploymentTargets.create({
        name: `edge-${randomUUID().slice(0, 6)}`,
        properties: { environment: "edge", ...place }
      });
      target = (
        await tenant.placements.create({ component: component.id, deploymentTarget: dt.id })
      ).id;
    }
    await tenant.executors.putBinding(target, { executionSystemId: argocdSystemId });
    return { component, target };
  }

  const derive = (target: string) =>
    inOrg(async (tx) => {
      const binding = (await tenant.executors.listBindings(target))[0]!;
      return deployLaneTriggerParameters(tx, {
        orgId: org.orgId,
        targetObjectId: target,
        waveId: randomUUID(),
        changeObjectId: randomUUID(),
        sourceRef: {},
        pluginModule: "argocd",
        executorType: "configuration",
        binding: {
          externalRef: binding.externalRef,
          executionSystemId: binding.executionSystemId,
          config: binding.config
        }
      });
    });

  beforeAll(async () => {
    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      operatorDatabaseUrl: await testOperatorDatabaseUrl(),
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    admin = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    await provisionInstallTimePrincipals(admin, server.deps.config, {
      SCP_STACKD_OPERATOR_CREDENTIAL: STACKD_TOKEN
    });
    org = await createTestOrg(server, "m29-3-authoring");
    server.deps.config.bootstrapOrgName = org.orgName;
    tenant = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    controller = new ScpClient({ baseUrl: server.baseUrl });
    await admin.query(
      "TRUNCATE stack_backend_wirings, stack_backend_tokens, stack_served_orgs, stack_backend_registrations"
    );
    await admin.query(
      `UPDATE stack_settings SET served_orgs_initialized = false, authoring_revision = NULL,
              authoring_clusters = '[]'::jsonb, authoring_facts_sha256 = NULL WHERE id = 'instance'`
    );
    for (const b of ["argocd", "gitea"] as const) await enable(b);
    await controller.stack.putWiring("argocd", wiring("argocd"), STACKD_TOKEN);
    await controller.stack.putWiring("gitea", wiring("gitea"), STACKD_TOKEN);
    argocdSystemId = (
      await admin.query<{ object_id: string }>(
        "SELECT object_id FROM stack_backend_registrations WHERE org_id = $1 AND backend = 'argocd'",
        [org.orgId]
      )
    ).rows[0]!.object_id;
  });

  afterAll(async () => {
    await admin?.end();
    await server?.close();
  });

  it("only the controller's credential hands authoring over, and only while all three backends are enabled", async () => {
    expect(
      (await apiError(() => tenant.stack.putAuthoring(handoff(), OPERATOR_TOKEN))).status
    ).toBe(403);
    // Argo Rollouts is not enabled yet: refused, nothing stored.
    const early = await apiError(() => controller.stack.putAuthoring(handoff(), STACKD_TOKEN));
    expect(early.status).toBe(409);
    expect((await tenant.stack.get()).authoring.configured).toBe(false);
    await enable("argo-rollouts");
    await controller.stack.putAuthoring(handoff(), STACKD_TOKEN);
    const view = (await tenant.stack.get()).authoring;
    expect(view).toMatchObject({
      configured: true,
      project: "scp-authored",
      namespace: "scp-apps",
      carrierRevision: REV,
      clusters: []
    });
    const spec = await controller.stack.spec(STACKD_TOKEN);
    expect(spec.authoring?.factsSha256).toBe(handoff().factsSha256);
    expect(await auditActions()).toContain("stack.authoring.configure");
  });

  it("the registered Argo CD's authoring is DERIVED — plugin config and deploy lane — and a tenant `authoring` on its properties is never read", async () => {
    await configure();
    const { target } = await authoredComponent();
    // M28 class: a tenant-chosen bound written straight onto the registration (past every door).
    await admin.query(`UPDATE objects SET properties = properties || $1::jsonb WHERE id = $2`, [
      JSON.stringify({
        authoring: {
          repoURL: "https://evil.example/repo.git",
          path: ".",
          targetRevision: "HEAD",
          project: "evil",
          namespaces: ["kube-system-ish", "payments"]
        }
      }),
      argocdSystemId
    ]);
    const resolved = await inOrg((tx) =>
      resolveExecutorPluginInstance(tx, {
        orgId: org.orgId,
        targetObjectId: target,
        masterKey: server.deps.config.secretsMasterKey
      })
    );
    const expected = {
      repoURL: CARRIER,
      path: "scp-authored-manifests",
      targetRevision: REV,
      project: "scp-authored",
      namespaces: ["scp-apps"]
    };
    expect((resolved!.instanceConfig.config as { authoring?: unknown }).authoring).toEqual(
      expected
    );
    const app = (await derive(target))!.parameters[AUTHORED_APPLICATION_PARAMETER] as {
      spec: {
        project: string;
        source: { repoURL: string; targetRevision: string };
        destination: unknown;
      };
    };
    expect(app.spec.project).toBe("scp-authored");
    expect(app.spec.source).toMatchObject({ repoURL: CARRIER, targetRevision: REV });
    // With the stack's ONE namespace allowed, an undeclared namespace is that one.
    expect(app.spec.destination).toEqual({
      server: "https://kubernetes.default.svc",
      namespace: "scp-apps"
    });
  });

  it("a place naming a cluster is refused until the controller hands it over as Rollouts-ready", async () => {
    await configure();
    const { target } = await authoredComponent({ cluster: "edge-1" });
    await expect(derive(target)).rejects.toMatchObject({
      inputContext: expect.objectContaining({ cause: "cluster_not_allowed" })
    });
    await configure(["edge-1"]);
    const app = (await derive(target))!.parameters[AUTHORED_APPLICATION_PARAMETER] as {
      spec: { destination: unknown };
    };
    expect(app.spec.destination).toEqual({ name: "edge-1", namespace: "scp-apps" });
  });

  it("disabling Argo Rollouts withdraws authoring in the same transaction; the canary is then refused (no_authoring)", async () => {
    await configure();
    const { target } = await authoredComponent();
    expect(await derive(target)).toBeDefined();
    await enable("argo-rollouts", false);
    expect((await tenant.stack.get()).authoring.configured).toBe(false);
    expect((await auditActions()).at(-2)).toBe("stack.authoring.withdraw");
    await expect(derive(target)).rejects.toMatchObject({
      inputContext: expect.objectContaining({ cause: "no_authoring" })
    });
    await enable("argo-rollouts");
  });

  it("unwiring Gitea (the carrier's host) withdraws authoring; the controller's DELETE does too", async () => {
    await configure();
    await controller.stack.deleteWiring("gitea", STACKD_TOKEN);
    expect((await tenant.stack.get()).authoring.configured).toBe(false);
    // Withdrawn at the row, not only hidden by the derivation (which also needs Gitea's wiring):
    // the controller sees no hand-off held, and hands it over again once Gitea is back.
    const row = await admin.query<{ authoring_revision: string | null }>(
      "SELECT authoring_revision FROM stack_settings WHERE id = 'instance'"
    );
    expect(row.rows[0]!.authoring_revision).toBeNull();
    await configure();
    await controller.stack.deleteAuthoring(STACKD_TOKEN);
    expect((await tenant.stack.get()).authoring.configured).toBe(false);
    expect((await apiError(() => tenant.stack.deleteAuthoring(OPERATOR_TOKEN))).status).toBe(403);
  });

  describe("REFUSAL, NOT SILENT DEGRADATION — through the real reconcile loop", () => {
    async function refused(changeId: string, target: string) {
      const row = await waitUntil(
        async () => {
          const rows = await inOrg((tx) =>
            tx
              .select()
              .from(changeWaveTargets)
              .where(
                and(
                  eq(changeWaveTargets.orgId, org.orgId),
                  eq(changeWaveTargets.targetObjectId, target)
                )
              )
          );
          return rows.find((r) => r.status !== "pending" && r.status !== "running");
        },
        { describe: `wave target ${target} settles`, timeoutMs: 45_000, intervalMs: 250 }
      );
      expect(row.executorRef, "trigger() was never called").toBeNull();
      const ds = await inOrg((tx) =>
        tx
          .select()
          .from(decisions)
          .where(and(eq(decisions.orgId, org.orgId), eq(decisions.subjectId, changeId)))
      );
      return { row, block: ds.find((d) => d.verdict === "block") };
    }

    it("a canary on a component bound to an executor that cannot author it is REFUSED with a Decision, never deployed", async () => {
      const component = await createTestComponent(tenant, {
        name: `plain-${randomUUID().slice(0, 6)}`
      });
      await inOrg((tx) =>
        upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: component.id,
          pluginModule: "fake-executor",
          pluginInstanceId: `fake-${randomUUID().slice(0, 8)}`,
          externalRef: component.id,
          config: {},
          actorObjectId: org.orgId,
          requestId: "m29-3-fake-binding"
        })
      );
      await inOrg((tx) =>
        upsertComponentRollout(tx, org.orgId, {
          componentObjectId: component.id,
          targetClass: "cluster",
          rollout: {
            strategy: "canary",
            steps: [{ weightPercent: 25, pauseSeconds: 5 }, { weightPercent: 100 }]
          }
        })
      );
      const change = await tenant.changes.propose({
        name: "canary nowhere",
        targets: [component.id]
      });
      const { block } = await refused(change.id, component.id);
      expect(block?.inputContext).toMatchObject({
        cause: "rollout_not_authored",
        reason: "executor_cannot_author"
      });
    });

    it("a canary on a component bound to Argo CD with no deployment declared is REFUSED, not synced as-is", async () => {
      await configure();
      const component = await createTestComponent(tenant, {
        name: `imported-${randomUUID().slice(0, 6)}`
      });
      await tenant.executors.putBinding(component.id, { executionSystemId: argocdSystemId });
      await inOrg((tx) =>
        upsertComponentRollout(tx, org.orgId, {
          componentObjectId: component.id,
          targetClass: "cluster",
          rollout: { strategy: "canary", steps: [{ weightPercent: 50 }] }
        })
      );
      const change = await tenant.changes.propose({
        name: "canary unauthored",
        targets: [component.id]
      });
      const { block } = await refused(change.id, component.id);
      expect(block?.inputContext).toMatchObject({
        cause: "rollout_not_authored",
        reason: "no_deployment_declared"
      });
    });

    it("control: the same executor with NO rollout requested is not refused on that ground", async () => {
      const component = await createTestComponent(tenant, {
        name: `norollout-${randomUUID().slice(0, 6)}`
      });
      await inOrg((tx) =>
        upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: component.id,
          pluginModule: "fake-executor",
          pluginInstanceId: `fake-${randomUUID().slice(0, 8)}`,
          externalRef: component.id,
          config: {},
          actorObjectId: org.orgId,
          requestId: "m29-3-fake-binding-2"
        })
      );
      const change = await tenant.changes.propose({
        name: "plain release",
        targets: [component.id]
      });
      const row = await waitUntil(
        async () => {
          const rows = await inOrg((tx) =>
            tx
              .select()
              .from(changeWaveTargets)
              .where(eq(changeWaveTargets.targetObjectId, component.id))
          );
          return rows.find((r) => r.executorRef !== null || r.status === "succeeded");
        },
        { describe: "the plain release triggers", timeoutMs: 45_000, intervalMs: 250 }
      );
      expect(row.executorRef).not.toBeNull();
      const ds = await inOrg((tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, change.id))
      );
      expect(
        ds.some((d) => (d.inputContext as { cause?: string }).cause === "rollout_not_authored")
      ).toBe(false);
    });
  });
});
