import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { startArgoCdStandIn, type ArgoCdStandIn } from "@scp/plugin-testkit";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, decisions } from "../db/schema.js";

/**
 * M28.4 (ADR-0055) — SCP CREATES an Argo CD Application and AUTHORS its Rollout for a component it
 * did not import, and then ONLY READS the Rollout.
 *
 * Driven through the production path end to end, nothing called directly: a change is PROPOSED
 * through the API against a release topology; the real reconcile loop compiles it into stage
 * waves, resolves each placement's binding to a real `execution-system`, derives the authored
 * Application in `deployLaneTriggerParameters`, and hands it to the REAL `@scp/plugin-argocd`
 * running in the subprocess plugin host, which reaches a recording Argo CD stand-in over loopback
 * (ADR-0003's two-layer internal-egress grant). The stand-in plays Argo CD's controller on sync, so
 * the Rollout exists only because the Application SCP wrote told Argo CD to apply it.
 *
 * Deleting the `deployLaneTriggerParameters` call in `reconcile.ts` turns the first test red (no
 * Application is ever created: the plain sync 404s). Adding a promote call anywhere in the plugin
 * turns the ADR-0008 §3 assertion red (`violations` is non-empty).
 */

const CARRIER = {
  repoURL: "https://git.example/platform/gitops.git",
  path: "charts/scp-authored-manifests",
  targetRevision: "carrier-v1"
};

