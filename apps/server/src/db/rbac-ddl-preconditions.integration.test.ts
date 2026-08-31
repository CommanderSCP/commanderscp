import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleBindings, roles } from "./schema.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  RawScpAppClient,
  testDatabaseUrl,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/**
 * drizzle/0097 — the RBAC DDL preconditions (docs/proposals/role-model.md §1.3g/§1.3h, build
 * order §5 step 1). This increment adds NO role and NO permission; it makes `roles` and
 * `role_bindings` able to HOLD the purpose-shaped roles safely. So there is no route to test
 * through — the whole subject matter is what the DATABASE refuses, and the only honest way to
 * assert that is to attempt the write against real Postgres and read the SQLSTATE back.
 *
 * Two of these guards protect against a failure that CANNOT be caught at the application layer:
 *
 *   - the duplicate-grant key (`role_bindings_grant_key`) is what makes a revoke verb
 *     trustworthy. Two identical grants are individually revocable and collectively still
 *     granting — revoke one, the other still grants, and the API reports success. No amount of
 *     care in one write door prevents that; the database is the only layer every writer passes
 *     through.
 *   - the effect CHECK closes a SILENT INERTNESS: `hasPermission` classifies with exact string
 *     equality (`effects.includes("deny")`, then `includes("allow")` — authz/resolve.ts:285-286),
 *     so a row with effect 'ALLOW' grants nothing and denies nothing while rendering, to any
 *     reader of the table, as authority.
 *
 * And the "cleanup path" describe block is the one that carries the real risk. (a), (b) and (c) can
 * HARD-FAIL on a populated database — a unique index over pre-existing duplicates aborts, and so
 * does a CHECK over pre-existing violations — so 0097 cleans before it constrains. A cleanup that
 * has never run on dirty data is a cleanup nobody has tested: every integration database here is
 * migrated from EMPTY, so the clean path is the only one CI would otherwise ever see. That block
 * therefore builds the dirty state by hand and re-executes the migration's own committed SQL text
 * against it — not a re-implementation of the cleanup in TypeScript, which would only prove the
 * test agrees with itself.
 *
 * Its last three cases are about §1a, the REFUSAL, and they are the ones with authority riding on
 * them. Collapsing duplicate built-in roles keeps the lowest id, which is deterministic but carries
 * no claim to be right: a re-executed 0002 seed writes the M1-era 11-permission `Owner` beside
 * today's 22-permission one, `gen_random_uuid()` decides which holds the lower id, and half the
 * time lowest-id-wins would strip twelve permissions — `freeze:override`, `change:emergency` and
 * `change:accept` among them — from every Owner in the estate, during an upgrade that reported
 * success. The other half widens instead, and since drizzle/0099 it also RESURRECTS `org:admin`,
 * a permission that was deleted precisely because it gates nothing. So 0097 refuses to pick and
 * aborts with the ids and the delta; the tests below pin the refusal, pin that the abort leaves
 * the database untouched, and pin that it does NOT fire on duplicates that merely differ in array
 * order. The exact counts are MEASURED from the live row inside each case rather than restated
 * here, so a later grant migration moves them without touching this paragraph's argument.
 *
 * ------------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied ALONE to `drizzle/0097`'s §1a, measured 2026-08-26, then reverted
 * ------------------------------------------------------------------------------------------------
 *
 * | Mutation | Measured result |
 * |---|---|
 * | `IF report IS NOT NULL THEN` → `IF false THEN` (i.e. §1a computes the delta and never raises) | **1 fail, and the right one.** `ABORTS instead of collapsing built-ins whose permissions have DIVERGED`: `Error: 0097 SUCCEEDED against two Owner rows with different permissions — it silently picked one`. The other 23 stay green, including both collapse cases — which is the whole point: the harmful behaviour is invisible to every test that only checks that duplicates went away. |
 * | The set comparison → a literal array comparison (`WHERE o.permissions IS DISTINCT FROM k.permissions`) | **1 fail, the opposite one.** `does NOT abort when the duplicates agree — order and repeats are not divergence` dies on the migration's own message: `0097: refusing to collapse duplicate built-in roles whose permissions have DIVERGED …`. A false alarm an operator cannot act on, since `hasPermission` reads the array with `= ANY(...)` and does not care about order. |
 */

/**
 * Located by SUFFIX, not by number. Migration numbering across open PRs is strictly serial in
 * merge order and is expected to be re-verified (and RENUMBERED) at merge time — a test that
 * hard-coded `0097_` would silently stop covering the migration the moment that happened.
 * Matching on the stable half of the filename removes the question, and `toHaveLength(1)` makes a
 * rename that breaks the match a loud failure rather than a skipped assertion.
 */
function readMigrationUnderTest(): string {
  const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
  const matches = readdirSync(drizzleDir).filter((f) => f.endsWith("_rbac_role_preconditions.sql"));
  expect(matches).toHaveLength(1);
  return readFileSync(path.join(drizzleDir, matches[0]!), "utf8");
}

