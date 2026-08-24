import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "../test-support/harness.js";

const OPERATOR_TOKEN = "test-operator-token-doctor";

/**
 * §7.3 — the operator-token-gated instance doctor. Instance-wide facts (DSN reachability, recovery
 * state, delivery config) answer to the deployment operator, not a tenant bearer. HTTP-only.
 */
describe("GET /api/v1/doctor/instance (§7.3, operator-token-gated)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer({ operatorToken: OPERATOR_TOKEN });
  }, 90_000);

  afterAll(async () => {
    await server.close();
  });

  it("401s with no operator token", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/doctor/instance" });
    expect(res.statusCode).toBe(401);
  });

  it("401s with a wrong operator token", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/doctor/instance",
      headers: { "x-scp-operator-token": "not-the-token" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns instance checks with the right token, including a passing DSN + primary (not recovery) check", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/doctor/instance",
      headers: { "x-scp-operator-token": OPERATOR_TOKEN }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { checks: Array<{ id: string; status: string; detail: string }> };
    const byId = new Map(body.checks.map((c) => [c.id, c]));
    expect(byId.get("dsn-reachability")?.status).toBe("ok");
    // The Testcontainers DB is the writable primary, not a replica.
    expect(byId.get("pg-recovery-state")?.status).toBe("ok");
    expect(byId.has("delivery-s3-endpoints")).toBe(true);
    expect(byId.has("mtls-san-coverage")).toBe(true);
    expect(byId.has("xo-readiness")).toBe(true);
    // Every check carries a detail string (the required DoctorCheck field).
    for (const c of body.checks) expect(typeof c.detail).toBe("string");
  });
});

describe("GET /api/v1/doctor/instance — closed when no operator token is configured", () => {
  it("403s when the instance has no operator token", async () => {
    const noTokenServer = await buildTestServer();
    try {
      const res = await noTokenServer.app.inject({
        method: "GET",
        url: "/api/v1/doctor/instance",
        headers: { "x-scp-operator-token": "anything" }
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await noTokenServer.close();
    }
  }, 90_000);
});
