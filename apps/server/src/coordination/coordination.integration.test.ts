import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ExecutionStatus, ExternalRunRef } from "@scp/plugin-api";
import {
  buildTestServer,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";
import { SubprocessPluginHost } from "../plugin-host/host.js";
import { startReconcileLoop } from "./reconcile.js";
import { startPgBoss } from "../events/pgboss.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID, DEFAULT_EXECUTOR_MODULE } from "./executor-config.js";
import { runWatchdogSweep } from "./watchdog.js";

/**
 * The M3 coordination-engine end-to-end suite (BUILD_AND_TEST.md §8 M3 DoD): full fake-executor
 * loop, rollback restoring prior state, crash-resumption (both "the worker" and "the plugin
 * subprocess"), and the watchdog. Real Postgres (Testcontainers, global-setup.ts), a REAL
 * subprocess plugin host (actual child `node` processes running `@scp/plugin-fake-executor`),
 * never mocked.
 */
describe("coordination engine: full fake-executor loop", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      // Fast enough that `autoSucceedAfterMs` (50ms, harness.ts default) resolves within a
      // couple of 1s reconcile ticks, but generous enough that a loaded CI box's occasional slow
      // tick doesn't spuriously time out a call.
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    org = await createTestOrg(server, "coordination");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  it("propose -> evaluate -> coordinate -> execute -> validate -> promote, waves ordered by depends_on, every transition has a Decision", async () => {
    const infra = await admin.components.create({ name: "coord-infra" });
    const app = await admin.components.create({ name: "coord-app" });
    await admin.components.addDependsOn(app.id, infra.id); // app depends_on infra

    const change = await admin.changes.propose({
      name: "roll out coord-app",
      targets: [app.id, infra.id]
    });
    expect(change.state).toBe("proposed");

    const validating = await waitUntil(
      async () => {
        const c = await admin.changes.get(change.id);
        return c.state === "validating" ? c : undefined;
      },
      { describe: `change ${change.id} reaches 'validating'`, timeoutMs: 20_000 }
    );
    expect(validating.state).toBe("validating");

    const explained = await admin.changes.explain(change.id);
    expect(explained.plan).not.toBeNull();
    const waves = explained.plan!.waves;
    expect(waves).toHaveLength(2); // infra first (no deps), then app (depends_on infra)
    expect(waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([infra.id]);
    expect(waves[1]!.targets.map((t) => t.targetObjectId)).toEqual([app.id]);
    for (const wave of waves) {
      expect(wave.status).toBe("succeeded");
      for (const target of wave.targets) expect(target.status).toBe("succeeded");
    }

    // Every transition (propose/evaluate/coordinate/execute/validate) plus the wave-boundary
    // gate checks wrote exactly one Decision each (DESIGN §10.4) — `scp change explain` (and
    // this same API response) is how a human reconstructs that chain.
    const transitionDecisions = explained.decisions.filter((d) => d.kind === "transition");
    expect(transitionDecisions.length).toBeGreaterThanOrEqual(5);
    expect(transitionDecisions.every((d) => d.verdict === "allow")).toBe(true);
    const gateDecisions = explained.decisions.filter((d) => d.kind === "gate");
    expect(gateDecisions.length).toBeGreaterThanOrEqual(2); // one per wave boundary

    const promoted = await admin.changes.promote(change.id);
    expect(promoted.state).toBe("promoted");

    const finalExplain = await admin.changes.explain(change.id);
    expect(finalExplain.decisions.some((d) => d.kind === "transition" && d.verdict === "allow")).toBe(
      true
    );
  });

  it("rollback is its own Change, executed through the same plan/wave machinery, and restores the prior known-good executor state", async () => {
    const target = await admin.components.create({ name: "coord-rollback-target" });

    // Change #1: the target's first-ever change — brings the fake executor's internal version to v0.
    const change1 = await admin.changes.propose({ name: "change 1", targets: [target.id] });
    await waitUntil(async () => (await admin.changes.get(change1.id)).state === "validating" || undefined, {
      describe: `change1 ${change1.id} reaches 'validating'`
    });
    await admin.changes.promote(change1.id);

    // Change #2: a second change against the SAME target — bumps the fake executor to v1. Its
    // wave target captures `priorStateRef` = "v0" (what change1 left behind) BEFORE triggering.
    const change2 = await admin.changes.propose({ name: "change 2", targets: [target.id] });
    await waitUntil(async () => (await admin.changes.get(change2.id)).state === "validating" || undefined, {
      describe: `change2 ${change2.id} reaches 'validating'`
    });
    await admin.changes.promote(change2.id);

    const decision = await admin.changes.rollback(change2.id, "integration test: undo change 2");
    expect(decision.rollbackOfObjectId).toBe(change2.id);
    expect(decision.state).toBe("proposed");

    // Rollback changes auto-promote (no human validation gate — coordination/reconcile.ts's
    // `completeExecution` doc comment) and, on their own promotion, transition the ORIGINAL back
    // to `rolled_back` in the same transaction.
    const rolledBack = await waitUntil(
      async () => {
        const c = await admin.changes.get(change2.id);
        return c.state === "rolled_back" ? c : undefined;
      },
      { describe: `original change2 ${change2.id} reaches 'rolled_back'`, timeoutMs: 20_000 }
    );
    expect(rolledBack.state).toBe("rolled_back");

    const rollbackExplain = await waitUntil(
      async () => {
        const e = await admin.changes.explain(decision.id);
        return e.change.state === "promoted" ? e : undefined;
      },
      { describe: `rollback change ${decision.id} reaches 'promoted'`, timeoutMs: 20_000 }
    );
    const rollbackTarget = rollbackExplain.plan!.waves[0]!.targets[0]!;
    expect(rollbackTarget.status).toBe("succeeded");

    // The rollback trigger Decision names its trigger (DESIGN §9.4: "every rollback writes a
    // Decision record naming its trigger") — written against the ORIGINAL change's subject id.
    const originalExplain = await admin.changes.explain(change2.id);
    const rollbackTriggerDecision = originalExplain.decisions.find((d) => d.kind === "rollback_trigger");
    expect(rollbackTriggerDecision).toBeDefined();
    expect(rollbackTriggerDecision!.verdict).toBe("rollback");
    expect(rollbackTriggerDecision!.inputContext["trigger"]).toBe("manual");

    // Verify the ACTUAL executor state, not just the engine's bookkeeping: ask the fake executor
    // directly what it thinks target's current state is, using the rollback's own persisted
    // executorRef — it must report "v0" (change1's version), not "v1" (change2's, now
    // superseded) or a fresh "v2" — proving the rollback genuinely restored the prior known-good
    // state rather than just re-running a forward trigger.
    const ref = rollbackTarget.executorRef as unknown as ExternalRunRef;
    const liveStatus: ExecutionStatus = await server.pluginHost!.executor(DEFAULT_EXECUTOR_INSTANCE_ID).status(
      ref
    );
    expect(liveStatus.stateRef).toBe("v0");
  });
});

describe("coordination engine: watchdog", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "watchdog");
  });

  afterAll(async () => {
    await server.close();
  });

  it("flags a change that has shown no progress within its per-state SLA, writing a Decision", async () => {
    const target = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { proposeChange } = await import("./changes-repo.js");
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "watchdog-test",
        name: "will stall",
        targets: [org.orgId] // any live object id — the org root itself is fine, this change is never executed
      });
      return change;
    });
    expect(target.state).toBe("proposed");

    // `runWatchdogSweep`'s `opts.now` lets the test simulate the passage of time without a real
    // sleep — `proposed`'s SLA is 5 minutes (coordination/watchdog.ts's `WATCHDOG_SLA_MS`).
    const farFuture = new Date(Date.now() + 10 * 60_000);
    const flags = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      runWatchdogSweep(tx, org.orgId, { requestId: "watchdog-test-sweep", now: farFuture })
    );

    const flagged = flags.find((f) => f.changeObjectId === target.id);
    expect(flagged).toBeDefined();
    expect(flagged!.state).toBe("proposed");

    const decision = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { getDecision } = await import("./decisions-repo.js");
      return getDecision(tx, org.orgId, flagged!.decisionId);
    });
    expect(decision.kind).toBe("watchdog");
    expect(decision.verdict).toBe("warn");

    // Idempotent per state-entry: a second sweep at the same (or later) `now` does NOT re-flag —
    // `watchdog_flagged_at` guards it (coordination/watchdog.ts's module doc).
    const secondSweep = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      runWatchdogSweep(tx, org.orgId, { requestId: "watchdog-test-sweep-2", now: farFuture })
    );
    expect(secondSweep.some((f) => f.changeObjectId === target.id)).toBe(false);
  });
});

