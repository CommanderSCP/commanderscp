import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `placement` — one component at one deployment target (ADR-0026 D2/D3/D14, owner decision D17).
 *
 * The properties are the SOURCE OF TRUTH and the two edges are DERIVED. One fact in two places is
 * the cost of the shape, and every test below that touches a write asserts BOTH halves, because a
 * bug in this design does not look like an error — it looks like a placement that is fine until
 * something traverses it, or an edge pointing out of an object that no longer exists.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | drop the 0051 unique index | the duplicate test AND the race test fail |
 * | index without `deleted_at IS NULL` | "re-declared after withdrawal" fails |
 * | drop `placed_at` from the derived-edge list (create) | "both derived edges" fails |
 * | withdrawal skips the edges | "withdrawal removes the derived edges" AND "re-declared" fail |
 * | remove `placement` from `PAIR_BOUND_OBJECT_TYPE_IDS` | BOTH door tests fail |
 * | drop the component type-check in `createPlacement` | **all pass** — see below |
 *
 * That last row is recorded because it is a true negative, not a gap: the `places` edge's own
 * registered `to_types` (migration 0051) refuses a non-component one step later, inside the same
 * transaction, so the write is still rejected and nothing is stored. The explicit check earns its
 * place by failing BEFORE any write and by saying which endpoint was wrong — but it is not the only
 * guard, and a test asserting "this throws" cannot separate the two. Stated plainly rather than
 * dressed up as proof.
 *
 * The race test's history is also worth keeping: it originally passed with the 0051 index REMOVED
 * ENTIRELY, because two derived-URN creates of the same pair compute the same URN and
 * `objects_org_id_urn_key` serialised them incidentally. It measures the pair index only because it
 * now supplies distinct explicit URNs.
 */
