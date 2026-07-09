import { deriveRuntimeDatabaseUrl } from "./db/provision.js";

export interface ServerConfig {
  port: number;
  host: string;
  /**
   * Admin/bootstrap connection (compose POSTGRES_USER) — used ONLY by the migration runner and
   * boot-time runtime-role provisioning (db/provision.ts), never by request-serving code
   * (PR #4 security review, CRITICAL 3).
   */
  databaseUrl: string;
  /**
   * The connection the application pool actually uses: authenticates as the least-privileged
   * `scp_app` login role (NOSUPERUSER, NOBYPASSRLS), so RLS holds independently of application
   * code. Defaults to `databaseUrl` with the user swapped to `scp_app` (same password);
   * override with SCP_RUNTIME_DATABASE_URL when the role is managed externally.
   */
  runtimeDatabaseUrl: string;
  role: "all" | "api" | "worker";
  bootstrapOrgName: string;
  bootstrapAdminUsername: string;
  cookieSecret: string;
  /** Base URL the server uses to call its own public API (UI SSR dogfoods the SDK). */
  internalBaseUrl: string;
  /**
   * Boot-time demo seed (BUILD_AND_TEST.md §5.3, seed.ts's `loginAndSeedDemoData`) — off by
   * default; the eval compose stack (`deploy/compose/docker-compose.yml`) turns it on. Never
   * required for the platform to function: a failed/skipped seed only means the demo graph isn't
   * there, never a boot failure (main.ts logs and continues).
   */
  seedDemo: boolean;
  /**
   * Generic OIDC (Authorization Code + PKCE via `openid-client`) — DESIGN.md §7, M2 stage 2 Part
   * B. `undefined` (the default — unset `SCP_OIDC_ISSUER`) means OIDC is DISABLED: the
   * `/auth/oidc/*` routes 404 rather than crash, and local-auth keeps working unmodified
   * (CLAUDE.md: air-gap/self-hosting is first-class — OIDC must be optional, never required).
   * One config shape covers Okta/Entra/Keycloak/Ping via discovery — no per-provider special
   * casing (auth/oidc.ts).
   */
  oidc?: {
    issuer: string;
    clientId: string;
    /** Public clients (no client secret — e.g. the CLI's own future native-app flow) may omit this. */
    clientSecret?: string;
    /** Must exactly match what's registered at the IdP. */
    redirectUri: string;
    scopes: string;
  };
}

function randomSecret(): string {
  // Node's global crypto (WebCrypto) is available without an extra import.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

/**
 * `undefined` (SCP_OIDC_ISSUER unset) is the default — OIDC disabled, local-auth-only. Setting
 * the issuer without a client id/redirect URI is a misconfiguration worth failing loudly at boot
 * rather than silently 404ing every OIDC route later.
 */
function loadOidcConfig(env: NodeJS.ProcessEnv): ServerConfig["oidc"] {
  const issuer = env.SCP_OIDC_ISSUER;
  if (!issuer) return undefined;

  const clientId = env.SCP_OIDC_CLIENT_ID;
  const redirectUri = env.SCP_OIDC_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error(
      "SCP_OIDC_ISSUER is set but SCP_OIDC_CLIENT_ID and/or SCP_OIDC_REDIRECT_URI are missing"
    );
  }

  return {
    issuer,
    clientId,
    clientSecret: env.SCP_OIDC_CLIENT_SECRET,
    redirectUri,
    scopes: env.SCP_OIDC_SCOPES ?? "openid profile email"
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8080);
  const host = env.HOST ?? "0.0.0.0";
  const databaseUrl = env.DATABASE_URL ?? "postgres://scp:scp@localhost:5432/scp";
  return {
    port,
    host,
    databaseUrl,
    runtimeDatabaseUrl: env.SCP_RUNTIME_DATABASE_URL ?? deriveRuntimeDatabaseUrl(databaseUrl),
    role: (env.SCP_ROLE as ServerConfig["role"] | undefined) ?? "all",
    bootstrapOrgName: env.SCP_BOOTSTRAP_ORG ?? "default",
    bootstrapAdminUsername: env.SCP_BOOTSTRAP_ADMIN_USERNAME ?? "admin",
    cookieSecret: env.SCP_COOKIE_SECRET ?? randomSecret(),
    internalBaseUrl: env.SCP_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}/api/v1`,
    seedDemo: env.SCP_SEED_DEMO === "true",
    oidc: loadOidcConfig(env)
  };
}
