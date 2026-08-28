import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  testDatabaseUrl,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * INSTANCE-TIER CREDENTIALS — role-model.md §5 step 9 / §3B
 * ================================================================================================
 *
 * Replaces the single shared `SCP_OPERATOR_TOKEN` with named, hashed, individually revocable,
 * optionally expiring credentials.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE ONE A HAPPY-PATH TEST MISSES: a credential that has been
 * revoked, or has expired, must stop opening doors — not the door that minted it, but the REAL
 * instance-tier doors whose blast radius is the whole deployment. So the tests below drive
 * `PUT /api/v1/instance/governance-move-rung`, an actual operator surface, rather than only the
 * credential CRUD. A credential API that mints correctly and is not consulted by anything is the
 * "built, never installed" defect wearing a security feature's name.
 */
describe("instance operator credentials (role-model.md §5 step 9)", () => {
  let server: TestServer;
  let org: TestOrg;
  let admin: pg.Client;
  /** The bootstrap env token the harness configures. */
  let bootstrapToken: string;

  const RUNG_URL = "/api/v1/instance/governance-move-enforcement";

  beforeAll(async () => {
    // The harness only sets SCP_OPERATOR_TOKEN when asked, and every case here either uses it or
    // asserts a refusal against it, so it is passed explicitly rather than assumed.
    server = await buildTestServer({ operatorToken: "bootstrap-operator-token-for-tests" });
    org = await createTestOrg(server, "op-creds");
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    bootstrapToken = server.deps.config.operatorToken ?? "";
  });

  afterAll(async () => {
    await admin?.end();
    await server?.app.close();
  });

  function mint(token: string, name: string, expiresAt?: string | null) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/instance/operator-credentials",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": token
      },
      payload: { name, ...(expiresAt !== undefined ? { expiresAt } : {}) }
    });
  }

  it("the harness really has a bootstrap token configured (known-positive control)", () => {
    // Everything below either uses it or asserts a refusal. If it were empty, the refusal tests
    // would pass for the wrong reason and the admission tests would fail confusingly.
    expect(bootstrapToken.length).toBeGreaterThan(0);
  });

  it("mints a credential with the bootstrap token, returning the secret exactly once", async () => {
    const res = await mint(bootstrapToken, "ci-runner");
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^scp_op_/);
    expect(body.name).toBe("ci-runner");

    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/instance/operator-credentials",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": bootstrapToken
      }
    });
    const listed = list.json().items.find((c: { id: string }) => c.id === body.id);
    expect(listed).toBeDefined();
    // The secret is returned once and never again — and nothing anywhere serializes the hash.
    expect(JSON.stringify(listed)).not.toContain(body.token);
    expect(JSON.stringify(list.json())).not.toContain("tokenHash");
  });

  it("the minted credential OPENS A REAL instance-tier door", async () => {
    const created = (await mint(bootstrapToken, `works-${Date.now()}`)).json();
    const res = await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      },
      payload: { enabled: false }
    });
    // Not the credential API — the governance:move rung, whose blast radius is every org on the
    // deployment. This is the assertion that the new mechanism is actually wired into the doors.
    expect(res.statusCode, res.body).toBe(200);
  });

  it("REVOKING one stops it opening that door, while the bootstrap token still works", async () => {
    const created = (await mint(bootstrapToken, `revokeme-${Date.now()}`)).json();

    const before = await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      },
      payload: { enabled: false }
    });
    expect(before.statusCode).toBe(200);

    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/instance/operator-credentials/${created.id}`,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": bootstrapToken
      }
    });
    expect(revoked.statusCode, revoked.body).toBe(204);

    const after = await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      },
      payload: { enabled: false }
    });
    // The capability the shared env token never had: revoke ONE holder without touching the others.
    expect(after.statusCode).toBe(403);

    const others = await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": bootstrapToken
      },
      payload: { enabled: false }
    });
    expect(others.statusCode).toBe(200);
  });

  it("an EXPIRED credential is refused", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const created = (await mint(bootstrapToken, `expired-${Date.now()}`, past)).json();
    const res = await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      },
      payload: { enabled: false }
    });
    expect(res.statusCode).toBe(403);
  });

  it("a garbage or truncated credential is refused, and so is the right id with the wrong secret", async () => {
    const created = (await mint(bootstrapToken, `wrongsecret-${Date.now()}`)).json();
    const tokenId = (created.token as string).split(".")[0];

    for (const bad of ["scp_op_nope.nope", "not-a-token", `${tokenId}.wrongsecret`, ""]) {
      const res = await server.app.inject({
        method: "PUT",
        url: RUNG_URL,
        headers: {
          authorization: `Bearer ${org.adminToken}`,
          "x-scp-operator-token": bad
        },
        payload: { enabled: false }
      });
      // Presenting a REAL token id with a wrong secret is the case a lookup-only implementation
      // would admit; argon2 verification is what refuses it.
      expect(res.statusCode, `expected refusal for ${JSON.stringify(bad)}`).toBe(403);
    }
  });

  it("reports which mechanism admitted the caller — so 'still on the bootstrap token' is visible", async () => {
    const viaBootstrap = await server.app.inject({
      method: "GET",
      url: "/api/v1/instance/operator-credentials",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": bootstrapToken
      }
    });
    expect(viaBootstrap.json().callerMechanism).toBe("bootstrap-env-token");

    const created = (await mint(bootstrapToken, `mech-${Date.now()}`)).json();
    const viaCredential = await server.app.inject({
      method: "GET",
      url: "/api/v1/instance/operator-credentials",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      }
    });
    // Without this, migrating off the env token is invisible: minting credentials while leaving
    // SCP_OPERATOR_TOKEN set looks exactly like having finished.
    expect(viaCredential.json().callerMechanism).toBe("credential");
  });

  it("records WHO minted it, even when the authority was the anonymous shared token", async () => {
    const created = (await mint(bootstrapToken, `attributed-${Date.now()}`)).json();
    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/instance/operator-credentials",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": bootstrapToken
      }
    });
    const row = list.json().items.find((c: { id: string }) => c.id === created.id);
    // The authority (the shared token) names nobody; the authenticated principal does. That split
    // is the thing the env token alone could not express.
    expect(row.createdByUserId).not.toBeNull();
  });

  it("stamps last_used_at, so a credential nobody uses is identifiable", async () => {
    const created = (await mint(bootstrapToken, `used-${Date.now()}`)).json();
    await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      },
      payload: { enabled: false }
    });
    // Best-effort and asynchronous in the verifier, so poll rather than assert immediately.
    let lastUsed: string | null = null;
    for (let i = 0; i < 20 && lastUsed === null; i++) {
      const r = await admin.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM instance_operator_credentials WHERE id = $1`,
        [created.id]
      );
      lastUsed = r.rows[0]?.last_used_at ? r.rows[0]!.last_used_at!.toISOString() : null;
      if (lastUsed === null) await new Promise((res) => setTimeout(res, 50));
    }
    expect(lastUsed).not.toBeNull();
  });

  it("the request-serving role CANNOT resurrect a revoked credential — the column grant is real", async () => {
    const created = (await mint(bootstrapToken, `resurrect-${Date.now()}`)).json();
    await server.app.inject({
      method: "DELETE",
      url: `/api/v1/instance/operator-credentials/${created.id}`,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": bootstrapToken
      }
    });

    // THE ESCALATION THIS CLOSES. `scp_app` must stamp `last_used_at` on the request path, so it
    // needs UPDATE — and a BLANKET update grant would let anything running as the request-serving
    // role clear `revoked_at` and bring a revoked credential back to life, which is exactly the
    // capability this table exists to provide. The grant is therefore column-scoped.
    //
    // Asserted as `scp_app` specifically, because the harness's ordinary connection is the
    // Testcontainers SUPERUSER, which bypasses grants and RLS and would make this pass vacuously.
    const app = new pg.Client({ connectionString: server.deps.config.runtimeDatabaseUrl });
    await app.connect();
    try {
      await expect(
        app.query(`UPDATE instance_operator_credentials SET revoked_at = NULL WHERE id = $1`, [
          created.id
        ])
      ).rejects.toThrow();

      // And the column it IS allowed to write still works, so the grant narrows rather than blocks.
      await app.query(
        `UPDATE instance_operator_credentials SET last_used_at = now() WHERE id = $1`,
        [created.id]
      );
    } finally {
      await app.end();
    }

    // Still refused at the door afterwards — the row was never resurrected.
    const after = await server.app.inject({
      method: "PUT",
      url: RUNG_URL,
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "x-scp-operator-token": created.token
      },
      payload: { enabled: false }
    });
    expect(after.statusCode).toBe(403);
  });

  it("the credential API itself requires an operator credential — no tenant role opens it", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/instance/operator-credentials",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "should-be-refused" }
    });
    // The org's bootstrap ADMIN — the strongest tenant principal there is — with no operator
    // header. Any RBAC gating here would put a tenant permission in front of authority that binds
    // the tenant's neighbours.
    expect(res.statusCode, res.body).toBe(403);
  });

  it("requires authentication as well as the operator credential", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/instance/operator-credentials",
      headers: { "x-scp-operator-token": bootstrapToken },
      payload: { name: "no-auth" }
    });
    // The credential is the AUTHORITY; the authenticated principal is the ATTRIBUTION. Neither
    // substitutes for the other.
    expect(res.statusCode).toBe(401);
  });
});
