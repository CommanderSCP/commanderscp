import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { mkdtempTracked } from "@scp/test-tmpdir";
import type { ExecutionStatus, ExternalRunRef } from "@scp/plugin-api";
import {
  createTestComponent,
  buildTestServer,
  createTestOrg,
  listenTestServer,
  RawScpPgBossClient,
  waitUntil,
  type ListeningTestServer,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { v7 as uuidv7 } from "uuid";
import {
  changes,
  changeSourceEvents,
  changeWaveTargets,
  decisions,
  objects
} from "../db/schema.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { createObject } from "../graph/objects-repo.js";
import { SubprocessPluginHost } from "../plugin-host/host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { RECONCILE_QUEUE, reconcileOrgTick, startReconcileLoop } from "./reconcile.js";
import { startPgBoss } from "../events/pgboss.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID, DEFAULT_EXECUTOR_MODULE } from "./executor-config.js";
import { runWatchdogSweep, WATCHDOG_SLA_MS } from "./watchdog.js";
import { markChangeReconcileBlocked, proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { markWaveTerminal } from "./wave-targets-repo.js";
import { tryAcquireTriggerClaimLock } from "./trigger-claim-lock.js";
import {
  createInMemoryFakeHost,
  withFailOnceAfterRealTrigger
} from "./test-support/fake-plugin-host.js";

/** The M3 coordination-engine end-to-end suite. See docs/coordination.md §343. */

/** These blocks create components through raw inject. See docs/coordination.md §344. */
async function createComponentViaInject(
  server: { app: { inject: (o: unknown) => Promise<{ json: () => { id: string } }> } },
  org: TestOrg,
  name: string
): Promise<string> {
  const svc = await server.app.inject({
    method: "POST",
    url: "/api/v1/services",
    headers: { authorization: `Bearer ${org.adminToken}` },
    payload: { name: `svc-${name}` }
  });
  const serviceId = svc.json().id;
  const comp = await server.app.inject({
    method: "POST",
    url: "/api/v1/components",
    headers: { authorization: `Bearer ${org.adminToken}` },
    payload: { name, service: serviceId }
  });
  return comp.json().id;
}

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
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "coordination");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  it("propose -> evaluate -> coordinate -> execute -> validate -> accept, waves ordered by depends_on, every transition has a Decision", async () => {
    const infra = await createTestComponent(admin, { name: "coord-infra" });
    const app = await createTestComponent(admin, { name: "coord-app" });
    await admin.components.addDependsOn(app.id, infra.id);

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
    expect(waves).toHaveLength(2);
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
    expect(gateDecisions.length).toBeGreaterThanOrEqual(2);

    const accepted = await admin.changes.accept(change.id);
    expect(accepted.state).toBe("accepted");

    const finalExplain = await admin.changes.explain(change.id);
    expect(
      finalExplain.decisions.some((d) => d.kind === "transition" && d.verdict === "allow")
    ).toBe(true);
  });

  it("persists the REAL synced revision reconcile observes from status().stateRef, surfaced as the wave target's observed revision (P4B increment 2, ADR-0008 decision 1)", async () => {
    // A fresh target's first change drives the fake to v0. See docs/coordination.md §345.
    const comp = await createTestComponent(admin, { name: `observed-rev-${uuidv7().slice(0, 8)}` });

    const change = await admin.changes.propose({
      name: "observe the synced revision",
      targets: [comp.id]
    });
    expect(change.state).toBe("proposed");

    // Drive to the succeeded wave target through the same plan read model the UI/CLI consume.
    const explained = await waitUntil(
      async () => {
        const e = await admin.changes.explain(change.id);
        const t = e.plan?.waves[0]?.targets.find((x) => x.targetObjectId === comp.id);
        return t && t.status === "succeeded" ? e : undefined;
      },
      { describe: `wave target for ${comp.id} reaches 'succeeded'`, timeoutMs: 20_000 }
    );
    const target = explained.plan!.waves[0]!.targets.find((x) => x.targetObjectId === comp.id)!;

    // The persisted, surfaced revision — the stateRef reconcile previously threw away.
    expect(target.observed).not.toBeNull();
    expect(target.observed!.revision).toBe("v0");

    // Prove it is the ACTUAL executor-reported revision, not a hardcoded constant: ask the fake
    // executor directly, using the target's own persisted executorRef, what stateRef it reports —
    // the persisted `observed.revision` must equal it byte-for-byte.
    const ref = target.executorRef as unknown as ExternalRunRef;
    const liveStatus: ExecutionStatus = await server
      .pluginHost!.executor(DEFAULT_EXECUTOR_INSTANCE_ID)
      .status(ref);
    expect(liveStatus.stateRef).toBe(target.observed!.revision);

    // And durably persisted on the row itself (observed_state jsonb), not just synthesized by the
    // read-model mapper.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.id, target.id))
    );
    expect((rows[0]!.observedState as { revision?: string } | null)?.revision).toBe("v0");

    // AND THE PAYLOAD DATES ITSELF. See docs/coordination.md §346.
    const persistedAt = (rows[0]!.observedState as { observedAt?: string }).observedAt;
    expect(persistedAt).toBeDefined();
    expect(Date.parse(persistedAt!)).toBeGreaterThan(Date.now() - 60_000);
    // Not surfaced on the wire: `ChangeWaveTargetSchema.observed` does not declare it, and the
    // response serializer key-strips what the schema does not name.
    expect(target.observed as Record<string, unknown>).not.toHaveProperty("observedAt");
  });

  it("reconcile passes the binding's externalRef (e.g. an Argo CD Application name) as trigger().targetRef — NOT the graph object id (M12 P1)", async () => {
    // This is the Mode A / import fix: a graph object whose SCP id differs from its external name
    // must trigger the EXTERNAL resource, not a resource named after its UUID. The fake-executor
    // mints its externalId as `${targetRef}<delim>${uuid}` (mintExternalId), so the externalId that
    // lands on the wave target reveals exactly which targetRef reconcile used.
    const externalName = `imported-app-${uuidv7().slice(0, 8)}`;
    const comp = await createTestComponent(admin, { name: `ext-ref-${uuidv7().slice(0, 8)}` });
    await admin.executors.putBinding(comp.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `ext-ref-inst-${uuidv7().slice(0, 8)}`,
      externalRef: externalName
    });

    const change = await admin.changes.propose({
      name: "coordinate an imported app",
      targets: [comp.id]
    });
    expect(change.state).toBe("proposed");

    const target = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, comp.id))
        );
        return rows[0]?.executorRef ? rows[0] : undefined;
      },
      { describe: `wave target for ${comp.id} records an executorRef`, timeoutMs: 20_000 }
    );

    const ref = target.executorRef as unknown as ExternalRunRef;
    // The trigger targeted the external name, so the minted externalId starts with it — and NOT
    // with the graph object's UUID (the pre-M12 behavior that would 404 against a real Argo CD).
    expect(ref.externalId.startsWith(externalName)).toBe(true);
    expect(ref.externalId.startsWith(comp.id)).toBe(false);
  });

  it("an execution-system-backed binding resolves the plugin from the system + drives the trigger end-to-end (M12 P2)", async () => {
    // Register the execution system once; a component bound to it must resolve the module/config
    // FROM the system at dispatch (resolveExecutorPluginInstance's system branch) and trigger the
    // external target — proving Mode A coordination works without inline per-binding config.
    await admin.secrets.put("sys-token", { value: "a-token" });
    const sys = await admin.object("execution-system").create({
      name: `exec-sys-${uuidv7().slice(0, 8)}`,
      properties: {
        kind: "fake-executor",
        serverUrl: "https://exec.example",
        tokenSecretKey: "sys-token"
      }
    });
    const externalName = `sys-app-${uuidv7().slice(0, 8)}`;
    const comp = await createTestComponent(admin, { name: `sys-comp-${uuidv7().slice(0, 8)}` });
    const binding = await admin.executors.putBinding(comp.id, {
      executionSystemId: sys.id,
      externalRef: externalName
    });
    expect(binding.pluginInstanceId).toBe(`execution-system:${sys.id}`);

    const change = await admin.changes.propose({
      name: "coordinate via execution-system",
      targets: [comp.id]
    });
    expect(change.state).toBe("proposed");

    const target = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, comp.id))
        );
        return rows[0]?.executorRef ? rows[0] : undefined;
      },
      { describe: `wave target for ${comp.id} records an executorRef`, timeoutMs: 20_000 }
    );
    // Dispatched through the system-resolved fake-executor instance, targeting the external name.
    const ref = target.executorRef as unknown as ExternalRunRef;
    expect(ref.externalId.startsWith(externalName)).toBe(true);
  });

  it("rollback is its own Change, executed through the same plan/wave machinery, and restores the prior known-good executor state", async () => {
    const target = await createTestComponent(admin, { name: "coord-rollback-target" });

    // Change #1: the target's first-ever change — brings the fake executor's internal version to v0.
    const change1 = await admin.changes.propose({ name: "change 1", targets: [target.id] });
    await waitUntil(
      async () => (await admin.changes.get(change1.id)).state === "validating" || undefined,
      {
        describe: `change1 ${change1.id} reaches 'validating'`
      }
    );
    await admin.changes.accept(change1.id);

    // Change #2: a second change against the SAME target — bumps the fake executor to v1. Its
    // wave target captures `priorStateRef` = "v0" (what change1 left behind) BEFORE triggering.
    const change2 = await admin.changes.propose({ name: "change 2", targets: [target.id] });
    await waitUntil(
      async () => (await admin.changes.get(change2.id)).state === "validating" || undefined,
      {
        describe: `change2 ${change2.id} reaches 'validating'`
      }
    );
    await admin.changes.accept(change2.id);

    const decision = await admin.changes.rollback(change2.id, "integration test: undo change 2");
    expect(decision.rollbackOfObjectId).toBe(change2.id);
    expect(decision.state).toBe("proposed");

    // Rollback changes auto-accept (no human validation gate — coordination/reconcile.ts's
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
        return e.change.state === "accepted" ? e : undefined;
      },
      { describe: `rollback change ${decision.id} reaches 'accepted'`, timeoutMs: 20_000 }
    );
    const rollbackTarget = rollbackExplain.plan!.waves[0]!.targets[0]!;
    expect(rollbackTarget.status).toBe("succeeded");

    // The rollback trigger Decision names its trigger (DESIGN §9.4: "every rollback writes a
    // Decision record naming its trigger") — written against the ORIGINAL change's subject id.
    const originalExplain = await admin.changes.explain(change2.id);
    const rollbackTriggerDecision = originalExplain.decisions.find(
      (d) => d.kind === "rollback_trigger"
    );
    expect(rollbackTriggerDecision).toBeDefined();
    expect(rollbackTriggerDecision!.verdict).toBe("rollback");
    expect(rollbackTriggerDecision!.inputContext["trigger"]).toBe("manual");

    // Verify the actual executor state, not the bookkeeping. See docs/coordination.md §347.
    const ref = rollbackTarget.executorRef as unknown as ExternalRunRef;
    const liveStatus: ExecutionStatus = await server
      .pluginHost!.executor(DEFAULT_EXECUTOR_INSTANCE_ID)
      .status(ref);
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
    const watchdogHost = createInMemoryFakeHost();
    // `runWatchdogSweep` manages its own per-row short transactions (§7.1 item 3) — no outer
    // `withTenantTx` wraps it any more.
    const flags = await runWatchdogSweep(
      server.deps.db,
      org.orgId,
      watchdogHost,
      server.deps.config.secretsMasterKey,
      {
        requestId: "watchdog-test-sweep",
        now: farFuture
      }
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
    const secondSweep = await runWatchdogSweep(
      server.deps.db,
      org.orgId,
      watchdogHost,
      server.deps.config.secretsMasterKey,
      {
        requestId: "watchdog-test-sweep-2",
        now: farFuture
      }
    );
    expect(secondSweep.some((f) => f.changeObjectId === target.id)).toBe(false);
  });
});

