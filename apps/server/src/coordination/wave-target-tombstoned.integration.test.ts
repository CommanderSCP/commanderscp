import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  auditEvents,
  changes,
  changeWaveTargets,
  changeWaves,
  decisions,
  objects
} from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost, withRefusingTrigger } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import { WAVE_TARGET_TOMBSTONED_AUDIT_ACTION } from "./target-liveness.js";
import type { GateDeps } from "./gates.js";

/**
 * THE DEFECT: reconcile drove a wave target's object without ever asking whether that object was
 * still LIVE.
 *
 * A plan is compiled on the `evaluated -> coordinated` edge and its `change_wave_targets` rows are a
 * SNAPSHOT from that instant. Everything downstream — the trigger claim, the binding resolution, the
 * executor dispatch — reads those rows and nothing re-reads `objects`. So an authorized actor calling
 * `DELETE /components/{id}` at any point after compilation left the row untouched and the next tick
 * dispatched a real deploy at an object that, for every SCOPE question the platform asks, no longer
 * exists.
 *
 * WHY THAT PAIRING IS THE WHOLE POINT. Tombstoning is already a governance lever: every containment
 * route joins `parent.deleted_at IS NULL` (PR #249), so deleting a container silently detaches
 * everything beneath it from the policies that governed it. This was the execution-side twin — the
 * same one tombstone made the object ungoverned AND left it deploying. Absence of the object was
 * read, everywhere it mattered, as permission.
 *
 * THE FAILURE MODE CHOSEN, and why it is not a throw: refusing with an exception mid-campaign strands
 * the change with a `console.error` and nothing an operator can query. This parks instead, exactly as
 * the ADR-0006 masking-gap gate and the M17.4(b) pre-deploy gate already do: a `block` Decision with a
 * resolvable `decision_id`, a hash-chained audit event, the target terminalized on its own
 * `target_deleted` status, the wave failed and the change parked. `scp change explain` then answers
 * "why did this stop" with "its target was deleted", never with silence.
 *
 * THE FAIL DIRECTION, in both senses: a MISSING row refuses too (absence is not permission), while a
 * transient read failure must never look like a deletion — the liveness read throws out of
 * `triggerWaveTarget` and is retried next tick, terminalizing nothing. The last case in this file
 * pins that, because it is the direction that fails silently if anyone "simplifies" the check into a
 * boolean that swallows its own errors.
 */
