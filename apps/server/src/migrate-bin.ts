/** Standalone migrations entrypoint. See docs/server.md §82. */
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionPgBossRole, provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import {
  assertNoVersionSkewOrThrow,
  isMissingHeartbeatTable,
  listLiveMemberHeartbeats
} from "./db/member-heartbeat-repo.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const adminPool = createPool(config.databaseUrl);
  const adminDb = createDb(adminPool);
  try {
    // §7.4 VERSION-SKEW GATE. See docs/server.md §83.
    if (process.env.SCP_MIGRATION_PHASE === "contract") {
      try {
        const live = await listLiveMemberHeartbeats(adminDb);
        assertNoVersionSkewOrThrow(live, config.appVersion);
        console.log(
          `[migrate-bin] version-skew gate passed: every live member cluster is on '${config.appVersion}'.`
        );
      } catch (err) {
        if (isMissingHeartbeatTable(err)) {
          console.log(
            "[migrate-bin] version-skew gate skipped: heartbeat table not present yet (first deploy)."
          );
        } else {
          throw err;
        }
      }
    }

    console.log("[migrate-bin] applying forward-only migrations...");
    await runMigrations(adminDb);
    console.log("[migrate-bin] migrations applied.");

    const creds = runtimeCredentials(config.runtimeDatabaseUrl);
    await provisionRuntimeRole(adminPool, creds.user, creds.password);
    const pgBossCreds = runtimeCredentials(config.pgBossDatabaseUrl);
    await provisionPgBossRole(adminPool, pgBossCreds.user, pgBossCreds.password);
    console.log("[migrate-bin] runtime roles provisioned. done.");
  } finally {
    await adminPool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[migrate-bin] fatal:", err);
  process.exitCode = 1;
});
