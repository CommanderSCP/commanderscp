import { defineConfig } from "drizzle-kit";

/** Forward-only migrations, diffed against the snapshot. See docs/server.md §1. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://scp:scp@localhost:5432/scp"
  }
});
