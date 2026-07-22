import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { instanceCosignKeys } from "../db/schema.js";

/**
 * E5/PR #102 adversarial-review follow-up — SIDE-EFFECT-BEFORE-AUTHORIZATION on GET
 * /federation/status. The handler resolves the org's cosign PUBLIC key via
 * `getInstanceCosignPublicKey`, which LAZILY PROVISIONS the org's cosign keypair (a cosign
 * subprocess) on first call. That resolution must run ONLY AFTER the `federation:read` authorize
 * check passes — otherwise an authenticated-but-unauthorized caller could trigger provisioning of
 * their OWN org's keypair just by hitting the route. These tests pin the corrected ordering:
 *
 *  - an authenticated caller LACKING `federation:read` gets 403 AND provisions NO keypair;
 *  - the authorized path still returns the cosign public key (and the keypair is provisioned then).
 */
describe("GET /federation/status — authz gates cosign provisioning (Testcontainers)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "fed-status-authz");
  });

  afterAll(async () => {
    await server.close();
  });

  /** Rows in `instance_cosign_keys` for this org — proving whether provisioning happened. */
  async function cosignKeyRows(orgId: string) {
    return withTenantTx(server.deps.db, orgId, (tx) =>
      tx.select().from(instanceCosignKeys).where(eq(instanceCosignKeys.orgId, orgId))
    );
  }

  it("an authenticated caller LACKING federation:read gets 403 and provisions NO cosign keypair", async () => {
    // A user in a FRESH org with NO role bindings at all — authenticated (real login token) but
    // with zero permissions, so `federation:read` at the org root must be denied.
    const isolatedOrg = await createTestOrg(server, "fed-status-unauth");
    const user = await createTestUser(server, isolatedOrg, []);

    // Precondition: no cosign keypair provisioned for this org yet.
    expect(await cosignKeyRows(isolatedOrg.orgId)).toHaveLength(0);

    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/federation/status",
      headers: { authorization: `Bearer ${user.token}` }
    });
    expect(res.statusCode).toBe(403);

    // THE FIX: authorize runs BEFORE the cosign resolution, so the denied call left NO keypair
    // behind. Before the fix, `getInstanceCosignPublicKey` ran first and provisioned one here.
    expect(await cosignKeyRows(isolatedOrg.orgId)).toHaveLength(0);
  });

  it("the authorized path still returns the cosign public key (and provisions it lazily)", async () => {
    // The bootstrap admin holds an org-root Owner binding, which carries federation:read.
    expect(await cosignKeyRows(org.orgId)).toHaveLength(0);

    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/federation/status",
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { self?: { cosignPublicKey?: string } };
    expect(body.self?.cosignPublicKey).toBeTruthy();
    expect(body.self?.cosignPublicKey).toContain("PUBLIC KEY");
    // The private half never appears in the status payload.
    expect(res.body).not.toContain("PRIVATE");

    // Now the keypair really is provisioned (the authorized read is what lazily created it).
    const rows = await cosignKeyRows(org.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.publicKey).toBe(body.self!.cosignPublicKey);
  });
});
