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
  RawScpPgBossClient,
  waitUntil,
  type ListeningTestServer,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, changeWaveTargets } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { SubprocessPluginHost } from "../plugin-host/host.js";
import { RECONCILE_QUEUE, reconcileOrgTick, startReconcileLoop } from "./reconcile.js";
import { startPgBoss } from "../events/pgboss.js";
import { DEFAULT_EXECUTOR_INSTANCE_ID, DEFAULT_EXECUTOR_MODULE } from "./executor-config.js";
import { runWatchdogSweep, WATCHDOG_SLA_MS } from "./watchdog.js";
import { markChangeReconcileBlocked, proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { markWaveTerminal } from "./wave-targets-repo.js";
import { createInMemoryFakeHost, withFailOnceAfterRealTrigger } from "./test-support/fake-plugin-host.js";

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
  /**
   * MAJOR #7 fix (PR #7 review — "the 'kill the worker mid-wave' resume test doesn't crash
   * anything"): the old version of this test called GRACEFUL `loop.stop()`/`host.stop()` only
   * AFTER the target was already durably `triggered`/`observing` — by that point there was nothing
   * left to resume; deleting all of `reconcile.ts`'s crash-resumption logic would still pass this
   * test. This version injects a REAL fault (`withFailOnceAfterRealTrigger`, wrapping the REAL
   * `SubprocessPluginHost` — the actual subprocess, actual JSON-RPC, actual fake-executor state
   * file, nothing faked except the one injected throw) that lets the target's `trigger()` call
   * genuinely fire against the real fake-executor subprocess and THEN throws, before worker #1's
   * tick ever reaches its own result-commit — the target is left durably `triggering`, mid-flight,
   * not post-commit. Worker #1 is torn down at EXACTLY that moment (no further ticks get a chance
   * to self-heal it), and a brand new worker #2 — sharing nothing in memory — must resume it: same
   * `externalId` (no duplicate trigger), wave completes, change promotes. This also directly
   * guards CRITICAL #2 (duplicate/lost trigger calls): if `reconcile.ts` regressed to its old
   * single-big-transaction design (or dropped the `triggering`-status resume path), worker #2
   * would either never notice the stuck target (this test times out) or fire a genuinely SECOND
   * real trigger with a different idempotencyKey (the externalId assertion below would fail).
   */
  it("kills the worker (reconcile loop + plugin host) mid-wave, via a real fault injected between trigger() firing and its result-commit — a freshly started worker resumes purely from Postgres state, with no duplicate trigger and no shared in-memory handoff", async () => {
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

      // This whole file shares ONE Postgres/pgboss schema across every describe block, and
      // `RECONCILE_QUEUE` is a single global queue name every `startReconcileLoop` call
      // (including earlier describes' already-finished loops) sends jobs to. A prior test's final
      // self-rescheduled tick can still be sitting in `pgboss.job`, not yet due, when THAT test's
      // `boss.stop()` ran — `stop()` only stops ITS OWN worker from fetching further, it doesn't
      // cancel jobs already queued. Left alone, THIS test's worker #1 would be eligible to pick
      // that stale job up too, running an extra tick this test doesn't control the timing of and
      // defeating "torn down before it can retry." Purged here so this test starts from a clean
      // queue — a test-hygiene concern specific to this shared-queue-name suite design, not
      // anything `reconcile.ts` itself needs to guard against in production (one `scpd` process
      // owns the queue there).
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
          domainId: "shared",
          config: { statePath, autoSucceedAfterMs: 2_000 }
        }
      ]);
      // `onFault` resolves the instant the injected throw fires — used below to tear worker #1
      // down IMMEDIATELY, rather than polling DB state for the 'triggering' status. Polling can't
      // reliably win the race against the loop's own 1s-later retry on a loaded CI box (worker #1
      // would just self-heal before the poll ever observes the mid-flight state); reacting to the
      // fault synchronously, from within the exact same tick that caused it, always beats it.
      let resolveFaulted!: () => void;
      const faulted = new Promise<void>((resolve) => {
        resolveFaulted = resolve;
      });
      const { host: host1, calls } = withFailOnceAfterRealTrigger(
        realHost1,
        (targetRef) => targetRef === targetObjectId,
        () => resolveFaulted()
      );
      const loop1 = await startReconcileLoop(boss1, server.deps.db, host1);

      // The target is left EXACTLY mid-flight: the real trigger() call already fired (a genuine
      // side effect against the real subprocess), but the injected fault meant reconcile.ts never
      // reached its own result-commit — status stays 'triggering', not 'triggered'.
      await faulted;

      // `calls` logs EVERY trigger() this host ever makes, across every org (see
      // `withFailOnceAfterRealTrigger`'s doc comment) — this shared-database suite's `boss1` will
      // legitimately also advance unrelated leftover work from other already-finished describe
      // blocks (e.g. the plain "watchdog" suite above deliberately leaves a change parked in
      // `proposed` with no loop of its own ever touching it — `runReconcileSweep` doesn't know or
      // care that it "belongs" to a different test). Scope to THIS test's own target before
      // asserting anything.
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
        tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, targetObjectId))
      );
      expect(stillTriggering[0]!.status).toBe("triggering");
      expect(stillTriggering[0]!.executorRef).toBeNull(); // never recorded — that's the crash.

      // "Worker" #2 — a BRAND NEW reconcile loop + plugin host, sharing nothing in memory with
      // worker #1 (fresh instances, this process never held any per-change state to begin with —
      // `coordination/reconcile.ts`'s whole design). No fault wrapper this time. The SAME
      // `statePath` is what lets the fake executor (standing in for a real external system, which
      // of course doesn't forget a deployment because SCP's worker restarted) answer correctly for
      // the ref worker #1's real (but never-recorded) trigger() call left in flight.
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

        // The resumed target was recorded with the SAME externalId worker #1's crashed-but-fired
        // real call produced — dedup, not a second real trigger. The fake-executor's own version
        // counter (asserted below) is the independent, harder-to-fake proof of that.
        const resumedTarget = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, targetObjectId))
        );
        expect(resumedTarget[0]!.status).not.toBe("triggering");
        const resumedRef = resumedTarget[0]!.executorRef as unknown as ExternalRunRef;
        expect(resumedRef.externalId).toBe(externalIdFromWorker1);
        const liveStatus = await host2.executor(DEFAULT_EXECUTOR_INSTANCE_ID).status(resumedRef);
        expect(liveStatus.stateRef).toBe("v0"); // NOT v1 — would be v1 if a second real run fired.

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

  it("kills the fake-executor SUBPROCESS mid-wave — the worker survives, the plugin restarts with backoff, and the wave resumes", async () => {
    const server = await buildTestServer();
    const org = await createTestOrg(server, "kill-subprocess");
    const stateDir = await mkdtemp(join(tmpdir(), "scp-kill-subprocess-test-"));
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
        domainId: "shared",
        config: { statePath, autoSucceedAfterMs: 3_000 }
      }
    ]);
    const loop = await startReconcileLoop(boss, server.deps.db, host);

    try {
      const createTarget = await server.app.inject({
        method: "POST",
        url: "/api/v1/components",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "kill-subprocess-target" }
      });
      expect(createTarget.statusCode).toBe(201);
      const targetObjectId = createTarget.json().id as string;

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
            tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, targetObjectId))
          );
          const t = targets[0];
          return t && (t.status === "triggered" || t.status === "observing") ? t : undefined;
        },
        {
          describe: "wave target reaches triggered/observing (mid-wave) before the subprocess is killed",
          timeoutMs: 10_000
        }
      );

      // The crash itself: simulate an OOM/segfault/operator `kill -9` of the fake-executor's REAL
      // child process (host.ts's killInstanceForTest — the test-only seam that exists precisely
      // because there's no OS-level access to the real PID from outside SubprocessPluginHost).
      host.killInstanceForTest(DEFAULT_EXECUTOR_INSTANCE_ID);

      // Direct proof of "the plugin restarts with backoff": an RPC call against the SAME `host`
      // instance issued right after the kill has nothing to talk to until host.ts's
      // restart-with-backoff timer respawns the child and it re-announces `ready` — `call()`'s
      // built-in wait-for-ready + transparent retry (host.ts's module doc: "callers never see a
      // dead subprocess, only a slower/retried call") is what makes this resolve successfully
      // rather than throw or hang. It can ONLY resolve if a genuinely new child process came up.
      const capabilities = await host.executor(DEFAULT_EXECUTOR_INSTANCE_ID).describeCapabilities();
      expect(capabilities.supportsTrigger).toBe(true);

      // "The worker survives": this is the SAME reconcile loop / pg-boss job that was running
      // before the kill — never stopped, never replaced — driving the change the rest of the way.
      // "The wave resumes": the target's in-flight run (its statePath-backed state survived the
      // crash — fake-executor's own module doc) still completes and the change reaches
      // 'validating' with no operator intervention beyond the eventual human promote below.
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

      const promote = await server.app.inject({
        method: "POST",
        url: `/api/v1/changes/${changeId}/promote`,
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: {}
      });
      expect(promote.statusCode).toBe(200);
      expect(promote.json().state).toBe("promoted");
    } finally {
      await loop.stop();
      await host.stop();
      await boss.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await server.close();
    }
  });
});

