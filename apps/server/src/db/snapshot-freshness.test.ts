import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

/** DRIZZLE-KIT'S SNAPSHOT STATE, against schema.ts. See docs/db.md §155. */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

// Renders a `check()`'s `sql` value the same way drizzle-kit does when it writes a snapshot, so
// the two sides of the comparison below are directly comparable text.
const dialect = new PgDialect();

type Snapshot = {
  tables: Record<
    string,
    {
      columns: Record<string, unknown>;
      indexes: Record<string, unknown>;
      uniqueConstraints: Record<string, unknown>;
      checkConstraints: Record<string, { name: string; value: string }>;
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

  // GAP CLOSED (team-pipeline-iac increment 0): this file's three cases above never looked at
  // `check()` at all. `pipeline_evidence_source_check` drifted for a whole migration (0107 widened
  // the live constraint by hand; nothing here — or in schema-ddl-drift.integration.test.ts, which
  // is scoped to indexes only — would have caught schema.ts and the snapshot quietly agreeing on a
  // stale three-value list). This closes the schema.ts-vs-snapshot half; the
  // schema.ts-vs-migrated-database half is `schema-ddl-drift.integration.test.ts`.
  it("declares the same check constraints, with the same expression, as the snapshot", () => {
    const mismatches: string[] = [];
    for (const [key, config] of tables) {
      const known = snapshot.tables[key]?.checkConstraints ?? {};
      for (const check of config.checks) {
        if (!check.name) continue;
        const declaredValue = dialect.sqlToQuery(check.value).sql;
        const snapshotValue = known[check.name]?.value;
        if (snapshotValue === undefined) {
          mismatches.push(
            `${config.name}.${check.name}: declared in schema.ts, absent from the snapshot`
          );
        } else if (snapshotValue !== declaredValue) {
          mismatches.push(
            `${config.name}.${check.name}: schema.ts says [${declaredValue}], snapshot says [${snapshotValue}]`
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
