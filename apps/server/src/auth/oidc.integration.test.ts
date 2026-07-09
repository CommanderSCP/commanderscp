import { randomUUID } from "node:crypto";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { orgs, users } from "../db/schema.js";
import { ensureBootstrapAdmin } from "./local-auth.js";
import { testDatabaseUrl, testRuntimeDatabaseUrl } from "../test-support/harness.js";
import type { AppDeps } from "../types.js";

// Fixed, known port (BUILD_AND_TEST.md §8 M2 DoD (c)) so the Keycloak client's `redirectUris` can
// be registered BEFORE the SCP test server starts listening.
const SCP_PORT = 18099;
const SCP_BASE_URL = `http://127.0.0.1:${SCP_PORT}/api/v1`;
const SCP_REDIRECT_URI = `http://127.0.0.1:${SCP_PORT}/api/v1/auth/oidc/callback`;
const KEYCLOAK_REALM = "scp-test";
const KEYCLOAK_CLIENT_ID = "scp-cli";
const KEYCLOAK_ADMIN_USER = "admin";
const KEYCLOAK_ADMIN_PASSWORD = "admin";
const KEYCLOAK_TEST_USER = "oidc-e2e-user";
const KEYCLOAK_TEST_PASSWORD = "oidc-e2e-password";

/** Accumulates `Set-Cookie` response headers and replays them as a `Cookie` request header — a
 * minimal hand-rolled cookie jar for the raw-`fetch` PKCE dance below (BUILD_AND_TEST.md §8 M2
 * DoD (c)). SCP's own PKCE/session cookies and Keycloak's login-session cookies are independent
 * jars against different hosts — never conflated here. */
