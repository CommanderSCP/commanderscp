import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, createTestOrg, type TestServer } from "../test-support/harness.js";

function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

interface CurrentUserBody {
  userId: string;
  orgId: string;
  orgName: string;
  username: string;
  subjectObjectId: string;
}

/**
 * `/auth/me`, `/auth/logout`, `/auth/config` (M2 stage 4 Part A, BUILD_AND_TEST.md §8 M2 item
 * 2) — the Web UI's session-discovery surface. `/auth/config` is public; the other two require
 * auth like everything else (auth/require-auth.ts).
 */
describe("Web UI session discovery (/auth/me, /auth/logout, /auth/config)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("getCurrentUser returns the caller's identity and 401s without a token", async () => {
    const org = await createTestOrg(server, "auth-me");

    const me = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(org.adminToken)
    });
    expect(me.statusCode, me.body).toBe(200);
    const body = me.json() as CurrentUserBody;
    expect(body.username).toBe(org.adminUsername);
    expect(body.orgId).toBe(org.orgId);
    expect(body.orgName).toBe(org.orgName);
    expect(body.userId).toBeTruthy();
    expect(body.subjectObjectId).toBeTruthy();

    const anon = await server.app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("getAuthConfig is public (no auth) and reports oidcEnabled=false by default", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ localAuthEnabled: true, oidcEnabled: false });
  });

  it("logout deletes the session — the token is rejected afterwards and the cookie is cleared", async () => {
    const org = await createTestOrg(server, "auth-logout");

    // Confirm the token works before logging out.
    const before = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(org.adminToken)
    });
    expect(before.statusCode).toBe(200);

    const logout = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authHeader(org.adminToken)
    });
    expect(logout.statusCode, logout.body).toBe(204);
    expect(logout.body).toBe("");
    const setCookie = logout.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    expect(String(setCookie)).toContain("scp_session=;");

    const after = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(org.adminToken)
    });
    expect(after.statusCode).toBe(401);
  });

  it("logout requires auth — 401 with no token", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(401);
  });

  it("logout no-ops for PAT-authenticated calls — the PAT keeps working afterwards", async () => {
    const org = await createTestOrg(server, "auth-logout-pat");

    const createPat = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeader(org.adminToken),
      payload: { name: "logout-noop-pat" }
    });
    expect(createPat.statusCode, createPat.body).toBe(201);
    const patToken = (createPat.json() as { token: string }).token;

    const logout = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authHeader(patToken)
    });
    expect(logout.statusCode, logout.body).toBe(204);

    // The PAT itself is a distinct credential from any session — "logout" doesn't revoke it.
    const stillWorks = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(patToken)
    });
    expect(stillWorks.statusCode, stillWorks.body).toBe(200);
  });
});
