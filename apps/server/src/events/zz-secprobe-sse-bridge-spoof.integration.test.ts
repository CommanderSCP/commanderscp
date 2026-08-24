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
  waitUntil,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/** TEMPORARY SECURITY PROBE — delete after the review round. */
describe("SECPROBE: forged NOTIFY on scp_sse_events", () => {
  let server: TestServer;
  let orgA: TestOrg;
  let orgB: TestOrg;
  let bridgePool: pg.Pool;
  let bridge: SseBridgeHandle;
  let attacker: pg.Client;

  beforeAll(async () => {
    server = await buildTestServer();
    orgA = await createTestOrg(server, "secprobe-a");
    orgB = await createTestOrg(server, "secprobe-b");
    bridgePool = createPool(testRuntimeDatabaseUrl());
    bridge = startSseBridge(bridgePool, server.deps.config.runtimeDatabaseUrl);
    // The pg-boss role: NOLOGIN->LOGIN, owns only the `pgboss` schema, "no grants on `public` at
    // all" (db/provision.ts). It cannot SELECT one byte of `outbox`.
    attacker = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await attacker.connect();
  }, 90_000);

  afterAll(async () => {
    await attacker.end().catch(() => undefined);
    await bridge.stop();
    await bridgePool.end();
    await server.close();
  });

  it("the attacker role really has no read access to outbox", async () => {
    await expect(attacker.query("SELECT count(*) FROM outbox")).rejects.toThrow(
      /permission denied|does not exist/i
    );
  });

  it("delivers a wholly FABRICATED event, with an org id of the attacker's choosing, to org B", async () => {
    const received: RelayedEvent[] = [];
    const onA = (e: RelayedEvent): void => void received.push({ ...e, source: `A:${e.source}` });
    const onB = (e: RelayedEvent): void => void received.push({ ...e, source: `B:${e.source}` });
    sseHub.on(orgA.orgId, onA);
    sseHub.on(orgB.orgId, onB);
    const forgedId = randomUUID();
    try {
      const forged = {
        id: forgedId,
        orgId: orgB.orgId, // <-- spoofed: never re-derived from any row
        type: "scp.change.transitioned",
        source: "scp",
        subject: "totally-made-up",
        data: { state: "released", note: "no outbox row backs this" },
        createdAt: new Date().toISOString()
      };
      await attacker.query("SELECT pg_notify('scp_sse_events', $1)", [JSON.stringify(forged)]);

      const got = await waitUntil(async () => received.find((e) => e.id === forgedId), {
        describe: "the forged frame to reach org B's hub channel",
        timeoutMs: 15_000
      });
      expect(got.source).toBe("B:scp");
      expect(got.subject).toBe("totally-made-up");

      // ...and no outbox row backs it.
      const rows = await server.deps.db.execute(
        // eslint-disable-next-line
        `SELECT count(*)::int AS n FROM outbox WHERE id = '${forgedId}'` as never
      );
      expect(JSON.stringify(rows)).toContain('"n":0');
    } finally {
      sseHub.off(orgA.orgId, onA);
      sseHub.off(orgB.orgId, onB);
    }
  }, 40_000);
});