class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;
      this.jar.set(pair.slice(0, eqIndex).trim(), pair.slice(eqIndex + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function keycloakAdminToken(kcBaseUrl: string): Promise<string> {
  const res = await fetch(`${kcBaseUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: KEYCLOAK_ADMIN_USER,
      password: KEYCLOAK_ADMIN_PASSWORD
    })
  });
  if (!res.ok)
    throw new Error(`keycloak admin token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function keycloakAdminApi(
  kcBaseUrl: string,
  adminToken: string,
  path: string,
  body: unknown
): Promise<void> {
  const res = await fetch(`${kcBaseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`keycloak admin API ${path} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Generic OIDC (Authorization Code + PKCE via `openid-client`) round-trip against a CONTAINERIZED
 * Keycloak fixture — BUILD_AND_TEST.md §8 M2 DoD (c), non-negotiable. Drives the real PKCE dance
 * with raw `fetch` + manual `redirect: 'manual'` (no browser, no keycloak-admin-client SDK).
 */
describe("generic OIDC: Authorization Code + PKCE round-trip against Keycloak", () => {
  let container: StartedTestContainer;
  let kcBaseUrl: string;
  let issuer: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let deps: AppDeps;
  let orgId: string;
  let orgName: string;

  beforeAll(async () => {
    container = await new GenericContainer("quay.io/keycloak/keycloak:26.0")
      .withExposedPorts(8080)
      .withCommand(["start-dev"])
      .withEnvironment({
        KC_BOOTSTRAP_ADMIN_USERNAME: KEYCLOAK_ADMIN_USER,
        KC_BOOTSTRAP_ADMIN_PASSWORD: KEYCLOAK_ADMIN_PASSWORD
      })
      .withWaitStrategy(Wait.forLogMessage(/Running the server in development mode/))
      .withStartupTimeout(180_000)
      .start();

    kcBaseUrl = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
    issuer = `${kcBaseUrl}/realms/${KEYCLOAK_REALM}`;

    const adminToken = await keycloakAdminToken(kcBaseUrl);

    await keycloakAdminApi(kcBaseUrl, adminToken, "/admin/realms", {
      realm: KEYCLOAK_REALM,
      enabled: true
    });

    // Public client: no client secret, standard (Authorization Code) flow, redirect URI must
    // exactly match what our SCP test server (fixed SCP_PORT above) will present.
    await keycloakAdminApi(kcBaseUrl, adminToken, `/admin/realms/${KEYCLOAK_REALM}/clients`, {
      clientId: KEYCLOAK_CLIENT_ID,
      publicClient: true,
      standardFlowEnabled: true,
      redirectUris: [SCP_REDIRECT_URI],
      enabled: true
    });

    // firstName/lastName avoid Keycloak 26's default VERIFY_PROFILE required action, which would
    // otherwise intercept the login with an extra form instead of redirecting straight back.
    await keycloakAdminApi(kcBaseUrl, adminToken, `/admin/realms/${KEYCLOAK_REALM}/users`, {
      username: KEYCLOAK_TEST_USER,
      firstName: "OIDC",
      lastName: "E2E",
      email: `${KEYCLOAK_TEST_USER}@example.test`,
      emailVerified: true,
      enabled: true,
      credentials: [{ type: "password", value: KEYCLOAK_TEST_PASSWORD, temporary: false }]
    });

    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value",
      SCP_BOOTSTRAP_ORG: `oidc-e2e-${randomUUID()}`,
      SCP_OIDC_ISSUER: issuer,
      SCP_OIDC_CLIENT_ID: KEYCLOAK_CLIENT_ID,
      SCP_OIDC_REDIRECT_URI: SCP_REDIRECT_URI
    });
    const pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    deps = { db, config };
    app = await buildApp(deps, { logger: false });
    await app.ready();
    await app.listen({ port: SCP_PORT, host: "127.0.0.1" });

    // JIT provisioning needs the bootstrap org (+ its graph root object) to already exist —
    // mirrors what boot-time `ensureBootstrapAdmin` does in production; the returned local-auth
    // admin credentials aren't used by this test at all.
    const bootstrap = await ensureBootstrapAdmin(
      deps.db,
      { orgName: config.bootstrapOrgName, adminUsername: "oidc-e2e-bootstrap-admin" },
      { info: () => undefined, warn: () => undefined }
    );
    orgId = bootstrap.orgId;
    orgName = config.bootstrapOrgName;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  /** Drives one full PKCE round-trip against the running Keycloak fixture; returns the SCP session cookie header value. */
  async function loginViaOidc(): Promise<string> {
    const scpCookies = new CookieJar();

    // (a) GET our own server's /oidc/login — expect a 302 to Keycloak's authorize endpoint, and
    // capture the PKCE/state cookie SCP just set.
    const loginRes = await fetch(`${SCP_BASE_URL}/auth/oidc/login`, { redirect: "manual" });
    expect(loginRes.status).toBe(302);
    scpCookies.absorb(loginRes);
    const authorizeUrl = loginRes.headers.get("location");
    expect(authorizeUrl).toBeTruthy();
    expect(authorizeUrl).toContain(
      `${kcBaseUrl}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`
    );

    // (b) GET that Keycloak URL with a FRESH Keycloak-side cookie jar — 200 HTML login form.
    const kcCookies = new CookieJar();
    const kcLoginPageRes = await fetch(authorizeUrl as string, { redirect: "manual" });
    expect(kcLoginPageRes.status).toBe(200);
    kcCookies.absorb(kcLoginPageRes);
    const html = await kcLoginPageRes.text();
    const actionMatch = /action="([^"]+)"/.exec(html);
    expect(actionMatch).toBeTruthy();
    const actionUrl = (actionMatch as RegExpExecArray)[1]?.replace(/&amp;/g, "&") as string;

    // (c) POST credentials to Keycloak's login form, forwarding Keycloak's cookies — 302 back to
    // our own redirect_uri with `state`/`code`.
    const submitRes = await fetch(actionUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: kcCookies.header()
      },
      body: new URLSearchParams({
        username: KEYCLOAK_TEST_USER,
        password: KEYCLOAK_TEST_PASSWORD
      })
    });
    expect(submitRes.status).toBe(302);
    const callbackUrl = submitRes.headers.get("location");
    expect(callbackUrl).toBeTruthy();
    expect(callbackUrl).toContain(SCP_REDIRECT_URI);

    // (d) GET that callback against OUR server, forwarding the PKCE cookie from (a) — NOT
    // Keycloak's cookies. Expect the exchange + JIT-provisioning to succeed: 302 to '/' with a
    // fresh `scp_session` cookie.
    const callbackRes = await fetch(callbackUrl as string, {
      redirect: "manual",
      headers: { cookie: scpCookies.header() }
    });
    expect(callbackRes.status, await callbackRes.text().catch(() => "")).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("/");
    scpCookies.absorb(callbackRes);

    const sessionCookieHeader = scpCookies.header();
    expect(sessionCookieHeader).toContain("scp_session=");
    return sessionCookieHeader;
  }

  it("full round-trip: login redirect → Keycloak auth → callback → working session; Viewer-only JIT-provisioned user; no duplicate row on a second login", async () => {
    const sessionCookieHeader = await loginViaOidc();

    // (e) Use the resulting session cookie to call a real authenticated SCP endpoint.
    const readRes = await fetch(`${SCP_BASE_URL}/domains`, {
      headers: { cookie: sessionCookieHeader }
    });
    expect(readRes.status, await readRes.text().catch(() => "")).toBe(200);

    // (f) JIT-provisioned users get the built-in Viewer role only — read succeeds, write 403s.
    const writeRes = await fetch(`${SCP_BASE_URL}/domains`, {
      method: "POST",
      headers: { cookie: sessionCookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "should-be-forbidden-for-a-jit-viewer" })
    });
    expect(writeRes.status).toBe(403);

    // Exactly one OIDC-provisioned user in this org after the first login.
    const afterFirstLogin = await deps.db.query.users.findMany({
      where: and(eq(users.orgId, orgId), isNotNull(users.oidcSubject))
    });
    expect(afterFirstLogin).toHaveLength(1);
    const provisionedUserId = afterFirstLogin[0]?.id;

    // Logging in a SECOND time with the SAME Keycloak user must NOT create a second `users` row.
    const secondSessionCookieHeader = await loginViaOidc();
    const afterSecondLogin = await deps.db.query.users.findMany({
      where: and(eq(users.orgId, orgId), isNotNull(users.oidcSubject))
    });
    expect(afterSecondLogin).toHaveLength(1);
    expect(afterSecondLogin[0]?.id).toBe(provisionedUserId);

    // The second login's session is independently valid too.
    const secondReadRes = await fetch(`${SCP_BASE_URL}/domains`, {
      headers: { cookie: secondSessionCookieHeader }
    });
    expect(secondReadRes.status).toBe(200);

    // Sanity: the org itself is the one this test bootstrapped.
    const org = await deps.db.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
    expect(org?.name).toBe(orgName);
  }, 120_000);

  it("returns 404 when OIDC is not configured", async () => {
    // A second, deliberately OIDC-less app instance — proves local-auth-only/air-gapped
    // deployments never see these routes turn into a crash (CLAUDE.md: OIDC must be optional).
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value"
    });
    const pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    const noOidcApp = await buildApp({ db, config }, { logger: false });
    await noOidcApp.ready();
    try {
      const res = await noOidcApp.inject({ method: "GET", url: "/api/v1/auth/oidc/login" });
      expect(res.statusCode).toBe(404);
    } finally {
      await noOidcApp.close();
      await pool.end();
    }
  });
});
