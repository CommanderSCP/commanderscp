/**
 * Standalone migrations entrypoint (M8 — BUILD_AND_TEST.md §8 M8 item 1, DESIGN.md §16: "Migrations
 * Job (pre-upgrade hook): Drizzle migrations, forward-only, expand/contract pattern for
 * zero-downtime"). `deploy/helm`'s migrations Job runs exactly `node dist/migrate-bin.js` as a Helm
 * `pre-upgrade,pre-install` hook, using the SAME admin/bootstrap `DATABASE_URL` `main.ts`'s Phase 1
 * already uses — this file performs ONLY that phase (`runMigrations` + the two `provision*Role`
 * calls) and exits, rather than going on to boot the HTTP server or the worker loops.
 *
 * Deliberately NOT a new `SCP_ROLE` value threaded through `main.ts`: this is a genuinely different
 * process shape (run once, to completion, then exit 0 — the Kubernetes Job model) from `main.ts`'s
 * "boot and serve forever" shape, and keeping them as separate entrypoints means neither has to
 * grow a conditional early-return path the other doesn't need.
 *
 * Idempotent and safe to run concurrently with itself or with `main.ts`'s own Phase 1 (every
 * existing pod's `main.ts` still runs the identical Phase 1 on its own boot, unchanged — this Job
 * is additive, not a replacement): `runMigrations` only applies migrations Drizzle's own tracking
 * table shows as not-yet-applied, and `provision*Role`'s `ALTER ROLE ... WITH LOGIN PASSWORD` is a
 * plain idempotent SQL statement. Running this Job FIRST, as a pre-upgrade hook (before the new
 * image's `api`/`worker` Deployments roll out), is what makes the zero-downtime expand/contract
 * proof possible: the schema is migrated before any new-version pod exists, so OLD-version pods
 * keep serving traffic against the (expand/contract-compatible) NEW schema for the whole rollout
 * window.
 */
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionPgBossRole, provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const adminPool = createPool(config.databaseUrl);
  const adminDb = createDb(adminPool);
  try {
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
