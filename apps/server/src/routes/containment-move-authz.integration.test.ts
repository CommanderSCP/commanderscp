import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE CONTAINMENT PARENT IS AN AUTHORIZATION-BEARING FIELD, AND EVERY DOOR THAT WRITES IT MUST SAY SO.
 *
 * `objects.domain_id` is not an ordinary column. RBAC scope expands strictly UPWARD
 * (`authz/resolve.ts`), so the value of this one field decides *who else* holds authority over the
 * row. Two consequences, and this file pins both:
 *
 *  - **B1 — a MOVE is a write at two places.** Re-parenting X under V hands every holder of a
 *    binding at V (or above V) authority over X. A door that authorizes only at X therefore lets an
 *    actor with write over X alone plant it inside a stranger's subtree.
 *  - **B2 — `null` is not a containment parent.** A row with `domain_id IS NULL` is DETACHED: its
 *    scope expansion terminates at itself, so no ancestor binding — not even the org root Owner's —
 *    can ever reach it again.
 *
 * Every case here goes through the real HTTP doors (`server.app.inject`), never the repo functions:
 * the defect in both cases was a route that resolved the wrong scope, which a repo-level test cannot
 * see. Cases are grouped by DOOR rather than by defect, because the census that produced this file
 * is "every door that writes a caller-supplied `domainId` onto an existing row" — PATCH and PUT, on
 * the generic route, the typed-registry factory, and the bespoke component route.
 */
