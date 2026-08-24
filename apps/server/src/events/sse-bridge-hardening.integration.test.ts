import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/client.js";
import { sseHub, type RelayedEvent } from "./sse-hub.js";
import { startSseBridge } from "./sse-bridge.js";
import {
  buildTestServer,
  createTestOrg,
  testDatabaseUrl,
  testRuntimeDatabaseUrl,
  waitUntil,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * M26.1 review hardening gates for the SSE bridge (findings SEC-1 work-gate, SEC-2 replay, SSE-2
 * teardown drain). Each pins a property whose absence let the finding ship, and each is written to
 * go RED under the exact mutation that reintroduces the defect. The NOTIFY payload is the relay's
 * pointer `{id, orgId}`; here we insert the authoritative outbox row directly and drive the pointer
 * ourselves, so the tests exercise the bridge in isolation from the relay (buildTestServer starts
 * no background relay/bridge).
 */
interface PoolControl {
  connectCount: number;
  /** When set, the outbox SELECT awaits this before running — used to hold a fetch in flight. */
  outboxSelectGate: Promise<void> | null;
  /** Flipped true the moment an outbox SELECT is reached (before it awaits the gate). */
  outboxSelectReached: boolean;
}

/** Wraps a real pool so the test can count `connect()` calls and hold the outbox SELECT open. */
function instrumentPool(pool: pg.Pool, control: PoolControl): pg.Pool {
  const originalConnect = pool.connect.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connect = async (...args: any[]) => {
    control.connectCount += 1;
    const client = await (originalConnect as (...a: unknown[]) => Promise<pg.PoolClient>)(...args);
    const originalQuery = client.query.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).query = async (text: any, ...rest: any[]) => {
      if (typeof text === "string" && text.includes("FROM outbox")) {
        control.outboxSelectReached = true;
        if (control.outboxSelectGate) await control.outboxSelectGate;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as (...a: any[]) => any)(text, ...rest);
    };
    return client;
  };
  return pool;
}

function freshControl(): PoolControl {
  return { connectCount: 0, outboxSelectGate: null, outboxSelectReached: false };
}

