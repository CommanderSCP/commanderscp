import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, testDatabaseUrl, type TestServer } from "../test-support/harness.js";

/** EVERY INSTANCE-SCOPED TABLE HAS A WRITE PRINCIPAL. See docs/db.md §7. */
describe("every tenant-read instance table has an operator write principal (drizzle/0102)", () => {
  let server: TestServer;
  let admin: pg.Client;
  let tenantReadTables: string[];

  beforeAll(async () => {
    // Building the server runs the migrations against the container.
    server = await buildTestServer();
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    const res = await admin.query<{ tablename: string }>(
      `SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_read'
        ORDER BY tablename`
    );
    tenantReadTables = res.rows.map((r) => r.tablename);
  });

  afterAll(async () => {
    await admin?.end();
    await server?.app.close();
  });

  it("the census found the instance-scoped tables (known-positive control)", () => {
    // Every assertion below is "for each member of this set...", which passes vacuously on an empty
    // set — and this set comes from a query that can legitimately return zero rows if the policy
    // naming convention ever changes. Seven tables carry `tenant_read` as of drizzle/0102.
    expect(tenantReadTables.length).toBeGreaterThanOrEqual(7);
    expect(tenantReadTables).toContain("governance_move_instance_rung");
    expect(tenantReadTables).toContain("dependency_subscription_unlock");
  });

  it("each one has an `operator_write` policy — the half FORCE RLS denies without", async () => {
    const res = await admin.query<{ tablename: string }>(
      `SELECT DISTINCT tablename FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'operator_write'`
    );
    const withPolicy = new Set(res.rows.map((r) => r.tablename));
    const missing = tenantReadTables.filter((t) => !withPolicy.has(t));
    expect(missing).toEqual([]);
  });

  it("each `operator_write` policy spells out WITH CHECK — an omitted one fails SILENTLY", async () => {
    // `pg_policies.with_check` is NULL when the clause was omitted on a FOR ALL policy. Reads and
    // row-matching still pass; only the write is refused. 0086 documents paying for this shape.
    const res = await admin.query<{ tablename: string; with_check: string | null }>(
      `SELECT tablename, with_check FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'operator_write'`
    );
    const silent = res.rows.filter((r) => r.with_check === null).map((r) => r.tablename);
    expect(silent).toEqual([]);
  });

  it("each one GRANTS write to scp_operator — the other half, denied without", async () => {
    const res = await admin.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'scp_operator' AND table_schema = 'public'`
    );
    const grants = new Map<string, Set<string>>();
    for (const row of res.rows) {
      if (!grants.has(row.table_name)) grants.set(row.table_name, new Set());
      grants.get(row.table_name)!.add(row.privilege_type);
    }
    const missing = tenantReadTables.filter((t) => {
      const g = grants.get(t);
      return !g || !g.has("INSERT") || !g.has("UPDATE") || !g.has("SELECT") || !g.has("DELETE");
    });
    expect(missing).toEqual([]);
  });

  it("scp_app is still NOT a writer of these tables — the read/write split is the point", async () => {
    // The fix must not have been made by widening the request-serving role, which would have
    // dissolved the separation these tables exist to express: any org's ordinary traffic could then
    // author config binding every org on the deployment.
    const res = await admin.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'scp_app' AND table_schema = 'public'
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')`
    );
    const appWrites = res.rows
      .filter((r) => tenantReadTables.includes(r.table_name))
      .map((r) => `${r.table_name}:${r.privilege_type}`);
    expect(appWrites).toEqual([]);
  });
});
