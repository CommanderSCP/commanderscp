import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE MEMBERSHIP DOOR, exercised through the generated SDK (principle 3).
 *
 * These go through `ScpClient` rather than calling the repo, because the repo already has its own
 * integration tests and they would pass against a route that was never registered. The question
 * here is whether a user can reach it at all.
 */
describe("infrastructure members route (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let productId: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "infra-members-route");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const product = await createTestComponent(admin, { name: `ig-${randomUUID().slice(0, 8)}` });
    productId = product.id;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it("WIRING: reports and reads membership through the generated SDK", async () => {
    const diff = await admin.infrastructureMembers.report(productId, [
      { memberId: "i-001", address: "10.0.0.1" },
      { memberId: "i-002", address: "10.0.0.2" }
    ]);
    expect(diff.added).toHaveLength(2);

    const view = await admin.infrastructureMembers.get(productId);
    expect(view.productObjectId).toBe(productId);
    expect(view.members.map((m) => m.memberId)).toEqual(["i-001", "i-002"]);
  });

  it("a second report REPLACES, and the read reflects it", async () => {
    await admin.infrastructureMembers.report(productId, [
      { memberId: "i-003", address: "10.0.0.3" }
    ]);
    const view = await admin.infrastructureMembers.get(productId);
    // Through the API, not the repo: this is the property a caller actually observes.
    expect(view.members).toEqual([{ memberId: "i-003", address: "10.0.0.3" }]);
  });

  it("an empty report is accepted and empties the product", async () => {
    await admin.infrastructureMembers.report(productId, []);
    const view = await admin.infrastructureMembers.get(productId);
    expect(view.members).toEqual([]);
  });

  it("404s a product that does not exist, rather than creating membership for it", async () => {
    await expect(admin.infrastructureMembers.get(randomUUID())).rejects.toMatchObject({
      status: 404
    });
  });

  it("refuses a body carrying an unknown field", async () => {
    // The request schema is strict, so a reporter that invents `producer` is refused rather than
    // silently ignored — provenance is stamped server-side and a self-declared producer must not
    // look accepted.
    const response = await fetch(
      // `baseUrl` already ends in `/api/v1` (the harness appends it, matching the spec's
      // `servers` entry), so the path here is relative to that — not repeated.
      `${server.baseUrl}/infrastructure-products/${productId}/members`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${org.adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ members: [], producer: "someone-else" })
      }
    );
    expect(response.status).toBe(400);
  });
});
