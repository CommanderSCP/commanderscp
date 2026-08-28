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
const SCP_APP_ROLE = "SCP.OrgAdmin";
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

/** Keycloak admin GET — the POST helper above returns no body, and the role/user/client ids this
 *  fixture needs are only discoverable by reading them back. */
async function keycloakAdminGet(
  baseUrl: string,
  token: string,
  path: string
): Promise<Record<string, string>[] & Record<string, string>> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`keycloak GET ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as never;
}

/** The client's internal UUID, which protocol-mapper URLs need — distinct from its `clientId`. */
async function clientUuid(baseUrl: string, token: string): Promise<string> {
  const found = await keycloakAdminGet(
    baseUrl,
    token,
    `/admin/realms/${KEYCLOAK_REALM}/clients?clientId=${KEYCLOAK_CLIENT_ID}`
  );
  return (found as unknown as Array<{ id: string }>)[0]!.id;
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
  let kcUserId: string;
  let bootstrapAdminToken: string;
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

    // ------------------------------------------------------------------------------------------
    // THE ENTRA APP-ROLE SHAPE, reproduced on Keycloak (role-model.md — SSO groups)
    // ------------------------------------------------------------------------------------------
    // Entra emits assigned APP ROLES as a `roles` claim whose values you choose. Keycloak does the
    // same thing under a different name: a realm role plus a `oidc-usermodel-realm-role-mapper`
    // that writes them into the ID TOKEN. `id.token.claim: "true"` is the load-bearing setting —
    // without it the role lands in the ACCESS token only, `tokens.claims()` never sees it, and the
    // sync silently reconciles to nothing. That is the exact silent-strip this feature refuses.
    await keycloakAdminApi(kcBaseUrl, adminToken, `/admin/realms/${KEYCLOAK_REALM}/roles`, {
      name: SCP_APP_ROLE
    });
    const realmRole = await keycloakAdminGet(
      kcBaseUrl,
      adminToken,
      `/admin/realms/${KEYCLOAK_REALM}/roles/${SCP_APP_ROLE}`
    );
    const kcUsers = await keycloakAdminGet(
      kcBaseUrl,
      adminToken,
      `/admin/realms/${KEYCLOAK_REALM}/users?username=${KEYCLOAK_TEST_USER}`
    );
    kcUserId = (kcUsers as unknown as Array<{ id: string }>)[0]!.id;
    await keycloakAdminApi(
      kcBaseUrl,
      adminToken,
      `/admin/realms/${KEYCLOAK_REALM}/users/${kcUserId}/role-mappings/realm`,
      [{ id: realmRole.id, name: realmRole.name }]
    );
    await keycloakAdminApi(
      kcBaseUrl,
      adminToken,
      `/admin/realms/${KEYCLOAK_REALM}/clients/${await clientUuid(kcBaseUrl, adminToken)}/protocol-mappers/models`,
      {
        name: "realm-roles-to-id-token",
        protocol: "openid-connect",
        protocolMapper: "oidc-usermodel-realm-role-mapper",
        config: {
          "claim.name": "roles",
          "jsonType.label": "String",
          multivalued: "true",
          "id.token.claim": "true",
          "access.token.claim": "true"
        }
      }
    );

    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value",
      SCP_BOOTSTRAP_ORG: `oidc-e2e-${randomUUID()}`,
      SCP_OIDC_ISSUER: issuer,
      SCP_OIDC_CLIENT_ID: KEYCLOAK_CLIENT_ID,
      SCP_OIDC_REDIRECT_URI: SCP_REDIRECT_URI,
      // Explicit even though `roles` is the default, so this fixture states the contract it tests.
      SCP_OIDC_ROLE_CLAIM: "roles"
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

    // The SSO-groups case below needs an authenticated ADMIN to author the mapped group and bind a
    // role to it — the human half of the feature, which no IdP performs. Logging in through the
    // real local-auth door rather than minting a session directly, so the fixture uses the same
    // path an operator would.
    const adminLogin = await fetch(`${SCP_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "oidc-e2e-bootstrap-admin",
        password: bootstrap.oneTimePassword
      })
    });
    if (!adminLogin.ok) throw new Error(`bootstrap admin login failed: ${adminLogin.status}`);
    bootstrapAdminToken = ((await adminLogin.json()) as { token: string }).token;
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

  it("SSO GROUPS END TO END: an app-role claim in a REAL login grants the mapped group's role", async () => {
    // ------------------------------------------------------------------------------------------
    // THE WIRING THIS FILE EXISTS TO PROVE, and which nothing else could.
    // ------------------------------------------------------------------------------------------
    // `identity-sync.integration.test.ts` calls `syncExternalGroupMembership` DIRECTLY, so it
    // proves reconciliation and proves nothing about whether a login ever reaches it. The chain
    // handleCallback -> claims.raw -> claimValuesFrom(config.roleClaim) -> sync was, until this
    // test, verified only by reading the source. Delete the sync call from `routes/oidc.ts` and
    // every other test in the suite stays green — which is this repo's dominant failure class
    // wearing an SSO costume.
    //
    // Keycloak stands in for Entra deliberately: same generic-OIDC seam, same `roles` claim, no
    // per-provider code. What is NOT covered is Entra's own quirks — the groups-claim overage in
    // particular — which no local fixture can reproduce.
    const asAdmin = {
      authorization: `Bearer ${bootstrapAdminToken}`,
      "content-type": "application/json"
    };

    // A group mapped to the claim value Keycloak will emit, carrying a real role.
    const groupRes = await fetch(`${SCP_BASE_URL}/groups`, {
      method: "POST",
      headers: asAdmin,
      body: JSON.stringify({
        name: `idp-mapped-${randomUUID()}`,
        properties: { externalIdentity: { claimValue: SCP_APP_ROLE } }
      })
    });
    // Read the body ONCE. `expect(res.status, await res.text())` consumes it eagerly — the message
    // argument is evaluated whether or not the assertion fails — and the following `.json()` then
    // throws "Body is unusable". Cost one run to find.
    const groupBody = await groupRes.text();
    expect(groupRes.status, groupBody).toBe(201);
    const group = JSON.parse(groupBody) as { id: string };

    const rolesRes = await fetch(`${SCP_BASE_URL}/roles`, { headers: asAdmin });
    const roles = (await rolesRes.json()) as { items: Array<{ id: string; name: string }> };
    const orgAdmin = roles.items.find((r) => r.name === "OrgAdmin");
    expect(orgAdmin, "OrgAdmin must be seeded (drizzle/0099)").toBeDefined();

    const bindRes = await fetch(`${SCP_BASE_URL}/role-bindings`, {
      method: "POST",
      headers: asAdmin,
      body: JSON.stringify({
        subjectId: group.id,
        roleId: orgAdmin!.id,
        scopeObjectId: orgId,
        reason: "idp-mapped admins",
        acknowledgedPrincipalIds: []
      })
    });
    const bindBody = await bindRes.text();
    expect(bindRes.status, bindBody).toBe(201);

    // A REAL PKCE login against the real Keycloak, whose ID token now carries roles: ["SCP.OrgAdmin"].
    const sessionCookieHeader = await loginViaOidc();

    const effective = await fetch(`${SCP_BASE_URL}/authz/effective?scopeObjectId=${orgId}`, {
      headers: { cookie: sessionCookieHeader }
    });
    const effectiveBody = await effective.text();
    expect(effective.status, effectiveBody).toBe(200);
    const body = JSON.parse(effectiveBody) as { permissions: string[] };

    // The whole feature in one assertion: a claim the operator never typed into SCP, carried by a
    // real IdP through a real login, resolving to a permission at a real door. `policy:write` is
    // OrgAdmin's and is NOT held by the Viewer floor every OIDC user is provisioned with, so this
    // cannot pass by way of the JIT binding.
    expect(body.permissions).toContain("policy:write");
    expect(body.permissions).toContain("role_binding:write");
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
