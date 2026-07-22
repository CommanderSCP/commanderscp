import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";

/**
 * M15.6 — Multi-region Argo CD as a first-class, tested SETTING (ADR-0017 §3).
 *
 * A prod environment that spans regions binds a DISTINCT Argo CD per region. A region is an ordinary
 * `deployment-target` carrying `properties.environment` + `properties.region`; its per-region Argo CD
 * is an ordinary per-region executor binding (imported/coordinated, NOT bundled-N). Two things are
 * proven here:
 *
 *  1. The config SURFACE (`GET /environments/:env/regional-executors`, via the generated SDK only):
 *     reads `prod env -> {region -> argocd binding}` and validates that every region has its OWN
 *     Argo CD binding — a helpful `valid:false` + `problems` when one does not, so a multi-region
 *     prod env is never silently deployed against a region with no Argo CD.
 *
 *  2. Per-region FAN-OUT end to end: a change to a prod env with AMER + APAC region targets, each
 *     bound to a DISTINCT execution-system (the fake-executor standing in for two regional Argo CDs),
 *     drives the AMER wave target against the AMER system's instance and the APAC wave target against
 *     the APAC system's instance — each wave target resolves its OWN regional binding. This is the
 *     real assertion the milestone asks for, not a unit tautology: it runs the reconcile loop and
 *     reads the executor-plugin-instance id recorded on each wave target.
 */
