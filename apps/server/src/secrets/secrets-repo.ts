import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { secrets } from "../db/schema.js";
import { decryptSecretValue, encryptSecretValue } from "./crypto.js";

/**
 * CRUD over the encrypted `secrets` table (db/schema.ts's M7 section, crypto.ts's AES-256-GCM
 * envelope). Every read/write here is org-scoped through `TenantTx` (RLS-backed, same as every
 * other tenant table) — there is no cross-org secret lookup path.
 */

export interface PutSecretInput {
  orgId: string;
  key: string;
  value: string;
  masterKey: Buffer;
}

export async function putSecret(tx: TenantTx, input: PutSecretInput): Promise<void> {
  const encrypted = encryptSecretValue(input.value, input.masterKey);
  const existing = await tx
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.orgId, input.orgId), eq(secrets.key, input.key)))
    .limit(1);

  if (existing[0]) {
    await tx
      .update(secrets)
      .set({
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyVersion: encrypted.keyVersion,
        updatedAt: new Date()
      })
      .where(eq(secrets.id, existing[0].id));
    return;
  }

  await tx.insert(secrets).values({
    id: uuidv7(),
    orgId: input.orgId,
    key: input.key,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    keyVersion: encrypted.keyVersion
  });
}

/** Resolves one secret's plaintext value — `undefined` when no row exists for `key` under this
 *  org (never throws for "not found"; a missing secret is a configuration fact a caller decides
 *  how to react to, same posture as `SecretsAccessor.get()` in `@scp/plugin-api`). */
export async function getSecretValue(
  tx: TenantTx,
  orgId: string,
  key: string,
  masterKey: Buffer
): Promise<string | undefined> {
  const rows = await tx
    .select()
    .from(secrets)
    .where(and(eq(secrets.orgId, orgId), eq(secrets.key, key)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return decryptSecretValue(
    { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion },
    masterKey
  );
}

/** Resolves every `{configFieldName: secretKey}` ref in one call (executor/notification bindings'
 *  `secretRefs` column) into `{configFieldName: plaintextValue}` — refs that don't resolve to an
 *  existing secret are silently omitted from the result (fail-soft here; the plugin itself decides
 *  whether a missing credential is fatal when it tries to use it, exactly like `SecretsAccessor`
 *  contract's `Promise<string | undefined>`). */
export async function resolveSecretRefs(
  tx: TenantTx,
  orgId: string,
  secretRefs: Record<string, string>,
  masterKey: Buffer
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [field, key] of Object.entries(secretRefs)) {
    const value = await getSecretValue(tx, orgId, key, masterKey);
    if (value !== undefined) resolved[field] = value;
  }
  return resolved;
}

export async function deleteSecret(tx: TenantTx, orgId: string, key: string): Promise<void> {
  await tx.delete(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.key, key)));
}

export async function listSecretKeys(tx: TenantTx, orgId: string): Promise<string[]> {
  const rows = await tx.select({ key: secrets.key }).from(secrets).where(eq(secrets.orgId, orgId));
  return rows.map((r) => r.key);
}