describe("coordination engine: crash resumption", () => {
  /** MAJOR #7 fix. See docs/coordination.md §348. */
  it("kills the worker (reconcile loop + plugin host) mid-wave, via a real fault injected between trigger() firing and its result-commit — a freshly started worker resumes purely from Postgres state, with no duplicate trigger and no shared in-memory handoff", async () => {
    const server = await buildTestServer();
    const org = await createTestOrg(server, "kill-worker");
    const stateDir = await mkdtempTracked(join(tmpdir(), "scp-kill-worker-test-"));
    const statePath = join(stateDir, "fake-executor-state.json");

    try {
      const targetObjectId = await createComponentViaInject(server, org, "kill-worker-target");

      const propose = await server.app.inject({
        method: "POST",
        url: "/api/v1/changes",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "kill-worker change", targets: [targetObjectId] }
      });
      expect(propose.statusCode).toBe(201);
      const changeId = propose.json().id as string;

      // This file shares one schema across every describe block. See docs/coordination.md §349.
      const pgBossRaw = await RawScpPgBossClient.connect();
      await pgBossRaw
        .query(`DELETE FROM pgboss.job WHERE name = $1`, [RECONCILE_QUEUE])
        .catch(() => undefined); // pgboss schema/tables may not exist yet if this is the first test to use pg-boss.
      await pgBossRaw.close();

      // "Worker" #1 — REAL subprocess plugin host, wrapped so the target's first real trigger()
      // call fires for real against the actual fake-executor subprocess and THEN throws, before
      // reconcile.ts ever gets to commit that fact.
      const boss1 = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
      const realHost1 = new SubprocessPluginHost({ callTimeoutMs: 5_000 });
      await realHost1.start([
        {
          id: DEFAULT_EXECUTOR_INSTANCE_ID,
          module: DEFAULT_EXECUTOR_MODULE,
          orgId: "shared",
          scopeKey: "shared",
          config: { statePath, autoSucceedAfterMs: 2_000 }
        }
      ]);
      // `onFault` resolves the instant the injected throw fires. See docs/coordination.md §350.
      let resolveFaulted!: () => void;
      const faulted = new Promise<void>((resolve) => {
        resolveFaulted = resolve;
      });
      const { host: host1, calls } = withFailOnceAfterRealTrigger(
        realHost1,
        (targetRef) => targetRef === targetObjectId,
        () => resolveFaulted()
      );
      const loop1 = await startReconcileLoop(
        boss1,
        server.deps.db,
        host1,
        getSharedCelSandbox(),
        server.deps.config.secretsMasterKey
      );

      // The target is left EXACTLY mid-flight: the real trigger() call already fired (a genuine
      // side effect against the real subprocess), but the injected fault meant reconcile.ts never
      // reached its own result-commit — status stays 'triggering', not 'triggered'.
      await faulted;

      // `calls` logs every trigger this host makes, across orgs. See docs/coordination.md §351.
      const ourCalls = calls.filter((c) => c.targetRef === targetObjectId);
      expect(ourCalls).toHaveLength(1); // the real trigger() call genuinely fired, exactly once so far.
      const idempotencyKey = ourCalls[0]!.idempotencyKey;
      expect(idempotencyKey).toBeTruthy();
      const externalIdFromWorker1 = ourCalls[0]!.externalId;

      // Simulate a full worker crash AT THIS EXACT MOMENT — nothing resumes this change until a
      // NEW worker starts. Torn down as the very next thing after the fault fires, so worker #1's
      // own next tick (1s later) never gets a chance to retry and self-heal it first.
      await loop1.stop();
      await realHost1.stop();
      await boss1.stop({ graceful: false, timeout: 500 }).catch(() => undefined);

      const stillTriggering = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(changeWaveTargets)
          .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
      );
      expect(stillTriggering[0]!.status).toBe("triggering");
      expect(stillTriggering[0]!.executorRef).toBeNull(); // never recorded — that's the crash.

      // Worker two shares nothing in memory with worker one. See docs/coordination.md §352.
      const boss2 = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
      const host2 = new SubprocessPluginHost({ callTimeoutMs: 5_000 });
      await host2.start([
        {
          id: DEFAULT_EXECUTOR_INSTANCE_ID,
          module: DEFAULT_EXECUTOR_MODULE,
          orgId: "shared",
          scopeKey: "shared",
          config: { statePath, autoSucceedAfterMs: 50 }
        }
      ]);
      const loop2 = await startReconcileLoop(
        boss2,
        server.deps.db,
        host2,
        getSharedCelSandbox(),
        server.deps.config.secretsMasterKey
      );

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
          {
            describe: `change ${changeId} reaches 'validating' after worker restart`,
            timeoutMs: 15_000
          }
        );

        // The resumed target was recorded with the SAME externalId worker #1's crashed-but-fired
        // real call produced — dedup, not a second real trigger. The fake-executor's own version
        // counter (asserted below) is the independent, harder-to-fake proof of that.
        const resumedTarget = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
        );
        expect(resumedTarget[0]!.status).not.toBe("triggering");
        const resumedRef = resumedTarget[0]!.executorRef as unknown as ExternalRunRef;
        expect(resumedRef.externalId).toBe(externalIdFromWorker1);
        const liveStatus = await host2.executor(DEFAULT_EXECUTOR_INSTANCE_ID).status(resumedRef);
        expect(liveStatus.stateRef).toBe("v0"); // NOT v1 — would be v1 if a second real run fired.

        const accept = await server.app.inject({
          method: "POST",
          url: `/api/v1/changes/${changeId}/accept`,
          headers: { authorization: `Bearer ${org.adminToken}` },
          payload: {}
        });
        expect(accept.statusCode).toBe(200);
        expect(accept.json().state).toBe("accepted");
      } finally {
        await loop2.stop();
        await host2.stop();
        await boss2.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      }
    } finally {
      await server.close();
    }
  });

  it("kills the fake-executor SUBPROCESS mid-wave — the worker survives, the plugin restarts with backoff, and the wave resumes", async () => {
    const server = await buildTestServer();
    const org = await createTestOrg(server, "kill-subprocess");
    const stateDir = await mkdtempTracked(join(tmpdir(), "scp-kill-subprocess-test-"));
    const statePath = join(stateDir, "fake-executor-state.json");

    // A generous autoSucceedAfterMs (3s) gives a reliable window to observe the wave target
    // mid-flight (triggered/observing) before the subprocess is killed out from under it. Small
    // restart-backoff bounds keep this test fast rather than waiting out production-tuned delays.
    const boss = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
    const host = new SubprocessPluginHost({
      callTimeoutMs: 10_000,
      restartBackoffBaseMs: 50,
      maxRestartBackoffMs: 300
    });
    await host.start([
      {
        id: DEFAULT_EXECUTOR_INSTANCE_ID,
        module: DEFAULT_EXECUTOR_MODULE,
        orgId: "shared",
        scopeKey: "shared",
        config: { statePath, autoSucceedAfterMs: 3_000 }
      }
    ]);
    const loop = await startReconcileLoop(
      boss,
      server.deps.db,
      host,
      getSharedCelSandbox(),
      server.deps.config.secretsMasterKey
    );

    try {
      const targetObjectId = await createComponentViaInject(server, org, "kill-subprocess-target");

      const propose = await server.app.inject({
        method: "POST",
        url: "/api/v1/changes",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "kill-subprocess change", targets: [targetObjectId] }
      });
      expect(propose.statusCode).toBe(201);
      const changeId = propose.json().id as string;

      await waitUntil(
        async () => {
          const targets = await withTenantTx(server.deps.db, org.orgId, (tx) =>
            tx
              .select()
              .from(changeWaveTargets)
              .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
          );
          const t = targets[0];
          return t && (t.status === "triggered" || t.status === "observing") ? t : undefined;
        },
        {
          describe:
            "wave target reaches triggered/observing (mid-wave) before the subprocess is killed",
          timeoutMs: 10_000
        }
      );

      // The crash itself: simulate an OOM/segfault/operator `kill -9` of the fake-executor's REAL
      // child process (host.ts's killInstanceForTest — the test-only seam that exists precisely
      // because there's no OS-level access to the real PID from outside SubprocessPluginHost).
      host.killInstanceForTest(DEFAULT_EXECUTOR_INSTANCE_ID);

      // Direct proof of "the plugin restarts with backoff". See docs/coordination.md §353.
      const capabilities = await host.executor(DEFAULT_EXECUTOR_INSTANCE_ID).describeCapabilities();
      expect(capabilities.supportsTrigger).toBe(true);

      // "The worker survives". See docs/coordination.md §354.
      await waitUntil(
        async () => {
          const get = await server.app.inject({
            method: "GET",
            url: `/api/v1/changes/${changeId}`,
            headers: { authorization: `Bearer ${org.adminToken}` }
          });
          return get.json().state === "validating" ? get.json() : undefined;
        },
        {
          describe: `change ${changeId} reaches 'validating' after the plugin subprocess is killed and restarts`,
          timeoutMs: 15_000
        }
      );

      const accept = await server.app.inject({
        method: "POST",
        url: `/api/v1/changes/${changeId}/accept`,
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: {}
      });
      expect(accept.statusCode).toBe(200);
      expect(accept.json().state).toBe("accepted");
    } finally {
      await loop.stop();
      await host.stop();
      await boss.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await server.close();
    }
  });
});

