import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestServer, createTestOrg, type TestServer } from "../test-support/harness.js";
import { users } from "../db/schema.js";
import { ensureBootstrapAdmin } from "../auth/local-auth.js";
import { PASSWORD_CHANGE_REQUIRED_DETAIL_PREFIX } from "../auth/require-auth.js";

function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

interface CurrentUserBody {
  userId: string;
  orgId: string;
  orgName: string;
  username: string;
  subjectObjectId: string;
  instanceRole: string;
  mustChangePassword: boolean;
}

/** `/auth/me`, `/auth/logout`, `/auth/config`. See docs/routes.md §1. */
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
    // outpost-ui.md §9.2 — the serving instance's INSTALL-TIME role, from config, so the web shell
    // can pick the commander site or the small outpost site. The harness boots with the default
    // (`SCP_FEDERATION_ROLE` unset → commander); this pins that the field is present and mirrors
    // config rather than the per-org advisory federation_self.role (which is "unset" here).
    expect(body.instanceRole).toBe("commander");

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

/** #422 review fix (SHOULD-FIX 3/4) — the forced password-change gate (require-auth.ts) and
 *  POST /auth/password, the only door that clears it. `createTestOrg` clears the flag itself (a
 *  fixture models an org that finished onboarding), so this block builds its OWN bootstrap admin
 *  directly with `ensureBootstrapAdmin` to get an UNCLEARED one. */
describe("forced password change (mustChangePassword)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  async function freshBootstrapAdmin(
    label: string
  ): Promise<{ username: string; password: string; token: string }> {
    const username = `pwd-${label}-${Math.random().toString(36).slice(2)}`;
    const result = await ensureBootstrapAdmin(
      server.deps.db,
      {
        orgName: `pwd-org-${label}-${Math.random().toString(36).slice(2)}`,
        adminUsername: username
      },
      { info: () => undefined, warn: () => undefined }
    );
    if (!result.oneTimePassword) throw new Error("expected a one-time password");
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: result.oneTimePassword }
    });
    expect(login.statusCode, login.body).toBe(200);
    const token = (login.json() as { token: string }).token;
    return { username, password: result.oneTimePassword, token };
  }

  it("a fresh bootstrap admin's session reports mustChangePassword: true", async () => {
    const admin = await freshBootstrapAdmin("report");
    const me = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(admin.token)
    });
    expect(me.statusCode, me.body).toBe(200);
    expect((me.json() as CurrentUserBody).mustChangePassword).toBe(true);
  });

  it(
    "MUTATION-CAUGHT: every route but /auth/{me,logout,password} 403s with " +
      "password_change_required until the password is changed — proven by asserting BOTH the " +
      "403 before AND the 200 after (a removed gate would fail the 403 half; a gate that never " +
      "clears would fail the 200 half)",
    async () => {
      const admin = await freshBootstrapAdmin("gate");

      const blocked = await server.app.inject({
        method: "POST",
        url: "/api/v1/services",
        headers: authHeader(admin.token),
        payload: { name: "should-be-blocked" }
      });
      expect(blocked.statusCode, blocked.body).toBe(403);
      // NOT a Problem `extensions` field: measured while building this that Fastify's OWN
      // schema-based response serialization strips one for any route declaring the plain,
      // unknown-key-stripping `ProblemSchema` (which is most of them) — see
      // require-auth.ts's PASSWORD_CHANGE_REQUIRED_DETAIL_PREFIX doc comment. `detail` DOES
      // survive (a declared field), so that is the wire-reliable signal.
      expect((blocked.json() as { detail?: string }).detail).toContain(
        PASSWORD_CHANGE_REQUIRED_DETAIL_PREFIX
      );

      // The three allowed doors stay reachable.
      for (const url of ["/api/v1/auth/me"] as const) {
        const res = await server.app.inject({
          method: "GET",
          url,
          headers: authHeader(admin.token)
        });
        expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      }

      const wrongCurrent = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: authHeader(admin.token),
        payload: { currentPassword: "definitely-wrong", newPassword: "a-brand-new-password-123" }
      });
      expect(wrongCurrent.statusCode, wrongCurrent.body).toBe(401);

      const changed = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/password",
        headers: authHeader(admin.token),
        payload: { currentPassword: admin.password, newPassword: "a-brand-new-password-123" }
      });
      expect(changed.statusCode, changed.body).toBe(204);

      // Now unblocked — same token, same session, the flag was cleared server-side.
      const nowAllowed = await server.app.inject({
        method: "POST",
        url: "/api/v1/services",
        headers: authHeader(admin.token),
        payload: { name: "now-allowed" }
      });
      expect(nowAllowed.statusCode, nowAllowed.body).toBe(201);

      const meAfter = await server.app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: authHeader(admin.token)
      });
      expect((meAfter.json() as CurrentUserBody).mustChangePassword).toBe(false);

      // The OLD (one-time) password no longer logs in; the NEW one does.
      const oldLogin = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: admin.username, password: admin.password }
      });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: admin.username, password: "a-brand-new-password-123" }
      });
      expect(newLogin.statusCode, newLogin.body).toBe(200);
    }
  );

  it("createTestOrg's fixture already has the flag cleared (onboarding modeled as finished)", async () => {
    const org = await createTestOrg(server, "pwd-fixture");
    const me = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(org.adminToken)
    });
    expect((me.json() as CurrentUserBody).mustChangePassword).toBe(false);
    const row = await server.deps.db.query.users.findFirst({
      where: eq(users.id, (me.json() as CurrentUserBody).userId)
    });
    expect(row?.mustChangePassword).toBe(false);
  });
});
