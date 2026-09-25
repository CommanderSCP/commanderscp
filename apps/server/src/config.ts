import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { deriveRuntimeDatabaseUrl } from "./db/provision.js";
import { generateMasterKeyBase64, parseMasterKeyBase64 } from "./secrets/crypto.js";
import { isCrlExpired, parseCrlNextUpdate } from "./federation/crl-parse.js";

export interface ServerConfig {
  port: number;
  host: string;
  /** Admin/bootstrap connection (compose POSTGRES_USER). See docs/server.md §30. */
  databaseUrl: string;
  /** The connection the application pool actually uses. See docs/server.md §31. */
  runtimeDatabaseUrl: string;
  /** The connection pg-boss uses for its own schema. See docs/server.md §32. */
  pgBossDatabaseUrl: string;
  /** The connection the instance-operator write doors use. See docs/server.md §33. */
  operatorDatabaseUrl?: string;
  role: "all" | "api" | "worker";
  /** The operator-declared, install-time federation role. See docs/server.md §34. */
  federationRole: "commander" | "outpost" | "retrans";
  /** DID THE OPERATOR ACTUALLY SAY SO? See docs/server.md §35. */
  federationRoleDeclared: boolean;
  /** D6 (multi-region-instance-resilience.md §7.3, §11). See docs/server.md §36. */
  deploymentMode: "production" | "evaluation";
  /** True when `SCP_COOKIE_SECRET` was UNSET and an ephemeral one was generated — the cookie half of
   *  the D6 production refusal (a restart invalidates every session signed under the old ephemeral). */
  cookieSecretWasGenerated: boolean;
  /** §7.4 — this member cluster's identity (`SCP_CLUSTER_ID`, else the host/pod name) and the running
   *  release (`SCP_APP_VERSION`, else "dev"). Heartbeated on boot; the migrations Job's version-skew
   *  gate refuses a contract-phase deploy while a live member cluster reports a different version. */
  clusterId: string;
  appVersion: string;
  /** The instance operator's shared secret. See docs/server.md §37. */
  operatorToken?: string;
  bootstrapOrgName: string;
  bootstrapAdminUsername: string;
  /** M29.1 — `SCP_BOOTSTRAP_ADMIN_PASSWORD`, the chart-generated one-time password the installer
   *  also reads (from the `<release>-bootstrap-admin` Secret) and prints. Unset: unchanged
   *  behaviour, `ensureBootstrapAdmin` generates its own and logs it (dev/compose). See
   *  docs/server.md and docs/adr/0060-front-door.md. */
  bootstrapAdminPassword?: string;
  cookieSecret: string;
  /** Base URL the server uses to call its own public API (UI SSR dogfoods the SDK). This is a
   *  SELF-call address — never hand it to a human or an external party (that was the device-flow
   *  bug this field's sibling, `publicBaseUrl`, exists to fix). See docs/server.md §105. */
  internalBaseUrl: string;
  /** The URL a HUMAN or an external party actually reaches this instance at (origin only, e.g.
   *  `https://scp.example.com`), from `SCP_PUBLIC_BASE_URL`. Deliberately never derived from
   *  `internalBaseUrl`, nor from a request's Host/X-Forwarded-* headers — a client controls those
   *  headers, so a header-derived verification link would be a phishing vector. `undefined` (unset)
   *  means no publicly-reachable URL is configured; each call site that needs one for a human falls
   *  back to a relative path (or, where a relative path isn't viable, to `internalBaseUrl`, which is
   *  at least a working URL for a local/dev install) — documented at the call site. See
   *  docs/server.md §105. */
  publicBaseUrl?: string;
  /** Boot-time demo seed. See docs/server.md §38. */
  seedDemo: boolean;
  /** Generic OIDC (Authorization Code + PKCE via `openid-client`). See docs/server.md §39. */
  oidc?: {
    issuer: string;
    clientId: string;
    /** Public clients (no client secret — e.g. the CLI's own future native-app flow) may omit this. */
    clientSecret?: string;
    /** Must exactly match what's registered at the IdP. */
    redirectUri: string;
    scopes: string;
    /**
     * The ID-token claim carrying the values that map to SCP groups (`SCP_OIDC_ROLE_CLAIM`,
     * default `roles`).
     *
     * `roles` — Entra APP ROLES — is the default and the recommended shape, over the `groups`
     * claim, for two measured reasons. (1) Its values are ones YOU choose in the app registration,
     * so they are readable in SCP's UI and stable across tenant changes, where `groups` carries
     * opaque directory GUIDs. (2) The `groups` claim OVERFLOWS: past roughly 200 groups Entra omits
     * it entirely and substitutes `_claim_names`/`_claim_sources` pointing at MS Graph, and
     * resolving that needs an outbound call to graph.microsoft.com — which CLAUDE.md principle 5
     * forbids outright. App roles are assigned per application and do not overflow in practice.
     *
     * Configurable rather than hard-coded because non-Entra issuers name this differently
     * (Keycloak's default mapper emits `roles`; Okta commonly `groups`), and the whole point of the
     * generic-OIDC seam is no per-provider special casing.
     */
    roleClaim: string;
  };
  /** `EventBus` backend toggle. See docs/server.md §40. */
  eventBus: {
    backend: "postgres" | "nats";
    /** Required when `backend === "nats"`; validated below. e.g. `nats://localhost:4222`. */
    natsUrl?: string;
  };
  /** AES-256-GCM root key for the `secrets` table. See docs/server.md §41. */
  secretsMasterKey: Buffer;
  secretsMasterKeyWasGenerated: boolean;
  /** Hardened defaults, and least privilege as the baseline. See docs/server.md §42. */
  skipMigrations: boolean;
  /** Defensive graph guardrail. See docs/server.md §43. */
  graphQueryStatementTimeoutMs: number;
  /** M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`). See docs/server.md §44. */
  federationServerMtls?: {
    caFile: string;
    certFile: string;
    keyFile: string;
    crlFile?: string;
    /** Default `false` (warn-and-continue). See docs/server.md §45. */
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

/** `undefined` (SCP_OIDC_ISSUER unset) is the default. See docs/server.md §46. */
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
    scopes: env.SCP_OIDC_SCOPES ?? "openid profile email",
    roleClaim: env.SCP_OIDC_ROLE_CLAIM ?? "roles"
  };
}

