import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";

/**
 * M0 seed: just the bootstrap org + admin (idempotent). The full five-minute-value demo seed
 * (fake executor, sample services/components, ownership edges, a policy, an in-flight change —
 * BUILD_AND_TEST.md §5.3) lands in M2 once those graph objects exist.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  await runMigrations(db);
  await ensureBootstrapAdmin(
    db,
    { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
    { info: (msg) => console.log(msg), warn: (msg) => console.warn(msg) }
  );

  await pool.end();
  console.log("seed: complete (M0 minimal — bootstrap org + admin only).");
}

main().catch((err: unknown) => {
  console.error("seed failed:", err);
  process.exitCode = 1;
});
