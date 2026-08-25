import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { ScpClient } from "@scp/sdk";
import type { CreateComponentRequest, GraphObject } from "@scp/schemas";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, roleBindings, roles, users } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureBootstrapAdmin } from "../auth/local-auth.js";
import { startPgBoss } from "../events/pgboss.js";
import { startOutboxRelay, type OutboxRelayHandle } from "../events/outbox-relay.js";
import { startSseBridge, type SseBridgeHandle } from "../events/sse-bridge.js";
import { connectNatsFanout, type NatsFanoutHandle } from "../events/nats-fanout.js";
import type PgBoss from "pg-boss";
import type { AppDeps } from "../types.js";
import { SubprocessPluginHost, type PluginHostOptions } from "../plugin-host/host.js";
import { startReconcileLoop, type ReconcileLoopHandle } from "../coordination/reconcile.js";
import { startWatchdogLoop, type WatchdogLoopHandle } from "../coordination/watchdog.js";
import {
  DEFAULT_EXECUTOR_INSTANCE_ID,
  DEFAULT_EXECUTOR_MODULE,
  SHARED_PLUGIN_INSTANCE_SCOPE_KEY,
  SHARED_PLUGIN_INSTANCE_ORG_ID
} from "../coordination/executor-config.js";

/**
 * Admin/superuser URL — set by test-support/global-setup.ts (Vitest `globalSetup` — process.env
 * is shared with workers). Tests use this only for privileged fixture surgery (e.g. the audit
 * tamper test); the servers under test run on `testRuntimeDatabaseUrl()`.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is unset — integration tests must run via `vitest.integration.config.ts` (globalSetup starts the Testcontainers postgres:16 instance)."
    );
  }
  return url;
}

/** Least-privileged `scp_app` login-role URL — what the servers under test actually connect as. */
export function testRuntimeDatabaseUrl(): string {
  const url = process.env.TEST_RUNTIME_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_RUNTIME_DATABASE_URL is unset — integration tests must run via `vitest.integration.config.ts` (globalSetup provisions the scp_app login role)."
    );
  }
  return url;
}

/**
 * Schema-scoped `scp_pgboss` login-role URL — what pg-boss connects as under test (M3 tracked
 * security follow-up), and what `pgboss-role.integration.test.ts` connects as directly to probe
 * it.
 */
export function testPgBossDatabaseUrl(): string {
  const url = process.env.TEST_PGBOSS_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_PGBOSS_DATABASE_URL is unset — integration tests must run via `vitest.integration.config.ts` (globalSetup provisions the scp_pgboss login role)."
    );
  }
  return url;
}

export interface TestServer {
  app: FastifyInstance;
  deps: AppDeps;
  close(): Promise<void>;
}

/**
 * Builds a Fastify app against the shared Testcontainers Postgres — migrations + runtime-role
 * provisioning already applied by globalSetup. The pool connects as the real `scp_app` login
 * role, exactly like production (main.ts phase 2) — never as the container's superuser.
 */
export async function buildTestServer(
  opts: {
    operatorToken?: string;
    federationRole?: "commander" | "outpost" | "retrans";
    role?: "all" | "api" | "worker";
  } = {}
): Promise<TestServer> {
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
    SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
    SCP_COOKIE_SECRET: "test-cookie-secret-value",
    // M17.5: the deployment-level operator credential that gates writing the instance-scoped scan
    // floors. Unset by default so every existing test keeps the fail-closed default (the operator
    // write surface is CLOSED unless a deployment configures a token).
    ...(opts.operatorToken ? { SCP_OPERATOR_TOKEN: opts.operatorToken } : {}),
    // M16.3 P3: the install-time federation-role axis (config.ts's `federationRole` doc comment).
    // Unset by default so every existing test keeps the pre-M16.3 default (`commander`, SPA served).
    ...(opts.federationRole ? { SCP_FEDERATION_ROLE: opts.federationRole } : {}),
    // M21.7 follow-up: the PROCESS axis (`SCP_ROLE`). Unset ⇒ `all`, which is what every existing
    // test has always got and is also the shape that HIDES a route guard carrying the process axis:
    // an `all` process satisfies it. A test about the split topology — an api process in front of a
    // worker, which is how the Helm chart deploys — has to be able to boot the api half. `buildApp`
    // reads nothing from `config.role` (only `main.ts`'s `runsBackgroundWork` and the dependency
    // guards do), so this changes what the ROUTES see and nothing else.
    ...(opts.role ? { SCP_ROLE: opts.role } : {})
  });
  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);
  const deps: AppDeps = { db, config };
  const app = await buildApp(deps, { logger: process.env.SCP_TEST_VERBOSE === "true" });
  await app.ready();
  return {
    app,
    deps,
    close: async () => {
      await app.close();
      await pool.end();
    }
  };
}

export interface ListeningTestServer extends TestServer {
  baseUrl: string;
  /** Set by `opts.withReconcileLoop` OR `opts.withPluginHost` — the plugin host driving whatever fake-executor
   *  instance the reconciliation loop triggers wave targets against. Integration tests use this
   *  directly (e.g. `pluginHost` internals via `killExecutorSubprocess` below) to exercise the
   *  plugin-host isolation DoD scenario. */
  pluginHost?: SubprocessPluginHost;
}

