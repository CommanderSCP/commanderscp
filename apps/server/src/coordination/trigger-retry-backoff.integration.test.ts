import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost, withRefusingTrigger } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import { claimWaveTargetForTriggering } from "./wave-targets-repo.js";
import type { GateDeps } from "./gates.js";

/** THE MEASURED PRODUCTION STORM. See docs/coordination.md §1016. */
describe("trigger retry backoff: a refused trigger steps aside; a crashed one does not", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let inner: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "trigger-backoff");
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

  /** A change walked to `executing` with wave 0 pending and NO blocking policy — so the only thing
   *  standing between it and a trigger is the executor itself. */
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
        requestId: "backoff-test",
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
            requestId: "backoff-test"
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
        .select({
          status: changeWaveTargets.status,
          attempt: changeWaveTargets.attempt,
          updatedAt: changeWaveTargets.updatedAt
        })
        .from(changeWaveTargets)
        .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.id, waveTargetId)))
    );
    return row!;
  }

  it("a REFUSED trigger records the attempt and is NOT re-fired on the immediately following ticks", async () => {
    const { targetObjectId, waveTargetId } = await changeReadyToTrigger("refused");
    const { host, calls } = withRefusingTrigger(inner, (ref) => ref === targetObjectId);

    await tickWith(host);
    const mine = () => calls.filter((c) => c.targetRef === targetObjectId);

    // Fired once, was refused, and the refusal is now DURABLE on the row — this is the write that
    // did not exist before, and the reason the storm was possible.
    expect(mine()).toHaveLength(1);
    const after = await targetRow(waveTargetId);
    expect(after.attempt).toBe(1);
    expect(after.status).toBe("triggering");

    // Two more ticks back to back. attempt 1 => a 2s backoff, so neither may re-fire.
    await tickWith(host);
    await tickWith(host);
    expect(mine()).toHaveLength(1);
  }, 180_000);

  it("...and DOES re-fire once the backoff has elapsed — it steps aside, it does not give up", async () => {
    const { targetObjectId, waveTargetId } = await changeReadyToTrigger("elapsed");
    const { host, calls } = withRefusingTrigger(inner, (ref) => ref === targetObjectId);
    const mine = () => calls.filter((c) => c.targetRef === targetObjectId);

    await tickWith(host);
    expect(mine()).toHaveLength(1);

    // Backdate the row past the 2s window rather than sleeping — same condition the clock would
    // produce, without making the suite wait on wall time.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changeWaveTargets)
        .set({ updatedAt: new Date(Date.now() - 60_000) })
        .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.id, waveTargetId)))
    );

    await tickWith(host);
    expect(mine()).toHaveLength(2);
    // The backoff GROWS with each refusal (2s, 4s, 8s...), which is what makes a permanently
    // refusing executor cheap instead of a hot loop.
    expect((await targetRow(waveTargetId)).attempt).toBe(2);
  }, 180_000);

  it("a target reset to 'pending' for a fresh re-trigger is NOT delayed, even though its `attempt` is non-zero", async () => {
    // Found by this change breaking a sibling suite. See docs/coordination.md §1017.
    const { targetObjectId, waveTargetId } = await changeReadyToTrigger("repending");
    const permissive = withRefusingTrigger(inner, () => false);

    await tickWith(permissive.host);
    const succeeded = await targetRow(waveTargetId);
    expect(succeeded.status).toBe("triggered");
    expect(succeeded.attempt).toBe(1); // set by SUCCESS, not by any failure

    // Put it back the way a forced re-trigger does — status only, attempt left as-is, updated_at
    // fresh (so an attempt-keyed backoff would definitely bite).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changeWaveTargets)
        .set({
          status: "pending",
          executorPluginId: null,
          executorRef: null,
          updatedAt: new Date()
        })
        .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.id, waveTargetId)))
    );

    const before = permissive.calls.filter((c) => c.targetRef === targetObjectId).length;
    await tickWith(permissive.host);
    // Re-fired on the very next tick, with no delay.
    expect(permissive.calls.filter((c) => c.targetRef === targetObjectId)).toHaveLength(before + 1);
    expect((await targetRow(waveTargetId)).status).toBe("triggered");
  }, 180_000);

  it("CONTRACT PRESERVED: a target abandoned mid-claim (attempt 0) is still retried on the very next tick, with no delay", async () => {
    // The crash case the repo documents and the suites exercise. See docs/coordination.md §1018.
    const { targetObjectId, waveTargetId } = await changeReadyToTrigger("abandoned");
    const claimed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      claimWaveTargetForTriggering(tx, org.orgId, waveTargetId)
    );
    expect(claimed).toBe(true);

    const before = await targetRow(waveTargetId);
    expect(before.status).toBe("triggering");
    expect(before.attempt).toBe(0);

    // A non-refusing host: the retry should go through immediately and succeed.
    const { host, calls } = withRefusingTrigger(inner, () => false);
    await tickWith(host);

    expect(calls.filter((c) => c.targetRef === targetObjectId)).toHaveLength(1);
    expect((await targetRow(waveTargetId)).status).toBe("triggered");
  }, 180_000);
});
