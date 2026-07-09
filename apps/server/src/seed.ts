import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";

/**
 * M0 seed: just the bootstrap org + admin (idempotent). The full five-minute-value demo seed
 * (fake executor, sample services/components, ownership edges, a policy, an in-flight change —
 * BUILD_AND_TEST.md §5.3) lands in M2 once those graph objects exist.
 *
 * Same two-phase connection split as main.ts (PR #4 security review, CRITICAL 3): admin
 * connection for migrations + role provisioning, then the seed writes run as the
 * least-privileged `scp_app` runtime role — the seed goes through the same code path (and the
 * same RLS) as real requests.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const adminPool = createPool(config.databaseUrl);
  const adminDb = createDb(adminPool);
  await runMigrations(adminDb);
  const creds = runtimeCredentials(config.runtimeDatabaseUrl);
  await provisionRuntimeRole(adminPool, creds.user, creds.password);
  await adminPool.end();

  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);
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
