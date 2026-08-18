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
 * `many_to_one` would have been silently unenforced — that cardinality was absent from
 * CardinalitySchema AND had no branch in assertCardinality, so it fell through every check. We
 * therefore register the MIRROR (`service -> component`, `one_to_many`), whose "to side is singular"
 * rule is what actually delivers "one service per component". If someone later "fixes" the direction
 * to read more naturally, these tests fail — which is the point.
 *
 * `many_to_one` IS enforced as of migration 0049 (ADR-0026 D11), and `assertCardinality` now fails
 * closed on any cardinality it cannot enforce — see cardinality.integration.test.ts. That does not
 * license flipping this edge: 0022's partial unique index and the authz/policy containment walks all
 * key on `service -> component`, so the direction below stays exactly as shipped.
 */
/**
 * ============================================================================================
 * MUTATION LOG — the `assembly` level (migration 0055). Each applied ALONE, then reverted.
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | allow `assembly -> assembly` (drop the app-level refusal) | the assembly-in-assembly test FAILS — the registry's flat from/to arrays admit the pair, so only the app can refuse it |
 * | delete `assertNoContainmentCycle` | **NO TEST FAILS**, and that is recorded rather than hidden. `to_types` excludes `service`, so `assembly -> service` is refused by the endpoint check and a type-legal cycle cannot be built today. The check is unreachable defence-in-depth, kept because widening the arrays makes it live; the loop test pins the OUTCOME, not the mechanism, and says so |
 *
 * ============================================================================================
 * MUTATION LOG — the MIXED-ROUTE loop (M21.7 item E). SUPERSEDES the last row above.
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | delete `assertNoContainmentCycle` | the MIXED-loop test FAILS. The row above was true only while the check walked `contains` alone: it was unreachable because a PURE-`contains` cycle is unconstructible by endpoint type. It now walks both containment routes, and the one-hop-of-each loop IS constructible with legal types — so the check is live, and deleting it is caught |
 * | make the walk `contains`-only again (the pre-M21.7 hand-rolled loop) | the MIXED-loop test FAILS, and nothing else does — which is the measurement of what the old walk could not see |
 * | refuse every `contains` edge | the CONTROL inside the mixed-loop test FAILS, plus most of this file |
 *
 * RENAMED 2026-08-18: `assertNoContainmentCycle` is now `assertContainsEdgeAdmissible` — the same
 * cycle question plus the DEPTH-BOUND question (owner ruling, ADR-0037 Consequences: no write may
 * leave a live row past `CONTAINMENT_WALK_MAX_DEPTH`). The rows above are kept under the old name as
 * the history they record; the depth half is pinned, per door and with mutation, in
 * `containment-depth-doors.integration.test.ts`, not here.
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

  // ============================================================================================
  // THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS (migration 0055).
  // `relationship_types` holds flat from/to arrays — a cross-product — so widening `contains` for the
  // `assembly` level necessarily admits shapes we do not want. They are refused in the app, and these
  // are the tests that keep the refusals honest.
  // ============================================================================================

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
    // READ THIS BEFORE TRUSTING IT. This test passes, but NOT because of
    // `assertNoContainmentCycle` — deleting that check leaves this test GREEN (recorded in the
    // mutation log). With `to_types = {assembly, component}`, a `service` is not a legal `to`
    // endpoint at all, so `assembly -> service` is refused one layer earlier and a type-legal cycle
    // is currently unconstructible.
    //
    // The check is kept anyway as defence-in-depth for THIS shape, and it becomes reachable for it
    // the moment anyone widens those arrays — e.g. to allow `service -> service`, which was the
    // rejected alternative shape for this very level.
    //
    // What this test therefore pins is the OUTCOME (the loop cannot be closed), not the mechanism.
    // If you widen the endpoint arrays, come back and make this test construct a type-legal
    // PURE-`contains` cycle, or that half of the check goes back to being untested.
    //
    // The check is NOT untested overall any more: the MIXED loop below reaches it, and dies when it
    // is removed. (The claim that used to sit here — "a cycle is an infinite walk in the code that
    // authorizes releases" — was wrong and has been removed from the check's own doc too. Every walk
    // named is depth-bounded. What a cycle actually corrupts is measured there.)
    const outer = await admin.object("service").create({ name: `cyc-outer-${Date.now()}` });
    const inner = await admin.object("assembly").create({ name: `cyc-inner-${Date.now()}` });
    await admin.relationships.create({ typeId: "contains", fromId: outer.id, toId: inner.id });

    await expect(
      admin.relationships.create({ typeId: "contains", fromId: inner.id, toId: outer.id })
    ).rejects.toThrow();
  });

  it("REFUSES a MIXED loop — one hop of `contains`, one hop of `domain_id` — which the cycle check could not see", async () => {
    // THE HOLE THE CHECK HAD, AND THE CASE THAT NOW KILLS IT IF IT IS DELETED.
    //
    // Containment has TWO routes (`graph/containment.ts`: `domain_id`, and the `contains` edge walked
    // backwards). `assertNoContainmentCycle` walked `contains` alone, so this loop — legal endpoint
    // types, one hop of each route — went straight past it. MEASURED on these doors before the fix:
    // the edge answered **201** and `svc -> asm -> svc` was in the table.
    //
    // It is the same loop the `domain_id` door already refuses (`assertRootedContainmentParent`
    // checks the whole walk); the two doors simply disagreed about what containment is. Which door
    // you happen to write it through is not a security or integrity boundary.
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
