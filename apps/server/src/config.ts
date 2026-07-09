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
}

function randomSecret(): string {
  // Node's global crypto (WebCrypto) is available without an extra import.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
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
    internalBaseUrl: env.SCP_INTERNAL_BASE_URL ?? `http://127.0.0.1:${port}/api/v1`
  };
}
