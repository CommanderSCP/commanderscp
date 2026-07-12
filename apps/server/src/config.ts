import { readFileSync } from "node:fs";
import { deriveRuntimeDatabaseUrl } from "./db/provision.js";
import { generateMasterKeyBase64, parseMasterKeyBase64 } from "./secrets/crypto.js";
import { isCrlExpired, parseCrlNextUpdate } from "./federation/crl-parse.js";

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
  /**
   * Defensive graph guardrail (adversarial review of PR #15 — graph/query-timeout.ts's module
   * doc): bounds every `/graph/traverse` and `/graph/query/:name` call to this many milliseconds
   * via Postgres `statement_timeout`, so a pathological shared-component topology (the
   * `impact-of` recursive CTE's measured fan-in^depth blowup — 7+ minutes then disk exhaustion on
   * one real topology) fails cleanly (a 408) instead of hanging a worker/connection or exhausting
   * disk. Does not change query semantics — the CTE's own node-dedup fix remains a separate,
   * pending owner decision. `SCP_GRAPH_QUERY_TIMEOUT_MS`, default 5000 (a few seconds — generous
   * for any legitimate depth-≤10 query against a normal topology, per the load-test numbers in
   * the M8 PR body, while still bounding the pathological case).
   */
  graphQueryStatementTimeoutMs: number;
  /**
   * M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — OPTIONAL, fail-closed in-app mTLS
   * for the three federation transport routes (`routes/federation.ts`'s `/exports`,
   * `/exports/promotion`, `/imports`), layered on top of (never replacing) bearer+RBAC+Ed25519.
   * `undefined` (no `SCP_FEDERATION_SERVER_MTLS_*` env set) is the default — behavior is BYTE-FOR-
   * BYTE unchanged from pre-M9.3 (plain HTTP, no client-cert requirement at all; the deployment-
   * level `ingress.mtls` from M8 remains the enforcement point for ingress-terminated topologies).
   * Mirrors `loadOidcConfig`'s house style: a nested optional block, throwing at boot on a PARTIAL
   * configuration (some but not all of ca/cert/key set) rather than silently degrading.
   *
   * This is a listener-construction concern, not a request-time one: `ca`/`cert`/`key`/`crl` are
   * read into memory ONCE at boot (here) because `app.ts` needs them synchronously to build the
   * `Fastify({ https: {...} })` options — the whole process listens as HTTPS when this is set,
   * `rejectUnauthorized: false` (ADR-0001 §Decision 1: the SAME listener also serves browsers/
   * CLI/SDK traffic that must not present a client cert; enforcement is per-route, not at the
   * handshake — see `federation/mtls-enforcement.ts`).
   */
  federationServerMtls?: {
    caFile: string;
    certFile: string;
    keyFile: string;
    crlFile?: string;
    /** Default `false` (warn-and-continue) — see `loadFederationServerMtlsConfig`'s doc comment
     *  for why an expired CRL can't just be "included but logged": empirically, Node/OpenSSL treats
     *  ANY CRL past its `nextUpdate` as invalidating EVERY cert-presenting connection
     *  (`CRL_HAS_EXPIRED`), not merely disabling revocation checking — so this flag controls
     *  whether boot refuses outright (`true`) or drops the stale CRL from the TLS context entirely
     *  and continues without revocation enforcement until a fresh CRL is delivered (`false`). */
    crlHardFailOnExpiry: boolean;
    ca: Buffer;
    cert: Buffer;
    key: Buffer;
    /** `undefined` when `crlFile` is unset, OR when it was set but found expired with
     *  `crlHardFailOnExpiry: false` (dropped — see above; a loud warning is logged either way in
     *  `loadFederationServerMtlsConfig`). */
    crl?: Buffer;
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

/**
 * `undefined` (no `SCP_FEDERATION_SERVER_MTLS_*` env at all) is the default — in-app federation
 * mTLS disabled, byte-for-byte pre-M9.3 behavior. Setting ANY of ca/cert/key without ALL three is a
 * misconfiguration worth failing loudly at boot (mirrors `loadOidcConfig` above) rather than
 * silently booting plain HTTP while an operator believes mTLS is on.
 *
 * **Why an expired CRL is handled here, not deferred to request time:** empirically verified while
 * building this (a throwaway CA + a CRL whose `nextUpdate` was set in the past via
 * `openssl ca -gencrl -crl_nextupdate <past-date>`, loaded into a real `https.createServer`):
 * passing an EXPIRED CRL into the TLS context makes Node/OpenSSL mark `authorized: false` with
 * `authorizationError: "CRL_HAS_EXPIRED"` for a perfectly valid, non-revoked client certificate —
 * not just for actually-revoked ones. In other words, OpenSSL's CRL-checking is itself already
 * fail-closed on staleness; it does NOT offer a "check revocation but tolerate staleness" mode.
 * So ADR-0001's "warn loudly and continue" policy (`crlHardFailOnExpiry: false`, the default —
 * an air-gapped domain may legitimately go a while between physical CRL deliveries) can only be
 * implemented by NOT handing the stale CRL to the TLS context at all: revocation enforcement is
 * disabled for federation until a fresh CRL is delivered, but the CA-trust check (and everything
 * else — bearer+RBAC, Ed25519 signatures) still holds. `crlHardFailOnExpiry: true` instead refuses
 * to boot outright — the simplest, clearest expression of "would rather reject all federation than
 * trust a stale revocation list" (ADR-0001 §8).
 */
export function loadFederationServerMtlsConfig(
  env: NodeJS.ProcessEnv
): ServerConfig["federationServerMtls"] {
  const caFile = env.SCP_FEDERATION_SERVER_MTLS_CA_FILE;
  const certFile = env.SCP_FEDERATION_SERVER_MTLS_CERT_FILE;
  const keyFile = env.SCP_FEDERATION_SERVER_MTLS_KEY_FILE;
  const crlFile = env.SCP_FEDERATION_SERVER_MTLS_CRL_FILE;
  const crlHardFailOnExpiry = env.SCP_FEDERATION_SERVER_MTLS_CRL_HARD_FAIL_ON_EXPIRY === "true";

  if (!caFile && !certFile && !keyFile) return undefined; // in-app federation mTLS not configured.
  if (!caFile || !certFile || !keyFile) {
    throw new Error(
      "in-app federation mTLS: SCP_FEDERATION_SERVER_MTLS_CA_FILE, _CERT_FILE, and _KEY_FILE must " +
        "all be set together (at least one was missing) — refusing to boot with a half-configured " +
        "server-side mTLS listener rather than silently falling back to plain HTTP"
    );
  }

  // Fail loud (readFileSync throws ENOENT/EACCES as-is) rather than swallowing a missing/unreadable
  // file — a misconfigured mTLS setup that quietly degrades to "no in-app enforcement" would be a
  // false sense of security, exactly the reasoning `loadFederationMtlsMaterial` (client-side,
  // plugin-host/subprocess-entry.ts) already documents for the symmetric client-cert case.
  const ca = readFileSync(caFile);
  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);

  let crl: Buffer | undefined;
  if (crlFile) {
    const rawCrl = readFileSync(crlFile);
    const nextUpdate = parseCrlNextUpdate(rawCrl);
    if (isCrlExpired(nextUpdate)) {
      const detail =
        `in-app federation mTLS: the CRL at '${crlFile}' is EXPIRED ` +
        `(nextUpdate ${nextUpdate?.toISOString()}, now ${new Date().toISOString()})`;
      if (crlHardFailOnExpiry) {
        throw new Error(
          `${detail} — SCP_FEDERATION_SERVER_MTLS_CRL_HARD_FAIL_ON_EXPIRY=true: refusing to boot ` +
            "rather than trust a stale revocation list."
        );
      }
      // Boot-time, before any Fastify logger exists — same "loud console.warn" convention main.ts
      // uses for the ephemeral-secrets-master-key warning.
      console.warn(
        `[scpd] ${detail}. SCP_FEDERATION_SERVER_MTLS_CRL_HARD_FAIL_ON_EXPIRY=false (default): ` +
          "continuing WITHOUT this CRL loaded — in-app federation mTLS still enforces CA trust + " +
          "registered-peer identity, but NOT revocation, until a fresh CRL is delivered. Deliver an " +
          "updated CRL (air-gap-compatible: drop the file in place and send SIGHUP, or restart) as " +
          "soon as possible."
      );
      crl = undefined;
    } else {
      crl = rawCrl;
    }
  }

  return { caFile, certFile, keyFile, crlFile, crlHardFailOnExpiry, ca, cert, key, crl };
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
    skipMigrations: env.SCP_SKIP_MIGRATIONS === "true",
    graphQueryStatementTimeoutMs: Number(env.SCP_GRAPH_QUERY_TIMEOUT_MS ?? 5000),
    federationServerMtls: loadFederationServerMtlsConfig(env)
  };
}
