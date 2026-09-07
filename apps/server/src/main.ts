import { buildApp } from "./app.js";
import { loadConfig, loadFederationServerMtlsConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionPgBossRole, provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";
import { startPgBoss } from "./events/pgboss.js";
import { domainEventRouters } from "./events/domain-event-registry.js";
import { startOutboxRelay } from "./events/outbox-relay.js";
import { startSseBridge } from "./events/sse-bridge.js";
import { connectNatsFanout, type NatsFanoutHandle } from "./events/nats-fanout.js";
import { loginAndSeedDemoData } from "./seed.js";
import { startPluginHostForRole } from "./plugin-host/host-bootstrap.js";
import {
  createsBootstrapAdmin,
  runsBackgroundWork,
  startBackgroundLoops
} from "./background-work.js";
import { warnOnFederationSelfOriginDivergence } from "./federation/self-origin-check.js";
import { runSecretsDecryptCanary } from "./secrets/decrypt-canary.js";
import { assertProductionSecretsOrThrow } from "./boot-checks.js";
import { recordMemberClusterHeartbeat } from "./db/member-heartbeat-repo.js";
import { createCommanderPokeSender } from "./federation/poke-sender.js";
import { getSharedCelSandbox } from "./governance/cel-sandbox.js";
import { SSE_AUTHZ_POOL_MAX } from "./routes/events.js";
import { GRAPH_QUERY_POOL_MAX } from "./routes/graph.js";
import type { AppDeps } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // D6 (§7.3) — a PRODUCTION instance must not boot on ephemeral generated secrets (fail-closed,
  // before anything else). Extracted to boot-checks.ts so it is directly testable.
  assertProductionSecretsOrThrow(config);
  if (config.deploymentMode !== "production" && config.secretsMasterKeyWasGenerated) {
    // M7 (secrets/crypto.ts) — evaluation mode keeps the loud-not-fatal warning.
    console.warn(
      "[scpd] SCP_SECRETS_MASTER_KEY is unset — generated an EPHEMERAL secrets master key for this process only. " +
        "Any plugin secret stored now will be unreadable after the next restart. Set SCP_SECRETS_MASTER_KEY " +
        "(base64, 32 bytes) for any deployment that configures real executor/notification credentials."
    );
  }

  // Phase 1 — admin/bootstrap connection. See docs/server.md §69.
  if (!config.skipMigrations) {
    const adminPool = createPool(config.databaseUrl);
    const adminDb = createDb(adminPool);
    await runMigrations(adminDb);
    const creds = runtimeCredentials(config.runtimeDatabaseUrl);
    await provisionRuntimeRole(adminPool, creds.user, creds.password);
    const pgBossCreds = runtimeCredentials(config.pgBossDatabaseUrl);
    await provisionPgBossRole(adminPool, pgBossCreds.user, pgBossCreds.password);
    await adminPool.end();
  }

  // Phase 2 — runtime pool: authenticates as the least-privileged `scp_app` login role. Every
  // request-serving query runs on this pool; RLS is enforced by the role itself, so a forgotten
  // `withTenantTx` cannot become a cross-tenant leak (DESIGN.md §4.2 "two independent failures").
  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);

  // §7.4 — heartbeat this member cluster's (cluster id, app version) so the migrations Job's
  // version-skew gate can see whether an old-version member cluster is still live. Never fatal: a
  // heartbeat failure must not block boot (the gate fails OPEN if the table isn't there yet anyway).
  await recordMemberClusterHeartbeat(db, config.clusterId, config.appVersion).catch((err) =>
    console.warn("[scpd] failed to record member-cluster heartbeat (non-fatal)", err)
  );

  // M7: `deps` is captured here (not just `{db, config}` inline) so `deps.pluginHost` can be set
  // AFTER the plugin host is constructed below — route handlers registered against this same
  // object (routes/executors.ts's `POST /discovery/run`) read `deps.pluginHost` at REQUEST time,
  // long after boot, so the late assignment is visible to them (types.ts's doc comment).
  const deps: AppDeps = { db, config };
  const app = await buildApp(deps);

  // ONLY THE HTTP-SERVING ROLE CREATES THE ADMIN — `createsBootstrapAdmin`, whose doc carries the
  // measured failure. Running this in every process meant the api and worker raced on an empty
  // database and the winner printed the one-time password; when the worker won, the only copy of
  // the credential landed in a log no operator instruction points at.
  const bootstrap = createsBootstrapAdmin(config)
    ? await ensureBootstrapAdmin(
        db,
        { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
        { info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) }
      )
    : null;

  // THE FEDERATION-IDENTITY STARTUP CHECK. See docs/server.md §70.
  await warnOnFederationSelfOriginDivergence(db, {
    warn: (msg) => app.log.warn(msg),
    error: (msg) => app.log.error(msg)
  });

  // THE SUBPROCESS PLUGIN HOST. See docs/server.md §71.
  const backgroundWork = runsBackgroundWork(config);
  const pluginHost = await startPluginHostForRole(deps, config.role);
  // An api-only process owns nothing else to tear down, so it stops the host itself. The
  // background-work branch below keeps stopping it in ITS onClose, ordered after the loops that use
  // it — stopping the host out from under a running reconcile tick is what that ordering avoids.
  if (!backgroundWork) {
    app.addHook("onClose", async () => {
      await pluginHost.stop();
    });
  }

  // THE SSE BRIDGE. See docs/server.md §72.
  const sseBridgePool = createPool(config.runtimeDatabaseUrl, { max: 2 });
  const sseBridge = startSseBridge(sseBridgePool, config.runtimeDatabaseUrl);
  const sseAuthzPool = createPool(config.runtimeDatabaseUrl, { max: SSE_AUTHZ_POOL_MAX });
  deps.sseAuthzDb = createDb(sseAuthzPool);
  // The pool for the recursive-CTE graph read routes. See docs/server.md §73.
  const graphQueryPool = createPool(config.runtimeDatabaseUrl, { max: GRAPH_QUERY_POOL_MAX });
  deps.graphDb = createDb(graphQueryPool);
  app.addHook("onClose", async () => {
    await sseBridge.stop();
    await sseBridgePool.end();
    await sseAuthzPool.end();
    await graphQueryPool.end();
  });

  // Outbox relay + pg-boss worker skeleton (DESIGN.md §8). See docs/server.md §74.
  if (backgroundWork) {
    // M21.4 (ADR-0032 §7): the domain-event stream's real consumers. See docs/server.md §75.
    const boss = await startPgBoss(config.pgBossDatabaseUrl, domainEventRouters(config));
    // M14.2 (ADR-0009): expose the job queue to request handlers (mirrors `deps.pluginHost` below)
    // so the inbound federation poke endpoint can enqueue an immediate federation-sync tick — the
    // contentless wake that pulls NOW instead of at the next interval, without pulling inline.
    deps.boss = boss;
    // NATS JetStream EventBus backend toggle. See docs/server.md §76.
    const natsFanout: NatsFanoutHandle | undefined =
      config.eventBus.backend === "nats"
        ? await connectNatsFanout(config.eventBus.natsUrl!)
        : undefined;
    // M14.3 (ADR-0009): the commander poke SENDER, hung off the outbox relay's post-commit hook (the
    // "outbox-derived" federation feed, DESIGN §5). INERT unless outbound client-cert material is
    // present AND a peer is per-peer poke-mode + downstream — otherwise a no-op. Best-effort:
    // fire-and-forget, coalesced per peer, and never blocks/fails the underlying journal append.
    const pokeSender = createCommanderPokeSender(db);
    const relay = startOutboxRelay(pool, config.runtimeDatabaseUrl, boss, {
      eventBusBackend: config.eventBus.backend,
      natsFanout,
      onEventsRelayed: (orgIds) => pokeSender.onEventsRelayed(orgIds)
    });

    // EVERY BACKGROUND LOOP THIS PROCESS RUNS. See docs/server.md §77.
    const backgroundLoops = await startBackgroundLoops({
      boss,
      db,
      host: pluginHost,
      sandbox: getSharedCelSandbox(),
      config
    });

    app.addHook("onClose", async () => {
      // Stops every loop in registration order — the same order this file stopped them in by hand,
      // and now impossible to get out of step with the list that STARTED them.
      await backgroundLoops.stop();
      await pluginHost.stop();
      await relay.stop();
      // Stop the poke sender AFTER the relay so no new post-commit hook fires into it; then drain any
      // in-flight best-effort pokes (unawaited network calls) before tearing the process down.
      await pokeSender.stop();
      await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
      await natsFanout?.close().catch(() => undefined);
    });
  }

  // When that is set, the app builds its own listener. See docs/server.md §78.
  if (config.deploymentMode === "production") {
    const canary = await runSecretsDecryptCanary(db, config.secretsMasterKey);
    app.log.info(
      `secrets decrypt canary passed (${canary.decryptsAttempted} decrypt(s) across ${canary.orgsWithSecrets} org(s) with a vault)`
    );
  }

  await app.listen({ port: config.port, host: config.host });
  const scheme = config.federationServerMtls ? "https" : "http";
  app.log.info(`scp (${config.role}) listening on ${scheme}://${config.host}:${config.port}`);

  // GRACEFUL SHUTDOWN ON SIGINT/SIGTERM. See docs/server.md §79.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal} — closing gracefully`);
    app
      .close()
      .catch((err: unknown) => app.log.error({ err }, "error during graceful shutdown"))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Revocation-list reload without a full restart. See docs/server.md §80.
  if (config.federationServerMtls) {
    process.on("SIGHUP", () => {
      try {
        const fresh = loadFederationServerMtlsConfig(process.env);
        if (!fresh) {
          throw new Error(
            "SCP_FEDERATION_SERVER_MTLS_* env vars are no longer set — refusing to reload " +
              "in-app federation mTLS out from under a running listener (restart the process " +
              "instead if you intend to disable it)"
          );
        }
        (app.server as unknown as import("node:tls").Server).setSecureContext({
          ca: fresh.ca,
          cert: fresh.cert,
          key: fresh.key,
          crl: fresh.crl
        });
        app.log.info(
          { crlLoaded: !!fresh.crl },
          "federation server mTLS: reloaded CA/cert/key/CRL material on SIGHUP"
        );
      } catch (err) {
        app.log.error(
          { err },
          "federation server mTLS: SIGHUP reload FAILED — continuing with the PREVIOUSLY loaded " +
            "material (fail-safe: a bad reload attempt must not drop TLS on a running listener)"
        );
      }
    });
  }

  // BUILD_AND_TEST.md §5.3 — eval-stack demo data. See docs/server.md §81.
  if (config.seedDemo && bootstrap) {
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