/** Duplicate or lost trigger calls, the worst finding. See docs/coordination.md §355. */
describe("coordination engine: trigger idempotency across a same-tick crash (CRITICAL #2)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "idempotency");
  });

  afterAll(async () => {
    await server.close();
  });

  it("a fault injected right after trigger() fires for real is retried with the SAME idempotencyKey — the executor dedupes to one real run — and a sibling change's same-tick progress is unaffected", async () => {
    const targetAId = await createComponentViaInject(server, org, "idem-target-a");
    const targetBId = await createComponentViaInject(server, org, "idem-target-b");

    const proposeA = await server.app.inject({
      method: "POST",
      url: "/api/v1/changes",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "idem change A", targets: [targetAId] }
    });
    const proposeB = await server.app.inject({
      method: "POST",
      url: "/api/v1/changes",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "idem change B", targets: [targetBId] }
    });
    expect(proposeA.statusCode).toBe(201);
    expect(proposeB.statusCode).toBe(201);

    // Long auto-succeed so neither target settles mid-test purely from the clock — this test cares
    // about the trigger/claim state machine, not wave completion.
    const { host, calls } = withFailOnceAfterRealTrigger(
      createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 }),
      (targetRef) => targetRef === targetAId // only A's target gets faulted; B must sail through.
    );

    // Tick 1: reconcileOrgTick walks BOTH freshly-proposed changes all the way to `executing` and
    // attempts to trigger their (only) wave target, all inside this one call.
    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      host,
      getSharedCelSandbox(),
      server.deps.config.secretsMasterKey
    );

    const targetsAfterTick1 = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets)
    );
    const targetARow1 = targetsAfterTick1.find((t) => t.targetObjectId === targetAId);
    const targetBRow1 = targetsAfterTick1.find((t) => t.targetObjectId === targetBId);
    expect(targetARow1).toBeDefined();
    expect(targetBRow1).toBeDefined();

    // A's trigger fired for real once, then the injected fault prevented it from ever being
    // recorded — it's stuck exactly where CRITICAL #2 says a crash-before-commit leaves it.
    expect(targetARow1!.status).toBe("triggering");
    expect(targetARow1!.executorRef).toBeNull();

    // B committed cleanly, so A's fault rolled nothing back. See docs/coordination.md §356.
    expect(targetBRow1!.status).toBe("triggered");
    expect(targetBRow1!.executorRef).not.toBeNull();

    // The injected fault is indistinguishable from a real one. See docs/coordination.md §357.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changeWaveTargets)
        .set({ updatedAt: new Date(Date.now() - 60_000) })
        .where(eq(changeWaveTargets.targetObjectId, targetAId))
    );

    // Tick 2: A's target (still `triggering`) is retried with the SAME idempotencyKey; nothing
    // faults it this time, so it commits.
    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      host,
      getSharedCelSandbox(),
      server.deps.config.secretsMasterKey
    );

    const targetsAfterTick2 = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets)
    );
    const targetARow2 = targetsAfterTick2.find((t) => t.targetObjectId === targetAId);
    expect(targetARow2).toBeDefined();
    expect(targetARow2!.status).toBe("triggered");
    expect(targetARow2!.executorRef).not.toBeNull();

    // The executor genuinely observed TWO real trigger() calls for A (the faulted attempt + the
    // retry) carrying the IDENTICAL idempotencyKey both times, and its dedup contract collapsed
    // them into one logical run: the same externalId both times, version bumped exactly once.
    const aCalls = calls.filter((c) => c.targetRef === targetAId);
    expect(aCalls).toHaveLength(2);
    expect(aCalls[0]!.idempotencyKey).toBeTruthy();
    expect(aCalls[1]!.idempotencyKey).toBe(aCalls[0]!.idempotencyKey);
    expect(aCalls[1]!.externalId).toBe(aCalls[0]!.externalId);

    const executorRef = targetARow2!.executorRef as unknown as ExternalRunRef;
    expect(executorRef.externalId).toBe(aCalls[0]!.externalId);
    const liveStatus: ExecutionStatus = await host
      .executor(DEFAULT_EXECUTOR_INSTANCE_ID)
      .status(executorRef);
    // v0, not v1 — a mutation that broke the dedup contract (e.g. re-minting a fresh run on every
    // retry) would bump this.
    expect(liveStatus.stateRef).toBe("v0");
  });
});