describe("SSE bridge — M26.1 hardening", () => {
  let server: TestServer;
  let orgWithClient: TestOrg;
  let orgNoClient: TestOrg;
  let admin: pg.Client;

  beforeAll(async () => {
    server = await buildTestServer({ role: "api" });
    orgWithClient = await createTestOrg(server, "hardening-sub");
    orgNoClient = await createTestOrg(server, "hardening-nosub");
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
  }, 90_000);

  afterAll(async () => {
    await admin.end().catch(() => undefined);
    await server.close();
  });

  async function insertOutboxRow(orgId: string, subject: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO outbox (id, org_id, type, source, subject, data, created_at)
       VALUES ($1, $2, 'scp.change.transitioned', 'scp', $3, '{"probe":true}'::jsonb, now())`,
      [id, orgId, subject]
    );
    return id;
  }

  /**
   * Wait until a bridge's dedicated LISTEN backend is actually subscribed before notifying — NOTIFY
   * has no replay, so a frame sent before the LISTEN is established is simply lost, which would make
   * the SEC-1 "no fetch happened" assertion pass VACUOUSLY (nothing arrived, rather than the
   * work-gate skipping it). Same pg_stat_activity probe the reconnect test uses.
   */
  async function waitForBridgeListening(): Promise<void> {
    await waitUntil(
      async () => {
        const res = await admin.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND query ILIKE 'LISTEN scp_sse_events%'`
        );
        return res.rows.length > 0 ? true : undefined;
      },
      { describe: "the SSE bridge's LISTEN connection to be established", timeoutMs: 15_000 }
    );
  }

  it("SEC-1: a NOTIFY for an org with NO locally-connected client does not touch the pool; one for a connected org does", async () => {
    const control = freshControl();
    const pool = instrumentPool(createPool(testRuntimeDatabaseUrl(), { max: 2 }), control);
    const bridge = startSseBridge(pool, server.deps.config.runtimeDatabaseUrl);
    const received: RelayedEvent[] = [];
    const onEvent = (e: RelayedEvent): void => void received.push(e);
    try {
      await waitForBridgeListening();
      const rowId = await insertOutboxRow(orgNoClient.orgId, "sec1-probe");

      // No subscriber for orgNoClient → the work-gate must skip the fetch entirely.
      await admin.query("SELECT pg_notify('scp_sse_events', $1)", [
        JSON.stringify({ id: rowId, orgId: orgNoClient.orgId })
      ]);
      await new Promise((r) => setTimeout(r, 1500));
      expect(
        control.connectCount,
        "a frame for an org with no local subscriber must not open a pool connection"
      ).toBe(0);
      expect(received).toHaveLength(0);

      // Now connect a client for that org and re-notify: the fetch must happen and deliver.
      sseHub.on(orgNoClient.orgId, onEvent);
      await admin.query("SELECT pg_notify('scp_sse_events', $1)", [
        JSON.stringify({ id: rowId, orgId: orgNoClient.orgId })
      ]);
      const evt = await waitUntil(async () => received.find((e) => e.id === rowId), {
        describe: "the event to be delivered once a client for the org is connected",
        timeoutMs: 15_000
      });
      expect(evt.orgId).toBe(orgNoClient.orgId);
      expect(control.connectCount).toBeGreaterThan(0);
    } finally {
      sseHub.off(orgNoClient.orgId, onEvent);
      await bridge.stop();
      await pool.end();
    }
  }, 40_000);

  it("SEC-2: a replayed pointer to a real, already-delivered outbox row is not delivered twice", async () => {
    const control = freshControl();
    const pool = instrumentPool(createPool(testRuntimeDatabaseUrl(), { max: 2 }), control);
    const bridge = startSseBridge(pool, server.deps.config.runtimeDatabaseUrl);
    const received: RelayedEvent[] = [];
    const onEvent = (e: RelayedEvent): void => void received.push(e);
    sseHub.on(orgWithClient.orgId, onEvent);
    try {
      await waitForBridgeListening();
      const rowId = await insertOutboxRow(orgWithClient.orgId, "sec2-probe");

      await admin.query("SELECT pg_notify('scp_sse_events', $1)", [
        JSON.stringify({ id: rowId, orgId: orgWithClient.orgId })
      ]);
      await waitUntil(async () => received.find((e) => e.id === rowId), {
        describe: "the first (legitimate) delivery of the event",
        timeoutMs: 15_000
      });
      expect(received.filter((e) => e.id === rowId)).toHaveLength(1);

      // The replay: same real id (an attacker who learned it, e.g. via pgboss.job). Must be dropped.
      await admin.query("SELECT pg_notify('scp_sse_events', $1)", [
        JSON.stringify({ id: rowId, orgId: orgWithClient.orgId })
      ]);
      await new Promise((r) => setTimeout(r, 2000));
      expect(
        received.filter((e) => e.id === rowId),
        "a replayed id must not re-inject the event into the live stream"
      ).toHaveLength(1);
    } finally {
      sseHub.off(orgWithClient.orgId, onEvent);
      await bridge.stop();
      await pool.end();
    }
  }, 40_000);

  it("SSE-2: stop() does not resolve until an in-flight fetch has settled", async () => {
    const control = freshControl();
    let releaseGate: () => void = () => undefined;
    control.outboxSelectGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const pool = instrumentPool(createPool(testRuntimeDatabaseUrl(), { max: 2 }), control);
    const bridge = startSseBridge(pool, server.deps.config.runtimeDatabaseUrl);
    const received: RelayedEvent[] = [];
    const onEvent = (e: RelayedEvent): void => void received.push(e);
    sseHub.on(orgWithClient.orgId, onEvent);
    try {
      await waitForBridgeListening();
      const rowId = await insertOutboxRow(orgWithClient.orgId, "sse2-probe");
      await admin.query("SELECT pg_notify('scp_sse_events', $1)", [
        JSON.stringify({ id: rowId, orgId: orgWithClient.orgId })
      ]);
      // Wait until the fetch has genuinely reached the (gated) outbox SELECT and is in flight.
      await waitUntil(async () => (control.outboxSelectReached ? true : undefined), {
        describe: "the outbox fetch to be in flight",
        timeoutMs: 15_000
      });

      let stopResolved = false;
      const stopP = bridge.stop().then(() => {
        stopResolved = true;
      });
      // stop() must be blocked on the in-flight fetch, not resolve out from under it.
      await new Promise((r) => setTimeout(r, 500));
      expect(
        stopResolved,
        "stop() must await the in-flight fetch before resolving (else the pool could be torn down mid-query)"
      ).toBe(false);

      // Releasing the fetch lets it settle, which lets stop() resolve.
      releaseGate();
      await stopP;
      expect(stopResolved).toBe(true);
    } finally {
      releaseGate();
      sseHub.off(orgWithClient.orgId, onEvent);
      await pool.end().catch(() => undefined);
    }
  }, 40_000);
});
