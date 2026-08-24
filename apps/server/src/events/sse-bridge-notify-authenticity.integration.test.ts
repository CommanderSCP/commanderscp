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
  waitUntil,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * SECURITY CONTRACT (M26.1 review finding F1 — fixed; this test is the standing gate).
 *
 * Postgres NOTIFY is not channel-access-controlled: any role that can merely CONNECT can
 * `pg_notify('scp_sse_events', …)` — including `scp_pgboss`, which is deliberately granted NOTHING
 * on `outbox` precisely so a pg-boss compromise cannot read tenant data. The bridge's original
 * full-envelope fast path validated the payload's SHAPE, not its AUTHENTICITY, and keyed delivery
 * on the payload's OWN `orgId` — letting any DB login fabricate an event for any tenant's live SSE
 * stream (a cross-tenant integrity regression the M26.1 cross-process bridge introduced).
 *
 * The contract pinned here: the NOTIFY payload is a POINTER, never authority. The relay NOTIFYs an
 * id (+ orgId as a non-authoritative hint), and the bridge ALWAYS re-derives the event from the
 * authoritative `outbox` row under `SET LOCAL ROLE scp_relay` — one fetch path for every event, so
 * a frame no outbox row backs delivers nothing, to anyone.
 */
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

      // POSITIVE SIGNAL for a negative assertion (integration-sleep-census.test.ts's property — a
      // fixed sleep here would be both flaky on a loaded box and vacuous on an idle one). Instead:
      // send a GENUINE frame, backed by a real outbox row, immediately after the forgery. NOTIFY is
      // ordered per channel and the bridge consumes one LISTEN connection in order, so the moment the
      // genuine event arrives, the forged frame has DEFINITIVELY already been processed — and dropped.
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
