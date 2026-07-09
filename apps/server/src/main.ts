import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";
import { startPgBoss } from "./events/pgboss.js";
import { startOutboxRelay } from "./events/outbox-relay.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Migrations run over the admin connection (creates the `scp_app` role, seeds built-in
  // types/roles, applies RLS — drizzle/0002_rls_rbac_seed.sql). Request-serving queries go
  // through the same pool but drop into `scp_app` per-transaction via `withTenantTx`
  // (db/tenant-tx.ts) — no BYPASSRLS role ever serves a request.
  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  await runMigrations(db);

  const app = await buildApp({ db, config });

  await ensureBootstrapAdmin(
    db,
    { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
    { info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) }
  );

  // Outbox relay + pg-boss worker skeleton (DESIGN.md §8) — only the roles that own background
  // work run them; `role=api` stays a pure request server.
  if (config.role === "all" || config.role === "worker") {
    const boss = await startPgBoss(config.databaseUrl);
    const relay = startOutboxRelay(pool, config.databaseUrl, boss);
    app.addHook("onClose", async () => {
      await relay.stop();
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
    });
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`scp (${config.role}) listening on http://${config.host}:${config.port}`);
}

main().catch((err: unknown) => {
  console.error("fatal error starting scp server:", err);
  process.exitCode = 1;
});
