import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE REST OF THE CENSUS: the doors `containment-move-authz.integration.test.ts` does not name.
 *
 * That file pins the two defects (a move authorized only at the source; a wire `null` written
 * through as a detach) on five doors. It is not the whole census. The property is "a door that
 * accepts a caller-supplied `domainId` for an object write", and enumerating it filterlessly turns
 * up three more:
 *
 *  - `PUT /components/{urn}` — BOTH branches. Measured: deleting this door's call to
 *    `resolveDeclaredContainmentParent` broke NOTHING in the sibling file. A door with the same
 *    defect and no test is how a fix ships inert.
 *  - `POST /components` and the other create doors — the create half of the `null` question. Two
 *    create doors already coerced `null` to the org root by hand and four did not; this file pins
 *    the agreed meaning on both kinds so the asymmetry cannot come back through whichever door was
 *    not looked at.
 *
 *  - the four coordination create doors (`/campaigns`, `/changes`, `/initiatives`, `/placements`)
 *    and `POST /plans/{id}/apply`, whose update entries authorized the object and never the
 *    destination.
 *
 * Plus the two refusals the fix ADDS rather than restores, both of which are the SAME PROPERTY as
 * the `null` detach — "a row whose scope expansion cannot reach the org root" — reached through a
 * different value:
 *
 *  - a row may not become its own containment parent. Reachable the moment `null` started
 *    resolving to the org root: `PATCH <org-root> {domainId: null}` would otherwise write a
 *    self-loop, and a cycle has no org-root ancestor.
 *  - a SOFT-DELETED object may not be a containment parent. `authz/resolve.ts` joins
 *    `parent_o.deleted_at IS NULL` on every hop of the scope walk, so parenting under a tombstone
 *    detaches exactly as `null` did. Measured, not reasoned: before the fix, `DELETE /domains/{d}`
 *    then `PATCH /services/{s} {domainId: d}` answered 200 and the org-root admin's own next GET of
 *    that service answered 403, permanently.
 */