/** MAJOR #6 (PR #7 review — "batch starvation"). See docs/coordination.md §358. */
describe("coordination engine: reconcile batch fairness (MAJOR #6)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "batch-fairness");
  });

  afterAll(async () => {
    await server.close();
  });

  /** Fabricates an `executing` change whose sole wave has already `failed`, and marks it parked
   *  exactly like `reconcileExecutingChange`'s `failed` branch does — directly via the repo layer
   *  (not by running the fake executor to an actual failure) so this test is precisely about the
   *  BATCH LISTING'S exclusion filter, not wave-failure detection (covered elsewhere). */
  async function createParkedExecutingChange(index: number): Promise<string> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const targetObject = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "batch-fairness-test",
        name: `parked-target-${index}`
      });
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "batch-fairness-test",
        name: `parked-change-${index}`,
        targets: [targetObject.id]
      });
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "evaluated",
          actorObjectId: org.orgId,
          requestId: "batch-fairness-test"
        },
        { sandbox: getSharedCelSandbox(), host: null }
      );
      const plan = await compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds,
        topologyObjectId: null,
        topologyVersion: null
      });
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "coordinated",
          actorObjectId: org.orgId,
          requestId: "batch-fairness-test"
        },
        { sandbox: getSharedCelSandbox(), host: null }
      );
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "executing",
          actorObjectId: org.orgId,
          requestId: "batch-fairness-test"
        },
        { sandbox: getSharedCelSandbox(), host: null }
      );
      await markWaveTerminal(tx, org.orgId, plan.waves[0]!.id, "failed");
      await markChangeReconcileBlocked(tx, org.orgId, change.id);
      return change.id;
    });
  }

  it("25+ parked (failed-wave) executing changes do not prevent a newer executing change from being reconciled", async () => {
    const PARKED_COUNT = 26; // one more than BATCH_LIMIT (25) — the minimal reproducer.
    for (let i = 0; i < PARKED_COUNT; i++) {
      await createParkedExecutingChange(i);
    }

    // A fresh change, created strictly AFTER (and therefore with a strictly newer `updated_at`
    // than) every parked change above — under the pre-fix ordering (oldest-`updated_at`-first, no
    // exclusion), the 26 parked changes would occupy every one of the 25 batch slots forever and
    // this one would never be reached.
    const freshTargetId = await createComponentViaInject(server, org, "fresh-target");

    const proposeFresh = await server.app.inject({
      method: "POST",
      url: "/api/v1/changes",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "fresh change", targets: [freshTargetId] }
    });
    expect(proposeFresh.statusCode).toBe(201);

    const host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
    // One tick walks the fresh change proposed -> ... -> executing -> triggered, all inline —
    // exactly like the CRITICAL #2 test above relies on.
    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      host,
      getSharedCelSandbox(),
      server.deps.config.secretsMasterKey
    );

    const targets = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, freshTargetId))
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("triggered");
  }, 30_000);
});

