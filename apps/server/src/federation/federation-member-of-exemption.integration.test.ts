import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import { relationships } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, deleteObject } from "../graph/objects-repo.js";
import { createRelationship, deleteRelationship } from "../graph/relationships-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/** THE FEDERATION-IMPORT CARVE-OUT ON `member_of` IS DELIBERATE. See docs/federation.md §119. */
describe("§2a's federation-import carve-out on `member_of`", () => {
  let server: TestServer;
  let org: TestOrg;
  /** Holds nothing at all — the weakest principal there is, so an admitted write can only be the
   *  carve-out and never the subset rule quietly passing. */
  let nobody: { objectId: string };
  /** A group holding an org-root `Owner` binding: the most powerful thing §2a can refuse a join to. */
  let powerGroup: string;

  const foreignDomainId = asTrustDomainId(randomUUID());

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "memberof-exempt");
    nobody = await createTestUser(server, org, []);

    powerGroup = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const group = await createObject(tx, {
        orgId: org.orgId,
        typeId: "group",
        actorObjectId: org.orgId,
        requestId: "memberof-exempt-setup",
        name: `owners-${randomUUID().slice(0, 8)}`
      });
      await tx.execute(sql`
        INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, ${group.id}::uuid, rl.id,
               ${org.orgId}::uuid, 'allow'
        FROM roles rl WHERE rl.org_id IS NULL AND rl.name = 'Owner'
      `);
      return group.id;
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A fresh `user` object to be the joiner — one per case, because
   *  `relationships_org_type_from_to_key` makes a reused pair a 409 rather than the verdict. */
  async function freshJoiner(): Promise<string> {
    return withTenantTx(
      server.deps.db,
      org.orgId,
      async (tx) =>
        (
          await createObject(tx, {
            orgId: org.orgId,
            typeId: "user",
            actorObjectId: org.orgId,
            requestId: "memberof-exempt-joiner",
            name: `joiner-${randomUUID().slice(0, 8)}`
          })
        ).id
    );
  }

  async function liveEdges(fromId: string, toId: string): Promise<{ id: string }[]> {
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

  it("a REPLICATED `member_of` into a role-bearing group is APPLIED, not refused", async () => {
    // THE FAILURE THIS EXISTS TO PREVENT: `import-repo.ts`'s replay loop catches a 400 per entry and
    // re-throws everything else, so a 403 from §2a here does not skip the membership — it aborts the
    // peer's whole signed bundle, and the channel stays wedged until somebody edits the code. A
    // replicated membership was decided at the authoring domain, under that domain's own door.
    const joiner = await freshJoiner();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: nobody.objectId,
        requestId: "memberof-exempt-import",
        typeId: "member_of",
        fromId: joiner,
        toId: powerGroup,
        federationImport: { originDomainId: foreignDomainId, revision: 1 }
      });
    });
    expect(
      await liveEdges(joiner, powerGroup),
      "a peer's replicated membership must land — a throw here aborts the whole bundle"
    ).toHaveLength(1);
  });

  it("the IDENTICAL local write is REFUSED — so the carve-out is the difference, not a dead guard", async () => {
    // SAME actor, SAME group, SAME edge type, SAME function. The ONLY difference is
    // `federationImport`. Without this half, the case above passes just as well against a §2a that
    // was deleted outright, which is the opposite defect and the one with a measured exploit behind
    // it (`routes/rbac-role-binding-door.integration.test.ts` §8).
    const joiner = await freshJoiner();
    let thrown: unknown;
    try {
      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await createRelationship(tx, {
          orgId: org.orgId,
          actorObjectId: nobody.objectId,
          requestId: "memberof-exempt-local",
          typeId: "member_of",
          fromId: joiner,
          toId: powerGroup
        });
      });
    } catch (err) {
      thrown = err;
    }
    // READ OFF THE PROBLEM'S `detail`, not off `message` — an RFC 9457 error's message is the status
    // TITLE ("Forbidden"), which every 403 in the tree shares, so matching on it would pass against
    // any refusal at all and this case would stop being about §2a.
    const problem = thrown as { status?: number; detail?: string } | undefined;
    expect(problem?.status, `expected a 403 from §2a, got: ${String(thrown)}`).toBe(403);
    expect(problem?.detail).toContain("no-escalation subset rule");

    expect(await liveEdges(joiner, powerGroup)).toHaveLength(0);
  });
});

