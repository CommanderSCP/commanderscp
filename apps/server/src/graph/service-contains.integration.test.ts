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

/** `contains` — service/component membership. See docs/graph.md §185. */
/** MUTATION LOG — the `assembly` level. See docs/graph.md §186. */
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

  it("is registered as a built-in type spanning the ASSEMBLY level, one_to_many", async () => {
    const types = await admin.typeRegistry.relationshipTypes.list();
    const contains = types.items.find((t) => t.id === "contains");
    expect(contains, "migration 0021 must register the `contains` relationship type").toBeDefined();
    // Migration 0054 widened both sides for the optional `assembly` level. The arrays are a
    // CROSS-PRODUCT, so this necessarily also admits `assembly -> assembly`, which the registry
    // cannot forbid — `relationships-repo.ts` refuses that pair at write time, and there is a test
    // for it below. If you widen these arrays again, go and look at that refusal.
    expect(contains!.fromTypes).toEqual(["service", "assembly"]);
    expect(contains!.toTypes).toEqual(["assembly", "component"]);
    // one_to_many (NOT many_to_one — see the module doc); this is the value that makes the
    // component side singular in assertCardinality.
    expect(contains!.cardinality).toBe("one_to_many");
  });

  // THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS. See docs/graph.md §187.

  it("a service may contain an ASSEMBLY, and the assembly may contain components", async () => {
    const svc = await admin.object("service").create({ name: `svc-${Date.now()}` });
    const asm = await admin.object("assembly").create({ name: `asm-${Date.now()}` });
    await admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: asm.id });

    const comp = await admin.components.create({ name: `c-${Date.now()}`, service: asm.id });
    expect(comp.id, "a component's parent may be an assembly, not only a service").toBeTruthy();
  });

  it("REFUSES an assembly containing an assembly — the registry admits it, the app must not", async () => {
    const a = await admin.object("assembly").create({ name: `asm-a-${Date.now()}` });
    const b = await admin.object("assembly").create({ name: `asm-b-${Date.now()}` });
    await expect(
      admin.relationships.create({ typeId: "contains", fromId: a.id, toId: b.id })
    ).rejects.toThrow();
  });

  it("REFUSES closing a containment loop — TODAY by the endpoint types, not by the cycle check", async () => {
    // READ THIS BEFORE TRUSTING IT. See docs/graph.md §188.
    const outer = await admin.object("service").create({ name: `cyc-outer-${Date.now()}` });
    const inner = await admin.object("assembly").create({ name: `cyc-inner-${Date.now()}` });
    await admin.relationships.create({ typeId: "contains", fromId: outer.id, toId: inner.id });

    await expect(
      admin.relationships.create({ typeId: "contains", fromId: inner.id, toId: outer.id })
    ).rejects.toThrow();
  });

  it("REFUSES a MIXED loop — one hop of `contains`, one hop of `domain_id` — which the cycle check could not see", async () => {
    // The hole the check had, and the case that now kills it. See docs/graph.md §189.
    const asm = await admin.object("assembly").create({ name: `mixed-asm-${Date.now()}` });
    // Hop 1, via `domain_id`: the assembly CONTAINS the service.
    const svc = await admin
      .object("service")
      .create({ name: `mixed-svc-${Date.now()}`, domainId: asm.id });
    // THE FIXTURE ITSELF, ASSERTED — if `domainId` were ignored here there would be no first hop,
    // and the refusal below would be about nothing.
    expect(svc.domainId).toBe(asm.id);

    // Hop 2, via the edge, closing the loop the other way round.
    await expect(
      admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: asm.id })
    ).rejects.toThrow();

    // AND THE CONTROL, so this is a check and not a ban on `contains` edges into assemblies: the
    // same edge, between the same two TYPES, with no `domain_id` hop to close the loop.
    const asm2 = await admin.object("assembly").create({ name: `mixed-asm2-${Date.now()}` });
    const svc2 = await admin.object("service").create({ name: `mixed-svc2-${Date.now()}` });
    const ok = await admin.relationships.create({
      typeId: "contains",
      fromId: svc2.id,
      toId: asm2.id
    });
    expect(ok.id).toBeTruthy();
  });

  it("REFUSES an object containing ITSELF", async () => {
    const svc = await admin.object("service").create({ name: `self-${Date.now()}` });
    await expect(
      admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: svc.id })
    ).rejects.toThrow();
  });

  it("a service may contain MANY components", async () => {
    const svc = await admin.object("service").create({ name: "billing" });
    const a = await createOrphanComponent(server, org, "billing-api");
    const b = await createOrphanComponent(server, org, "billing-worker");

    await admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: a.id });
    await admin.relationships.create({ typeId: "contains", fromId: svc.id, toId: b.id });

    const edges = await admin.relationships.list({ typeId: "contains", fromId: svc.id });
    expect(edges.items.map((e) => e.toId).sort()).toEqual([a.id, b.id].sort());
  });

  it("REFUSES a component in a second service — the actual 'one service per component' guarantee", async () => {
    const svc1 = await admin.object("service").create({ name: "checkout" });
    const svc2 = await admin.object("service").create({ name: "fulfilment" });
    const comp = await createOrphanComponent(server, org, "checkout-api");

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
    const orphan = await createOrphanComponent(server, org, "imported-from-argocd");
    expect(orphan.id).toBeTruthy();
    const edges = await admin.relationships.list({ typeId: "contains", toId: orphan.id });
    expect(edges.items).toHaveLength(0);
  });

  it("the DB itself enforces one service per component — not just assertCardinality (race backstop)", async () => {
    // A select-then-insert under READ COMMITTED can double-write. See docs/graph.md §190.
    const s1 = await admin.object("service").create({ name: "race-a" });
    const s2 = await admin.object("service").create({ name: "race-b" });
    const comp = await createOrphanComponent(server, org, "race-target");

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
    const comp = await createOrphanComponent(server, org, "notify-worker");

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
