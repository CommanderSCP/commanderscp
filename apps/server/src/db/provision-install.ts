import type pg from "pg";
import type { ServerConfig } from "../config.js";
import {
  STACKD_INSTALL_CREDENTIAL_NAME,
  provisionInstallOperatorCredential
} from "../auth/operator-auth.js";
import { provisionOperatorRole, runtimeCredentials } from "./provision.js";
import { parsePrefixedToken, sha256HashOf } from "../auth/prefixed-token.js";

/**
 * What the migrations Job is handed for the controller's credential. On Helm it is the token id and
 * the sha256 of the secret ONLY (`SCP_STACKD_CREDENTIAL_TOKEN_ID` / `_SHA256`): the plaintext lives
 * in the stack controller's own namespace and nowhere else (ADR-0058, review B1). The whole token
 * (`SCP_STACKD_OPERATOR_CREDENTIAL`) is accepted too, for a self-migrating dev process.
 */
export function stackdCredentialMaterial(
  env: NodeJS.ProcessEnv
): { tokenId: string; secretSha256: string } | null {
  const tokenId = (env.SCP_STACKD_CREDENTIAL_TOKEN_ID ?? "").trim();
  const sha = (env.SCP_STACKD_CREDENTIAL_SHA256 ?? "").trim();
  if (tokenId || sha) {
    if (!tokenId || !sha) {
      throw new Error(
        "SCP_STACKD_CREDENTIAL_TOKEN_ID and SCP_STACKD_CREDENTIAL_SHA256 come together"
      );
    }
    return { tokenId, secretSha256: sha };
  }
  const whole = (env.SCP_STACKD_OPERATOR_CREDENTIAL ?? "").trim();
  if (!whole) return null;
  const parsed = parsePrefixedToken("scp_op_", whole);
  if (!parsed || parsed.secret.length < 32) {
    throw new Error(
      "SCP_STACKD_OPERATOR_CREDENTIAL is not a well-formed scp_op_<tokenId>.<secret> — refusing to record it"
    );
  }
  return {
    tokenId: parsed.tokenId,
    secretSha256: sha256HashOf(parsed.secret).slice("sha256:".length)
  };
}

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
  const material = stackdCredentialMaterial(env);
  if (material) {
    const outcome = await provisionInstallOperatorCredential(adminPool, {
      name: STACKD_INSTALL_CREDENTIAL_NAME,
      ...material
    });
    log.push(
      outcome === "revoked"
        ? `stack controller credential is REVOKED (left revoked; replace the chart Secret to re-issue)`
        : `stack controller credential ${outcome}`
    );
  }
  return log;
}