/**
 * Same as `buildTestServer`, but actually bound to a real loopback port (`app.inject()` doesn't
 * open a socket) — needed for anything that speaks real HTTP to the server: the SDK's
 * `fetch`-based client and the CLI subprocess (test-support/cli-runner.ts).
 *
 * `withEventRelay: true` additionally wires up the outbox relay + pg-boss (main.ts's `role ===
 * "all" || "worker"` branch, unchanged logic) AND the SSE bridge (main.ts's unconditional-per-role
 * branch — events/sse-bridge.ts) so events written by requests against this server actually reach
 * `sseHub`/`GET /events/stream` — `buildApp` alone never starts any of them, so SSE stays silent
 * without this. Off by default: most callers of `listenTestServer` don't need a live event
 * pipeline, and pg-boss provisioning its own schema on every boot isn't free.
 *
 * THE BRIDGE IS NOT OPTIONAL HERE (M26.1). Since the relay stopped calling `sseHub.publish`
 * directly (outbox-relay.ts's doc comment — proposal multi-region-instance-resilience.md §7.1 item
 * 1), it is the ONLY thing that can feed `sseHub` in this process, in EVERY topology main.ts
 * starts it in — which, because `app.listen()` there is itself unconditional, is every role. A
 * test harness that mirrored the OLD, role-gated shape here would silently reproduce exactly the
 * process-boundary bug (§4-A1) this milestone closes.
 *
 * `natsUrl` mirrors main.ts's `config.eventBus.backend === "nats"` branch: when set (only the
 * NATS-backend half of events/event-bus.integration.test.ts's shared suite passes this), the
 * relay ALSO fans relayed outbox rows out to a real JetStream stream, exactly as it would in
 * production with `SCP_EVENT_BUS_BACKEND=nats`. `undefined` (every other caller) leaves the relay
 * exactly as it's always behaved — no NATS connection is ever attempted.
 *
 * `withReconcileLoop: true` (requires `withEventRelay: true` — the loop needs `boss`) starts the
 * M3 coordination engine exactly as main.ts does: a `SubprocessPluginHost` with one fake-executor
 * instance, the self-re-scheduling reconcile tick, AND (CRITICAL #1 fix, PR #7 review) the
 * watchdog sweep loop — main.ts starts both under the same `role === "all" || "worker"` guard, so
 * this mirrors that exactly rather than needing a separate flag. `pluginHostOptions` lets a test
 * tighten timeouts/backoff (the production defaults are tuned for real workloads, not fast test
 * iteration); `watchdogIntervalSeconds` similarly overrides the production default (60s) for tests
 * that want more than one real sweep within a reasonable test timeout — the loop's very first
 * sweep still fires immediately on start regardless, so most tests need neither.
 * `reconcileTickIntervalOverrideMs` isn't exposed — tests instead just poll (`waitUntil`,
 * coordination.integration.test.ts) since `RECONCILE_TICK_INTERVAL_SECONDS` (1s) is already fast
 * enough not to dominate test runtime.
 */
