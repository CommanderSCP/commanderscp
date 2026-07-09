import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit generates committed, forward-only SQL migrations under ./drizzle
 * (BUILD_AND_TEST.md §3.2). `db:generate` diffs src/db/schema.ts against the migrations
 * already on disk and does not require a live database connection.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://scp:scp@localhost:5432/scp"
  }
});
