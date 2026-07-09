import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  RawScpAppClient,
  testDatabaseUrl,
  type TestServer
} from "../test-support/harness.js";
import pg from "pg";

/**
 * BUILD_AND_TEST.md §8 M1 DoD (a): "adversarial RLS cross-org probes: cross-org reads/writes
 * with wrong or unset app.current_org_id fail closed on every tenant table". Everything here
 * goes through `RawScpAppClient` — a raw `pg.Client` running as the same least-privileged
 * `scp_app` role a real request uses, but issuing hand-written SQL directly (no application
 * code, no `withTenantTx`) — so these probes exercise the database's own defenses, independent
 * of whether the app layer remembers to filter by org.
 */
describe("RLS: adversarial cross-org probes", () => {
  let server: TestServer;
  let orgAId: string;
  let orgBId: string;
  let objectAId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    const orgA = await createTestOrg(server, "rls-a");
    const orgB = await createTestOrg(server, "rls-b");
    orgAId = orgA.orgId;
    orgBId = orgB.orgId;

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${orgA.adminToken}` },
      payload: { name: "org-a-secret-service" }
    });
    expect(create.statusCode, create.body).toBe(201);
    objectAId = create.json().id;
  });

  afterAll(async () => {
    await server.close();
  });

  it("scp_app role does not have BYPASSRLS (charter: 'app DB role without BYPASSRLS')", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const result = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'scp_app'"
    );
    await client.end();
    expect(result.rows[0]?.rolbypassrls).toBe(false);
    expect(result.rows[0]?.rolsuper).toBe(false);
  });

  it("fails closed when app.current_org_id is never set (SELECT)", async () => {
    const raw = await RawScpAppClient.connect();
    const result = await raw.query("SELECT * FROM objects WHERE id = $1", [objectAId]);
    await raw.close();
    expect(result.rows).toHaveLength(0);
  });

  it("fails closed when app.current_org_id is never set (INSERT is rejected, not silently org-NULL)", async () => {
    const raw = await RawScpAppClient.connect();
    await expect(
      raw.query(
        `INSERT INTO objects (id, org_id, domain_id, type_id, name, urn, origin_domain_id, content_hash)
         VALUES ($1, $2, $2, 'service', 'sneaky', $3, $2, 'deadbeef')`,
        [randomUUID(), orgAId, `urn:scp:${orgAId}:service:sneaky-${randomUUID()}`]
      )
    ).rejects.toThrow(/row-level security/i);
    await raw.close();
  });

  it("fails closed with the WRONG org context set (SELECT sees zero rows)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const result = await raw.query("SELECT * FROM objects WHERE id = $1", [objectAId]);
    await raw.close();
    expect(result.rows).toHaveLength(0);
  });

  it("fails closed with the WRONG org context set (UPDATE affects zero rows)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const result = await raw.query("UPDATE objects SET name = 'pwned' WHERE id = $1", [objectAId]);
    await raw.close();
    expect(result.rowCount).toBe(0);
  });

  it("hard DELETE on objects is blocked at the privilege level (scp_app only has soft-delete UPDATE)", async () => {
    // Stronger than RLS row-filtering: `scp_app` was never GRANTed DELETE on `objects` at all
    // (drizzle/0002_rls_rbac_seed.sql) — deletion is soft-delete-only (deleted_at UPDATE), by
    // design, regardless of org context.
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    await expect(raw.query("DELETE FROM objects WHERE id = $1", [objectAId])).rejects.toThrow(
      /permission denied/i
    );
    await raw.close();
  });

  it("cannot INSERT a row under org B's context claiming org A's org_id (WITH CHECK)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    await expect(
      raw.query(
        `INSERT INTO objects (id, org_id, domain_id, type_id, name, urn, origin_domain_id, content_hash)
         VALUES ($1, $2, $2, 'service', 'cross-org-insert', $3, $2, 'deadbeef')`,
        [randomUUID(), orgAId, `urn:scp:${orgAId}:service:cross-org-${randomUUID()}`]
      )
    ).rejects.toThrow(/row-level security/i);
    await raw.close();
  });

  it("succeeds and returns the row only under the CORRECT org context", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgAId);
    const result = await raw.query("SELECT * FROM objects WHERE id = $1", [objectAId]);
    await raw.close();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("org-a-secret-service");
  });

  it("built-in registry rows (org_id IS NULL) stay visible under any org context", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const objectTypes = await raw.query("SELECT id FROM object_types WHERE id = 'service'");
    const relTypes = await raw.query("SELECT id FROM relationship_types WHERE id = 'owns'");
    const rolesRows = await raw.query("SELECT name FROM roles WHERE name = 'Owner'");
    await raw.close();
    expect(objectTypes.rows).toHaveLength(1);
    expect(relTypes.rows).toHaveLength(1);
    expect(rolesRows.rows).toHaveLength(1);
  });

  it("cannot register a custom object type claiming org_id NULL (built-in) via WITH CHECK", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgAId);
    await expect(
      raw.query(
        `INSERT INTO object_types (id, org_id, display_name) VALUES ($1, NULL, 'Sneaky Built-in')`,
        [`sneaky-${randomUUID()}`]
      )
    ).rejects.toThrow(/row-level security/i);
    await raw.close();
  });

  it("relationships table fails closed the same way as objects", async () => {
    const raw = await RawScpAppClient.connect();
    // no org context set at all
    const result = await raw.query("SELECT * FROM relationships");
    await raw.close();
    expect(result.rows).toHaveLength(0);
  });

  it("audit_events: correct org context still cannot UPDATE or DELETE (append-only guard)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgAId);
    const existing = await raw.query("SELECT id FROM audit_events WHERE org_id = $1 LIMIT 1", [
      orgAId
    ]);
    expect(existing.rows.length).toBeGreaterThan(0);
    await expect(
      raw.query("UPDATE audit_events SET action = 'tampered' WHERE org_id = $1", [orgAId])
    ).rejects.toThrow();
    await expect(
      raw.query("DELETE FROM audit_events WHERE org_id = $1", [orgAId])
    ).rejects.toThrow();
    await raw.close();
  });

  it("audit_events also fails closed cross-org for SELECT", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const result = await raw.query("SELECT * FROM audit_events WHERE org_id = $1", [orgAId]);
    await raw.close();
    expect(result.rows).toHaveLength(0);
  });

  it("outbox and idempotency_keys fail closed cross-org", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const outboxRows = await raw.query("SELECT * FROM outbox WHERE org_id = $1", [orgAId]);
    const idemRows = await raw.query("SELECT * FROM idempotency_keys WHERE org_id = $1", [orgAId]);
    await raw.close();
    expect(outboxRows.rows).toHaveLength(0);
    expect(idemRows.rows).toHaveLength(0);
  });

  it("the application API itself (not just raw SQL) refuses cross-org reads (defense in depth, layer 2)", async () => {
    const orgB = await createTestOrg(server, "rls-app-layer");
    const get = await server.app.inject({
      method: "GET",
      url: `/api/v1/objects/service/${objectAId}`,
      headers: { authorization: `Bearer ${orgB.adminToken}` }
    });
    expect(get.statusCode).toBe(404);
  });
});
