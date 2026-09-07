import { describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../config.js";
import { ProblemError } from "../errors.js";
import { withOperatorDb } from "./operator-db.js";

/** THE OPERATOR WRITE DOORS' CREDENTIAL, AT THE UNIT LAYER M22.9 R3. See docs/routes.md §282. */

/** `loadConfig` reads only the env object handed to it, so each case is a complete deployment
 *  shape rather than a mutation of `process.env`. */
function configFor(env: Record<string, string>): ServerConfig {
  return loadConfig(env as NodeJS.ProcessEnv);
}

describe("operatorDatabaseUrl derivation", () => {
  it("uses SCP_OPERATOR_DATABASE_URL verbatim when the operator supplies one", () => {
    const config = configFor({
      DATABASE_URL: "postgres://admin:pw@db:5432/scp",
      SCP_OPERATOR_DATABASE_URL: "postgres://scp_operator:opw@db:5432/scp"
    });
    expect(config.operatorDatabaseUrl).toBe("postgres://scp_operator:opw@db:5432/scp");
  });

  it("falls back to the admin connection in a SELF-MIGRATING shape (dev, compose, Testcontainers)", () => {
    // `SCP_SKIP_MIGRATIONS` unset ⇒ main.ts Phase 1 opens an admin pool on this very URL, so it is
    // a real, reachable, superuser-capable credential. Byte-for-byte the pre-R3 behaviour, which is
    // what keeps every existing integration test on its existing connection.
    const config = configFor({ DATABASE_URL: "postgres://admin:pw@db:5432/scp" });
    expect(config.operatorDatabaseUrl).toBe("postgres://admin:pw@db:5432/scp");
  });

  it("is UNDEFINED in the hardened shape, rather than defaulting to a connection that is not there", () => {
    // THE ACTUAL BUG, as a config assertion. `SCP_SKIP_MIGRATIONS=true` with no `DATABASE_URL` is
    // exactly what the Helm chart renders on api/worker pods. Before R3 the operator write doors
    // read `config.databaseUrl` here, which silently resolves to the localhost fallback below — so
    // they dialed 127.0.0.1 INSIDE the pod and 500'd on ECONNREFUSED.
    const config = configFor({
      SCP_SKIP_MIGRATIONS: "true",
      SCP_RUNTIME_DATABASE_URL: "postgres://scp_app:apw@db:5432/scp",
      SCP_PGBOSS_DATABASE_URL: "postgres://scp_pgboss:ppw@db:5432/scp"
    });
    expect(config.databaseUrl).toBe("postgres://scp:scp@localhost:5432/scp");
    expect(config.operatorDatabaseUrl).toBeUndefined();
  });

  it("prefers the explicit variable even in the hardened shape's presence of an admin URL", () => {
    const config = configFor({
      DATABASE_URL: "postgres://admin:pw@db:5432/scp",
      SCP_SKIP_MIGRATIONS: "true",
      SCP_OPERATOR_DATABASE_URL: "postgres://scp_operator:opw@db:5432/scp"
    });
    expect(config.operatorDatabaseUrl).toBe("postgres://scp_operator:opw@db:5432/scp");
  });

  it("never widens the request-serving pool: runtime/pgboss derivations are untouched by any of this", () => {
    const config = configFor({ DATABASE_URL: "postgres://admin:pw@db:5432/scp" });
    expect(new URL(config.runtimeDatabaseUrl).username).toBe("scp_app");
    expect(new URL(config.pgBossDatabaseUrl).username).toBe("scp_pgboss");
  });
});

describe("withOperatorDb fails closed", () => {
  it("refuses with a 503 NAMING the missing variable, and never runs the callback", async () => {
    const config = configFor({
      SCP_SKIP_MIGRATIONS: "true",
      SCP_RUNTIME_DATABASE_URL: "postgres://scp_app:apw@db:5432/scp"
    });
    let ran = false;
    const err = await withOperatorDb(config, "scan-exclusion admissions", async () => {
      ran = true;
    }).catch((e: unknown) => e);

    expect(ran).toBe(false);
    expect(err).toBeInstanceOf(ProblemError);
    const problem = err as ProblemError;
    expect(problem.status).toBe(503);
    // The whole point of the status change is that an operator learns what to configure from the
    // response body. Pin the two things they need — the surface and the variable — not the prose.
    expect(problem.detail).toContain("SCP_OPERATOR_DATABASE_URL");
    expect(problem.detail).toContain("scan-exclusion admissions");
  });

  it("turns an unopenable connection into a 503 carrying the remedy, not a 500", async () => {
    // Loopback port 1. See docs/routes.md §283.
    const config = configFor({
      SCP_SKIP_MIGRATIONS: "true",
      SCP_OPERATOR_DATABASE_URL: "postgres://scp_operator:opw@127.0.0.1:1/scp"
    });
    const err = await withOperatorDb(config, "instance scan floors", async () => undefined).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(ProblemError);
    const problem = err as ProblemError;
    expect(problem.status).toBe(503);
    expect(problem.detail).toContain("SCP_OPERATOR_DATABASE_URL");
    expect(problem.detail).toContain("ALTER ROLE scp_operator");
  });
});
