import { buildApp } from "./app.js";
import { loadConfig, loadFederationServerMtlsConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionPgBossRole, provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin } from "./auth/local-auth.js";
import { startPgBoss } from "./events/pgboss.js";
import { domainEventRouters } from "./events/domain-event-registry.js";
import { startOutboxRelay } from "./events/outbox-relay.js";
import { connectNatsFanout, type NatsFanoutHandle } from "./events/nats-fanout.js";
import { loginAndSeedDemoData } from "./seed.js";
import { startPluginHostForRole } from "./plugin-host/host-bootstrap.js";
import { runsBackgroundWork, startBackgroundLoops } from "./background-work.js";
import { warnOnFederationSelfOriginDivergence } from "./federation/self-origin-check.js";
import { createCommanderPokeSender } from "./federation/poke-sender.js";
import { getSharedCelSandbox } from "./governance/cel-sandbox.js";
import type { AppDeps } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.secretsMasterKeyWasGenerated) {
    // M7 (secrets/crypto.ts) — see config.ts's doc comment: an ephemeral key lets the compose
    // eval stack and a first `pnpm dev` boot with zero required env vars, but any org secret
    // (GitHub App key, ArgoCD token, managed-iac infra creds) encrypted under it becomes
    // undecryptable the moment this process restarts. Loud, not fatal.
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

  // M7: `deps` is captured here (not just `{db, config}` inline) so `deps.pluginHost` can be set
  // AFTER the plugin host is constructed below — route handlers registered against this same
  // object (routes/executors.ts's `POST /discovery/run`) read `deps.pluginHost` at REQUEST time,
  // long after boot, so the late assignment is visible to them (types.ts's doc comment).
  const deps: AppDeps = { db, config };
  const app = await buildApp(deps);

  const bootstrap = await ensureBootstrapAdmin(
    db,
    { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
    { info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) }
  );

  // ---------------------------------------------------------------------------------------------
  // THE FEDERATION-IDENTITY STARTUP CHECK (federation/self-origin-check.ts has the full rationale).
  //
  // Every reconcile candidate query filters on `objects.origin_domain_id =
  // federation_self.domain_id`. If those two ever diverge — a partial restore, an org cloned into a
  // fresh database, a rebuild that recreated the `federation_self` row — every batch comes back
  // empty and ALL coordination for that org stops with no error and no log line. That is the exact
  // shape of the 13-day production outage this codebase already measured, and a green `/healthz`
  // (four lines below) says nothing about it.
  //
  // WHY HERE, three ways:
  //  - AFTER `ensureBootstrapAdmin`, because that is the one code path that creates an org and its
  //    first locally-authored objects; running before it would inspect an org that does not exist yet.
  //  - BEFORE `app.listen` and before the loops start, so the warning is in the log AHEAD of the
  //    first silent tick rather than buried under an hour of ordinary request logging.
  //  - UNCONDITIONALLY, not inside the `runsBackgroundWork` guard below. The damage lands on the
  //    worker, but the api pod is where an operator looks first, and in the chart's default split
  //    topology only one of the two would otherwise say anything. It costs two small reads per org,
  //    once per boot — it is emphatically NOT on the reconcile hot path, which was the whole reason
  //    a per-tick empty-batch probe was rejected in favour of this.
  //
  // Read-only and non-fatal: it never repairs the divergence (which side is wrong depends on where
  // the good backup is — an operator decision), and it never blocks boot, exactly like the ephemeral
  // secrets-key and expired-CRL warnings.
  // ---------------------------------------------------------------------------------------------
  await warnOnFederationSelfOriginDivergence(db, {
    warn: (msg) => app.log.warn(msg),
    error: (msg) => app.log.error(msg)
  });

  // ---------------------------------------------------------------------------------------------
  // THE SUBPROCESS PLUGIN HOST — constructed for EVERY role, including `api`.
  //
  // It used to be built inside the `all|worker` guard below, next to the loops, so a split
  // api/worker deployment (the Helm chart's default, and how the homelab runs) left `deps.pluginHost`
  // undefined on the api process and `POST /discovery/run` answered 400 "discovery requires a
  // worker-capable process" — on the ONLY process that serves HTTP. Discovery was unreachable in the
  // topology the chart ships, and the operator-facing remediation ("SCP_ROLE=all") is wrong advice:
  // it would ALSO start a second reconcile/watchdog/observe loop set beside the worker's.
  //
  // The guard conflated two different needs. The LOOPS need pg-boss, the outbox relay and a
  // single-writer role — that is what `all|worker` protects, and it is unchanged below. Discovery
  // needs only the ability to dispatch a plugin for the duration of ONE request. Hosting plugins is
  // not background work, so it does not belong behind a background-work guard.
  //
  // What stays role-gated is the shared fake-executor INSTANCE: it exists for the coordination loops
  // (coordination/executor-config.ts), so an api-only process starts the host with NO pre-registered
  // instances and pays only for an idle supervisor. Discovery registers its own instance per request
  // either way, so it never depended on that default.
  //
  // Egress is unchanged and was verified before this landed: the chart's executor NetworkPolicies
  // select every pod of the release rather than the worker alone, and the app-level SSRF egress
  // guard is per-plugin-instance, not per-process. Neither boundary moves because a different
  // process dispatches the plugin.
  // ---------------------------------------------------------------------------------------------
  // `runsBackgroundWork(config)` is IMPORTED, not inlined (`background-work.ts`). It used to be an
  // inline `config.role === "all" || config.role === "worker"`, and that made it unreachable by any
  // test: setting it `false` — killing all eleven loops below — left the entire apps/server unit
  // suite green, because nothing can import this file. The predicate is now a pure exported
  // function with its own coverage, and the loops it gates are a registry that is STARTED in a test.
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

  // Outbox relay + pg-boss worker skeleton (DESIGN.md §8) — only the roles that own background
  // work run them; `role=api` stays a pure request server for everything EXCEPT request-scoped
  // plugin dispatch (see the plugin-host note above). The relay runs on the runtime pool
  // and assumes the outbox-only `scp_relay` role per transaction; pg-boss connects as the
  // schema-scoped `scp_pgboss` login role (M3 tracked security follow-up — pg-boss no longer
  // runs its own schema migrations on the admin/superuser connection).
  if (backgroundWork) {
    // M21.4 (ADR-0032 §7): the domain-event stream's real consumers. `boss.work()` is a competing
    // consumer, so a feature that reacts to an event registers a ROUTER rather than a second worker
    // on `domain-events` — the router makes one cheap decision and enqueues onto that capability's
    // own queue, worked by the `start…Loop` calls below.
    //
    // WHICH routers, and under WHICH role guard, is `events/domain-event-registry.ts` — not a
    // literal here. Until M21.7 it was a literal here, and that is precisely why nothing could
    // check it: `main()` runs at module scope, so no test can import this file, so the census that
    // guarded the list had to read this file as TEXT — and text cannot tell a live registration
    // from an unreachable one (an inverted guard leaves the factory's name sitting right there in
    // the source). The registry is a pure value, so `events/domain-event-routers.test.ts` now
    // EXECUTES it for a matrix of configs and asserts what is actually registered, against the set
    // of routers it discovers in the tree. The one thing that census still reads as text is the
    // line below — that this composition root calls `domainEventRouters` at all.
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

    // EVERY BACKGROUND LOOP THIS PROCESS RUNS — `background-work.ts`'s `BACKGROUND_LOOPS`, not a
    // list of eleven `const`s here, and not eleven matching `.stop()` calls in the `onClose` below.
    //
    // WHY IT MOVED. This block used to hand-write both halves, and both were unverifiable: nothing
    // can import this file (`main()` runs at module scope), so every test that claimed to check the
    // wiring was matching SUBSTRINGS. Measured 2026-08-17 — flipping this block's own condition to
    // `false`, killing all eleven loops, left `bump-dispatch`, `bump-gate`, `inventory-ingestion`
    // and `domain-event-routers` green at 79/79 and the whole unit suite green. A registry is a pure
    // importable value, so `background-work.test.ts` STARTS it against a probe boss and asserts what
    // actually happened, and a loop that is never registered fails that test rather than shipping
    // inert. Same move, same reason, as M21.7 moving the router list into `domain-event-registry.ts`.
    //
    // The one link still checked as text is the CALL BELOW — see that test file, which says so.
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
  await app.listen({ port: config.port, host: config.host });
  const scheme = config.federationServerMtls ? "https" : "http";
  app.log.info(`scp (${config.role}) listening on ${scheme}://${config.host}:${config.port}`);

  // GRACEFUL SHUTDOWN ON SIGINT/SIGTERM — newly required by `host.ts`'s process-group kill fix.
  // Plugin subprocesses are now spawned `detached: true` (their own process group, so a hang-
  // timeout SIGKILL can take down a `docker` child with it instead of orphaning it — see that
  // file's `killInstanceProcess` doc comment). The side effect: they no longer sit in THIS
  // process's foreground process group, so a terminal Ctrl-C (`pnpm dev`) no longer reaches them
  // for free the way it used to — nothing here previously called `app.close()` on a signal either,
  // so a plain container SIGTERM (Kubernetes pod termination, pid 1, never a process-group signal)
  // was already not gracefully handled before this change. Both paths now go through the same
  // `onClose` hooks above, which is where `pluginHost.stop()`/`backgroundLoops.stop()`/etc. already
  // live — one graceful-shutdown path instead of relying on OS job-control as an accident of the
  // process tree shape.
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
