import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull, sql } from "drizzle-orm";
import { asContainmentDomainId } from "@scp/schemas";
import { relationships, users } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { principalsReachedBy } from "../authz/role-binding-door.js";
import { buildOpenApiDocument } from "../openapi/build-document.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/** THE ADMINISTRATOR FLOOR IS A PROPERTY OF THE ORG. See docs/routes.md §317. */
describe("the administrator floor is an invariant of the org, not a rule on one door", () => {
  let server: TestServer;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function call(
    method: "GET" | "POST" | "DELETE",
    token: string,
    url: string,
    payload?: Record<string, unknown>
  ): Promise<LightMyRequestResponse> {
    const options: InjectOptions = { method, url, headers: bearer(token) };
    if (payload !== undefined) options.payload = payload;
    return server.app.inject(options);
  }

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  async function bindings(
    token: string
  ): Promise<{ id: string; subjectId: string; roleName: string }[]> {
    const res = await call("GET", token, "/api/v1/role-bindings");
    if (res.statusCode !== 200) throw new Error(`list failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { items: { id: string; subjectId: string; roleName: string }[] }).items;
  }

  /** `domainId` omitted means the ORG ROOT, which is `createObject`'s own default and where every
   *  user, group and team on this estate sits unless somebody says otherwise. Passing one is how the
   *  filtered-preview case builds a team a service-scoped principal can read. */
  async function mkObject(
    orgId: string,
    typeId: string,
    label: string,
    domainId?: string
  ): Promise<string> {
    return withTenantTx(server.deps.db, orgId, async (tx) =>
      createObject(tx, {
        orgId,
        typeId,
        actorObjectId: orgId,
        requestId: "rbac-floor-setup",
        name: `${label}-${randomUUID().slice(0, 8)}`,
        // `asContainmentDomainId` and not a cast: the value came from `createObject`'s own return,
        // which is a containment-sense source. `domain-ids.ts` is explicit that a service id is a
        // valid containment parent — the brand asserts the SENSE, never the object's type.
        ...(domainId === undefined ? {} : { domainId: asContainmentDomainId(domainId) })
      })
    ).then((o) => o.id);
  }

  /** The id of the `Owner` role, read from the live catalogue. */
  async function ownerRoleId(token: string): Promise<string> {
    const res = await call("GET", token, "/api/v1/roles");
    const items = (res.json() as { items: { id: string; name: string }[] }).items;
    const owner = items.find((r) => r.name === "Owner");
    if (!owner) throw new Error("no built-in 'Owner' role in the catalogue");
    return owner.id;
  }

  /** D7's acknowledgement value, computed with the door's own walk (fixture plumbing). */
  async function ack(orgId: string, subjectId: string): Promise<string[]> {
    const reached = await withTenantTx(server.deps.db, orgId, async (tx) =>
      principalsReachedBy(tx, orgId, subjectId)
    );
    return reached
      .filter((p) => p.depth > 0)
      .map((p) => p.id)
      .sort();
  }

  async function memberOfEdgeId(orgId: string, fromId: string, toId: string): Promise<string> {
    const rows = await withTenantTx(server.deps.db, orgId, async (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, orgId),
            eq(relationships.typeId, "member_of"),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );
    const row = rows[0];
    if (!row) throw new Error(`no live member_of edge ${fromId} -> ${toId}`);
    return row.id;
  }

  /** THE FIXTURE EVERY FLOOR CASE NEEDS. See docs/routes.md §318. */
  async function orgAdministeredThroughATeam(label: string): Promise<{
    org: TestOrg;
    team: string;
    member: TestUser;
    teamBindingId: string;
  }> {
    const org = await createTestOrg(server, label);
    const roleId = await ownerRoleId(org.adminToken);
    const team = await mkObject(org.orgId, "team", "admins");
    const member = await createTestUser(server, org, []);

    const joined = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: member.objectId,
      toId: team
    });
    expect(joined.statusCode, joined.body).toBe(201);

    const bound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: team,
      roleId,
      scopeObjectId: org.orgId,
      reason: "seating the administrators team",
      acknowledgedPrincipalIds: await ack(org.orgId, team)
    });
    expect(bound.statusCode, bound.body).toBe(201);
    const teamBindingId = (bound.json() as { id: string }).id;

    const bootstrap = (await bindings(org.adminToken)).find((b) => b.id !== teamBindingId);
    if (!bootstrap) throw new Error("expected the bootstrap admin's own binding to still exist");
    const retired = await call("DELETE", org.adminToken, `/api/v1/role-bindings/${bootstrap.id}`, {
      reason: "retiring the bootstrap admin now the team is seated"
    });
    // DOOR A'S ADMISSION HALF. If this 409s, the floor is refusing a revoke it must permit and every
    // refusal below would be measuring a blanket guard.
    expect(retired.statusCode, retired.body).toBe(200);

    return { org, team, member, teamBindingId };
  }

  it("DOOR B: removing the `member_of` edge under the last administrative binding is refused", async () => {
    const { org, team, member, teamBindingId } = await orgAdministeredThroughATeam("floor-door-b");

    // THE ADMISSION PAIR FIRST, and it is a REDUNDANT MEMBERSHIP. See docs/routes.md §319.
    const spare = await createTestUser(server, org, []);
    const spareJoined = await call("POST", member.token, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: spare.objectId,
      toId: team
    });
    expect(spareJoined.statusCode, spareJoined.body).toBe(201);
    const spareEdge = (spareJoined.json() as { id: string }).id;

    const removedRedundant = await call(
      "DELETE",
      member.token,
      `/api/v1/relationships/${spareEdge}`
    );
    expect(removedRedundant.statusCode, removedRedundant.body).toBe(200);

    // THE REFUSAL — the same verb on the LAST membership. The `role_bindings` row is untouched by
    // this request and survives it, which is precisely why a revoke-time guard never fired: it
    // counted a row that resolves for nobody.
    const lastEdge = await memberOfEdgeId(org.orgId, member.objectId, team);
    const refused = await call("DELETE", member.token, `/api/v1/relationships/${lastEdge}`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("role_binding:write");
    expect(refused.body).toContain("member_of");

    // THE EDGE SURVIVED AND THE ORG IS STILL ADMINISTRABLE. A status-code-only assertion would pass
    // against a handler that tombstoned the row and threw afterwards outside a transaction — which
    // leaves the estate in exactly the state this guard exists to prevent.
    expect(await memberOfEdgeId(org.orgId, member.objectId, team)).toBe(lastEdge);
    const stillAdministers = await call("GET", member.token, "/api/v1/role-bindings");
    expect(stillAdministers.statusCode, stillAdministers.body).toBe(200);
    expect((stillAdministers.json() as { items: { id: string }[] }).items.map((b) => b.id)).toEqual(
      [teamBindingId]
    );
  });

  it("DOOR C: tombstoning the team that holds the last administrative binding is refused", async () => {
    const { org, team, member } = await orgAdministeredThroughATeam("floor-door-c");

    // THE ADMISSION PAIR: a team with a live member and NO role binding. Its delete runs the same
    // probe and the same predicate — the object has live `member_of` edges, so the check is not
    // skipped — and is admitted, because tombstoning it changes nothing about who can administer.
    const ordinary = await mkObject(org.orgId, "team", "ordinary");
    const joined = await call("POST", member.token, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: (await createTestUser(server, org, [])).objectId,
      toId: ordinary
    });
    expect(joined.statusCode, joined.body).toBe(201);
    const ordinaryDeleted = await call("DELETE", member.token, `/api/v1/objects/team/${ordinary}`);
    expect(ordinaryDeleted.statusCode, ordinaryDeleted.body).toBe(200);

    // THE REFUSAL — the identical verb on the team that HOLDS the binding. Nothing in this request
    // names a role, a binding or a permission; the door it goes through is the generic object
    // delete, which is why a rule living on the role-binding route could not see it.
    const refused = await call("DELETE", member.token, `/api/v1/objects/team/${team}`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("role_binding:write");

    // THE TEAM SURVIVED — read back through the API, not inferred from the status code.
    const stillThere = await call("GET", member.token, `/api/v1/objects/team/${team}`);
    expect(stillThere.statusCode, stillThere.body).toBe(200);
    const stillAdministers = await call("GET", member.token, "/api/v1/roles");
    expect(stillAdministers.statusCode, stillAdministers.body).toBe(200);
  });

  it("DOOR C': tombstoning the USER that holds the last administrative binding is refused", async () => {
    // THIS IS THE CASE NO CASCADE COVERS. The binding is held DIRECTLY by a user, so deleting that
    // user removes no `member_of` edge at all and `deleteRelationship`'s guard never runs. It is the
    // reason `deleteObject` makes its own call rather than relying on the cascade it performs.
    const org = await createTestOrg(server, "floor-door-c-prime");
    const roleId = await ownerRoleId(org.adminToken);
    const bootstrapSubject = (
      (await call("GET", org.adminToken, "/api/v1/auth/me")).json() as { subjectObjectId: string }
    ).subjectObjectId;

    // THE ADMISSION PAIR: a SECOND administrator, deleted while the bootstrap admin survives. Same
    // verb, same object type, same actor — differing only in whether the org keeps an administrator.
    const spare = await createTestUser(server, org, []);
    const spareBound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: spare.objectId,
      roleId,
      scopeObjectId: org.orgId,
      reason: "a second administrator"
    });
    expect(spareBound.statusCode, spareBound.body).toBe(201);
    const spareDeleted = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/objects/user/${spare.objectId}`
    );
    expect(spareDeleted.statusCode, spareDeleted.body).toBe(200);

    // THE REFUSAL — the bootstrap admin deleting its own user object, now the only administrator
    // left. MEASURED before this guard: 200, and the estate held a `role_bindings` row naming a
    // tombstone.
    const refused = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/objects/user/${bootstrapSubject}`
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("role_binding:write");

    const stillWorks = await call("GET", org.adminToken, "/api/v1/roles");
    expect(stillWorks.statusCode, stillWorks.body).toBe(200);
  });

  // §2a's MEMBER-SHAPE HALF — §2b's refusals, on the JOIN path

  it("§2b's refusals apply on the JOIN path when the joining subject is itself a group", async () => {
    // §2a as first shipped asked only about the ACTOR: does the actor hold what the joiner would
    // inherit. That is the whole question when the joiner is a user, and HALF of it when the joiner
    // is a GROUP — nesting G into an empowered team empowers everything inside G, and a direct
    // `POST /role-bindings` naming G would be refused for exactly that membership.
    const org = await createTestOrg(server, "floor-join-shape");
    const roleId = await ownerRoleId(org.adminToken);

    const empowered = await mkObject(org.orgId, "team", "empowered");
    const seatWarmer = await createTestUser(server, org, []);
    expect(
      (
        await call("POST", org.adminToken, "/api/v1/relationships", {
          typeId: "member_of",
          fromId: seatWarmer.objectId,
          toId: empowered
        })
      ).statusCode
    ).toBe(201);
    const bound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: empowered,
      roleId,
      scopeObjectId: org.orgId,
      reason: "the empowered team",
      acknowledgedPrincipalIds: await ack(org.orgId, empowered)
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // The joining GROUP, holding one live member and one that is about to be tombstoned.
    const nested = await mkObject(org.orgId, "group", "nested");
    const healthy = await createTestUser(server, org, []);
    const doomed = await createTestUser(server, org, []);
    for (const u of [healthy, doomed]) {
      expect(
        (
          await call("POST", org.adminToken, "/api/v1/relationships", {
            typeId: "member_of",
            fromId: u.objectId,
            toId: nested
          })
        ).statusCode
      ).toBe(201);
    }

    // THE GRANT DOOR ALREADY REFUSES THIS MEMBERSHIP — measured first, because it is the standard
    // the join is being held to. Tombstoned raw and not through `DELETE /objects/user/{id}`, for the
    // reason §2b's own fixture states: the local delete cascades the edge away, and a fixture built
    // through that door would leave the liveness arm untested while looking tested.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(
        sql`UPDATE objects SET deleted_at = now() WHERE org_id = ${org.orgId}::uuid AND id = ${doomed.objectId}::uuid`
      );
    });
    const grantRefused = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: nested,
      roleId,
      scopeObjectId: org.orgId,
      reason: "the standard the join is held to",
      acknowledgedPrincipalIds: await ack(org.orgId, nested)
    });
    expect(grantRefused.statusCode, grantRefused.body).toBe(422);
    expect(grantRefused.body).toContain("soft-deleted");

    // THE JOIN — the other route to the same end state, and it was a 201 before this round.
    const joinRefused = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: nested,
      toId: empowered
    });
    expect(joinRefused.statusCode, joinRefused.body).toBe(422);
    expect(joinRefused.body).toContain("soft-deleted");
    expect(joinRefused.body).toContain(doomed.objectId);
    expect(
      await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        tx
          .select({ id: relationships.id })
          .from(relationships)
          .where(
            and(
              eq(relationships.orgId, org.orgId),
              eq(relationships.typeId, "member_of"),
              eq(relationships.fromId, nested),
              eq(relationships.toId, empowered),
              isNull(relationships.deletedAt)
            )
          )
      )
    ).toHaveLength(0);

    // THE ADMISSION PAIR: clean the membership up, join again, same actor and same endpoints. This
    // is what says the tombstone decided it rather than nesting-a-group being refused outright.
    const doomedEdge = await memberOfEdgeId(org.orgId, doomed.objectId, nested);
    expect(
      (await call("DELETE", org.adminToken, `/api/v1/relationships/${doomedEdge}`)).statusCode
    ).toBe(200);
    const joinAdmitted = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: nested,
      toId: empowered
    });
    expect(joinAdmitted.statusCode, joinAdmitted.body).toBe(201);

    // AND THE NESTING REALLY CONFERRED THE AUTHORITY — the property the guard governs, asserted
    // rather than assumed. `healthy` holds no binding of its own.
    const inherited = await call("GET", healthy.token, "/api/v1/role-bindings");
    expect(inherited.statusCode, inherited.body).toBe(200);
  });

  // D7 — THE ACKNOWLEDGEMENT (owner ruling 2026-08-27)

  it("D7: a grant to a group is refused without an acknowledgement and admitted with the right one", async () => {
    const org = await createTestOrg(server, "d7-basic");
    const roleId = await ownerRoleId(org.adminToken);
    const team = await mkObject(org.orgId, "team", "d7");
    const memberA = await createTestUser(server, org, []);
    const memberB = await createTestUser(server, org, []);
    for (const u of [memberA, memberB]) {
      expect(
        (
          await call("POST", org.adminToken, "/api/v1/relationships", {
            typeId: "member_of",
            fromId: u.objectId,
            toId: team
          })
        ).statusCode
      ).toBe(201);
    }

    // NO ACKNOWLEDGEMENT — 422, because an absent field is a malformed request for this subject
    // type and no retry of the same body fixes it. The refusal NAMES the preview operation, so the
    // remedy is in the message rather than in a document.
    const noAck = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: team,
      roleId,
      scopeObjectId: org.orgId,
      reason: "granting blind"
    });
    expect(noAck.statusCode, noAck.body).toBe(422);
    expect(noAck.body).toContain("acknowledgedPrincipalIds");
    expect(noAck.body).toContain("grant-preview");

    // A USER SUBJECT IS UNAFFECTED — the same door, the same actor, the same missing field, and a
    // 201. Without this the 422 above could be any schema rejection, and the ruling's "do not burden
    // the common case" would be unmeasured.
    const userGrant = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: (await createTestUser(server, org, [])).objectId,
      roleId,
      scopeObjectId: org.orgId,
      reason: "a user subject needs no acknowledgement"
    });
    expect(userGrant.statusCode, userGrant.body).toBe(201);

    // THE PREVIEW TEACHES THE VALUE — one call, sorted, ready to paste. Without this the field is
    // unusable from a CLI: the closure is transitive, so `GET /relationships` cannot answer it.
    const preview = await call(
      "GET",
      org.adminToken,
      `/api/v1/role-bindings/grant-preview?subjectId=${team}`
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const previewed = preview.json() as {
      acknowledgementRequired: boolean;
      acknowledgedPrincipalIds: string[];
      principals: { id: string; typeId: string; depth: number; bindable: boolean }[];
    };
    expect(previewed.acknowledgementRequired).toBe(true);
    expect([...previewed.acknowledgedPrincipalIds].sort()).toEqual(
      [memberA.objectId, memberB.objectId].sort()
    );
    expect(previewed.principals.every((p) => p.depth === 1 && p.bindable)).toBe(true);

    // THE ADMISSION — the identical body plus the previewed value.
    const admitted = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: team,
      roleId,
      scopeObjectId: org.orgId,
      reason: "granting with eyes open",
      acknowledgedPrincipalIds: previewed.acknowledgedPrincipalIds
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  it("D7: a STALE acknowledgement is a 409 naming the principal that joined in between", async () => {
    // THE CASE THE FIELD EXISTS FOR: a member joining between the caller's read and its write must
    // be CAUGHT rather than silently included. Sequential here because the door holds §0's org lock
    // across its read and its write, so the only way to observe the window is to widen it — which
    // is what a real client's round trip does anyway.
    const org = await createTestOrg(server, "d7-stale");
    const roleId = await ownerRoleId(org.adminToken);
    const team = await mkObject(org.orgId, "team", "d7-stale");
    const known = await createTestUser(server, org, []);
    expect(
      (
        await call("POST", org.adminToken, "/api/v1/relationships", {
          typeId: "member_of",
          fromId: known.objectId,
          toId: team
        })
      ).statusCode
    ).toBe(201);

    const stale = (
      (
        await call("GET", org.adminToken, `/api/v1/role-bindings/grant-preview?subjectId=${team}`)
      ).json() as { acknowledgedPrincipalIds: string[] }
    ).acknowledgedPrincipalIds;
    expect(stale).toEqual([known.objectId]);

    const latecomer = await createTestUser(server, org, []);
    expect(
      (
        await call("POST", org.adminToken, "/api/v1/relationships", {
          typeId: "member_of",
          fromId: latecomer.objectId,
          toId: team
        })
      ).statusCode
    ).toBe(201);

    const refused = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: team,
      roleId,
      scopeObjectId: org.orgId,
      reason: "acknowledging a membership that has moved on",
      acknowledgedPrincipalIds: stale
    });
    // 409 and not 422: the body is well-formed and the caller's standing is not in question — the
    // request conflicts with the STATE of the org, and re-reading fixes it.
    expect(refused.statusCode, refused.body).toBe(409);
    // NAMED, not merely refused: the id that was missing from the acknowledgement.
    expect(refused.body).toContain(latecomer.objectId);
    expect(refused.body).toContain("not in the acknowledgement");

    // NOTHING WAS GRANTED — asserting on the status alone would pass against a handler that wrote
    // the row and threw afterwards.
    expect((await bindings(org.adminToken)).some((b) => b.subjectId === team)).toBe(false);

    // THE OTHER DIRECTION — an acknowledged id the team does not reach. Same 409, named separately,
    // because a client that sends a value it never read is a different mistake from a stale one.
    const bogus = await createTestUser(server, org, []);
    const wrongWay = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: team,
      roleId,
      scopeObjectId: org.orgId,
      reason: "acknowledging somebody who is not in the team",
      acknowledgedPrincipalIds: [known.objectId, latecomer.objectId, bogus.objectId]
    });
    expect(wrongWay.statusCode, wrongWay.body).toBe(409);
    expect(wrongWay.body).toContain("not reached by this team");
    expect(wrongWay.body).toContain(bogus.objectId);

    const fresh = (
      (
        await call("GET", org.adminToken, `/api/v1/role-bindings/grant-preview?subjectId=${team}`)
      ).json() as { acknowledgedPrincipalIds: string[] }
    ).acknowledgedPrincipalIds;
    const admitted = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: team,
      roleId,
      scopeObjectId: org.orgId,
      reason: "re-read and retried",
      acknowledgedPrincipalIds: fresh
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  it("D7: an EMPTY group is acknowledged with `[]`, and an OMITTED field is still refused", async () => {
    // THE INTERESTING BOUNDARY. See docs/routes.md §320.
    const org = await createTestOrg(server, "d7-empty");
    const roleId = await ownerRoleId(org.adminToken);
    const emptyTeam = await mkObject(org.orgId, "team", "d7-empty");

    const omitted = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: emptyTeam,
      roleId,
      scopeObjectId: org.orgId,
      reason: "no acknowledgement at all"
    });
    expect(omitted.statusCode, omitted.body).toBe(422);
    expect(omitted.body).toContain("EMPTY group is acknowledged with an empty array");

    const previewed = (
      await call(
        "GET",
        org.adminToken,
        `/api/v1/role-bindings/grant-preview?subjectId=${emptyTeam}`
      )
    ).json() as { acknowledgementRequired: boolean; acknowledgedPrincipalIds: string[] };
    expect(previewed.acknowledgementRequired).toBe(true);
    expect(previewed.acknowledgedPrincipalIds).toEqual([]);

    const admitted = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: emptyTeam,
      roleId,
      scopeObjectId: org.orgId,
      reason: "seating the team later",
      acknowledgedPrincipalIds: []
    });
    expect(admitted.statusCode, admitted.body).toBe(201);

    // AND THE ACKNOWLEDGEMENT IS DURABLE. The Decision this door writes carries what the granter
    // said, so the estate can afterwards say not just what authority was handed over but to whom the
    // granter believed they were handing it.
    const decision = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx.execute<{ input_context: { acknowledgedPrincipalIds: string[] | null } }>(sql`
        SELECT input_context FROM decisions
        WHERE org_id = ${org.orgId}::uuid AND kind = 'role_binding'
        ORDER BY created_at DESC LIMIT 1
      `)
    );
    expect(decision.rows[0]!.input_context.acknowledgedPrincipalIds).toEqual([]);
  });

  it("D7: the preview is gated on `audit:read`, like the binding listing it discloses membership for", async () => {
    // A GROUP'S MEMBERSHIP IS ACCOUNTABILITY DATA. If this operation were open to any authenticated
    // principal it would be a membership dump for the whole org — the same disclosure §2b's ordering
    // fix exists to prevent, re-opened through a read.
    const org = await createTestOrg(server, "d7-preview-authz");
    const team = await mkObject(org.orgId, "team", "d7-authz");
    const nobody = await createTestUser(server, org, []);

    const refused = await call(
      "GET",
      nobody.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${team}`
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("audit:read");

    const admitted = await call(
      "GET",
      org.adminToken,
      `/api/v1/role-bindings/grant-preview?subjectId=${team}`
    );
    expect(admitted.statusCode, admitted.body).toBe(200);
  });

  // THE FLOOR'S ANCHOR — a principal that can AUTHENTICATE, not a graph object of a principal type

  /** The bootstrap admin's own org-root binding — the one the brick chain revokes. */
  async function ownBindingIdOf(orgToken: string, subjectObjectId: string): Promise<string> {
    const own = (await bindings(orgToken)).find((b) => b.subjectId === subjectObjectId);
    if (!own) throw new Error("expected the caller to hold a role binding");
    return own.id;
  }

  async function meSubject(token: string): Promise<string> {
    const res = await call("GET", token, "/api/v1/auth/me");
    if (res.statusCode !== 200) throw new Error(`/auth/me failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { subjectObjectId: string }).subjectObjectId;
  }

  /**
   * A GRAPH OBJECT AND NOTHING ELSE — the phantom. Created through the ordinary public route,
   * because that is the whole point: no privilege beyond `object:write`, no concurrency, no SQL.
   */
  async function phantomPrincipal(
    orgToken: string,
    typeId: "user" | "service-account"
  ): Promise<string> {
    const res = await call("POST", orgToken, `/api/v1/objects/${typeId}`, {
      name: `phantom-${typeId}-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  /** WIRES A CREDENTIAL ONTO AN EXISTING GRAPH OBJECT. See docs/routes.md §321. */
  async function giveCredential(org: TestOrg, objectId: string): Promise<string> {
    const username = `cred-${randomUUID()}`;
    const password = randomUUID();
    await server.deps.db.insert(users).values({
      id: uuidv7(),
      orgId: org.orgId,
      username,
      passwordHash: await argon2.hash(password),
      objectId
    });
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password }
    });
    expect(login.statusCode, login.body).toBe(200);
    const token = (login.json() as { token: string }).token;
    // THE CREDENTIAL REALLY RESOLVES TO THIS GRAPH OBJECT — `resolveAuthContext` reads no
    // `type_id`, which is exactly why the floor's anchor can be type-blind.
    expect(await meSubject(token)).toBe(objectId);
    return token;
  }

  it("the floor REFUSES the phantom brick: a `user` graph object with no login is not an administrator", async () => {
    // MEASURED BEFORE THIS REVISION. See docs/routes.md §322.
    const org = await createTestOrg(server, "floor-phantom");
    const roleId = await ownerRoleId(org.adminToken);
    const bootstrapSubject = await meSubject(org.adminToken);
    const bootstrapBinding = await ownBindingIdOf(org.adminToken, bootstrapSubject);

    const phantom = await phantomPrincipal(org.adminToken, "user");
    // STEP 2 MUST STAY A 201. The grant path takes no floor check (a grant can only ADD
    // reachability) and D7 exempts a `user` subject from the acknowledgement by design — so if this
    // ever 403s or 422s, the fix has been made in the wrong place and the case below is measuring a
    // grant refusal rather than the floor.
    const bound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: phantom,
      roleId,
      scopeObjectId: org.orgId,
      reason: "binding Owner to a graph object that has no account"
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // THE REFUSAL. Two org-root Owner bindings exist and one of them resolves for nobody who can
    // log in, so removing the other empties the org.
    const refused = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${bootstrapBinding}`,
      { reason: "retiring the only real administrator" }
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("role_binding:write");
    // NAMES THE SHAPE, so the operator is told what a phantom is rather than that a count was short.
    expect(refused.body).toContain("no row in 'users'");

    // THE BINDING SURVIVED AND THE ORG IS STILL ADMINISTRABLE — read back, not inferred from the
    // status code: a handler that deleted the row and threw outside a transaction would leave the
    // estate in exactly the state this guard exists to prevent.
    expect((await bindings(org.adminToken)).map((b) => b.id)).toContain(bootstrapBinding);
    expect((await call("GET", org.adminToken, "/api/v1/roles")).statusCode).toBe(200);

    // THE ADMISSION PAIR. See docs/routes.md §323.
    const real = await createTestUser(server, org, []);
    const realBound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: real.objectId,
      roleId,
      scopeObjectId: org.orgId,
      reason: "a second administrator that can log in"
    });
    expect(realBound.statusCode, realBound.body).toBe(201);

    const admitted = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${bootstrapBinding}`,
      { reason: "retiring the bootstrap admin now a real second administrator exists" }
    );
    expect(admitted.statusCode, admitted.body).toBe(200);

    // AND THE SURVIVOR REALLY ADMINISTERS — the property the floor is FOR, measured through the
    // survivor's own token rather than assumed from the 200.
    expect((await call("GET", real.token, "/api/v1/roles")).statusCode).toBe(200);
    expect((await call("GET", real.token, "/api/v1/role-bindings")).statusCode).toBe(200);
  });

  it("a REAL service-account administrator counts — the anchor is the credential, not the type", async () => {
    // THE MIRROR-IMAGE FAILURE this case exists to prevent: an anchor that is too strict stops
    // counting a legitimate service-account administrator, and an org that IS administrable starts
    // reporting 409 on every revoke. Both directions are measured here, in ONE org, so the only
    // difference between them is the credential.
    const org = await createTestOrg(server, "floor-service-account");
    const roleId = await ownerRoleId(org.adminToken);
    const bootstrapSubject = await meSubject(org.adminToken);
    const bootstrapBinding = await ownBindingIdOf(org.adminToken, bootstrapSubject);

    // A service account, created the ordinary way, then given the one thing that makes any graph
    // object able to present a token.
    const serviceAccount = await phantomPrincipal(org.adminToken, "service-account");
    const saToken = await giveCredential(org, serviceAccount);

    const saBound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: serviceAccount,
      roleId,
      scopeObjectId: org.orgId,
      reason: "the automation account administers this org"
    });
    expect(saBound.statusCode, saBound.body).toBe(201);
    const saBinding = (saBound.json() as { id: string }).id;

    // ADMITTED — the org keeps an administrator that can authenticate, and it is not a `user`.
    const admitted = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${bootstrapBinding}`,
      { reason: "handing administration to the service account" }
    );
    expect(admitted.statusCode, admitted.body).toBe(200);

    // AND IT REALLY ADMINISTERS. A 200 above says the floor counted it; these say the count was
    // TRUE — the service account reads the catalogue, reads the bindings, and WRITES one, which is
    // the `role_binding:write` the floor is actually about.
    expect((await call("GET", saToken, "/api/v1/roles")).statusCode).toBe(200);
    expect((await call("GET", saToken, "/api/v1/role-bindings")).statusCode).toBe(200);
    const viewerRoleId = (
      (await call("GET", saToken, "/api/v1/roles")).json() as {
        items: { id: string; name: string }[];
      }
    ).items.find((r) => r.name === "Viewer")!.id;
    const writtenBySa = await call("POST", saToken, "/api/v1/role-bindings", {
      subjectId: (await createTestUser(server, org, [])).objectId,
      roleId: viewerRoleId,
      scopeObjectId: org.orgId,
      reason: "the service account exercising role_binding:write"
    });
    expect(writtenBySa.statusCode, writtenBySa.body).toBe(201);

    // THE OTHER DIRECTION, IN THE SAME ORG. See docs/routes.md §324.
    const phantomSa = await phantomPrincipal(saToken, "service-account");
    const phantomBound = await call("POST", saToken, "/api/v1/role-bindings", {
      subjectId: phantomSa,
      roleId,
      scopeObjectId: org.orgId,
      reason: "a service-account object with no account"
    });
    expect(phantomBound.statusCode, phantomBound.body).toBe(201);

    const refused = await call("DELETE", saToken, `/api/v1/role-bindings/${saBinding}`, {
      reason: "retiring the only real administrator in favour of a phantom"
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("no row in 'users'");
    expect((await call("GET", saToken, "/api/v1/roles")).statusCode).toBe(200);
  });

  // THE PREVIEW MUST NOT TELL A CALLER ANYTHING THEY COULD NOT ALREADY READ

  it("grant-preview is anchored to the SUBJECT, not to a scope the caller chooses", async () => {
    // The defect: the preview admitted a scoped holder. See docs/routes.md §325.
    const org = await createTestOrg(server, "preview-subject-anchor");
    const secret = await mkObject(org.orgId, "team", "secret");
    const other = await mkObject(org.orgId, "team", "other");
    const insider = await createTestUser(server, org, []);
    expect(
      (
        await call("POST", org.adminToken, "/api/v1/relationships", {
          typeId: "member_of",
          fromId: insider.objectId,
          toId: secret
        })
      ).statusCode
    ).toBe(201);

    // A principal whose `audit:read` is real but scoped SOMEWHERE ELSE — a service they administer.
    const elsewhere = await mkObject(org.orgId, "service", "elsewhere");
    const scoped = await createTestUser(server, org, [{ role: "Viewer", scope: elsewhere }]);

    // THE REFUSAL. This is the exact request that used to return the membership.
    const refused = await call(
      "GET",
      scoped.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${secret}`
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("audit:read");
    expect(refused.body).toContain(secret);

    // THE OLD EXPLOIT, VERBATIM. See docs/routes.md §326.
    const oldExploit = await call(
      "GET",
      scoped.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${secret}&scopeObjectId=${elsewhere}`
    );
    expect(oldExploit.statusCode, oldExploit.body).toBe(403);

    // NOTHING NEW — the parity claim, measured. The binding listing for that same team is closed to
    // this caller too, so the preview is refusing exactly what its sibling refuses rather than
    // being arbitrarily stricter.
    const listing = await call(
      "GET",
      scoped.token,
      `/api/v1/role-bindings?scopeObjectId=${secret}`
    );
    expect(listing.statusCode, listing.body).toBe(403);

    // The admission pair, which says the fix is an anchor. See docs/routes.md §327.
    const anchored = await createTestUser(server, org, [{ role: "Viewer", scope: secret }]);
    const admitted = await call(
      "GET",
      anchored.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${secret}`
    );
    expect(admitted.statusCode, admitted.body).toBe(200);
    expect((admitted.json() as { subjectId: string }).subjectId).toBe(secret);

    // This case asserted the wrong thing here, and why. See docs/routes.md §328.
    expect((admitted.json() as { principals: unknown[] }).principals).toEqual([]);

    const stillRefused = await call(
      "GET",
      anchored.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${other}`
    );
    expect(stillRefused.statusCode, stillRefused.body).toBe(403);

    // AND THE ORG-ROOT ARM SURVIVES — a whole-org `audit:read` holder still previews any subject.
    expect(
      (await call("GET", org.adminToken, `/api/v1/role-bindings/grant-preview?subjectId=${other}`))
        .statusCode
    ).toBe(200);
  });

  it("the preview discloses only principals the caller could read individually, and counts the rest", async () => {
    // THE DEFECT, MEASURED BEFORE THIS ROUND. See docs/routes.md §329.
    const org = await createTestOrg(server, "preview-projection");
    const team = await mkObject(org.orgId, "team", "projection");
    const insider = await createTestUser(server, org, []);
    expect(
      (
        await call("POST", org.adminToken, "/api/v1/relationships", {
          typeId: "member_of",
          fromId: insider.objectId,
          toId: team
        })
      ).statusCode
    ).toBe(201);

    // THE CALLER THE SUBJECT ANCHOR DELIBERATELY ADMITS: `audit:read` at-or-above the team, and
    // nothing at all above it.
    const teamScoped = await createTestUser(server, org, [{ role: "Viewer", scope: team }]);

    // WHAT THIS CALLER CANNOT ALREADY READ. See docs/routes.md §330.
    expect(
      (await call("GET", teamScoped.token, `/api/v1/objects/user/${insider.objectId}`)).statusCode,
      "GET /objects/user/{id} must refuse this caller, or the disclosure is not a disclosure"
    ).toBe(403);
    expect(
      (await call("GET", teamScoped.token, `/api/v1/users/${insider.objectId}`)).statusCode
    ).toBe(403);
    expect(
      (await call("GET", teamScoped.token, "/api/v1/role-bindings")).statusCode,
      "the binding listing is org-root `audit:read` only without a scope filter"
    ).toBe(403);
    // The LIST door admits this caller and returns their own readable subtree — which does not
    // contain the member, because `member_of` is not containment.
    const listed = await call("GET", teamScoped.token, "/api/v1/objects/user");
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain(insider.objectId);

    // THE REFUSAL — a 200 that carries no identity at all, and a COUNT that says somebody is there.
    const filtered = await call(
      "GET",
      teamScoped.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${team}`
    );
    expect(filtered.statusCode, filtered.body).toBe(200);
    // ON THE RAW BODY, not on the parsed fields: a leak through any field of the response — a name
    // echoed into a message, an id left in a second array — is the thing being refused, and reading
    // only the fields this case knows about would miss one added later.
    expect(filtered.body, "the preview leaked a member id").not.toContain(insider.objectId);
    expect(filtered.body, "the preview leaked a member name").not.toContain(insider.username);
    const hidden = filtered.json() as {
      acknowledgementRequired: boolean;
      acknowledgementComplete: boolean;
      withheldPrincipalCount: number;
      acknowledgedPrincipalIds: string[];
      principals: unknown[];
    };
    expect(hidden.principals).toEqual([]);
    expect(hidden.acknowledgedPrincipalIds).toEqual([]);
    expect(hidden.withheldPrincipalCount).toBe(1);
    // AND THE CALLER IS TOLD, rather than left to paste a value the grant door will 409 on. This is
    // what tells an EMPTY team apart from one this caller may not see into — the two are otherwise
    // the same response, and D7 exists precisely to stop a granter confusing them.
    expect(hidden.acknowledgementComplete).toBe(false);
    expect(hidden.acknowledgementRequired).toBe(true);

    // THE ADMISSION PAIR. See docs/routes.md §331.
    const orgReader = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    expect(
      (await call("GET", orgReader.token, `/api/v1/objects/user/${insider.objectId}`)).statusCode,
      "the admission pair is only meaningful if this caller CAN read the member individually"
    ).toBe(200);
    const full = await call(
      "GET",
      orgReader.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${team}`
    );
    expect(full.statusCode, full.body).toBe(200);
    const shown = full.json() as {
      acknowledgementComplete: boolean;
      withheldPrincipalCount: number;
      acknowledgedPrincipalIds: string[];
      principals: { id: string }[];
    };
    expect(shown.acknowledgedPrincipalIds).toEqual([insider.objectId]);
    expect(shown.principals.map((p) => p.id)).toEqual([insider.objectId]);
    expect(shown.withheldPrincipalCount).toBe(0);
    expect(shown.acknowledgementComplete).toBe(true);

    // WHY THAT ADMISSION GENERALISES, verified rather than assumed. See docs/routes.md §332.
    const catalogue = (
      (await call("GET", org.adminToken, "/api/v1/roles")).json() as {
        items: { name: string; permissions: string[] }[];
      }
    ).items;
    expect(
      catalogue
        .filter(
          (r) => r.permissions.includes("audit:read") && !r.permissions.includes("object:read")
        )
        .map((r) => r.name),
      "a role that can open this preview but cannot read the estate would get a permanently " +
        "incomplete acknowledgement — see GrantPreviewResponseSchema's D7 paragraph"
    ).toEqual([]);
  });

  it("D7 survives a FILTERED preview: the grant door's own 409 names what the preview withheld", async () => {
    // The residual population, measured rather than ruled out. See docs/routes.md §333.
    const org = await createTestOrg(server, "d7-filtered-preview");
    const service = await mkObject(org.orgId, "service", "scoped-svc");
    // The team sits UNDER the service, so a service-scoped principal reads it. The member does not:
    // `createObject` parents a user at the ORG ROOT, which is where every principal on this estate
    // lives, and `member_of` is not containment.
    const team = await mkObject(org.orgId, "team", "scoped-team", service);
    const member = await createTestUser(server, org, []);
    expect(
      (
        await call("POST", org.adminToken, "/api/v1/relationships", {
          typeId: "member_of",
          fromId: member.objectId,
          toId: team
        })
      ).statusCode
    ).toBe(201);

    // THE GRANTER: `OrgAdmin` bound at the SERVICE. Written through the harness rather than through
    // the door on purpose — `bindable_at` for OrgAdmin is `organization`, so this is exactly the
    // hand-written-SQL population `docs/authz/role-binding-door.md` §4 says the door must keep working
    // for, and it is the only shape that holds `role_binding:write` below the org root.
    const granter = await createTestUser(server, org, [{ role: "OrgAdmin", scope: service }]);
    // The role id is read with the admin's token, deliberately. See docs/routes.md §334.
    const serviceAdminRoleId = (
      (await call("GET", org.adminToken, "/api/v1/roles")).json() as {
        items: { id: string; name: string }[];
      }
    ).items.find((r) => r.name === "ServiceAdmin")!.id;

    // THE FILTERED PREVIEW. Admitted (the team is inside their scope) and empty (the member is not).
    const preview = await call(
      "GET",
      granter.token,
      `/api/v1/role-bindings/grant-preview?subjectId=${team}`
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.body).not.toContain(member.objectId);
    const previewed = preview.json() as {
      acknowledgementComplete: boolean;
      withheldPrincipalCount: number;
      acknowledgedPrincipalIds: string[];
    };
    expect(previewed.withheldPrincipalCount).toBe(1);
    expect(previewed.acknowledgementComplete).toBe(false);
    expect(previewed.acknowledgedPrincipalIds).toEqual([]);

    // PASTING IT IS REFUSED — and the refusal is the thing that makes the field usable rather than
    // theatre: it NAMES the principal the preview withheld.
    const refused = await call("POST", granter.token, "/api/v1/role-bindings", {
      subjectId: team,
      roleId: serviceAdminRoleId,
      scopeObjectId: service,
      reason: "granting from an incomplete preview",
      acknowledgedPrincipalIds: previewed.acknowledgedPrincipalIds
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain(member.objectId);
    expect(refused.body).toContain("not in the acknowledgement");

    // ONE ROUND TRIP, NOT FOREVER. The 409 taught the value; the same body with it is admitted.
    const admitted = await call("POST", granter.token, "/api/v1/role-bindings", {
      subjectId: team,
      roleId: serviceAdminRoleId,
      scopeObjectId: service,
      reason: "granting with the full membership acknowledged",
      acknowledgedPrincipalIds: [member.objectId]
    });
    expect(admitted.statusCode, admitted.body).toBe(201);

    // AND THE GRANT REALLY LANDED ON THE MEMBERSHIP — read back through the resolver rather than
    // inferred from the 201, because "D7 still works" means the binding works, not that a status
    // code was returned.
    const boundId = (admitted.json() as { id: string }).id;
    expect((await bindings(org.adminToken)).map((b) => b.id)).toContain(boundId);
    expect(
      (await call("GET", member.token, `/api/v1/objects/service/${service}`)).statusCode,
      "the member should now read the service through the team's ServiceAdmin binding"
    ).toBe(200);
  });

  // THE TENANT BOUNDARY ON THE FLOOR'S FIFTH INPUT — `users` CARRIES NO RLS

  it("a `users` row in ANOTHER org naming this org's phantom is not this org's administrator", async () => {
    // The walk joins the user table to decide credentialed. See docs/routes.md §335.
    const org = await createTestOrg(server, "floor-cross-tenant");
    const neighbour = await createTestOrg(server, "floor-cross-tenant-neighbour");
    const roleId = await ownerRoleId(org.adminToken);
    const bootstrapSubject = await meSubject(org.adminToken);
    const bootstrapBinding = await ownBindingIdOf(org.adminToken, bootstrapSubject);

    // A PHANTOM IN THIS ORG — a graph object with no account, made the ordinary way.
    const phantom = await phantomPrincipal(org.adminToken, "user");
    const bound = await call("POST", org.adminToken, "/api/v1/role-bindings", {
      subjectId: phantom,
      roleId,
      scopeObjectId: org.orgId,
      reason: "binding Owner to a graph object that has no account in this org"
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // …AND A CREDENTIAL FOR IT IN THE NEIGHBOUR'S TENANT. This row can never authenticate INTO this
    // org — `resolveAuthContext` reads the session's own org — so counting it would be counting a
    // credential that belongs to somebody else.
    await server.deps.db.insert(users).values({
      id: uuidv7(),
      orgId: neighbour.orgId,
      username: `cross-tenant-${randomUUID()}`,
      passwordHash: await argon2.hash(randomUUID()),
      objectId: phantom
    });
    // THE FIXTURE REALLY LANDED — asserted rather than assumed, because a silently-rejected INSERT
    // (an FK that got added, a unique constraint) would make the refusal below pass VACUOUSLY: it
    // would be the plain phantom case wearing this case's name.
    const planted = await server.deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, neighbour.orgId), eq(users.objectId, phantom)));
    expect(planted, "the cross-tenant `users` row was not written").toHaveLength(1);

    // THE REFUSAL. Without `u.org_id = <this org>` on the join, the neighbour's row makes the
    // phantom `credentialed` here, the floor counts it, and this revoke is a 200 that bricks the
    // org — the same three-request brick the credential anchor was written to close, re-opened
    // across a tenant boundary.
    const refused = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${bootstrapBinding}`,
      {
        reason: "retiring the only administrator that can sign in to THIS org"
      }
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("no row in 'users'");
    expect((await bindings(org.adminToken)).map((b) => b.id)).toContain(bootstrapBinding);
    expect((await call("GET", org.adminToken, "/api/v1/roles")).statusCode).toBe(200);

    // THE ADMISSION PAIR. See docs/routes.md §336.
    await giveCredential(org, phantom);
    const admitted = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${bootstrapBinding}`,
      { reason: "the phantom now has a credential in THIS org" }
    );
    expect(admitted.statusCode, admitted.body).toBe(200);
  });

  it("every delete route that can hit the floor declares 409 in the emitted contract", async () => {
    // DOOR B and DOOR C above prove these two routes RETURN 409. See docs/routes.md §337.
    const doc = buildOpenApiDocument(server.app.routeRegistry) as {
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };

    // The two routes the floor's own cases exercise, plus the typed-registry deletes that reach the
    // identical `deleteObject` choke point for the four types that can hold a role binding.
    const mustDeclare409 = [
      "/relationships/{id}",
      "/objects/{type}/{idOrUrn}",
      "/users/{idOrUrn}",
      "/service-accounts/{idOrUrn}",
      "/teams/{idOrUrn}",
      "/groups/{idOrUrn}"
    ];
    for (const path of mustDeclare409) {
      const operation = doc.paths[path]?.delete;
      expect(operation, `no DELETE ${path} in the emitted document`).toBeDefined();
      expect(
        Object.keys(operation!.responses ?? {}),
        `DELETE ${path} (${operation!.operationId}) can return the administrator floor's 409 and ` +
          `must declare it`
      ).toContain("409");
    }

    // ADDITIVE, NOT A REPLACEMENT: the pre-existing codes are all still declared, which is what
    // makes this an oasdiff-clean change rather than a breaking one.
    expect(Object.keys(doc.paths["/relationships/{id}"]!.delete!.responses ?? {}).sort()).toEqual([
      "200",
      "401",
      "403",
      "404",
      "409"
    ]);
    expect(
      Object.keys(doc.paths["/objects/{type}/{idOrUrn}"]!.delete!.responses ?? {}).sort()
    ).toEqual(["200", "401", "403", "404", "409"]);
  });
});
