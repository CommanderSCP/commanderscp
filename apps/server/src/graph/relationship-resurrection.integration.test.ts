import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { outbox, syncJournal } from "../db/schema.js";
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

/**
 * ================================================================================================
 * A RESURRECTION IS A CREATE — and it must leave every trace a create leaves
 * ================================================================================================
 *
 * The resurrection branch returned as soon as it had un-tombstoned the row, so reviving an edge was
 * the ONE write in `relationships-repo.ts` that happened invisibly: no audit event, no sync-journal
 * entry, no event publish. The tests above cover the row, the revision and the authority it
 * confers — all of which were already green while the rejoin was unauditable, unreplicable and
 * unobservable. That is exactly the shape of a test that passes for a reason other than its claim,
 * so the traces get their own assertions here, on a fresh org so the counts mean what they say.
 */
describe("a resurrection writes the same records a first-time create writes", () => {
  let server: TestServer;
  let org: TestOrg;
  let owner: TestUser;
  let user: TestUser;
  let groupId: string;
  let relId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "resurrect-traces");
    owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    user = await createTestUser(server, org, []);
    const group = await server.app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: `resurrect-traces-${Date.now()}` }
    });
    groupId = group.json().id;

    const first = await server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { typeId: "member_of", fromId: user.objectId, toId: groupId }
    });
    expect(first.statusCode, first.body).toBe(201);
    relId = first.json().id;

    const removed = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/relationships/${relId}`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect([200, 204]).toContain(removed.statusCode);

    const rejoined = await server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { typeId: "member_of", fromId: user.objectId, toId: groupId }
    });
    expect(rejoined.statusCode, rejoined.body).toBe(201);
    // The revived row keeps the triple's identity, so the rejoin names the SAME edge id — which is
    // what makes the per-subject counts below unambiguous.
    expect(rejoined.json().id).toBe(relId);
  });

  afterAll(async () => {
    await server?.close();
  });

  it("audits the rejoin — read back through the public audit API, in chain order", async () => {
    const page = await server.app.inject({
      method: "GET",
      url: "/api/v1/audit-events?limit=200",
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(page.statusCode, page.body).toBe(200);
    const forEdge = page
      .json()
      .items.filter((e: { subjectId: string | null }) => e.subjectId === relId)
      .map((e: { action: string }) => e.action);
    // Join, leave, REJOIN. One event before the fix — the operator saw the leave and never the
    // return, which is the audit log answering "is this person in the team" with a stale no.
    expect(forEdge).toEqual([
      "relationship.member_of.create",
      "relationship.member_of.delete",
      "relationship.member_of.create"
    ]);
  });

  it("journals the rejoin, so a peer that already replicated the tombstone learns the edge is back", async () => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ entryKind: syncJournal.entryKind, payload: syncJournal.payload })
        .from(syncJournal)
        .where(eq(syncJournal.orgId, org.orgId))
        .orderBy(syncJournal.sequence)
    );
    const forEdge = rows
      .filter((r) => (r.payload as { id?: unknown }).id === relId)
      .filter(
        (r) => r.entryKind === "relationship_upsert" || r.entryKind === "relationship_tombstone"
      )
      .map((r) => r.entryKind);
    expect(forEdge).toEqual([
      "relationship_upsert",
      "relationship_tombstone",
      "relationship_upsert"
    ]);

    // The revived row's OWN revision, not a fresh insert's `1`: a receiver that applied the
    // tombstone must see the resurrection as the later write, and revision 1 would not be.
    const revived = rows.filter(
      (r) => r.entryKind === "relationship_upsert" && (r.payload as { id?: unknown }).id === relId
    );
    expect((revived.at(-1)!.payload as { revision: number }).revision).toBeGreaterThan(1);
  });

  it("publishes scp.relationship.created for the rejoin", async () => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.orgId, org.orgId),
            eq(outbox.type, "scp.relationship.created"),
            eq(outbox.subject, relId)
          )
        )
    );
    // Two creates for this edge, so two events. One before the fix: a subscriber reconciling on
    // events kept the membership removed forever.
    expect(rows).toHaveLength(2);
  });
});
