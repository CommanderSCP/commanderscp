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

/** Admin/superuser URL — set by test-support/global-setup.ts. See docs/test-support.md §9. */
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

/** Schema-scoped `scp_pgboss` login-role URL. See docs/test-support.md §10. */
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

/** Builds an app against the shared Testcontainers Postgres. See docs/test-support.md §11. */
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
    // M21.7 follow-up: the PROCESS axis. See docs/test-support.md §12.
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

/** Same, but bound to a real loopback port for real HTTP. See docs/test-support.md §13. */
export async function listenTestServer(
  opts: {
    withEventRelay?: boolean;
    natsUrl?: string;
    withReconcileLoop?: boolean;
    /** Starts the `SubprocessPluginHost`. See docs/test-support.md §14. */
    withPluginHost?: boolean;
    pluginHostOptions?: PluginHostOptions;
    watchdogIntervalSeconds?: number;
    /** Merged into the shared fake-executor instance's config. See docs/test-support.md §15. */
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
    // RAW `mkdtemp`, DELIBERATELY NOT `@scp/test-tmpdir`. See docs/test-support.md §16.
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

/** A fresh org and bootstrap admin, logged in through the API. See docs/test-support.md §17. */
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
  /** Built-in role name. See docs/test-support.md §18. */
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

/** Creates a NON-admin user in an existing test org. See docs/test-support.md §19. */
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

/** Writes a role binding with an effect the constraint bans. See docs/test-support.md §20. */
export async function insertMalformedEffectRoleBinding(opts: {
  orgId: string;
  subjectId: string;
  roleId: string;
  scopeObjectId: string;
  effect: string;
}): Promise<string> {
  if (opts.effect === "allow" || opts.effect === "deny") {
    throw new Error(
      `insertMalformedEffectRoleBinding is for MALFORMED effects only — '${opts.effect}' is legal and must be written through the ordinary path`
    );
  }
  const id = uuidv7();
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    // The DROP takes ACCESS EXCLUSIVE on `role_bindings`. Bounded so that a lingering
    // idle-in-transaction connection from the test server's pool surfaces as a 55P03 naming this
    // statement, rather than as the suite's 60s hook timeout naming nothing.
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query('ALTER TABLE role_bindings DROP CONSTRAINT "role_bindings_effect_check"');
    await client.query(
      `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, opts.orgId, opts.subjectId, opts.roleId, opts.scopeObjectId, opts.effect]
    );
    await client.query(
      `ALTER TABLE role_bindings ADD CONSTRAINT "role_bindings_effect_check"
       CHECK (effect IN ('allow', 'deny')) NOT VALID`
    );
    await client.query("COMMIT");

    const readBack = await client.query<{ effect: string }>(
      `SELECT effect FROM role_bindings WHERE id = $1`,
      [id]
    );
    if (readBack.rowCount !== 1 || readBack.rows[0]!.effect !== opts.effect) {
      throw new Error(
        `insertMalformedEffectRoleBinding did not land: expected one row ${id} with effect ${JSON.stringify(opts.effect)}, read back ${JSON.stringify(readBack.rows)}. Every assertion resting on this row would have passed VACUOUSLY.`
      );
    }

    // The constraint has to be back AND biting, or the rest of the file runs against an
    // unconstrained table. `NOT VALID` is easy to mis-remember as "disabled"; this measures it
    // instead of trusting the memory.
    await client.query("BEGIN");
    let probeAccepted = false;
    try {
      await client.query(
        `INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NOT-A-LEGAL-EFFECT')`,
        [opts.orgId, opts.subjectId, opts.roleId, opts.scopeObjectId]
      );
      probeAccepted = true;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "23514") throw err;
    } finally {
      await client.query("ROLLBACK");
    }
    if (probeAccepted) {
      throw new Error(
        "insertMalformedEffectRoleBinding left `role_bindings_effect_check` NOT ENFORCING — the table is unconstrained for the rest of this file"
      );
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  return id;
}

/** A raw client authenticated as the app login role. See docs/test-support.md §21. */
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

/** A raw client authenticated as the pg-boss login role. See docs/test-support.md §22. */
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

/** Polls until the check passes or the deadline elapses. See docs/test-support.md §23. */
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

/** The barrier every SSE test needs before it publishes. See docs/test-support.md §24. */
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

/** How long one reconcile tick may take, for sizing deadlines. See docs/test-support.md §25. */
export const RECONCILE_TICK_BUDGET_MS = 6_000;

/** A deadline, in ms, for a wait whose chain needs `ticks` reconcile ticks to complete. */
export function reconcileTicks(ticks: number): number {
  return ticks * RECONCILE_TICK_BUDGET_MS;
}

/** Reads the engine-private reconcile bookkeeping. See docs/test-support.md §26. */
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

/** Still parked, asserted from a positive signal not a sleep. See docs/test-support.md §27. */
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

/** Waits for the run that authorizes the accept edge. See docs/test-support.md §28. */
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

/** The companion positive signal for a failed wave. See docs/test-support.md §29. */
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

/** M12 P5a: components can no longer be created bare. See docs/test-support.md §30. */
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

/** M12 P5a: create an ORPHAN component. See docs/test-support.md §31. */
export async function createOrphanComponent(
  server: TestServer,
  org: TestOrg,
  name: string
): Promise<GraphObject> {
  return withTenantTx(server.deps.db, org.orgId, (tx) =>
    createObject(tx, {
      orgId: org.orgId,
      typeId: "component",
      actorObjectId: org.orgId,
      requestId: `orphan-${name}`,
      name
    })
  );
}