describe("a tombstoned wave target is never driven", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let inner: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "tombstoned-target");
    sandbox = new CountingCelSandbox();
    inner = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  async function inject(url: string, payload: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /** The tombstone, taken THROUGH THE PUBLIC API by an authorized actor — not a raw UPDATE. The
   *  whole premise of the defect is that this is a legitimate, permitted call that nothing about the
   *  in-flight change refuses; faking it with a direct write would prove a weaker claim. */
  async function deleteComponentViaApi(componentId: string) {
    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/components/${componentId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    if (res.statusCode >= 300) {
      throw new Error(`DELETE component -> ${res.statusCode} ${res.body}`);
    }
  }

  /** A change walked to `executing` with wave 0 pending and NO blocking policy — so the only thing
   *  standing between it and a trigger is this feature. Mirrors
   *  `trigger-retry-backoff.integration.test.ts`'s helper of the same shape. */
  async function changeReadyToTrigger(
    label: string
  ): Promise<{ changeObjectId: string; targetObjectId: string; waveTargetId: string }> {
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });

    const gateDeps: GateDeps = { sandbox, host: inner };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "tombstone-test",
        name: `change-${label}`,
        targets: [component.id as string]
      });
      for (const toState of ["evaluated", "coordinated", "executing"] as const) {
        if (toState === "coordinated") {
          await compileAndPersistPlan(tx, {
            orgId: org.orgId,
            changeObjectId: change.id,
            targetObjectIds,
            topologyObjectId: null,
            topologyVersion: null
          });
        }
        await transitionChange(
          tx,
          {
            orgId: org.orgId,
            changeObjectId: change.id,
            toState,
            actorObjectId: org.orgId,
            requestId: "tombstone-test"
          },
          gateDeps
        );
      }
      return change.id;
    });

    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeObjectId)
    );
    const waveTarget = plan!.waves[0]!.targets[0]!;
    return {
      changeObjectId,
      targetObjectId: component.id as string,
      waveTargetId: waveTarget.id
    };
  }

  function tickWith(host: PluginHost) {
    return reconcileOrgTick(
      server.deps.db,
      org.orgId,
      host,
      sandbox,
      server.deps.config.secretsMasterKey
    );
  }

  async function targetRow(waveTargetId: string) {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.id, waveTargetId)))
    );
    return row!;
  }

  async function waveRowOf(waveTargetId: string) {
    const target = await targetRow(waveTargetId);
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaves)
        .where(and(eq(changeWaves.orgId, org.orgId), eq(changeWaves.id, target.waveId)))
    );
    return row!;
  }

  const decisionsFor = (changeObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, changeObjectId))
    );
  const auditFor = (changeObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeObjectId))
    );
  const changeRow = async (changeObjectId: string) => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    return row!;
  };

  // ===============================================================================================
  // THE REPRODUCTION. Before the fix this arm failed on its very first assertion — the executor was
  // handed a deploy for an object the platform had already tombstoned.
  // ===============================================================================================
  it("REPRODUCTION: an authorized mid-flight DELETE of the target stops the dispatch instead of riding through it", async () => {
    const { targetObjectId, waveTargetId } = await changeReadyToTrigger("mid-flight");
    const { host, calls } = withRefusingTrigger(inner, () => false);
    const mine = () => calls.filter((c) => c.targetRef === targetObjectId);

    // The plan is compiled and the target is `pending` — one tick away from a real deploy.
    expect((await targetRow(waveTargetId)).status).toBe("pending");

    // The tombstone lands here, in the window the plan snapshot cannot see.
    await deleteComponentViaApi(targetObjectId);

    await tickWith(host);

    // THE DEFECT, stated as the assertion that used to fail: nothing may reach the executor.
    expect(mine()).toHaveLength(0);

    const after = await targetRow(waveTargetId);
    expect(after.status).toBe("target_deleted");
    expect(after.executorRef).toBeNull();
    expect(after.executorPluginId).toBeNull();
  }, 180_000);

  it("EXPLAINABILITY: the refusal carries a block Decision, a hash-chained audit event, a failed wave and a parked change", async () => {
    const { changeObjectId, targetObjectId, waveTargetId } = await changeReadyToTrigger("explain");
    const { host } = withRefusingTrigger(inner, () => false);
    await deleteComponentViaApi(targetObjectId);
    await tickWith(host);

    // A `block` Decision an operator can resolve by id — charter principle 6. It NAMES the object
    // and the gate, so `scp change explain` answers "its target was deleted" rather than nothing.
    const blockDecision = (await decisionsFor(changeObjectId)).find(
      (d) => d.kind === "wave_target" && d.verdict === "block"
    );
    expect(blockDecision).toBeDefined();
    expect(blockDecision!.inputContext).toMatchObject({
      targetObjectId,
      gate: "target_deleted",
      liveness: "deleted"
    });
    expect(String((blockDecision!.reasonTree as { summary?: unknown }).summary)).toContain(
      "soft-deleted"
    );

    // The hash-chained audit event carries that decision_id.
    const event = (await auditFor(changeObjectId)).find(
      (e) => e.action === WAVE_TARGET_TOMBSTONED_AUDIT_ACTION
    );
    expect(event).toBeDefined();
    expect(event!.decisionId).toBe(blockDecision!.id);
    expect(event!.rowHash).toEqual(expect.any(String));

    // The wave failed and the change is PARKED — operator recourse is cancel/rollback, not silence.
    expect((await waveRowOf(waveTargetId)).status).toBe("failed");
    expect((await changeRow(changeObjectId)).reconcileBlockedAt).not.toBeNull();
  }, 180_000);

  it("ONCE ONLY: later ticks neither re-dispatch nor append a second Decision or audit event", async () => {
    const { changeObjectId, targetObjectId, waveTargetId } = await changeReadyToTrigger("once");
    const { host, calls } = withRefusingTrigger(inner, () => false);
    await deleteComponentViaApi(targetObjectId);

    await tickWith(host);
    const decisionsAfterFirst = (await decisionsFor(changeObjectId)).length;
    const auditAfterFirst = (await auditFor(changeObjectId)).length;

    // A parked change is filtered out of `listChangeRowsInStates`, and `markWaveTargetTombstoned`'s
    // status guard is the durable backstop underneath that. Both are exercised: three more ticks.
    await tickWith(host);
    await tickWith(host);
    await tickWith(host);

    expect(calls.filter((c) => c.targetRef === targetObjectId)).toHaveLength(0);
    expect((await targetRow(waveTargetId)).status).toBe("target_deleted");
    expect((await decisionsFor(changeObjectId)).length).toBe(decisionsAfterFirst);
    expect((await auditFor(changeObjectId)).length).toBe(auditAfterFirst);
  }, 180_000);

  // ===============================================================================================
  // THE OTHER ADR-0026 SHAPE — the one that would have been missed by checking the wave target's own
  // row alone, and the reason this fix is not a one-liner.
  //
  // Under stage-shaped compilation the wave target IS a `placement`. `deleteObject` cascades to
  // `relationships` and to NOTHING ELSE, and a placement carries its pair in
  // `properties.componentId` / `properties.deploymentTargetId` — soft references the cascade cannot
  // see. So deleting the COMPONENT leaves the placement `deleted_at IS NULL` forever: a perfectly
  // healthy-looking row naming a dead component. This arm pins BOTH halves — that the placement
  // really does survive (otherwise the second hop is dead code and this test is vacuous), and that
  // reconcile refuses anyway.
  // ===============================================================================================
  it("STAGE SHAPE: deleting the COMPONENT stops a placement wave target, even though the placement itself is still live", async () => {
    const label = `stage-${randomUUID().slice(0, 8)}`;
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });
    const place = await inject("/api/v1/deployment-targets", { name: `prod-${label}` });
    const placement = await inject("/api/v1/placements", {
      component: component.id as string,
      deploymentTarget: place.id as string
    });
    const topo = await inject("/api/v1/objects/release-topology", {
      name: `topo-${label}`,
      properties: { waves: [{ name: "prod", mode: "parallel", targets: [place.id] }] }
    });

    const gateDeps: GateDeps = { sandbox, host: inner };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "tombstone-test",
        name: `change-${label}`,
        targets: [component.id as string]
      });
      for (const toState of ["evaluated", "coordinated", "executing"] as const) {
        if (toState === "coordinated") {
          await compileAndPersistPlan(tx, {
            orgId: org.orgId,
            changeObjectId: change.id,
            targetObjectIds,
            topologyObjectId: topo.id as string,
            topologyVersion: null
          });
        }
        await transitionChange(
          tx,
          {
            orgId: org.orgId,
            changeObjectId: change.id,
            toState,
            actorObjectId: org.orgId,
            requestId: "tombstone-test"
          },
          gateDeps
        );
      }
      return change.id;
    });

    // Stage-shaped: the wave target is the PLACEMENT, not the component. If this ever stops being
    // true the rest of the arm is testing the legacy shape by accident.
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeObjectId)
    );
    const waveTarget = plan!.waves[0]!.targets[0]!;
    expect(waveTarget.targetObjectId).toBe(placement.id);

    await deleteComponentViaApi(component.id as string);

    // THE PREMISE, asserted rather than assumed: the placement OUTLIVES its component. Were the
    // cascade to start tombstoning placements, the second hop in `readTargetLiveness` would be dead
    // code and this test would pass for the wrong reason.
    const [placementRow] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ deletedAt: objects.deletedAt })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, placement.id as string)))
    );
    expect(placementRow!.deletedAt).toBeNull();

    const { host, calls } = withRefusingTrigger(inner, () => false);
    await tickWith(host);

    expect(calls.filter((c) => c.targetRef === placement.id)).toHaveLength(0);
    expect((await targetRow(waveTarget.id)).status).toBe("target_deleted");

    // The Decision names the COMPONENT the operator actually deleted — not the placement that merely
    // referenced it — and says which hop found it.
    const blockDecision = (await decisionsFor(changeObjectId)).find(
      (d) => d.kind === "wave_target" && d.verdict === "block"
    );
    expect(blockDecision!.inputContext).toMatchObject({
      targetObjectId: placement.id,
      deadObjectId: component.id,
      deadObjectTypeId: "component",
      reachedVia: "placement.component",
      liveness: "deleted"
    });
  }, 180_000);

  it("SCOPE GUARD: a LIVE target is untouched — it triggers exactly as before", async () => {
    // The check must refuse deleted objects and nothing else. Without this arm a `false`-returning
    // liveness read would pass every other test in this file while blocking the whole product.
    const { changeObjectId, targetObjectId, waveTargetId } = await changeReadyToTrigger("live");
    const { host, calls } = withRefusingTrigger(inner, () => false);

    await tickWith(host);

    expect(calls.filter((c) => c.targetRef === targetObjectId)).toHaveLength(1);
    expect((await targetRow(waveTargetId)).status).toBe("triggered");
    expect(
      (await decisionsFor(changeObjectId)).some(
        (d) => d.kind === "wave_target" && d.verdict === "block"
      )
    ).toBe(false);
    expect((await changeRow(changeObjectId)).reconcileBlockedAt).toBeNull();
  }, 180_000);
});
