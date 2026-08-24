import pg from "pg";
import type PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { createPool } from "../db/client.js";
import { eventBus } from "./event-bus.js";
import { sseHub, type RelayedEvent } from "./sse-hub.js";
import { startPgBoss } from "./pgboss.js";
import { startOutboxRelay, type OutboxRelayHandle } from "./outbox-relay.js";
import { startSseBridge, type SseBridgeHandle } from "./sse-bridge.js";
import {
  buildTestServer,
  createTestOrg,
  testDatabaseUrl,
  testPgBossDatabaseUrl,
  testRuntimeDatabaseUrl,
  waitUntil,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * §7.5 FAILOVER DRILL — the whole outbox→NOTIFY→bridge→sseHub delivery path must SURVIVE a Postgres
 * connection loss mid-flight and keep delivering, exactly once. A member cluster far from the primary
 * (or one whose primary just failed over) loses every backend at once; this drill reproduces that
 * with `pg_terminate_backend` of ALL the drill's own connections (deterministic, unlike a container
 * restart), then asserts a post-failover event still flows end to end and is delivered ONCE — proving
 * the M26.1 reconnecting relay wake-listener (§4-A5) + sse-bridge reconnect (§7.1.1) + fast-fail pool
 * timeouts (§4-A6) actually recover as designed. (Fork/duplicate under concurrency is separately
 * gated by divergence-rails, reconcile-startup-singleton and watchdog-race.)
 */
describe("§7.5 failover drill: outbox→bridge delivery survives a mid-flight backend loss, once", () => {
  let server: TestServer;
  let org: TestOrg;
  let boss: PgBoss;
  let relayPool: pg.Pool;
  let bridgePool: pg.Pool;
  let adminClient: pg.Client;
  let relay: OutboxRelayHandle;
  let bridge: SseBridgeHandle;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "failover-drill");
    boss = await startPgBoss(testPgBossDatabaseUrl());
    relayPool = createPool(testRuntimeDatabaseUrl());
    bridgePool = createPool(testRuntimeDatabaseUrl(), { max: 2 });
    adminClient = new pg.Client({ connectionString: testDatabaseUrl() });
    await adminClient.connect();
    relay = startOutboxRelay(relayPool, server.deps.config.runtimeDatabaseUrl, boss, {
      eventBusBackend: "postgres"
    });
    bridge = startSseBridge(bridgePool, server.deps.config.runtimeDatabaseUrl);
  }, 60_000);

  afterAll(async () => {
    await bridge.stop();
    await relay.stop();
    await adminClient.end().catch(() => undefined);
    await relayPool.end();
    await bridgePool.end();
    await boss.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
    await server.close();
  });

  async function publishProbe(subject: string): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      eventBus.publish(tx, {
        orgId: org.orgId,
        type: "scp.failover_drill.probe",
        source: "/events/failover-drill",
        subject,
        data: { probe: true }
      })
    );
  }

  it("delivers before the failover, survives pg_terminate of ALL backends, and delivers again exactly once", async () => {
    await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const received: RelayedEvent[] = [];
    const onEvent = (e: RelayedEvent): void => {
      if (e.type === "scp.failover_drill.probe") received.push(e);
    };
    sseHub.on(org.orgId, onEvent);
    try {
      // Baseline: the path works end to end.
      await publishProbe("pre-failover");
      await waitUntil(async () => received.find((e) => e.subject === "pre-failover"), {
        describe: "the pre-failover probe to be delivered through relay→bridge",
        timeoutMs: 15_000
      });

      // THE FAILOVER: terminate every backend on this worker's database. The relay's wake listener,
      // the bridge's LISTEN client, and both pools all lose their connections at once.
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`
      );

      // RECOVERY: a fresh event published after the blip must still flow end to end (the relay poll
      // fallback + the reconnecting LISTEN clients bring everything back), delivered EXACTLY ONCE.
      await publishProbe("post-failover");
      await waitUntil(async () => received.find((e) => e.subject === "post-failover"), {
        describe: "the post-failover probe to be delivered after every backend was terminated",
        timeoutMs: 20_000
      });
      // Give any duplicate a generous window to (wrongly) arrive, then assert exactly one of each.
      await new Promise((r) => setTimeout(r, 1500));
      expect(received.filter((e) => e.subject === "pre-failover")).toHaveLength(1);
      expect(received.filter((e) => e.subject === "post-failover")).toHaveLength(1);
    } finally {
      sseHub.off(org.orgId, onEvent);
    }
  }, 60_000);
});
