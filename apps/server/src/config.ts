import { readFileSync } from "node:fs";
import { hostname } from "node:os";
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
  /**
   * M22.9 R3 — the connection the four INSTANCE-OPERATOR write doors use (`routes/
   * instance-scan-exclusion-admissions.ts`, `instance-scan-floors.ts`, `scanner-assignments.ts`,
   * `scan-db.ts`). Authenticates as `scp_operator`: NOSUPERUSER, NOBYPASSRLS, and granted
   * INSERT/UPDATE/DELETE plus a write RLS policy on exactly those four instance-scoped tables and
   * nothing else (drizzle/0076). `SCP_OPERATOR_DATABASE_URL`.
   *
   * WHY IT IS A THIRD CONNECTION RATHER THAN EITHER OF THE TWO ABOVE. It cannot be
   * `runtimeDatabaseUrl`: `scp_app` holds SELECT only on those tables and has no write policy, by
   * design and in two independent layers (drizzle/0029, 0035, 0036, 0074) — an operator write must
   * not be reachable from the role that serves tenant traffic. And it must not be `databaseUrl`,
   * which is what these four doors USED and is the bug they shipped with: in the hardened Helm
   * shape the api/worker pods hold no admin credential at all (`commanderscp.adminDbEnv` is
   * included only by `migrations-job.yaml`), so `databaseUrl` silently resolved to the
   * `localhost:5432` fallback below and every operator write dialed 127.0.0.1 inside its own pod —
   * ECONNREFUSED, a bare 500, and for M22 an admissions table that stayed empty, which fails the
   * exclusion AND at its top rung for every clause on the deployment.
   *
   * `undefined` MEANS THE WRITE DOORS FAIL CLOSED WITH A 503 THAT NAMES THIS VARIABLE
   * (`routes/operator-db.ts`), never a 500 and never a fallback to a wider credential. Reads are
   * unaffected — they run inside the ordinary tenant transaction and always did.
   *
   * THE DEFAULT IS THE ADMIN CONNECTION *ONLY IN THE SHAPES THAT ACTUALLY HAVE ONE*, i.e. when
   * this process is self-migrating (`SCP_SKIP_MIGRATIONS` unset/false — `pnpm dev`, the compose
   * eval stack, Testcontainers). Those are precisely the shapes where `databaseUrl` is a real,
   * reachable, superuser-capable credential that `main.ts` Phase 1 already opens a pool on, so
   * their behaviour is byte-for-byte what it was before this field existed. `SCP_SKIP_MIGRATIONS=
   * true` is the hardened deployment saying it holds no admin connection, and there the absence of
   * an explicit `SCP_OPERATOR_DATABASE_URL` is a missing credential, not a default to guess at.
   */
  operatorDatabaseUrl?: string;
  role: "all" | "api" | "worker";
  /**
   * M16.3 P3 — the OPERATOR/install-time-declared federation role, `SCP_FEDERATION_ROLE`
   * (`commander` the default when unset — matches `deploy/helm-bundled`'s `federationRole`
   * default, and preserves every pre-M16.3 deployment's behavior byte-for-byte since no such env
   * var existed before). This is DELIBERATELY NOT `self_domain.role`
   * (`federation/self-repo.ts`'s `FederationSelf.role`): that value is per-ORG (DESIGN §4.1
   * "kept org-scoped, not instance-wide" — self-repo.ts's own module doc), set lazily post-install
   * via the federation API, and advisory (M15.4's `tools/helm-verify` doc comment: "the runtime
   * `self_domain.role`... has no bearing on a Helm install-time value" — using it here would be
   * exactly the runtime/install-time fork that M15.4 explicitly declined to create). SPA
   * registration in `app.ts`, by contrast, happens ONCE at process boot, before any request (or
   * tenant/org) context exists — there is no per-request org to look up a DB row for even if we
   * wanted to. So this mirrors `role` above: an explicit, install-time, deployment-wide config
   * value the operator sets (Helm's `federationRole` value on the MAIN chart, wired to this env
   * var — `deploy/helm/templates/_helpers.tpl`), never inferred from tenant data.
   *
   * Used for exactly one thing today (P3): a `retrans` relay — "no local Gitea/registry, no
   * executor coordination, no deploy machinery, no UI" (BUILD_AND_TEST.md M13.1) — must not serve
   * the full management SPA at the most sensitive point in the topology (a CDS boundary). Every
   * other value (`commander`/`outpost`/unset) preserves the pre-M16.3 unconditional-serve
   * behavior.
   */
  federationRole: "commander" | "outpost" | "retrans";
  /**
   * DID THE OPERATOR ACTUALLY SAY SO? True only when `SCP_FEDERATION_ROLE` was set; false when
   * `federationRole` above is the `commander` DEFAULT (M21.4).
   *
   * The two are not the same fact, and one consumer needs the difference. `federationRole` defaults
   * to `commander` so that every pre-M16.3 deployment keeps serving the SPA byte-for-byte — that
   * default is right for a question about what to SERVE, because serving is what those deployments
   * already did. It is the wrong default for a question about what to REACH: an outpost deployed
   * before this env var existed, or a chart that simply does not set it, is indistinguishable from a
   * declared commander, so a guard that only tests `federationRole === "commander"` is FAIL-OPEN for
   * exactly the deployments most likely to be air-gapped.
   *
   * Consumers therefore pick per question: "may I serve the SPA?" reads `federationRole`, and "may I
   * dial the public internet on a timer?" additionally requires this to be true (see
   * `dependencies/version-poll.ts`'s `dependencyVersionPollRoleGuard`). Nothing about the pre-M16.3
   * serve behaviour changes — this field ADDS a distinction rather than moving the default.
   */
  federationRoleDeclared: boolean;
  /**
   * D6 (multi-region-instance-resilience.md §7.3, §11) — the DEPLOYMENT MODE. `production` (the
   * default; Helm ships it) makes boot FAIL-CLOSED on the DR footguns that only bite after a
   * restart/failover: an ephemeral generated `SCP_SECRETS_MASTER_KEY`/`SCP_COOKIE_SECRET` (which
   * silently orphans every stored secret and every session on restart), and a secrets vault that
   * cannot be decrypted with the configured key (the B3 canary). `evaluation` (compose-eval and
   * `pnpm dev` set it explicitly) keeps today's zero-required-env boot with only a loud warning. An
   * invalid value fails loud at boot, exactly like `SCP_FEDERATION_ROLE`.
   */
  deploymentMode: "production" | "evaluation";
  /** True when `SCP_COOKIE_SECRET` was UNSET and an ephemeral one was generated — the cookie half of
   *  the D6 production refusal (a restart invalidates every session signed under the old ephemeral). */
  cookieSecretWasGenerated: boolean;
  /** §7.4 — this member cluster's identity (`SCP_CLUSTER_ID`, else the host/pod name) and the running
   *  release (`SCP_APP_VERSION`, else "dev"). Heartbeated on boot; the migrations Job's version-skew
   *  gate refuses a contract-phase deploy while a live member cluster reports a different version. */
  clusterId: string;
  appVersion: string;
  /**
   * M17.5 (ADR-0016) — the INSTANCE OPERATOR's shared secret (`SCP_OPERATOR_TOKEN`). Authenticates
   * the one write surface that is deliberately NOT a tenant capability: authoring the
   * instance-scoped scan-requirement floors (`scan_requirement_floors` — platform + trust domain),
   * which apply to EVERY org hosted on this deployment. A tenant admin, however privileged inside
   * their own org, must never be able to author or loosen them, so no RBAC permission can grant
   * this — it is a separate, deployment-level credential.
   *
   * UNSET (the default) means the operator write surface is CLOSED: the route 403s rather than
   * falling back to any tenant credential. Fail-closed, and air-gap friendly (an env var, no
   * external IdP).
   */
  operatorToken?: string;
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
   * Generic OIDC (Authorization Code + PKCE via `openid-client`) — DESIGN.md §7, M2 step 2 Part
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
    scopes: env.SCP_OIDC_SCOPES ?? "openid profile email",
    roleClaim: env.SCP_OIDC_ROLE_CLAIM ?? "roles"
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

