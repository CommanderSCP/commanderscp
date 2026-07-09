import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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

  // -------------------------------------------------------------------------------------------
  // PR #4 security review, CRITICAL 3: the runtime pool must BE the least-privileged login role
  // (session-level), not a privileged user relying on a per-transaction SET ROLE.
  // -------------------------------------------------------------------------------------------

  it("the application's own pool authenticates as scp_app (session_user), not a superuser", async () => {
    const result = await server.deps.db.execute(
      sql`SELECT current_user, session_user, (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_is_super`
    );
    const row = result.rows[0] as {
      current_user: string;
      session_user: string;
      session_is_super: boolean;
    };
    expect(row.session_user).toBe("scp_app");
    expect(row.current_user).toBe("scp_app");
    expect(row.session_is_super).toBe(false);
  });

  it("runtime login role, no SET ROLE, no org context: every tenant table fails closed", async () => {
    // RawScpAppClient now AUTHENTICATES as scp_app — this connection is exactly what a
    // forgotten-withTenantTx code path would use. Prove the session really is the login role
    // (not a privileged session_user that merely SET ROLE'd down), then probe every table.
    const raw = await RawScpAppClient.connect();
    const who = await raw.query<{ session_user: string; current_user: string }>(
      "SELECT session_user, current_user"
    );
    expect(who.rows[0]?.session_user).toBe("scp_app");
    expect(who.rows[0]?.current_user).toBe("scp_app");

    for (const table of [
      "objects",
      "relationships",
      "role_bindings",
      "audit_events",
      "outbox",
      "idempotency_keys"
    ]) {
      const result = await raw.query(`SELECT * FROM ${table}`);
      expect(result.rows, `${table} must be empty with no org context`).toHaveLength(0);
    }
    // Org-scoped registry/rbac tables may only show built-in (org_id IS NULL) rows.
    for (const table of ["object_types", "relationship_types", "roles"]) {
      const result = await raw.query<{ org_id: string | null }>(`SELECT org_id FROM ${table}`);
      expect(
        result.rows.every((r) => r.org_id === null),
        `${table} must show only built-in rows with no org context`
      ).toBe(true);
    }
    await raw.close();
  });

  it("scp_relay: SET LOCAL ROLE scp_relay reads outbox cross-org, but cannot touch other tenant tables", async () => {
    const raw = await RawScpAppClient.connect();

    // Trigger at least one outbox row for org A (any write does).
    // (objectAId's create in beforeAll already wrote outbox rows for org A.)

    // Plain scp_app (no relay role, no org context): outbox is invisible.
    const plain = await raw.query("SELECT * FROM outbox");
    expect(plain.rows).toHaveLength(0);

    // Inside a transaction with SET LOCAL ROLE scp_relay: cross-org outbox rows are visible...
    await raw.query("BEGIN");
    await raw.query("SET LOCAL ROLE scp_relay");
    const relayOutbox = await raw.query<{ org_id: string }>("SELECT org_id FROM outbox");
    expect(relayOutbox.rows.length).toBeGreaterThan(0);
    const orgs = new Set(relayOutbox.rows.map((r) => r.org_id));
    expect(orgs.has(orgAId) || orgs.has(orgBId)).toBe(true);
    await raw.query("ROLLBACK");

    // ...but every other tenant table is a hard permission-denied (scp_relay has NO grants on
    // them — stronger than RLS row-filtering). One transaction per probe: a denied statement
    // aborts its transaction, so probes can't share one.
    const relayProbe = async (statement: string, params?: unknown[]): Promise<void> => {
      await raw.query("BEGIN");
      await raw.query("SET LOCAL ROLE scp_relay");
      await expect(raw.query(statement, params), `${statement} must be denied`).rejects.toThrow(
        /permission denied/i
      );
      await raw.query("ROLLBACK");
    };
    for (const table of ["objects", "relationships", "role_bindings", "audit_events"]) {
      await relayProbe(`SELECT * FROM ${table}`);
    }
    await relayProbe(
      `INSERT INTO objects (id, org_id, domain_id, type_id, name, urn, origin_domain_id, content_hash)
       VALUES ($1, $2, $2, 'service', 'relay-sneak', $3, $2, 'deadbeef')`,
      [randomUUID(), orgAId, `urn:scp:${orgAId}:service:relay-sneak-${randomUUID()}`]
    );
    await raw.close();
  });

  it("scp_relay has no BYPASSRLS, no superuser, and no LOGIN", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const result = await client.query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcanlogin: boolean;
    }>("SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'scp_relay'");
    await client.end();
    expect(result.rows[0]?.rolbypassrls).toBe(false);
    expect(result.rows[0]?.rolsuper).toBe(false);
    expect(result.rows[0]?.rolcanlogin).toBe(false);
  });

  it("scp_app does NOT inherit scp_relay's permissive outbox policy (INHERIT FALSE membership)", async () => {
    // Regression guard for the subtle leak the role split itself introduced in review: RLS
    // policies naming a role also apply to members that INHERIT from it, so a plain
    // `GRANT scp_relay TO scp_app` would have silently given every ordinary scp_app query
    // cross-org outbox visibility. Membership is INHERIT FALSE — relay powers exist only
    // inside an explicit SET LOCAL ROLE scp_relay transaction (previous test).
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const crossOrg = await raw.query("SELECT * FROM outbox WHERE org_id = $1", [orgAId]);
    expect(crossOrg.rows).toHaveLength(0);
    await raw.close();
  });

  // -------------------------------------------------------------------------------------------
  // PR #4 security review, MAJOR 4: role_bindings — the privilege-authority table — gets the
  // same adversarial treatment as the data tables.
  // -------------------------------------------------------------------------------------------

  it("role_bindings: cross-org SELECT sees zero rows (wrong org context)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const result = await raw.query("SELECT * FROM role_bindings WHERE org_id = $1", [orgAId]);
    await raw.close();
    expect(result.rows).toHaveLength(0);
  });

  it("role_bindings: cross-org UPDATE affects zero rows (cannot flip another org's allow to deny)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const result = await raw.query("UPDATE role_bindings SET effect = 'deny' WHERE org_id = $1", [
      orgAId
    ]);
    await raw.close();
    expect(result.rowCount).toBe(0);
  });

  it("role_bindings: WITH CHECK blocks INSERTing a binding into another org (privilege grant forgery)", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    const role = await raw.query<{ id: string }>(
      "SELECT id FROM roles WHERE org_id IS NULL AND name = 'Owner'"
    );
    const ownerRoleId = role.rows[0]?.id;
    expect(ownerRoleId).toBeTruthy();
    await expect(
      raw.query(
        `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
         VALUES ($1, $2, $3, $4, $5, 'allow')`,
        [randomUUID(), orgAId, randomUUID(), ownerRoleId, objectAId]
      )
    ).rejects.toThrow(/row-level security|violates/i);
    await raw.close();
  });

  it("role_bindings: unset org context fails closed for SELECT and INSERT", async () => {
    const raw = await RawScpAppClient.connect();
    const rows = await raw.query("SELECT * FROM role_bindings");
    expect(rows.rows).toHaveLength(0);
    const role = await raw.query<{ id: string }>(
      "SELECT id FROM roles WHERE org_id IS NULL AND name = 'Viewer'"
    );
    await expect(
      raw.query(
        `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
         VALUES ($1, $2, $3, $4, $5, 'allow')`,
        [randomUUID(), orgAId, randomUUID(), role.rows[0]?.id, objectAId]
      )
    ).rejects.toThrow(/row-level security|violates/i);
    await raw.close();
  });

  // -------------------------------------------------------------------------------------------
  // PR #4 security review, MAJOR 5: relationship_types gets the same WITH CHECK write probes
  // object_types already had.
  // -------------------------------------------------------------------------------------------

  it("cannot register a custom relationship type claiming org_id NULL (built-in) via WITH CHECK", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgAId);
    await expect(
      raw.query(
        `INSERT INTO relationship_types (id, org_id, display_name) VALUES ($1, NULL, 'Sneaky Built-in Rel')`,
        [`sneaky-rel-${randomUUID()}`]
      )
    ).rejects.toThrow(/row-level security/i);
    await raw.close();
  });

  it("cannot register a relationship type into ANOTHER org via WITH CHECK", async () => {
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgBId);
    await expect(
      raw.query(
        `INSERT INTO relationship_types (id, org_id, display_name) VALUES ($1, $2, 'Cross-org Rel Type')`,
        [`cross-rel-${randomUUID()}`, orgAId]
      )
    ).rejects.toThrow(/row-level security/i);
    await raw.close();
  });
});
