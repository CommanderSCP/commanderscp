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
  waitForSseBridgeListening,
  waitUntil,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/** §7.5 FAILOVER DRILL. See docs/events.md §20. */
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
    // NOTIFY has no replay and the bridge's LISTEN comes up asynchronously — publishing before it is
    // established loses the event permanently. Also load-bearing for the kill below: the drill
    // asserts it terminated >=2 LISTEN backends, which requires them to exist first.
    await waitForSseBridgeListening(adminClient);
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

  it("delivers before the failover, survives pg_terminate of BOTH LISTEN backends, and delivers again exactly once", async () => {
    await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const received: RelayedEvent[] = [];
    const onEvent = (e: RelayedEvent): void => {
      if (e.type === "scp.failover_drill.probe") received.push(e);
    };
    sseHub.on(org.orgId, onEvent);
    try {
      await publishProbe("pre-failover");
      await waitUntil(async () => received.find((e) => e.subject === "pre-failover"), {
        describe: "the pre-failover probe to be delivered through relay→bridge",
        timeoutMs: 15_000
      });

      // THE FAILOVER: terminate BOTH long-lived LISTEN backends. See docs/events.md §21.
      const killed = await adminClient.query<{ pid: number }>(
        `SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND query ILIKE 'LISTEN scp_%'`
      );
      expect(
        killed.rowCount,
        "both LISTEN backends (relay wake + SSE bridge) must have been found and terminated — if this is 0 the drill proves nothing"
      ).toBeGreaterThanOrEqual(2);

      // WAIT FOR THE BRIDGE TO BE LISTENING AGAIN BEFORE PUBLISHING. See docs/events.md §22.
      const killedPids = killed.rows.map((r) => r.pid);
      await waitUntil(
        async () => {
          const res = await adminClient.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database() AND query ILIKE 'LISTEN scp_sse_events%'
               AND pid <> ALL($1::int[])`,
            [killedPids]
          );
          return res.rows.length > 0 ? true : undefined;
        },
        {
          describe:
            "the SSE bridge to re-establish a NEW LISTEN backend after the failover (NOTIFY has no replay, so publishing before this is a lost-event race)",
          timeoutMs: 20_000
        }
      );

      // RECOVERY: a fresh event published after the blip must still flow end to end (the relay poll
      // fallback + the reconnecting LISTEN clients bring everything back), delivered EXACTLY ONCE.
      await publishProbe("post-failover");
      await waitUntil(async () => received.find((e) => e.subject === "post-failover"), {
        describe:
          "the post-failover probe to be delivered after both LISTEN backends were terminated",
        timeoutMs: 20_000
      });
      // POSITIVE SIGNAL rather than a settle sleep. See docs/events.md §23.
      await publishProbe("post-failover-barrier");
      await waitUntil(async () => received.find((e) => e.subject === "post-failover-barrier"), {
        describe:
          "a third probe to be delivered — the ordered barrier for the no-duplicate assertion",
        timeoutMs: 20_000
      });
      expect(received.filter((e) => e.subject === "pre-failover")).toHaveLength(1);
      expect(received.filter((e) => e.subject === "post-failover")).toHaveLength(1);
      expect(received.filter((e) => e.subject === "post-failover-barrier")).toHaveLength(1);
    } finally {
      sseHub.off(org.orgId, onEvent);
    }
  }, 60_000);
});