/**
 * CRITICAL #2 (PR #7 review — "duplicate/lost external trigger() calls", the most serious
 * finding): the old code called `plugin.trigger()` and then wrote its result INTO the same
 * still-open, whole-org transaction as every other change in the tick — so ANY later failure in
 * that tick rolled back the DB record of an already-fired trigger, and the next tick re-fired it,
 * with no way for the executor to tell the two calls apart. It also meant one change's failure
 * could roll back a sibling change's already-committed progress in the same tick.
 *
 * This suite proves the fix using a fast, deterministic in-process fake host
 * (`createInMemoryFakeHost`) wrapped with a fault injector (`withFailOnceAfterRealTrigger`) that
 * lets the REAL trigger() fire (a genuine side effect against the fake executor) and THEN throws —
 * simulating a crash/tick-abort in the exact window `triggerWaveTarget`'s doc comment describes.
 */
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
    const createTargetA = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "idem-target-a" }
    });
    const createTargetB = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "idem-target-b" }
    });
    expect(createTargetA.statusCode).toBe(201);
    expect(createTargetB.statusCode).toBe(201);
    const targetAId = createTargetA.json().id as string;
    const targetBId = createTargetB.json().id as string;

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
    await reconcileOrgTick(server.deps.db, org.orgId, host);

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

    // B's trigger, in the SAME reconcileOrgTick call, committed cleanly — proof A's fault never
    // rolled back or blocked B's progress in the same tick. Under the OLD single-big-transaction
    // design this assertion would fail: A's uncaught throw would have unwound the whole org's one
    // transaction, taking B's write down with it (and leaving B's already-fired trigger() call
    // duplicated on the next tick too).
    expect(targetBRow1!.status).toBe("triggered");
    expect(targetBRow1!.executorRef).not.toBeNull();

    // Tick 2: A's target (still `triggering`) is retried with the SAME idempotencyKey; nothing
    // faults it this time, so it commits.
    await reconcileOrgTick(server.deps.db, org.orgId, host);

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
    const liveStatus: ExecutionStatus = await host.executor(DEFAULT_EXECUTOR_INSTANCE_ID).status(executorRef);
    // v0, not v1 — a mutation that broke the dedup contract (e.g. re-minting a fresh run on every
    // retry) would bump this.
    expect(liveStatus.stateRef).toBe("v0");
  });
});