/** The watchdog had no non-test caller at all. See docs/coordination.md §359. */
describe("coordination engine: watchdog scheduled on the running worker (CRITICAL #1)", () => {
  it("the scheduled watchdog loop, started as part of the worker (not called directly by the test), flags a stalled change and writes a Decision", async () => {
    const server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 5_000 },
      // A short interval isn't needed for the FIRST sweep (startWatchdogLoop fires one immediately
      // on start), but keeps this test fast if it ever needs a second one.
      watchdogIntervalSeconds: 2
    });
    const org = await createTestOrg(server, "watchdog-scheduled");

    try {
      // A normal change, let the ACTIVE reconcile loop. See docs/coordination.md §360.
      const targetId = await createComponentViaInject(server, org, "watchdog-scheduled-target");

      const propose = await server.app.inject({
        method: "POST",
        url: "/api/v1/changes",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "will stall in validating (scheduled sweep)", targets: [targetId] }
      });
      expect(propose.statusCode).toBe(201);
      const changeId = propose.json().id as string;

      await waitUntil(
        async () => {
          const get = await server.app.inject({
            method: "GET",
            url: `/api/v1/changes/${changeId}`,
            headers: { authorization: `Bearer ${org.adminToken}` }
          });
          return get.json().state === "validating" ? get.json() : undefined;
        },
        { describe: `change ${changeId} reaches 'validating'`, timeoutMs: 15_000 }
      );

      // Backdate past the `validating` SLA (24h) so the very next scheduled sweep flags it.
      const longAgo = new Date(Date.now() - (WATCHDOG_SLA_MS.validating + 60_000));
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx.update(changes).set({ stateEnteredAt: longAgo }).where(eq(changes.objectId, changeId))
      );

      // Never calls runWatchdogSweep directly — only the scheduled loop, wired up exactly like
      // main.ts wires it, is allowed to produce this Decision.
      await waitUntil(
        async () => {
          const explain = await server.app.inject({
            method: "GET",
            url: `/api/v1/changes/${changeId}/explain`,
            headers: { authorization: `Bearer ${org.adminToken}` }
          });
          if (explain.statusCode !== 200) return undefined;
          const body = explain.json() as { decisions: { kind: string; verdict: string }[] };
          const watchdogDecision = body.decisions.find((d) => d.kind === "watchdog");
          return watchdogDecision ? watchdogDecision : undefined;
        },
        {
          describe: `change ${changeId} gets a 'watchdog' Decision from the SCHEDULED sweep`,
          timeoutMs: 20_000
        }
      );
    } finally {
      await server.close();
    }
  }, 40_000);
});

