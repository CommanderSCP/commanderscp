import pg from "pg";
import type PgBoss from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { createPool } from "../db/client.js";
import { eventBus } from "./event-bus.js";
import { startPgBoss } from "./pgboss.js";
import { startOutboxRelay, type OutboxRelayHandle } from "./outbox-relay.js";
import type { NatsFanoutHandle } from "./nats-fanout.js";
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
 * CRITICAL #5 (PR #7 review — "relay can permanently drop a NATS-bound event"): the relay must
 * never mark an outbox row `processed_at` until EVERY sink configured for `eventBusBackend` has
 * actually accepted it. Uses a controllable fake `NatsFanoutHandle` (not a real NATS
 * Testcontainer — events/event-bus.integration.test.ts already proves real JetStream parity; this
 * suite is about OUR relay code's mark-after-all-sinks guarantee specifically, independent of
 * real broker behavior) whose `publish()` can be toggled to fail on demand.
 */
describe("outbox-relay: never marks a NATS-bound event processed unless the JetStream publish succeeded", () => {
  let server: TestServer;
  let org: TestOrg;
  let boss: PgBoss;
  let relayPool: pg.Pool;
  let adminClient: pg.Client;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "outbox-relay-nats");
    boss = await startPgBoss(testPgBossDatabaseUrl());
    relayPool = createPool(testRuntimeDatabaseUrl());
    adminClient = new pg.Client({ connectionString: testDatabaseUrl() });
    await adminClient.connect();
  });

  afterAll(async () => {
    await adminClient.end();
    await relayPool.end();
    await boss.stop({ graceful: false, timeout: 500 }).catch(() => undefined);
    await server.close();
  });

  let relay: OutboxRelayHandle | undefined;
  afterEach(async () => {
    await relay?.stop();
    relay = undefined;
  });

  it("construction fails loudly (never silently degrades) when eventBusBackend is 'nats' but no natsFanout handle was given", () => {
    expect(() =>
      startOutboxRelay(relayPool, server.deps.config.runtimeDatabaseUrl, boss, {
        eventBusBackend: "nats"
      })
    ).toThrow(/requires a connected natsFanout handle/);
  });

  it("a JetStream publish failure leaves the row unprocessed on every retry; once the sink recovers, the SAME row is delivered and marked processed", async () => {
    // Hermetic starting point (this is a SHARED-Postgres, singleFork suite): every test file that
    // creates objects writes outbox rows, and most of them run NO relay, so a large backlog of
    // permanently-unprocessed rows accumulates ahead of anything this test publishes. The relay
    // drains that backlog OLDEST-first, 100 rows per ~1s poll — so without this pre-clean, once the
    // NATS sink "recovers" below the relay would have to grind through hundreds of stale backlog
    // rows before it ever reaches our probe, blowing the recovery timeout (the exact flake this
    // fixes). Marking the pre-existing backlog processed makes our probe the ONLY pending row, so
    // the relay's behaviour is deterministic and every `publishCalls` entry is genuinely about our
    // probe. It does NOT weaken the assertions: the "stays unprocessed while failing" half still
    // catches a mutation that marked rows processed on failure.
    await adminClient.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);

    let shouldFail = true;
    const publishCalls: string[] = [];
    const fakeFanout: NatsFanoutHandle = {
      async publish(event) {
        publishCalls.push(event.id);
        if (shouldFail) throw new Error("injected NATS publish failure (test only)");
      },
      async close() {
        // no-op — nothing real to tear down.
      }
    };

    // Publish the probe BEFORE starting the relay so the relay's very first batch is exactly this
    // one row (belt-and-braces on top of the pre-clean above).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      eventBus.publish(tx, {
        orgId: org.orgId,
        type: "scp.outbox_relay_test.nats_failure",
        source: "/events/outbox-relay.integration.test",
        subject: "nats-failure-probe",
        data: { probe: true }
      })
    );
    // `writeOutboxEvent` mints the row's id internally and doesn't return it — fetch it back by
    // its distinguishing subject.
    const written = await adminClient.query<{ id: string }>(
      `SELECT id FROM outbox WHERE subject = 'nats-failure-probe' ORDER BY created_at DESC LIMIT 1`
    );
    const eventId = written.rows[0]!.id;

    relay = startOutboxRelay(relayPool, server.deps.config.runtimeDatabaseUrl, boss, {
      eventBusBackend: "nats",
      natsFanout: fakeFanout
    });

    // Wait for the relay to have genuinely ATTEMPTED delivery of OUR probe (ruling out the
    // false-negative of "it just never got picked up yet") — the relay's immediate on-start
    // trigger plus its 1s poll/NOTIFY wakeup make this fast, and with the backlog cleared the only
    // row it can be attempting is the probe.
    await waitUntil(async () => (publishCalls.includes(eventId) ? true : undefined), {
      describe: "the relay attempted the JetStream publish of the probe row at least once",
      timeoutMs: 5_000
    });

    // Give the relay several more retry cycles — the row must stay unprocessed through every one
    // of them, not just the first — and every publish attempt must be for our probe (the backlog
    // is gone, so nothing else is in play).
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const stillUnprocessed = await adminClient.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM outbox WHERE id = $1`,
      [eventId]
    );
    expect(stillUnprocessed.rows[0]?.processed_at).toBeNull();
    expect(publishCalls.filter((id) => id === eventId).length).toBeGreaterThan(1);
    expect(publishCalls.every((id) => id === eventId)).toBe(true);

    // The sink recovers — the relay's next retry of the SAME row (driven by its 1s poll, no
    // explicit wakeup needed) should now succeed all the way through and commit `processed_at`.
    shouldFail = false;
    await waitUntil(
      async () => {
        const result = await adminClient.query<{ processed_at: Date | null }>(
          `SELECT processed_at FROM outbox WHERE id = $1`,
          [eventId]
        );
        return result.rows[0]?.processed_at ? result.rows[0] : undefined;
      },
      { describe: "the outbox row is marked processed once the NATS sink recovers", timeoutMs: 5_000 }
    );
  }, 20_000);
});
