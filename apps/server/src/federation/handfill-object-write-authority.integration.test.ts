import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, objects, objectTypes, roleBindings, roles } from "../db/schema.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import { PAIR_BOUND_OBJECT_TYPE_IDS } from "../graph/pair-bound-types.js";
import { PEER_BOUND_OBJECT_TYPE_IDS } from "./outpost-binding.js";
import {
  GOVERNANCE_MANAGED_OBJECT_TYPE_IDS,
  PROJECTION_BOUND_OBJECT_TYPE_IDS
} from "../governance/governance-managed-types.js";

/** `federation:write` IS NOT A GRAPH-WRITE PERMISSION. See docs/federation.md §227. */
describe("hand-fill demands object:write as a second bar — federation:write is not estate authority (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `federation:write` at the org root and `object:write` NOWHERE — the FederationAdmin shape. */
  let federationOnly: TestUser;
  /** A real paired peer, not fixture noise. See docs/federation.md §228. */
  let handFillPeer: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "handfill-objwrite");
    federationOnly = await createFederationOnlyUser();
    handFillPeer = await pairCommanderPeer();
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function post(url: string, token: string, payload: unknown) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>
    });
  }

  /** The FederationAdmin under test. See docs/federation.md §229. */
  async function createFederationOnlyUser(): Promise<TestUser> {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `federation-admin-${randomUUID().slice(0, 8)}`,
        permissions: ["federation:read", "federation:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user;
  }

  /** A paired `commander` peer, so a hand-fill can actually reach `upsertObjectByUrn`. */
  async function pairCommanderPeer(): Promise<string> {
    const domainId = randomUUID();
    const { publicKey } = generateKeyPairSync("ed25519");
    const res = await post("/api/v1/federation/peers", org.adminToken, {
      domainId,
      name: `handfill-objwrite-cmdr-${domainId.slice(0, 8)}`,
      role: "commander",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    expect(res.statusCode, res.body).toBe(201);
    return domainId;
  }

  /** Live rows of a type in this org with this urn — the "nothing was written" half. */
  async function liveRowsByUrn(typeId: string, urn: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          id: objects.id,
          provenance: objects.provenance,
          revision: objects.revision,
          originDomainId: objects.originDomainId
        })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, typeId),
            eq(objects.urn, urn),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  /** Every type this door will write, computed not listed. See docs/federation.md §230. */
  async function handFillableTypeIds(): Promise<string[]> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ id: objectTypes.id }).from(objectTypes)
    );
    return rows
      .map((r) => r.id)
      .filter(
        (id) =>
          !PAIR_BOUND_OBJECT_TYPE_IDS.has(id) &&
          !PEER_BOUND_OBJECT_TYPE_IDS.has(id) &&
          !PROJECTION_BOUND_OBJECT_TYPE_IDS.has(id) &&
          !GOVERNANCE_MANAGED_OBJECT_TYPE_IDS.has(id)
      )
      .sort();
  }

  it("a FederationAdmin (federation:write, no object:write) cannot author estate objects through hand-fill", async () => {
    const typeIds = await handFillableTypeIds();
    // Non-vacuity: if the exclusions above ever swallow the whole registry the loop would pass by
    // running zero iterations. `service` and `component` are the two the defect was reported
    // against and must always be in the set.
    expect(typeIds).toEqual(expect.arrayContaining(["service", "component"]));

    for (const typeId of typeIds) {
      const name = `objwrite-${typeId}-${randomUUID().slice(0, 8)}`;
      const urn = `urn:scp:${org.orgId}:${typeId}:${name}`;
      const res = await post("/api/v1/federation/hand-fill", federationOnly.token, {
        peer: handFillPeer,
        typeId,
        urn,
        name
      });

      expect(res.statusCode, `${typeId}: ${res.body}`).toBe(403);
      // THE SPECIFIC VIOLATION, named. A bare 403 would also be produced by a door that refused
      // this actor for some unrelated reason, and the detail is what an operator acts on.
      expect(res.body, `${typeId}`).toMatch(/object:write/);
      expect(
        await liveRowsByUrn(typeId, urn),
        `${typeId}: a refusal that still stored the row is not a refusal`
      ).toHaveLength(0);
    }
  });

  it("CONTROL: both permissions still land the row, and it is STILL a shadow copy authored by the import actor", async () => {
    // Without this, a door that refuses everyone would pass. See docs/federation.md §231.
    const name = `objwrite-control-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${org.orgId}:service:${name}`;
    const res = await post("/api/v1/federation/hand-fill", org.adminToken, {
      peer: handFillPeer,
      typeId: "service",
      urn,
      name,
      properties: { guess: true }
    });
    expect(res.statusCode, res.body).toBe(201);

    const rows = await liveRowsByUrn("service", urn);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenance).toBe("manual");
    expect(rows[0]!.revision).toBe(0);
    expect(rows[0]!.originDomainId).toBe(handFillPeer);

    // The AUTHORSHIP half, read from the audit chain rather than inferred from the response: the
    // create was recorded against the synthetic import actor, not against the Administrator who
    // asked for it. `authorize`/`hasPermission` resolve the REQUESTING subject; the row does not.
    const events = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ actorId: auditEvents.actorId, action: auditEvents.action })
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.subjectId, rows[0]!.id)))
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorId, `${event.action} was authored by the requesting subject`).toBe(
        FEDERATION_IMPORT_ACTOR_ID
      );
    }
  });

  it("NO REGRESSION: the pair-bound, peer-bound and governance-managed refusals still fire for an actor who clears the new bar", async () => {
    // Driven by the ADMINISTRATOR. See docs/federation.md §232.
    const pairBound = await post("/api/v1/federation/hand-fill", org.adminToken, {
      peer: handFillPeer,
      typeId: "placement",
      urn: `urn:scp:${org.orgId}:placement:nr-${randomUUID().slice(0, 8)}`,
      name: "no-regression-placement"
    });
    expect(pairBound.statusCode, pairBound.body).toBe(403);
    expect(pairBound.body).toMatch(/cannot be hand-filled/);

    // A peer-bound `outpost` naming a domain that is NOT this instance's own — refused with a 400
    // by `assertHandFillableType`, which is a different status AND a different reason from the bar
    // under test, so it cannot be satisfied by it.
    const peerBound = await post("/api/v1/federation/hand-fill", org.adminToken, {
      peer: handFillPeer,
      typeId: "outpost",
      urn: `urn:scp:${org.orgId}:outpost:nr-${randomUUID().slice(0, 8)}`,
      name: "no-regression-outpost",
      properties: { peerDomainId: randomUUID() }
    });
    expect(peerBound.statusCode, peerBound.body).toBe(400);
    expect(peerBound.body).toMatch(/must be this instance's own federation domain id/);

    // A governance-managed type still takes `policy:write`, resolved against the REQUESTING subject
    // — so an actor holding `federation:write` + `object:write` and no `policy:write` is refused
    // with the governance detail, not with the estate one.
    const govActor = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `fedwrite-objwrite-${randomUUID().slice(0, 8)}`,
        permissions: ["federation:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: govActor.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    const govName = `nr-policy-${randomUUID().slice(0, 8)}`;
    const govUrn = `urn:scp:${org.orgId}:policy:${govName}`;
    const governanceManaged = await post("/api/v1/federation/hand-fill", govActor.token, {
      peer: handFillPeer,
      typeId: "policy",
      urn: govUrn,
      name: govName,
      properties: { enforcement: "advisory" }
    });
    expect(governanceManaged.statusCode, governanceManaged.body).toBe(403);
    expect(governanceManaged.body).toMatch(/policy:write/);
    expect(await liveRowsByUrn("policy", govUrn)).toHaveLength(0);
  });
});