/**
 * MAJOR #6 (PR #7 review — "batch starvation"): `listChangeRowsInStates` orders `executing`
 * changes oldest-`updated_at`-first, capped at `BATCH_LIMIT` (25). A change parked in `executing`
 * with a `failed` wave never otherwise touches `changes` again on its own, so `updated_at` stays
 * frozen — 25+ such parked changes would sort ahead of every newer, genuinely-progressing
 * `executing` change and starve it out of every batch forever.
 */
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
      await transitionChange(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        toState: "evaluated",
        actorObjectId: org.orgId,
        requestId: "batch-fairness-test"
      });
      const plan = await compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds,
        topologyObjectId: null,
        topologyVersion: null
      });
      await transitionChange(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        toState: "coordinated",
        actorObjectId: org.orgId,
        requestId: "batch-fairness-test"
      });
      await transitionChange(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        toState: "executing",
        actorObjectId: org.orgId,
        requestId: "batch-fairness-test"
      });
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
    const createFreshTarget = await server.app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "fresh-target" }
    });
    expect(createFreshTarget.statusCode).toBe(201);
    const freshTargetId = createFreshTarget.json().id as string;

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
    await reconcileOrgTick(server.deps.db, org.orgId, host);

    const targets = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, freshTargetId))
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("triggered");
  }, 30_000);
});

/**
 * CRITICAL #1 (PR #7 review — "watchdog never runs in production"): `runWatchdogSweep` had no
 * non-test caller; `main.ts` scheduled the reconcile loop but never the watchdog. This proves the
 * sweep actually executes on a RUNNING WORKER (via `listenTestServer`'s `withReconcileLoop`, which
 * now also starts `startWatchdogLoop` — see harness.ts's doc comment) rather than only when called
 * directly, the way the pre-existing "coordination engine: watchdog" suite above does.
 */
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
      // A normal change, let the ACTIVE reconcile loop (also running on this "worker") drive it
      // all the way to `validating` — a stable resting state the loop never advances past on its
      // own (a human `scp change promote` is required). That's what makes this different from
      // just backdating a freshly-proposed change: with the reconcile loop genuinely running
      // alongside the watchdog, a change left in `proposed` would just get advanced normally
      // before the watchdog ever got a look at it. `validating` is where a real, actively-managed
      // worker can genuinely leave a change stalled.
      const createTarget = await server.app.inject({
        method: "POST",
        url: "/api/v1/components",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: { name: "watchdog-scheduled-target" }
      });
      expect(createTarget.statusCode).toBe(201);
      const targetId = createTarget.json().id as string;

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
