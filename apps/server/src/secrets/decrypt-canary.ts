import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs, secrets } from "../db/schema.js";
import { decryptSecretValue } from "./crypto.js";

export interface DecryptCanaryResult {
  orgsEnumerated: number;
  orgsWithSecrets: number;
  decryptsAttempted: number;
}

/** D6 / B3 BOOT CANARY. See docs/secrets.md §3. */
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
