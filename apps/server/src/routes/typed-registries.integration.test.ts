import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestServer
} from "../test-support/harness.js";
import { TYPED_REGISTRY_RESOURCES } from "./typed-registries.js";

function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1): thin layers over the same
 * objects/object_types substrate the generic `/objects/{type}` endpoint uses. Uses `app.inject`
 * directly (not the SDK) to exercise the real HTTP contract, mirroring
 * test-support/smoke.integration.test.ts's style.
 */
describe("typed registries: thin layers over the generic graph substrate", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  // Smoke-tests all 8 basePath/typeId pairs from the real exported config (not a hand-copied
  // table here) — catches a basePath/typeId typo in routes/typed-registries.ts immediately.
  it.each(TYPED_REGISTRY_RESOURCES)(
    "smoke: create + get round-trip through /api/v1/$basePath (typeId=$typeId)",
    async ({ basePath, typeId }) => {
      const org = await createTestOrg(server, `smoke-${basePath}`);

      const create = await server.app.inject({
        method: "POST",
        url: `/api/v1/${basePath}`,
        headers: authHeader(org.adminToken),
        payload: { name: `${basePath}-smoke-object` }
      });
      expect(create.statusCode, create.body).toBe(201);
      const created = create.json();
      expect(created.typeId).toBe(typeId);
      expect(created.name).toBe(`${basePath}-smoke-object`);

      const get = await server.app.inject({
        method: "GET",
        url: `/api/v1/${basePath}/${created.id}`,
        headers: authHeader(org.adminToken)
      });
      expect(get.statusCode, get.body).toBe(200);
      expect(get.json().id).toBe(created.id);
    }
  );

  describe.each([
    { basePath: "domains", typeId: "domain" },
    { basePath: "services", typeId: "service" },
    { basePath: "teams", typeId: "team" }
  ])("full CRUD round-trip, RBAC, and substrate parity: $basePath", ({ basePath, typeId }) => {
    it("401 without a token", async () => {
      const res = await server.app.inject({ method: "GET", url: `/api/v1/${basePath}` });
      expect(res.statusCode).toBe(401);
    });

    it("403 for a Viewer-role user attempting a write", async () => {
      const org = await createTestOrg(server, `viewer-${basePath}`);
      const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);

      const res = await server.app.inject({
        method: "POST",
        url: `/api/v1/${basePath}`,
        headers: authHeader(viewer.token),
        payload: { name: "should-be-forbidden" }
      });
      expect(res.statusCode).toBe(403);
    });

    it("create/list/get/update/delete/upsert round-trip, visible both ways through /objects/{type}", async () => {
      const org = await createTestOrg(server, `crud-${basePath}`);

      // create via the typed endpoint
      const create = await server.app.inject({
        method: "POST",
        url: `/api/v1/${basePath}`,
        headers: authHeader(org.adminToken),
        payload: { name: "crud-object", properties: { tier: "critical" } }
      });
      expect(create.statusCode, create.body).toBe(201);
      const created = create.json();
      expect(created.typeId).toBe(typeId);

      // get via the typed endpoint
      const getTyped = await server.app.inject({
        method: "GET",
        url: `/api/v1/${basePath}/${created.id}`,
        headers: authHeader(org.adminToken)
      });
      expect(getTyped.statusCode, getTyped.body).toBe(200);
      expect(getTyped.json().id).toBe(created.id);

      // ... and visible via the pre-existing generic /objects/{type} endpoint (same substrate).
      const genericGet = await server.app.inject({
        method: "GET",
        url: `/api/v1/objects/${typeId}/${created.id}`,
        headers: authHeader(org.adminToken)
      });
      expect(genericGet.statusCode, genericGet.body).toBe(200);
      expect(genericGet.json().id).toBe(created.id);

      // list via the typed endpoint
      const list = await server.app.inject({
        method: "GET",
        url: `/api/v1/${basePath}`,
        headers: authHeader(org.adminToken)
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items.some((o: { id: string }) => o.id === created.id)).toBe(true);

      // update via the typed endpoint
      const update = await server.app.inject({
        method: "PATCH",
        url: `/api/v1/${basePath}/${created.id}`,
        headers: authHeader(org.adminToken),
        payload: { name: "crud-object-renamed" }
      });
      expect(update.statusCode, update.body).toBe(200);
      expect(update.json().name).toBe("crud-object-renamed");

      // reverse direction: an object created via the GENERIC endpoint is visible via the typed one.
      const genericCreate = await server.app.inject({
        method: "POST",
        url: `/api/v1/objects/${typeId}`,
        headers: authHeader(org.adminToken),
        payload: { name: "created-via-generic" }
      });
      expect(genericCreate.statusCode, genericCreate.body).toBe(201);
      const viaGeneric = genericCreate.json();
      const typedGetOfGeneric = await server.app.inject({
        method: "GET",
        url: `/api/v1/${basePath}/${viaGeneric.id}`,
        headers: authHeader(org.adminToken)
      });
      expect(typedGetOfGeneric.statusCode, typedGetOfGeneric.body).toBe(200);
      expect(typedGetOfGeneric.json().name).toBe("created-via-generic");

      // idempotent upsert-by-URN via the typed endpoint (create branch)
      const urn = `urn:scp:${org.orgId}:${typeId}:upsert-${randomUUID()}`;
      const upsertCreate = await server.app.inject({
        method: "PUT",
        url: `/api/v1/${basePath}/${encodeURIComponent(urn)}`,
        headers: authHeader(org.adminToken),
        payload: { name: "upserted" }
      });
      expect(upsertCreate.statusCode, upsertCreate.body).toBe(201);
      const upserted = upsertCreate.json();
      expect(upserted.urn).toBe(urn);

      // replaying the exact same PUT is a no-op (200, not 201) — same idempotent-upsert contract
      // as the generic endpoint (graph/objects-repo.ts upsertObjectByUrn).
      const upsertReplay = await server.app.inject({
        method: "PUT",
        url: `/api/v1/${basePath}/${encodeURIComponent(urn)}`,
        headers: authHeader(org.adminToken),
        payload: { name: "upserted" }
      });
      expect(upsertReplay.statusCode, upsertReplay.body).toBe(200);
      expect(upsertReplay.json().id).toBe(upserted.id);

      // delete (soft) via the typed endpoint
      const del = await server.app.inject({
        method: "DELETE",
        url: `/api/v1/${basePath}/${created.id}`,
        headers: authHeader(org.adminToken)
      });
      expect(del.statusCode, del.body).toBe(200);
      expect(del.json().deletedAt).not.toBeNull();
    });
  });
});
