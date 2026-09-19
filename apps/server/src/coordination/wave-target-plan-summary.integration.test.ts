import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { updateWaveTargetObserved } from "./wave-targets-repo.js";

/** The plan's own wave-target row for a placement, straight off the table — the same shortcut
 *  `wave-target-freshness.integration.test.ts` takes. */
async function waveTargetRowFor(tx: TenantTx, orgId: string, targetObjectId: string) {
  const rows = await tx
    .select()
    .from(changeWaveTargets)
    .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
    .orderBy(desc(changeWaveTargets.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || row.orgId !== orgId) throw new Error(`no wave target row for ${targetObjectId}`);
  return row;
}

/**
 * pipeline-mockup-data.md §6 (increment 5): `observed.plan`, the managed-iac plan-summary chip —
 * counted from `tofu show -json`'s `resource_changes[].change.actions` in the plugin, carried
 * through `observedStateFrom`/`updateWaveTargetObserved`, and projected on `GET
 * /changes/{id}:explain` by `toChangeWaveTargetShape`. Every assertion enters at the real route,
 * the same discipline the freshness increment's own integration test follows.
 */
describe("pipeline-mockup-data increment 5: observed.plan", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "wave-target-plan-summary");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function componentPlacedAt(deploymentTargetId: string, slug: string) {
    const component = await createTestComponent(admin, { name: `${slug}-${randomUUID()}` });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: deploymentTargetId
    });
    return { component, placement };
  }

  /** Compiles the plan directly (no reconcile loop) — the same shortcut the freshness and
   *  provider integration tests take, so reading state does not race the reconcile loop's timing. */
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

  async function explainTarget(changeId: string, targetObjectId: string) {
    const explained = await admin.changes.explain(changeId);
    const target = explained
      .plan!.waves.flatMap((w) => w.targets)
      .find((t) => t.targetObjectId === targetObjectId);
    if (!target) throw new Error(`no wave target for ${targetObjectId} on change ${changeId}`);
    return target;
  }

  it("a plan tally written by the reconcile loop's observation reaches `explain` verbatim, with the ref short enough to display and the real counts", async () => {
    const gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID()}` });
    const topology = await admin.object("release-topology").create({
      name: `topo-plan-${randomUUID()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    const { component, placement } = await componentPlacedAt(gamma.id, "plan");
    const change = await proposeAndCompile(`chg-plan-${randomUUID()}`, [component.id], topology.id);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await waveTargetRowFor(tx, org.orgId, placement.id);
      await updateWaveTargetObserved(tx, org.orgId, row.id, "succeeded", {
        plan: {
          ref: "7c1e9f2a8b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
          add: 2,
          change: 0,
          destroy: 1
        }
      });
    });

    const target = await explainTarget(change.id, placement.id);
    expect(target.observed?.plan).toEqual({
      ref: "7c1e9f2a8b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
      add: 2,
      change: 0,
      destroy: 1
    });
  });

  // THE HONESTY TEST — a target this instance has observed at all (a real `rollout` reading is
  // present) but for which the executor never reported a plan tally (e.g. a non-managed-iac
  // executor, or a rollback whose evidence carried no `resource_changes`) must project `plan` as
  // ABSENT — never a zeroed `{add: 0, change: 0, destroy: 0}`.
  it("an observed target with no plan tally at all -> observed.plan stays absent, never a zeroed summary", async () => {
    const gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID()}` });
    const topology = await admin.object("release-topology").create({
      name: `topo-no-plan-${randomUUID()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    const { component, placement } = await componentPlacedAt(gamma.id, "no-plan");
    const change = await proposeAndCompile(
      `chg-no-plan-${randomUUID()}`,
      [component.id],
      topology.id
    );

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await waveTargetRowFor(tx, org.orgId, placement.id);
      await updateWaveTargetObserved(tx, org.orgId, row.id, "succeeded", {
        rollout: { phase: "Healthy" }
      });
    });

    const target = await explainTarget(change.id, placement.id);
    expect(target.observed?.rollout).toEqual({ phase: "Healthy" });
    expect(target.observed?.plan).toBeUndefined();
  });

  // A later observation with NO plan field must not null out a previously-captured one —
  // `observedStateFrom`'s "only when present" rule, the same one `rollout` already follows.
  it("a later observation carrying no plan field does not erase a previously-captured plan", async () => {
    const gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID()}` });
    const topology = await admin.object("release-topology").create({
      name: `topo-sticky-plan-${randomUUID()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    const { component, placement } = await componentPlacedAt(gamma.id, "sticky-plan");
    const change = await proposeAndCompile(
      `chg-sticky-plan-${randomUUID()}`,
      [component.id],
      topology.id
    );

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await waveTargetRowFor(tx, org.orgId, placement.id);
      await updateWaveTargetObserved(tx, org.orgId, row.id, "observing", {
        plan: { ref: "a802", add: 1, change: 0, destroy: 0 }
      });
      // A direct-DB write with no `observedState` argument at all is the API's own contract for
      // "no new reading", never a caller-supplied clear.
      await updateWaveTargetObserved(tx, org.orgId, row.id, "succeeded");
    });

    const target = await explainTarget(change.id, placement.id);
    expect(target.observed?.plan).toEqual({ ref: "a802", add: 1, change: 0, destroy: 0 });
  });
});
