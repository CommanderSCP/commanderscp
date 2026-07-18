import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { objectHealth } from "../db/schema.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Object health push + read (observe-enrichment signal 4; ADR-0008 decision 4).
 *
 * Proves the WHOLE round-trip against REAL Postgres:
 *  - an owner PUSH stores health GRAPH-NATIVELY — an object-referencing projection row keyed by
 *    objects(id) (DESIGN §4.1), NOT a bespoke top-level concept table (charter principle 2);
 *  - the store is UPSERT-IN-PLACE — a second push updates the SAME single row, no history table;
 *  - the pushed value is surfaced on the object read AND on the graph node-payload join (the exact
 *    node set the two-layer graph UI assembles: services.list + subgraph edges + the health batch);
 *  - the REAL pushed value round-trips (degraded → down), never a hardcoded/fabricated one;
 *  - RLS isolates health per org.
 *
 * SCP never probes/polls/computes health — the only write path exercised here is the owner PUSH.
 */
describe("object health: PUT/GET /objects/:type/:idOrUrn/health + POST /graph/health", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "object-health");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("pushes health, stores it graph-natively as a single upsert-in-place row, and surfaces the real value on reads and the graph node join", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await admin.components.create({ name: "gateway", service: svc.id });

    // (2) PUSH: degraded, owner-sourced.
    const pushed = await admin.health.push("service", svc.id, {
      status: "degraded",
      detail: "p99 latency",
      source: "owner"
    });
    expect(pushed).toMatchObject({
      objectId: svc.id,
      status: "degraded",
      detail: "p99 latency",
      source: "owner"
    });
    const firstObservedAt = pushed.observedAt;

    // (3) Stored GRAPH-NATIVELY: exactly ONE projection row keyed by the service's object id.
    const rowsAfterFirst = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(objectHealth)
        .where(and(eq(objectHealth.orgId, org.orgId), eq(objectHealth.objectId, svc.id)))
    );
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]?.objectId).toBe(svc.id); // FK REFERENCES objects(id) — no bespoke concept table
    expect(rowsAfterFirst[0]?.status).toBe("degraded");

    // Re-push a DIFFERENT status → same single row, updated in place, observedAt advanced.
    await new Promise((r) => setTimeout(r, 5));
    const repushed = await admin.health.push("service", svc.id, {
      status: "down",
      detail: "hard down",
      source: "owner"
    });
    expect(repushed.status).toBe("down");
    expect(new Date(repushed.observedAt).getTime()).toBeGreaterThan(
      new Date(firstObservedAt).getTime()
    );
    const rowsAfterRepush = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(objectHealth)
        .where(and(eq(objectHealth.orgId, org.orgId), eq(objectHealth.objectId, svc.id)))
    );
    expect(rowsAfterRepush).toHaveLength(1); // STILL one row — upsert-in-place, no history row
    expect(rowsAfterRepush[0]?.status).toBe("down");

    // (4) Surfaced on the object read.
    const read = await admin.health.get("service", svc.id);
    expect(read.status).toBe("down");
    expect(read.detail).toBe("hard down");

    // An object with NO pushed health reads as `unknown` — never fabricated as healthy.
    const compRead = await admin.health.get("component", comp.id);
    expect(compRead.status).toBe("unknown");
    expect(compRead.detail).toBeNull();

    // (5) Surfaced in the graph NODE payload the two-layer UI builds: services.list gives the
    // nodes, graph.subgraph gives the edges, graph.health gives health joined by id. `subgraph`
    // returns EDGES ONLY, so health is joined at the node source — exactly what the UI does.
    const services = await admin.services.list({ limit: 100 });
    const nodeIds = services.items.map((s) => s.id);
    const batch = await admin.health.batchGet({ objectId: svc.id, ids: nodeIds });
    const byId = new Map(batch.records.map((rec) => [rec.objectId, rec.status]));
    const nodes = services.items.map((s) => ({
      id: s.id,
      name: s.name,
      typeId: s.typeId,
      health: byId.get(s.id) ?? "unknown"
    }));
    const svcNode = nodes.find((n) => n.id === svc.id);
    expect(svcNode?.health).toBe("down"); // the REAL pushed value on the node the UI renders
  });

  it("defaults observedAt to receive-time and accepts a caller-supplied observedAt", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const when = "2026-01-02T03:04:05.000Z";
    const pushed = await admin.health.push("service", svc.id, {
      status: "healthy",
      observedAt: when,
      source: "owner"
    });
    expect(pushed.observedAt).toBe(when);
    expect(pushed.status).toBe("healthy");
    expect(pushed.detail).toBeNull();
  });

  it("isolates health per org (RLS): a second org cannot read or write the first org's health", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    await admin.health.push("service", svc.id, { status: "down", source: "owner" });

    const otherOrg = await createTestOrg(server, "object-health-other");
    const other = new ScpClient({ baseUrl: server.baseUrl, token: otherOrg.adminToken });

    // The other org can't even resolve the object (RLS scopes `objects` too) → 404, never leaks.
    await expect(other.health.get("service", svc.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      other.health.push("service", svc.id, { status: "healthy", source: "owner" })
    ).rejects.toMatchObject({ status: 404 });

    // A batch read scoped by the other org sees none of the first org's health rows.
    const otherSvc = await other.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const batch = await other.health.batchGet({
      objectId: otherSvc.id,
      ids: [svc.id, otherSvc.id]
    });
    expect(batch.records).toHaveLength(0);

    // The first org's row is intact and unchanged.
    const read = await admin.health.get("service", svc.id);
    expect(read.status).toBe("down");
  });
});
