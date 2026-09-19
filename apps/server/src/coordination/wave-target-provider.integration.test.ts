import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { claimWaveTargetForTriggering, markWaveTargetTriggered } from "./wave-targets-repo.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** docs/proposals/pipeline-mockup-data.md §2 (increment 1): `executor`, `commitSha`,
 *  `topologyName` — three additive projections onto responses that already exist. See
 *  docs/coordination.md §689 (`compileAndPersistPlan`) for why this suite compiles plans directly
 *  rather than through the reconcile loop: the loop's own timing would make "read the plan BEFORE
 *  anything triggers" racy, and `component-pipeline.integration.test.ts` takes the identical
 *  shortcut for the identical reason. Every ASSERTION below still enters at the real route
 *  (`GET /changes/{id}:explain`, via `ScpClient`), which is what actually exercises the new
 *  projection code. */
describe("pipeline-mockup-data increment 1: provider, commit, topology name", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    // No reconcile loop: nothing here should ever auto-trigger a target out from under a
    // pre-trigger assertion.
    server = await listenTestServer();
    org = await createTestOrg(server, "wave-target-provider");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function proposeAndCompile(
    name: string,
    targetObjectIds: string[],
    topologyObjectId: string | null = null
  ) {
    const change = await admin.changes.propose({ name, targets: targetObjectIds });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds,
        topologyObjectId,
        topologyVersion: null
      })
    );
    return change;
  }

  it("a pre-trigger target with no binding anywhere on the ladder reports 'unbound' — never a guess", async () => {
    const component = await createTestComponent(admin, { name: `unbound-${uuidv7()}` });
    const change = await proposeAndCompile(`chg-unbound-${uuidv7()}`, [component.id]);

    const explained = await admin.changes.explain(change.id);
    const target = explained.plan!.waves[0]!.targets[0]!;
    expect(target.executorPluginId, "not triggered — the null this whole field exists for").toBeNull();
    expect(target.executor).toEqual({ basis: "unbound" });
  });

  it("a pre-trigger target shows the BOUND provider the resolution ladder selects NOW, from the binding — not the (still-null) trigger", async () => {
    const component = await createTestComponent(admin, { name: `bound-${uuidv7()}` });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7()}`
    });
    const change = await proposeAndCompile(`chg-bound-${uuidv7()}`, [component.id]);

    const explained = await admin.changes.explain(change.id);
    const target = explained.plan!.waves[0]!.targets[0]!;
    expect(target.executorPluginId).toBeNull();
    expect(target.executor).toEqual({ basis: "bound", pluginModule: "fake-executor" });
  });

  it("a TRIGGERED target's provider comes from the binding executor_plugin_id actually joins to", async () => {
    const component = await createTestComponent(admin, { name: `triggered-${uuidv7()}` });
    const instanceId = `inst-${uuidv7()}`;
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: instanceId
    });
    const change = await proposeAndCompile(`chg-triggered-${uuidv7()}`, [component.id]);
    const before = await admin.changes.explain(change.id);
    const targetId = before.plan!.waves[0]!.targets[0]!.id;

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const claimed = await claimWaveTargetForTriggering(tx, org.orgId, targetId);
      expect(claimed, "setup: claim must succeed against a fresh pending target").toBe(true);
      const marked = await markWaveTargetTriggered(tx, org.orgId, targetId, {
        executorPluginId: instanceId,
        executorRef: { externalId: "ext-1" },
        priorStateRef: null
      });
      expect(marked, "setup: the trigger record must land").toBe(true);
    });

    const explained = await admin.changes.explain(change.id);
    const target = explained.plan!.waves[0]!.targets[0]!;
    expect(target.executorPluginId).toBe(instanceId);
    expect(target.executor).toEqual({ basis: "triggered", pluginModule: "fake-executor" });
  });

  it("the change's typed commitSha reads sourceRef.commit — present, absent, and non-string all handled", async () => {
    const component = await createTestComponent(admin, { name: `commit-${uuidv7()}` });

    const withCommit = await admin.changes.propose({
      name: `chg-commit-${uuidv7()}`,
      targets: [component.id],
      sourceRef: { commit: "9f2a1c4" }
    });
    expect((await admin.changes.explain(withCommit.id)).change.commitSha).toBe("9f2a1c4");

    const withoutSourceRef = await admin.changes.propose({
      name: `chg-nosource-${uuidv7()}`,
      targets: [component.id]
    });
    expect((await admin.changes.explain(withoutSourceRef.id)).change.commitSha).toBeNull();

    const withNonStringCommit = await admin.changes.propose({
      name: `chg-badcommit-${uuidv7()}`,
      targets: [component.id],
      sourceRef: { commit: 12345 as unknown as string }
    });
    expect(
      (await admin.changes.explain(withNonStringCommit.id)).change.commitSha,
      "a non-string commit must read back null, never a coerced guess"
    ).toBeNull();
  });

  it("the plan's topologyName is the topology object's name, and null when there is none", async () => {
    const component = await createTestComponent(admin, { name: `topo-${uuidv7()}` });
    const topo = await admin.object("release-topology").create({
      name: `commercial-gamma-then-prod-${uuidv7()}`,
      properties: { waves: [{ name: "only-wave", mode: "parallel", targets: [component.id] }] }
    });

    const withTopology = await proposeAndCompile(`chg-topo-${uuidv7()}`, [component.id], topo.id);
    expect((await admin.changes.explain(withTopology.id)).plan!.topologyName).toBe(topo.name);

    const withoutTopology = await proposeAndCompile(`chg-notopo-${uuidv7()}`, [component.id]);
    expect((await admin.changes.explain(withoutTopology.id)).plan!.topologyName).toBeNull();
  });
});