/** Multi-replica coordination trigger concurrency. See docs/coordination.md §361. */
describe("coordination engine: multi-replica trigger claim is single-flight (M8 hardening)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "multi-replica-claim");
  });

  afterAll(async () => {
    await server.close();
  });

  /** Manually walks a change to `executing` with a compiled plan — same manual walk as the
   *  "reconcile batch fairness" fixture above — WITHOUT ever calling `reconcileOrgTick`/
   *  `advanceExecutingChanges`, so the resulting wave target sits at `pending`, genuinely
   *  un-claimed by anything, under this test's full control. */
  async function createExecutingChangeWithPendingTarget(name: string): Promise<string> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const targetObject = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "multi-replica-claim-test",
        name
      });
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "multi-replica-claim-test",
        name: `${name}-change`,
        targets: [targetObject.id]
      });
      const gateDeps = { sandbox: getSharedCelSandbox(), host: null };
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "evaluated",
          actorObjectId: org.orgId,
          requestId: "multi-replica-claim-test"
        },
        gateDeps
      );
      await compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds,
        topologyObjectId: null,
        topologyVersion: null
      });
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "coordinated",
          actorObjectId: org.orgId,
          requestId: "multi-replica-claim-test"
        },
        gateDeps
      );
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "executing",
          actorObjectId: org.orgId,
          requestId: "multi-replica-claim-test"
        },
        gateDeps
      );
      return targetObject.id;
    });
  }

  async function waveTargetIdFor(targetObjectId: string): Promise<string> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    return rows[0]!.id;
  }

  it("N genuinely concurrent lock-acquire attempts for the SAME wave target: exactly one succeeds", async () => {
    const targetObjectId = await createExecutingChangeWithPendingTarget("race-target");
    const waveTargetId = await waveTargetIdFor(targetObjectId);

    // Real independent connections, locks fired concurrently. See docs/coordination.md §362.
    const CONCURRENT_CLAIMANTS = 8;
    const locks = await Promise.all(
      Array.from({ length: CONCURRENT_CLAIMANTS }, () =>
        tryAcquireTriggerClaimLock(server.deps.db, waveTargetId)
      )
    );

    const winners = locks.filter((lock) => lock !== undefined);
    expect(winners).toHaveLength(1);

    // Release the sole winner's lock — every loser already released nothing (they acquired
    // nothing), so this is the only cleanup needed.
    await winners[0]!.release();
  });

  it("releasing the lock makes it IMMEDIATELY reclaimable — no time budget spent, unlike a lease would need", async () => {
    const targetObjectId = await createExecutingChangeWithPendingTarget("release-target");
    const waveTargetId = await waveTargetIdFor(targetObjectId);

    const first = await tryAcquireTriggerClaimLock(server.deps.db, waveTargetId);
    expect(first).toBeDefined();

    // While held, a second attempt must NOT acquire it — this is the property that makes a
    // concurrent replica back off instead of double-firing.
    const whileHeld = await tryAcquireTriggerClaimLock(server.deps.db, waveTargetId);
    expect(whileHeld).toBeUndefined();

    await first!.release();

    // The instant it's released (simulating the original claimant's `triggerWaveTarget` `finally`
    // running — success OR a caught error, exactly what the M3 crash-resumption tests rely on for
    // "retry on the very next tick") a fresh attempt succeeds immediately. No staleness window,
    // no wait.
    const afterRelease = await tryAcquireTriggerClaimLock(server.deps.db, waveTargetId);
    expect(afterRelease).toBeDefined();
    await afterRelease!.release();
  });

  it("end-to-end: two independent PluginHosts (simulating two worker replicas with NO shared executor state) run reconcileOrgTick concurrently against the SAME already-executing change — the executor's trigger() fires exactly once", async () => {
    // Deterministic setup by the same manual state walk. See docs/coordination.md §363.
    const targetObjectId = await createExecutingChangeWithPendingTarget("e2e-race-target");
    await waveTargetIdFor(targetObjectId);

    // Two separate fake hosts, so two separate plugin instances. See docs/coordination.md §364.
    const { host: hostA, calls: callsA } = withFailOnceAfterRealTrigger(
      createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 }),
      () => false // never inject a fault — this wrapper is used purely as a call-count logger here.
    );
    const { host: hostB, calls: callsB } = withFailOnceAfterRealTrigger(
      createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 }),
      () => false
    );

    // Two concurrent, continuously self-re-ticking loops. See docs/coordination.md §365.
    let settled = false;
    async function tickLoop(host: PluginHost): Promise<void> {
      while (!settled) {
        await reconcileOrgTick(
          server.deps.db,
          org.orgId,
          host,
          getSharedCelSandbox(),
          server.deps.config.secretsMasterKey
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const loopA = tickLoop(hostA);
    const loopB = tickLoop(hostB);

    try {
      await waitUntil(
        async () => {
          const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
            tx
              .select()
              .from(changeWaveTargets)
              .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
          );
          const row = rows[0];
          return row && row.status !== "pending" && row.status !== "triggering" ? row : undefined;
        },
        { describe: "e2e-race wave target settles past triggering", timeoutMs: 15_000 }
      );
    } finally {
      settled = true; // stop both loops — awaited below so the test doesn't outlive them.
      await Promise.all([loopA, loopB]);
    }

    const totalRealTriggerCalls =
      callsA.filter((c) => c.targetRef === targetObjectId).length +
      callsB.filter((c) => c.targetRef === targetObjectId).length;
    expect(totalRealTriggerCalls).toBe(1);
  }, 30_000);
});

/** One pipeline phase earlier than the trigger-claim race. See docs/coordination.md §366. */
describe("coordination engine: evaluated->coordinated plan compilation is single-flight (M8 hardening)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "eval-coordinate-race");
  });

  afterAll(async () => {
    await server.close();
  });

  it("N concurrent reconcileOrgTick calls racing the SAME freshly-proposed change: exactly ONE plan is ever persisted, and the change is never wrongfully cancelled", async () => {
    const targetObjectId = await createComponentViaInject(server, org, "eval-race-target");

    const propose = await server.app.inject({
      method: "POST",
      url: "/api/v1/changes",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "eval-race change", targets: [targetObjectId] }
    });
    expect(propose.statusCode).toBe(201);
    const changeObjectId = propose.json().id as string;

    // Independent in-memory fake hosts (no shared executor state, same reasoning as the
    // trigger-claim e2e test above) driving several genuinely concurrent, continuously
    // self-re-ticking reconcile loops — all racing to be the one that compiles this change's
    // plan and coordinates it.
    const CONCURRENT_REPLICAS = 4;
    let settled = false;
    async function tickLoop(): Promise<void> {
      const host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
      while (!settled) {
        await reconcileOrgTick(
          server.deps.db,
          org.orgId,
          host,
          getSharedCelSandbox(),
          server.deps.config.secretsMasterKey
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const loops = Array.from({ length: CONCURRENT_REPLICAS }, () => tickLoop());

    try {
      await waitUntil(
        async () => {
          const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
            tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
          );
          const state = rows[0]?.state;
          // "coordinated" or further (executing/validating/...) — anything past the race this
          // test is about. Never expect "cancelled" here (asserted explicitly below too).
          return state && state !== "proposed" && state !== "evaluated" ? state : undefined;
        },
        { describe: "eval-race change reaches coordinated (or further)", timeoutMs: 15_000 }
      );
    } finally {
      settled = true;
      await Promise.all(loops);
    }

    const finalChange = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    expect(finalChange[0]!.state).not.toBe("cancelled");

    // The definitive proof: exactly ONE plan was EVER persisted for this change — not "the
    // latest one looks fine" (which duplicate-plan-row bugs can still pass), but a hard count.
    const plans = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.query.changePlans.findMany({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.orgId, org.orgId), eqOp(t.changeObjectId, changeObjectId))
      })
    );
    expect(plans).toHaveLength(1);

    // And exactly one wave_target row for this target — the same observable symptom the
    // pre-fix bug produced (two distinct waveIds for the same targetObjectId).
    const waveTargetRows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
    );
    expect(waveTargetRows).toHaveLength(1);
  }, 30_000);
});

