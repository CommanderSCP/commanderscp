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

/**
 * THE MEASURED PRODUCTION STORM (live homelab k3s, 2026-08-01, in the 15 minutes after the
 * executing-batch starvation fix let the engine reach its backlog again):
 *
 *     19 x "argocd trigger: sync returned HTTP 400"
 *     12 x "argocd: sync triggered"
 *
 * — and every single 400 was the SAME target. Argo CD refuses a sync while an operation is already
 * running on that Application, and a real backlog fans many changes onto a handful of Argo apps, so
 * losing that race is the NORMAL case, not an error.
 *
 * Before this fix a refused trigger left the row `triggering` with `attempt` still 0 (only
 * `markWaveTargetTriggered` ever wrote `attempt`, and only on SUCCESS), so the next tick — one
 * second later — re-claimed and re-fired it. Forever. That burned executor capacity on requests
 * guaranteed to fail and buried genuine failures under repeated noise.
 *
 * THE DISTINCTION THIS SUITE EXISTS TO PROTECT. Two faults reach the same code path and must be
 * treated OPPOSITELY:
 *
 *   - a CRASH between claiming a target and recording the outcome leaves `attempt` at 0, and
 *     `wave-targets-repo.ts`'s crash-recovery contract requires it to be retried on the VERY NEXT
 *     tick with no time budget (several M3 suites depend on exactly that);
 *   - a REFUSAL means the executor was reached and said no, and must be backed off.
 *
 * `attempt` is the discriminator, which is why it is written on the failure path and nowhere else.
 * Collapse the two and you either re-introduce the storm or break crash recovery.
 */
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
    // FOUND BY THIS CHANGE BREAKING wave-target-type.integration.test.ts, and pinned here because
    // the cause is a genuine trap: `attempt` is NOT a pure failure counter — `markWaveTargetTriggered`
    // also sets it to 1 on SUCCESS. So a target deliberately put back to `pending` to force a fresh
    // re-trigger still carries `attempt: 1` from its successful run. A backoff keyed on the COUNT
    // alone would silently delay a re-trigger that nothing had ever refused.
    //
    // The gate is therefore keyed on `status === 'triggering'` — the only state that means "handed
    // to the executor and not recorded as succeeded". This arm fails if anyone simplifies it back
    // to an attempt-only check.
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
    // This is the crash case `wave-targets-repo.ts` documents and the M3 suites exercise: a tick
    // died after `claimWaveTargetForTriggering` and before recording anything, so the row sits in
    // `triggering` with `attempt` still 0. Simulated exactly — claim it, then do nothing.
    //
    // If the backoff were keyed on `status`/`updated_at` alone rather than on `attempt`, THIS is
    // the test that would fail: the claim itself stamps `updated_at`, so a freshly abandoned row
    // would look "recently attempted" and be made to wait, breaking crash recovery.
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
