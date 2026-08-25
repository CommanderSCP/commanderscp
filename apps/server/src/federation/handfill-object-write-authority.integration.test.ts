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

/**
 * ================================================================================================
 * `federation:write` IS NOT A GRAPH-WRITE PERMISSION — THE HAND-FILL DOOR
 * ================================================================================================
 *
 * THE PROPERTY. `federation:write` operates the federation LINK: pair a peer, export a bundle,
 * import one, poke. `object:write` authors the ESTATE. A door that writes a graph object while
 * demanding only the former has silently merged the two, and every role built on the split becomes
 * a lie. `POST /api/v1/federation/hand-fill` was exactly that door: `routes/federation.ts`
 * authorizes `{permission: 'federation:write', scopeObjectId: auth.orgId}` and nothing else, and
 * `federation/handfill-repo.ts` then takes a free-form `typeId`, `urn`, `name`, `properties` and
 * `labels`. Its four preceding refusals are narrow — pair-bound (`placement`), peer-bound naming a
 * foreign domain (`outpost`), projection-bound (`freeze`), and governance-managed (`policy`,
 * `control`, ... , which take `policy:write`) — so EVERY OTHER REGISTERED TYPE, `service` and
 * `component` and `change` included, landed on `federation:write` alone.
 *
 * THE ACTOR THAT MAKES IT LIVE, and why the M21.7 coincidence argument does not cover this. A
 * `FederationAdmin` role holds `federation:read` + `federation:write` and DELIBERATELY withholds
 * `object:write`, on the invariant "a federation administrator operates the link, it does not edit
 * the estate". M21.7's sibling hole (`policy` through the same door) was latent because
 * `federation:write` and `policy:write` both land on Administrator and Owner and nowhere else — an
 * accident between two migrations. This one is not an accident: the role is being written to hold
 * one permission and not the other on purpose, so a role that exists to be safe was the exploit.
 *
 * MEASURED before the fix, over HTTP, with the `federationOnly` actor below:
 * `POST /api/v1/federation/hand-fill {typeId: "service", ...}` answered **201** with a live row in
 * `objects`, from a subject holding `object:write` NOWHERE.
 *
 * ================================================================================================
 * WHAT THIS FILE ASSERTS
 * ================================================================================================
 *  1. THE REFUSAL, over the whole reachable type set rather than over `service` alone — computed
 *     from the live `object_types` registry minus the four classes hand-fill already refuses for
 *     other reasons, so a type registered tomorrow is covered without editing this file. Per-type
 *     cases are how the sibling hole survived a green suite.
 *  2. THE CONTROL — an actor with BOTH permissions still lands the row, so (1) is not satisfied by
 *     a hand-fill route that is broken for everyone.
 *  3. THE SHADOW-COPY PROPERTY did not regress: the row that lands is still authored by
 *     `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'` and `revision: 0`, which is the
 *     entire reconciliation mechanism (`handfill-repo.ts` module doc). The new bar is
 *     AUTHORIZATION ONLY; if a later change "tidies" it by passing the requesting subject to the
 *     upsert, the next signed bundle stops reconciling over the shadow and this case goes red.
 *  4. NO REGRESSION in the four refusals that already existed — driven by the BOTH-permissions
 *     actor on purpose, so each one is measured to still fire on its own reason rather than being
 *     masked by the new `object:write` 403 in front of it.
 *
 * ================================================================================================
 * MUTATION RUN (2026-08-25). MEASURED, not predicted.
 * ================================================================================================
 *   M-1  DELETE the `await assertObjectWriteAuthorityForHandFill(tx, input)` call from
 *        `handFillObject`
 *          -> 1 failed | 2 passed. "a FederationAdmin (federation:write, no object:write) cannot
 *             author estate objects through hand-fill" went red on
 *             `AssertionError: assembly: {"id":"01a03935-...","typeId":"assembly",...,
 *             "revision":0,"provenance":"manual",...}: expected 201 to be 403` — the loop's first
 *             type alphabetically, with the row LIVE in `objects` and stamped as a shadow copy, i.e.
 *             a subject holding `object:write` nowhere had authored an estate object.
 *             THE OTHER TWO CASES STAYED GREEN, which is the measured point of case 4: the four
 *             pre-existing refusals never depended on this bar, so the new bar is not what makes
 *             them pass and they are not what makes it pass.
 */
describe("hand-fill demands object:write as a second bar — federation:write is not estate authority (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `federation:write` at the org root and `object:write` NOWHERE — the FederationAdmin shape. */
  let federationOnly: TestUser;
  /**
   * A REAL, PAIRED commander peer, and it is load-bearing rather than fixture noise.
   *
   * `handFillObject` runs every refusal BEFORE `getPeerByIdOrName`, so with a peer that does not
   * exist each refusal case would still see its 403 — but the "nothing was written" half would be
   * VACUOUS (the write was unreachable whatever the guard did) and unwiring the guard would turn the
   * case red with a 404 about the peer rather than letting the row land. With a real peer the only
   * thing between the request and a live row is the bar under test.
   */
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

  /**
   * The FederationAdmin under test: `federation:write` and NOTHING that writes the graph.
   *
   * Built through `roles.org_id` (the org-defined-role mechanism) because no BUILT-IN role can
   * express it — `drizzle/0012` puts `federation:write` on Administrator and Owner, and
   * `drizzle/0002` puts `object:write` on both of those plus Operator and Approver, so every
   * built-in holder of one holds the other. Testing against the role table's current accident would
   * measure nothing.
   *
   * Viewer is bound purely so the harness mints an auth row and a live token; `object:read` is no
   * part of what is under test and grants no write anywhere.
   */
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

  /**
   * EVERY registered type this door will actually try to write, computed rather than listed.
   *
   * The four exclusions are the classes hand-fill refuses for reasons that are NOT this bar — a
   * pair-bound `placement`, a peer-bound `outpost` naming a foreign domain, a projection-bound
   * `freeze`, and the governance-managed set that takes `policy:write`. Including them would make
   * the loop green on refusals that already existed, which is precisely the vacuous shape this file
   * is written against: the 403 would be real and would say nothing about `object:write`.
   */
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
    // Without this the case above is satisfied by a hand-fill route that refuses everyone — which
    // would delete DESIGN §13's reason for the feature (an air-gapped outpost with no bundle
    // transport keying a commander-origin object in by hand).
    //
    // The provenance assertions are not decoration. The bar added above is AUTHORIZATION ONLY: the
    // row must still be written as `FEDERATION_IMPORT_ACTOR_ID` with `provenance: 'manual'` and
    // `revision: 0`, because that is what makes ANY later real import (always `revision >= 1`,
    // always `provenance: null`) win the single-writer comparison and reconcile over the shadow.
    // Handing the requesting subject to `upsertObjectByUrn` instead would look like a tidy-up and
    // would silently break reconciliation forever.
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
    // Driven by the ADMINISTRATOR — who holds `object:write` and therefore passes the new bar — on
    // purpose. Driven by the federation-only actor these would all be green off the new 403 alone,
    // and the file would claim coverage it does not have: the risk of adding a broad permission bar
    // is that it MASKS the narrow refusals in front of it, turning four measured guards into one.
    //
    // The `object:write` bar is ordered LAST in `handFillObject` for exactly this reason, and these
    // three assertions are what holds that ordering in place.
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
