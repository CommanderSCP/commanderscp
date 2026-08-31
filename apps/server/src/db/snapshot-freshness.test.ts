import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

/**
 * DRIZZLE-KIT'S SNAPSHOT STATE, against schema.ts.
 *
 * `drizzle-kit generate` does not read the database and does not read the `.sql` files. It diffs
 * schema.ts against the newest `drizzle/meta/*_snapshot.json` — so that snapshot IS the tool's
 * entire model of what already exists, and a stale one makes `db:generate` (BUILD_AND_TEST.md §3.2,
 * the documented workflow after any schema edit) emit a migration that recreates everything it has
 * forgotten.
 *
 * It had been stale since the M1/M2 era: `0000_snapshot.json` described 4 tables while the journal
 * carried 110 entries and schema.ts declared 71, and `db:generate` did not merely emit a bad
 * migration — it aborted on an interactive rename prompt for columns it thought were new. The
 * workflow every schema change is supposed to use had not worked in ~107 migrations.
 *
 * This is the gate that keeps it working. A pure comparison of two files, no database and no
 * subprocess, so it runs in the unit suite where the workflow it protects is used.
 *
 * SCOPED TO NAMES — tables, columns, indexes, unique constraints. Types and defaults are what
 * `db:generate` itself decides, and re-deriving them here would be re-implementing the tool. The
 * name level is where staleness actually shows: a new table, column or index that schema.ts
 * declares and the snapshot has never heard of is exactly what makes the next generate wrong.
 *
 * TABLES THE MIGRATIONS CREATE AND schema.ts DOES NOT MODEL are deliberately outside this test's
 * reach — it compares schema.ts to the snapshot, and both are silent about them. Measured
 * 2026-08-31 against a fully-migrated database: `scanner_assignments`,
 * `scan_db_staleness_policy` and `dependency_subscription_unlock` (instance-scoped singletons
 * addressed by raw SQL) plus the dead `objects_m0_deprecated`. They hold no indexes, so
 * `schema-ddl-drift.integration.test.ts` does not see them either. Naming them here so the next
 * reader does not rediscover them as a surprise.
 *
 * MUTATION-PROVEN 2026-08-31: adding a column to schema.ts without re-running `db:generate` turns
 * this red naming `config_source_sync_queue.probe_column`; running `db:generate` (which emits the
 * one-line `ALTER TABLE ... ADD COLUMN` and writes the next snapshot) turns it green again.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

type Snapshot = {
  tables: Record<
    string,
    {
      columns: Record<string, unknown>;
      indexes: Record<string, unknown>;
      uniqueConstraints: Record<string, unknown>;
    }
  >;
};

/** The one drizzle-kit itself would diff against: highest numeric prefix in `meta/`. */
function newestSnapshot(): Snapshot {
  const files = readdirSync(path.join(drizzleDir, "meta"))
    .filter((f) => f.endsWith("_snapshot.json"))
    .sort();
  const newest = files[files.length - 1];
  expect(newest).toBeDefined();
  return JSON.parse(readFileSync(path.join(drizzleDir, "meta", newest!), "utf8")) as Snapshot;
}

function schemaTables(): Map<string, ReturnType<typeof getTableConfig>> {
  const out = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    out.set(`public.${config.name}`, config);
  }
  return out;
}

describe("drizzle-kit snapshot state is current with schema.ts", () => {
  const snapshot = newestSnapshot();
  const tables = schemaTables();

  it("is not the M1-era stub — a 4-table snapshot would make every case below vacuous", () => {
    expect(Object.keys(snapshot.tables).length).toBeGreaterThan(50);
    expect(tables.size).toBeGreaterThan(50);
  });

  it("covers exactly the tables schema.ts declares", () => {
    expect(Object.keys(snapshot.tables).sort()).toEqual([...tables.keys()].sort());
  });

  it("covers every column schema.ts declares", () => {
    const missing: string[] = [];
    for (const [key, config] of tables) {
      const snapshotColumns = new Set(Object.keys(snapshot.tables[key]?.columns ?? {}));
      for (const column of config.columns) {
        if (!snapshotColumns.has(column.name)) missing.push(`${config.name}.${column.name}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it("covers every index and unique constraint schema.ts declares", () => {
    const missing: string[] = [];
    for (const [key, config] of tables) {
      const entry = snapshot.tables[key];
      const known = new Set([
        ...Object.keys(entry?.indexes ?? {}),
        ...Object.keys(entry?.uniqueConstraints ?? {})
      ]);
      const declared = [
        ...config.indexes.map((i) => i.config.name),
        ...config.uniqueConstraints.map((u) => u.name),
        ...config.columns.filter((c) => c.isUnique).map((c) => c.uniqueName)
      ];
      for (const name of declared) {
        if (name && !known.has(name)) missing.push(`${config.name}.${name}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });
});
