import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit generates committed, forward-only SQL migrations under ./drizzle
 * (BUILD_AND_TEST.md §3.2). No live database connection is required.
 *
 * IT DIFFS AGAINST `drizzle/meta/<newest>_snapshot.json`, NOT AGAINST THE `.sql` FILES — the earlier
 * wording here ("against the migrations already on disk") is what made a stale snapshot look
 * harmless. That snapshot is the tool's whole model of what already exists, and it sat at 4 tables
 * against 110 journal entries until 0109_snapshot.json reconciled it, which made `db:generate`
 * abort on an interactive rename prompt rather than emit anything at all.
 *
 * `src/db/snapshot-freshness.test.ts` fails if a schema.ts edit lands without a matching generate.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://scp:scp@localhost:5432/scp"
  }
});
