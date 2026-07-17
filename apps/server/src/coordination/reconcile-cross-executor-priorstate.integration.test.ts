import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";

/**
 * Regression: the forward-trigger "prior known-good state" snapshot (reconcile.ts's `sync` branch)
 * and the rollback prior-state lookup must only ever consider a prior SUCCEEDED execution that ran
 * on the SAME executor plugin instance as the current trigger.
 *
 * The bug: `findLatestSucceededExecution` returned a target's most recent succeeded execution
 * REGARDLESS of which executor ran it, and the caller then passed that (possibly FOREIGN) executor
 * ref to the CURRENT trigger's `client.status()`. In production this wedged a wave forever: a
 * component whose latest succeeded run was an infra push that fell back to the fake-executor, then
 * driven by a real argocd software promotion, called argocd `status()` with the fake ref — argocd
 * `GET /applications/<uuid>` → 403 → the trigger tx threw, the target never triggered, and every
 * reconcile tick re-threw the same 403.
 *
 * These tests drive the real reconcile loop against the real fake-executor subprocess host. The
 * fake-executor is deliberately forgiving (an unknown/foreign ref yields phase `pending` with NO
 * `stateRef`, never a throw), which makes the seam observable WITHOUT reproducing the argocd 403:
 * if the current trigger consults a foreign row, the snapshot comes back empty (priorStateRef
 * null); if it correctly consults the SAME-executor prior run, the snapshot carries that run's
 * versioned `stateRef`. The first test pins exactly that difference.
 */
