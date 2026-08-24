import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs, secrets } from "../db/schema.js";
import { decryptSecretValue } from "./crypto.js";

export interface DecryptCanaryResult {
  orgsEnumerated: number;
  orgsWithSecrets: number;
  decryptsAttempted: number;
}

/**
 * D6 / B3 BOOT CANARY (multi-region-instance-resilience.md §7.3). Proves the configured
 * `SCP_SECRETS_MASTER_KEY` actually decrypts this instance's vault BEFORE serving — the failure mode
 * it exists to catch is a member cluster (or a restored instance) booting with the WRONG master key,
 * where every stored plugin credential is silently undecryptable and every executor call fails only
 * later, one at a time, with no single loud signal.
 *
 * SPECIFIED AGAINST RLS (the v0.1 canary "could never run"): `secrets` is FORCE-RLS, so an UNSCOPED
 * `SELECT FROM secrets` returns zero rows *vacuously* and a canary written that way passes on a vault
 * it never read. So this enumerates orgs on the un-RLS'd `orgs` table, then attempts exactly one
 * decrypt PER ORG inside `withTenantTx` (which sets `app.current_org_id`, the only way the row is
 * visible). A zero-row org is skipped — a genuinely empty vault is not a failure. `decryptSecretValue`
 * throws on an AES-256-GCM auth-tag mismatch (a wrong key), which propagates out as the refusal.
 *
 * The caller (main.ts, production mode only) treats a throw as fail-closed: refuse to serve.
 */
export async function runSecretsDecryptCanary(
  db: Db,
  masterKey: Buffer
): Promise<DecryptCanaryResult> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  let orgsWithSecrets = 0;
  let decryptsAttempted = 0;

  for (const { id: orgId } of orgRows) {
    await withTenantTx(db, orgId, async (tx) => {
      const rows = await tx
        .select({
          ciphertext: secrets.ciphertext,
          nonce: secrets.nonce,
          keyVersion: secrets.keyVersion
        })
        .from(secrets)
        .limit(1);
      const row = rows[0];
      if (!row) return; // empty vault for this org — nothing to canary
      orgsWithSecrets += 1;
      try {
        decryptSecretValue(
          { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion },
          masterKey
        );
        decryptsAttempted += 1;
      } catch (err) {
        throw new Error(
          `[scpd] secrets decrypt canary FAILED for org ${orgId}: the configured ` +
            "SCP_SECRETS_MASTER_KEY does not decrypt this instance's vault (AEAD failure). Refusing " +
            "to serve — a member cluster or a restored instance must use the SAME master key as the " +
            "one the vault was encrypted with (appSecrets.existingSecret, identical across clusters). " +
            `Underlying error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  }

  return { orgsEnumerated: orgRows.length, orgsWithSecrets, decryptsAttempted };
}
