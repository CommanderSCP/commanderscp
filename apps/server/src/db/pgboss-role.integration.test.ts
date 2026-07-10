import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listenTestServer,
  RawScpPgBossClient,
  testDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";

/**
 * M3 tracked security follow-up (BUILD_AND_TEST.md §8 M3 item 9, closing a gap flagged in an
 * earlier security review): pg-boss no longer runs its own internal schema migrations on the
 * admin/superuser connection — it connects as the schema-scoped `scp_pgboss` login role
 * (drizzle/0008_pgboss_role.sql, src/db/provision.ts's `provisionPgBossRole`,
 * src/events/pgboss.ts). Two things need PROVING here, not just asserting:
 *
 *   1. pg-boss actually boots under this least-privileged role — its own internal
 *      `CREATE SCHEMA`/`CREATE TYPE`/`CREATE TABLE`/`CREATE FUNCTION` migrations at `.start()`
 *      succeed without superuser, because `scp_pgboss` OWNS the `pgboss` schema (ownership, not
 *      elevated privilege, is what makes this work — see the migration's own comments for why no
 *      `ALTER DEFAULT PRIVILEGES` is needed on top of that).
 *   2. `scp_pgboss` has ZERO privilege on `public`'s tenant tables — proven as an actual Postgres
 *      permission-denied failure (SQLSTATE 42501), not merely an empty result set, since RLS
 *      could otherwise make an ungranted role's SELECT look identical to a granted-but-filtered
 *      one.
 *
 * `listenTestServer({ withEventRelay: true })` is what actually starts pg-boss in-process
 * (main.ts's `role === "all" || "worker"` branch) — at the time this test was written, no other
 * integration test in the suite exercised that path, so this is also the first real proof pg-boss
 * boots end to end under the new role, not just under the old admin connection.
 */
describe("scp_pgboss: schema-scoped role probe", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer({ withEventRelay: true });
  });

  afterAll(async () => {
    await server.close();
  });

  it("scp_pgboss is NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE, and LOGIN only because boot-time provisioning granted it", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const result = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles WHERE rolname = 'scp_pgboss'`
    );
    await client.end();
    expect(result.rows[0]?.rolsuper).toBe(false);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
    expect(result.rows[0]?.rolcreatedb).toBe(false);
    expect(result.rows[0]?.rolcreaterole).toBe(false);
    // The migration creates scp_pgboss NOLOGIN (fail-closed default); LOGIN is granted only at
    // boot by provisionPgBossRole. pg-boss has already connected and started by this point
    // (beforeAll), so this being true is itself proof provisioning ran.
    expect(result.rows[0]?.rolcanlogin).toBe(true);
  });

  it("scp_pgboss owns the pgboss schema, and pg-boss's own migrations actually created its tables in it", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const owner = await client.query<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_namespace n
       JOIN pg_roles r ON r.oid = n.nspowner
       WHERE n.nspname = 'pgboss'`
    );
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'pgboss'`
    );
    await client.end();

    expect(owner.rows[0]?.owner).toBe("scp_pgboss");
    // pg-boss (v10) creates at least these tables at .start() — proof its migrations really ran
    // under scp_pgboss's ownership, not just that the empty schema exists.
    const tableNames = tables.rows.map((r) => r.table_name);
    expect(tableNames).toEqual(expect.arrayContaining(["version", "queue", "job", "archive"]));
  });

  it("scp_pgboss CAN operate inside its own pgboss schema: reads pg-boss's own table, and a DDL round-trip", async () => {
    const raw = await RawScpPgBossClient.connect();

    const version = await raw.query("SELECT * FROM pgboss.version");
    expect(version.rows.length).toBeGreaterThan(0);

    await raw.query("CREATE TABLE pgboss.probe_test (id int PRIMARY KEY)");
    await raw.query("INSERT INTO pgboss.probe_test (id) VALUES (1)");
    const probeRows = await raw.query("SELECT * FROM pgboss.probe_test");
    expect(probeRows.rows).toHaveLength(1);
    await raw.query("DROP TABLE pgboss.probe_test");

    await raw.close();
  });

  it("scp_pgboss CANNOT read or write public.objects — hard permission-denied (42501), not an RLS-emptied result", async () => {
    const raw = await RawScpPgBossClient.connect();
    await expect(raw.query("SELECT * FROM public.objects")).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      raw.query(
        `INSERT INTO public.objects (id, org_id, domain_id, type_id, name, urn, origin_domain_id, content_hash)
         VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'service', 'probe', 'urn:probe', gen_random_uuid(), 'deadbeef')`
      )
    ).rejects.toMatchObject({ code: "42501" });
    await raw.close();
  });

  it("scp_pgboss CANNOT read or write public.relationships — permission-denied (42501)", async () => {
    const raw = await RawScpPgBossClient.connect();
    await expect(raw.query("SELECT * FROM public.relationships")).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      raw.query(
        `INSERT INTO public.relationships (id, org_id, type_id, from_id, to_id, origin_domain_id, content_hash)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'depends_on', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'deadbeef')`
      )
    ).rejects.toMatchObject({ code: "42501" });
    await raw.close();
  });

  it("scp_pgboss CANNOT read or write public.role_bindings — permission-denied (42501)", async () => {
    const raw = await RawScpPgBossClient.connect();
    await expect(raw.query("SELECT * FROM public.role_bindings")).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      raw.query(
        `INSERT INTO public.role_bindings (id, org_id, subject_id, role_id, scope_object_id)
         VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`
      )
    ).rejects.toMatchObject({ code: "42501" });
    await raw.close();
  });

  it("scp_pgboss CANNOT read or write public.changes — permission-denied (42501)", async () => {
    // `changes` (drizzle/0007_change_coordination.sql, M3) is the coordination engine's tenant
    // table — the same isolation guarantee proven for objects/relationships/role_bindings above
    // must hold for it too (BUILD_AND_TEST.md §8 M3 DoD: "pg-boss-role probe proves the
    // pgboss-schema role cannot touch tenant tables (objects/relationships/role_bindings/changes)").
    const raw = await RawScpPgBossClient.connect();
    await expect(raw.query("SELECT * FROM public.changes")).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      raw.query(
        `INSERT INTO public.changes (object_id, org_id) VALUES (gen_random_uuid(), gen_random_uuid())`
      )
    ).rejects.toMatchObject({ code: "42501" });
    await raw.close();
  });
});