describe("reconcile: prior-state snapshot is scoped to the current executor instance", () => {
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
    org = await createTestOrg(server, "xexec-priorstate");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function proposeAndPromote(name: string, targetId: string): Promise<void> {
    const change = await admin.changes.propose({ name, targets: [targetId] });
    await waitUntil(async () => (await admin.changes.get(change.id)).state === "validating" || undefined, {
      describe: `change ${change.id} (${name}) reaches 'validating'`,
      timeoutMs: 20_000
    });
    await admin.changes.promote(change.id);
  }

  it("snapshots prior state from the SAME-executor succeeded run, not a newer FOREIGN-executor one", async () => {
    // No binding => every trigger flows through the shared default fake-executor instance.
    const comp = await createTestComponent(admin, { name: `xexec-comp-${uuidv7().slice(0, 8)}` });

    // change #1: the target's first trigger on the shared fake-executor — brings it to version v0
    // and records a SUCCEEDED wave target under executor_plugin_id = "fake-executor".
    await proposeAndPromote("change 1", comp.id);

    const change1Target = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.targetObjectId, comp.id)))
        .orderBy(desc(changeWaveTargets.createdAt))
        .limit(1)
    );
    expect(change1Target[0]!.status).toBe("succeeded");
    expect(change1Target[0]!.executorPluginId).toBe("fake-executor");
    const change1WaveId = change1Target[0]!.waveId;

    // Poison: inject a MORE-RECENT succeeded wave target for the SAME component that ran under a
    // DIFFERENT executor (a foreign argocd instance), carrying a ref only that executor could
    // interpret. This is the row `findLatestSucceededExecution` used to pick (newest by updatedAt)
    // regardless of executor. Attached to change #1's real wave/plan so it satisfies the repo's
    // wave/plan inner joins.
    const foreignTargetId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeWaveTargets).values({
        id: foreignTargetId,
        orgId: org.orgId,
        waveId: change1WaveId,
        targetObjectId: comp.id,
        executorPluginId: "argocd-homelab-foreign",
        executorRef: { externalId: `foreign-app::${uuidv7()}`, url: "argocd://homelab/foreign-app" },
        priorStateRef: "foreign-state",
        status: "succeeded",
        // Strictly newer than change #1 so the pre-fix (unscoped) query would prefer it.
        updatedAt: new Date(Date.now() + 3_600_000)
      })
    );

    const preChange2Ids = new Set(
      (
        await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select({ id: changeWaveTargets.id })
            .from(changeWaveTargets)
            .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.targetObjectId, comp.id)))
        )
      ).map((r) => r.id)
    );

    // change #2: a second trigger of the SAME component on the shared fake-executor. Its snapshot
    // must come from change #1's SAME-executor run (stateRef "v0"), NOT the newer foreign row.
    await proposeAndPromote("change 2", comp.id);

    const change2Target = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.targetObjectId, comp.id)))
        );
        const fresh = rows.find((r) => !preChange2Ids.has(r.id));
        return fresh && fresh.executorRef ? fresh : undefined;
      },
      { describe: `change2 wave target for ${comp.id} is triggered`, timeoutMs: 20_000 }
    );

    expect(change2Target.executorPluginId).toBe("fake-executor");
    // The crux: the snapshot used change #1's SAME-executor ref (fake-executor reported "v0"),
    // proving the trigger did NOT call status() with the newer foreign argocd ref.
    //   - pre-fix: the foreign row was selected; fake-executor.status(foreignRef) => pending, no
    //     stateRef => priorStateRef === null (assertion fails).
    //   - post-fix: change #1's fake-executor row is selected => stateRef "v0".
    expect(change2Target.priorStateRef).toBe("v0");
    expect(change2Target.priorStateRef).not.toBe("foreign-state");
  });

  it("a foreign-executor succeeded run this executor can't interpret does not wedge the trigger", async () => {
    // A component whose ONLY prior succeeded execution ran on a foreign executor, carrying a ref
    // this executor cannot interpret. Post-fix the foreign row is invisible to the same-executor
    // lookup, so no status() call is made against it and the target triggers normally. Pre-fix the
    // foreign ref was handed to the current executor's status(); with a ref shaped like one that
    // executor rejects, that call threw inside the trigger tx and wedged the wave forever.
    const comp = await createTestComponent(admin, { name: `xexec-wedge-${uuidv7().slice(0, 8)}` });

    // Borrow an existing real wave/plan so the injected foreign row satisfies the repo joins.
    const anchor = await createTestComponent(admin, { name: `xexec-anchor-${uuidv7().slice(0, 8)}` });
    await proposeAndPromote("anchor change", anchor.id);
    const anchorTarget = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.targetObjectId, anchor.id)))
        .limit(1)
    );
    const anchorWaveId = anchorTarget[0]!.waveId;

    // Foreign succeeded run for `comp` with a ref the current (fake-)executor rejects (a non-string
    // externalId makes fake-executor's `status()` throw, standing in for argocd's 403 on a foreign
    // appName). Recorded under a foreign executor_plugin_id so the same-executor lookup skips it.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeWaveTargets).values({
        id: uuidv7(),
        orgId: org.orgId,
        waveId: anchorWaveId,
        targetObjectId: comp.id,
        executorPluginId: "argocd-homelab-foreign",
        executorRef: { externalId: 1234567 as unknown as string, url: "argocd://homelab/poison" },
        priorStateRef: "foreign-state",
        status: "succeeded",
        updatedAt: new Date(Date.now() + 3_600_000)
      })
    );

    // Drive a fresh trigger of `comp` on the shared fake-executor. It must reach a terminal state
    // (no wedge) with a null prior-state snapshot (there is no SAME-executor prior run).
    const change = await admin.changes.propose({ name: "post-poison change", targets: [comp.id] });
    await waitUntil(async () => (await admin.changes.get(change.id)).state === "validating" || undefined, {
      describe: `post-poison change ${change.id} reaches 'validating' (not wedged)`,
      timeoutMs: 20_000
    });

    const triggered = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            eq(changeWaveTargets.targetObjectId, comp.id),
            eq(changeWaveTargets.executorPluginId, "fake-executor")
          )
        )
        .limit(1)
    );
    expect(triggered[0]!.status).toBe("succeeded");
    expect(triggered[0]!.priorStateRef).toBeNull();
  });
});
