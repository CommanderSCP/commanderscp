import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { syncExternalGroupMembership } from "./identity-sync.js";
import { hasPermission } from "../authz/resolve.js";
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
 * IdP GROUP SYNC — reconciliation against a real graph
 * ================================================================================================
 *
 * THE PROPERTY UNDER TEST IS AUTHORITY, NOT EDGES. A sync that writes the right `member_of` rows
 * and does not change what anyone may DO would be an elaborate no-op, so every case here ends at
 * `hasPermission` — the same function the doors call — rather than at a row count.
 */
describe("IdP group sync reconciles membership and therefore authority", () => {
  let server: TestServer;
  let org: TestOrg;
  let owner: TestUser;
  /** The synced principal. Starts with no bindings of its own. */
  let user: TestUser;
  let adminGroupId: string;
  let unmappedGroupId: string;

  const CLAIM = "SCP.OrgAdmin";

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "idp-sync");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    user = await createTestUser(server, org, []);

    // A MAPPED group carrying real authority, authored through the real doors by a principal who
    // holds what it confers — the composition the mapping door is built around.
    const mapped = await server.app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: `idp-admins-${Date.now()}`,
        properties: { externalIdentity: { claimValue: CLAIM } }
      }
    });
    expect(mapped.statusCode, mapped.body).toBe(201);
    adminGroupId = mapped.json().id;

    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        subjectId: adminGroupId,
        roleId: await orgAdminRoleId(),
        scopeObjectId: org.orgId,
        reason: "idp-mapped admins",
        acknowledgedPrincipalIds: []
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // An UNMAPPED group the sync must never touch.
    const unmapped = await server.app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: `hand-managed-${Date.now()}` }
    });
    unmappedGroupId = unmapped.json().id;
    const joined = await server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { typeId: "member_of", fromId: user.objectId, toId: unmappedGroupId }
    });
    expect(joined.statusCode, joined.body).toBe(201);
  });

  afterAll(async () => {
    await server?.app.close();
  });

  async function orgAdminRoleId(): Promise<string> {
    const roles = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    return roles.json().items.find((r: { name: string }) => r.name === "OrgAdmin").id;
  }

  function sync(claimValues: string[]) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      syncExternalGroupMembership(tx, {
        orgId: org.orgId,
        subjectObjectId: user.objectId,
        claimValues,
        requestId: "test"
      })
    );
  }

  function may(permission: "policy:write" | "object:write") {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: user.objectId,
        scopeObjectId: org.orgId,
        permission
      })
    );
  }

  it("holds nothing before the first sync (known-positive control)", async () => {
    // Without this, the admission below could be true for a reason that has nothing to do with the
    // sync — the fixture user having been provisioned with authority, say.
    expect(await may("policy:write")).toBe(false);
  });

  it("a matching claim GRANTS the group's authority", async () => {
    const outcome = await sync([CLAIM]);
    expect(outcome.joined).toEqual([adminGroupId]);
    // The assertion that matters: not that an edge exists, but that the doors now admit them.
    expect(await may("policy:write")).toBe(true);
  });

  it("is IDEMPOTENT — a second login with the same claims changes nothing", async () => {
    const outcome = await sync([CLAIM]);
    expect(outcome.joined).toEqual([]);
    expect(outcome.left).toEqual([]);
    expect(await may("policy:write")).toBe(true);
  });

  it("LOSING the claim revokes it — the deprovisioning half", async () => {
    const outcome = await sync([]);
    expect(outcome.left).toEqual([adminGroupId]);
    // The half a happy-path test misses, and the reason this feature is worth having over hand
    // management: removal in the directory reaches SCP.
    expect(await may("policy:write")).toBe(false);
  });

  it("NEVER touches an unmapped group — a hand-managed team is outside this system", async () => {
    await sync([]);
    const rels = await server.app.inject({
      method: "GET",
      url: `/api/v1/relationships?fromId=${user.objectId}&typeId=member_of`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    const toIds = rels.json().items.map((r: { toId: string }) => r.toId);
    // The delete arm is scoped to MAPPED groups. If that scoping were lost, this membership — which
    // no IdP claim mentions — would be silently emptied at the user's next login.
    expect(toIds).toContain(unmappedGroupId);
  });

  it("an unmatched claim value is reported, not an error", async () => {
    const outcome = await sync(["SCP.NoSuchGroup"]);
    // A claim naming no SCP group is an ordinary state during rollout — the operator has not
    // created that group yet. Failing the login would make partial configuration unusable.
    expect(outcome.unmatchedClaimValues).toEqual(["SCP.NoSuchGroup"]);
  });

  it("re-granting after a revoke works — the cycle is stable in both directions", async () => {
    await sync([CLAIM]);
    expect(await may("policy:write")).toBe(true);
    await sync([]);
    expect(await may("policy:write")).toBe(false);
    await sync([CLAIM]);
    expect(await may("policy:write")).toBe(true);
  });
});

