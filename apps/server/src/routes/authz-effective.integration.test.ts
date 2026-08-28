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
 * `GET /api/v1/authz/effective` and `/auth/me`'s identity half — role-model.md §5 step 6
 * ================================================================================================
 *
 * THE PROPERTY UNDER TEST IS AGREEMENT, NOT PLAUSIBILITY. An effective-permissions endpoint that
 * returns a believable-looking set is worse than none: a UI renders controls from it, and a set
 * that disagrees with what the doors actually enforce produces either phantom buttons that 403 or
 * hidden buttons the caller was entitled to. So the assertions below do not check the response
 * against a hand-written expectation of what a role "should" carry — they check it against what
 * `authorize` actually does, by making the same call the UI would gate and comparing.
 *
 * Every test enters through the HTTP surface rather than calling `effectivePermissions` directly.
 * A unit test of the resolver would pass identically whether or not the route were wired into
 * `app.ts` at all, and "built, never installed" is this repo's most expensive recurring defect.
 */
describe("GET /authz/effective — the caller's own permissions at one object (role-model.md §5 step 6)", () => {
  let server: TestServer;
  let org: TestOrg;
  let owner: TestUser;
  let viewer: TestUser;
  /** A user with NO bindings at all — the "you hold nothing here" case, which must be a 200. */
  let unbound: TestUser;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "authz-effective");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    unbound = await createTestUser(server, org, []);
  });

  afterAll(async () => {
    await server?.app.close();
  });

  async function effectiveAt(user: TestUser, scopeObjectId: string) {
    return server.app.inject({
      method: "GET",
      url: `/api/v1/authz/effective?scopeObjectId=${scopeObjectId}`,
      headers: { authorization: `Bearer ${user.token}` }
    });
  }

  it("the route is REACHABLE — it is registered in app.ts, not merely written", async () => {
    // The wiring assertion, first and on its own. Delete `registerAuthzRoutes(app, deps)` from
    // app.ts and this is a 404 while every other test in this file also fails; that is the point —
    // there is no arrangement in which the resolver works and the feature does not exist.
    const res = await effectiveAt(owner, org.orgId);
    expect(res.statusCode).toBe(200);
  });

  it("an Owner bound at the org root holds permissions there, and the set is sorted and deduplicated", async () => {
    const res = await effectiveAt(owner, org.orgId);
    const body = res.json();
    expect(body.scopeObjectId).toBe(org.orgId);
    expect(body.permissions).toContain("object:write");
    expect(body.permissions).toContain("role_binding:write");
    expect([...body.permissions].sort()).toEqual(body.permissions);
    expect(new Set(body.permissions).size).toBe(body.permissions.length);
  });

  it("AGREES WITH THE DOORS: a Viewer's reported set omits `object:write`, and the write really is refused", async () => {
    const res = await effectiveAt(viewer, org.orgId);
    const body = res.json();
    expect(body.permissions).toContain("object:read");
    expect(body.permissions).not.toContain("object:write");

    // The half that makes the assertion above mean something. If `effectivePermissions` ever
    // diverged from `authorize` — a different deny rule, a different walk bound — this pairing is
    // what catches it, and no amount of checking the response against a hand-written list would.
    const write = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { name: "should-be-refused" }
    });
    expect(write.statusCode).toBe(403);
  });

  it("the Owner's reported `object:write` is likewise REAL — the agreement is checked in both directions", async () => {
    const body = (await effectiveAt(owner, org.orgId)).json();
    expect(body.permissions).toContain("object:write");
    const write = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: "authz-effective-allowed" }
    });
    // A test that only ever proves refusals would pass on an endpoint that reports the empty set
    // for everybody.
    expect(write.statusCode).toBe(201);
  });

  it("a principal with no bindings gets 200 and an EMPTY set — not a 403", async () => {
    const res = await effectiveAt(unbound, org.orgId);
    // "You may not ask what you may do" and "you may do nothing" are different facts, and a UI
    // that cannot tell them apart cannot render an honest empty state.
    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toEqual([]);
    expect(res.json().contributingBindings).toEqual([]);
  });

  it("names the bindings that produced the answer, including the subject they were written on", async () => {
    const body = (await effectiveAt(owner, org.orgId)).json();
    expect(body.contributingBindings.length).toBeGreaterThan(0);
    const ownerBinding = body.contributingBindings.find(
      (b: { roleName: string }) => b.roleName === "Owner"
    );
    expect(ownerBinding).toBeDefined();
    expect(ownerBinding.scopeObjectId).toBe(org.orgId);
    expect(ownerBinding.viaSubjectId).toBe(owner.objectId);
    expect(ownerBinding.effect).toBe("allow");
  });

  it("DENY-OVERRIDE IS PER-PERMISSION, not per-binding: a Viewer deny beside an Owner allow removes only Viewer's set", async () => {
    // THE MISTAKE THIS EXISTS TO CATCH. `hasPermission` filters to bindings whose ROLE CARRIES THE
    // REQUESTED PERMISSION and only then looks for a deny — so a deny row suppresses exactly the
    // permissions its own role holds, and nothing else. The plausible one-query rewrite
    // (`bool_or(effect='deny')` over ALL matching bindings, ungrouped) instead lets one narrow deny
    // wipe the caller's entire set. Both implementations return a believable-looking array; only
    // this fixture tells them apart.
    const mixed = await createTestUser(server, org, [
      { role: "Owner", scope: org.orgId, effect: "allow" },
      { role: "Viewer", scope: org.orgId, effect: "deny" }
    ]);
    const body = (await effectiveAt(mixed, org.orgId)).json();

    // Viewer carries `object:read`, so the deny takes it — even though Owner also carries it.
    expect(body.permissions).not.toContain("object:read");
    // Owner carries `role_binding:write` and Viewer does not, so the deny cannot reach it.
    expect(body.permissions).toContain("role_binding:write");
    // Not merely non-empty by accident: a whole-binding deny would have emptied this entirely.
    expect(body.permissions.length).toBeGreaterThan(1);

    // AND IT AGREES WITH THE DOOR, which is the assertion that makes the two above more than a
    // description of the implementation.
    const read = await server.app.inject({
      method: "GET",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${mixed.token}` }
    });
    expect(read.statusCode).toBe(403);
  });

  it("a deny binding is still REPORTED in contributingBindings — an unexplained absence is worse than none", async () => {
    const denied = await createTestUser(server, org, [
      { role: "Owner", scope: org.orgId, effect: "allow" },
      { role: "Viewer", scope: org.orgId, effect: "deny" }
    ]);
    const body = (await effectiveAt(denied, org.orgId)).json();
    const denyRow = body.contributingBindings.find((b: { effect: string }) => b.effect === "deny");
    // An operator asking "why can I not read here" is looking at exactly this row. Filtering deny
    // rows out of the explanation would make the answer a mystery.
    expect(denyRow).toBeDefined();
    expect(denyRow.roleName).toBe("Viewer");
  });

  it("an unknown scope object is a 404, distinguishable from holding nothing", async () => {
    const res = await effectiveAt(owner, "00000000-0000-4000-8000-0000000000ff");
    expect(res.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/authz/effective?scopeObjectId=${org.orgId}`
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-uuid scope with 400 rather than resolving it", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/authz/effective?scopeObjectId=not-a-uuid",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /auth/me — the identity half (role-model.md §5 step 6)", () => {
  let server: TestServer;
  let org: TestOrg;
  let owner: TestUser;
  let unbound: TestUser;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "authz-me");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    unbound = await createTestUser(server, org, []);
  });

  afterAll(async () => {
    await server?.app.close();
  });

  async function me(user: TestUser) {
    return server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${user.token}` }
    });
  }

  it("carries the caller's bindings and the union of what they confer", async () => {
    const body = (await me(owner)).json();
    expect(body.roleBindings.some((b: { roleName: string }) => b.roleName === "Owner")).toBe(true);
    expect(body.permissionsAnywhere).toContain("object:write");
    expect([...body.permissionsAnywhere].sort()).toEqual(body.permissionsAnywhere);
  });

  it("the pre-existing fields are unchanged — this is an ADDITIVE change to a live contract", async () => {
    const body = (await me(owner)).json();
    // `/auth/me` is how the SPA discovers its session. Adding fields to it must not disturb the
    // ones the shell already reads, and asserting that here is cheaper than discovering it in a
    // browser.
    expect(typeof body.userId).toBe("string");
    expect(body.orgId).toBe(org.orgId);
    expect(body.username).toBe(owner.username);
    expect(body.subjectObjectId).toBe(owner.objectId);
    expect(body.instanceRole).toBeDefined();
  });

  it("a principal with no bindings gets empty arrays, not absent fields", async () => {
    const body = (await me(unbound)).json();
    // Required-and-always-present: an absent field reads as "old server" and a client would have
    // to guess, which is the same rule `RoleSchema.deprecated` follows.
    expect(body.roleBindings).toEqual([]);
    expect(body.permissionsAnywhere).toEqual([]);
  });
});
