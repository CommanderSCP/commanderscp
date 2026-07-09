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

interface StartBody {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface TokenErrorBody {
  error: string;
  status: number;
}

interface TokenOkBody {
  token: string;
  expiresAt: string;
  org: string;
}

/**
 * SCP's own RFC 8628-shaped device-authorization flow for the CLI (M2 stage 2 Part C) —
 * start → approve (by an authenticated browser session) → poll (single-use) end to end, entirely
 * via `app.inject` (no real network round trip through an external IdP needed — this flow is
 * SCP-hosted, not a proxy to one).
 */
describe("device authorization flow", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("start → approve → poll (success) → the issued token is a working bearer token; a second poll fails", async () => {
    const org = await createTestOrg(server, "device-flow-happy");

    const start = await server.app.inject({ method: "POST", url: "/api/v1/auth/device/start" });
    expect(start.statusCode, start.body).toBe(200);
    const started = start.json() as StartBody;
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.deviceCode.length).toBeGreaterThan(20);
    expect(started.verificationUri).toContain("/device");

    // Poll before approval — expected/normal "not yet" state.
    const pendingPoll = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/token",
      payload: { deviceCode: started.deviceCode }
    });
    expect(pendingPoll.statusCode).toBe(400);
    expect((pendingPoll.json() as TokenErrorBody).error).toBe("authorization_pending");

    // Approve, as an already-authenticated human (their own browser/UI session).
    const approve = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/approve",
      headers: authHeader(org.adminToken),
      payload: { userCode: started.userCode }
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toEqual({ approved: true });

    // Poll again — now succeeds.
    const poll = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/token",
      payload: { deviceCode: started.deviceCode }
    });
    expect(poll.statusCode, poll.body).toBe(200);
    const claimed = poll.json() as TokenOkBody;
    expect(claimed.org).toBe(org.orgName);
    expect(claimed.token).not.toBe(started.deviceCode);

    // The issued token is a genuinely working bearer token.
    const whoami = await server.app.inject({
      method: "GET",
      url: "/api/v1/domains",
      headers: authHeader(claimed.token)
    });
    expect(whoami.statusCode, whoami.body).toBe(200);

    // Single-use: a second poll for the same device code fails.
    const secondPoll = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/token",
      payload: { deviceCode: started.deviceCode }
    });
    expect(secondPoll.statusCode).toBe(400);
    expect((secondPoll.json() as TokenErrorBody).error).toBe("invalid_grant");
  });

  it("approving a nonexistent userCode 404s", async () => {
    const org = await createTestOrg(server, "device-flow-bad-code");

    const approve = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/approve",
      headers: authHeader(org.adminToken),
      payload: { userCode: "ZZZZ-ZZZZ" }
    });
    expect(approve.statusCode).toBe(404);
  });

  it("approve requires authentication", async () => {
    const start = await server.app.inject({ method: "POST", url: "/api/v1/auth/device/start" });
    const started = start.json() as StartBody;

    const approve = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/approve",
      payload: { userCode: started.userCode }
    });
    expect(approve.statusCode).toBe(401);
  });

  it("polling an unknown device code fails with invalid_grant", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/token",
      payload: { deviceCode: "not-a-real-device-code" }
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as TokenErrorBody).error).toBe("invalid_grant");
  });

  it("the issued token carries the approver's own RBAC scope, not more", async () => {
    const org = await createTestOrg(server, "device-flow-rbac");
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);

    const start = await server.app.inject({ method: "POST", url: "/api/v1/auth/device/start" });
    const started = start.json() as StartBody;

    await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/approve",
      headers: authHeader(viewer.token),
      payload: { userCode: started.userCode }
    });
    const poll = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/device/token",
      payload: { deviceCode: started.deviceCode }
    });
    const claimed = poll.json() as TokenOkBody;

    const write = await server.app.inject({
      method: "POST",
      url: "/api/v1/domains",
      headers: authHeader(claimed.token),
      payload: { name: "should-be-forbidden" }
    });
    expect(write.statusCode).toBe(403);
  });
});
