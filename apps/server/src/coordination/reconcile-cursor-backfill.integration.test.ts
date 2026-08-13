import path from "node:path";
import { tmpdir } from "node:os";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { testDatabaseUrl } from "../test-support/harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/** THIS migration's journal tag. If it is renumbered, the assertion below fails loudly rather than
 *  letting the suite quietly stop excluding it. */
const MIGRATION_TAG = "0058_reconcile_cursor";

/**
 * MIGRATION 0058's BACKFILL, which every other integration suite is blind to.
 *
 * Every suite in this repo migrates a FRESH database, where `changes` is empty when 0058 runs — so
 * its `UPDATE changes SET reconcile_cursor_at = updated_at` touches zero rows and the whole
 * backfill is exercised by nothing. The 354 coordination tests passing says only that the DDL is
 * valid. This suite is the one that runs the statement against rows that already exist, which is
 * the only state a real deploy is ever in.
 *
 * WHAT GOES WRONG WITHOUT IT is not a crash — it is a silent fairness failure that looks exactly
 * like normal operation. `ADD COLUMN ... NOT NULL DEFAULT now()` stamps every pre-existing row with
 * the deploy instant, so the entire live queue collapses into one tie broken by nothing. On the
 * homelab that means a change that had been waiting for its turn since 2026-07-19 becomes
 * indistinguishable from one proposed a second before the deploy, and `ORDER BY reconcile_cursor_at
 * ASC LIMIT 25` picks 25 of them by whatever order the planner feels like. The scheduler would not
 * error, log, or fail a health check; it would just quietly stop being fair, in a deploy whose whole
 * purpose was protecting fairness.
 *
 * Driven the same way as `federation-sync.integration.test.ts`'s 0038 test: migrate a scratch
 * database with a copy of the drizzle folder whose journal has THIS migration removed, write
 * `changes` rows against that older schema with deliberately spread-out `updated_at` values, then
 * run the REAL folder — which therefore applies exactly one migration — and read the new column.
 */
