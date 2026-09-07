import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";

/** THE ADMINISTRATOR FLOOR IS AT THE CHOKE POINT, NOT AT THE ROUTE. See docs/iac.md §3. */
describe("the administrator floor is enforced on the IaC apply path (role-binding-door §7)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-floor");
  });

  afterAll(async () => {
    await server?.close();
  });

  async function objectIdByUrn(urn: string): Promise<string> {
    const row = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, urn))
      })
    );
    if (!row) throw new Error(`no object with urn '${urn}'`);
    return row.id;
  }

  async function liveMemberOfEdges(fromId: string, toId: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "member_of"),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );
  }

  it("IaC apply cannot PRUNE the membership that makes the org's administrators reachable", async () => {
    const stackName = `floor-${uuidv7().slice(0, 8)}`;
    const teamUrn = `urn:scp:${stackName}:team:admins`;
    const adminClient = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // The administrator, and the URN that lets a manifest name them. The harness mints users without
    // one; stamping it is fixture plumbing, not the thing under test.
    const admin = await createTestUser(server, org, []);
    const adminUrn = `urn:scp:${stackName}:user:admin`;
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ urn: adminUrn })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, admin.objectId)));
    });

    // THE ESTATE, DECLARED IN IaC: an administrators team and one membership. Applied by the
    // bootstrap admin, whose Owner binding is about to be retired in favour of the team.
    const withEdge: DesiredStateManifest = {
      stackName,
      objects: [{ urn: teamUrn, typeId: "team", name: `admins-${stackName}` }],
      relationships: [{ typeId: "member_of", fromUrn: adminUrn, toUrn: teamUrn }]
    };
    const plan1 = await adminClient.plans.create(withEdge);
    await adminClient.plans.apply(plan1.id);
    const teamId = await objectIdByUrn(teamUrn);
    expect(await liveMemberOfEdges(admin.objectId, teamId)).toHaveLength(1);

    // Seat the team, then retire the bootstrap admin — through the real doors, because both are
    // actions a real operator takes and both must be ADMITTED. The revoke succeeding is the
    // admission half of door A: the team reaches a live member, so the floor holds.
    const roles = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    const ownerRoleId = (roles.json() as { items: { id: string; name: string }[] }).items.find(
      (r) => r.name === "Owner"
    )!.id;
    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        subjectId: teamId,
        roleId: ownerRoleId,
        scopeObjectId: org.orgId,
        reason: "seating the administrators team",
        acknowledgedPrincipalIds: [admin.objectId]
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);
    const teamBindingId = (bound.json() as { id: string }).id;

    const listed = await server.app.inject({
      method: "GET",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    const bootstrapBinding = (listed.json() as { items: { id: string }[] }).items.find(
      (b) => b.id !== teamBindingId
    )!;
    const retired = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${bootstrapBinding.id}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { reason: "retiring the bootstrap admin now the team is seated" }
    });
    expect(retired.statusCode, retired.body).toBe(200);

    // THE PRUNE. Same stack, same object, the relationship simply removed from the manifest — which
    // is how an operator deletes an edge in IaC. `prepareApplyChecks` sees a `relationship:write`
    // the actor genuinely holds at both endpoints, and nothing in the plan mentions RBAC at all.
    const withoutEdge: DesiredStateManifest = { ...withEdge, relationships: [] };
    const adminUserClient = new ScpClient({ baseUrl: server.baseUrl, token: admin.token });
    const plan2 = await adminUserClient.plans.create(withoutEdge);
    const failure = await adminUserClient.plans
      .apply(plan2.id)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure, "the pruning apply must be REFUSED, not resolved").toBeInstanceOf(ScpApiError);
    const problem = failure as ScpApiError;
    expect(problem.status, JSON.stringify(problem.problem)).toBe(409);
    expect(JSON.stringify(problem.problem)).toContain("role_binding:write");

    // THE EDGE SURVIVED — read from the table, because an apply that pruned the row and threw
    // afterwards would satisfy the status assertion and leave the org unadministrable.
    expect(await liveMemberOfEdges(admin.objectId, teamId)).toHaveLength(1);

    // THE ADMISSION PAIR: give the org a second, directly-bound administrator and re-run the SAME
    // apply. Identical manifest, identical actor, identical prune — admitted, because the floor
    // survives it. Without this the guard could refuse every IaC prune of a `member_of` edge.
    const spare = await createTestUser(server, org, []);
    const spareBound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        subjectId: spare.objectId,
        roleId: ownerRoleId,
        scopeObjectId: org.orgId,
        reason: "a second, directly bound administrator"
      }
    });
    expect(spareBound.statusCode, spareBound.body).toBe(201);

    const plan3 = await adminUserClient.plans.create(withoutEdge);
    await adminUserClient.plans.apply(plan3.id);
    expect(await liveMemberOfEdges(admin.objectId, teamId)).toHaveLength(0);

    // And the estate really is still administrable through the surviving principal.
    const stillWorks = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${spare.token}` }
    });
    expect(stillWorks.statusCode, stillWorks.body).toBe(200);
    expect(
      await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        tx.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM role_bindings
          WHERE org_id = ${org.orgId}::uuid AND subject_id = ${spare.objectId}::uuid
        `)
      ).then((r) => Number(r.rows[0]!.n))
    ).toBe(1);
  });
});