export async function listenTestServer(
  opts: {
    withEventRelay?: boolean;
    natsUrl?: string;
    withReconcileLoop?: boolean;
    /**
     * Starts the `SubprocessPluginHost` (and assigns `deps.pluginHost`) WITHOUT the reconcile and
     * watchdog loops.
     *
     * Use this whenever a test needs the plugin host — `POST /discovery/run` fail-closes on
     * `deps.pluginHost` alone — but is going to drive the coordination engine ITSELF, e.g. by
     * calling `processChangeSourceEvents` inline and then reading the result synchronously.
     *
     * `withReconcileLoop: true` starts a LIVE COMPETITOR for exactly that work. The processor claims
     * rows `FOR UPDATE SKIP LOCKED`, so when a 1s tick claims the row first, the test's own inline
     * call silently processes NOTHING and its follow-up read sees the tick's uncommitted pre-image —
     * `resulting_change_object_id` still NULL. That is a real, measured flake (~0.7% per event under
     * CPU load; 0/300 with the loop off), and it is invisible on an idle machine.
     */
    withPluginHost?: boolean;
    pluginHostOptions?: PluginHostOptions;
    watchdogIntervalSeconds?: number;
    /** Merged into the shared fake-executor instance's config (default is just `{statePath,
     *  autoSucceedAfterMs: 50}`) — lets a test set `FakeExecutorConfig.forcePhase` to
     *  deterministically fail a specific, test-known target object id (create the target with an
     *  explicit `id:` so it's known before the server — and therefore the plugin instance — ever
     *  boots). Used by governance.integration.test.ts's M4 automatic-rollback-on-failure suite;
     *  every other caller leaves this unset and gets ordinary auto-succeeding targets. */
    fakeExecutorConfig?: Record<string, unknown>;
    /** M17.5: sets `SCP_OPERATOR_TOKEN` on the server under test, opening the operator-only
     *  instance-scan-floor write surface. Unset ⇒ that surface stays closed (403). */
    operatorToken?: string;
    /** M16.3 P3: sets `SCP_FEDERATION_ROLE` on the server under test (config.ts's `federationRole`
     *  doc comment). Unset ⇒ `commander` (SPA served — the pre-M16.3 default for every deployment). */
    federationRole?: "commander" | "outpost" | "retrans";
    /** Sets `SCP_ROLE` — the PROCESS axis. Unset ⇒ `all`. Set it to `api` to boot the request-serving
     *  half of the split topology, which is the only deployment shape under which a route that
     *  wrongly carries the process axis misbehaves. Note this does NOT stop the caller starting the
     *  loops below: the flags here are independent, exactly as `main.ts`'s are. */
    role?: "all" | "api" | "worker";
  } = {}
): Promise<ListeningTestServer> {
  const server = await buildTestServer({
    ...(opts.operatorToken ? { operatorToken: opts.operatorToken } : {}),
    ...(opts.federationRole ? { federationRole: opts.federationRole } : {}),
    ...(opts.role ? { role: opts.role } : {})
  });
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });

  let boss: PgBoss | undefined;
  let relay: OutboxRelayHandle | undefined;
  let sseBridge: SseBridgeHandle | undefined;
  let relayPool: pg.Pool | undefined;
  let natsFanout: NatsFanoutHandle | undefined;
  let pluginHost: SubprocessPluginHost | undefined;
  let pluginStateDir: string | undefined;
  let reconcileLoop: ReconcileLoopHandle | undefined;
  let watchdogLoop: WatchdogLoopHandle | undefined;
  // The plugin host does NOT need pg-boss, so it is started outside the relay block — which is what
  // lets `withPluginHost` exist without dragging in the loops that make inline processing racy.
  if (opts.withReconcileLoop || opts.withPluginHost) {
    // RAW `mkdtemp`, DELIBERATELY NOT `@scp/test-tmpdir` — and this is the one module in the repo
    // where that package is not merely unnecessary but FATAL.
    //
    // THE PROPERTY: `@scp/test-tmpdir` registers `afterEach`/`afterAll` from `vitest` at MODULE
    // LOAD (correctly — see its doc), so importing it drags `vitest` into the import graph of
    // whatever imports it. THIS module is not vitest-only: `apps/web/e2e/global-setup.ts` (a
    // PLAYWRIGHT `globalSetup`, a plain Node process with no vitest runner) imports
    // `@scp/server/dist/test-support/harness.js` for `listenTestServer`/`createTestOrg`. Merely
    // importing `vitest` there throws "Vitest failed to access its internal state" at module init,
    // before a single line of setup runs — measured 2026-08-23 both in CI job 9 and locally with a
    // bare `node -e 'await import(".../harness.js")'`. It takes down BOTH of that suite's modes,
    // including the compose-stack mode that never reaches the code below.
    //
    // THE LIFETIME IS BETTER HERE ANYWAY. This directory belongs to the plugin host started three
    // lines down, not to a test file's `afterAll` — so it is removed by `close()` below, beside
    // every other resource this function opens. `test-support-runner-neutral.test.ts` is the gate
    // that keeps a future import from putting `vitest` back into this directory's graph.
    const stateDir = await mkdtemp(join(tmpdir(), "scp-test-fake-executor-"));
    pluginStateDir = stateDir;
    pluginHost = new SubprocessPluginHost(opts.pluginHostOptions);
    server.deps.pluginHost = pluginHost; // M7: routes/executors.ts's POST /discovery/run needs this
    try {
      await pluginHost.start([
        {
          id: DEFAULT_EXECUTOR_INSTANCE_ID,
          module: DEFAULT_EXECUTOR_MODULE,
          orgId: SHARED_PLUGIN_INSTANCE_ORG_ID,
          scopeKey: SHARED_PLUGIN_INSTANCE_SCOPE_KEY,
          config: {
            statePath: join(stateDir, "fake-executor-state.json"),
            autoSucceedAfterMs: 50,
            ...opts.fakeExecutorConfig
          }
        }
      ]);
    } catch (err) {
      // `start()` can genuinely throw (a plugin that never reaches ready inside `callTimeoutMs`),
      // and on that path NOBODY gets the `close()` below — `listenTestServer` never returns. The
      // hook-based allocator this replaced covered that case for free; owning the lifetime by hand
      // means owning the failure path too, or the fix trades a common leak for a rare one.
      await rm(stateDir, { recursive: true, force: true });
      throw err;
    }
  }

  if (opts.withEventRelay) {
    boss = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
    if (opts.natsUrl) {
      natsFanout = await connectNatsFanout(opts.natsUrl);
    }
    // A separate pool from the app's own `deps.db` connection — mirrors main.ts's `pool`, which
    // the relay also owns independently of the request-serving pool.
    relayPool = createPool(server.deps.config.runtimeDatabaseUrl);
    relay = startOutboxRelay(relayPool, server.deps.config.runtimeDatabaseUrl, boss, {
      eventBusBackend: opts.natsUrl ? "nats" : "postgres",
      natsFanout
    });
    // M26.1: the relay above no longer publishes into `sseHub` itself — this bridge is what does,
    // mirroring main.ts's unconditional-per-role wiring (see this function's doc comment). Reuses
    // `relayPool` rather than opening a third pool: both are equally valid `scp_app`-authenticated
    // pools and a `pg.Pool` supports concurrent checkouts from more than one consumer.
    sseBridge = startSseBridge(relayPool, server.deps.config.runtimeDatabaseUrl);

    if (opts.withReconcileLoop) {
      // The host is started in the block above, which `withReconcileLoop` also triggers. Asserted
      // rather than `!`-ed so that if the two are ever decoupled further, this fails loudly instead
      // of starting a reconcile loop with no executor behind it.
      if (!pluginHost) {
        throw new Error(
          "internal: withReconcileLoop requires the plugin host to have been started"
        );
      }
      reconcileLoop = await startReconcileLoop(
        boss,
        server.deps.db,
        pluginHost,
        server.deps.celSandbox!,
        server.deps.config.secretsMasterKey
      );
      watchdogLoop = await startWatchdogLoop(
        boss,
        server.deps.db,
        pluginHost,
        server.deps.config.secretsMasterKey,
        {
          intervalSeconds: opts.watchdogIntervalSeconds
        }
      );
    }
  }

  return {
    ...server,
    baseUrl: `${address}/api/v1`,
    pluginHost,
    close: async () => {
      await reconcileLoop?.stop();
      await watchdogLoop?.stop();
      await pluginHost?.stop();
      // AFTER `pluginHost.stop()`, never before: the fake executor re-creates this directory on
      // every persist (`mkdir(dirname(statePath), { recursive: true })`), so removing it while a
      // child is still alive removes nothing durably — that is exactly how the leak this replaced
      // survived a green run.
      if (pluginStateDir) await rm(pluginStateDir, { recursive: true, force: true });
      await sseBridge?.stop();
      await relay?.stop();
      await boss?.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
      await relayPool?.end();
      await natsFanout?.close().catch(() => undefined);
      await server.close();
    }
  };
}