describe("M28.4 — SCP creates an Argo CD Application + authors its Rollout (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let standIn: ArgoCdStandIn;
  const prevEgressHosts = process.env.SCP_INTERNAL_EGRESS_HOSTS;

  beforeAll(async () => {
    // Layer 1 of the internal-egress grant, set BEFORE boot; layer 2 is `allowInternalEgress` below.
    process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
    standIn = await startArgoCdStandIn();
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "m28-4-authored");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await admin.secrets.put("m28-4-argocd-token", { value: "stand-in-token" });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await standIn?.close();
    if (prevEgressHosts === undefined) delete process.env.SCP_INTERNAL_EGRESS_HOSTS;
    else process.env.SCP_INTERNAL_EGRESS_HOSTS = prevEgressHosts;
  });

  async function argocdSystem(authoring: unknown) {
    return admin.object("execution-system").create({
      name: `argocd-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "argocd",
        serverUrl: standIn.url,
        tokenSecretKey: "m28-4-argocd-token",
        allowInternalEgress: true,
        ...(authoring !== undefined ? { authoring } : {})
      }
    });
  }

  async function placedComponent(
    label: string,
    places: GraphObject[],
    system: GraphObject,
    deployment: unknown
  ) {
    const component = await createTestComponent(admin, {
      name: `${label}-${randomUUID().slice(0, 6)}`,
      properties: { deployment }
    });
    const placements: Record<string, string> = {};
    for (const place of places) {
      const placement = await admin.placements.create({
        component: component.id,
        deploymentTarget: place.id
      });
      placements[place.id] = placement.id;
      await admin.executors.putBinding(placement.id, { executionSystemId: system.id });
    }
    return { component, placements };
  }

  async function waveTargetRow(targetObjectId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            eq(changeWaveTargets.targetObjectId, targetObjectId)
          )
        )
        .limit(1)
    );
    return rows[0];
  }

  it("creates the Application and a Rollout whose steps ARE the wave plan's, and never writes the Rollout after", async () => {
    const suffix = randomUUID().slice(0, 6);
    const gamma = await admin.deploymentTargets.create({
      name: `gamma-${suffix}`,
      properties: { environment: "gamma", namespace: "shop-gamma" }
    });
    const prod = await admin.deploymentTargets.create({
      name: `prod-${suffix}`,
      properties: { environment: "production", namespace: "shop" }
    });
    const system = await argocdSystem(CARRIER);
    const { component, placements } = await placedComponent("checkout", [gamma, prod], system, {
      image: "ghcr.io/acme/checkout:1.4.0",
      containerPort: 8080,
      replicas: 4
    });
    const topology = await admin.object("release-topology").create({
      name: `gamma-then-prod-${suffix}`,
      properties: {
        waves: [
          {
            name: "gamma",
            mode: "parallel",
            targets: [gamma.id],
            rollout: {
              strategy: "canary",
              steps: [{ weightPercent: 50, pauseSeconds: 30 }, { weightPercent: 100 }]
            }
          },
          {
            name: "prod",
            mode: "parallel",
            targets: [prod.id],
            rollout: {
              strategy: "canary",
              steps: [
                { weightPercent: 10, pauseSeconds: 60 },
                { weightPercent: 50, pauseSeconds: 60 },
                { weightPercent: 100 }
              ]
            }
          }
        ]
      }
    });

    // Nothing exists in Argo CD for this component: it was never imported.
    expect(component.properties.argocdApplication).toBeUndefined();
    const before = new Set(standIn.applications.keys());

    const digest = `sha256:${"c".repeat(64)}`;
    const change = await admin.changes.propose({
      name: `release checkout ${suffix}`,
      targets: [component.id],
      topology: topology.id,
      sourceRef: { artifact_digest: digest }
    });
    await waitUntil(
      async () => {
        const state = (await admin.changes.get(change.id)).state;
        return state === "validating" || state === "accepted" ? state : undefined;
      },
      { describe: `change ${change.id} runs both waves`, timeoutMs: 60_000, intervalMs: 250 }
    ).catch(async (err: unknown) => {
      const c = await admin.changes.get(change.id);
      const ds = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, change.id))
      );
      console.error(
        "DIAG state",
        c.state,
        JSON.stringify(ds.map((d) => [d.kind, d.verdict, d.reasonTree]))
      );
      console.error(
        "DIAG requests",
        JSON.stringify(standIn.requests.map((r) => `${r.method} ${r.path}`))
      );
      throw err;
    });

    const created = [...standIn.applications.keys()].filter((n) => !before.has(n)).sort();
    expect(created).toHaveLength(2);
    const byPlace = (place: GraphObject) => {
      const app = [...standIn.applications.values()].find(
        (a) => a.metadata.labels?.["commanderscp.io/target"] === placements[place.id]
      );
      expect(app, `an Application authored for ${place.name}`).toBeDefined();
      return app!;
    };

    for (const [place, namespace, steps] of [
      [
        gamma,
        "shop-gamma",
        [{ setWeight: 50 }, { pause: { duration: "30s" } }, { setWeight: 100 }]
      ],
      [
        prod,
        "shop",
        [
          { setWeight: 10 },
          { pause: { duration: "60s" } },
          { setWeight: 50 },
          { pause: { duration: "60s" } },
          { setWeight: 100 }
        ]
      ]
    ] as const) {
      const app = byPlace(place);
      expect(app.metadata.labels?.["commanderscp.io/authored"]).toBe("true");
      expect(app.metadata.labels?.["commanderscp.io/component"]).toBe(component.id);
      expect(app.spec?.source).toMatchObject(CARRIER);
      expect(app.spec?.destination).toEqual({
        server: "https://kubernetes.default.svc",
        namespace
      });

      // The Rollout exists IN THE CLUSTER — applied by the stand-in's controller from the
      // Application's values, with the wave plan's steps and the change's digest.
      const rollout = [...standIn.cluster.values()].find(
        (m) =>
          m.kind === "Rollout" && (m.metadata as { namespace?: string }).namespace === namespace
      );
      expect(rollout, `a Rollout applied in ${namespace}`).toBeDefined();
      const spec = rollout!.spec as {
        replicas: number;
        strategy: { canary: { steps: unknown[] } };
        template: { spec: { containers: { image: string }[] } };
      };
      expect(spec.strategy.canary.steps).toEqual(steps);
      expect(spec.replicas).toBe(4);
      expect(spec.template.spec.containers[0]!.image).toBe(`ghcr.io/acme/checkout@${digest}`);

      // SCP OBSERVED the Rollout it authored: the step total it mirrored is the step list it wrote.
      const row = await waveTargetRow(placements[place.id]!);
      expect(row?.status).toBe("succeeded");
      const observedRollout = (row?.observedState as { rollout?: { stepCount?: number } } | null)
        ?.rollout;
      expect(observedRollout?.stepCount).toBe(steps.length);
    }

    // ADR-0008 §3 — the standing half. Every write that reached Argo CD is one of: create the
    // Application, sync it. Nothing wrote a Rollout; nothing called a Rollout action.
    expect(standIn.violations).toEqual([]);
    const writes = standIn.requests
      .filter((r) => r.method !== "GET")
      .map(
        (r) => `${r.method} ${r.path.replace(/\/applications\/[^/]+\//, "/applications/:name/")}`
      );
    expect(writes.sort()).toEqual(
      [
        "POST /api/v1/applications",
        "POST /api/v1/applications",
        "POST /api/v1/applications/:name/sync",
        "POST /api/v1/applications/:name/sync"
      ].sort()
    );
  }, 120_000);

  it("REFUSES, with a Decision and before any call to Argo CD, when the bound Argo CD names no carrier", async () => {
    const suffix = randomUUID().slice(0, 6);
    const place = await admin.deploymentTargets.create({
      name: `solo-${suffix}`,
      properties: { environment: "gamma" }
    });
    const system = await argocdSystem(undefined);
    const { component, placements } = await placedComponent("nocarrier", [place], system, {
      image: "ghcr.io/acme/nocarrier:1.0.0"
    });
    const topology = await admin.object("release-topology").create({
      name: `solo-${suffix}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [place.id] }] }
    });
    const requestsBefore = standIn.requests.length;
    const change = await admin.changes.propose({
      name: `release nocarrier ${suffix}`,
      targets: [component.id],
      topology: topology.id
    });

    const row = await waitUntil(
      async () => {
        const r = await waveTargetRow(placements[place.id]!);
        return r?.status === "deployment_authoring_refused" ? r : undefined;
      },
      { describe: "the wave target is refused", timeoutMs: 45_000, intervalMs: 250 }
    );
    expect(row.status).toBe("deployment_authoring_refused");
    const blocks = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.orgId, org.orgId), eq(decisions.subjectId, change.id)))
    );
    const refusal = blocks.find(
      (d) => (d.inputContext as { gate?: string } | null)?.gate === "deployment_authoring"
    );
    expect(refusal?.verdict).toBe("block");
    expect(JSON.stringify(refusal?.reasonTree)).toContain("declares no `authoring` source");
    // Nothing about this component reached Argo CD — not a create, not a sync of an absent app.
    const touched = standIn.requests
      .slice(requestsBefore)
      .filter((r) => r.path.includes(component.name.toLowerCase()) || r.method !== "GET");
    expect(touched).toEqual([]);
  }, 90_000);
});
