import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import {
  startArgoCdStandIn,
  type ArgoCdStandIn,
  type StandInApplication
} from "@scp/plugin-testkit";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changeWaveTargets, decisions } from "../db/schema.js";
import { upsertComponentRollout } from "../coordination-as-code/rollout-convergence-repo.js";
import {
  AUTHORED_APPLICATION_PARAMETER,
  deployLaneTriggerParameters
} from "./deploy-lane-trigger-parameters.js";

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
 * Application is ever created: the plain sync 404s). Adding a promote call anywhere in the plugin,
 * or a `paused: true` anywhere in what is authored, turns the ADR-0008 §3 assertions red.
 */

/** A received manifest, read field by field in assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const AUTHORING = {
  repoURL: "https://gitea.example/platform/gitops.git",
  path: "charts/scp-authored-manifests",
  targetRevision: "carrier-v1",
  project: "scp-authored",
  namespaces: ["shop", "shop-gamma"]
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

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  async function argocdSystem(authoring: unknown = AUTHORING) {
    // `null` = declare NO authoring (a default parameter cannot be omitted with `undefined`).
    if (authoring === null) authoring = undefined;
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

  async function place(label: string, namespace = "shop") {
    return admin.deploymentTargets.create({
      name: `${label}-${randomUUID().slice(0, 6)}`,
      properties: { environment: label, namespace }
    });
  }

  async function placedComponent(
    name: string,
    places: GraphObject[],
    system: GraphObject,
    properties: Record<string, unknown>
  ) {
    const component = await createTestComponent(admin, { name, properties });
    const placements: Record<string, string> = {};
    for (const p of places) {
      const placement = await admin.placements.create({
        component: component.id,
        deploymentTarget: p.id
      });
      placements[p.id] = placement.id;
      await admin.executors.putBinding(placement.id, { executionSystemId: system.id });
    }
    return { component, placements };
  }

  async function topology(waves: unknown[]) {
    return admin.object("release-topology").create({
      name: `topo-${randomUUID().slice(0, 8)}`,
      properties: { waves }
    });
  }

  async function waveTargetRow(
    targetObjectId: string,
    changeFilter?: (r: { waveId: string }) => boolean
  ) {
    const rows = await inOrg((tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            eq(changeWaveTargets.targetObjectId, targetObjectId)
          )
        )
    );
    const filtered = changeFilter ? rows.filter(changeFilter) : rows;
    return filtered.sort((a, b) => String(a.id).localeCompare(String(b.id))).at(-1);
  }

  async function settle(changeId: string, want: string[] = ["validating", "accepted"]) {
    return waitUntil(
      async () => {
        const state = (await admin.changes.get(changeId)).state;
        return want.includes(state) ? state : undefined;
      },
      {
        describe: `change ${changeId} reaches ${want.join("|")}`,
        timeoutMs: 60_000,
        intervalMs: 250
      }
    );
  }

  /** The server's OWN derivation for a triggered wave target, recomputed — what the plugin must
   *  have sent byte for byte (finding 4). */
  async function serverDerived(changeId: string, targetObjectId: string, digest?: string) {
    const row = await waveTargetRow(targetObjectId);
    const binding = (await admin.executors.listBindings(targetObjectId))[0]!;
    const trig = await inOrg((tx) =>
      deployLaneTriggerParameters(tx, {
        orgId: org.orgId,
        targetObjectId,
        waveId: row!.waveId,
        changeObjectId: changeId,
        sourceRef: digest ? { artifact_digest: digest } : {},
        pluginModule: "argocd",
        binding: {
          externalRef: binding.externalRef,
          executionSystemId: binding.executionSystemId,
          config: binding.config
        }
      })
    );
    return trig!.parameters[AUTHORED_APPLICATION_PARAMETER];
  }

  /** A refusal: terminal status, a `block` Decision naming the cause, its audit event — and no
   *  write to Argo CD while it happened. */
  async function expectRefused(
    changeId: string,
    targetObjectId: string,
    status: string,
    match: Record<string, unknown>,
    writesBefore: number
  ) {
    const row = await waitUntil(
      async () => {
        // ANY row of this target — a place named by two waves has two wave-target rows, and only the
        // first one ever reaches the trigger.
        const rows = await inOrg((tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, org.orgId),
                eq(changeWaveTargets.targetObjectId, targetObjectId)
              )
            )
        );
        return rows.find((r) => r.status === status);
      },
      {
        describe: `wave target ${targetObjectId} refused as ${status}`,
        timeoutMs: 45_000,
        intervalMs: 250
      }
    ).catch(async (err: unknown) => {
      const r = await waveTargetRow(targetObjectId);
      const c = await admin.changes.get(changeId);
      const ds = await inOrg((tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
      );
      throw new Error(
        `${String(err)} — change ${c.state}, target ${r?.status ?? "(no row)"}; decisions ${JSON.stringify(ds.map((d) => [d.verdict, d.reasonTree]))}`
      );
    });
    expect(row.status).toBe(status);
    expect(row.executorRef, "trigger() was never called").toBeNull();
    const ds = await inOrg((tx) =>
      tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.orgId, org.orgId), eq(decisions.subjectId, changeId)))
    );
    const block = ds.find(
      (d) =>
        d.verdict === "block" &&
        Object.entries(match).every(
          ([k, v]) =>
            (d.inputContext as Record<string, unknown>)[k] === v ||
            JSON.stringify((d.inputContext as Record<string, unknown>)[k]) === JSON.stringify(v)
        )
    );
    expect(block, `a block Decision matching ${JSON.stringify(match)}`).toBeDefined();
    const audits = await inOrg((tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.subjectId, changeId)))
    );
    expect(audits.some((a) => a.decisionId === block!.id)).toBe(true);
    expect(
      standIn.requests.slice(writesBefore).filter((r) => r.method !== "GET"),
      "nothing was written to Argo CD for a refused target"
    ).toEqual([]);
    return block!;
  }

  const writeMark = () => standIn.requests.length;

  it("creates the Application and a Rollout whose steps ARE the wave plan's, and never writes the Rollout after", async () => {
    const gamma = await place("gamma", "shop-gamma");
    const prod = await place("production", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `checkout-${randomUUID().slice(0, 6)}`,
      [gamma, prod],
      system,
      {
        deployment: { image: "ghcr.io/acme/checkout:1.4.0", containerPort: 8080, replicas: 4 }
      }
    );
    const topo = await topology([
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
    ]);
    expect(component.properties.argocdApplication).toBeUndefined();
    const before = new Set(standIn.applications.keys());
    const bodiesBefore = standIn.authoredBodies.length;
    const requestsBefore = writeMark();

    const digest = `sha256:${"c".repeat(64)}`;
    const change = await admin.changes.propose({
      name: `release checkout`,
      targets: [component.id],
      topology: topo.id,
      sourceRef: { artifact_digest: digest }
    });
    await settle(change.id);

    expect([...standIn.applications.keys()].filter((n) => !before.has(n))).toHaveLength(2);
    for (const [p, namespace, steps] of [
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
      const targetId = placements[p.id]!;
      const app = [...standIn.applications.values()].find(
        (a) => a.metadata.labels?.["commanderscp.io/target"] === targetId
      )!;
      expect(app, `an Application authored for ${p.name}`).toBeDefined();
      expect(app.metadata.labels?.["commanderscp.io/org"]).toBe(org.orgId);
      expect(app.spec?.project).toBe("scp-authored");
      expect(app.spec?.destination).toEqual({
        server: "https://kubernetes.default.svc",
        namespace
      });
      // EXACT: what reached Argo CD is what the server derives — nothing rewritten on the way.
      const sent = standIn.authoredBodies
        .slice(bodiesBefore)
        .find((b) => b.metadata.labels?.["commanderscp.io/target"] === targetId);
      expect(sent).toEqual(await serverDerived(change.id, targetId, digest));

      const rollout = [...standIn.cluster.values()].find(
        (m) =>
          m.kind === "Rollout" &&
          (m.metadata as { namespace?: string }).namespace === namespace &&
          (m.metadata as { name: string }).name.startsWith(component.name)
      )!;
      const spec = rollout.spec as {
        replicas: number;
        strategy: { canary: { steps: unknown[] } };
        template: { spec: { containers: { image: string }[] } };
      };
      expect(spec.strategy.canary.steps).toEqual(steps);
      expect(spec.template.spec.containers[0]!.image).toBe(`ghcr.io/acme/checkout@${digest}`);
      const row = await waveTargetRow(targetId);
      expect(row?.status).toBe("succeeded");
      expect(
        (row?.observedState as { rollout?: { stepCount?: number } } | null)?.rollout?.stepCount
      ).toBe(steps.length);
    }

    // ADR-0008 §3 — the standing half.
    expect(standIn.violations).toEqual([]);
    const writes = standIn.requests
      .slice(requestsBefore)
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

  it("D-a: the component's OWN rollout declaration wins over the wave plan's, and says so", async () => {
    const p = await place("gamma", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `own-${randomUUID().slice(0, 6)}`,
      [p],
      system,
      {
        deployment: { image: "ghcr.io/acme/own:1.0.0" }
      }
    );
    await inOrg((tx) =>
      upsertComponentRollout(tx, org.orgId, {
        componentObjectId: component.id,
        targetClass: "cluster",
        rollout: {
          strategy: "canary",
          steps: [{ weightPercent: 30, pauseSeconds: 10 }, { weightPercent: 100 }]
        }
      })
    );
    const topo = await topology([
      {
        name: "gamma",
        mode: "parallel",
        targets: [p.id],
        rollout: { strategy: "canary", steps: [{ weightPercent: 5 }] }
      }
    ]);
    const bodiesBefore = standIn.authoredBodies.length;
    const change = await admin.changes.propose({
      name: "own rollout",
      targets: [component.id],
      topology: topo.id
    });
    await settle(change.id);
    const sent = standIn.authoredBodies
      .slice(bodiesBefore)
      .find((b) => b.metadata.labels?.["commanderscp.io/target"] === placements[p.id])!;
    expect(sent.metadata.annotations?.["commanderscp.io/rollout-source"]).toBe("component");
    const manifests = sent.spec?.source?.helm?.valuesObject?.manifests as {
      spec: { strategy: unknown };
    }[];
    expect(manifests[0]!.spec.strategy).toEqual({
      canary: { steps: [{ setWeight: 30 }, { pause: { duration: "10s" } }, { setWeight: 100 }] }
    });
  }, 90_000);

  it("D-b: blue-green authors the Rollout and its two Services, and always auto-promotes", async () => {
    const p = await place("gamma", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `bg-${randomUUID().slice(0, 6)}`,
      [p],
      system,
      {
        deployment: { image: "ghcr.io/acme/bg:1.0.0", containerPort: 8080 }
      }
    );
    // Blue-green is declared in the WAVE PLAN (ADR-0055 D4): the D12 component wire cannot carry
    // it without a /v1 response break.
    const topo = await topology([
      {
        name: "gamma",
        mode: "parallel",
        targets: [p.id],
        rollout: { strategy: "blueGreen", autoPromotionSeconds: 90 }
      }
    ]);
    const bodiesBefore = standIn.authoredBodies.length;
    const change = await admin.changes.propose({
      name: "blue-green",
      targets: [component.id],
      topology: topo.id
    });
    await settle(change.id);
    const sent = standIn.authoredBodies
      .slice(bodiesBefore)
      .find((b) => b.metadata.labels?.["commanderscp.io/target"] === placements[p.id])!;
    const manifests = sent.spec?.source?.helm?.valuesObject?.manifests as Record<string, Loose>[];
    expect(manifests.map((m) => m.kind)).toEqual(["Rollout", "Service", "Service"]);
    expect(manifests[0]!.spec.strategy.blueGreen).toMatchObject({
      autoPromotionEnabled: true,
      autoPromotionSeconds: 90
    });
    expect(standIn.violations).toEqual([]);
  }, 90_000);

  it("D-b: blue-green WITHOUT autoPromotionSeconds is refused with a Decision", async () => {
    const p = await place("gamma", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `bgbad-${randomUUID().slice(0, 6)}`,
      [p],
      system,
      {
        deployment: { image: "ghcr.io/acme/bg:1.0.0", containerPort: 8080 }
      }
    );
    const topo = await topology([
      { name: "gamma", mode: "parallel", targets: [p.id], rollout: { strategy: "blueGreen" } }
    ]);
    const mark = writeMark();
    const change = await admin.changes.propose({
      name: "bg bad",
      targets: [component.id],
      topology: topo.id
    });
    await expectRefused(
      change.id,
      placements[p.id]!,
      "deployment_authoring_refused",
      { cause: "blue_green_without_auto_promotion" },
      mark
    );
  }, 90_000);

  it("D-a: a component rollout declaration the D12 wire cannot read is refused, not ignored", async () => {
    const p = await place("gamma", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `ownbad-${randomUUID().slice(0, 6)}`,
      [p],
      system,
      { deployment: { image: "ghcr.io/acme/bg:1.0.0", containerPort: 8080 } }
    );
    // Written the way an older writer or a hand edit could: IaC apply's schema would refuse it.
    await inOrg((tx) =>
      upsertComponentRollout(tx, org.orgId, {
        componentObjectId: component.id,
        targetClass: "cluster",
        rollout: { strategy: "canary", steps: [] }
      })
    );
    const topo = await topology([{ name: "gamma", mode: "parallel", targets: [p.id] }]);
    const mark = writeMark();
    const change = await admin.changes.propose({
      name: `own bad ${randomUUID().slice(0, 6)}`,
      targets: [component.id],
      topology: topo.id
    });
    await expectRefused(
      change.id,
      placements[p.id]!,
      "deployment_authoring_refused",
      { cause: "component_rollout_unreadable" },
      mark
    );
  }, 90_000);

  it("D-c: a rollback RE-AUTHORS the prior manifest; a rollback of the first-ever deployment is refused", async () => {
    const p = await place("gamma", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `rb-${randomUUID().slice(0, 6)}`,
      [p],
      system,
      {
        deployment: { image: "ghcr.io/acme/rb:1.0.0" }
      }
    );
    const topo = await topology([{ name: "gamma", mode: "parallel", targets: [p.id] }]);
    const targetId = placements[p.id]!;
    const bodyFor = (from: number) =>
      standIn.authoredBodies
        .slice(from)
        .filter((b) => b.metadata.labels?.["commanderscp.io/target"] === targetId);

    const b1 = standIn.authoredBodies.length;
    const v1 = await admin.changes.propose({
      name: "v1",
      targets: [component.id],
      topology: topo.id,
      sourceRef: { artifact_digest: `sha256:${"1".repeat(64)}` }
    });
    if ((await settle(v1.id)) === "validating") await admin.changes.accept(v1.id);
    const v1Doc = bodyFor(b1)[0]!;

    const b2 = standIn.authoredBodies.length;
    const v2 = await admin.changes.propose({
      name: "v2",
      targets: [component.id],
      topology: topo.id,
      sourceRef: { artifact_digest: `sha256:${"2".repeat(64)}` }
    });
    if ((await settle(v2.id)) === "validating") await admin.changes.accept(v2.id);
    expect(bodyFor(b2)).toHaveLength(1);
    expect(JSON.stringify(bodyFor(b2)[0])).toContain("2".repeat(64));

    const b3 = standIn.authoredBodies.length;
    const rb = await admin.changes.rollback(v2.id, "undo v2");
    await waitUntil(
      async () => ((await admin.changes.get(v2.id)).state === "rolled_back" ? true : undefined),
      {
        describe: "v2 rolled back",
        timeoutMs: 60_000,
        intervalMs: 250
      }
    );
    // The rollback re-authored EXACTLY v1's CONTENT (its Rollout, image and steps), through the same
    // door, under today's envelope — stamped as a rollback.
    const rolledBack = bodyFor(b3);
    expect(rolledBack).toHaveLength(1);
    expect(rolledBack[0]!.spec?.source?.helm?.valuesObject?.manifests).toEqual(
      v1Doc.spec?.source?.helm?.valuesObject?.manifests
    );
    expect(rolledBack[0]!.spec?.source?.repoURL).toBe(v1Doc.spec?.source?.repoURL);
    expect(rolledBack[0]!.metadata.annotations?.["commanderscp.io/rollout-source"]).toBe(
      "rollback"
    );
    const liveImage = (
      [...standIn.cluster.values()].find(
        (m) =>
          m.kind === "Rollout" && (m.metadata as { name: string }).name.startsWith(component.name)
      )!.spec as { template: { spec: { containers: { image: string }[] } } }
    ).template.spec.containers[0]!.image;
    expect(liveImage).toContain("1".repeat(64));
    expect(rb.rollbackOfObjectId).toBe(v2.id);

    // And v1 — the first authored deployment of this target — has nothing before it.
    const mark = writeMark();
    const rb1 = await admin.changes.rollback(v1.id, "undo v1");
    const row = await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, org.orgId),
                eq(changeWaveTargets.targetObjectId, targetId)
              )
            )
        );
        return rows.find((r) => r.status === "deployment_authoring_refused");
      },
      { describe: "the v1 rollback is refused", timeoutMs: 45_000, intervalMs: 250 }
    );
    expect(row.executorRef).toBeNull();
    const ds = await inOrg((tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, rb1.id))
    );
    expect(
      ds.some(
        (d) =>
          d.verdict === "block" &&
          (d.inputContext as { cause?: string }).cause === "rollback_without_prior"
      )
    ).toBe(true);
    expect(standIn.requests.slice(mark).filter((r) => r.method !== "GET")).toEqual([]);
  }, 180_000);

  it("finding 1: a RECIPE naming scpAuthoredApplication is refused — for a component that declares no deployment", async () => {
    const p = await place("gamma", "shop");
    const system = await argocdSystem();
    const { component, placements } = await placedComponent(
      `smuggle-${randomUUID().slice(0, 6)}`,
      [p],
      system,
      {}
    );
    const topo = await topology([{ name: "gamma", mode: "parallel", targets: [p.id] }]);
    const evil: StandInApplication = {
      metadata: { name: "pwn", labels: { "commanderscp.io/authored": "true" } },
      spec: {
        project: "default",
        destination: { namespace: "kube-system" },
        source: {
          repoURL: "https://evil.example/x.git",
          // The reviewer's probe shape: raw `helm.values` text, shallow enough to pass the recipe
          // schema's depth bound — which is exactly why the depth bound is not the defence.
          helm: {
            values:
              "manifests:\n- apiVersion: rbac.authorization.k8s.io/v1\n  kind: ClusterRoleBinding\n  metadata: {name: pwn}\n  roleRef: {kind: ClusterRole, name: cluster-admin}\n"
          } as never
        }
      }
    };
    const mark = writeMark();
    const change = await admin.changes.propose({
      name: "smuggle",
      targets: [component.id],
      topology: topo.id,
      properties: {
        recipe: {
          version: 1,
          trigger: { kind: "sync", parameters: { scpAuthoredApplication: evil } }
        }
      }
    });
    await expectRefused(
      change.id,
      placements[p.id]!,
      "recipe_reserved_parameter",
      { reservedParameters: ["scpAuthoredApplication"] },
      mark
    );
    expect(standIn.applications.has("pwn")).toBe(false);
  }, 90_000);

  it("finding 6: two components whose component-place names fold EQUAL get two Applications", async () => {
    const suffix = randomUUID().slice(0, 4);
    const system = await argocdSystem();
    const west = await admin.deploymentTargets.create({
      name: `west${suffix}`,
      properties: { environment: "gamma", namespace: "shop" }
    });
    const euwest = await admin.deploymentTargets.create({
      name: `eu-west${suffix}`,
      properties: { environment: "gamma", namespace: "shop" }
    });
    const a = await placedComponent(`ca${suffix}-eu`, [west], system, {
      deployment: { image: "ghcr.io/acme/a:1" }
    });
    const b = await placedComponent(`ca${suffix}`, [euwest], system, {
      deployment: { image: "ghcr.io/acme/b:1" }
    });
    const topo = await topology([
      { name: "gamma", mode: "parallel", targets: [west.id, euwest.id] }
    ]);
    const change = await admin.changes.propose({
      name: "fold",
      targets: [a.component.id, b.component.id],
      topology: topo.id
    });
    await settle(change.id);
    const apps = [...standIn.applications.values()].filter((x) =>
      [a.placements[west.id], b.placements[euwest.id]].includes(
        x.metadata.labels?.["commanderscp.io/target"] as string
      )
    );
    expect(apps).toHaveLength(2);
    expect(apps[0]!.metadata.name).not.toBe(apps[1]!.metadata.name);
  }, 90_000);

  describe("review round 2 — rollback against TODAY's authoring, config provenance, terminal plugin verdicts", () => {
    /** Propose + settle + accept one forward release; returns its id. */
    async function release(componentId: string, topologyId: string, digitChar: string) {
      const c = await admin.changes.propose({
        name: `rel ${digitChar} ${randomUUID().slice(0, 6)}`,
        targets: [componentId],
        topology: topologyId,
        sourceRef: { artifact_digest: `sha256:${digitChar.repeat(64)}` }
      });
      if ((await settle(c.id)) === "validating") await admin.changes.accept(c.id);
      return c.id;
    }

    it("B1: a rollback into a namespace the target has since LEFT (and the operator withdrew) is refused, not re-authored", async () => {
      const p = await place("gamma", "shop");
      const system = await argocdSystem({ ...AUTHORING, namespaces: ["shop-gamma", "shop"] });
      const name = `b1-${randomUUID().slice(0, 6)}`;
      const { component, placements } = await placedComponent(name, [p], system, {
        deployment: { image: "ghcr.io/acme/b1:1", namespace: "shop-gamma" }
      });
      const topo = await topology([{ name: "gamma", mode: "parallel", targets: [p.id] }]);
      await release(component.id, topo.id, "3");
      // The target moves to `shop`, releases there, and the operator withdraws the old namespace.
      await admin.components.update(component.id, {
        properties: { deployment: { image: "ghcr.io/acme/b1:1", namespace: "shop" } }
      });
      const v2 = await release(component.id, topo.id, "4");
      await admin
        .object("execution-system")
        .update(system.id, {
          properties: { ...system.properties, authoring: { ...AUTHORING, namespaces: ["shop"] } }
        });
      const mark = writeMark();
      const rb = await admin.changes.rollback(v2, "undo v2");
      const row = await waitUntil(
        async () => {
          const rows = await inOrg((tx) =>
            tx
              .select()
              .from(changeWaveTargets)
              .where(
                and(
                  eq(changeWaveTargets.orgId, org.orgId),
                  eq(changeWaveTargets.targetObjectId, placements[p.id]!)
                )
              )
          );
          return rows.find((r) => r.status === "deployment_authoring_refused");
        },
        { describe: "the B1 rollback is refused", timeoutMs: 45_000, intervalMs: 250 }
      );
      expect(row.executorRef).toBeNull();
      const ds = await inOrg((tx) => tx.select().from(decisions).where(eq(decisions.subjectId, rb.id)));
      expect(
        ds.some(
          (d) =>
            d.verdict === "block" &&
            (d.inputContext as { cause?: string }).cause === "rollback_destination_changed"
        )
      ).toBe(true);
      expect(standIn.requests.slice(mark).filter((r) => r.method !== "GET")).toEqual([]);
      expect((await admin.changes.get(v2)).state).not.toBe("rolled_back");
    }, 180_000);

    it("B2: after a carrier bump, a rollback re-authors the prior CONTENT under the NEW carrier — and the plugin sees the new authoring (config refresh)", async () => {
      const p = await place("gamma", "shop");
      const system = await argocdSystem();
      const { component, placements } = await placedComponent(
        `b2-${randomUUID().slice(0, 6)}`,
        [p],
        system,
        { deployment: { image: "ghcr.io/acme/b2:1" } }
      );
      const topo = await topology([{ name: "gamma", mode: "parallel", targets: [p.id] }]);
      await release(component.id, topo.id, "5");
      const v2 = await release(component.id, topo.id, "6");
      // The operator upgrades the carrier. The plugin instance was started with carrier-v1; if it kept
      // that copy, its own guard would refuse the carrier-v2 document below.
      await admin.object("execution-system").update(system.id, {
        properties: { ...system.properties, authoring: { ...AUTHORING, targetRevision: "carrier-v2" } }
      });
      const b = standIn.authoredBodies.length;
      await admin.changes.rollback(v2, "undo v2");
      await waitUntil(
        async () => ((await admin.changes.get(v2)).state === "rolled_back" ? true : undefined),
        { describe: "v2 rolled back under the new carrier", timeoutMs: 60_000, intervalMs: 250 }
      );
      const body = standIn.authoredBodies
        .slice(b)
        .find((x) => x.metadata.labels?.["commanderscp.io/target"] === placements[p.id])!;
      expect(body.spec?.source?.targetRevision).toBe("carrier-v2");
      expect(JSON.stringify(body.spec?.source?.helm)).toContain("5".repeat(64));
      expect(standIn.violations).toEqual([]);
    }, 180_000);

    it("item 3: an INLINE binding may not declare `authoring` — only the execution-system can", async () => {
      const component = await createTestComponent(admin, {
        name: `inline-${randomUUID().slice(0, 6)}`,
        properties: { deployment: { image: "ghcr.io/acme/x:1" } }
      });
      const err = await admin.executors
        .putBinding(component.id, {
          pluginModule: "argocd",
          pluginInstanceId: `inline-${randomUUID().slice(0, 6)}`,
          config: {
            serverUrl: standIn.url,
            authoring: { ...AUTHORING, repoURL: "https://evil.example/x.git", namespaces: ["payments"] }
          }
        })
        .catch((e: unknown) => e);
      expect(String((err as Error)?.message ?? err)).toMatch(/Bad Request|400/);
      expect(JSON.stringify(err)).toContain("only the execution-system");
    }, 60_000);

    it("item 2: a PLUGIN refusal is a terminal verdict with a Decision — not a trigger retried forever", async () => {
      const p = await place("gamma", "shop");
      const system = await argocdSystem();
      const component = await createTestComponent(admin, {
        name: `theirs-${randomUUID().slice(0, 6)}`,
        properties: { deployment: { image: "ghcr.io/acme/x:1" } }
      });
      const placement = await admin.placements.create({
        component: component.id,
        deploymentTarget: p.id
      });
      // The binding names an Application someone else already owns in that Argo CD.
      const theirs = `theirs-${randomUUID().slice(0, 6)}`;
      standIn.seed({ metadata: { name: theirs, labels: {} } });
      await admin.executors.putBinding(placement.id, {
        executionSystemId: system.id,
        externalRef: theirs
      });
      const topo = await topology([{ name: "gamma", mode: "parallel", targets: [p.id] }]);
      const mark = writeMark();
      const change = await admin.changes.propose({
        name: `theirs ${randomUUID().slice(0, 6)}`,
        targets: [component.id],
        topology: topo.id
      });
      const row = await waitUntil(
        async () => {
          const r = await waveTargetRow(placement.id);
          return r?.status === "executor_refused" ? r : undefined;
        },
        { describe: "the plugin's refusal terminalises the target", timeoutMs: 45_000, intervalMs: 250 }
      );
      expect(row.status).toBe("executor_refused");
      const ds = await inOrg((tx) =>
        tx.select().from(decisions).where(eq(decisions.subjectId, change.id))
      );
      const block = ds.find(
        (d) => d.verdict === "block" && (d.inputContext as { gate?: string }).gate === "executor_refused"
      );
      expect(JSON.stringify(block?.reasonTree)).toContain("not authored by CommanderSCP");
      expect(standIn.requests.slice(mark).filter((r) => r.method !== "GET")).toEqual([]);
    }, 90_000);
  });

  describe("finding 7: every refusal branch — terminal, a Decision, an audit event, and trigger() never called", () => {
    const cases: [
      string,
      string,
      (ctx: { p: GraphObject; system: GraphObject }) => Promise<{
        properties: Record<string, unknown>;
        waves?: (p: GraphObject) => unknown[];
        sourceRef?: Record<string, unknown>;
        system?: GraphObject;
      }>
    ][] = [
      [
        "no authoring on the Argo CD",
        "no_authoring",
        async () => ({
          properties: { deployment: { image: "x:1" } },
          system: await argocdSystem(null)
        })
      ],
      [
        "an unscoped authoring (default project)",
        "authoring_unreadable",
        async () => ({
          properties: { deployment: { image: "x:1" } },
          system: await argocdSystem({ ...AUTHORING, project: "default" })
        })
      ],
      [
        "an unreadable declaration",
        "deployment_unreadable",
        async () => ({ properties: { deployment: { image: "has space" } } })
      ],
      [
        "imported AND declared",
        "imported_and_declared",
        async () => ({ properties: { deployment: { image: "x:1" }, argocdApplication: "theirs" } })
      ],
      [
        "a namespace outside the allowlist",
        "namespace_not_allowed",
        async () => ({ properties: { deployment: { image: "x:1", namespace: "payments" } } })
      ],
      [
        "kube-system",
        "namespace_not_allowed",
        async () => ({ properties: { deployment: { image: "x:1", namespace: "kube-system" } } })
      ],
      [
        "two OCI digests",
        "multiple_digests",
        async () => ({
          properties: { deployment: { image: "x:1" } },
          sourceRef: { artifact_digest: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`] }
        })
      ],
      [
        "an ambiguous wave plan",
        "ambiguous_wave_rollout",
        async () => ({
          properties: { deployment: { image: "x:1" } },
          waves: (p) => [
            {
              name: "a",
              mode: "parallel",
              targets: [p.id],
              rollout: { strategy: "canary", steps: [{ weightPercent: 10 }] }
            },
            {
              name: "b",
              mode: "parallel",
              targets: [p.id],
              rollout: { strategy: "canary", steps: [{ weightPercent: 20 }] }
            }
          ]
        })
      ],
      [
        "blue-green with no port for its Services",
        "blue_green_needs_port",
        async () => ({
          properties: { deployment: { image: "x:1" } },
          waves: (p) => [
            {
              name: "g",
              mode: "parallel",
              targets: [p.id],
              rollout: { strategy: "blueGreen", autoPromotionSeconds: 30 }
            }
          ]
        })
      ]
    ];

    it.each(cases)(
      "%s ⇒ refused (%s)",
      async (_what, cause, setup) => {
        const p = await place("gamma", "shop");
        const defaultSystem = await argocdSystem();
        const s = await setup({ p, system: defaultSystem });
        const { component, placements } = await placedComponent(
          `ref-${randomUUID().slice(0, 6)}`,
          [p],
          s.system ?? defaultSystem,
          s.properties
        );
        const topo = await topology(
          s.waves ? s.waves(p) : [{ name: "gamma", mode: "parallel", targets: [p.id] }]
        );
        const mark = writeMark();
        const change = await admin.changes.propose({
          name: `refuse ${cause} ${randomUUID().slice(0, 6)}`,
          targets: [component.id],
          topology: topo.id,
          ...(s.sourceRef ? { sourceRef: s.sourceRef } : {})
        });
        await expectRefused(
          change.id,
          placements[p.id]!,
          "deployment_authoring_refused",
          { gate: "deployment_authoring", cause },
          mark
        );
      },
      90_000
    );
  });
});
