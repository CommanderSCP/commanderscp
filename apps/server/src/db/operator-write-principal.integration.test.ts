import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, testDatabaseUrl, type TestServer } from "../test-support/harness.js";

/**
 * ================================================================================================
 * EVERY INSTANCE-SCOPED TABLE HAS A WRITE PRINCIPAL — role-model.md §5 step 9, drizzle/0102
 * ================================================================================================
 *
 * THE PROPERTY. An instance-scoped table here is tenant-READ (a `tenant_read` policy,
 * `FOR SELECT USING (true)`) and operator-WRITE (the `scp_operator` role, drizzle/0076). Under
 * FORCE ROW LEVEL SECURITY both halves are required: the GRANT alone is denied by the absent
 * policy, and the POLICY alone is denied by the absent grant.
 *
 * IT SHIPPED WRONG THREE TIMES, WHICH IS WHY THIS IS A CENSUS AND NOT TWO ASSERTIONS.
 * 0029/0035/0036/0074 created four such tables with no write principal and 0076 came back for them;
 * 0083 §2 then created `governance_move_instance_rung` without one — 0086's comment records this as
 * having happened "AGAIN" — and 0062 had already done the same for
 * `dependency_subscription_unlock`. Each time the noticed instances were fixed and the CLASS was
 * left open. So this test does not name tables: it DERIVES the population from `pg_policies` and
 * requires the write principal for every member. A table added tomorrow with a `tenant_read` policy
 * and no operator write fails here, which is the only version of this check that stops the
 * recurrence.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS READS THE CATALOG INSTEAD OF ATTEMPTING A WRITE
 * ------------------------------------------------------------------------------------------------
 * The obvious test — write the row and see it land — CANNOT detect this defect in this suite. The
 * integration harness's `DATABASE_URL` is the Testcontainers SUPERUSER, and a superuser bypasses
 * both grants and row-level security outright. That is precisely why two of these survived a fully
 * green suite for as long as they did, and it generalises: **a passing integration run here is not
 * evidence that a grant exists.** The catalog is the only instrument in this environment that can
 * see the thing being asserted.
 */
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
