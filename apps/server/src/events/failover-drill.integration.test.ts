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

/**
 * §7.5 FAILOVER DRILL — the outbox→NOTIFY→bridge→sseHub delivery path must SURVIVE losing its
 * Postgres connections mid-flight and keep delivering, exactly once. A promoted primary evicts the
 * long-lived LISTEN connections this path depends on; the drill reproduces that by
 * `pg_terminate_backend`-ing BOTH of them by pid (deterministic, unlike a container restart — and
 * scoped rather than a blanket kill, for the flakiness reason documented at the kill site), then
 * asserts a post-failover event still flows end to end and is delivered ONCE — proving the M26.1
 * reconnecting relay wake-listener (§4-A5) + sse-bridge reconnect (§7.1.1) + the pool error handler
 * and fast-fail timeouts (§4-A6, db/client.ts) actually recover as designed. The kill itself is
 * asserted (≥2 backends terminated), so the drill cannot pass vacuously by finding nothing to kill.
 * (Fork/duplicate under concurrency is separately gated by divergence-rails,
 * reconcile-startup-singleton and watchdog-race.)
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
      // Baseline: the path works end to end.
      await publishProbe("pre-failover");
      await waitUntil(async () => received.find((e) => e.subject === "pre-failover"), {
        describe: "the pre-failover probe to be delivered through relay→bridge",
        timeoutMs: 15_000
      });

      // THE FAILOVER: terminate BOTH long-lived LISTEN backends — the relay's wake listener
      // (`scp_outbox_insert`) and the SSE bridge's (`scp_sse_events`). These are precisely the
      // connections a promoted primary evicts and precisely what the M26.1 reconnecting LISTEN client
      // (§4-A5, §7.1.1) exists to survive; killing them is what makes this a failover drill rather
      // than a delivery test.
      //
      // DELIBERATELY NOT a blanket kill of every backend (or of every `scp_app` backend). Both wider
      // forms also evict pg-boss and the harness's own runtime pool, which then reconnect-storm
      // against a database the NEXT run is trying to re-create — measured as `Hook timed out in
      // 60000ms` in `beforeAll` on 1-of-2 and then 1-of-5 consecutive runs. A test that reds CI a
      // fifth of the time teaches people to ignore CI, so the blast radius is scoped to the
      // connections whose recovery is the actual claim.
      const killed = await adminClient.query<{ pid: number }>(
        `SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND query ILIKE 'LISTEN scp_%'`
      );
      expect(
        killed.rowCount,
        "both LISTEN backends (relay wake + SSE bridge) must have been found and terminated — if this is 0 the drill proves nothing"
      ).toBeGreaterThanOrEqual(2);

      // WAIT FOR THE BRIDGE TO BE LISTENING AGAIN BEFORE PUBLISHING. This is not tidiness, it is the
      // difference between testing the product and testing a coin flip: **LISTEN/NOTIFY has no
      // replay**. Both the relay and the bridge were just evicted, and they race to recover
      // independently. If the relay wins, it emits `pg_notify('scp_sse_events', …)` for the probe
      // below while the bridge is still disconnected — and that notification is gone permanently, so
      // the probe is never delivered live no matter how long the test waits.
      //
      // That is CORRECT PRODUCT BEHAVIOUR, not a bug: an event published during a bridge outage is
      // not recoverable from the live stream, which is exactly why reconnecting publishes a resync
      // (ADR-0025) so clients refetch what they missed. Asserting live delivery of an event published
      // mid-outage would assert a guarantee the design deliberately does not make.
      //
      // MEASURED: without this barrier the drill failed in CI with the relay having demonstrably
      // processed the probe (`[worker] domain-events: scp.failover_drill.probe` in the log) while the
      // bridge never saw it. The sibling reconnect test in `sse-bridge.integration.test.ts` passed in
      // the same run precisely because it waits first.
      //
      // The wait EXCLUDES the pids just terminated, so a backend still winding down cannot satisfy it
      // and let the publish through early.
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
        describe: "the post-failover probe to be delivered after both LISTEN backends were terminated",
        timeoutMs: 20_000
      });
      // POSITIVE SIGNAL rather than a settle sleep (integration-sleep-census.test.ts's property): a
      // THIRD probe, published after the first two and awaited. The relay walks the outbox in commit
      // order and NOTIFY is ordered per channel, so once probe three has been delivered, any
      // duplicate of the earlier two would already have arrived — making "exactly one of each" a
      // claim about work that provably finished, not about a wall-clock guess.
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