describe("migration 0058 — the round-robin cursor backfills from `updated_at` on an existing database", () => {
  it("seeds every pre-existing row's cursor from its `updated_at`, preserving the live queue ORDER", async () => {
    const dbName = `reconcile_cursor_backfill_${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");
    const adminUrl = new URL(testDatabaseUrl());
    const bootstrapPool = new pg.Pool({ connectionString: adminUrl.toString() });
    try {
      const client = await bootstrapPool.connect();
      try {
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`);
      } finally {
        client.release();
      }
    } finally {
      await bootstrapPool.end();
    }
    const scratchUrl = new URL(adminUrl.toString());
    scratchUrl.pathname = `/${dbName}`;

    // The schema as shipped BEFORE this migration. The SQL files are byte-identical copies, so
    // drizzle's applied-migration hashes carry over and the second `migrate` applies ONLY 0058.
    const tmpFolder = await mkdtemp(path.join(tmpdir(), "scp-drizzle-0055-"));
    await cp(migrationsFolder, tmpFolder, { recursive: true });
    const journalPath = path.join(tmpFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    // EVERYTHING STRICTLY BEFORE THIS MIGRATION — located BY TAG, never by a numeric cut-off.
    //
    // The tag lookup is the original design and stays: a renumber must not silently stop excluding
    // the migration under test, which would leave this file "verifying" a backfill it never ran.
    // Asserting the tag is present is what makes that safe.
    //
    // The `slice` replaced a `filter(tag !== MIGRATION_TAG)` that kept LATER migrations in the
    // scratch schema (M20.1, when 0059 landed). Drizzle's migrator applies by ascending `when` and
    // records the newest applied timestamp, so a scratch DB carrying 0059 has already moved its
    // watermark PAST 0058 — the upgrade step then applies nothing, the column never appears, and the
    // failure surfaces as `column "reconcile_cursor_at" does not exist` rather than as anything
    // resembling its cause. "Everything except this one" is also not a state any real database is
    // ever in; "everything before this one" is exactly the pre-upgrade state being modelled, and it
    // lets the upgrade apply this migration AND its successors in their real order.
    const targetIdx = journal.entries.findIndex((e) => e.tag === MIGRATION_TAG);
    expect(journal.entries.map((e) => e.tag)).toContain(MIGRATION_TAG);
    const truncated = journal.entries.slice(0, targetIdx);
    expect(truncated.map((e) => e.tag)).not.toContain(MIGRATION_TAG);
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: truncated }, null, 2));

    const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
    try {
      await migrate(drizzle(pool), { migrationsFolder: tmpFolder });

      // The column does not exist yet. That IS the pre-upgrade state, asserted rather than assumed —
      // if a future edit made this scratch DB already carry the column, every assertion below would
      // pass while testing nothing.
      const before = await pool.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'changes' AND column_name = 'reconcile_cursor_at'`
      );
      expect(before.rowCount).toBe(0);

      // A queue with a REAL spread: the head has been waiting 20 days (the homelab's actual shape —
      // its blocked head dated from 2026-07-19 while the deploy would have happened in August), the
      // tail arrived a minute ago. If the backfill were `now()`, these three collapse to one value.
      const orgId = randomUUID();
      const rows = [
        { id: randomUUID(), label: "head-20-days-stuck", ageMs: 20 * 24 * 60 * 60_000 },
        { id: randomUUID(), label: "middle-3-hours", ageMs: 3 * 60 * 60_000 },
        { id: randomUUID(), label: "tail-1-minute", ageMs: 60_000 }
      ];
      const domainId = randomUUID();
      for (const row of rows) {
        // `changes.object_id` REFERENCES objects(id) (migration 0007), so the graph object has to
        // exist first — a change row is the state machine hanging off a graph object, never a
        // free-standing record.
        await pool.query(
          `INSERT INTO objects (id, org_id, type_id, name, urn, origin_domain_id, content_hash)
             VALUES ($1, $2, 'change', $3, $4, $5, 'backfill-fixture')`,
          [row.id, orgId, row.label, `urn:scp:${orgId}:change:${row.label}`, domainId]
        );
        await pool.query(
          `INSERT INTO changes (object_id, org_id, state, updated_at, created_at, state_entered_at)
             VALUES ($1, $2, 'executing', now() - ($3 || ' milliseconds')::interval,
                     now() - ($3 || ' milliseconds')::interval,
                     now() - ($3 || ' milliseconds')::interval)`,
          [row.id, orgId, String(row.ageMs)]
        );
      }

      // THE UPGRADE.
      await migrate(drizzle(pool), { migrationsFolder });

      const after = await pool.query<{
        object_id: string;
        updated_at: Date;
        reconcile_cursor_at: Date;
      }>(
        `SELECT object_id, updated_at, reconcile_cursor_at FROM changes
           WHERE org_id = $1 ORDER BY reconcile_cursor_at ASC`,
        [orgId]
      );
      expect(after.rowCount).toBe(3);

      // THE BACKFILL: every row's cursor equals its own `updated_at`, exactly. Not "close to", not
      // "in the past" — equal, because the deploy must reproduce the queue it inherited.
      for (const row of after.rows) {
        expect(row.reconcile_cursor_at.getTime()).toBe(row.updated_at.getTime());
      }

      // AND THE CONSEQUENCE, asserted separately because the equality above is a statement about
      // values while THIS is the statement about behaviour: the engine's own ORDER BY still returns
      // the longest-waiting change first. Under a `now()` backfill all three timestamps would be
      // equal and this ordering would be arbitrary.
      const order = after.rows.map((r) => rows.find((x) => x.id === r.object_id)!.label);
      expect(order).toEqual(["head-20-days-stuck", "middle-3-hours", "tail-1-minute"]);

      // NOT NULL and NOT DEFAULTED-TO-DEPLOY-TIME: a NULL would sort LAST under Postgres' ASC NULLS
      // LAST and starve the row it belongs to, which is the failure this column exists to prevent.
      const nulls = await pool.query(
        `SELECT count(*)::int AS n FROM changes WHERE reconcile_cursor_at IS NULL`
      );
      expect(nulls.rows[0].n).toBe(0);
    } finally {
      await pool.end();
      await rm(tmpFolder, { recursive: true, force: true });
      const dropPool = new pg.Pool({ connectionString: adminUrl.toString() });
      try {
        const client = await dropPool.connect();
        try {
          await client.query(`DROP DATABASE ${client.escapeIdentifier(dbName)} WITH (FORCE)`);
        } finally {
          client.release();
        }
      } finally {
        await dropPool.end();
      }
    }
  }, 180_000);
});
