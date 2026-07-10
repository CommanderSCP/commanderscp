import type pg from "pg";

/**
 * Boot-time runtime-role provisioning (PR #4 review, CRITICAL 3). Runs over the admin/bootstrap
 * connection immediately after migrations, then the admin pool is closed — the request-serving
 * pool connects as the login role provisioned here and never sees superuser privileges.
 *
 * The migration files fix `scp_app`'s privilege shape (NOSUPERUSER, NOBYPASSRLS, table grants,
 * RLS policies — drizzle/0002, 0003); this only grants LOGIN and sets the password, which cannot
 * live in committed SQL. Idempotent: safe on every boot.
 */
export async function provisionRuntimeRole(
  adminPool: pg.Pool,
  runtimeUser: string,
  runtimePassword: string
): Promise<void> {
  const client = await adminPool.connect();
  try {
    const role = client.escapeIdentifier(runtimeUser);
    const password = client.escapeLiteral(runtimePassword);
    await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${password}`);
  } finally {
    client.release();
  }
}

/**
 * Boot-time pg-boss role provisioning (M3 tracked security follow-up: pg-boss no longer connects
 * on the admin/superuser URL for its own `pgboss` schema). Same mechanism and same reasoning as
 * `provisionRuntimeRole` above — drizzle/0008_pgboss_role.sql fixes `scp_pgboss`'s privilege
 * shape (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, owns only the `pgboss` schema, no grants on `public`
 * at all); this only grants LOGIN and sets the password, which cannot live in committed SQL. A
 * distinct function (rather than reusing `provisionRuntimeRole` under this name) keeps main.ts's
 * boot sequence self-documenting: each role provisioned in Phase 1 gets its own named call.
 * Idempotent: safe on every boot.
 */
export async function provisionPgBossRole(
  adminPool: pg.Pool,
  pgBossUser: string,
  pgBossPassword: string
): Promise<void> {
  const client = await adminPool.connect();
  try {
    const role = client.escapeIdentifier(pgBossUser);
    const password = client.escapeLiteral(pgBossPassword);
    await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${password}`);
  } finally {
    client.release();
  }
}

/**
 * Derives the runtime (least-privileged) connection string from the admin one: same host, port,
 * database, and password — only the user is swapped to `scp_app`. Operators who manage the role
 * themselves override with an explicit SCP_RUNTIME_DATABASE_URL instead.
 */
export function deriveRuntimeDatabaseUrl(
  adminDatabaseUrl: string,
  runtimeUser = "scp_app"
): string {
  const url = new URL(adminDatabaseUrl);
  url.username = runtimeUser;
  return url.toString();
}

/** Extracts the user + password the runtime pool will authenticate with (for provisioning). */
export function runtimeCredentials(runtimeDatabaseUrl: string): { user: string; password: string } {
  const url = new URL(runtimeDatabaseUrl);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password)
  };
}