/** `undefined` (SCP_PUBLIC_BASE_URL unset) is the default. See docs/server.md §105.
 *
 * Deliberately does NOT accept a Host/X-Forwarded-Host request header as a substitute for an
 * operator-set value — those are client-controlled, and a verification link built from one is a
 * phishing vector (an attacker who controls what Host they send controls what URL a victim is
 * told to open). This must be an explicit, operator-configured deployment value or nothing at all.
 */
function loadPublicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.SCP_PUBLIC_BASE_URL ?? "").trim();
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `SCP_PUBLIC_BASE_URL must be an absolute http(s) URL, e.g. "https://scp.example.com" (got "${raw}")`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `SCP_PUBLIC_BASE_URL must be an absolute http(s) URL, e.g. "https://scp.example.com" (got "${raw}")`
    );
  }

  // Strip a trailing slash so every call site can uniformly do `${publicBaseUrl}/path`.
  return raw.replace(/\/+$/, "");
}

/** `postgres` (SCP_EVENT_BUS_BACKEND unset) is the default. See docs/server.md §47. */
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

/** `commander` (SCP_FEDERATION_ROLE unset) is the default. See docs/server.md §48. */
function loadFederationRole(env: NodeJS.ProcessEnv): ServerConfig["federationRole"] {
  const role = env.SCP_FEDERATION_ROLE ?? "commander";
  if (role !== "commander" && role !== "outpost" && role !== "retrans") {
    throw new Error(
      `SCP_FEDERATION_ROLE must be "commander", "outpost", or "retrans" (got "${role}")`
    );
  }
  return role;
}

