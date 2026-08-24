import pg from "pg";
import type { ServerConfig } from "../config.js";
import { ProblemError } from "../errors.js";
import { createPool } from "../db/client.js";

/**
 * M22.9 R3 — THE ONE CONNECTION EVERY INSTANCE-OPERATOR WRITE DOOR OPENS.
 *
 * Four routes author instance-scoped config that binds every org on the deployment —
 * `instance-scan-exclusion-admissions.ts` (ADR-0033), `instance-scan-floors.ts` (ADR-0016),
 * `scanner-assignments.ts` and `scan-db.ts` (ADR-0020) — and all four opened
 * `new pg.Pool({ connectionString: deps.config.databaseUrl })` inline. That was wrong in the same
 * way in all four places, so it is fixed here once rather than four times.
 *
 * WHAT WAS WRONG. `config.databaseUrl` is the admin/bootstrap connection, and the hardened Helm
 * shape does not give it to the api/worker pods at all (`commanderscp.adminDbEnv` is included by
 * `migrations-job.yaml` and nothing else — M8: only the migrations Job holds admin credentials).
 * With `DATABASE_URL` unset, `loadConfig` falls back to its `postgres://scp:scp@localhost:5432/scp`
 * literal, so each handler dialed 127.0.0.1 INSIDE its own pod and returned a bare 500 on
 * ECONNREFUSED. Behind that sat a second, independent refusal: `scp_app` holds SELECT only on all
 * four tables, which are `FORCE ROW LEVEL SECURITY` with a `FOR SELECT` policy and no write policy
 * for anyone (drizzle/0029, 0035, 0036, 0074). The integration suite never saw either layer because
 * its `DATABASE_URL` is the Testcontainers SUPERUSER, which bypasses grants and RLS outright.
 *
 * WHY THE FAILURES BELOW ARE 503 AND NOT 500. A 500 says "this request hit a bug"; every operator
 * who met this one met it as an opaque one. These two are deployment facts — a credential this
 * instance was never given, or a role whose password was never provisioned — and the operator
 * reading the response is exactly the person who can fix them, so the response names the env var,
 * the role, and the SQL. Nothing here is retryable by the caller, but a 503 is honest about the
 * instance being unable to serve the surface rather than about the request being malformed.
 *
 * ONLY THE CONNECT PHASE IS TRANSLATED. Everything the callback does — a CHECK constraint
 * violation, a serialization failure, a rolled-back transaction — propagates untouched, because
 * those are statements about the REQUEST and turning them into 503s would hide real refusals
 * behind an infrastructure-shaped error.
 */
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