describe("the IdP mapping door — where the member_of subset rule's bar went", () => {
  let server: TestServer;
  let org: TestOrg;
  let owner: TestUser;
  /** Holds `role_binding:write` at the org root but NOT `freeze:override`. */
  let orgAdmin: TestUser;
  /** Holds `object:write` (so CAN create a group) but NOT `role_binding:write` — the fixture that
   *  isolates the mapping door's first bar. A Viewer cannot create a group AT ALL, so a refusal
   *  measured against one proves nothing about this door. */
  let operator: TestUser;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "idp-door");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    orgAdmin = await createTestUser(server, org, [{ role: "OrgAdmin", scope: org.orgId }]);
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
  });

  afterAll(async () => {
    await server?.app.close();
  });

  function createGroup(user: TestUser, payload: Record<string, unknown>) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${user.token}` },
      payload
    });
  }

  it("REFUSES a caller without role_binding:write at the org root", async () => {
    const res = await createGroup(operator, {
      name: `operator-mapped-${Date.now()}`,
      properties: { externalIdentity: { claimValue: "SCP.Anything" } }
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().detail as string).toContain("role_binding:write");
  });

  it("ADMITS an unmapped group from the same caller — the door narrows mapping, not groups", async () => {
    // Load-bearing: without it, the refusal above would be satisfied by a door that blocks every
    // group creation, and ordinary team management would be broken for a Viewer.
    const res = await createGroup(operator, { name: `operator-plain-${Date.now()}` });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("REFUSES mapping a group that already holds authority the caller lacks — BIND-then-MAP", async () => {
    // The ordering the door exists for. Without rule 2, an OrgAdmin could point a claim they
    // control at a group somebody else made powerful.
    const group = await createGroup(owner, { name: `preloaded-${Date.now()}` });
    const groupId = group.json().id;

    const roles = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    const ownerRoleId = roles.json().items.find((r: { name: string }) => r.name === "Owner").id;

    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        subjectId: groupId,
        roleId: ownerRoleId,
        scopeObjectId: org.orgId,
        reason: "owner-bearing group",
        acknowledgedPrincipalIds: []
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    const mapped = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/groups/${groupId}`,
      headers: { authorization: `Bearer ${orgAdmin.token}` },
      payload: { properties: { externalIdentity: { claimValue: "SCP.Sneaky" } } }
    });
    expect(mapped.statusCode, mapped.body).toBe(403);
    // Names the role and the missing permission, so the refusal is actionable.
    expect(mapped.json().detail as string).toMatch(/Owner/);
  });

  it("ADMITS the same mapping from a caller who DOES hold what the group carries", async () => {
    const group = await createGroup(owner, { name: `ownermapped-${Date.now()}` });
    const groupId = group.json().id;

    const roles = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    const ownerRoleId = roles.json().items.find((r: { name: string }) => r.name === "Owner").id;
    await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        subjectId: groupId,
        roleId: ownerRoleId,
        scopeObjectId: org.orgId,
        reason: "owner-bearing group",
        acknowledgedPrincipalIds: []
      }
    });

    const mapped = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/groups/${groupId}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { properties: { externalIdentity: { claimValue: "SCP.Legit" } } }
    });
    // The Owner could have granted that binding themselves, so they may delegate it.
    expect(mapped.statusCode, mapped.body).toBe(200);
  });

  it("the grant preview REPORTS that a subject is directory-synced", async () => {
    const group = await createGroup(owner, {
      name: `previewed-${Date.now()}`,
      properties: { externalIdentity: { claimValue: "SCP.Preview" } }
    });
    const groupId = group.json().id;

    const preview = await server.app.inject({
      method: "GET",
      url: `/api/v1/role-bindings/grant-preview?subjectId=${groupId}`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(preview.statusCode, preview.body).toBe(200);
    // D7's acknowledgement is a statement about a moment; for a synced group that moment is shorter
    // than it looks. A granter needs to learn that BEFORE granting, not afterwards.
    expect(preview.json().subjectExternallySynced).toBe(true);
  });

  it("and reports FALSE for an ordinary group, so the flag means something", async () => {
    const group = await createGroup(owner, { name: `plain-preview-${Date.now()}` });
    const preview = await server.app.inject({
      method: "GET",
      url: `/api/v1/role-bindings/grant-preview?subjectId=${group.json().id}`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(preview.json().subjectExternallySynced).toBe(false);
  });
});