/**
 * `commander` (SCP_FEDERATION_ROLE unset) is the default — matches `deploy/helm-bundled`'s
 * `federationRole` default (`templates/_helpers.tpl`) and every pre-M16.3 deployment, none of
 * which set this env var, keeps serving the SPA exactly as before. An explicit invalid value fails
 * loud at boot (mirrors `loadEventBusConfig`/`loadOidcConfig` above) rather than silently doing
 * something an operator didn't ask for with a deployment-wide, security-relevant switch.
 */
function loadFederationRole(env: NodeJS.ProcessEnv): ServerConfig["federationRole"] {
  const role = env.SCP_FEDERATION_ROLE ?? "commander";
  if (role !== "commander" && role !== "outpost" && role !== "retrans") {
    throw new Error(
      `SCP_FEDERATION_ROLE must be "commander", "outpost", or "retrans" (got "${role}")`
    );
  }
  return role;
}

/**
 * D6 (§7.3). `production` is the DEFAULT (unset → production) so a Helm install with no extra env is
 * fail-closed on the DR footguns; the compose-eval stack and `pnpm dev` set `SCP_DEPLOYMENT_MODE=
 * evaluation` explicitly to keep their zero-required-env boot. An explicit invalid value fails loud
 * at boot rather than silently picking a posture the operator didn't ask for (mirrors
 * `loadFederationRole`).
 */
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
    // NOT `deriveRuntimeDatabaseUrl(databaseUrl, "scp_operator")` like the two above, and the
    // difference is load-bearing rather than an oversight: that helper swaps the USER and keeps the
    // admin PASSWORD, which only authenticates because `main.ts`/`migrate-bin.ts` provision
    // `scp_app`/`scp_pgboss` with exactly that password at boot. There is no such provisioner for
    // `scp_operator` yet (drizzle/0076's header names the owed `provisionOperatorRole`), so a
    // derived URL here would be a credential that looks configured and cannot log in.
    operatorDatabaseUrl:
      env.SCP_OPERATOR_DATABASE_URL ?? (skipMigrations ? undefined : databaseUrl),
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
    cookieSecret: env.SCP_COOKIE_SECRET ?? randomSecret(),
    internalBaseUrl: env.SCP_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}/api/v1`,
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