describe("every door that writes a caller-supplied containment parent", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

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

  async function readComponentDomainId(org: TestOrg, id: string): Promise<string | null> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${id}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { domainId: string | null }).domainId;
  }

  // -----------------------------------------------------------------------------------------
  // PUT /components/{urn} — the door the sibling file misses, on both branches
  // -----------------------------------------------------------------------------------------

  it("PUT /components/{urn} — the update branch — refuses a move into a domain the actor holds nothing at", async () => {
    const org = await createTestOrg(server, "put-cmp-move");
    const victim = await post(org.adminToken, "/api/v1/domains", { name: "put-cmp-victim" });
    const service = await post(org.adminToken, "/api/v1/services", { name: "put-cmp-service" });
    expect(victim.status, victim.body).toBe(201);
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;
    const component = await post(org.adminToken, "/api/v1/components", {
      name: "put-cmp-movable",
      service: serviceId,
      domainId: serviceId
    });
    expect(component.status, component.body).toBe(201);
    const componentId = component.json().id as string;
    const componentUrn = component.json().urn as string;
    const victimDomainId = victim.json().id as string;

    // Authority over the component itself, and nowhere else.
    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: componentId }
    ]);

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/components/${encodeURIComponent(componentUrn)}`,
      headers: { authorization: `Bearer ${mover.token}` },
      payload: { name: "renamed-by-mover", domainId: victimDomainId }
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(victimDomainId);
    expect(await readComponentDomainId(org, componentId)).toBe(serviceId);
  });

  it("PUT /components/{urn} {domainId: null} on an EXISTING component does not detach it", async () => {
    const org = await createTestOrg(server, "put-cmp-null");
    const service = await post(org.adminToken, "/api/v1/services", { name: "put-cmp-null-svc" });
    expect(service.status, service.body).toBe(201);
    const component = await post(org.adminToken, "/api/v1/components", {
      name: "put-cmp-null-component",
      service: service.json().id as string,
      domainId: service.json().id as string
    });
    expect(component.status, component.body).toBe(201);
    const componentId = component.json().id as string;

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/components/${encodeURIComponent(component.json().urn as string)}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "put-cmp-null-renamed", domainId: null }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readComponentDomainId(org, componentId)).toBe(org.orgId);
  });

  // -----------------------------------------------------------------------------------------
  // The create doors — `null` means the same thing at every one of them
  // -----------------------------------------------------------------------------------------

  it("POST /components {domainId: null} creates an org-root child, not an orphan", async () => {
    const org = await createTestOrg(server, "post-cmp-null");
    const service = await post(org.adminToken, "/api/v1/services", { name: "post-cmp-null-svc" });
    expect(service.status, service.body).toBe(201);

    const created = await post(org.adminToken, "/api/v1/components", {
      name: "post-cmp-null-component",
      service: service.json().id as string,
      domainId: null
    });
    expect(created.status, created.body).toBe(201);
    expect(created.json().domainId).toBe(org.orgId);
  });

  it("PUT /components/{urn} {domainId: null} that CREATES a component agrees with POST", async () => {
    const org = await createTestOrg(server, "put-cmp-create-null");
    const service = await post(org.adminToken, "/api/v1/services", { name: "put-cmp-create-svc" });
    expect(service.status, service.body).toBe(201);
    const urn = `urn:scp:${org.orgName.slice(0, 12)}:component:put-created`;

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/components/${encodeURIComponent(urn)}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        name: "put-created-component",
        service: service.json().id as string,
        domainId: null
      }
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { domainId: string | null }).domainId).toBe(org.orgId);
  });

  it("POST /services and POST /objects/{type} {domainId: null} agree with them — the two doors that always coerced", async () => {
    const org = await createTestOrg(server, "post-null-controls");

    const typed = await post(org.adminToken, "/api/v1/services", {
      name: "typed-null-service",
      domainId: null
    });
    expect(typed.status, typed.body).toBe(201);
    expect(typed.json().domainId).toBe(org.orgId);

    const generic = await post(org.adminToken, "/api/v1/objects/service", {
      name: "generic-null-service",
      domainId: null
    });
    expect(generic.status, generic.body).toBe(201);
    expect(generic.json().domainId).toBe(org.orgId);
  });

  // -----------------------------------------------------------------------------------------
  // The COORDINATION create doors — same wire `null`, four more handlers
  // -----------------------------------------------------------------------------------------

  async function readObjectDomainId(
    org: TestOrg,
    typeId: string,
    id: string
  ): Promise<string | null> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/objects/${typeId}/${id}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { domainId: string | null }).domainId;
  }

  it("POST /initiatives, /campaigns, /changes and /placements all read {domainId: null} as the org root", async () => {
    const org = await createTestOrg(server, "coordination-null");
    const service = await post(org.adminToken, "/api/v1/services", { name: "coord-null-svc" });
    expect(service.status, service.body).toBe(201);
    const component = await post(org.adminToken, "/api/v1/components", {
      name: "coord-null-cmp",
      service: service.json().id as string
    });
    expect(component.status, component.body).toBe(201);
    const target = await post(org.adminToken, "/api/v1/deployment-targets", {
      name: "coord-null-target"
    });
    expect(target.status, target.body).toBe(201);
    const componentId = component.json().id as string;

    const initiative = await post(org.adminToken, "/api/v1/initiatives", {
      name: "coord-null-initiative",
      domainId: null
    });
    expect(initiative.status, initiative.body).toBe(201);
    expect(await readObjectDomainId(org, "initiative", initiative.json().id as string)).toBe(
      org.orgId
    );

    const campaign = await post(org.adminToken, "/api/v1/campaigns", {
      name: "coord-null-campaign",
      targets: [componentId],
      domainId: null
    });
    expect(campaign.status, campaign.body).toBe(201);
    expect(await readObjectDomainId(org, "campaign", campaign.json().id as string)).toBe(org.orgId);

    const change = await post(org.adminToken, "/api/v1/changes", {
      name: "coord-null-change",
      targets: [componentId],
      domainId: null
    });
    expect(change.status, change.body).toBe(201);
    expect(await readObjectDomainId(org, "change", change.json().id as string)).toBe(org.orgId);

    const placement = await post(org.adminToken, "/api/v1/placements", {
      component: componentId,
      deploymentTarget: target.json().id as string,
      domainId: null
    });
    expect(placement.status, placement.body).toBe(201);
    expect(await readObjectDomainId(org, "placement", placement.json().id as string)).toBe(
      org.orgId
    );
  });

  // -----------------------------------------------------------------------------------------
  // IaC apply — the ninth door, and the only one that authorizes through a drained check list
  // -----------------------------------------------------------------------------------------

  it("POST /plans/{id}/apply refuses a manifest that re-parents an object into a domain the actor holds nothing at", async () => {
    const org = await createTestOrg(server, "iac-move");
    const victim = await post(org.adminToken, "/api/v1/domains", { name: "iac-victim" });
    const home = await post(org.adminToken, "/api/v1/domains", { name: "iac-home" });
    expect(victim.status, victim.body).toBe(201);
    expect(home.status, home.body).toBe(201);
    const homeDomainId = home.json().id as string;
    const victimDomainId = victim.json().id as string;

    const service = await post(org.adminToken, "/api/v1/services", {
      name: "iac-movable",
      domainId: homeDomainId
    });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;
    const serviceUrn = service.json().urn as string;

    const mover = await createTestUser(server, org, [{ role: "Administrator", scope: serviceId }]);

    // `POST /plans` needs `object:read` at the org root, which the mover does not hold — so the
    // plan is authored by someone who does. That is the honest shape of the attack anyway: the
    // manifest is data, and the only question that matters is who may APPLY it.
    const plan = await post(org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-move-${serviceId.slice(0, 8)}`,
        objects: [
          { urn: serviceUrn, typeId: "service", name: "iac-movable", domainId: victimDomainId }
        ],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.json().id as string}/apply`,
      headers: { authorization: `Bearer ${mover.token}` }
    });
    expect(applied.statusCode, applied.body).toBe(403);
    expect(applied.body).toContain(victimDomainId);

    const after = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(after.statusCode, after.body).toBe(200);
    expect((after.json() as { domainId: string | null }).domainId).toBe(homeDomainId);
  });

  // -----------------------------------------------------------------------------------------
  // A soft-deleted container is the same unreachable row, reached through a different value
  // -----------------------------------------------------------------------------------------

  it("a SOFT-DELETED domain is refused as a containment parent — moving under a tombstone is the same detach", async () => {
    const org = await createTestOrg(server, "deleted-parent");
    const domain = await post(org.adminToken, "/api/v1/domains", { name: "doomed-domain" });
    const service = await post(org.adminToken, "/api/v1/services", { name: "deleted-parent-svc" });
    expect(domain.status, domain.body).toBe(201);
    expect(service.status, service.body).toBe(201);
    const domainId = domain.json().id as string;
    const serviceId = service.json().id as string;

    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/domains/${domainId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    const moved = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId }
    });
    expect(moved.statusCode, moved.body).toBe(400);

    // THE CONSEQUENCE, asserted rather than described: before the refusal this returned 200, and
    // this next read — by the ORG-ROOT ADMIN — then 403'd forever, because scope expansion refuses
    // to walk through a tombstoned ancestor.
    const read = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(read.statusCode, read.body).toBe(200);

    // The create half of the same door agrees.
    const created = await post(org.adminToken, "/api/v1/services", {
      name: "born-under-a-tombstone",
      domainId
    });
    expect(created.status, created.body).toBe(400);
  });

  // -----------------------------------------------------------------------------------------
  // The new refusal: a containment cycle has no org-root ancestor
  // -----------------------------------------------------------------------------------------

  it("an object cannot be made its own containment parent", async () => {
    const org = await createTestOrg(server, "self-parent");
    const service = await post(org.adminToken, "/api/v1/services", { name: "self-parent-svc" });
    expect(service.status, service.body).toBe(201);
    const serviceId = service.json().id as string;

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${serviceId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId: serviceId }
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(serviceId);
  });

  it("the ORG ROOT is the one row allowed to have no containment parent, and PATCHing it keeps that true", async () => {
    const org = await createTestOrg(server, "org-root-null");
    // `domainId: null` resolves to "the org root", so on the org root itself it would be a
    // self-loop — refused rather than written, and the row is left exactly as it was.
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/objects/organization/${org.orgId}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { domainId: null }
    });
    expect(res.statusCode, res.body).toBe(400);

    const after = await server.app.inject({
      method: "GET",
      url: `/api/v1/objects/organization/${org.orgId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(after.statusCode, after.body).toBe(200);
    expect((after.json() as { domainId: string | null }).domainId).toBeNull();
  });
});
