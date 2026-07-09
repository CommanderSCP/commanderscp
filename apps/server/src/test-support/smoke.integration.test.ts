import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, createTestOrg, type TestServer } from "./harness.js";

describe("smoke: bootstrap + generic object CRUD over real Postgres", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("creates an org, logs in, and round-trips a generic object", async () => {
    const org = await createTestOrg(server, "smoke");

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "billing" }
    });
    expect(create.statusCode, create.body).toBe(201);
    const created = create.json();
    expect(created.name).toBe("billing");
    expect(created.type).toBe("service"); // M0 legacy contract shape — unchanged

    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(page.items.some((o: { id: string }) => o.id === created.id)).toBe(true);
  });

  it("round-trips a generic object through the M1 /objects/{type} endpoint", async () => {
    const org = await createTestOrg(server, "smoke-generic");

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "checkout", properties: { tier: "critical" } }
    });
    expect(create.statusCode, create.body).toBe(201);

    const generic = await server.app.inject({
      method: "GET",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(generic.statusCode).toBe(200);

    const byUrn = await server.app.inject({
      method: "GET",
      url: `/api/v1/objects/service/${create.json().id}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(byUrn.statusCode, byUrn.body).toBe(200);
    const genericObject = byUrn.json();
    expect(genericObject.typeId).toBe("service");
    expect(genericObject.urn).toMatch(/^urn:scp:/);
    expect(genericObject.domainId).toBeTruthy();
  });
});
