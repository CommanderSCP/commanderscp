import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * PR #4 security review, CRITICAL 1: relationship writes require `relationship:write` at BOTH
 * endpoints' scopes (docs/DESIGN.md §7). The attack this forecloses: `member_of` edges feed
 * RBAC subject expansion (authz/resolve.ts), so a from-side-only check would let any subject
 * with `relationship:write` at their own user object add themselves `member_of` any team/group
 * and inherit its role bindings — privilege escalation through the graph itself.
 */
describe("relationship writes: both-endpoint authorization", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let teamId: string;
  let svcAId: string;
  let svcBId: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "rel-authz");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const team = await admin.object("team").create({ name: "privileged-team" });
    const svcA = await admin.object("service").create({ name: "rel-authz-svc-a" });
    const svcB = await admin.object("service").create({ name: "rel-authz-svc-b" });
    teamId = team.id;
    svcAId = svcA.id;
    svcBId = svcB.id;
  });

  afterAll(async () => {
    await server.close();
  });

  it("member_of escalation is blocked: rights on 'from' (own user object) but not on the team → 403", async () => {
    // Operator grants relationship:write; scoped to the attacker's OWN user object only —
    // the exact preconditions of the reported escalation.
    const attacker = await createTestUser(server, org, [{ role: "Operator", scope: "self" }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: attacker.token });

    await expect(
      client.relationships.create({
        typeId: "member_of",
        fromId: attacker.objectId,
        toId: teamId
      })
    ).rejects.toMatchObject({ status: 403 });

    // And the membership really was not created (no partial write).
    const memberships = await admin.relationships.list({
      fromId: attacker.objectId,
      typeId: "member_of"
    });
    expect(memberships.items).toHaveLength(0);
  });

  it("plain relationship type is equally blocked: rights on 'from' but not 'to' → 403", async () => {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: svcAId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    await expect(
      client.relationships.create({ typeId: "depends_on", fromId: svcAId, toId: svcBId })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rights on 'to' but not 'from' is also a 403 (symmetric)", async () => {
    const user = await createTestUser(server, org, [{ role: "Operator", scope: svcBId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    await expect(
      client.relationships.create({ typeId: "depends_on", fromId: svcAId, toId: svcBId })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rights at BOTH endpoints succeed (plain type)", async () => {
    const user = await createTestUser(server, org, [
      { role: "Operator", scope: svcAId },
      { role: "Operator", scope: svcBId }
    ]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    const created = await client.relationships.create({
      typeId: "depends_on",
      fromId: svcAId,
      toId: svcBId
    });
    expect(created.typeId).toBe("depends_on");

    // Cleanup so other tests' cardinality/uniqueness constraints stay unaffected.
    await admin.relationships.delete(created.id);
  });

  it("rights at BOTH endpoints succeed (member_of — legitimate membership management)", async () => {
    const user = await createTestUser(server, org, [
      { role: "Operator", scope: "self" },
      { role: "Operator", scope: teamId }
    ]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });

    const created = await client.relationships.create({
      typeId: "member_of",
      fromId: user.objectId,
      toId: teamId
    });
    expect(created.typeId).toBe("member_of");
    await admin.relationships.delete(created.id);
  });

  it("DELETE also requires rights at both endpoints", async () => {
    const rel = await admin.relationships.create({
      typeId: "communicates_with",
      fromId: svcAId,
      toId: svcBId
    });

    const fromOnly = await createTestUser(server, org, [{ role: "Operator", scope: svcAId }]);
    const fromOnlyClient = new ScpClient({ baseUrl: server.baseUrl, token: fromOnly.token });
    await expect(fromOnlyClient.relationships.delete(rel.id)).rejects.toMatchObject({
      status: 403
    });

    const both = await createTestUser(server, org, [
      { role: "Operator", scope: svcAId },
      { role: "Operator", scope: svcBId }
    ]);
    const bothClient = new ScpClient({ baseUrl: server.baseUrl, token: both.token });
    const deleted = await bothClient.relationships.delete(rel.id);
    expect(deleted.id).toBe(rel.id);
  });
});
