import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * CUSTOM ROLES — role-model.md §5 step 10
 * ================================================================================================
 *
 * THE PRECONDITION THIS SHIPS ON. The proposal gated custom roles behind closing the
 * `hasRoleAtScope` quorum bypass, and the first test below is the reason: without that fix, an org
 * authoring a zero-permission role named 'Approver' would have made its holders eligible quorum
 * voters everywhere a policy names Approver. `authz/quorum-name-collision.integration.test.ts`
 * pins the resolver; this file pins that the authoring door refuses the name outright, so the two
 * cover the same hazard at the door and at the resolver.
 *
 * WHAT AUTHORING IS. It confers nothing — `POST /role-bindings` re-runs the full subset rule
 * against whoever tries to bind the result. The bars here keep the CATALOGUE honest: a role that
 * advertises authority its author cannot confer misleads every operator who reads `GET /roles`.
 */
describe("custom roles: POST/PATCH/DELETE /api/v1/roles (role-model.md §5 step 10)", () => {
  let server: TestServer;
  let org: TestOrg;
  /** Holds Owner at the org root — may author anything Owner carries. */
  let owner: TestUser;
  /** Holds Viewer only — no `role_binding:write` at all. */
  let viewer: TestUser;
  /** Holds OrgAdmin: `role_binding:write` YES, `freeze:override` NO (Owner alone holds that).
   *  The fixture that separates bar 1 from bar 3 — with a Viewer, bar 1 refuses first and the
   *  subset rule is never reached, so a subset-rule test written against a Viewer proves nothing
   *  about the subset rule. */
  let orgAdmin: TestUser;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "custom-roles");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    orgAdmin = await createTestUser(server, org, [{ role: "OrgAdmin", scope: org.orgId }]);
  });

  afterAll(async () => {
    await server?.app.close();
  });

  function create(user: TestUser, body: Record<string, unknown>) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { reason: "test", ...body }
    });
  }

  it("authors an org role, and GET /roles then publishes it beside the built-ins", async () => {
    const res = await create(owner, {
      name: `Release Captain ${Date.now()}`,
      permissions: ["object:read", "change:accept"]
    });
    expect(res.statusCode, res.body).toBe(201);
    const role = res.json();
    expect(role.orgId).toBe(org.orgId);
    expect(role.permissions).toContain("change:accept");

    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    // Built, and INSTALLED: the authored row has to appear on the read surface the UI uses, or the
    // feature exists only in the writer's imagination.
    expect(list.json().items.some((r: { id: string }) => r.id === role.id)).toBe(true);
  });

  it("REFUSES a built-in name — the quorum hazard, refused where it is fixable", async () => {
    const res = await create(owner, { name: "Approver", permissions: ["object:read"] });
    // Such a row is permanently unbindable anyway (`builtInNameCollisionReason` refuses it at the
    // grant door) AND, since the quorum fix, silently ineligible to vote. Refusing at authoring
    // means an operator learns immediately rather than at the next grant.
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().detail as string).toContain("built-in");
  });

  it("REFUSES a permission the author does not hold — the catalogue may not advertise a lie", async () => {
    const res = await create(orgAdmin, {
      name: `Escalator ${Date.now()}`,
      permissions: ["freeze:override"]
    });
    // A Viewer authoring 'Estate Owner' with freeze:override is the shape this refuses. Note it is
    // not an escalation on its own — the binding door would refuse the grant — which is exactly why
    // the refusal is stated in terms of the catalogue rather than of privilege.
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().detail as string).toContain("freeze:override");
  });

  it("REFUSES a caller with no role_binding:write at all", async () => {
    const res = await create(viewer, {
      name: `Harmless ${Date.now()}`,
      permissions: ["object:read"]
    });
    // Even a role carrying only permissions the Viewer holds: authoring is conferring-adjacent, and
    // the bar is `role_binding:write` at the org root.
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().detail as string).toContain("role_binding:write");
  });

  it("REFUSES an unknown permission string — the `org:admin` shape, authored through the API", async () => {
    const res = await create(owner, {
      name: `Bogus ${Date.now()}`,
      permissions: ["object:read", "estate:rule-everything"]
    });
    // A string no door demands renders in GET /roles as authority and gates nothing. The drift gate
    // stops that arriving by migration; this stops it arriving by API.
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().detail as string).toContain("'estate:rule-everything'");
  });

  it("REFUSES a duplicate name within the org (roles_org_name_key)", async () => {
    const name = `Duplicated ${Date.now()}`;
    expect((await create(owner, { name, permissions: ["object:read"] })).statusCode).toBe(201);
    const second = await create(owner, { name, permissions: ["object:write"] });
    // Two roles with one name and different arrays make the catalogue unreadable: both bind, both
    // render identically, and a revoke names one of them.
    expect(second.statusCode, second.body).toBe(409);
  });

  it("PATCH edits an org role, and records what the widening reached", async () => {
    const created = await create(owner, {
      name: `Editable ${Date.now()}`,
      permissions: ["object:read"]
    });
    const id = created.json().id as string;

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${id}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { permissions: ["object:read", "object:write"], reason: "widen" }
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().permissions).toContain("object:write");
  });

  it("PATCH applies the subset rule to the RESULTING array, not the delta", async () => {
    const created = await create(owner, {
      name: `Subset ${Date.now()}`,
      permissions: ["object:read"]
    });
    const id = created.json().id as string;

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${id}`,
      headers: { authorization: `Bearer ${orgAdmin.token}` },
      payload: { permissions: ["object:read", "freeze:override"], reason: "escalate" }
      // OrgAdmin, not Viewer: this must be refused by the SUBSET rule, and a Viewer would be
      // refused by the `role_binding:write` bar before the subset rule ran.
    });
    expect(patched.statusCode).toBe(403);
  });

  it("a BUILT-IN is not editable by any tenant — it is a shared row for every org", async () => {
    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    const builtIn = list.json().items.find((r: { orgId: string | null }) => r.orgId === null);
    expect(builtIn).toBeDefined();

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${builtIn.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { permissions: ["object:read"], reason: "should be refused" }
    });
    // Editing one would rewrite the permission set of every org on the deployment at once — the
    // shared-singleton property role-model.md §2 turns on. An Owner is the strongest tenant
    // principal there is, and it is still refused.
    expect(patched.statusCode, patched.body).toBe(403);
    expect(patched.json().detail as string).toContain("built-in");
  });

  it("DELETE removes a role nothing points at", async () => {
    const created = await create(owner, {
      name: `Disposable ${Date.now()}`,
      permissions: ["object:read"]
    });
    const id = created.json().id as string;

    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${id}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { reason: "no longer needed" }
    });
    expect(res.statusCode, res.body).toBe(204);

    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(list.json().items.some((r: { id: string }) => r.id === id)).toBe(false);
  });

  it("DELETE REFUSES while bindings exist — a cascade would be an unreviewable mass revoke", async () => {
    const created = await create(owner, {
      name: `Held ${Date.now()}`,
      permissions: ["object:read"]
    });
    const roleId = created.json().id as string;

    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        subjectId: viewer.objectId,
        roleId,
        scopeObjectId: org.orgId,
        reason: "bind it"
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${roleId}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { reason: "tidy up" }
    });
    // Cascading would revoke authority from every holder in one request, under one audit event
    // naming the ROLE and not the principals who lost it. Same shape as refusing to delete a
    // container with children.
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().detail as string).toContain("binding");
  });

  it("an authored role is BINDABLE and actually confers its permissions", async () => {
    // The end-to-end property. Everything above is refusals; without this, the whole feature could
    // be authoring rows that nothing ever honours.
    const created = await create(owner, {
      name: `Working ${Date.now()}`,
      permissions: ["object:read", "object:write"]
    });
    const roleId = created.json().id as string;
    const subject = await createTestUser(server, org, []);

    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { subjectId: subject.objectId, roleId, scopeObjectId: org.orgId, reason: "grant" }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    const write = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${subject.token}` },
      payload: { name: `svc-${Date.now()}` }
    });
    expect(write.statusCode, write.body).toBe(201);

    const effective = await server.app.inject({
      method: "GET",
      url: `/api/v1/authz/effective?scopeObjectId=${org.orgId}`,
      headers: { authorization: `Bearer ${subject.token}` }
    });
    // And step 6's read surface agrees with the door, for a role that did not exist when step 6
    // was written.
    expect(effective.json().permissions).toContain("object:write");
  });
});
