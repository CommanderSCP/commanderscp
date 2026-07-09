import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);

  // Auto-migrate on boot (dev + two-container compose eval mode — BUILD_AND_TEST.md §5).
  await runMigrations(db);

  const app = await buildApp({ db, config });

  await ensureBootstrapAdmin(
    db,
    { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
    { info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) }
  );

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`scp (${config.role}) listening on http://${config.host}:${config.port}`);
}

main().catch((err: unknown) => {
  console.error("fatal error starting scp server:", err);
  process.exitCode = 1;
});
