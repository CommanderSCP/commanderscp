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
 * RE-CREATING A REMOVED RELATIONSHIP — a pre-existing defect, found by needing leave-and-rejoin
 * ================================================================================================
 *
 * `relationships_org_type_from_to_key` is a FULL unique constraint on
 * `(org_id, type_id, from_id, to_id)`, while every removal in this codebase is a SOFT delete. Those
 * two facts together meant an edge could be created exactly ONCE, ever: after a delete the triple
 * stayed occupied by a tombstone that confers nothing, and re-creating it returned
 * `409 relationship already exists` — naming a row the caller cannot see and which grants nothing.
 *
 * MEASURED on the ordinary route before the fix: join a group, `DELETE /relationships/{id}`, POST
 * the same edge -> 409. So a person removed from a team could never be re-added, by anyone, for the
 * life of the deployment.
 *
 * It is INDEPENDENT OF SSO and predates it. It surfaced only because a directory sync has to handle
 * leave-and-rejoin, which is an entirely ordinary directory event — the feature did not cause the
 * bug, it just made it unavoidable.
 *
 * The fix is RESURRECTION rather than a partial index: reviving the row keeps ONE row per triple,
 * which is the identity the constraint already asserts, where a partial index would allow N
 * tombstones beside one live row and make every reader that joins on the triple pick between them.
 */
describe("a soft-deleted relationship can be re-created (resurrection)", () => {
  let server: TestServer;
  let org: TestOrg;
  let owner: TestUser;
  let user: TestUser;
  let groupId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "resurrect");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    user = await createTestUser(server, org, []);
    const group = await server.app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: `resurrect-${Date.now()}` }
    });
    groupId = group.json().id;
  });

  afterAll(async () => {
    await server?.app.close();
  });

  function join() {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { typeId: "member_of", fromId: user.objectId, toId: groupId }
    });
  }

  it("join, leave, and REJOIN — the cycle a directory performs routinely", async () => {
    const first = await join();
    expect(first.statusCode, first.body).toBe(201);
    const relId = first.json().id;

    const removed = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/relationships/${relId}`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect([200, 204]).toContain(removed.statusCode);

    const second = await join();
    // 409 before the fix. The whole defect in one assertion.
    expect(second.statusCode, second.body).toBe(201);
  });

  it("keeps ONE row per triple — the revived row, not a second one", async () => {
    const rels = await server.app.inject({
      method: "GET",
      url: `/api/v1/relationships?fromId=${user.objectId}&typeId=member_of`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    const toThisGroup = rels.json().items.filter((r: { toId: string }) => r.toId === groupId);
    // A partial-index fix would have produced two rows here and left every triple-joining reader to
    // choose. Resurrection keeps the identity the constraint asserts.
    expect(toThisGroup).toHaveLength(1);
    expect(toThisGroup[0].deletedAt ?? null).toBeNull();
    // `revision` advances rather than resetting, so the row's history is not rewritten to look new.
    expect(toThisGroup[0].revision).toBeGreaterThan(1);
  });

  it("the resurrected membership CONFERS authority again, not just a row", async () => {
    const roles = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    const viewerRoleId = roles.json().items.find((r: { name: string }) => r.name === "Viewer").id;
    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        subjectId: groupId,
        roleId: viewerRoleId,
        scopeObjectId: org.orgId,
        reason: "check the revived edge resolves",
        acknowledgedPrincipalIds: [user.objectId]
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    const effective = await server.app.inject({
      method: "GET",
      url: `/api/v1/authz/effective?scopeObjectId=${org.orgId}`,
      headers: { authorization: `Bearer ${user.token}` }
    });
    // `subject_expand` joins `relationships.deleted_at`. A revived row whose tombstone was not
    // actually cleared would return a 201 above and confer nothing here.
    expect(effective.json().permissions).toContain("object:read");
  });
});