export interface TestOrg {
  orgId: string;
  orgName: string;
  adminUsername: string;
  adminPassword: string;
  adminToken: string;
}

/**
 * Creates a fresh, uniquely-named org + bootstrap admin, and logs the admin in via the real API.
 *
 * Uses a per-org-unique admin username deliberately: local-auth's `login()` resolves users by
 * username only (DESIGN.md §6's `LoginRequestSchema` has no org discriminator — fine for a
 * single-bootstrap-org walking skeleton), so two orgs sharing a literal username would make
 * login ambiguous. Pre-existing M0 limitation, out of M1 scope (local-auth is superseded by
 * OIDC/PATs in M2/M3) — noted here rather than worked around silently.
 */
export async function createTestOrg(server: TestServer, label = "org"): Promise<TestOrg> {
  const orgName = `${label}-${randomUUID()}`;
  const adminUsername = `admin-${randomUUID()}`;
  const result = await ensureBootstrapAdmin(
    server.deps.db,
    { orgName, adminUsername },
    { info: () => undefined, warn: () => undefined }
  );
  if (!result.oneTimePassword)
    throw new Error("expected a freshly created org to return a one-time password");

  const login = await server.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: adminUsername, password: result.oneTimePassword }
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed for freshly bootstrapped org: ${login.statusCode} ${login.body}`);
  }
  const body = login.json() as { token: string };

  return {
    orgId: result.orgId,
    orgName,
    adminUsername,
    adminPassword: result.oneTimePassword,
    adminToken: body.token
  };
}

export interface TestUserBinding {
  /** Built-in role name: Viewer | Operator | Approver | Administrator | Owner. */
  role: string;
  /** Scope object id, or "self" for the user's own graph object. */
  scope: string | "self";
  effect?: "allow" | "deny";
}

export interface TestUser {
  /** The graph `user` object id — the RBAC subject. */
  objectId: string;
  username: string;
  password: string;
  token: string;
}

/**
 * Creates a NON-admin user in an existing test org: a graph `user` object (the RBAC subject),
 * an auth row, the given role bindings, and a live bearer token via the real login API. This is
 * how authz tests get subjects with narrow, deliberate permissions instead of the bootstrap
 * admin's org-root Owner binding. (No user-management API exists yet in M1 — that's an M2 typed
 * endpoint — so setup goes through the repo layer, inside the same tenant transaction machinery
 * real requests use.)
 */
export async function createTestUser(
  server: TestServer,
  org: TestOrg,
  bindings: TestUserBinding[]
): Promise<TestUser> {
  const username = `user-${randomUUID()}`;
  const password = randomUUID();

  const objectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
    const userObject = await createObject(tx, {
      orgId: org.orgId,
      typeId: "user",
      actorObjectId: org.orgId,
      requestId: "test-user-setup",
      name: username
    });

    for (const binding of bindings) {
      const role = await tx.query.roles.findFirst({
        where: and(isNull(roles.orgId), eq(roles.name, binding.role))
      });
      if (!role) throw new Error(`built-in role '${binding.role}' not found`);
      await tx.insert(roleBindings).values({
        id: uuidv7(),
        orgId: org.orgId,
        subjectId: userObject.id,
        roleId: role.id,
        scopeObjectId: binding.scope === "self" ? userObject.id : binding.scope,
        effect: binding.effect ?? "allow"
      });
    }

    return userObject.id;
  });

  const passwordHash = await argon2.hash(password);
  await server.deps.db.insert(users).values({
    id: uuidv7(),
    orgId: org.orgId,
    username,
    passwordHash,
    objectId
  });

  const login = await server.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password }
  });
  if (login.statusCode !== 200) {
    throw new Error(`test user login failed: ${login.statusCode} ${login.body}`);
  }
  const body = login.json() as { token: string };

  return { objectId, username, password, token: body.token };
}

/**
 * A raw `pg.Client` that AUTHENTICATES as the least-privileged `scp_app` login role (no SET
 * ROLE, no BYPASSRLS) — the exact identity the production runtime pool uses (PR #4 security
 * review, CRITICAL 3). Used by adversarial RLS tests to probe the database directly, bypassing
 * the application layer entirely, per BUILD_AND_TEST.md §4.2 "attempt reads/writes across
 * org_id with a mis-set/unset app.current_org_id". Callers are responsible for calling
 * `setOrgContext`/leaving it unset.
 */
export class RawScpAppClient {
  private constructor(private readonly client: pg.Client) {}

  static async connect(): Promise<RawScpAppClient> {
    const client = new pg.Client({ connectionString: testRuntimeDatabaseUrl() });
    await client.connect();
    return new RawScpAppClient(client);
  }

  /** Sets `app.current_org_id` for the remainder of this session (until `clearOrgContext`). */
  async setOrgContext(orgId: string): Promise<void> {
    await this.client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
  }

  async clearOrgContext(): Promise<void> {
    await this.client.query("SELECT set_config('app.current_org_id', '', false)");
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) {
    return this.client.query<T>(text, params);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * A raw `pg.Client` that AUTHENTICATES as the schema-scoped `scp_pgboss` login role — the exact
 * identity pg-boss itself connects as (M3 tracked security follow-up, drizzle/0008_pgboss_role
 * .sql). Used by `pgboss-role.integration.test.ts` to probe the database directly: proving the
 * role can operate inside the `pgboss` schema, and proving it has NO grant at all on `public`'s
 * tenant tables (objects/relationships/role_bindings/changes).
 */
export class RawScpPgBossClient {
  private constructor(private readonly client: pg.Client) {}

  static async connect(): Promise<RawScpPgBossClient> {
    const client = new pg.Client({ connectionString: testPgBossDatabaseUrl() });
    await client.connect();
    return new RawScpPgBossClient(client);
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) {
    return this.client.query<T>(text, params);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * Polls `check()` until it returns truthy or `timeoutMs` elapses (then throws, the last-seen
 * error folded into the failure message). The M3 coordination engine (coordination/reconcile.ts)
 * advances changes asynchronously off a ~1s self-scheduling pg-boss tick — every coordination
 * integration test that asserts "eventually the change reaches state X" polls for it with this
 * rather than a fixed `sleep`, so the suite is exactly as slow as the engine actually is and
 * never flaky-fast on a loaded CI box.
 */
export async function waitUntil<T>(
  check: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number; describe: string }
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await check();
      if (result) return result;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitUntil timed out after ${timeoutMs}ms waiting for: ${opts.describe}` +
          (lastError
            ? ` — last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
            : "")
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * THE BARRIER EVERY SSE-BRIDGE TEST NEEDS, before it publishes anything it expects to be delivered.
 *
 * `startSseBridge` returns synchronously but establishes its `LISTEN scp_sse_events` connection
 * ASYNCHRONOUSLY, and NOTIFY has NO REPLAY (ADR-0025 D4). An event relayed into that window is lost
 * permanently — so a test that expected it times out, and (worse) a test making a NEGATIVE assertion
 * passes VACUOUSLY, because nothing could ever have reached the bridge to be rejected.
 *
 * Idle machines win that race and hide it. CI lost it: `sse-bridge.integration.test.ts`'s wiring test
 * failed with `waitUntil timed out after 15000ms` on a runner where a neighbouring suite's 10k-write
 * audit test was taking 141s. Postgres retains an idle backend's last query text, so the LISTEN's own
 * presence in `pg_stat_activity` IS the positive signal that it is established — no fixed sleep, and
 * exactly as slow as the connection actually is (integration-sleep-census.test.ts's property).
 *
 * `admin` must be a client on the ADMIN url (`testDatabaseUrl()`), scoped to this worker's database.
 */
export async function waitForSseBridgeListening(admin: pg.Client): Promise<void> {
  await waitUntil(
    async () => {
      const res = await admin.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND query ILIKE 'LISTEN scp_sse_events%'`
      );
      return res.rows.length > 0 ? true : undefined;
    },
    {
      describe: "the SSE bridge's LISTEN connection to be established (NOTIFY has no replay)",
      timeoutMs: 15_000
    }
  );
}

