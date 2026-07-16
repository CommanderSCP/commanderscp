import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `contains` — service/component membership (docs/proposals/service-component-model.md, migration
 * 0021). Every component belongs to at most ONE service (owner decision, 2026-07-15).
 *
 * These tests exist because the enforcement is SUBTLE and easy to get wrong in a way that looks fine:
 * the domain reads "component is part of a service", but registering `component -> service` with
 * `many_to_one` would be silently unenforced — that cardinality is absent from CardinalitySchema AND
 * has no branch in assertCardinality, so it falls through every check. We therefore register the
 * MIRROR (`service -> component`, `one_to_many`), whose "to side is singular" rule is what actually
 * delivers "one service per component". If someone later "fixes" the direction to read more naturally,
 * these tests fail — which is the point.
 */
describe("service --contains--> component (membership, one service per component)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "svc-contains");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("is registered as a built-in type: service -> component, one_to_many", async () => {
    const types = await admin.typeRegistry.relationshipTypes.list();
    const contains = types.items.find((t) => t.id === "contains");
    expect(contains, "migration 0021 must register the `contains` relationship type").toBeDefined();
    expect(contains!.fromTypes).toEqual(["service"]);
    expect(contains!.toTypes).toEqual(["component"]);
    // one_to_many (NOT many_to_one — see the module doc); this is the value that makes the
    // component side singular in assertCardinality.
    expect(contains!.cardinality).toBe("one_to_many");
  });

  it("a service may contain MANY components", async () => {
    const svc = await admin.object("service").create({ name: "billing" });
    const a = await createOrphanComponent(admin, "billing-api");
    const b = await createOrphanComponent(admin, "billing-worker");

    await admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: a.id });
    await admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: b.id });

    const edges = await admin.relationships.list({ typeId: "contains", fromId: svc.id });
    expect(edges.items.map((e) => e.toId).sort()).toEqual([a.id, b.id].sort());
  });

  it("REFUSES a component in a second service — the actual 'one service per component' guarantee", async () => {
    const svc1 = await admin.object("service").create({ name: "checkout" });
    const svc2 = await admin.object("service").create({ name: "fulfilment" });
    const comp = await createOrphanComponent(admin, "checkout-api");

    await admin.relationships.create({ typeId: "contains", fromId: svc1.id, toId: comp.id });

    // 409 from assertCardinality's "to side is singular" rule. Asserted on the STATUS, not the
    // detail text — the SDK surfaces the HTTP status ("Conflict"), not the problem `detail`.
    await expect(
      admin.relationships.create({ typeId: "contains", fromId: svc2.id, toId: comp.id })
    ).rejects.toThrow(/conflict/i);

    // The load-bearing assertion: behaviour, not the error string. The component must still have
    // exactly ONE service, and it must still be the first one — a rejection that nonetheless wrote
    // the row would pass the throw-check above and be exactly the bug worth catching.
    const edges = await admin.relationships.list({ typeId: "contains", toId: comp.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.fromId).toBe(svc1.id);
  });

  it("REFUSES a wrong-typed endpoint (component -> component, or service -> service)", async () => {
    const svc = await admin.object("service").create({ name: "search" });
    const compA = await createTestComponent(admin, { name: "search-api" });
    const compB = await createTestComponent(admin, { name: "search-indexer" });

    // from must be a service
    await expect(
      admin.relationships.create({ typeId: "contains", fromId: compA.id, toId: compB.id })
    ).rejects.toThrow();
    // to must be a component
    const svc2 = await admin.object("service").create({ name: "search-legacy" });
    await expect(
      admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: svc2.id })
    ).rejects.toThrow();
  });

  it("import stays permissive — an imported component may have NO service (organize after; M12 P5a)", async () => {
    // The governing principle: import is permissive, create is strict. `discovery/accept` mints an
    // orphan by construction (it calls createObject server-side, never the strict route), so an
    // imported component has no `contains` edge until it is organized. (The strict-route requirement
    // is covered in components.integration.test.ts.)
    const orphan = await createOrphanComponent(admin, "imported-from-argocd");
    expect(orphan.id).toBeTruthy();
    const edges = await admin.relationships.list({ typeId: "contains", toId: orphan.id });
    expect(edges.items).toHaveLength(0);
  });

  it("the DB itself enforces one service per component — not just assertCardinality (race backstop)", async () => {
    // assertCardinality is a SELECT-then-INSERT under READ COMMITTED with no row lock, so two
    // concurrent creates can both pass the check and both insert (found by adversarial review of P2).
    // Once `contains` bounds RBAC reach, a doubly-contained component is reachable from BOTH services'
    // bindings — so migration 0022 backs the invariant with a partial unique index. This drives the
    // two creates CONCURRENTLY (Promise.allSettled), which the sequential tests above cannot catch:
    // exactly one must win, whether it loses at the app check or the DB constraint.
    const s1 = await admin.object("service").create({ name: "race-a" });
    const s2 = await admin.object("service").create({ name: "race-b" });
    const comp = await createOrphanComponent(admin, "race-target");

    const results = await Promise.allSettled([
      admin.relationships.create({ typeId: "contains", fromId: s1.id, toId: comp.id }),
      admin.relationships.create({ typeId: "contains", fromId: s2.id, toId: comp.id })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    // The invariant that actually matters: exactly one live service-ancestor, whoever won.
    const edges = await admin.relationships.list({ typeId: "contains", toId: comp.id });
    expect(edges.items).toHaveLength(1);
  });

  it("frees the component once the edge is deleted (re-assignable, so organize-after works)", async () => {
    const svc1 = await admin.object("service").create({ name: "notifications" });
    const svc2 = await admin.object("service").create({ name: "messaging" });
    const comp = await createOrphanComponent(admin, "notify-worker");

    const edge = await admin.relationships.create({
      typeId: "contains",
      fromId: svc1.id,
      toId: comp.id
    });
    // Reassigning without deleting must fail (guarded above); deleting must free it.
    await admin.relationships.delete(edge.id);
    const moved = await admin.relationships.create({
      typeId: "contains",
      fromId: svc2.id,
      toId: comp.id
    });
    expect(moved.fromId).toBe(svc2.id);
  });
});
