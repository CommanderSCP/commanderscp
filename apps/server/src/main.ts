import path from "node:path";
import os from "node:os";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionPgBossRole, provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";
import { startPgBoss } from "./events/pgboss.js";
import { startOutboxRelay } from "./events/outbox-relay.js";
import { connectNatsFanout, type NatsFanoutHandle } from "./events/nats-fanout.js";
import { loginAndSeedDemoData } from "./seed.js";
import { SubprocessPluginHost } from "./plugin-host/host.js";
import { startReconcileLoop } from "./coordination/reconcile.js";
import { startWatchdogLoop } from "./coordination/watchdog.js";
import {
  DEFAULT_EXECUTOR_INSTANCE_ID,
  DEFAULT_EXECUTOR_MODULE,
  SHARED_PLUGIN_INSTANCE_DOMAIN_ID,
  SHARED_PLUGIN_INSTANCE_ORG_ID
} from "./coordination/executor-config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Phase 1 — admin/bootstrap connection: migrations + login-role provisioning ONLY (PR #4
  // security review, CRITICAL 3; pg-boss role added for the M3 tracked security follow-up).
  // Migrations create `scp_app` (NOSUPERUSER, NOBYPASSRLS), `scp_relay`, and `scp_pgboss`
  // (schema-scoped to `pgboss` only, no grants on `public`) and apply RLS; provisioning grants
  // each LOGIN with its runtime password. The admin pool is closed before the server serves
  // anything.
  const adminPool = createPool(config.databaseUrl);
  const adminDb = createDb(adminPool);
  await runMigrations(adminDb);
  const creds = runtimeCredentials(config.runtimeDatabaseUrl);
  await provisionRuntimeRole(adminPool, creds.user, creds.password);
  const pgBossCreds = runtimeCredentials(config.pgBossDatabaseUrl);
  await provisionPgBossRole(adminPool, pgBossCreds.user, pgBossCreds.password);
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
  // and assumes the outbox-only `scp_relay` role per transaction; pg-boss connects as the
  // schema-scoped `scp_pgboss` login role (M3 tracked security follow-up — pg-boss no longer
  // runs its own schema migrations on the admin/superuser connection).
  if (config.role === "all" || config.role === "worker") {
    const boss = await startPgBoss(config.pgBossDatabaseUrl);
    // NATS JetStream EventBus backend toggle (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md
    // M3 item 8) — `config.eventBus.backend === "postgres"` (the default) leaves `natsFanout`
    // undefined and the relay's behavior completely unchanged. Connecting is NOT wrapped in
    // try/catch: an explicit `nats` opt-in with an unreachable/misconfigured server must fail
    // boot loudly, not silently degrade to Postgres-only fan-out.
    const natsFanout: NatsFanoutHandle | undefined =
      config.eventBus.backend === "nats"
        ? await connectNatsFanout(config.eventBus.natsUrl!)
        : undefined;
    const relay = startOutboxRelay(pool, config.runtimeDatabaseUrl, boss, {
      eventBusBackend: config.eventBus.backend,
      natsFanout
    });

    // M3 coordination engine (BUILD_AND_TEST.md §8 M3, DESIGN.md §9.3/§9.4): the subprocess
    // plugin host + the resumable reconciliation loop. One shared fake-executor plugin instance
    // (coordination/executor-config.ts documents why: M3 has no plugin-instance configuration
    // API yet) with its state file under the OS temp dir — durable across the plugin
    // SUBPROCESS restarting (the plugin-host isolation DoD scenario), not across this whole
    // `scpd` process restarting, which is fine: fake-executor is never a real system of record.
    const pluginHost = new SubprocessPluginHost();
    await pluginHost.start([
      {
        id: DEFAULT_EXECUTOR_INSTANCE_ID,
        module: DEFAULT_EXECUTOR_MODULE,
        orgId: SHARED_PLUGIN_INSTANCE_ORG_ID,
        domainId: SHARED_PLUGIN_INSTANCE_DOMAIN_ID,
        config: { statePath: path.join(os.tmpdir(), "scpd-fake-executor-state.json") }
      }
    ]);
    const reconcileLoop = await startReconcileLoop(boss, db, pluginHost);
    // CRITICAL #1 fix (PR #7 review): the stuck-change watchdog sweep (DESIGN.md §9.4) had no
    // production caller at all before this — scheduled here the same way the reconcile loop is,
    // one queue per capability, both under the same `role === "all" || "worker"` guard.
    const watchdogLoop = await startWatchdogLoop(boss, db);

    app.addHook("onClose", async () => {
      await reconcileLoop.stop();
      await watchdogLoop.stop();
      await pluginHost.stop();
      await relay.stop();
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
      await natsFanout?.close().catch(() => undefined);
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
