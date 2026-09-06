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

  // Phase 1 — admin/bootstrap connection: migrations + login-role provisioning ONLY (PR #4
  // security review, CRITICAL 3; pg-boss role added for the M3 tracked security follow-up).
  // Migrations create `scp_app` (NOSUPERUSER, NOBYPASSRLS), `scp_relay`, and `scp_pgboss`
  // (schema-scoped to `pgboss` only, no grants on `public`) and apply RLS; provisioning grants
  // each LOGIN with its runtime password. The admin pool is closed before the server serves
  // anything.
  //
  // M8 hardening: `SCP_SKIP_MIGRATIONS=true` (the Helm chart's `api`/`worker` Deployments) skips
  // ALL of this — `config.databaseUrl` (admin-capable) is never even connected to from these
  // pods. The chart's migrations Job (`migrate-bin.ts`) runs this exact same work, once, as a
  // pre-upgrade hook, using the admin connection ONLY that Job holds. Every other deployment
  // shape (compose, `pnpm dev`, every E2E script) leaves `SCP_SKIP_MIGRATIONS` unset and keeps
  // this unchanged.
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

  // THE FEDERATION-IDENTITY STARTUP CHECK. See docs/main.md §1.
  await warnOnFederationSelfOriginDivergence(db, {
    warn: (msg) => app.log.warn(msg),
    error: (msg) => app.log.error(msg)
  });

  // THE SUBPROCESS PLUGIN HOST. See docs/main.md §2.
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

  // THE SSE BRIDGE. See docs/main.md §3.
  const sseBridgePool = createPool(config.runtimeDatabaseUrl, { max: 2 });
  const sseBridge = startSseBridge(sseBridgePool, config.runtimeDatabaseUrl);
  const sseAuthzPool = createPool(config.runtimeDatabaseUrl, { max: SSE_AUTHZ_POOL_MAX });
  deps.sseAuthzDb = createDb(sseAuthzPool);
  //  3. `graphQueryPool` — the recursive-CTE graph read routes (routes/graph.ts). Same isolation
  //     rationale as the SSE pools: their cost is driven by graph shape + caller parameters, not by
  //     request volume, so a burst of expensive traversals must not starve the request pool and turn
  //     other tenants' requests into checkout timeouts. `max` imported as `GRAPH_QUERY_POOL_MAX` so
  //     the number and its justification cannot drift. Assigned after `buildApp`, like `sseAuthzDb`.
  const graphQueryPool = createPool(config.runtimeDatabaseUrl, { max: GRAPH_QUERY_POOL_MAX });
  deps.graphDb = createDb(graphQueryPool);
  app.addHook("onClose", async () => {
    await sseBridge.stop();
    await sseBridgePool.end();
    await sseAuthzPool.end();
    await graphQueryPool.end();
  });

  // Outbox relay + pg-boss worker skeleton (DESIGN.md §8) — only the roles that own background
  // work run them; `role=api` stays a pure request server for everything EXCEPT request-scoped
  // plugin dispatch (see the plugin-host note above). The relay runs on the runtime pool
  // and assumes the outbox-only `scp_relay` role per transaction; pg-boss connects as the
  // schema-scoped `scp_pgboss` login role (M3 tracked security follow-up — pg-boss no longer
  // runs its own schema migrations on the admin/superuser connection).
  if (backgroundWork) {
    // M21.4 (ADR-0032 §7): the domain-event stream's real consumers. See docs/main.md §4.
    const boss = await startPgBoss(config.pgBossDatabaseUrl, domainEventRouters(config));
    // M14.2 (ADR-0009): expose the job queue to request handlers (mirrors `deps.pluginHost` below)
    // so the inbound federation poke endpoint can enqueue an immediate federation-sync tick — the
    // contentless wake that pulls NOW instead of at the next interval, without pulling inline.
    deps.boss = boss;
    // NATS JetStream EventBus backend toggle (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md
    // M3 item 8) — `config.eventBus.backend === "postgres"` (the default) leaves `natsFanout`
    // undefined and the relay's behavior completely unchanged. Connecting is NOT wrapped in
    // try/catch: an explicit `nats` opt-in with an unreachable/misconfigured server must fail
    // boot loudly, not silently degrade to Postgres-only fan-out.
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

    // EVERY BACKGROUND LOOP THIS PROCESS RUNS. See docs/main.md §5.
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

  // M9.3 (ADR-0001): when `config.federationServerMtls` is set, `buildApp` (app.ts) already
  // constructed this Fastify instance with `https: {..., requestCert: true, rejectUnauthorized:
  // false}` — the listen call itself is unchanged either way, Fastify just binds an `https.Server`
  // instead of `http.Server` under the hood. Per-route enforcement (rejecting an unauthorized/
  // unregistered peer on the three federation transport routes) lives in
  // `federation/mtls-enforcement.ts`'s `enforceFederationMtls`, not here. When
  // `federationServerMtls` is unset (the default), this is byte-for-byte the pre-M9.3 plain-HTTP
  // behavior; server-side mTLS
  // enforcement then lives only at the deployment edge (`deploy/helm/templates/ingress.yaml`'s
  // `ingress.mtls` — nginx client-cert-verification annotations, see deploy/helm/README.md's
  // "Federation mTLS" section).
  // D6 / B3 (§7.3) — PROVE the configured secrets master key decrypts this instance's vault BEFORE
  // binding the listener, in production mode. A member cluster (or a restored instance) booting with
  // the wrong key would otherwise serve happily and fail every executor call later, one at a time,
  // with no single loud signal. A throw here fails the process closed. Evaluation mode skips it (an
  // eval stack may legitimately run on an ephemeral key with an empty or throwaway vault).
  if (config.deploymentMode === "production") {
    const canary = await runSecretsDecryptCanary(db, config.secretsMasterKey);
    app.log.info(
      `secrets decrypt canary passed (${canary.decryptsAttempted} decrypt(s) across ${canary.orgsWithSecrets} org(s) with a vault)`
    );
  }

  await app.listen({ port: config.port, host: config.host });
  const scheme = config.federationServerMtls ? "https" : "http";
  app.log.info(`scp (${config.role}) listening on ${scheme}://${config.host}:${config.port}`);

  // GRACEFUL SHUTDOWN ON SIGINT/SIGTERM. See docs/main.md §6.
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

  // M9.3 (ADR-0001 §8): CRL reload without a full restart, so a revocation can take effect in a
  // running (possibly air-gapped) instance by dropping in a new CRL file and signaling this
  // process — no network fetch, matching CLAUDE.md principle 5. Re-runs the SAME loader used at
  // boot (`loadFederationServerMtlsConfig`), so a reload is held to the identical validation (CA/
  // cert/key still required together, the same warn-vs-hard-fail-on-expiry policy for the CRL);
  // `tls.Server#setSecureContext` atomically swaps the context for all FUTURE handshakes without
  // dropping already-established connections. A reload failure (e.g. an operator drops in a
  // corrupt file) is logged and the PREVIOUS material stays in effect — a bad reload attempt must
  // never take down an already-running, correctly-configured listener.
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

  // BUILD_AND_TEST.md §5.3 — eval-stack demo data (SCP_SEED_DEMO, off by default; the compose
  // eval stack turns it on). Needs the server actually listening (it talks to itself over HTTP,
  // PUBLIC API ONLY — seed.ts module doc), hence after `app.listen` above, not before. A
  // nice-to-have, not boot-critical: logged and swallowed on failure, never crashes the server.
  // `&& bootstrap`: a process that did not CREATE the admin holds no fresh one-time password, so it
  // cannot log in to seed — the same reason seed.ts already skips when `oneTimePassword` is null.
  // The eval stack that turns this on runs `SCP_ROLE=all`, which does create it.
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
