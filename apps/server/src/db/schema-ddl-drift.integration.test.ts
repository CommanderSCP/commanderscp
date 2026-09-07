import pg from "pg";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { testDatabaseUrl } from "../test-support/harness.js";

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