/** The same audit, one layer further upstream. See docs/coordination.md §367. */
describe("coordination engine: webhook-event processing is single-flight across concurrent ticks (M8 hardening)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "webhook-race");
  });

  afterAll(async () => {
    await server.close();
  });

  it("N concurrent processChangeSourceEvents calls racing the SAME unprocessed event row: exactly ONE Change is ever proposed", async () => {
    const componentObjectId = await createComponentViaInject(
      server,
      org,
      `webhook-race-comp-${randomSuffix()}`
    );
    const repo = `webhook-race-org/${randomSuffix()}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentObjectId
      })
    );

    // Insert ONE unprocessed change_source_events row directly (bypassing the HTTP/HMAC layer,
    // already covered by executors.integration.test.ts's signature/redelivery-dedupe suite) — this
    // test is specifically about PROCESSING-time concurrency, not ingestion.
    const eventId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeSourceEvents).values({
        id: eventId,
        orgId: org.orgId,
        sourceKind: "generic",
        signatureVerified: true,
        dedupeKey: `test:${eventId}`,
        headers: {},
        payload: { repo, correlationKey: "refs/heads/main" }
      })
    );

    const CONCURRENT_REPLICAS = 6;
    await Promise.all(
      Array.from({ length: CONCURRENT_REPLICAS }, () =>
        withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId))
      )
    );

    const eventRow = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(eventRow[0]!.processedAt).not.toBeNull();
    expect(eventRow[0]!.resultingChangeObjectId).not.toBeNull();

    // The definitive proof: exactly one Change exists in this (fresh, dedicated) org — a
    // duplicate-processing bug would show two.
    const allChanges = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ objectId: changes.objectId }).from(changes).where(eq(changes.orgId, org.orgId))
    );
    expect(allChanges).toHaveLength(1);
    expect(allChanges[0]!.objectId).toBe(eventRow[0]!.resultingChangeObjectId);
  });
});

/** M8 hardening follow-up. See docs/coordination.md §368. */
describe("coordination engine: wave-gate evaluation is single-flight (M8 hardening MINOR #5)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "wave-gate-race");
  });

  afterAll(async () => {
    await server.close();
  });

  /** Walks a change to executing entirely outside the tick. See docs/coordination.md §369. */
  async function createExecutingChangeWithPendingWave(
    name: string
  ): Promise<{ changeObjectId: string; targetObjectId: string }> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const targetObject = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "wave-gate-race-test",
        name
      });
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "wave-gate-race-test",
        name: `${name}-change`,
        targets: [targetObject.id]
      });
      const gateDeps = { sandbox: getSharedCelSandbox(), host: null };
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "evaluated",
          actorObjectId: org.orgId,
          requestId: "wave-gate-race-test"
        },
        gateDeps
      );
      await compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds,
        topologyObjectId: null,
        topologyVersion: null
      });
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "coordinated",
          actorObjectId: org.orgId,
          requestId: "wave-gate-race-test"
        },
        gateDeps
      );
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "executing",
          actorObjectId: org.orgId,
          requestId: "wave-gate-race-test"
        },
        gateDeps
      );
      return { changeObjectId: change.id, targetObjectId: targetObject.id };
    });
  }

  it("N genuinely concurrent reconcileOrgTick calls racing the SAME pending wave's gate: exactly ONE gate Decision is ever recorded", async () => {
    const { changeObjectId, targetObjectId } =
      await createExecutingChangeWithPendingWave("wave-gate-race-target");

    // Sanity: the wave genuinely has never been GATED yet — the manual walk above writes
    // `kind: "transition"` Decisions for each transitionChange call, but zero `kind: "gate"`
    // Decisions exist before the race starts (this manual walk never called reconcileOrgTick, the
    // only thing that ever evaluates a wave gate).
    const beforeGateDecisions = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.subjectId, changeObjectId), eq(decisions.kind, "gate")))
    );
    expect(beforeGateDecisions).toHaveLength(0);

    // A real, independent in-memory fake host per the same reasoning the other races' e2e tests
    // use — not shared executor state, and a long autoSucceedAfterMs so the target sits durably
    // `triggered`/`observing` after the race resolves rather than racing to completion too.
    const host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });

    // Genuinely concurrent (Promise.all, not a loop) — the same shape as the trigger-claim lock's
    // own direct N-concurrent-attempts test above. All N ticks race the SAME org, so all N read
    // this change as `executing` with its one wave `pending` before any of them can possibly have
    // committed a gate Decision yet.
    const CONCURRENT_REPLICAS = 8;
    await Promise.all(
      Array.from({ length: CONCURRENT_REPLICAS }, () =>
        reconcileOrgTick(
          server.deps.db,
          org.orgId,
          host,
          getSharedCelSandbox(),
          server.deps.config.secretsMasterKey
        )
      )
    );

    // The wave genuinely progressed past `pending` (proves SOME tick won the race and did the
    // real work, not that every tick just silently no-op'd).
    const waveTargetRows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeWaveTargets)
        .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
    );
    expect(waveTargetRows).toHaveLength(1);
    expect(waveTargetRows[0]!.status).not.toBe("pending");

    // The definitive proof: exactly ONE gate Decision was EVER persisted for this change's wave
    // boundary — not "the latest one looks fine", a hard count.
    const gateDecisions = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.subjectId, changeObjectId), eq(decisions.kind, "gate")))
    );
    expect(gateDecisions).toHaveLength(1);
  }, 30_000);
});

/** Regression (live bug). See docs/coordination.md §370. */
describe("coordination engine: same-repo change_source_events do not collide on URN (queue-wedge regression)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "webhook-samerepo");
  });

  afterAll(async () => {
    await server.close();
  });

  it("a batch of MANY unprocessed events from ONE repo processes without a Conflict — one Change per event, all marked processed", async () => {
    const componentObjectId = await createComponentViaInject(
      server,
      org,
      `samerepo-comp-${randomSuffix()}`
    );
    const repo = `samerepo-org/${randomSuffix()}`;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "generic",
        repoPattern: repo,
        componentIdOrUrn: componentObjectId
      })
    );

    // Seed several DISTINCT events for the SAME repo in one batch — exactly the monorepo-backlog
    // shape that wedged the live queue. Each is a separate delivery (distinct id + dedupe_key); the
    // shared `correlationKey` (a branch ref) is what a real push stream looks like.
    const EVENT_COUNT = 5;
    const eventIds = Array.from({ length: EVENT_COUNT }, () => uuidv7());
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeSourceEvents).values(
        eventIds.map((id) => ({
          id,
          orgId: org.orgId,
          sourceKind: "generic",
          signatureVerified: true,
          dedupeKey: `samerepo:${id}`,
          headers: {},
          payload: { repo, correlationKey: "refs/heads/main" }
        }))
      )
    );

    // Pre-fix this threw `Conflict` on the 2nd same-repo event and rolled the whole tx back.
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

    // (a)/(b) EVERY event is now processed with a resulting change linked — nothing left stuck.
    const eventRows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changeSourceEvents)
        .where(
          and(eq(changeSourceEvents.orgId, org.orgId), inArray(changeSourceEvents.id, eventIds))
        )
    );
    expect(eventRows).toHaveLength(EVENT_COUNT);
    for (const row of eventRows) {
      expect(row.processedAt).not.toBeNull();
      expect(row.resultingChangeObjectId).not.toBeNull();
    }

    // (c) Distinct releases → distinct Changes: one per event, each a unique object with a unique URN.
    const resultingIds = new Set(eventRows.map((r) => r.resultingChangeObjectId));
    expect(resultingIds.size).toBe(EVENT_COUNT);

    const changeObjects = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, urn: objects.urn })
        .from(objects)
        .where(
          and(eq(objects.orgId, org.orgId), inArray(objects.id, [...resultingIds] as string[]))
        )
    );
    expect(changeObjects).toHaveLength(EVENT_COUNT);
    expect(new Set(changeObjects.map((o) => o.urn)).size).toBe(EVENT_COUNT);

    // All same-repo events share ONE coordinated-change group (correlationKey grouping), proving the
    // group — not the change — is what dedupes.
    const groups = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.typeId, "coordinated-change")))
    );
    expect(groups).toHaveLength(1);
  });
});

// P4C increment 3 (ADR-0008 signal 1, image half). See docs/coordination.md §371.
describe("coordination engine: observed deployed-image threading (P4C)", () => {
  let server: ListeningTestServer;
  const imageTargetId = uuidv7();
  const deployedImages = ["ghcr.io/acme/api:2.4.1", "ghcr.io/acme/sidecar@sha256:cafebabe"];

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      },
      fakeExecutorConfig: { imagesByTarget: { [imageTargetId]: deployedImages } }
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("persists status().observed.images onto observed_state and surfaces them on the plan read model, without dropping the revision", async () => {
    const org = await createTestOrg(server, "observed-images");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // Explicit id so the boot-time `imagesByTarget` config (above) names THIS target.
    const target = await createTestComponent(admin, {
      id: imageTargetId,
      name: "observed-images-target"
    });
    expect(target.id).toBe(imageTargetId);

    const change = await admin.changes.propose({
      name: "observe the deployed images",
      targets: [imageTargetId]
    });

    // Drive to succeeded via the same plan read model the UI/CLI consume.
    const explained = await waitUntil(
      async () => {
        const e = await admin.changes.explain(change.id);
        const t = e.plan?.waves[0]?.targets.find((x) => x.targetObjectId === imageTargetId);
        return t && t.status === "succeeded" ? e : undefined;
      },
      { describe: `wave target for ${imageTargetId} reaches 'succeeded'`, timeoutMs: 20_000 }
    );
    const wireTarget = explained.plan!.waves[0]!.targets.find(
      (x) => x.targetObjectId === imageTargetId
    )!;

    // The REAL images the fake-executor reported for this run (its configured output), surfaced on
    // the read model — AND the synced revision (#76) is still present, not dropped by the merge.
    expect(wireTarget.observed).not.toBeNull();
    expect(wireTarget.observed!.images).toEqual(deployedImages);
    expect(wireTarget.observed!.revision).toBe("v0");

    // Durably persisted on the row's observed_state jsonb, not just synthesized by the read mapper.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.id, wireTarget.id))
    );
    const persisted = rows[0]!.observedState as { revision?: string; images?: string[] } | null;
    expect(persisted?.images).toEqual(deployedImages);
    expect(persisted?.revision).toBe("v0");
  });
});

// ADR-0008 P4D (rollout, OBSERVE-ONLY). See docs/coordination.md §372.
describe("coordination engine: observed rollout threading (P4D)", () => {
  let server: ListeningTestServer;
  const rolloutTargetId = uuidv7();
  const observedRollout = { phase: "Paused", step: 2, weight: 40, message: "Rollout is paused" };

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      },
      fakeExecutorConfig: { rolloutByTarget: { [rolloutTargetId]: observedRollout } }
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("persists status().observed.rollout onto observed_state and surfaces it on the plan read model, without dropping the revision", async () => {
    const org = await createTestOrg(server, "observed-rollout");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // Explicit id so the boot-time `rolloutByTarget` config (above) names THIS target.
    const target = await createTestComponent(admin, {
      id: rolloutTargetId,
      name: "observed-rollout-target"
    });
    expect(target.id).toBe(rolloutTargetId);

    const change = await admin.changes.propose({
      name: "observe the rollout",
      targets: [rolloutTargetId]
    });

    // Drive to succeeded via the same plan read model the UI/CLI consume.
    const explained = await waitUntil(
      async () => {
        const e = await admin.changes.explain(change.id);
        const t = e.plan?.waves[0]?.targets.find((x) => x.targetObjectId === rolloutTargetId);
        return t && t.status === "succeeded" ? e : undefined;
      },
      { describe: `wave target for ${rolloutTargetId} reaches 'succeeded'`, timeoutMs: 20_000 }
    );
    const wireTarget = explained.plan!.waves[0]!.targets.find(
      (x) => x.targetObjectId === rolloutTargetId
    )!;

    // The REAL rollout the fake-executor reported for this run (its configured output), surfaced on
    // the read model — AND the synced revision (#76) is still present, not dropped by the merge.
    expect(wireTarget.observed).not.toBeNull();
    expect(wireTarget.observed!.rollout).toEqual(observedRollout);
    expect(wireTarget.observed!.revision).toBe("v0");

    // Durably persisted on the row's observed_state jsonb, not just synthesized by the read mapper.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.id, wireTarget.id))
    );
    const persisted = rows[0]!.observedState as {
      revision?: string;
      rollout?: { phase?: string; step?: number; weight?: number; message?: string };
    } | null;
    expect(persisted?.rollout).toEqual(observedRollout);
    expect(persisted?.revision).toBe("v0");
  });
});

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