/**
 * How long ONE reconcile tick is allowed to take, for the purpose of sizing a test's deadline.
 *
 * ## `RECONCILE_TICK_INTERVAL_SECONDS` is 1, and every deadline written against that number is wrong
 *
 * The tick does not run every second. It re-schedules ITSELF with `boss.send(RECONCILE_QUEUE, {},
 * { startAfter: 1 })` after each sweep completes, and pg-boss's `pollingInterval` defaults to
 * 2000 ms and is not overridden anywhere in this repo — so the floor is `sweep + 1s + U(0, 2s)`
 * before the sweep does any work at all. The sweep then walks EVERY org in the database
 * (`runReconcileSweep`, correctly: production is one instance serving many orgs), and a test FILE
 * accumulates one org per test, so the same deadline buys fewer ticks the later in the file it is
 * evaluated.
 *
 * MEASURED, not assumed (2026-08-17, 8-core dev box, ambient load ~25), by watching
 * `reconcile_cursor_at` on a gate-blocked change for 30 s and timing `propose -> executing`:
 *
 *   | orgs in the database | arrival (`propose -> executing`) | tick gap (median) | tick gap (max) |
 *   |----------------------|----------------------------------|-------------------|----------------|
 *   | 1                    | 1391 ms                          | 2025 ms           | 2154 ms        |
 *   | 21                   | **10903 ms**                     | 2821 ms           | 5972 ms        |
 *
 * The right-hand columns are why "several ticks" was never several ticks. The ARRIVAL column is why
 * the sleep-based `assertStaysExecuting` failed: it asserted `state === "executing"` 4000 ms after
 * `propose()`, from the 16th test of a file that has already created 15 orgs by then (28 by the
 * end) — so the sweep it is waiting on is a long way down the right-hand columns. Reproduced: after
 * the full 4000 ms the change had not left `proposed`. That is not a race the test lost
 * occasionally; it is a deadline it had already missed, hidden by the fact that seven of the eight
 * call sites happen to wait for something else first and are therefore already in `executing`.
 *
 * ## This is a BUDGET, not a measurement
 *
 * A deadline set to the idle-case upper bound is a deadline that fails the first time the box is
 * busy. That is exactly how the rollback test's `waitUntil(..., 15_000)` — fifteen ticks at the
 * fictitious 1 s rate, seven at the measured one-org rate, five once its own file's orgs are in the
 * sweep, and fewer still under a parallel fork — timed out while passing alone. Say what a chain
 * needs in TICKS, which
 * is the unit the engine actually works in, and let {@link reconcileTicks} convert with headroom.
 *
 * Deadlines elsewhere in this suite are still written in raw milliseconds against the 1 s fiction.
 * They are a known instance of the same property and should migrate to `reconcileTicks` as they are
 * touched — see `test-support/integration-sleep-census.test.ts` for the sibling guard on the sleep
 * half of it.
 */
