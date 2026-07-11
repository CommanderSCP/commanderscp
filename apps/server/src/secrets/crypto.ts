import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for the `secrets` table (db/schema.ts's M7 section doc comment). This is
 * the encryption-at-rest layer `instance_keys` (M4/M6) explicitly opted out of — org-supplied
 * plugin credentials (GitHub App private key, ArgoCD token, managed-IaC infra credentials) are a
 * different trust tier: many tenants, arbitrary third-party secrets, injected into subprocess
 * plugins, not just one federation-domain signing keypair `scp_app` alone ever touches.
 *
 * Key management (honest, v1 scope — no KMS/vault integration, same "no external PKI" posture
 * DESIGN §10.2 takes for attestation signing): the root key is a single 32-byte AES-256 key
 * supplied by the operator via `SCP_SECRETS_MASTER_KEY` (base64), loaded once at boot
 * (config.ts). `keyVersion` on every row is reserved for a future key-rotation scheme (re-encrypt
 * under a new master key, bump the version, keep decrypting old rows under whichever version they
 * were written with) — v1 always writes/reads version 1 and only ever has one active key in
 * memory, but the column exists now so rotation is additive later, not a migration.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12; // GCM's recommended IV length

export const CURRENT_SECRETS_KEY_VERSION = 1;

export interface EncryptedSecret {
  ciphertext: string; // base64(ciphertext || authTag)
  nonce: string; // base64
  keyVersion: number;
}

function requireKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `secrets master key must be exactly ${KEY_BYTES} bytes (got ${key.length}) — SCP_SECRETS_MASTER_KEY must decode (base64) to ${KEY_BYTES} bytes`
    );
  }
}

export function encryptSecretValue(plaintext: string, masterKey: Buffer): EncryptedSecret {
  requireKeyLength(masterKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
    nonce: nonce.toString("base64"),
    keyVersion: CURRENT_SECRETS_KEY_VERSION
  };
}

export function decryptSecretValue(encrypted: EncryptedSecret, masterKey: Buffer): string {
  requireKeyLength(masterKey);
  const raw = Buffer.from(encrypted.ciphertext, "base64");
  // Auth tag is always the trailing 16 bytes (GCM standard tag length) of what encryptSecretValue
  // concatenated above — split it back off before decrypting.
  const authTag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const nonce = Buffer.from(encrypted.nonce, "base64");
  const decipher = createDecipheriv(ALGORITHM, masterKey, nonce);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Parses `SCP_SECRETS_MASTER_KEY` (base64) into the 32-byte key `encrypt`/`decryptSecretValue`
 *  need. Thrown errors are meant to fail boot loudly (config.ts), never to be swallowed. */
export function parseMasterKeyBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  requireKeyLength(key);
  return key;
}

export function generateMasterKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