describe("coordination engine: crash resumption", () => {
  it("kills the worker (reconcile loop + plugin host) mid-wave — a freshly started worker resumes purely from Postgres state, with no shared in-memory handoff", async () => {
    const server = await buildTestServer();
    const org = await createTestOrg(server, "kill-worker");
    const stateDir = await mkdtemp(join(tmpdir(), "scp-kill-worker-test-"));
    const statePath = join(stateDir, "fake-executor-state.json");

    try {
      const createTarget = await server.app.inject({
        method: "POST",
        url: "/api/v1/components",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "kill-worker-target" }
      });
      expect(createTarget.statusCode).toBe(201);
      const targetObjectId = createTarget.json().id as string;

      const propose = await server.app.inject({
        method: "POST",
        url: "/api/v1/changes",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "kill-worker change", targets: [targetObjectId] }
      });
      expect(propose.statusCode).toBe(201);
      const changeId = propose.json().id as string;

      // "Worker" #1 — long autoSucceedAfterMs (2s) so the test can reliably observe the wave
      // target mid-flight (triggered, not yet succeeded) before killing everything.
      const boss1 = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
      const host1 = new SubprocessPluginHost({ callTimeoutMs: 5_000 });
      await host1.start([
        {
          id: DEFAULT_EXECUTOR_INSTANCE_ID,
          module: DEFAULT_EXECUTOR_MODULE,
          orgId: "shared",
          domainId: "shared",
          config: { statePath, autoSucceedAfterMs: 2_000 }
        }
      ]);
      const loop1 = await startReconcileLoop(boss1, server.deps.db, host1);

      await waitUntil(
        async () => {
          const targets = await withTenantTx(server.deps.db, org.orgId, (tx) =>
            tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, targetObjectId))
          );
          const t = targets[0];
          return t && (t.status === "triggered" || t.status === "observing") ? t : undefined;
        },
        { describe: "wave target reaches triggered/observing (mid-wave)", timeoutMs: 10_000 }
      );

      // Simulate a full worker crash: nothing resumes this change until a NEW worker starts.
      await loop1.stop();
      await host1.stop();
      await boss1.stop({ graceful: false, timeout: 500 }).catch(() => undefined);

      // "Worker" #2 — a BRAND NEW reconcile loop + plugin host, sharing nothing in memory with
      // worker #1 (fresh instances, this process never held any per-change state to begin with —
      // `coordination/reconcile.ts`'s whole design). The SAME `statePath` is what lets the fake
      // executor (standing in for a real external system, which of course doesn't forget a
      // deployment because SCP's worker restarted) answer correctly for the ref worker #1 left
      // in flight.
      const boss2 = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
      const host2 = new SubprocessPluginHost({ callTimeoutMs: 5_000 });
      await host2.start([
        {
          id: DEFAULT_EXECUTOR_INSTANCE_ID,
          module: DEFAULT_EXECUTOR_MODULE,
          orgId: "shared",
          domainId: "shared",
          config: { statePath, autoSucceedAfterMs: 50 }
        }
      ]);
      const loop2 = await startReconcileLoop(boss2, server.deps.db, host2);

      try {
        await waitUntil(
          async () => {
            const get = await server.app.inject({
              method: "GET",
              url: `/api/v1/changes/${changeId}`,
              headers: { authorization: `Bearer ${org.adminToken}` }
            });
            return get.json().state === "validating" ? get.json() : undefined;
          },
          { describe: `change ${changeId} reaches 'validating' after worker restart`, timeoutMs: 15_000 }
        );

        const promote = await server.app.inject({
          method: "POST",
          url: `/api/v1/changes/${changeId}/promote`,
          headers: { authorization: `Bearer ${org.adminToken}` },
          payload: {}
        });
        expect(promote.statusCode).toBe(200);
        expect(promote.json().state).toBe("promoted");
      } finally {
        await loop2.stop();
        await host2.stop();
        await boss2.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      }
    } finally {
      await server.close();
    }
  });
});