describe("placement: one component at one deployment target", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "placements");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const target = (name: string) => admin.deploymentTargets.create({ name });

  it("writes the object AND both derived edges in one call", async () => {
    const comp = await createOrphanComponent(admin, "pl-keycloak");
    const prod = await target("pl-prod");

    const placement = await admin.placements.create({
      component: comp.id,
      deploymentTarget: prod.id
    });

    // The source of truth.
    expect(placement.typeId).toBe("placement");
    expect(placement.properties.componentId).toBe(comp.id);
    expect(placement.properties.deploymentTargetId).toBe(prod.id);

    // The derived half. Both edges, both pointing OUT of the placement — without these the
    // placement is an island and no traversal or blast-radius query can see it.
    const places = await admin.relationships.list({ typeId: "places", fromId: placement.id });
    expect(places.items.map((e) => e.toId)).toEqual([comp.id]);
    const placedAt = await admin.relationships.list({ typeId: "placed_at", fromId: placement.id });
    expect(placedAt.items.map((e) => e.toId)).toEqual([prod.id]);
  });

  it("names it <component>@<target>, and gives it a URN whose separator cannot be forged", async () => {
    // `slugify` maps every non-alphanumeric run to '-', so an '@' in the URN would be indistinguishable
    // from a hyphen that came out of either endpoint's own name. '/' is admitted by the URN grammar and
    // STRIPPED by slugify, so a '/' in a placement URN can only be the separator.
    const comp = await createOrphanComponent(admin, "pl sep component");
    const tgt = await target("pl sep target");
    const placement = await admin.placements.create({
      component: comp.id,
      deploymentTarget: tgt.id
    });

    expect(placement.name).toBe(`${comp.name}@${tgt.name}`);
    expect(placement.urn.endsWith(":pl-sep-component/pl-sep-target")).toBe(true);
    // The property that matters: exactly one separator, whatever the endpoint names contained.
    const slugPath = placement.urn.split(":placement:")[1]!;
    expect(slugPath.split("/")).toHaveLength(2);
  });

  it("REFUSES a second placement of the same component at the same target", async () => {
    const comp = await createOrphanComponent(admin, "pl-dup");
    const tgt = await target("pl-dup-target");
    await admin.placements.create({ component: comp.id, deploymentTarget: tgt.id });

    await expect(
      admin.placements.create({ component: comp.id, deploymentTarget: tgt.id })
    ).rejects.toThrow(/conflict/i);

    const all = await admin.placements.list({ component: comp.id });
    expect(all.items).toHaveLength(1);
  });

  it("ALLOWS one component at MANY targets, and one target holding MANY components", async () => {
    // The whole point of the type: a one-column key cannot address a two-dimensional grid.
    const keycloak = await createOrphanComponent(admin, "pl-grid-keycloak");
    const market = await createOrphanComponent(admin, "pl-grid-market");
    const gamma = await target("pl-grid-gamma");
    const prod = await target("pl-grid-prod");

    await admin.placements.create({ component: keycloak.id, deploymentTarget: gamma.id });
    await admin.placements.create({ component: keycloak.id, deploymentTarget: prod.id });
    await admin.placements.create({ component: market.id, deploymentTarget: prod.id });

    const keycloakPlacements = await admin.placements.list({ component: keycloak.id });
    expect(keycloakPlacements.items.map((p) => p.properties.deploymentTargetId).sort()).toEqual(
      [gamma.id, prod.id].sort()
    );
    const prodPlacements = await admin.placements.list({ deploymentTarget: prod.id });
    expect(prodPlacements.items.map((p) => p.properties.componentId).sort()).toEqual(
      [keycloak.id, market.id].sort()
    );
  });

  it("withdrawal removes the DERIVED EDGES too, not just the object", async () => {
    // Nothing in this graph cascades: `deleteObject` does not touch relationships. A withdrawal that
    // dropped only the object would leave two live edges pointing out of a dead one, and traversal
    // would keep reporting the component as placed.
    const comp = await createOrphanComponent(admin, "pl-withdraw");
    const tgt = await target("pl-withdraw-target");
    const placement = await admin.placements.create({
      component: comp.id,
      deploymentTarget: tgt.id
    });

    await admin.placements.delete(placement.id);

    const places = await admin.relationships.list({ typeId: "places", fromId: placement.id });
    expect(places.items).toHaveLength(0);
    const placedAt = await admin.relationships.list({ typeId: "placed_at", fromId: placement.id });
    expect(placedAt.items).toHaveLength(0);
    const remaining = await admin.placements.list({ component: comp.id });
    expect(remaining.items).toHaveLength(0);
  });

  it("can be re-declared after withdrawal — and does not accumulate stale edges", async () => {
    // 0051's index filters `deleted_at IS NULL`, so the pair is freed. The second half is the one
    // that catches a withdrawal which forgot the edges: the component would end up with TWO live
    // `places` edges and read as placed at the same target twice.
    const comp = await createOrphanComponent(admin, "pl-redeclare");
    const tgt = await target("pl-redeclare-target");
    const first = await admin.placements.create({ component: comp.id, deploymentTarget: tgt.id });
    await admin.placements.delete(first.id);

    const second = await admin.placements.create({ component: comp.id, deploymentTarget: tgt.id });
    expect(second.id).not.toBe(first.id);

    const live = await admin.placements.list({ component: comp.id });
    expect(live.items).toHaveLength(1);
    const inboundPlaces = await admin.relationships.list({ typeId: "places", toId: comp.id });
    expect(inboundPlaces.items.map((e) => e.fromId)).toEqual([second.id]);
  });

  it("the DB itself enforces one placement per pair (race backstop)", async () => {
    // EXPLICIT, DISTINCT URNs are load-bearing here, and this test asserted nothing without them.
    // Two derived-URN creates of the same pair compute the SAME base URN, so `objects_org_id_urn_key`
    // serialises them incidentally — the test passed with migration 0051's pair index removed
    // entirely, i.e. it was measuring the wrong constraint. Distinct URNs take that constraint out
    // of the picture and leave the pair index as the only thing that can hold.
    //
    // The race itself is not theoretical: 0049's mutation testing showed two concurrent creates
    // both getting past an application-level check under READ COMMITTED. Here there is no
    // application-level pre-check at all, so the index is the sole guard by construction.
    const comp = await createOrphanComponent(admin, "pl-race");
    const tgt = await target("pl-race-target");
    const urnBase = `urn:scp:${org.orgId}:placement:pl-race`;

    const results = await Promise.allSettled([
      admin.placements.create({
        component: comp.id,
        deploymentTarget: tgt.id,
        urn: `${urnBase}/a`
      }),
      admin.placements.create({ component: comp.id, deploymentTarget: tgt.id, urn: `${urnBase}/b` })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const live = await admin.placements.list({ component: comp.id });
    expect(live.items).toHaveLength(1);
  });

  it("REFUSES endpoints of the wrong type — the check the property schema cannot make", async () => {
    // Two well-formed UUIDs satisfy migration 0051's `required` perfectly. Only the typed route
    // resolves them and checks what they actually are.
    const svc = await admin.object("service").create({ name: "pl-wrong-type-svc" });
    const comp = await createOrphanComponent(admin, "pl-wrong-type-comp");
    const tgt = await target("pl-wrong-type-target");

    await expect(
      admin.placements.create({ component: svc.id, deploymentTarget: tgt.id })
    ).rejects.toThrow();
    await expect(
      admin.placements.create({ component: comp.id, deploymentTarget: svc.id })
    ).rejects.toThrow();

    // Nothing was written under either rejection.
    const all = await admin.placements.list({ deploymentTarget: tgt.id });
    expect(all.items).toHaveLength(0);
  });

  it("the generic /objects/placement door is refused — no side entrance past the pairing rule", async () => {
    const comp = await createOrphanComponent(admin, "pl-sidedoor-comp");
    const tgt = await target("pl-sidedoor-target");

    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/placement",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        name: "smuggled",
        properties: { componentId: comp.id, deploymentTargetId: tgt.id }
      }
    });
    expect(res.statusCode).toBe(403);

    // Behaviour, not the status: the generic door must not have created one. A placement minted here
    // would satisfy the property schema and the unique index while having NO edges at all.
    const all = await admin.placements.list({ component: comp.id });
    expect(all.items).toHaveLength(0);
  });

  it("the federation OVERLAY door is refused too — the second user-facing create surface", async () => {
    // Overlay takes a free-form `overlayTypeId` + properties, so it is the same side entrance one
    // module over. Refusing only the generic route would be the incomplete-call-site mistake.
    const comp = await createOrphanComponent(admin, "pl-overlay-comp");
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/federation/overlays`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        base: comp.id,
        typeId: "placement",
        name: "smuggled-overlay",
        properties: { componentId: comp.id, deploymentTargetId: comp.id }
      }
    });
    expect(res.statusCode).toBe(403);
  });
});