describe("M15.6: multi-region Argo CD — config surface + per-region fan-out", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "m15-6-multiregion");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** An imported/coordinated execution-system standing in for one region's Argo CD. `kind` selects
   *  the executor module — "argocd" for the config-surface (read-only, no dispatch) assertions;
   *  "fake-executor" for the fan-out test that actually drives the reconcile loop. */
  async function createRegionalArgocd(kind: "argocd" | "fake-executor", host: string) {
    return admin.object("execution-system").create({
      name: `argocd-${host}-${randomUUID().slice(0, 8)}`,
      properties: { kind, serverUrl: `https://${host}.argocd.example` }
    });
  }

  async function createRegionTarget(environment: string, region: string) {
    return admin.object("deployment-target").create({
      name: `${environment}-${region}-${randomUUID().slice(0, 8)}`,
      properties: { environment, region }
    });
  }

  it("config surface: a prod env with an Argo CD bound per region validates as OK, and names the distinct systems", async () => {
    const env = `prod-ok-${randomUUID().slice(0, 6)}`;
    const amerSys = await createRegionalArgocd("argocd", "amer");
    const apacSys = await createRegionalArgocd("argocd", "apac");
    const amer = await createRegionTarget(env, "amer");
    const apac = await createRegionTarget(env, "apac");

    // Declare each region's Argo CD via the EXISTING per-target binding path (unchanged).
    await admin.executors.putBinding(amer.id, { executionSystemId: amerSys.id });
    await admin.executors.putBinding(apac.id, { executionSystemId: apacSys.id });

    const view = await admin.executors.getRegionalExecutors(env);

    expect(view.environment).toBe(env);
    expect(view.type).toBe("configuration"); // Argo CD is GitOps sync
    expect(view.expectedModule).toBe("argocd");
    expect(view.valid).toBe(true);
    expect(view.problems).toEqual([]);

    const byRegion = new Map(view.regions.map((r) => [r.region, r]));
    expect([...byRegion.keys()].sort()).toEqual(["amer", "apac"]);
    expect(byRegion.get("amer")).toMatchObject({
      bound: true,
      isExpectedModule: true,
      pluginModule: "argocd",
      executionSystemId: amerSys.id
    });
    expect(byRegion.get("apac")).toMatchObject({
      bound: true,
      isExpectedModule: true,
      pluginModule: "argocd",
      executionSystemId: apacSys.id
    });
    // The two regions really resolve to DISTINCT Argo CD systems — the whole point of the setting.
    expect(byRegion.get("amer")!.executionSystemId).not.toBe(byRegion.get("apac")!.executionSystemId);
  });

  it("config surface: a region with NO Argo CD binding fails validation with a helpful problem (never a silent deploy)", async () => {
    const env = `prod-gap-${randomUUID().slice(0, 6)}`;
    const amerSys = await createRegionalArgocd("argocd", "amer");
    const amer = await createRegionTarget(env, "amer");
    const emea = await createRegionTarget(env, "emea"); // declared, but left UNBOUND
    await admin.executors.putBinding(amer.id, { executionSystemId: amerSys.id });

    const view = await admin.executors.getRegionalExecutors(env);

    expect(view.valid).toBe(false);
    const emeaEntry = view.regions.find((r) => r.region === "emea");
    expect(emeaEntry).toMatchObject({ bound: false, isExpectedModule: false, pluginModule: null });
    expect(view.problems.some((p) => p.includes("emea") && p.includes("no 'configuration' executor binding"))).toBe(true);
    expect(emea.id).toBe(emeaEntry!.targetId);
  });

  it("config surface: a region bound to a NON-argocd module is flagged (multi-region prod expects Argo CD per region)", async () => {
    const env = `prod-wrongmod-${randomUUID().slice(0, 6)}`;
    const amerSys = await createRegionalArgocd("argocd", "amer");
    const apacSys = await createRegionalArgocd("fake-executor", "apac"); // not argocd
    const amer = await createRegionTarget(env, "amer");
    const apac = await createRegionTarget(env, "apac");
    await admin.executors.putBinding(amer.id, { executionSystemId: amerSys.id });
    await admin.executors.putBinding(apac.id, { executionSystemId: apacSys.id });

    const view = await admin.executors.getRegionalExecutors(env);

    expect(view.valid).toBe(false);
    expect(view.regions.find((r) => r.region === "apac")).toMatchObject({
      bound: true,
      isExpectedModule: false,
      pluginModule: "fake-executor"
    });
    expect(view.problems.some((p) => p.includes("apac") && p.includes("not 'argocd'"))).toBe(true);
  });

  it("config surface: an unknown environment is empty + invalid (no regions declared)", async () => {
    const view = await admin.executors.getRegionalExecutors(`nope-${randomUUID().slice(0, 6)}`);
    expect(view.regions).toEqual([]);
    expect(view.valid).toBe(false);
    expect(view.problems.some((p) => p.includes("no region deployment-targets"))).toBe(true);
  });

  it("per-region fan-out: a change to a prod env drives AMER→AMER Argo CD and APAC→APAC Argo CD (distinct instances)", async () => {
    const env = `prod-fanout-${randomUUID().slice(0, 6)}`;
    // Two DISTINCT execution-systems stand in for the two regional Argo CDs. fake-executor lets the
    // real reconcile loop drive each without a live Argo CD, while keeping the instances distinct.
    const amerSys = await createRegionalArgocd("fake-executor", "amer-fan");
    const apacSys = await createRegionalArgocd("fake-executor", "apac-fan");
    const amer = await createRegionTarget(env, "amer");
    const apac = await createRegionTarget(env, "apac");
    await admin.executors.putBinding(amer.id, { executionSystemId: amerSys.id });
    await admin.executors.putBinding(apac.id, { executionSystemId: apacSys.id });

    // Sanity: the surface agrees these are two distinct regional systems before we deploy.
    const preView = await admin.executors.getRegionalExecutors(env);
    expect(preView.regions.length).toBe(2);
    expect(new Set(preView.regions.map((r) => r.executionSystemId)).size).toBe(2);

    // The operator names the region targets explicitly (per the scope decision — no stage->region
    // auto-expansion); the mechanics already fan a change out to each target's own binding.
    const change = await admin.changes.propose({
      name: `promote ${env}`,
      targets: [amer.id, apac.id]
    });
    await waitUntil(
      async () => (await admin.changes.get(change.id)).state === "validating" || undefined,
      { describe: `change ${change.id} reaches 'validating'`, timeoutMs: 20_000 }
    );
    await admin.changes.promote(change.id);

    // Each region's wave target must be triggered against its OWN regional execution-system instance.
    async function triggeredInstanceFor(targetId: string): Promise<string | undefined> {
      const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(changeWaveTargets)
          .where(
            and(
              eq(changeWaveTargets.orgId, org.orgId),
              eq(changeWaveTargets.targetObjectId, targetId)
            )
          )
          .limit(1)
      );
      const row = rows[0];
      return row && row.executorPluginId ? row.executorPluginId : undefined;
    }

    const amerInstance = await waitUntil(() => triggeredInstanceFor(amer.id), {
      describe: `AMER wave target triggered against its regional Argo CD`,
      timeoutMs: 25_000
    });
    const apacInstance = await waitUntil(() => triggeredInstanceFor(apac.id), {
      describe: `APAC wave target triggered against its regional Argo CD`,
      timeoutMs: 25_000
    });

    // The crux — proven end to end, not a tautology: each region resolved its OWN binding.
    expect(amerInstance).toBe(`execution-system:${amerSys.id}`);
    expect(apacInstance).toBe(`execution-system:${apacSys.id}`);
    expect(amerInstance).not.toBe(apacInstance);
  });
});