describe("writing an object's containment parent is authorized at the destination", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  interface Fixture {
    org: TestOrg;
    victimDomainId: string;
    /** A domain the mover holds nothing at either — where the movable object lives. */
    homeDomainId: string;
    /** A `service` the mover holds `object:write` at, and only there. */
    movableId: string;
    movableUrn: string;
    /** Bearer token for an actor whose ONLY binding is at `movableId`. */
    moverToken: string;
  }

  async function post(
    token: string,
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  async function makeFixture(label: string): Promise<Fixture> {
    const org = await createTestOrg(server, label);
    const victim = await post(org.adminToken, "/api/v1/domains", { name: `${label}-victim` });
    expect(victim.status, victim.body).toBe(201);
    const home = await post(org.adminToken, "/api/v1/domains", { name: `${label}-home` });
    expect(home.status, home.body).toBe(201);
    const victimDomainId = victim.json().id as string;
    const homeDomainId = home.json().id as string;

    const movable = await post(org.adminToken, "/api/v1/services", {
      name: `${label}-movable`,
      domainId: homeDomainId
    });
    expect(movable.status, movable.body).toBe(201);

    // Administrator carries `object:write` (and `policy:write`), bound at the SERVICE and nowhere
    // else. That is genuine, legitimate authority over this one object — the whole point of the
    // case is that it must not extend to choosing the object's neighbours.
    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: movable.json().id as string }
    ]);

    return {
      org,
      victimDomainId,
      homeDomainId,
      movableId: movable.json().id as string,
      movableUrn: movable.json().urn as string,
      moverToken: mover.token
    };
  }

  async function readDomainId(org: TestOrg, id: string): Promise<string | null> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${id}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { domainId: string | null }).domainId;
  }

  it("PATCH /services/{id} refuses a move into a domain the actor holds nothing at, and the row does not move", async () => {
    const f = await makeFixture("move-patch-typed");

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${f.movableId}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { domainId: f.victimDomainId }
    });

    expect(res.statusCode, res.body).toBe(403);
    // Names the DESTINATION, not the object: an operator reading this must be able to tell a
    // "you may not edit this object" refusal from a "you may not put it there" one.
    expect(res.body).toContain(f.victimDomainId);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.homeDomainId);
  });

  it("PATCH /objects/service/{id} — the generic door — refuses the same move", async () => {
    const f = await makeFixture("move-patch-generic");

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/objects/service/${f.movableId}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { domainId: f.victimDomainId }
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(f.victimDomainId);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.homeDomainId);
  });

  it("PUT /services/{urn} — the upsert door's UPDATE branch — refuses the same move", async () => {
    const f = await makeFixture("move-put-typed");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/services/${encodeURIComponent(f.movableUrn)}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { name: "renamed-by-mover", domainId: f.victimDomainId }
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(f.victimDomainId);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.homeDomainId);
  });

  it("PUT /objects/service/{urn} — the generic upsert door — refuses the same move", async () => {
    const f = await makeFixture("move-put-generic");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/objects/service/${encodeURIComponent(f.movableUrn)}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { name: "renamed-by-mover", domainId: f.victimDomainId }
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(f.victimDomainId);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.homeDomainId);
  });

  it("PATCH /components/{id} — the bespoke component door — refuses the same move", async () => {
    const org = await createTestOrg(server, "move-patch-component");
    const victim = await post(org.adminToken, "/api/v1/domains", { name: "cmp-victim" });
    const home = await post(org.adminToken, "/api/v1/services", { name: "cmp-home-service" });
    expect(victim.status, victim.body).toBe(201);
    expect(home.status, home.body).toBe(201);
    const component = await post(org.adminToken, "/api/v1/components", {
      name: "cmp-movable",
      service: home.json().id as string,
      domainId: home.json().id as string
    });
    expect(component.status, component.body).toBe(201);
    const componentId = component.json().id as string;
    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: componentId }
    ]);

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/components/${componentId}`,
      headers: { authorization: `Bearer ${mover.token}` },
      payload: { domainId: victim.json().id as string }
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(victim.json().id as string);
  });

  it("a move the actor IS authorized for still succeeds — the destination check is a check, not a ban", async () => {
    const f = await makeFixture("move-allowed");
    // The org-root admin holds `object:write` everywhere, including at the victim domain.
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${f.movableId}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` },
      payload: { domainId: f.victimDomainId }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.victimDomainId);
  });

  it("a PATCH that does not name a destination is unaffected — no destination check is imposed on an ordinary field edit", async () => {
    const f = await makeFixture("move-absent");
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${f.movableId}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { name: "renamed-in-place" }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.homeDomainId);
  });

  it("re-stating the CURRENT parent is a no-op, not a privilege demand — an idempotent re-apply keeps working", async () => {
    const f = await makeFixture("move-restate");
    // The mover holds nothing at `homeDomainId`; naming it as the destination changes nothing, so
    // demanding authority there would break every idempotent PUT/IaC re-apply of an unchanged row.
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${f.movableId}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { domainId: f.homeDomainId }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readDomainId(f.org, f.movableId)).toBe(f.homeDomainId);
  });

  // ---------------------------------------------------------------------------------------------
  // B2 — `null` is "unspecified", never "detach"
  // ---------------------------------------------------------------------------------------------

  it("PATCH {domainId: null} does not detach the object — it stays reachable from the org root", async () => {
    const f = await makeFixture("detach-patch-typed");

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${f.movableId}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` },
      payload: { domainId: null }
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await readDomainId(f.org, f.movableId);
    expect(after).not.toBeNull();
    expect(after).toBe(f.org.orgId);

    // THE CONSEQUENCE, asserted rather than described: a detached row's scope expansion terminates
    // at itself, so the org-root Owner's binding would no longer reach it. This second edit is what
    // fails when `null` is written through.
    const second = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${f.movableId}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` },
      payload: { name: "still-governable" }
    });
    expect(second.statusCode, second.body).toBe(200);
  });

  it("PUT {domainId: null} on an EXISTING row does not detach it either", async () => {
    const f = await makeFixture("detach-put-typed");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/services/${encodeURIComponent(f.movableUrn)}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` },
      payload: { name: "put-with-null-domain", domainId: null }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readDomainId(f.org, f.movableId)).not.toBeNull();
  });

  it("PUT {domainId: null} that CREATES a row does not detach it either — the create doors must agree with the update doors", async () => {
    const org = await createTestOrg(server, "detach-put-create");
    const urn = `urn:scp:${org.orgName.slice(0, 12)}:service:put-created`;

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/services/${encodeURIComponent(urn)}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "put-created-service", domainId: null }
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { domainId: string | null }).domainId).toBe(org.orgId);
  });

  it("PATCH /objects/service {domainId: null} — the generic door — does not detach either", async () => {
    const f = await makeFixture("detach-patch-generic");

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/objects/service/${f.movableId}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` },
      payload: { domainId: null }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readDomainId(f.org, f.movableId)).not.toBeNull();
  });
});