export const RECONCILE_TICK_BUDGET_MS = 6_000;

/** A deadline, in ms, for a wait whose chain needs `ticks` reconcile ticks to complete. */
export function reconcileTicks(ticks: number): number {
  return ticks * RECONCILE_TICK_BUDGET_MS;
}

/**
 * Reads the engine-private reconcile bookkeeping for one change. `reconcile_cursor_at` and
 * `reconcile_blocked_at` are deliberately NOT on the public `Change` schema — they are scheduler
 * queue position and park flag, not anything an API caller should see — so the progress helpers
 * below read them straight from `changes`, exactly like the fixture surgery this file's other
 * helpers already do.
 */
async function readReconcileRow(
  server: TestServer,
  orgId: string,
  changeObjectId: string
): Promise<{ state: string; cursorAt: number; blockedAt: Date | null }> {
  return withTenantTx(server.deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({
        state: changes.state,
        cursorAt: changes.reconcileCursorAt,
        blockedAt: changes.reconcileBlockedAt
      })
      .from(changes)
      .where(and(eq(changes.orgId, orgId), eq(changes.objectId, changeObjectId)));
    if (!row) {
      throw new Error(`no changes row for ${changeObjectId} in org ${orgId}`);
    }
    return { state: row.state, cursorAt: row.cursorAt?.getTime() ?? 0, blockedAt: row.blockedAt };
  });
}

/** The states a change passes through BEFORE the one the caller is waiting to see it hold. Used to
 *  tell "has not got there yet" (keep waiting, and say so if we run out of time) apart from "went
 *  straight past it" (fail now, loudly) — the distinction the sleep-based helper could not make. */
const STATES_BEFORE: Record<"executing" | "waiting", ReadonlySet<string>> = {
  executing: new Set(["proposed", "evaluated", "coordinated", "waiting"]),
  waiting: new Set(["proposed", "evaluated", "coordinated"])
};

