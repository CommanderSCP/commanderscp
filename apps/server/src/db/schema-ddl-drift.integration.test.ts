import pg from "pg";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { testDatabaseUrl } from "../test-support/harness.js";

/**
 * THE INDEX DRIFT GATE — `src/db/schema.ts` against the database the migrations actually build.
 *
 * `apps/server/drizzle/*.sql` is hand-authored; `drizzle-kit generate` has not produced a migration
 * here since the M1/M2 era. So schema.ts is a DESCRIPTION of the database that, until this file,
 * nothing forced to be true. Drizzle enforces no constraint at runtime, which makes an undeclared
 * index invisible in the worst way: every test passes, every query works, and the omission surfaces
 * only when somebody reads schema.ts to decide whether an invariant is enforced. That reading is
 * exactly what the four race-closing partial unique indexes on `objects`/`relationships`
 * (drizzle/0022, 0049, 0051, 0095) exist to answer — and all four were absent from schema.ts for
 * between one and four milestones, alongside `roles_org_name_key`,
 * `config_source_sync_queue_pending_identity` and `instance_operator_credentials_token_id_key`.
 *
 * BOTH DIRECTIONS, because the two failures are different bugs. An index in the database and not in
 * schema.ts is an invariant a reader will not know is enforced. An index in schema.ts and not in the
 * database is the opposite and worse: a guarantee the code may already be leaning on, which no
 * deployment has.
 *
 * BY NAME, deliberately. Comparing columns or predicates would need this test to re-implement
 * Drizzle's SQL emitter, and a mismatch there would be a test bug reported as drift. The name is the
 * one thing both sides state literally — and it is also the half Drizzle's `.unique()` column sugar
 * gets wrong in this repo: the sugar names its constraint `<table>_<column>_unique` while the
 * hand-authored migrations write `<table>_<column>_key`, so a bare `.unique()` beside a hand-written
 * `..._key` index reads as declared and is not. `instance_freezes` and `federation_self` both had
 * that shape. Per-index SHAPE (partiality, column order) is asserted where it is load-bearing, next
 * to the invariant it protects — see `rbac-ddl-preconditions.integration.test.ts`.
 *
 * MUTATION-PROVEN 2026-08-31: removing `uniqueIndex("roles_org_name_key")` from schema.ts turns the
 * first case red naming `roles_org_name_key (roles)`; a declaration for an index no migration
 * creates turns the second case red naming it. Neither mutation moves any other test in the suite.
 *
 * NOT COVERED HERE: CHECK constraints, grants and RLS policies. Those have no schema.ts counterpart
 * to compare against for most tables (Drizzle models only the first, and only where someone wrote a
 * `check(...)`), so a gate over them would assert the absence of something schema.ts never claimed.
 * Indexes are the class where schema.ts does make a complete claim.
 */

/** Lives in `public` but belongs to tooling, not to schema.ts. */
const NON_SCHEMA_TABLES = new Set(["__drizzle_migrations"]);

/** Every index name schema.ts declares, by any of the three routes Drizzle offers. */
function declaredIndexNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    for (const index of config.indexes) {
      if (index.config.name) names.add(index.config.name);
    }
    for (const constraint of config.uniqueConstraints) {
      if (constraint.name) names.add(constraint.name);
    }
    for (const column of config.columns) {
      // `.unique()` sugar, whose backing index takes the constraint's name.
      const uniqueName = column.uniqueName;
      if (column.isUnique && uniqueName) names.add(uniqueName);
    }
  }
  return names;
}

/**
 * Non-primary indexes of the migrated database. Primary keys are excluded because Postgres names
 * them (`<table>_pkey`) and Drizzle's `primaryKey()` does not, so they could only ever mismatch.
 */
async function liveIndexes(admin: pg.Client): Promise<{ indexname: string; tablename: string }[]> {
  const result = await admin.query<{ indexname: string; tablename: string }>(
    `SELECT i.relname AS indexname, t.relname AS tablename
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND NOT x.indisprimary
      ORDER BY t.relname, i.relname`
  );
  return result.rows;
}

describe("schema.ts and the migrated DDL declare the same indexes", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("declares every index the database holds", async () => {
    const live = await liveIndexes(admin);
    // A fully-migrated database holds well over a hundred; an empty or tiny result would mean this
    // test is reading an unmigrated database and asserting nothing.
    expect(live.length).toBeGreaterThan(50);

    const declared = declaredIndexNames();
    const undeclared = live
      .filter((r) => !NON_SCHEMA_TABLES.has(r.tablename) && !declared.has(r.indexname))
      .map((r) => `${r.indexname} (${r.tablename})`);
    expect(undeclared).toEqual([]);
  });

  it("declares no index the database does not have", async () => {
    const live = await liveIndexes(admin);
    const liveNames = new Set(live.map((r) => r.indexname));
    const phantom = [...declaredIndexNames()].filter((n) => !liveNames.has(n)).sort();
    expect(phantom).toEqual([]);
  });
});
