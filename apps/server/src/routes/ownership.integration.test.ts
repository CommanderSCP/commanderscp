import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M2 ownership/consumes/depends_on ergonomics (BUILD_AND_TEST.md §8 M2 item 1), exercised through
 * the real SDK over real HTTP (mirrors relationship-authz.integration.test.ts /
 * custom-type.integration.test.ts's style) — these sub-resources are thin wrappers around the
 * exact same `graph/relationships-repo.ts` functions the generic `/relationships` endpoint uses,
 * so correctness here is really about the wrapper's id/urn resolution and BOTH-endpoint RBAC.
 */
describe("ownership ergonomics: owns/consumes/depends_on sub-resources", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "ownership");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  it("add/list/remove owner round-trips (domain <- team)", async () => {
    const domain = await admin.domains.create({ name: "ownership-domain-1" });
    const team = await admin.teams.create({ name: "ownership-team-1" });

    const created = await admin.domains.addOwner(domain.id, team.id);
    expect(created.typeId).toBe("owns");
    expect(created.fromId).toBe(team.id);
    expect(created.toId).toBe(domain.id);

    const owners = await admin.domains.listOwners(domain.id);
    expect(owners.items.map((r) => r.id)).toContain(created.id);

    const removed = await admin.domains.removeOwner(domain.id, team.id);
    expect(removed.id).toBe(created.id);
    expect(removed.deletedAt).not.toBeNull();

    const ownersAfter = await admin.domains.listOwners(domain.id);
    expect(ownersAfter.items.map((r) => r.id)).not.toContain(created.id);
  });

  it("removeOwner is a 404 when no such live edge exists", async () => {
    const domain = await admin.domains.create({ name: "ownership-domain-404" });
    const team = await admin.teams.create({ name: "ownership-team-404" });
    await expect(admin.domains.removeOwner(domain.id, team.id)).rejects.toMatchObject({
      status: 404
    });
  });

  it("owns cardinality: a second distinct owner on an already-owned target is a 409", async () => {
    // `owns` is one_to_many (drizzle/0002_rls_rbac_seed.sql §6): one 'from' can own many
    // objects, but each 'to' object may have at most one incoming `owns` edge — so a SECOND,
    // DIFFERENT owner added to the same already-owned target is a cardinality conflict, not a
    // no-op. (createRelationship's assertCardinality — not re-validated in ownership.ts.)
    const service = await admin.services.create({ name: "ownership-cardinality-svc" });
    const ownerA = await admin.teams.create({ name: "cardinality-owner-a" });
    const ownerB = await admin.teams.create({ name: "cardinality-owner-b" });

    await admin.services.addOwner(service.id, ownerA.id);
    await expect(admin.services.addOwner(service.id, ownerB.id)).rejects.toMatchObject({
      status: 409
    });
  });

  it("wrong-typed owner is a 400 (service is not a valid owns 'from' type)", async () => {
    const domain = await admin.domains.create({ name: "ownership-wrong-owner-domain" });
    // owns.from_types = [team, group, user, service-account] — 'service' is not among them.
    const wrongTypeOwner = await admin.services.create({ name: "not-a-valid-owner" });

    await expect(admin.domains.addOwner(domain.id, wrongTypeOwner.id)).rejects.toMatchObject({
      status: 400
    });
  });

  it("consumes/depends_on round-trip on services", async () => {
    const svcA = await admin.services.create({ name: "edge-svc-a" });
    const svcB = await admin.services.create({ name: "edge-svc-b" });

    const consumes = await admin.services.addConsumes(svcA.id, svcB.id);
    expect(consumes.typeId).toBe("consumes");
    expect(consumes.fromId).toBe(svcA.id);
    expect(consumes.toId).toBe(svcB.id);
    const consumesList = await admin.services.listConsumes(svcA.id);
    expect(consumesList.items.map((r) => r.id)).toContain(consumes.id);
    const consumesRemoved = await admin.services.removeConsumes(svcA.id, svcB.id);
    expect(consumesRemoved.id).toBe(consumes.id);

    const dependsOn = await admin.services.addDependsOn(svcA.id, svcB.id);
    expect(dependsOn.typeId).toBe("depends_on");
    const dependsOnList = await admin.services.listDependsOn(svcA.id);
    expect(dependsOnList.items.map((r) => r.id)).toContain(dependsOn.id);
    const dependsOnRemoved = await admin.services.removeDependsOn(svcA.id, svcB.id);
    expect(dependsOnRemoved.id).toBe(dependsOn.id);
  });

  it("consumes/depends_on round-trip on components too", async () => {
    const compA = await createTestComponent(admin, { name: "edge-comp-a" });
    const compB = await createTestComponent(admin, { name: "edge-comp-b" });

    const consumes = await admin.components.addConsumes(compA.id, compB.id);
    expect(consumes.fromId).toBe(compA.id);
    expect(consumes.toId).toBe(compB.id);
    await admin.components.removeConsumes(compA.id, compB.id);

    const dependsOn = await admin.components.addDependsOn(compA.id, compB.id);
    expect(dependsOn.typeId).toBe("depends_on");
    await admin.components.removeDependsOn(compA.id, compB.id);
  });

  it("consumes and depends_on many_to_many: a second distinct edge from the same source succeeds", async () => {
    const svcA = await admin.services.create({ name: "many-to-many-src" });
    const svcB = await admin.services.create({ name: "many-to-many-dst-1" });
    const svcC = await admin.services.create({ name: "many-to-many-dst-2" });

    await admin.services.addConsumes(svcA.id, svcB.id);
    await admin.services.addConsumes(svcA.id, svcC.id); // no cardinality conflict — many_to_many

    const list = await admin.services.listConsumes(svcA.id);
    expect(list.items.map((r) => r.toId).sort()).toEqual([svcB.id, svcC.id].sort());

    await admin.services.removeConsumes(svcA.id, svcB.id);
    await admin.services.removeConsumes(svcA.id, svcC.id);
  });

  it("wrong-typed depends-on target is a 400 (pointing at a team)", async () => {
    const svc = await admin.services.create({ name: "edge-wrong-type-svc" });
    const team = await admin.teams.create({ name: "edge-wrong-type-team" });
    await expect(admin.services.addDependsOn(svc.id, team.id)).rejects.toMatchObject({
      status: 400
    });
  });

  describe("RBAC: both-endpoint requirement (mirrors relationship-authz.integration.test.ts)", () => {
    it("addOwner: rights on the owner only, not the target -> 403", async () => {
      const domain = await admin.domains.create({ name: "rbac-owner-domain-a" });
      const team = await admin.teams.create({ name: "rbac-owner-team-a" });

      const user = await createTestUser(server, org, [{ role: "Operator", scope: team.id }]);
      const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
      await expect(client.domains.addOwner(domain.id, team.id)).rejects.toMatchObject({
        status: 403
      });
    });

    it("addOwner: rights on the target only, not the owner -> 403", async () => {
      const domain = await admin.domains.create({ name: "rbac-owner-domain-b" });
      const team = await admin.teams.create({ name: "rbac-owner-team-b" });

      const user = await createTestUser(server, org, [{ role: "Operator", scope: domain.id }]);
      const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
      await expect(client.domains.addOwner(domain.id, team.id)).rejects.toMatchObject({
        status: 403
      });
    });

    it("addOwner: rights at BOTH endpoints succeeds", async () => {
      const domain = await admin.domains.create({ name: "rbac-owner-domain-c" });
      const team = await admin.teams.create({ name: "rbac-owner-team-c" });

      const user = await createTestUser(server, org, [
        { role: "Operator", scope: domain.id },
        { role: "Operator", scope: team.id }
      ]);
      const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
      const created = await client.domains.addOwner(domain.id, team.id);
      expect(created.typeId).toBe("owns");
      await admin.domains.removeOwner(domain.id, team.id);
    });

    it("removeOwner also requires rights at both endpoints", async () => {
      const domain = await admin.domains.create({ name: "rbac-owner-domain-d" });
      const team = await admin.teams.create({ name: "rbac-owner-team-d" });
      await admin.domains.addOwner(domain.id, team.id);

      const ownerOnly = await createTestUser(server, org, [{ role: "Operator", scope: team.id }]);
      const ownerOnlyClient = new ScpClient({ baseUrl: server.baseUrl, token: ownerOnly.token });
      await expect(ownerOnlyClient.domains.removeOwner(domain.id, team.id)).rejects.toMatchObject({
        status: 403
      });

      const both = await createTestUser(server, org, [
        { role: "Operator", scope: domain.id },
        { role: "Operator", scope: team.id }
      ]);
      const bothClient = new ScpClient({ baseUrl: server.baseUrl, token: both.token });
      const removed = await bothClient.domains.removeOwner(domain.id, team.id);
      expect(removed.id).toBeTruthy();
    });

    it("addConsumes requires rights at both endpoints", async () => {
      const svcA = await admin.services.create({ name: "rbac-edge-svc-a" });
      const svcB = await admin.services.create({ name: "rbac-edge-svc-b" });

      const fromOnly = await createTestUser(server, org, [{ role: "Operator", scope: svcA.id }]);
      const fromOnlyClient = new ScpClient({ baseUrl: server.baseUrl, token: fromOnly.token });
      await expect(fromOnlyClient.services.addConsumes(svcA.id, svcB.id)).rejects.toMatchObject({
        status: 403
      });

      const both = await createTestUser(server, org, [
        { role: "Operator", scope: svcA.id },
        { role: "Operator", scope: svcB.id }
      ]);
      const bothClient = new ScpClient({ baseUrl: server.baseUrl, token: both.token });
      const created = await bothClient.services.addConsumes(svcA.id, svcB.id);
      expect(created.typeId).toBe("consumes");
      await admin.services.removeConsumes(svcA.id, svcB.id);
    });
  });

  it("unauthenticated addOwner is a 401", async () => {
    const domain = await admin.domains.create({ name: "unauth-domain" });
    const team = await admin.teams.create({ name: "unauth-team" });
    const anon = new ScpClient({ baseUrl: server.baseUrl });
    await expect(anon.domains.addOwner(domain.id, team.id)).rejects.toMatchObject({ status: 401 });
  });

  it("ownership edges created via the typed endpoints remain queryable via M1's owners-of named query", async () => {
    const domain = await admin.domains.create({ name: "named-query-domain" });
    const team = await admin.teams.create({ name: "named-query-team" });
    await admin.domains.addOwner(domain.id, team.id);

    const result = await admin.graph.query("owners-of", { objectId: domain.id });
    expect(result.objects.some((o) => o.id === team.id)).toBe(true);
  });
});
