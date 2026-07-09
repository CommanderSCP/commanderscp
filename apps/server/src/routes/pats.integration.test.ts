import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestServer
} from "../test-support/harness.js";

function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

interface PatBody {
  id: string;
  name: string;
  token?: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
}

/**
 * Personal Access Tokens (M2 stage 2 Part A, BUILD_AND_TEST.md §8 M2 item 3) — create/use/list/
 * revoke, expiry, and the load-bearing RBAC-parity property: a PAT must resolve to EXACTLY the
 * same permission scope as the owning user's own session, never more.
 */
describe("Personal Access Tokens", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("create → use as bearer on a real endpoint → list → revoke → revoked token now rejected", async () => {
    const org = await createTestOrg(server, "pat-lifecycle");

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeader(org.adminToken),
      payload: { name: "ci-token" }
    });
    expect(create.statusCode, create.body).toBe(201);
    const created = create.json() as PatBody;
    expect(created.token).toMatch(/^scp_pat_[^.]+\.[^.]+$/);
    expect(created.name).toBe("ci-token");
    expect(created.expiresAt).toBeNull();

    // Use it as a bearer token against a real, unrelated endpoint.
    const listDomains = await server.app.inject({
      method: "GET",
      url: "/api/v1/domains",
      headers: authHeader(created.token as string)
    });
    expect(listDomains.statusCode, listDomains.body).toBe(200);

    // List — metadata only, never the token/tokenHash/tokenId.
    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/pats",
      headers: authHeader(org.adminToken)
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json() as { items: PatBody[] }).items;
    const listed = items.find((p) => p.id === created.id);
    expect(listed).toBeTruthy();
    expect(listed?.revokedAt ?? null).toBeNull();
    expect(listed).not.toHaveProperty("token");
    expect(listed).not.toHaveProperty("tokenHash");
    expect(listed).not.toHaveProperty("tokenId");

    // Revoke.
    const revoke = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/pats/${created.id}`,
      headers: authHeader(org.adminToken)
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((revoke.json() as PatBody).revokedAt).toBeTruthy();

    // The revoked token is now rejected — same real endpoint as before.
    const afterRevoke = await server.app.inject({
      method: "GET",
      url: "/api/v1/domains",
      headers: authHeader(created.token as string)
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("a PAT created with expiresAt in the past is rejected", async () => {
    const org = await createTestOrg(server, "pat-expired");
    const past = new Date(Date.now() - 60_000).toISOString();

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeader(org.adminToken),
      payload: { name: "already-expired", expiresAt: past }
    });
    expect(create.statusCode, create.body).toBe(201);
    const created = create.json() as PatBody;

    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/domains",
      headers: authHeader(created.token as string)
    });
    expect(res.statusCode).toBe(401);
  });

  it("resolves to the exact same RBAC scope as the owning user's session — a PAT never escalates", async () => {
    const org = await createTestOrg(server, "pat-rbac-parity");
    // Bound at the org root scope (not "self") so both read (allowed) and write (forbidden) are
    // meaningfully exercised — a Viewer role has object:read but not object:write.
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);

    const createPat = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeader(viewer.token),
      payload: { name: "viewer-pat" }
    });
    expect(createPat.statusCode, createPat.body).toBe(201);
    const patToken = (createPat.json() as PatBody).token as string;

    const sessionRead = await server.app.inject({
      method: "GET",
      url: "/api/v1/domains",
      headers: authHeader(viewer.token)
    });
    const patRead = await server.app.inject({
      method: "GET",
      url: "/api/v1/domains",
      headers: authHeader(patToken)
    });
    expect(sessionRead.statusCode).toBe(200);
    expect(patRead.statusCode).toBe(sessionRead.statusCode);

    const sessionWrite = await server.app.inject({
      method: "POST",
      url: "/api/v1/domains",
      headers: authHeader(viewer.token),
      payload: { name: "should-be-forbidden-session" }
    });
    const patWrite = await server.app.inject({
      method: "POST",
      url: "/api/v1/domains",
      headers: authHeader(patToken),
      payload: { name: "should-be-forbidden-pat" }
    });
    expect(sessionWrite.statusCode).toBe(403);
    // Load-bearing: the PAT must be exactly as forbidden as the session — no escalation.
    expect(patWrite.statusCode).toBe(403);
  });

  it("404s revoking a PAT that doesn't exist or belongs to another user — no existence leak", async () => {
    const org = await createTestOrg(server, "pat-cross-user");
    const userA = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
    const userB = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);

    const createPat = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeader(userA.token),
      payload: { name: "userA-pat" }
    });
    const patId = (createPat.json() as PatBody).id;

    const revokeAsB = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/pats/${patId}`,
      headers: authHeader(userB.token)
    });
    expect(revokeAsB.statusCode).toBe(404);

    const revokeNonexistent = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/pats/${randomUUID()}`,
      headers: authHeader(userA.token)
    });
    expect(revokeNonexistent.statusCode).toBe(404);
  });

  it("401 without a token", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/auth/pats" });
    expect(res.statusCode).toBe(401);
  });
});