/**
 * "It is still parked", asserted from a POSITIVE signal instead of a fixed sleep.
 *
 * ## What this replaces, and why the thing it replaces could only ever be probabilistic
 *
 * Three test files had their own copy of `sleep(3_000); expect(state).toBe(X)`, each with a comment
 * promising the grace was "several reconcile ticks". That form makes two different claims through
 * one assertion, and gets flaky on the one it never meant to make:
 *
 *  1. **Arrival** — "the change has REACHED X". A freshly-proposed change walks `proposed ->
 *     evaluated -> coordinated -> executing` under the reconcile loop before a wave gate is asked
 *     anything, so the fixed grace was silently doubling as the WAIT for arrival. A call site that
 *     ran straight after `changes.propose()` therefore failed under load with
 *     `expected 'coordinated' to be 'executing'` — a change that had not got there YET, reported
 *     with the same message as one that had escaped the gate. Same failure text, opposite bug, and
 *     it cost three sessions a day of chasing phantom regressions on 2026-08-17.
 *  2. **Non-progression** — "and it did not get past X". Only this one was ever intended.
 *
 * ## "Several ticks" was not several ticks
 *
 * The graces were sized against `RECONCILE_TICK_INTERVAL_SECONDS` (1s) — see
 * {@link RECONCILE_TICK_BUDGET_MS} for the arithmetic and the measurements. The headline number:
 * with 21 orgs in the database, `propose -> executing` took **10903 ms**, against a grace of 4000 ms.
 * A 3s grace is at most one tick and often zero, so the assertion was near-vacuous when it passed
 * and spurious when it failed.
 *
 * ## The positive signal
 *
 * `reconcile.ts` bumps `reconcile_cursor_at` on every tick that re-examines a change and leaves it
 * where it is — the round-robin anti-starvation write (BUMP 1 OF 5 for `waiting`, 3 OF 5 for a
 * gate-blocked wave), load-bearing enough to have its own regression test and a 13-day production
 * outage behind it. For a parked change that write happens if and only if the engine looked again
 * and still refused, which makes an observed cursor advance a direct observation of exactly the
 * event the test is asserting about.
 *
 * So: poll for arrival (deadlined, and reported AS an arrival failure), then watch the cursor
 * advance `ticks` times, failing the instant the state leaves X or the change is parked out of the
 * candidate set. Under contention this waits precisely as long as the engine needs; on an idle box
 * it returns as soon as the ticks land instead of always burning the full grace.
 */
