import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";
import { startPgBoss } from "./events/pgboss.js";
import { startOutboxRelay } from "./events/outbox-relay.js";
import { loginAndSeedDemoData } from "./seed.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Phase 1 — admin/bootstrap connection: migrations + runtime-role provisioning ONLY (PR #4
  // security review, CRITICAL 3). Migrations create `scp_app` (NOSUPERUSER, NOBYPASSRLS) and
  // `scp_relay` and apply RLS; provisioning grants scp_app LOGIN with the runtime password.
  // The admin pool is closed before the server serves anything.
  const adminPool = createPool(config.databaseUrl);
  const adminDb = createDb(adminPool);
  await runMigrations(adminDb);
  const creds = runtimeCredentials(config.runtimeDatabaseUrl);
  await provisionRuntimeRole(adminPool, creds.user, creds.password);
  await adminPool.end();

  // Phase 2 — runtime pool: authenticates as the least-privileged `scp_app` login role. Every
  // request-serving query runs on this pool; RLS is enforced by the role itself, so a forgotten
  // `withTenantTx` cannot become a cross-tenant leak (DESIGN.md §4.2 "two independent failures").
  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);

  const app = await buildApp({ db, config });

  const bootstrap = await ensureBootstrapAdmin(
    db,
    { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
    { info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) }
  );

  // Outbox relay + pg-boss worker skeleton (DESIGN.md §8) — only the roles that own background
  // work run them; `role=api` stays a pure request server. The relay runs on the runtime pool
  // and assumes the outbox-only `scp_relay` role per transaction; pg-boss keeps the admin URL
  // because it owns (and migrates) its own `pgboss` schema at boot — documented deviation.
  if (config.role === "all" || config.role === "worker") {
    const boss = await startPgBoss(config.databaseUrl);
    const relay = startOutboxRelay(pool, config.runtimeDatabaseUrl, boss);
    app.addHook("onClose", async () => {
      await relay.stop();
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
    });
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`scp (${config.role}) listening on http://${config.host}:${config.port}`);

  // BUILD_AND_TEST.md §5.3 — eval-stack demo data (SCP_SEED_DEMO, off by default; the compose
  // eval stack turns it on). Needs the server actually listening (it talks to itself over HTTP,
  // PUBLIC API ONLY — seed.ts module doc), hence after `app.listen` above, not before. A
  // nice-to-have, not boot-critical: logged and swallowed on failure, never crashes the server.
  if (config.seedDemo) {
    await loginAndSeedDemoData(config, bootstrap, {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg)
    }).catch((err: unknown) => {
      app.log.error({ err }, "demo seed failed — continuing (non-fatal, eval-only feature)");
    });
  }
}

main().catch((err: unknown) => {
  console.error("fatal error starting scp server:", err);
  process.exitCode = 1;
});
