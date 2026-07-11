import { deriveRuntimeDatabaseUrl } from "./db/provision.js";
import { generateMasterKeyBase64, parseMasterKeyBase64 } from "./secrets/crypto.js";

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
  /**
   * The connection pg-boss itself uses to manage its own `pgboss` schema (job/queue tables) —
   * authenticates as the schema-scoped `scp_pgboss` login role (NOSUPERUSER, NOBYPASSRLS, owns
   * only the `pgboss` schema, no grants on `public` at all — drizzle/0008_pgboss_role.sql). M3
   * tracked security follow-up: pg-boss previously ran on `databaseUrl` (the admin/superuser
   * connection) to perform its internal schema migrations at boot; this closes that gap the same
   * way `runtimeDatabaseUrl` closed it for the request-serving pool. Defaults to `databaseUrl`
   * with the user swapped to `scp_pgboss` (same password); override with
   * SCP_PGBOSS_DATABASE_URL when the role is managed externally.
   */
  pgBossDatabaseUrl: string;
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
  /**
   * `EventBus` backend toggle (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md M3 item 8).
   * `"postgres"` (the default — `SCP_EVENT_BUS_BACKEND` unset) is the untouched, zero-new-dependency
   * path: the transactional outbox relay fans out to pg-boss + SSE only, exactly as it always has.
   * `"nats"` is an explicit opt-in that ALSO fans relayed outbox events out to NATS JetStream
   * (events/nats-fanout.ts) — never a *required* dependency (CLAUDE.md principle 4). `publish()`
   * itself (events/event-bus.ts) is identical for both backends; see that file's doc comment.
   */
  eventBus: {
    backend: "postgres" | "nats";
    /** Required when `backend === "nats"`; validated below. e.g. `nats://localhost:4222`. */
    natsUrl?: string;
  };
  /**
   * AES-256-GCM root key for the `secrets` table (M7, secrets/crypto.ts) — org-supplied plugin
   * credentials (GitHub App private key, ArgoCD token, managed-IaC infra creds) are encrypted
   * under this key, never stored in plaintext. `SCP_SECRETS_MASTER_KEY` (base64, 32 bytes) SHOULD
   * be set explicitly and kept stable across restarts/deploys — every secret encrypted under one
   * value becomes undecryptable if it changes. Mirrors `cookieSecret`'s "generate an ephemeral one
   * with a loud warning if unset" fallback (five-minute-value / self-hosting-first: the compose
   * eval stack and a first `pnpm dev` must still boot with zero required env vars) rather than
   * failing boot — the operational consequence (secrets configured before a restart become
   * unreadable after one) is a one-line warning away from being obvious, not a silent landmine.
   */
  secretsMasterKey: Buffer;
  secretsMasterKeyWasGenerated: boolean;
  /**
   * M8 hardening (BUILD_AND_TEST.md §8 M8 item 1, "hardened defaults" — least privilege): when
   * `true`, `main.ts` skips Phase 1 entirely (no admin-connection migrations/role-provisioning on
   * boot) and connects straight in as `runtimeDatabaseUrl`/`pgBossDatabaseUrl`. Set by the Helm
   * chart's `api`/`worker` Deployments — ONLY the migrations Job (`migrate-bin.ts`, run as a
   * pre-upgrade hook with the admin `DATABASE_URL`) ever holds admin/superuser-capable database
   * credentials in that deployment shape; `api`/`worker` pods hold only the already-least-
   * privileged `scp_app`/`scp_pgboss` role credentials. Default `false` preserves EVERY existing
   * deployment shape unchanged (compose, `pnpm dev`, every E2E script): every pod still
   * self-migrates+self-provisions on its own boot, exactly as it always has.
   */
  skipMigrations: boolean;
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

/**
 * `postgres` (SCP_EVENT_BUS_BACKEND unset) is the default — no NATS connection is ever attempted.
 * Opting into `nats` without `SCP_NATS_URL` is a misconfiguration worth failing loudly at boot
 * (mirrors `loadOidcConfig` above) rather than silently falling back to Postgres-only fan-out or
 * deferring the failure to the first missed event. Actual reachability isn't checked here (this
 * function does no I/O) — that happens when the relay connects the JetStream client at boot
 * (main.ts) / per-test (test-support/harness.ts), where a failed `connect()` is likewise left to
 * throw rather than being caught and swallowed.
 */
function loadEventBusConfig(env: NodeJS.ProcessEnv): ServerConfig["eventBus"] {
  const backend = env.SCP_EVENT_BUS_BACKEND ?? "postgres";
  if (backend !== "postgres" && backend !== "nats") {
    throw new Error(`SCP_EVENT_BUS_BACKEND must be "postgres" or "nats" (got "${backend}")`);
  }
  const natsUrl = env.SCP_NATS_URL;
  if (backend === "nats" && !natsUrl) {
    throw new Error("SCP_EVENT_BUS_BACKEND=nats requires SCP_NATS_URL to be set");
  }
  return { backend, natsUrl };
}

function loadSecretsMasterKey(env: NodeJS.ProcessEnv): { key: Buffer; wasGenerated: boolean } {
  const raw = env.SCP_SECRETS_MASTER_KEY;
  if (raw) {
    try {
      return { key: parseMasterKeyBase64(raw), wasGenerated: false };
    } catch (err) {
      throw new Error(
        `SCP_SECRETS_MASTER_KEY is set but invalid: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { key: parseMasterKeyBase64(generateMasterKeyBase64()), wasGenerated: true };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8080);
  const host = env.HOST ?? "0.0.0.0";
  const databaseUrl = env.DATABASE_URL ?? "postgres://scp:scp@localhost:5432/scp";
  const secretsMasterKey = loadSecretsMasterKey(env);
  return {
    port,
    host,
    databaseUrl,
    runtimeDatabaseUrl: env.SCP_RUNTIME_DATABASE_URL ?? deriveRuntimeDatabaseUrl(databaseUrl),
    pgBossDatabaseUrl:
      env.SCP_PGBOSS_DATABASE_URL ?? deriveRuntimeDatabaseUrl(databaseUrl, "scp_pgboss"),
    role: (env.SCP_ROLE as ServerConfig["role"] | undefined) ?? "all",
    bootstrapOrgName: env.SCP_BOOTSTRAP_ORG ?? "default",
    bootstrapAdminUsername: env.SCP_BOOTSTRAP_ADMIN_USERNAME ?? "admin",
    cookieSecret: env.SCP_COOKIE_SECRET ?? randomSecret(),
    internalBaseUrl: env.SCP_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}/api/v1`,
    seedDemo: env.SCP_SEED_DEMO === "true",
    oidc: loadOidcConfig(env),
    eventBus: loadEventBusConfig(env),
    secretsMasterKey: secretsMasterKey.key,
    secretsMasterKeyWasGenerated: secretsMasterKey.wasGenerated,
    skipMigrations: env.SCP_SKIP_MIGRATIONS === "true"
  };
}
