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
 * THE CROSS-PROCESS PROOF (proposal multi-region-instance-resilience.md §7.1 item 1, closing
 * §4-A1). The relay and the bridge here run against SEPARATE `pg.Pool`s / separate dedicated LISTEN
 * connections — deliberately mirroring outbox-relay.integration.test.ts's own convention for
 * simulating "two processes sharing one Postgres" — so the only channel between them is the
 * `scp_sse_events` NOTIFY this suite exists to prove. Both still run in one Node process (as every
 * integration test here does; there is no real OS process boundary to cross in a test), but that is
 * exactly the same honest simplification `outbox-relay.integration.test.ts` already makes: the
 * thing under test is the POSTGRES boundary, not an OS one.
 */
describe("SSE bridge: relay -> pg_notify(scp_sse_events) -> bridge -> sseHub", () => {
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
    org = await createTestOrg(server, "sse-bridge");
    boss = await startPgBoss(testPgBossDatabaseUrl());
    relayPool = createPool(testRuntimeDatabaseUrl());
    bridgePool = createPool(testRuntimeDatabaseUrl());
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
    await adminClient.end();
    await relayPool.end();
    await bridgePool.end();
    await boss.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
    await server.close();
  });

  it("a row written through the public outbox path is delivered to a subscriber on the BRIDGE's hub — fails if either NOTIFY leg is removed", async () => {
    // Hermetic starting point (shared-Postgres suite, same reasoning as
    // outbox-relay.integration.test.ts): drain whatever backlog earlier tests in this worker's
    // database left behind so the relay reaches THIS probe promptly.
    await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);

    const received: RelayedEvent[] = [];
    const onEvent = (evt: RelayedEvent): void => {
      if (evt.subject === "sse-bridge-probe") received.push(evt);
    };
    sseHub.on(org.orgId, onEvent);
    try {
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        eventBus.publish(tx, {
          orgId: org.orgId,
          type: "scp.sse_bridge_test.delivered",
          source: "/events/sse-bridge.integration.test",
          subject: "sse-bridge-probe",
          data: { probe: true }
        })
      );

      const event = await waitUntil(
        async () => received.find((e) => e.subject === "sse-bridge-probe"),
        {
          describe: `the bridge to deliver the relayed event to its local sseHub for org ${org.orgId}`,
          timeoutMs: 15_000
        }
      );
      expect(event.type).toBe("scp.sse_bridge_test.delivered");
      expect(event.orgId).toBe(org.orgId);
    } finally {
      sseHub.off(org.orgId, onEvent);
    }
  }, 30_000);

  it("an event far larger than the NOTIFY payload cap round-trips whole via the pointer + SET LOCAL ROLE scp_relay fetch path", async () => {
    await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);

    const received: RelayedEvent[] = [];
    const onEvent = (evt: RelayedEvent): void => {
      if (evt.subject === "sse-bridge-oversized-probe") received.push(evt);
    };
    sseHub.on(org.orgId, onEvent);
    try {
      // Comfortably over Postgres's ~8000-byte NOTIFY payload cap once wrapped in the full
      // RelayedEvent envelope. Since F1 the payload is always a tiny {id, orgId} pointer and the
      // bridge always fetches the row, so event size cannot hit the cap — this pins exactly that.
      const bigBlob = "x".repeat(8_000);
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        eventBus.publish(tx, {
          orgId: org.orgId,
          type: "scp.sse_bridge_test.oversized",
          source: "/events/sse-bridge.integration.test",
          subject: "sse-bridge-oversized-probe",
          data: { blob: bigBlob }
        })
      );

      const event = await waitUntil(
        async () => received.find((e) => e.subject === "sse-bridge-oversized-probe"),
        {
          describe: `the bridge to fetch and deliver the oversized event for org ${org.orgId} via the marker path`,
          timeoutMs: 15_000
        }
      );
      expect((event.data as { blob: string }).blob).toHaveLength(8_000);
    } finally {
      sseHub.off(org.orgId, onEvent);
    }
  }, 30_000);

  it("reconnects after its LISTEN connection is killed: re-LISTENs, publishes a resync, and keeps delivering afterward", async () => {
    const received: RelayedEvent[] = [];
    const onEvent = (evt: RelayedEvent): void => {
      received.push(evt);
    };
    sseHub.on(org.orgId, onEvent);
    try {
      // The bridge's dedicated LISTEN connection is identifiable by the literal query it issued and
      // never issues again (startReconnectingListenClient's connect() runs exactly one `LISTEN
      // scp_sse_events` per connection and nothing else on that client) — Postgres retains the last
      // query text for an idle backend in `pg_stat_activity.query`. Scoped to this worker's own
      // database (vitest.integration.config.ts: one private database per test FILE).
      const findListenerPid = () =>
        adminClient.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND query ILIKE 'LISTEN scp_sse_events%'`
        );

      const before = await findListenerPid();
      expect(
        before.rows,
        "exactly one backend should be holding this bridge's LISTEN"
      ).toHaveLength(1);
      await adminClient.query(`SELECT pg_terminate_backend($1)`, [before.rows[0]!.pid]);

      // Reconnection is observed as a `scp.sse.resync` frame arriving on this ALREADY-connected
      // subscriber: `startSseBridge`'s `onReconnect` fires only after `connect()` AND every LISTEN
      // re-issue succeeded (events/listen-client.ts), so seeing this frame IS the direct observation
      // of "reconnected and re-LISTENed" — not an inference from a timeout.
      await waitUntil(async () => received.find((e) => e.type === "scp.sse.resync"), {
        describe:
          "the bridge to reconnect and publish a resync event after its LISTEN connection was killed",
        timeoutMs: 15_000
      });

      const after = await findListenerPid();
      expect(after.rows).toHaveLength(1);
      expect(
        after.rows[0]!.pid,
        "a genuinely NEW backend must hold the LISTEN — proves reconnection, not survival of the killed one"
      ).not.toBe(before.rows[0]!.pid);

      // And the reconnected LISTEN actually delivers: a fresh event still reaches the hub.
      await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        eventBus.publish(tx, {
          orgId: org.orgId,
          type: "scp.sse_bridge_test.post_reconnect",
          source: "/events/sse-bridge.integration.test",
          subject: "sse-bridge-post-reconnect-probe",
          data: { probe: true }
        })
      );
      await waitUntil(
        async () => received.find((e) => e.subject === "sse-bridge-post-reconnect-probe"),
        {
          describe:
            "a post-reconnect outbox event to be delivered through the re-established LISTEN",
          timeoutMs: 15_000
        }
      );
    } finally {
      sseHub.off(org.orgId, onEvent);
    }
  }, 30_000);
});

/**
 * THE WIRING PROOF. `main.ts` starts `startSseBridge` for EVERY role because `app.listen()` there
 * is itself unconditional — an api-role process genuinely serves `GET /events/stream` and has
 * nothing else that can ever feed its `sseHub` now that the relay's direct `sseHub.publish` call is
 * gone (outbox-relay.ts's doc comment). This test calls that SAME production function
 * (`startSseBridge`) directly against a `role=api` server — the idiom
 * `plugin-host/host-bootstrap.integration.test.ts` established for exactly this shape of proof
 * ("these tests therefore call the PRODUCTION wiring directly rather than relying on the harness")
 * — and, unlike that precedent, demonstrates the NEGATIVE case in the same run: an api-role process
 * with a real relay running elsewhere but NO bridge started against it receives nothing, and the
 * identical event published afterward IS received the moment `startSseBridge` is called. Removing
 * the `startSseBridge(...)` call from this test (as opposed to from `main.ts`, which is the one
 * link every loop-wiring test in this tree still accepts checking only as text —
 * background-work.ts's own doc comment says so) turns the SECOND assertion into a timeout.
 */
describe("wiring: an api-role process depends ENTIRELY on the bridge for sseHub delivery", () => {
  it("receives nothing before startSseBridge is called, and the SAME event type immediately after", async () => {
    const apiServer = await buildTestServer({ role: "api" });
    const org = await createTestOrg(apiServer, "sse-bridge-wiring");
    const boss = await startPgBoss(testPgBossDatabaseUrl());
    const relayPool = createPool(testRuntimeDatabaseUrl());
    const bridgePool = createPool(testRuntimeDatabaseUrl());
    const adminClient = new pg.Client({ connectionString: testDatabaseUrl() });
    await adminClient.connect();

    const relay = startOutboxRelay(relayPool, apiServer.deps.config.runtimeDatabaseUrl, boss, {
      eventBusBackend: "postgres"
    });

    const received: RelayedEvent[] = [];
    const onEvent = (evt: RelayedEvent): void => {
      received.push(evt);
    };
    sseHub.on(org.orgId, onEvent);

    let bridge: SseBridgeHandle | undefined;
    try {
      await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);

      await withTenantTx(apiServer.deps.db, org.orgId, (tx) =>
        eventBus.publish(tx, {
          orgId: org.orgId,
          type: "scp.sse_bridge_wiring_test.pre_bridge",
          source: "/events/sse-bridge.integration.test",
          subject: "sse-bridge-wiring-pre",
          data: { probe: true }
        })
      );
      // POSITIVE SIGNAL for a negative assertion (integration-sleep-census.test.ts's property): the
      // relay stamps `processed_at` when it has relayed the row, and the removed direct-publish
      // path ran BEFORE that stamp inside the same relayOnce() — so once the stamp is visible,
      // a still-empty `received` proves the old path is gone, with no fixed budget to go vacuous
      // under contention or spuriously red on a slow box.
      await waitUntil(
        async () => {
          const res = await adminClient.query<{ processed_at: Date | null }>(
            `SELECT processed_at FROM outbox WHERE subject = 'sse-bridge-wiring-pre'`
          );
          return res.rows[0]?.processed_at ? true : undefined;
        },
        { describe: "the relay to mark the pre-bridge outbox row processed", timeoutMs: 15_000 }
      );
      expect(
        received.find((e) => e.subject === "sse-bridge-wiring-pre"),
        "an api-role process with no bridge started must NOT receive relayed events — this is what " +
          "proves the relay's old direct-publish path is actually gone, not merely untested"
      ).toBeUndefined();

      bridge = startSseBridge(bridgePool, apiServer.deps.config.runtimeDatabaseUrl);

      await withTenantTx(apiServer.deps.db, org.orgId, (tx) =>
        eventBus.publish(tx, {
          orgId: org.orgId,
          type: "scp.sse_bridge_wiring_test.post_bridge",
          source: "/events/sse-bridge.integration.test",
          subject: "sse-bridge-wiring-post",
          data: { probe: true }
        })
      );
      const event = await waitUntil(
        async () => received.find((e) => e.subject === "sse-bridge-wiring-post"),
        {
          describe:
            "the SAME api-role process's sseHub to receive the event once startSseBridge is called",
          timeoutMs: 15_000
        }
      );
      expect(event.type).toBe("scp.sse_bridge_wiring_test.post_bridge");
    } finally {
      sseHub.off(org.orgId, onEvent);
      await bridge?.stop();
      await relay.stop();
      await adminClient.end();
      await boss.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
      await relayPool.end();
      await bridgePool.end();
      await apiServer.close();
    }
  }, 40_000);
});