async function assertChangeStaysIn(
  server: TestServer,
  orgId: string,
  changeObjectId: string,
  state: "executing" | "waiting",
  opts: { ticks?: number; timeoutMs?: number } = {}
): Promise<void> {
  const ticks = opts.ticks ?? 2;
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const intervalMs = 100;
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  const before = STATES_BEFORE[state];

  // Phase 1 — ARRIVAL, polled rather than slept for.
  let row = await readReconcileRow(server, orgId, changeObjectId);
  while (row.state !== state) {
    if (!before.has(row.state)) {
      throw new Error(
        `change ${changeObjectId} was expected to stay parked in '${state}' but is '${row.state}' — it progressed PAST '${state}'`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `change ${changeObjectId} never reached '${state}' within ${timeoutMs}ms (still '${row.state}'). This is an ARRIVAL timeout — the reconcile loop had not got to it yet — not a governance failure.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    row = await readReconcileRow(server, orgId, changeObjectId);
  }

  // Phase 2 — PROGRESS: `ticks` observed refusals, however long the engine takes to make them.
  let seen = 0;
  let cursor = row.cursorAt;
  while (seen < ticks) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    row = await readReconcileRow(server, orgId, changeObjectId);
    if (row.state !== state) {
      throw new Error(
        `change ${changeObjectId} left '${state}' for '${row.state}' after ${seen} observed reconcile tick(s) — it was expected to stay parked`
      );
    }
    if (row.blockedAt !== null) {
      throw new Error(
        `change ${changeObjectId} was PARKED OUT of the candidate set (reconcile_blocked_at set) after ${seen} observed reconcile tick(s) — its wave failed rather than staying gate-blocked, and the loop will never serve it again`
      );
    }
    if (row.cursorAt > cursor) {
      cursor = row.cursorAt;
      seen++;
    }
    if (seen < ticks && Date.now() >= deadline) {
      throw new Error(
        `change ${changeObjectId} is still '${state}' but only ${seen}/${ticks} reconcile tick(s) were observed in ${Date.now() - started}ms — the loop is not serving it (is \`withReconcileLoop: true\` set?), so "it stayed parked" would be vacuous`
      );
    }
  }
}

/** {@link assertChangeStaysIn} for a wave-gate-blocked change: the gate was re-evaluated and
 *  refused again, and the change never got past `executing`. */
export async function assertStaysExecuting(
  server: TestServer,
  orgId: string,
  changeObjectId: string,
  opts: { ticks?: number; timeoutMs?: number } = {}
): Promise<void> {
  await assertChangeStaysIn(server, orgId, changeObjectId, "executing", opts);
}

/**
 * Waits for the run of `controlObjectId` that authorizes the **accept edge** — `lifecycle_edge` /
 * `{fromState: "validating", toState: "accepted"}` — to exist on `changeObjectId` with `status`.
 *
 * ## Why a wave-boundary run is not an answer to this question
 *
 * `POST /changes/{id}/accept` runs the lifecycle gate with **no plugin host** (DESIGN §16's
 * api/worker split — `coordination/gates.ts`'s `GateDeps.host` is `null` on the API tier), so it can
 * only READ a control outcome, never produce one. Since M22.0a it reads
 * `latestControlRunForGate`: the run made for ITS OWN crossing, because a run is evidence that a
 * particular crossing was authorized and not a permanent property of the change (an exclusion grant
 * carries an expiry — ADR-0033 §10).
 *
 * The run every test sees FIRST belongs to a different crossing. A change reaches `validating` by
 * clearing its **wave boundaries** (`{topologyObjectId, waveIndex}`), so by the time it is
 * acceptable there is already a passing run for the control — for the wrong gate. The accept edge's
 * own run is written afterwards, by `reconcile.ts`'s `advanceValidatingChanges` prewarm, in the same
 * tick that transitioned the change but in a LATER transaction. Between those two commits the
 * change is observably `validating` and `accept` correctly answers 409 with a Decision reading
 * `requireControls: {outcome: "not-run"}`.
 *
 * So `waitForValidating(...)` followed immediately by `accept(...)` is a RACE, and one that only
 * ever loses on a loaded runner: the window measured ~180 ms wide on a cold plugin subprocess and
 * ~20 ms warm, against a 100 ms poll.
 *
 * CI SURFACED THREE OF NINE. Three tests failed the shard; a census by the PROPERTY ("this accept
 * depends on a control run made for another gate") found NINE call sites across
 * `governance.integration.test.ts` and `scoped-scan-requirements.integration.test.ts`, and holding
 * the accept-edge prewarm back by one reconcile tick failed exactly those nine and nothing else.
 * The other six were passing on timing, not on contract. Waiting for the accept edge's OWN run
 * makes the precondition the thing the test actually depends on, rather than a faster machine.
 *
 * NOT A RETRY LOOP AROUND `accept`. This waits for a named, observable fact — the run that will
 * decide the crossing — and then asserts the accept exactly as before. A test whose control never
 * produces that run still fails, here, by timeout.
 *
 * Reads `gateKind`/`gateRef` off `GET /changes/{id}/control-runs`, the additive projection M22.8
 * shipped for exactly this question. A run missing them does not match: absent gate identity is not
 * evidence of the right crossing, and failing closed here keeps the wait from silently degrading
 * into the gate-agnostic one it replaced.
 */
export async function waitForAcceptEdgeControlRun(
  client: ScpClient,
  changeObjectId: string,
  controlObjectId: string,
  status: string,
  opts: { timeoutMs?: number } = {}
) {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  return waitUntil(
    async () => {
      const runs = await client.controlRuns.listForChange(changeObjectId);
      // `listControlRunsForChange` orders `createdAt DESC`, so the first match is the newest run
      // for this crossing — the one `latestControlRunForGate` would return.
      return runs.items.find((r) => {
        if (r.controlObjectId !== controlObjectId || r.status !== status) return false;
        if (r.gateKind !== "lifecycle_edge") return false;
        const ref = r.gateRef as { fromState?: unknown; toState?: unknown } | undefined;
        return ref?.fromState === "validating" && ref?.toState === "accepted";
      });
    },
    {
      describe: `the accept-edge (validating->accepted) run of control ${controlObjectId} on change ${changeObjectId} reports '${status}' — the run POST /accept will actually read (M22.0a)`,
      timeoutMs
    }
  );
}

/** {@link assertChangeStaysIn} for a change parked on an unsatisfied cross-change prerequisite
 *  (M12 P4B): `advanceWaitingChanges` looked at it again and its requirements are still unmet. */
export async function assertStaysWaiting(
  server: TestServer,
  orgId: string,
  changeObjectId: string,
  opts: { ticks?: number; timeoutMs?: number } = {}
): Promise<void> {
  await assertChangeStaysIn(server, orgId, changeObjectId, "waiting", opts);
}

/**
 * The companion positive signal for a change whose wave has FAILED: `reconcile.ts`'s failed-wave
 * branch sets `reconcile_blocked_at`, and `listChangeRowsInStates` filters that column `IS NULL`,
 * so a parked change is never served again. That makes parking the precise, observable moment
 * after which "no auto-rollback was triggered" stops being a race and becomes a settled fact —
 * where a fixed `sleep(3_000)` asserts a negative over a window in which the engine had either
 * already stopped looking, or (on a loaded box) not yet started.
 *
 * Use this before any "and it never did X" assertion about a failed wave.
 */
export async function waitForChangeParked(
  server: TestServer,
  orgId: string,
  changeObjectId: string,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 40_000;
  await waitUntil(
    async () => (await readReconcileRow(server, orgId, changeObjectId)).blockedAt !== null,
    {
      describe: `change ${changeObjectId} is parked by the reconcile loop (reconcile_blocked_at set — its wave failed, so it will never be served again)`,
      timeoutMs
    }
  );
}

/**
 * M12 P5a: components can no longer be created bare — the strict `POST /components` requires a
 * service. This test helper creates a throwaway service (unless one is supplied) and the component
 * in it, returning the component. Every pre-P5a `client.components.create({ name })` test call
 * migrates to `createTestComponent(client, { name })` — the components are coordination targets that
 * just need to EXIST; which service they belong to is irrelevant to those tests.
 */
export async function createTestComponent(
  client: ScpClient,
  req: Omit<CreateComponentRequest, "service"> & { service?: string }
): Promise<GraphObject> {
  const { service, ...rest } = req;
  const serviceId =
    service ??
    (await client.services.create({ name: `svc-${rest.name}-${randomUUID().slice(0, 8)}` })).id;
  return client.components.create({ ...rest, service: serviceId });
}

/**
 * M12 P5a: create an ORPHAN component (no service) via the IMPORT path (`discovery/accept`), which is
 * permissive by design — the strict `POST /components` route requires a service, but imports never
 * do. Used by the `contains`-model tests that need a service-less component to then assign manually.
 */
export async function createOrphanComponent(client: ScpClient, name: string): Promise<GraphObject> {
  const result = await client.discovery.accept({
    proposal: {
      objects: [{ typeId: "component", name, properties: {} }],
      relationships: [],
      bindings: []
    }
  });
  return client.components.get(result.createdObjectIds[0]!);
}