/** Production is the default when unset, so an install is safe. See docs/server.md §49. */
function loadDeploymentMode(env: NodeJS.ProcessEnv): ServerConfig["deploymentMode"] {
  const mode = env.SCP_DEPLOYMENT_MODE ?? "production";
  if (mode !== "production" && mode !== "evaluation") {
    throw new Error(`SCP_DEPLOYMENT_MODE must be "production" or "evaluation" (got "${mode}")`);
  }
  return mode;
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

/** Undefined is the default: no such environment at all. See docs/server.md §50. */
export function loadFederationServerMtlsConfig(
  env: NodeJS.ProcessEnv
): ServerConfig["federationServerMtls"] {
  const caFile = env.SCP_FEDERATION_SERVER_MTLS_CA_FILE;
  const certFile = env.SCP_FEDERATION_SERVER_MTLS_CERT_FILE;
  const keyFile = env.SCP_FEDERATION_SERVER_MTLS_KEY_FILE;
  const crlFile = env.SCP_FEDERATION_SERVER_MTLS_CRL_FILE;
  const crlHardFailOnExpiry = env.SCP_FEDERATION_SERVER_MTLS_CRL_HARD_FAIL_ON_EXPIRY === "true";

  if (!caFile && !certFile && !keyFile) return undefined;
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

/** `scp_operator` at the runtime connection's address, with a generated password (M29.4). */
export function operatorUrlFromPassword(
  runtimeDatabaseUrl: string,
  password: string | undefined
): string | undefined {
  if (!password || password.trim() === "") return undefined;
  const url = new URL(runtimeDatabaseUrl);
  url.username = "scp_operator";
  url.password = encodeURIComponent(password.trim());
  return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8080);
  const host = env.HOST ?? "0.0.0.0";
  const databaseUrl = env.DATABASE_URL ?? "postgres://scp:scp@localhost:5432/scp";
  // Hoisted out of the object literal only because `operatorDatabaseUrl`'s default reads it — see
  // that field's doc comment for why "does this process self-migrate?" is the honest test for
  // "does this process hold a usable admin connection?".
  const skipMigrations = env.SCP_SKIP_MIGRATIONS === "true";
  const secretsMasterKey = loadSecretsMasterKey(env);
  return {
    port,
    host,
    databaseUrl,
    runtimeDatabaseUrl: env.SCP_RUNTIME_DATABASE_URL ?? deriveRuntimeDatabaseUrl(databaseUrl),
    pgBossDatabaseUrl:
      env.SCP_PGBOSS_DATABASE_URL ?? deriveRuntimeDatabaseUrl(databaseUrl, "scp_pgboss"),
    // Not derived like the two above, and the reason why. See docs/server.md §51. The one derived
    // form (M29.4): a chart-GENERATED `SCP_OPERATOR_DATABASE_PASSWORD`, which the migrations Job
    // provisions (`provisionOperatorRole`) before any pod uses it — the runtime URL's host, port
    // and database with the user and password swapped, so the chart never needs to know the host.
    operatorDatabaseUrl:
      env.SCP_OPERATOR_DATABASE_URL ??
      operatorUrlFromPassword(
        env.SCP_RUNTIME_DATABASE_URL ?? deriveRuntimeDatabaseUrl(databaseUrl),
        env.SCP_OPERATOR_DATABASE_PASSWORD
      ) ??
      (skipMigrations ? undefined : databaseUrl),
    role: (env.SCP_ROLE as ServerConfig["role"] | undefined) ?? "all",
    federationRole: loadFederationRole(env),
    // Whether the operator SET it, kept beside the value it resolved to — see the field's doc.
    federationRoleDeclared: (env.SCP_FEDERATION_ROLE ?? "").trim() !== "",
    deploymentMode: loadDeploymentMode(env),
    cookieSecretWasGenerated: (env.SCP_COOKIE_SECRET ?? "").trim() === "",
    clusterId: (env.SCP_CLUSTER_ID ?? "").trim() || hostname(),
    appVersion: (env.SCP_APP_VERSION ?? "").trim() || "dev",
    bootstrapOrgName: env.SCP_BOOTSTRAP_ORG ?? "default",
    bootstrapAdminUsername: env.SCP_BOOTSTRAP_ADMIN_USERNAME ?? "admin",
    bootstrapAdminPassword: (env.SCP_BOOTSTRAP_ADMIN_PASSWORD ?? "").trim() || undefined,
    cookieSecret: env.SCP_COOKIE_SECRET ?? randomSecret(),
    internalBaseUrl: env.SCP_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}/api/v1`,
    publicBaseUrl: loadPublicBaseUrl(env),
    seedDemo: env.SCP_SEED_DEMO === "true",
    oidc: loadOidcConfig(env),
    eventBus: loadEventBusConfig(env),
    secretsMasterKey: secretsMasterKey.key,
    secretsMasterKeyWasGenerated: secretsMasterKey.wasGenerated,
    skipMigrations,
    graphQueryStatementTimeoutMs: Number(env.SCP_GRAPH_QUERY_TIMEOUT_MS ?? 5000),
    federationServerMtls: loadFederationServerMtlsConfig(env),
    operatorToken:
      env.SCP_OPERATOR_TOKEN && env.SCP_OPERATOR_TOKEN.length > 0
        ? env.SCP_OPERATOR_TOKEN
        : undefined
  };
}
