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
import { auditEvents, changes, changeWaveTargets, decisions } from "../db/schema.js";

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

  // ---------------------------------------------------------------------------------------------
  // FAIL-CLOSED enforcement of the no-silent-deploy property (regional-executors.ts). The config
  // surface above is READ-ONLY; the actual guarantee lives at DEPLOY time. A change targeting a
  // DECLARED region deployment-target (properties.environment + properties.region) with NO resolvable
  // executor binding must be REFUSED — a block Decision (decision_id) + hash-chained audit + parked
  // change — NOT silently triggered against the shared default fake executor. SCOPED: a plain,
  // non-region target with no binding keeps its pre-existing default-executor behaviour untouched.
  // ---------------------------------------------------------------------------------------------

  /** The full change_wave_targets row for one target object (null until the plan materializes it). */
  async function waveTargetRow(targetId: string) {
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
    return rows[0];
  }
  const decisionsFor = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
    );
  const auditFor = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeId))
    );
  const changeRow = async (changeId: string) => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeId))
    );
    return rows[0]!;
  };

  it("refusal (fail-closed): a declared region target with NO Argo CD binding is REFUSED, not silently deployed against the default executor", async () => {
    const env = `prod-refuse-${randomUUID().slice(0, 6)}`;
    // APAC is bound (a drivable fake-executor stand-in for its regional Argo CD); AMER is left UNBOUND.
    const apacSys = await createRegionalArgocd("fake-executor", "apac-refuse");
    const amer = await createRegionTarget(env, "amer"); // declared region, NO binding
    const apac = await createRegionTarget(env, "apac");
    await admin.executors.putBinding(apac.id, { executionSystemId: apacSys.id });

    const change = await admin.changes.propose({
      name: `promote ${env}`,
      targets: [amer.id, apac.id]
    });

    // AMER's wave target must terminalize on the dedicated `no_executor` status — the fail-closed
    // gate firing — rather than being triggered against the shared default executor.
    const amerTarget = await waitUntil(
      async () => {
        const row = await waveTargetRow(amer.id);
        return row && row.status === "no_executor" ? row : undefined;
      },
      { describe: `AMER region target refused (no_executor)`, timeoutMs: 25_000 }
    );

    // It was NEVER handed to the shared default fake executor (that is exactly the silent deploy the
    // overclaimed comment promised never happens — now actually enforced).
    expect(amerTarget.executorPluginId).not.toBe("fake-executor");
    expect(amerTarget.executorRef).toBeNull();

    // A `block` Decision with a decision_id names the region gap.
    const blockDecision = (await decisionsFor(change.id)).find(
      (d) => d.kind === "wave_target" && d.verdict === "block"
    );
    expect(blockDecision).toBeDefined();
    expect(blockDecision!.id).toEqual(expect.any(String));
    expect(blockDecision!.inputContext).toMatchObject({
      environment: env,
      region: "amer",
      gate: "regional_argocd_silent_deploy"
    });

    // A hash-chained audit event carries that decision_id.
    const noExecEvent = (await auditFor(change.id)).find(
      (e) => e.action === "change.wave_target.no_executor"
    );
    expect(noExecEvent).toBeDefined();
    expect(noExecEvent!.decisionId).toBe(blockDecision!.id);
    expect(noExecEvent!.rowHash).toEqual(expect.any(String)); // linked into the org's hash chain.

    // The change is PARKED (reconcile_blocked) — never silently succeeded.
    expect((await changeRow(change.id)).reconcileBlockedAt).not.toBeNull();
  });

  it("scope guard: a PLAIN (non-region) unbound deployment-target keeps its pre-existing default-executor behaviour — the region gate never touches it", async () => {
    // No properties.environment / properties.region ⇒ NOT a declared region target. Zero bindings ⇒
    // the intended-fake path: the shared default executor IS its rehearsal executor. The M15.6 gate
    // must leave this exactly as it was (case (a)); this pins that it does not over-fire.
    const plain = await admin.object("deployment-target").create({
      name: `plain-${randomUUID().slice(0, 8)}`,
      properties: {}
    });

    const change = await admin.changes.propose({
      name: `deploy plain target`,
      targets: [plain.id]
    });

    // It is triggered against the shared DEFAULT fake executor, exactly as before — NOT newly blocked.
    const target = await waitUntil(
      async () => {
        const row = await waveTargetRow(plain.id);
        return row && row.executorPluginId ? row : undefined;
      },
      { describe: `plain target triggered against default executor`, timeoutMs: 25_000 }
    );

    expect(target.executorPluginId).toBe("fake-executor"); // DEFAULT_EXECUTOR_INSTANCE_ID — unchanged.
    expect(target.status).not.toBe("no_executor");

    // No block Decision from the region gate, and the change is NOT parked.
    expect(
      (await decisionsFor(change.id)).some((d) => d.kind === "wave_target" && d.verdict === "block")
    ).toBe(false);
    expect((await changeRow(change.id)).reconcileBlockedAt).toBeNull();
  });
});
