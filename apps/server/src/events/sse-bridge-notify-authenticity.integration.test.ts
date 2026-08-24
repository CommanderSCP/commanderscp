import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../db/client.js";
import { sseHub, type RelayedEvent } from "./sse-hub.js";
import { startSseBridge, type SseBridgeHandle } from "./sse-bridge.js";
import {
  buildTestServer,
  createTestOrg,
  testPgBossDatabaseUrl,
  testRuntimeDatabaseUrl,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * SECURITY CONTRACT (M26.1 review finding — EXPECTED RED until the bridge stops trusting the
 * NOTIFY payload as authority; see docs/proposals/M26-BUILD-STATUS.md "F1").
 *
 * `startSseBridge`'s full-envelope fast path (`sse-bridge.ts` — `RelayedEventSchema.safeParse` then
 * `sseHub.publish(result.data)`) validates the payload's SHAPE, not its AUTHENTICITY, and keys the
 * publish on the payload's OWN `orgId`. Postgres NOTIFY is not channel-access-controlled: any role
 * that can merely CONNECT can `pg_notify('scp_sse_events', …)`. So any DB login — including
 * `scp_pgboss`, which is deliberately granted NOTHING on `outbox` precisely so a pg-boss compromise
 * cannot read tenant data — can fabricate a whole event with an org id of its choosing and have the
 * bridge inject it into that tenant's live SSE stream. This is a cross-tenant integrity regression
 * introduced by the M26.1 cross-process bridge; before it, the relay read every event straight from
 * `outbox` (authenticated by the row existing), so no attacker-authored envelope path existed.
 *
 * The fix (F1): the relay NOTIFYs an id (+ orgId as a hint only), and the bridge ALWAYS re-derives
 * the event from the authoritative `outbox` row under `SET LOCAL ROLE scp_relay` — collapsing the
 * small-event and oversized paths into one fetch, so the payload is never the authority. This test
 * pins that contract and flips to green when it lands.
 */
describe("SSE bridge — NOTIFY payload authenticity", () => {
  let server: TestServer;
  let orgA: TestOrg;
  let orgB: TestOrg;
  let bridgePool: pg.Pool;
  let bridge: SseBridgeHandle;
  let attacker: pg.Client;

  beforeAll(async () => {
    server = await buildTestServer();
    orgA = await createTestOrg(server, "authn-a");
    orgB = await createTestOrg(server, "authn-b");
    bridgePool = createPool(testRuntimeDatabaseUrl());
    bridge = startSseBridge(bridgePool, server.deps.config.runtimeDatabaseUrl);
    // The pg-boss role: LOGIN, owns only the `pgboss` schema, no grants on `public` at all
    // (db/provision.ts) — it cannot read one byte of `outbox`, yet it CAN issue NOTIFY.
    attacker = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await attacker.connect();
  }, 90_000);

  afterAll(async () => {
    await attacker.end().catch(() => undefined);
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

      // Settle window: give the bridge ample time to (mis)deliver. Secure behavior = nothing
      // arrives; the forged id must never reach org B's channel because no outbox row backs it.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const leaked = received.find((e) => e.id === forgedId);
      expect(leaked).toBeUndefined();
    } finally {
      sseHub.off(orgB.orgId, onB);
    }
  }, 40_000);
});
