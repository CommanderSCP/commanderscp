import pg from "pg";
import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { testDatabaseUrl } from "../test-support/harness.js";

// Renders a `check()`'s `sql` value to text, the same way drizzle-kit would when writing a
// snapshot. Postgres does NOT echo this text back — see `liveCheckConstraints` below.
const dialect = new PgDialect();

/** The single-quoted string literals in a CHECK expression, order-independent. Postgres rewrites
 *  `x IN ('a','b')` to `x = ANY (ARRAY['a'::text,'b'::text])` in `pg_get_constraintdef`, and casts
 *  vary by column type, so comparing rendered SQL text byte-for-byte between schema.ts and the live
 *  database is not meaningful — the literal SET is the part that must agree. */
function literalSet(expression: string): string[] {
  return [...expression.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
}

/** THE INDEX DRIFT GATE. See docs/db.md §37. */

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

/** Tables the migrations create that `schema.ts` does not model at all (docs/BUILD_AND_TEST.md
 *  §3.2: `scanner_assignments`, `scan_db_staleness_policy` and `dependency_subscription_unlock` are
 *  instance-scoped singletons addressed by raw SQL, plus the dead `objects_m0_deprecated`). A check
 *  constraint on one of these can never get a `check()` declaration — there is no `pgTable` call to
 *  hang it on — so the name-coverage gate below excludes them rather than failing forever. Only
 *  `scan_db_staleness_policy` (2) and `dependency_subscription_unlock` (1) actually carry any. */
const UNMODELLED_TABLES = new Set([
  "scanner_assignments",
  "scan_db_staleness_policy",
  "dependency_subscription_unlock",
  "objects_m0_deprecated"
]);

/** Every `check()` schema.ts declares, by name, rendered as drizzle-kit would render it. */
function declaredCheckConstraints(): Map<string, { tablename: string; literals: string[] }> {
  const out = new Map<string, { tablename: string; literals: string[] }>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    for (const check of config.checks) {
      if (!check.name) continue;
      out.set(check.name, {
        tablename: config.name,
        literals: literalSet(dialect.sqlToQuery(check.value).sql)
      });
    }
  }
  return out;
}

/** Every CHECK constraint (`contype = 'c'`) in the migrated database, by name. */
async function liveCheckConstraints(
  admin: pg.Client
): Promise<{ conname: string; tablename: string; def: string }[]> {
  const result = await admin.query<{ conname: string; tablename: string; def: string }>(
    `SELECT co.conname AS conname, t.relname AS tablename, pg_get_constraintdef(co.oid) AS def
       FROM pg_constraint co
       JOIN pg_class t ON t.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND co.contype = 'c'
      ORDER BY t.relname, co.conname`
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

// GAP CLOSED (db-check-constraint-coverage increment). This is the gate that would have caught
// `pipeline_evidence_source_check` drifting: migration 0107 widened the LIVE constraint by hand
// without updating schema.ts, and `snapshot-freshness.test.ts` could not see it either, because the
// drizzle-kit snapshot it compares against was reconciled from schema.ts at the same stale value —
// two things that agree with each other are not thereby correct. This test's ground truth is the
// migrated database itself, same as the index gate above.
//
// FULL NAME COVERAGE (was a SCOPE NOTE above; the backfill it deferred is now done). schema.ts used
// to write `check(...)` for only 5 of the 23 CHECK constraints the migrated database holds, so the
// "declares every one, by name" assertion (the shape of the two index tests above) failed on 18
// pre-existing constraints across 7 MODELED tables — `bundle_transfers`, `governance_move_rungs`,
// `instance_freezes` (x4, one of whose OWN doc comment in schema.ts said "(DB CHECK)" — the exact
// "comment names a hazard" case, never swept), `scan_exclusion_admissions` (x3),
// `scan_requirement_floors` (x3), `source_mappings` (x2), and `governance_move_instance_rung`. All
// 15 of those now have a `check()` (migration 0114 is a database no-op that only reconciles
// drizzle-kit's snapshot lineage, since the constraints themselves were created by their own
// original migrations). The remaining 3, on `scan_db_staleness_policy` and
// `dependency_subscription_unlock`, are on tables `docs/BUILD_AND_TEST.md` §3.2 documents as
// unmodeled entirely — see `UNMODELLED_TABLES` above — and are excluded from the name-coverage
// assertion for that reason, not left as a gap.
describe("schema.ts and the migrated DDL declare the same check constraints", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("declares every check constraint the database holds, by name", async () => {
    const live = await liveCheckConstraints(admin);
    // A fully-migrated database holds well over twenty; an empty or tiny result would mean this
    // test is reading an unmigrated database and asserting nothing (mirrors the index gate's guard).
    expect(live.length).toBeGreaterThan(15);

    const declared = declaredCheckConstraints();
    const undeclared = live
      .filter((r) => !UNMODELLED_TABLES.has(r.tablename) && !declared.has(r.conname))
      .map((r) => `${r.conname} (${r.tablename})`);
    expect(undeclared).toEqual([]);
  });

  it("declares the SAME allowed values as the migrated database, for every shared check constraint", async () => {
    // Comparing rendered SQL text would be wrong on its face: Postgres rewrites `IN (...)` to
    // `= ANY (ARRAY[...])` with per-value casts, so schema.ts's text and `pg_get_constraintdef`'s
    // text never match syntactically even when they mean the same thing. The literal SET is the
    // fact that must agree — and disagreeing here is exactly the shape of bug this test exists for:
    // a value present in one but not the other, discovered by neither side matching the mismatch.
    const live = await liveCheckConstraints(admin);
    const declared = declaredCheckConstraints();
    const mismatches: string[] = [];
    for (const row of live) {
      const decl = declared.get(row.conname);
      if (!decl) continue; // reported by the name-coverage test above
      const liveLiterals = literalSet(row.def);
      if (JSON.stringify(liveLiterals) !== JSON.stringify(decl.literals)) {
        mismatches.push(
          `${row.conname} (${row.tablename}): schema.ts allows [${decl.literals.join(",")}], ` +
            `the database allows [${liveLiterals.join(",")}]`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
