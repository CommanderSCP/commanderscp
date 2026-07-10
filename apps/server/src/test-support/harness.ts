import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import * as argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles, users } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureBootstrapAdmin } from "../auth/local-auth.js";
import { startPgBoss } from "../events/pgboss.js";
import { startOutboxRelay, type OutboxRelayHandle } from "../events/outbox-relay.js";
import { connectNatsFanout, type NatsFanoutHandle } from "../events/nats-fanout.js";
import type PgBoss from "pg-boss";
import type { AppDeps } from "../types.js";
import { SubprocessPluginHost, type PluginHostOptions } from "../plugin-host/host.js";
import { startReconcileLoop, type ReconcileLoopHandle } from "../coordination/reconcile.js";
import {
  DEFAULT_EXECUTOR_INSTANCE_ID,
  DEFAULT_EXECUTOR_MODULE,
  SHARED_PLUGIN_INSTANCE_DOMAIN_ID,
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
export async function buildTestServer(): Promise<TestServer> {
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
    SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
    SCP_COOKIE_SECRET: "test-cookie-secret-value"
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
  /** Only set when `opts.withReconcileLoop` — the plugin host driving whatever fake-executor
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
 * "all" || "worker"` branch, unchanged logic) so events written by requests against this server
 * actually reach `sseHub`/`GET /events/stream` — `buildApp` alone never starts either, so SSE
 * stays silent without this. Off by default: most callers of `listenTestServer` don't need a
 * live event pipeline, and pg-boss provisioning its own schema on every boot isn't free.
 *
 * `natsUrl` mirrors main.ts's `config.eventBus.backend === "nats"` branch: when set (only the
 * NATS-backend half of events/event-bus.integration.test.ts's shared suite passes this), the
 * relay ALSO fans relayed outbox rows out to a real JetStream stream, exactly as it would in
 * production with `SCP_EVENT_BUS_BACKEND=nats`. `undefined` (every other caller) leaves the relay
 * exactly as it's always behaved — no NATS connection is ever attempted.
 *
 * `withReconcileLoop: true` (requires `withEventRelay: true` — the loop needs `boss`) starts the
 * M3 coordination engine exactly as main.ts does: a `SubprocessPluginHost` with one fake-executor
 * instance, plus the self-re-scheduling reconcile tick. `pluginHostOptions` lets a test tighten
 * timeouts/backoff (the production defaults are tuned for real workloads, not fast test
 * iteration) and `reconcileTickIntervalOverrideMs` isn't exposed — tests instead just poll
 * (`waitUntil`, coordination.integration.test.ts) since `RECONCILE_TICK_INTERVAL_SECONDS` (1s) is
 * already fast enough not to dominate test runtime.
 */
export async function listenTestServer(
  opts: {
    withEventRelay?: boolean;
    natsUrl?: string;
    withReconcileLoop?: boolean;
    pluginHostOptions?: PluginHostOptions;
  } = {}
): Promise<ListeningTestServer> {
  const server = await buildTestServer();
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });

  let boss: PgBoss | undefined;
  let relay: OutboxRelayHandle | undefined;
  let relayPool: pg.Pool | undefined;
  let natsFanout: NatsFanoutHandle | undefined;
  let pluginHost: SubprocessPluginHost | undefined;
  let reconcileLoop: ReconcileLoopHandle | undefined;
  if (opts.withEventRelay) {
    boss = await startPgBoss(server.deps.config.pgBossDatabaseUrl);
    if (opts.natsUrl) {
      natsFanout = await connectNatsFanout(opts.natsUrl);
    }
    // A separate pool from the app's own `deps.db` connection — mirrors main.ts's `pool`, which
    // the relay also owns independently of the request-serving pool.
    relayPool = createPool(server.deps.config.runtimeDatabaseUrl);
    relay = startOutboxRelay(relayPool, server.deps.config.runtimeDatabaseUrl, boss, natsFanout);

    if (opts.withReconcileLoop) {
      const stateDir = await mkdtemp(join(tmpdir(), "scp-test-fake-executor-"));
      pluginHost = new SubprocessPluginHost(opts.pluginHostOptions);
      await pluginHost.start([
        {
          id: DEFAULT_EXECUTOR_INSTANCE_ID,
          module: DEFAULT_EXECUTOR_MODULE,
          orgId: SHARED_PLUGIN_INSTANCE_ORG_ID,
          domainId: SHARED_PLUGIN_INSTANCE_DOMAIN_ID,
          config: { statePath: join(stateDir, "fake-executor-state.json"), autoSucceedAfterMs: 50 }
        }
      ]);
      reconcileLoop = await startReconcileLoop(boss, server.deps.db, pluginHost);
    }
  }

  return {
    ...server,
    baseUrl: `${address}/api/v1`,
    pluginHost,
    close: async () => {
      await reconcileLoop?.stop();
      await pluginHost?.stop();
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