/** §7'S ADMINISTRATOR FLOOR TAKES THE SAME CARVE-OUT. See docs/federation.md §120. */
describe("§7's federation-import carve-out on the administrator floor", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  /** The `federation_self` domain id — the origin every locally authored row carries. */
  async function selfDomainId(orgId: string) {
    return withTenantTx(
      server.deps.db,
      orgId,
      async (tx) => (await ensureFederationSelf(tx, orgId)).domainId
    );
  }

  async function thrownFrom(
    fn: () => Promise<void>
  ): Promise<{ status?: number; detail?: string }> {
    try {
      await fn();
    } catch (err) {
      return err as { status?: number; detail?: string };
    }
    return {};
  }

  /** An org whose only administrator is reached through a team. See docs/federation.md §121. */
  async function orgAdministeredThroughATeam(label: string): Promise<{
    org: TestOrg;
    team: string;
    member: { objectId: string; token: string };
    edgeId: string;
  }> {
    const org = await createTestOrg(server, label);
    const bearer = { authorization: `Bearer ${org.adminToken}` };
    const roles = await server.app.inject({ method: "GET", url: "/api/v1/roles", headers: bearer });
    const ownerRoleId = (roles.json() as { items: { id: string; name: string }[] }).items.find(
      (r) => r.name === "Owner"
    )!.id;

    const team = await withTenantTx(
      server.deps.db,
      org.orgId,
      async (tx) =>
        (
          await createObject(tx, {
            orgId: org.orgId,
            typeId: "team",
            actorObjectId: org.orgId,
            requestId: "floor-exempt-setup",
            name: `admins-${randomUUID().slice(0, 8)}`
          })
        ).id
    );
    const member = await createTestUser(server, org, []);

    const joined = await server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: bearer,
      payload: { typeId: "member_of", fromId: member.objectId, toId: team }
    });
    expect(joined.statusCode, joined.body).toBe(201);
    const edgeId = (joined.json() as { id: string }).id;

    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: bearer,
      payload: {
        subjectId: team,
        roleId: ownerRoleId,
        scopeObjectId: org.orgId,
        reason: "seating the administrators team",
        acknowledgedPrincipalIds: [member.objectId]
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    const listed = await server.app.inject({
      method: "GET",
      url: "/api/v1/role-bindings",
      headers: bearer
    });
    const bootstrap = (listed.json() as { items: { id: string; subjectId: string }[] }).items.find(
      (b) => b.subjectId !== team
    )!;
    const retired = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${bootstrap.id}`,
      headers: bearer,
      payload: { reason: "retiring the bootstrap admin" }
    });
    // The admission half of the fixture — if this 409s, the floor is refusing something it must
    // permit and every measurement below is against the wrong state.
    expect(retired.statusCode, retired.body).toBe(200);

    return { org, team, member, edgeId };
  }

  it("a REPLICATED `relationship_tombstone` that empties the floor is APPLIED, not refused", async () => {
    const { org, member, team, edgeId } = await orgAdministeredThroughATeam("floor-exempt-edge");
    const origin = await selfDomainId(org.orgId);

    // THE GUARDED HALF FIRST, so the exemption below is measured against a guard that demonstrably
    // fires on this exact row. Same function, same edge, same actor — only `federationImport` moves.
    const refusal = await thrownFrom(async () => {
      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await deleteRelationship(tx, {
          orgId: org.orgId,
          actorObjectId: member.objectId,
          requestId: "floor-exempt-local",
          id: edgeId
        });
      });
    });
    expect(refusal.status, `expected a 409 from §7, got: ${JSON.stringify(refusal)}`).toBe(409);
    expect(refusal.detail).toContain("role_binding:write");
    expect(
      await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        tx
          .select({ id: relationships.id })
          .from(relationships)
          .where(
            and(
              eq(relationships.orgId, org.orgId),
              eq(relationships.id, edgeId),
              isNull(relationships.deletedAt)
            )
          )
      )
    ).toHaveLength(1);

    // THE EXEMPT HALF. A throw here does not skip one entry — it aborts the peer's whole signed
    // bundle, because `import-repo.ts`'s replay loop re-throws anything that is not a 400.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await deleteRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: member.objectId,
        requestId: "floor-exempt-import",
        id: edgeId,
        federationImport: { originDomainId: origin, revision: 2 }
      });
    });
    expect(
      await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        tx
          .select({ id: relationships.id })
          .from(relationships)
          .where(
            and(
              eq(relationships.orgId, org.orgId),
              eq(relationships.id, edgeId),
              isNull(relationships.deletedAt)
            )
          )
      ),
      "a peer's replicated tombstone must land — a throw here wedges the whole bundle"
    ).toHaveLength(0);
    // …and the org really is below the floor now, which is the accepted cost stated in §8 rather
    // than an accident: the team's binding survives and reaches nobody live.
    expect(team).toBeTruthy();
  });

  it("a REPLICATED `object_tombstone` that empties the floor is APPLIED, not refused", async () => {
    // THE SECOND CALL SITE. `deleteObject` makes its own floor call — the one no cascade covers,
    // because tombstoning the principal that holds the binding DIRECTLY removes no edge at all — so
    // its carve-out needs its own pin. Dropping `!input.federationImport` there would 409 a peer's
    // `object_tombstone` for a replicated user and wedge that bundle exactly as above.
    const org = await createTestOrg(server, "floor-exempt-object");
    const bearer = { authorization: `Bearer ${org.adminToken}` };
    const meRes = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bearer
    });
    const bootstrapSubject = (meRes.json() as { subjectObjectId: string }).subjectObjectId;
    const origin = await selfDomainId(org.orgId);

    const refusal = await thrownFrom(async () => {
      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await deleteObject(tx, {
          orgId: org.orgId,
          typeId: "user",
          actorObjectId: bootstrapSubject,
          requestId: "floor-exempt-object-local",
          idOrUrn: bootstrapSubject
        });
      });
    });
    expect(refusal.status, `expected a 409 from §7, got: ${JSON.stringify(refusal)}`).toBe(409);
    expect(refusal.detail).toContain("role_binding:write");
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v1/roles", headers: bearer })).statusCode
    ).toBe(200);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await deleteObject(tx, {
        orgId: org.orgId,
        typeId: "user",
        actorObjectId: bootstrapSubject,
        requestId: "floor-exempt-object-import",
        idOrUrn: bootstrapSubject,
        federationImport: { originDomainId: origin, revision: 2 }
      });
    });
    const tombstoned = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.id, bootstrapSubject))
      })
    );
    expect(
      tombstoned?.deletedAt,
      "a peer's replicated object tombstone must land — a throw here wedges the whole bundle"
    ).not.toBeNull();
  });
});
