import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/client.js";
import { sseHub, type RelayedEvent } from "./sse-hub.js";
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

/** The security contract, and this test is its standing guard. See docs/events.md §49. */
describe("SSE bridge — NOTIFY payload authenticity", () => {
  let server: TestServer;
  let orgB: TestOrg;
  let bridgePool: pg.Pool;
  let bridge: SseBridgeHandle;
  let attacker: pg.Client;
  let admin: pg.Client;

  beforeAll(async () => {
    server = await buildTestServer();
    // A second org exists on the instance (the realistic multi-tenant setting the forgery targets
    // across) — created, deliberately not referenced: every assertion below is about org B.
    await createTestOrg(server, "authn-a");
    orgB = await createTestOrg(server, "authn-b");
    bridgePool = createPool(testRuntimeDatabaseUrl());
    bridge = startSseBridge(bridgePool, server.deps.config.runtimeDatabaseUrl);
    // The pg-boss role: LOGIN, owns only the `pgboss` schema, no grants on `public` at all
    // (db/provision.ts) — it cannot read one byte of `outbox`, yet it CAN issue NOTIFY.
    attacker = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await attacker.connect();
    // Writes the REAL outbox row whose delivery is this test's positive signal (see below).
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    // The listen is established asynchronously and has no replay. See docs/events.md §50.
    await waitForSseBridgeListening(admin);
  }, 90_000);

  afterAll(async () => {
    await attacker.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await bridge.stop();
    await bridgePool.end();
    await server.close();
  });

  it("the attacker role really has no read access to outbox (threat-model precondition)", async () => {
    await expect(attacker.query("SELECT count(*) FROM outbox")).rejects.toThrow(
      /permission denied|does not exist/i
    );
  });

  it("does NOT deliver a fabricated, outbox-unbacked NOTIFY frame to the spoofed org's hub channel", async () => {
    const received: RelayedEvent[] = [];
    const onB = (e: RelayedEvent): void => void received.push(e);
    sseHub.on(orgB.orgId, onB);
    const forgedId = randomUUID();
    try {
      const forged = {
        id: forgedId,
        orgId: orgB.orgId, // spoofed — must never be trusted as the delivery key
        type: "scp.change.transitioned",
        source: "scp",
        subject: "totally-made-up",
        data: { state: "released", note: "no outbox row backs this" },
        createdAt: new Date().toISOString()
      };
      await attacker.query("SELECT pg_notify('scp_sse_events', $1)", [JSON.stringify(forged)]);

      // POSITIVE SIGNAL for a negative assertion. See docs/events.md §51.
      const realId = randomUUID();
      await admin.query(
        `INSERT INTO outbox (id, org_id, type, source, subject, data, created_at)
         VALUES ($1, $2, 'scp.change.transitioned', 'scp', 'authenticity-positive-signal', '{}'::jsonb, now())`,
        [realId, orgB.orgId]
      );
      await admin.query("SELECT pg_notify('scp_sse_events', $1)", [
        JSON.stringify({ id: realId, orgId: orgB.orgId })
      ]);
      await waitUntil(async () => received.find((e) => e.id === realId), {
        describe:
          "the genuine (outbox-backed) frame sent AFTER the forgery to arrive — the ordered barrier proving the forged frame was already processed",
        timeoutMs: 15_000
      });

      const leaked = received.find((e) => e.id === forgedId);
      expect(leaked).toBeUndefined();
    } finally {
      sseHub.off(orgB.orgId, onB);
    }
  }, 40_000);
});
