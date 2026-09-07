import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import type { ServerConfig } from "../config.js";
import { ProblemError } from "../errors.js";
import { createPool } from "../db/client.js";

/** The one connection every instance-operator door opens. See docs/routes.md §284. */
export async function withOperatorDb<T>(
  config: ServerConfig,
  /** What the caller is authoring, in the same voice as each route's own `requireOperator`
   *  message ("scan-exclusion admissions", "instance scan floors", ...). It leads the 503 so an
   *  operator sees which door failed without correlating by URL. */
  surface: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const connectionString = config.operatorDatabaseUrl;
  if (!connectionString) {
    throw new ProblemError(503, "Service Unavailable", {
      detail:
        `${surface} cannot be written: this deployment has no operator database connection. Set ` +
        "SCP_OPERATOR_DATABASE_URL to a connection string authenticating as the `scp_operator` " +
        "role (drizzle/0076). The request-serving role deliberately cannot write instance-scoped " +
        "config, and the admin connection is not present on api/worker pods, so there is no " +
        "credential to fall back to. Reading this surface is unaffected."
    });
  }

  const pool = createPool(connectionString, { max: 1 });
  try {
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      // The two shapes seen in practice: ECONNREFUSED/ENOTFOUND (the URL points nowhere from
      // inside this pod) and 28P01/28000 (the role exists NOLOGIN, or its password was never set —
      // drizzle/0076 fixes the role's privilege shape and deliberately leaves LOGIN + password to
      // out-of-band provisioning). Both are answered with the remedy rather than the stack.
      throw new ProblemError(503, "Service Unavailable", {
        detail:
          `${surface} cannot be written: the operator database connection ` +
          "(SCP_OPERATOR_DATABASE_URL) could not be opened — " +
          `${err instanceof Error ? err.message : String(err)}. If the \`scp_operator\` role has ` +
          "not been given a login yet, grant one once against the admin connection: " +
          "ALTER ROLE scp_operator WITH LOGIN PASSWORD '<the password in that URL>'."
      });
    }
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Constant-time comparison of a presented operator token. See docs/routes.md §285. */
export function operatorTokenMatches(presented: unknown, configured: string | undefined): boolean {
  if (!configured || typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
