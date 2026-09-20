import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { updateWaveTargetObserved, type WaveTargetObservedState } from "./wave-targets-repo.js";
import { recordPeerObservation } from "../federation/peer-observations-repo.js";

/** The plan's own wave-target row for a placement, straight off the table — NOT
 *  `findLatestWaveTargetForObject` (that repo function scopes to `DRIVING_CHANGE_STATES` for the
 *  reconcile hold's own purpose, which a freshly `compileAndPersistPlan`-only change, never ticked,
 *  does not satisfy). */
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

/** docs/proposals/pipeline-mockup-data.md §5.1 (increment 2): `observedFreshness` — never / fresh /
 *  stale / not_reported. Every assertion enters at the real route (`GET /changes/{id}:explain`),
 *  which is what actually exercises `resolveWaveTargetFreshness`. */
describe("pipeline-mockup-data increment 2: observedFreshness", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "wave-target-freshness");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A `deployment-target` object planted with a FOREIGN `originDomainId` — the shape a replicated
   *  outpost target has, mirroring `component-pipeline-target-outpost.integration.test.ts`'s
   *  `plantTargetUnder`. */
  async function plantForeignDeploymentTarget(slug: string) {
    const name = `${slug}-${randomUUID()}`;
    const foreignDomainId = asTrustDomainId(randomUUID());
    const object = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { object } = await upsertObjectByUrn(tx, {
        orgId: org.orgId,
        typeId: "deployment-target",
        actorObjectId: org.orgId,
        requestId: `test-plant-${name}`,
        urn: `urn:scp:${org.orgId}:deployment-target:${name}`,
        name,
        properties: { environment: "prod" },
        federationImport: {
          originDomainId: foreignDomainId,
          revision: 1,
          provenance: null
        }
      });
      return object;
    });
    return { object, foreignDomainId };
  }

  async function componentPlacedAt(deploymentTargetId: string, slug: string) {
    const component = await createTestComponent(admin, { name: `${slug}-${randomUUID()}` });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: deploymentTargetId
    });
    return { component, placement };
  }

  /** Compiles the plan directly (no reconcile loop), the same shortcut
   *  `wave-target-provider.integration.test.ts` takes: reading state BEFORE anything triggers would
   *  otherwise race the loop's own timing. */
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

  it("a self-owned, never-observed stage-mode target (via a placement) reports 'never'", async () => {
    const gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID()}` });
    const topology = await admin.object("release-topology").create({
      name: `topo-never-${randomUUID()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    const { component, placement } = await componentPlacedAt(gamma.id, "never");
    const change = await proposeAndCompile(
      `chg-never-${randomUUID()}`,
      [component.id],
      topology.id
    );

    const target = await explainTarget(change.id, placement.id);
    expect(target.observedFreshness).toEqual({ state: "never" });
  });

  it("a self-owned, LEGACY (no-topology) never-observed target reports 'never' too — the component IS targetObjectId here", async () => {
    const component = await createTestComponent(admin, { name: `legacy-never-${randomUUID()}` });
    const change = await proposeAndCompile(`chg-legacy-never-${randomUUID()}`, [component.id]);

    const target = await explainTarget(change.id, component.id);
    expect(target.observedFreshness).toEqual({ state: "never" });
  });

  it("a self-owned target with a JUST-WRITTEN observation reports 'fresh', with a small ageSeconds", async () => {
    const gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID()}` });
    const topology = await admin.object("release-topology").create({
      name: `topo-fresh-${randomUUID()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    const { component, placement } = await componentPlacedAt(gamma.id, "fresh");
    const change = await proposeAndCompile(
      `chg-fresh-${randomUUID()}`,
      [component.id],
      topology.id
    );

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await waveTargetRowFor(tx, org.orgId, placement.id);
      await updateWaveTargetObserved(tx, org.orgId, row.id, "observing", {
        rollout: { phase: "Progressing", step: 1, weight: 20 }
      });
    });

    const target = await explainTarget(change.id, placement.id);
    expect(target.observedFreshness?.state).toBe("fresh");
    expect((target.observedFreshness as { ageSeconds: number }).ageSeconds).toBeLessThan(30);
  });

  it("a self-owned target whose reading is older than OBSERVED_WEIGHT_FRESHNESS_MS reports 'stale', dated off the READING's OWN observedAt (never lastObservedAt)", async () => {
    const gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID()}` });
    const topology = await admin.object("release-topology").create({
      name: `topo-stale-${randomUUID()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    const { component, placement } = await componentPlacedAt(gamma.id, "stale");
    const change = await proposeAndCompile(
      `chg-stale-${randomUUID()}`,
      [component.id],
      topology.id
    );

    const staleObservedAt = new Date(Date.now() - 15 * 60_000); // 15 min — past the 10 min bound
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await waveTargetRowFor(tx, org.orgId, placement.id);
      const observedState: WaveTargetObservedState = {
        rollout: { phase: "Paused", step: 2, weight: 40 },
        observedAt: staleObservedAt.toISOString()
      };
      // Direct write, bypassing `updateWaveTargetObserved` (which always stamps `now`) — this is the
      // only way to plant a reading whose `observedAt` is genuinely in the past, and it deliberately
      // sets `lastObservedAt` to a DIFFERENT, recent instant, so a passing test proves the field reads
      // the reading's own stamp and not the row-level column.
      await tx
        .update(changeWaveTargets)
        .set({ observedState, lastObservedAt: new Date(), updatedAt: new Date() })
        .where(eq(changeWaveTargets.id, row.id));
    });

    const target = await explainTarget(change.id, placement.id);
    expect(target.observedFreshness?.state).toBe("stale");
    const stale = target.observedFreshness as { ageSeconds: number; staleAfterSeconds: number };
    expect(stale.staleAfterSeconds).toBe(600);
    expect(stale.ageSeconds).toBeGreaterThan(600);
  });

  it("a target whose PLACEMENT names a deployment-target owned by ANOTHER domain reports 'not_reported', never 'never' — nothing has arrived on the wave_target_observed channel yet", async () => {
    const { object: foreignTarget } = await plantForeignDeploymentTarget("outpost-place");
    const topology = await admin.object("release-topology").create({
      name: `topo-not-reported-${randomUUID()}`,
      properties: {
        waves: [{ name: "outpost-wave", mode: "parallel", targets: [foreignTarget.id] }]
      }
    });
    const { component, placement } = await componentPlacedAt(foreignTarget.id, "not-reported");
    const change = await proposeAndCompile(
      `chg-not-reported-${randomUUID()}`,
      [component.id],
      topology.id
    );

    const target = await explainTarget(change.id, placement.id);
    expect(target.observedFreshness).toEqual({ state: "not_reported" });
  });

  // -----------------------------------------------------------------------------------------
  // Increment 6 (PR #374) follow-up: `wave_target_observed` (subject `target`) now really does
  // reach this instance, and `observedFreshness` must read the ARRIVED reading rather than
  // asserting `not_reported` from topology alone forever. Same defect class, same fix shape, as
  // `evidenceOrigin` (PR #386) on the `hook_run` subject of the same journal kind.
  // -----------------------------------------------------------------------------------------

  it("a target driven elsewhere, with a FRESH wave_target_observed(subject: target) arrived, reports 'fresh' off the PEER'S stamped observedAt", async () => {
    const { object: foreignTarget, foreignDomainId } =
      await plantForeignDeploymentTarget("outpost-fresh");
    const topology = await admin.object("release-topology").create({
      name: `topo-elsewhere-fresh-${randomUUID()}`,
      properties: {
        waves: [{ name: "outpost-wave", mode: "parallel", targets: [foreignTarget.id] }]
      }
    });
    const { component, placement } = await componentPlacedAt(foreignTarget.id, "elsewhere-fresh");
    const change = await proposeAndCompile(
      `chg-elsewhere-fresh-${randomUUID()}`,
      [component.id],
      topology.id
    );

    const observedAt = new Date();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordPeerObservation(tx, {
        orgId: org.orgId,
        peerDomainId: foreignDomainId,
        payload: {
          subject: "target",
          changeObjectId: change.id,
          targetObjectId: placement.id,
          type: "configuration",
          waveIndex: 0,
          status: "observing",
          attempt: 1,
          rollout: { phase: "Progressing", step: 1, weight: 20 },
          observedAt: observedAt.toISOString()
        }
      })
    );

    const target = await explainTarget(change.id, placement.id);
    expect(target.observedFreshness?.state).toBe("fresh");
    expect((target.observedFreshness as { ageSeconds: number }).ageSeconds).toBeLessThan(30);
    // This instance still runs no reconcile for it — the rollout CONTENT stays this instance's
    // own (empty) snapshot; only the FRESHNESS verdict reads the peer's arrival.
    expect(target.observed).toBeNull();
  });

  it("a target driven elsewhere, with a STALE wave_target_observed(subject: target) arrived, reports 'stale' off the PEER'S stamped observedAt — sharing OBSERVED_WEIGHT_FRESHNESS_MS, not a second bound", async () => {
    const { object: foreignTarget, foreignDomainId } =
      await plantForeignDeploymentTarget("outpost-stale");
    const topology = await admin.object("release-topology").create({
      name: `topo-elsewhere-stale-${randomUUID()}`,
      properties: {
        waves: [{ name: "outpost-wave", mode: "parallel", targets: [foreignTarget.id] }]
      }
    });
    const { component, placement } = await componentPlacedAt(foreignTarget.id, "elsewhere-stale");
    const change = await proposeAndCompile(
      `chg-elsewhere-stale-${randomUUID()}`,
      [component.id],
      topology.id
    );

    const staleObservedAt = new Date(Date.now() - 15 * 60_000); // 15 min — past the 10 min bound
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordPeerObservation(tx, {
        orgId: org.orgId,
        peerDomainId: foreignDomainId,
        payload: {
          subject: "target",
          changeObjectId: change.id,
          targetObjectId: placement.id,
          type: "configuration",
          waveIndex: 0,
          status: "observing",
          attempt: 1,
          rollout: { phase: "Paused", step: 2, weight: 40 },
          observedAt: staleObservedAt.toISOString()
        }
      })
    );

    const target = await explainTarget(change.id, placement.id);
    expect(target.observedFreshness?.state).toBe("stale");
    const stale = target.observedFreshness as { ageSeconds: number; staleAfterSeconds: number };
    // The SAME bound the self-owned stale test above asserts (600s) — `PEER_OBSERVATION_FRESHNESS_MS`
    // is `OBSERVED_WEIGHT_FRESHNESS_MS`, never a second constant.
    expect(stale.staleAfterSeconds).toBe(600);
    expect(stale.ageSeconds).toBeGreaterThan(600);
  });
});
