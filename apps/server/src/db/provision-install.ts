import type pg from "pg";
import type { ServerConfig } from "../config.js";
import {
  STACKD_INSTALL_CREDENTIAL_NAME,
  provisionInstallOperatorCredential
} from "../auth/operator-auth.js";
import { provisionOperatorRole, runtimeCredentials } from "./provision.js";

/**
 * THE INSTALL-TIME PRINCIPALS THE STACK CONTROLLER NEEDS (M29.4, ADR-0058), provisioned over the
 * admin connection right after migrations — by the migrations Job on Helm, by Phase 1 of a
 * self-migrating process elsewhere.
 *
 * 1. `scp_operator`'s LOGIN, when the chart generated its connection string. Without it every
 *    operator write door — the stack's included — 503s, and before this the only remedy was an
 *    `ALTER ROLE` typed against the admin connection by hand.
 * 2. The stack controller's operator credential, from the chart-generated Secret the controller
 *    also mounts. Recorded as an argon2 hash; the plaintext stays in that Secret.
 *
 * Both are opt-in by env, so every existing deployment shape is unchanged.
 */
export async function provisionInstallTimePrincipals(
  adminPool: pg.Pool,
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const log: string[] = [];
  if (env.SCP_PROVISION_OPERATOR_ROLE === "1") {
    if (!config.operatorDatabaseUrl || config.operatorDatabaseUrl === config.databaseUrl) {
      throw new Error(
        "SCP_PROVISION_OPERATOR_ROLE=1 but SCP_OPERATOR_DATABASE_URL is unset (or is the admin " +
          "connection) — there is no scp_operator login to provision"
      );
    }
    const op = runtimeCredentials(config.operatorDatabaseUrl);
    await provisionOperatorRole(adminPool, op.user, op.password);
    log.push("scp_operator login provisioned");
  }
  const stackdToken = (env.SCP_STACKD_OPERATOR_CREDENTIAL ?? "").trim();
  if (stackdToken) {
    const outcome = await provisionInstallOperatorCredential(adminPool, {
      name: STACKD_INSTALL_CREDENTIAL_NAME,
      token: stackdToken
    });
    log.push(
      outcome === "revoked"
        ? `stack controller credential is REVOKED (left revoked; replace the chart Secret to re-issue)`
        : `stack controller credential ${outcome}`
    );
  }
  return log;
}