/** Runs `fn` and asserts it failed with exactly `sqlState`, surfacing the real error if not. */
async function expectSqlState(fn: () => Promise<unknown>, sqlState: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`expected SQLSTATE ${sqlState}, but the statement SUCCEEDED`);
  }
  const code = (caught as { code?: unknown }).code;
  if (code !== sqlState) throw caught;
}

const UUID_ZERO_PREFIX = "00000000-0000-0000-0000-0000000000";

describe("drizzle/0097 — RBAC DDL preconditions", () => {
  let server: TestServer;
  let org: TestOrg;
  let viewerUser: TestUser;
  let operatorUser: TestUser;
  let admin: pg.Client;
  let viewerRoleId: string;
  let operatorRoleId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "rbac-ddl");
    // `scope: "self"` gives each subject a binding whose scope object is its OWN graph object —
    // a known, per-test id, so the fixtures below never collide with the bootstrap admin's
    // org-root Owner binding.
    viewerUser = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
    operatorUser = await createTestUser(server, org, [{ role: "Operator", scope: "self" }]);

    // Superuser connection — the harness's documented channel for privileged fixture surgery.
    // Required here for a reason that is itself part of the subject: `roles`'s RLS `WITH CHECK
    // (org_id = current_org)` means `scp_app` can NEVER write a built-in (org_id IS NULL) row, so
    // the duplicate-built-in cases are unreachable as the app role by construction.
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();

    const roleRows = await admin.query<{ id: string; name: string }>(
      `SELECT id, name FROM roles WHERE org_id IS NULL AND name IN ('Viewer', 'Operator')`
    );
    viewerRoleId = roleRows.rows.find((r) => r.name === "Viewer")!.id;
    operatorRoleId = roleRows.rows.find((r) => r.name === "Operator")!.id;
    expect(viewerRoleId).toBeTruthy();
    expect(operatorRoleId).toBeTruthy();
  });

  afterAll(async () => {
    await admin?.end();
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (a) roles_builtin_name_key
  // -----------------------------------------------------------------------------------------

  it("refuses a SECOND built-in role with an existing name — the arbiter index 0002's seed never had", async () => {
    await expectSqlState(
      () =>
        admin.query(
          `INSERT INTO roles (id, org_id, name, permissions)
           VALUES (gen_random_uuid(), NULL, 'Viewer', ARRAY['object:read']::text[])`
        ),
      "23505"
    );
  });

  it("makes 0002's own `ON CONFLICT DO NOTHING` seed fire instead of duplicating", async () => {
    // The actual defect, reproduced at its source: before 0097 this statement had no arbiter
    // index to conflict against, so it inserted a second 'Viewer' every time it ran. Now it is a
    // no-op — which is what the seed always claimed to be.
    const before = await admin.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM roles WHERE org_id IS NULL AND name = 'Viewer'`
    );
    await admin.query(
      `INSERT INTO roles (id, org_id, name, permissions)
       VALUES (gen_random_uuid(), NULL, 'Viewer', ARRAY['object:read']::text[])
       ON CONFLICT DO NOTHING`
    );
    const after = await admin.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM roles WHERE org_id IS NULL AND name = 'Viewer'`
    );
    expect(before.rows[0]!.n).toBe("1");
    expect(after.rows[0]!.n).toBe("1");
  });

  it("is PARTIAL — an org row may take a BUILT-IN's name at the DDL level", async () => {
    // The `WHERE org_id IS NULL` half. If someone "simplifies" the index to a plain UNIQUE(name),
    // this test is what tells them they just made every org's custom-role namespace global.
    //
    // NARROWED BY drizzle/0103, DELIBERATELY. This case used to insert TWO org rows named 'Viewer'
    // and assert a count of 2 — which the new `roles_org_name_key` (`UNIQUE (org_id, name) WHERE
    // org_id IS NOT NULL`) now refuses, because two roles sharing a name inside one org make the
    // catalogue unreadable: both bind, both render identically in GET /roles, and a revoke names
    // one of them. The CLAIM this case exists to make is unchanged and is still measured here —
    // 0097's index does not constrain org rows, so an org row may take a built-in's name — it is
    // now demonstrated with ONE row, which is all the claim ever needed.
    //
    // Such a row is refused by the AUTHORING door (`assertRoleNameNotBuiltIn`) and unbindable at
    // the grant door (`builtInNameCollisionReason`). Those are doors, not DDL, which is exactly
    // why this DDL-level assertion is still worth making: it pins that the database permits what
    // the doors refuse, so nobody later "fixes" the index and silently changes two doors' meaning.
    await admin.query(
      `INSERT INTO roles (id, org_id, name, permissions)
       VALUES (gen_random_uuid(), $1, 'Viewer', ARRAY['object:read']::text[])`,
      [org.orgId]
    );
    const rows = await admin.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM roles WHERE org_id = $1 AND name = 'Viewer'`,
      [org.orgId]
    );
    expect(rows.rows[0]!.n).toBe("1");
    await admin.query(`DELETE FROM roles WHERE org_id = $1 AND name = 'Viewer'`, [org.orgId]);
  });

  it("drizzle/0103 — but the SAME org may not hold two roles of one name", async () => {
    // The other side of the narrowing above, asserted rather than left implied by the edit.
    await admin.query(
      `INSERT INTO roles (id, org_id, name, permissions)
       VALUES (gen_random_uuid(), $1, 'Duplicated', ARRAY['object:read']::text[])`,
      [org.orgId]
    );
    await expectSqlState(
      () =>
        admin.query(
          `INSERT INTO roles (id, org_id, name, permissions)
           VALUES (gen_random_uuid(), $1, 'Duplicated', ARRAY['object:write']::text[])`,
          [org.orgId]
        ),
      "23505"
    );
    await admin.query(`DELETE FROM roles WHERE org_id = $1 AND name = 'Duplicated'`, [org.orgId]);
  });

  // -----------------------------------------------------------------------------------------
  // (b) role_bindings_grant_key
  // -----------------------------------------------------------------------------------------

  it("refuses a DUPLICATE grant — the row that would survive a revoke of its twin", async () => {
    await expectSqlState(
      () =>
        admin.query(
          `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
           VALUES (gen_random_uuid(), $1, $2, $3, $2, 'allow')`,
          [org.orgId, viewerUser.objectId, viewerRoleId]
        ),
      "23505"
    );
  });

  it("does NOT conflate an allow with a deny at the same scope — `effect` is part of the key", async () => {
    // Deliberate: a deny is a distinct, meaningful grant (it overrides every allow —
    // resolve.ts:285), so the natural key has to admit both rows. If `effect` were dropped from
    // the key, this insert would 23505 and denies would become unexpressible for any subject that
    // already holds the same role at the same scope.
    const inserted = await admin.query(
      `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
       VALUES (gen_random_uuid(), $1, $2, $3, $2, 'deny')`,
      [org.orgId, viewerUser.objectId, viewerRoleId]
    );
    expect(inserted.rowCount).toBe(1);
    await admin.query(
      `DELETE FROM role_bindings WHERE org_id = $1 AND subject_id = $2 AND effect = 'deny'`,
      [org.orgId, viewerUser.objectId]
    );
  });

  // -----------------------------------------------------------------------------------------
  // (c) role_bindings_effect_check
  // -----------------------------------------------------------------------------------------

  it.each(["ALLOW", "Allow", "allowed", "DENY", "", " allow"])(
    "refuses effect=%p — a value authz/resolve.ts reads as neither allow nor deny",
    async (effect) => {
      await expectSqlState(
        () =>
          admin.query(
            `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
             VALUES (gen_random_uuid(), $1, $2, $3, $2, $4)`,
            [org.orgId, operatorUser.objectId, viewerRoleId, effect]
          ),
        "23514"
      );
    }
  );

  it("still accepts the two legal values", async () => {
    for (const effect of ["allow", "deny"]) {
      const res = await admin.query(
        `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
         VALUES (gen_random_uuid(), $1, $2, $3, $2, $4)`,
        [org.orgId, operatorUser.objectId, viewerRoleId, effect]
      );
      expect(res.rowCount).toBe(1);
    }
    await admin.query(
      `DELETE FROM role_bindings WHERE org_id = $1 AND subject_id = $2 AND role_id = $3`,
      [org.orgId, operatorUser.objectId, viewerRoleId]
    );
  });

  it("refuses an UPDATE into an illegal effect, not just an INSERT", async () => {
    await expectSqlState(
      () =>
        admin.query(
          `UPDATE role_bindings SET effect = 'ALLOW' WHERE org_id = $1 AND subject_id = $2`,
          [org.orgId, viewerUser.objectId]
        ),
      "23514"
    );
  });

  // -----------------------------------------------------------------------------------------
  // (d) GRANT DELETE ON role_bindings TO scp_app
  // -----------------------------------------------------------------------------------------

  describe("scp_app's DELETE grant", () => {
    let raw: RawScpAppClient;

    beforeAll(async () => {
      raw = await RawScpAppClient.connect();
    });

    afterAll(async () => {
      await raw?.close();
    });

    it("lets the least-privileged app role DELETE a role_binding in its own org", async () => {
      // Proven as the identity production actually runs as. Before 0097 this raised 42501
      // (permission denied) — AFTER the route had already authorized the caller, which is the
      // shape a revoke verb would have shipped with.
      const doomed = await admin.query<{ id: string }>(
        `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
         VALUES (gen_random_uuid(), $1, $2, $3, $2, 'deny') RETURNING id`,
        [org.orgId, operatorUser.objectId, operatorRoleId]
      );
      const doomedId = doomed.rows[0]!.id;

      await raw.setOrgContext(org.orgId);
      const deleted = await raw.query(`DELETE FROM role_bindings WHERE id = $1`, [doomedId]);
      expect(deleted.rowCount).toBe(1);
    });

    it("and RLS still confines that DELETE to the session's own org", async () => {
      // The grant is a grant, not a hole. `role_bindings` is FORCE ROW LEVEL SECURITY with an
      // `org_id = current_org` USING clause (0002:85-90), which governs DELETE as well as SELECT.
      const survivor = await admin.query<{ id: string }>(
        `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
         VALUES (gen_random_uuid(), $1, $2, $3, $2, 'deny') RETURNING id`,
        [org.orgId, operatorUser.objectId, operatorRoleId]
      );
      const survivorId = survivor.rows[0]!.id;

      const otherOrg = await createTestOrg(server, "rbac-ddl-other");
      await raw.setOrgContext(otherOrg.orgId);
      const deleted = await raw.query(`DELETE FROM role_bindings WHERE id = $1`, [survivorId]);
      expect(deleted.rowCount).toBe(0);

      const still = await admin.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM role_bindings WHERE id = $1`,
        [survivorId]
      );
      expect(still.rows[0]!.n).toBe("1");
      await admin.query(`DELETE FROM role_bindings WHERE id = $1`, [survivorId]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (e) roles.bindable_at
  // -----------------------------------------------------------------------------------------

  it("adds `roles.bindable_at` as a NULLABLE text[], NULL on every pre-existing built-in", async () => {
    const col = await admin.query<{ data_type: string; is_nullable: string; udt_name: string }>(
      `SELECT data_type, is_nullable, udt_name
       FROM information_schema.columns
       WHERE table_name = 'roles' AND column_name = 'bindable_at'`
    );
    expect(col.rows[0]).toMatchObject({
      data_type: "ARRAY",
      is_nullable: "YES",
      udt_name: "_text"
    });

    // NULL = "any scope", ON THE FIVE LADDER ROWS. Backfilling any non-NULL value for them would
    // retroactively make live bindings illegal the day the write door starts enforcing it:
    // Viewer/Operator/Approver/Administrator/Owner are bound at org roots, services and components
    // across deployments, and 0097 has no way to know which.
    //
    // SCOPED TO THE LADDER BY NAME, not to "every built-in", because drizzle/0099 seeds five
    // PURPOSE roles that DO carry a `bindable_at` (role-model.md §3) — they have no bindings in the
    // field to invalidate, since there is no write door yet. Their exact arrays are asserted in
    // `routes/rbac-permission-splits.integration.test.ts`; what belongs here is the 0097 property
    // that the pre-existing rows were left alone.
    const filled = await admin.query<{ name: string }>(
      `SELECT name FROM roles
       WHERE org_id IS NULL AND bindable_at IS NOT NULL
         AND name IN ('Viewer', 'Operator', 'Approver', 'Administrator', 'Owner')
       ORDER BY name`
    );
    expect(filled.rows.map((r) => r.name)).toEqual([]);
  });

  // -----------------------------------------------------------------------------------------
  // schema.ts <-> DDL agreement.
  //
  // Drizzle does not enforce constraints at runtime and these tables' DDL is hand-authored (not
  // `drizzle-kit generate`d), so a `unique(...)`/`check(...)` declaration in schema.ts is, on its
  // own, a comment that TypeScript happens to compile. That is precisely the "built and tested but
  // wired nowhere" shape: the schema.ts edit in this increment would pass every other check in the
  // repo even if the migration had never been written. These assertions read BOTH sides.
  //
  // `db/schema-ddl-drift.integration.test.ts` now carries the general form of this — every index in
  // the migrated database must have a named declaration in schema.ts, and vice versa. It was
  // written because this block's own observation ("nothing else in this repo checks it") turned
  // out to be load-bearing: seven indexes, four of them race-closing partial uniques on
  // `objects`/`relationships`, had been missing from schema.ts for up to four milestones. What
  // stays here is the SHAPE of 0097's own constraints, which a name-level gate cannot see.
  // -----------------------------------------------------------------------------------------

  describe("schema.ts agrees with the DDL", () => {
    it("declares the same partial unique index on `roles` that the database actually has", async () => {
      // Located BY NAME, not by asserting the whole index array. `roles` has since acquired
      // `roles_org_name_key` (drizzle/0103) and `roles_managed_stack` (drizzle/0108), and an
      // exact-array assertion here would make every later index on this table look like a
      // regression in 0097's test. That completeness question — no index in the database missing
      // from schema.ts, and none declared that the database lacks — is `schema-ddl-drift`'s job
      // now, generically, for every table. What belongs HERE is 0097's own index's SHAPE.
      const declared = getTableConfig(roles)
        .indexes.filter((i) => i.config.name === "roles_builtin_name_key")
        .map((i) => ({
          name: i.config.name,
          unique: i.config.unique,
          partial: i.config.where !== undefined
        }));
      expect(declared).toEqual([{ name: "roles_builtin_name_key", unique: true, partial: true }]);

      const live = await admin.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'roles' AND indexname = 'roles_builtin_name_key'`
      );
      expect(live.rows[0]!.indexdef).toContain("CREATE UNIQUE INDEX");
      // The partiality is the half a reader is most likely to drop; assert the predicate itself,
      // not merely that SOME predicate exists.
      expect(live.rows[0]!.indexdef).toContain("WHERE (org_id IS NULL)");
    });

    it("declares the same unique key columns on `role_bindings`, IN THE SAME ORDER", async () => {
      const declared = getTableConfig(roleBindings).uniqueConstraints.map((u) => ({
        name: u.name,
        columns: u.columns.map((c) => c.name)
      }));
      const live = await admin.query<{ attname: string }>(
        `SELECT a.attname
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE c.conname = 'role_bindings_grant_key' AND c.contype = 'u'
         ORDER BY k.ord`
      );
      expect(declared).toEqual([
        {
          name: "role_bindings_grant_key",
          columns: ["org_id", "subject_id", "role_id", "scope_object_id", "effect"]
        }
      ]);
      expect(live.rows.map((r) => r.attname)).toEqual(declared[0]!.columns);
    });

    it("declares the same CHECK on `role_bindings.effect` that the database enforces", async () => {
      expect(getTableConfig(roleBindings).checks.map((c) => c.name)).toEqual([
        "role_bindings_effect_check"
      ]);
      const live = await admin.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'role_bindings_effect_check' AND contype = 'c'`
      );
      expect(live.rows).toHaveLength(1);
      expect(live.rows[0]!.def).toContain("'allow'");
      expect(live.rows[0]!.def).toContain("'deny'");
    });

    it("declares exactly the columns `roles` actually has", async () => {
      // Catches the drift in BOTH directions: a schema.ts column with no DDL behind it makes
      // every `db.query.roles` read fail with 42703 at runtime (drizzle names each column in its
      // SELECT list), and a DDL column absent from schema.ts is invisible to the application.
      const declared = getTableConfig(roles)
        .columns.map((c) => c.name)
        .sort();
      const live = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'roles'`
      );
      expect(declared).toEqual(live.rows.map((r) => r.column_name).sort());
      expect(declared).toContain("bindable_at");
    });
  });

  // -----------------------------------------------------------------------------------------
  // The cleanup path — the part that has never run on dirty data anywhere else.
  // -----------------------------------------------------------------------------------------

  describe("cleanup path: the migration re-run against a hand-built DIRTY database", () => {
    it("collapses duplicate built-ins lowest-id-wins, repoints their bindings, collapses the duplicate bindings that repoint MANUFACTURES, and deletes inert-effect rows", async () => {
      const migrationSql = readMigrationUnderTest();

      // A built-in duplicate whose id sorts BELOW the seeded row's random v4 id, so the assertion
      // proves the documented "lowest id wins" rule actually decided the outcome — rather than
      // "whatever was already there survived", which would pass even if the rule were reversed.
      const dupViewerRoleId = `${UUID_ZERO_PREFIX}01`;
      expect(dupViewerRoleId < viewerRoleId).toBe(true);

      // Bindings are seeded with explicit all-zero-prefix ids for the same reason: every id this
      // codebase writes is a uuidv7, which sorts ABOVE these, so which row the cleanup keeps is
      // predetermined and asserted, not observed.
      const manufacturedDupId = `${UUID_ZERO_PREFIX}b2`;
      const dupKeepId = `${UUID_ZERO_PREFIX}c1`;
      const dupLoseId = `${UUID_ZERO_PREFIX}c2`;
      const inertEffectId = `${UUID_ZERO_PREFIX}d1`;

      await admin.query("BEGIN");
      try {
        // Undo 0097's constraints so the dirty state is even expressible — i.e. put the database
        // back into exactly the pre-0097 shape a real upgrade would find it in.
        await admin.query(`DROP INDEX "roles_builtin_name_key"`);
        await admin.query(`ALTER TABLE role_bindings DROP CONSTRAINT "role_bindings_grant_key"`);
        await admin.query(`ALTER TABLE role_bindings DROP CONSTRAINT "role_bindings_effect_check"`);

        // 1. A duplicate built-in 'Viewer' — the row the never-firing ON CONFLICT produces.
        await admin.query(
          `INSERT INTO roles (id, org_id, name, permissions)
           SELECT $1, NULL, 'Viewer', permissions FROM roles WHERE id = $2`,
          [dupViewerRoleId, viewerRoleId]
        );

        // 2. viewerUser is ALREADY bound to the seeded (losing) Viewer row via createTestUser.
        //    Binding it to the duplicate as well is what makes the repoint in §1 of the migration
        //    manufacture a collision that §2 then has to clean up — the reason the two cleanups
        //    are ordered the way they are.
        const preexisting = await admin.query<{ id: string }>(
          `SELECT id FROM role_bindings
           WHERE org_id = $1 AND subject_id = $2 AND role_id = $3 AND scope_object_id = $2`,
          [org.orgId, viewerUser.objectId, viewerRoleId]
        );
        expect(preexisting.rowCount).toBe(1);
        const repointedAwayId = preexisting.rows[0]!.id;
        expect(manufacturedDupId < repointedAwayId).toBe(true);

        await admin.query(
          `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
           VALUES ($1, $2, $3, $4, $3, 'allow')`,
          [manufacturedDupId, org.orgId, viewerUser.objectId, dupViewerRoleId]
        );

        // 3. A plain duplicate grant, unrelated to the role collapse. operatorUser already holds
        //    this exact grant from createTestUser, so this makes the group THREE rows deep — and
        //    the surviving row must still be the lowest id of all three, not merely the older of
        //    the two added here.
        await admin.query(
          `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
           VALUES ($1, $3, $4, $5, $4, 'allow'), ($2, $3, $4, $5, $4, 'allow')`,
          [dupKeepId, dupLoseId, org.orgId, operatorUser.objectId, operatorRoleId]
        );
        const tripled = await admin.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM role_bindings
           WHERE org_id = $1 AND subject_id = $2 AND role_id = $3 AND effect = 'allow'`,
          [org.orgId, operatorUser.objectId, operatorRoleId]
        );
        expect(tripled.rows[0]!.n).toBe("3");

        // 4. An inert-effect row: grants nothing, denies nothing, reads as authority.
        await admin.query(
          `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
           VALUES ($1, $2, $3, $4, $3, 'ALLOW')`,
          [inertEffectId, org.orgId, operatorUser.objectId, operatorRoleId]
        );

        // --- run the committed migration text itself, cleanup and constraints together ---
        await admin.query(migrationSql);

        // (1) one 'Viewer' left, and it is the LOWEST id — the loser was the pre-existing row.
        const viewers = await admin.query<{ id: string }>(
          `SELECT id FROM roles WHERE org_id IS NULL AND name = 'Viewer'`
        );
        expect(viewers.rows.map((r) => r.id)).toEqual([dupViewerRoleId]);

        // (2) the repoint happened — no binding anywhere still references the deleted role, which
        //     is also the only reason the DELETE in §1 did not raise 23503 against the FK.
        const orphaned = await admin.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM role_bindings WHERE role_id = $1`,
          [viewerRoleId]
        );
        expect(orphaned.rows[0]!.n).toBe("0");

        // (3) the repoint's manufactured collision was collapsed, lowest id winning.
        const collapsed = await admin.query<{ id: string }>(
          `SELECT id FROM role_bindings
           WHERE org_id = $1 AND subject_id = $2 AND role_id = $3 AND scope_object_id = $2
             AND effect = 'allow'`,
          [org.orgId, viewerUser.objectId, dupViewerRoleId]
        );
        expect(collapsed.rows.map((r) => r.id)).toEqual([manufacturedDupId]);
        expect(collapsed.rows.map((r) => r.id)).not.toContain(repointedAwayId);

        // (4) the plain duplicate pair collapsed to its lowest id.
        const plain = await admin.query<{ id: string }>(
          `SELECT id FROM role_bindings
           WHERE org_id = $1 AND subject_id = $2 AND role_id = $3 AND effect = 'allow'`,
          [org.orgId, operatorUser.objectId, operatorRoleId]
        );
        expect(plain.rows.map((r) => r.id)).toEqual([dupKeepId]);

        // (5) the inert row is gone — DELETED, never normalised. Normalising to 'allow' would
        //     have left a row here that GRANTS where nothing granted before: a migration widening
        //     authority with no audit event and nobody in the loop.
        const inert = await admin.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM role_bindings WHERE id = $1`,
          [inertEffectId]
        );
        expect(inert.rows[0]!.n).toBe("0");

        // (6) and the constraints the cleanup existed to make possible are actually in place —
        //     i.e. the migration ran to completion rather than stopping after the cleanup.
        const constraints = await admin.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint
           WHERE conname IN ('role_bindings_grant_key', 'role_bindings_effect_check')
           ORDER BY conname`
        );
        expect(constraints.rows.map((r) => r.conname)).toEqual([
          "role_bindings_effect_check",
          "role_bindings_grant_key"
        ]);
        const index = await admin.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE indexname = 'roles_builtin_name_key'`
        );
        expect(index.rowCount).toBe(1);
      } finally {
        await admin.query("ROLLBACK");
      }
    });

    // ---------------------------------------------------------------------------------------
    // §1a — the refusal. The case the "lowest id wins is provably harmless" argument missed.
    // ---------------------------------------------------------------------------------------

    /** `roles.permissions` for `Owner` EXACTLY as 0002:220-222 writes it — the literal a re-run of
     *  that seed puts on disk today, copied here so this fixture is the real producer and not a
     *  stylised one.
     *
     *  IT STILL INCLUDES `org:admin`, WHICH THE LIVE ROW NO LONGER CARRIES. drizzle/0099 deleted
     *  that permission with `array_remove` and deliberately LEFT 0002's literal alone: a shipped
     *  migration is a record of what the database was asked to do at that version, and editing one
     *  makes the file on disk disagree with the hash `__drizzle_migrations` recorded on every
     *  deployment that already ran it. So a re-executed 0002 seed really does still write this,
     *  and the divergence it manufactures is now BIDIRECTIONAL — the stale row is no longer a
     *  strict subset of the live one, which the assertions below measure rather than assume. */
    const OWNER_PERMISSIONS_AS_SEEDED_BY_0002 = [
      "object:read",
      "relationship:read",
      "type_registry:read",
      "graph:query",
      "audit:read",
      "object:write",
      "relationship:write",
      "approval:write",
      "type_registry:write",
      "role_binding:write",
      "org:admin"
    ];

    it("ABORTS instead of collapsing built-ins whose permissions have DIVERGED, naming the ids and the delta", async () => {
      const migrationSql = readMigrationUnderTest();

      // The duplicate takes an all-zero-prefix id so it is the LOWEST — i.e. the half of the coin
      // flip where lowest-id-wins would keep the STALE row. 0002 seeds with `gen_random_uuid()`
      // (a random v4, not a time-ordered v7), so on a real estate this is a coin flip, not an
      // edge case: whichever way it lands, one of the two Owners is deleted and every Owner
      // binding in the org is repointed at the other.
      const staleOwnerId = `${UUID_ZERO_PREFIX}e1`;
      // Captured INSIDE the transaction and asserted after the rollback, so the "nothing was left
      // behind" check compares against the row that was actually there rather than against an
      // arithmetic restatement of every grant migration to date.
      let liveOwnerPermissionCount = -1;

      await admin.query("BEGIN");
      try {
        await admin.query(`DROP INDEX "roles_builtin_name_key"`);

        const live = await admin.query<{ id: string; permissions: string[] }>(
          `SELECT id, permissions FROM roles WHERE org_id IS NULL AND name = 'Owner'`
        );
        expect(live.rowCount).toBe(1);
        const liveOwner = live.rows[0]!;
        expect(staleOwnerId < liveOwner.id).toBe(true);

        // Re-run 0002's seed row for Owner. Its permission literal is FROZEN at M1; the six
        // migrations that later edited Owner by name (0010/0012/0083/0088/0094 append,
        // 0099 appends three and removes one) are already in `__drizzle_migrations` and do not
        // re-run over the new row. So the duplicate is born behind — which is exactly why "every
        // grant migration updates all duplicates identically" does not imply "duplicates are
        // identical".
        await admin.query(
          `INSERT INTO roles (id, org_id, name, permissions) VALUES ($1, NULL, 'Owner', $2::text[])`,
          [staleOwnerId, OWNER_PERMISSIONS_AS_SEEDED_BY_0002]
        );
        liveOwnerPermissionCount = liveOwner.permissions.length;

        // The delta, MEASURED rather than asserted from a comment. If a future migration edits
        // Owner again, this recomputes and the message assertions below follow it.
        const dropped = liveOwner.permissions
          .filter((p) => !OWNER_PERMISSIONS_AS_SEEDED_BY_0002.includes(p))
          .sort();
        expect(dropped).toEqual([
          "campaign:deadline-override",
          "change:accept",
          "change:emergency",
          "federation:pair",
          "federation:read",
          "federation:write",
          "freeze:override",
          "freeze:write",
          "governance:move",
          "policy:write",
          "scan:override",
          "secret:write"
        ]);
        // AND THE OTHER DIRECTION IS NO LONGER EMPTY. Until drizzle/0099 the stale row was a strict
        // SUBSET of the live one, and the case still refused because repointing bindings the other
        // way would WIDEN. 0099 REMOVED `org:admin` from the live Owner (it gated nothing at any
        // call site) while deliberately leaving 0002's frozen literal alone — so a re-executed seed
        // now manufactures a duplicate that is behind in twelve permissions AND ahead in one dead
        // one. Both directions in one fixture, which is what §1a's predicate is written for.
        const gained = OWNER_PERMISSIONS_AS_SEEDED_BY_0002.filter(
          (p) => !liveOwner.permissions.includes(p)
        ).sort();
        expect(gained).toEqual(["org:admin"]);

        let caught: (Error & { code?: string; detail?: string; hint?: string }) | undefined;
        try {
          await admin.query(migrationSql);
        } catch (err) {
          caught = err as Error & { code?: string; detail?: string; hint?: string };
        }
        if (caught === undefined) {
          throw new Error(
            "0097 SUCCEEDED against two Owner rows with different permissions — it silently picked one"
          );
        }
        // P0001 = a PL/pgSQL `RAISE EXCEPTION` with no explicit ERRCODE. Asserted as a code, not by
        // matching prose, so rewording the message cannot turn this green by accident.
        expect(caught.code).toBe("P0001");
        expect(caught.message).toContain("DIVERGED");

        // The DETAIL is the whole point of choosing abort over a warning: it has to be enough to
        // resolve the estate by hand, so it names BOTH ids, the direction, and every permission.
        const detail = caught.detail ?? "";
        expect(detail).toContain(liveOwner.id);
        expect(detail).toContain(staleOwnerId);
        expect(detail).toContain(`LOSING ${dropped.length} permission(s)`);
        expect(detail).toContain(`GAINING ${gained.length} [${gained.join(", ")}]`);
        for (const permission of dropped) expect(detail).toContain(permission);
        expect(caught.hint ?? "").toContain("re-run the upgrade");
      } finally {
        await admin.query("ROLLBACK");
      }

      // And the abort left NOTHING behind. drizzle runs the pending set in one transaction, so a
      // real upgrade rolls back to the pre-0097 database — the claim 0097's HINT makes to the
      // operator, checked rather than asserted.
      const after = await admin.query<{ id: string; n: string }>(
        `SELECT id, cardinality(permissions)::text AS n
         FROM roles WHERE org_id IS NULL AND name = 'Owner'`
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]!.id).not.toBe(staleOwnerId);
      expect(liveOwnerPermissionCount).toBeGreaterThan(0);
      expect(Number(after.rows[0]!.n)).toBe(liveOwnerPermissionCount);
    });

    it("does NOT abort when the duplicates agree — order and repeats are not divergence", async () => {
      // The other side of the predicate, and the reason it compares SETS. `hasPermission` reads
      // `<permission> = ANY(rl.permissions)` (authz/resolve.ts), which is blind to element order
      // and to repeats — so two rows differing only that way carry identical authority, and
      // stopping an upgrade over them would be a false alarm an operator cannot act on. A
      // straight `permissions = permissions` comparison would fire here; this is what says it
      // must not. (The byte-identical case is covered by the dirty-fixture test above, which
      // copies `permissions` from the survivor.)
      const twinOwnerId = `${UUID_ZERO_PREFIX}e2`;
      const migrationSql = readMigrationUnderTest();

      await admin.query("BEGIN");
      try {
        await admin.query(`DROP INDEX "roles_builtin_name_key"`);
        const live = await admin.query<{ id: string }>(
          `SELECT id FROM roles WHERE org_id IS NULL AND name = 'Owner'`
        );
        expect(twinOwnerId < live.rows[0]!.id).toBe(true);
        // Same SET, reversed order, with one element repeated.
        await admin.query(
          `INSERT INTO roles (id, org_id, name, permissions)
           SELECT $1, NULL, 'Owner',
                  (SELECT array_agg(p ORDER BY p DESC) FROM unnest(permissions) AS p) || permissions[1:1]
           FROM roles WHERE org_id IS NULL AND name = 'Owner'`,
          [twinOwnerId]
        );

        await admin.query(migrationSql);

        // Collapsed, not refused — and the lowest id won, as documented.
        const owners = await admin.query<{ id: string }>(
          `SELECT id FROM roles WHERE org_id IS NULL AND name = 'Owner'`
        );
        expect(owners.rows.map((r) => r.id)).toEqual([twinOwnerId]);
      } finally {
        await admin.query("ROLLBACK");
      }
    });

    it("is a NO-OP on a clean database — re-running the migration changes no row and still succeeds", async () => {
      // The other half of "safe to run on a populated database": every cleanup is bounded by a
      // `HAVING COUNT(*) > 1` or an explicit not-a-legal-value predicate, so on a clean estate it
      // must touch nothing. If a future edit drops one of those bounds, this is what catches it —
      // a cleanup that deletes on a CLEAN database is a data-loss bug that the dirty-fixture test
      // above would happily pass.
      const migrationSql = readMigrationUnderTest();

      const snapshot = async () => ({
        roles: (await admin.query<{ id: string }>(`SELECT id FROM roles ORDER BY id`)).rows.map(
          (r) => r.id
        ),
        bindings: (
          await admin.query<{ id: string }>(`SELECT id FROM role_bindings ORDER BY id`)
        ).rows.map((r) => r.id)
      });

      const before = await snapshot();
      await admin.query(migrationSql);
      const after = await snapshot();

      expect(after).toEqual(before);
      expect(before.roles.length).toBeGreaterThan(0);
      expect(before.bindings.length).toBeGreaterThan(0);
    });
  });
});
