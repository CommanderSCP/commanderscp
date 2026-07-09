import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { ensureBootstrapAdmin } from "../auth/local-auth.js";
import type { AppDeps } from "../types.js";

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
}

/**
 * Same as `buildTestServer`, but actually bound to a real loopback port (`app.inject()` doesn't
 * open a socket) — needed for anything that speaks real HTTP to the server: the SDK's
 * `fetch`-based client and the CLI subprocess (test-support/cli-runner.ts).
 */
export async function listenTestServer(): Promise<ListeningTestServer> {
  const server = await buildTestServer();
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  return { ...server, baseUrl: `${address}/api/v1` };
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
