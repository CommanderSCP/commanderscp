import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { generateKeyPair, type GeneratedKeyPair } from "@scp/cosign";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { instanceCosignKeys } from "../db/schema.js";

/**
 * The org's cosign MANIFEST-SIGNING keypair (M17.3 E4) — the cosign analogue of
 * `governance/attestation.ts`'s `ensureInstanceKey` (Ed25519), and DELIBERATELY MODELLED ON IT:
 * lazy first-use provisioning, race-safe convergence on one row, ORG-SCOPED + RLS-protected, no
 * committed-SQL seed. E6 signs each org's promotion manifests with this key; E5 distributes the
 * PUBLIC half to outposts for verification.
 *
 * WHY A DEDICATED TABLE (`instance_cosign_keys`), NOT the `secrets` vault (owner decision, M17.3
 * grounding Area C): `secrets/secrets-repo.ts` `resolveSecretRefs` can resolve any
 * `executor_bindings.secretRefs` entry into a `secrets` row and `plugin-host/host.ts` injects that
 * plaintext into a plugin subprocess. A dedicated table is STRUCTURALLY unreachable by that path —
 * `resolveSecretRefs` queries `secrets` only and has no code path here — so the SCP signing key
 * can never be exfiltrated into a plugin (proven by cosign-keys.integration.test.ts).
 *
 * KEY MANAGEMENT ONLY. This module does NOT sign any manifest and does NOT touch export/gate
 * behaviour — those are E6. It manages the keypair and exposes accessors for E5/E6 to build on.
 */

/** The full keypair — INTERNAL to the server. `privateKey` (cosign's empty-password encrypted PEM)
 *  is never returned over any HTTP API or SDK type; E6 materializes it to an ephemeral tmpfile at
 *  sign time. Use `getInstanceCosignPublicKey` for anything that leaves the server. */
export interface InstanceCosignKeyPair {
  id: string;
  publicKey: string; // cosign public-key PEM (`cosign.pub`) — not a secret
  privateKey: string; // cosign empty-password encrypted PEM (`cosign.key`) — server-side only
  fingerprint: string; // SHA-256 (hex) of the public-key PEM
}

/** Just the non-secret half — the ONLY shape any distribution/API path (E5) ever needs. The type
 *  omits `privateKey` by construction, so a caller cannot accidentally leak it. */
export interface InstanceCosignPublicKey {
  publicKey: string;
  fingerprint: string;
}

/** Injectable for tests (lets the race/RLS/API tests avoid the real cosign subprocess when they
 *  only care about table behaviour). Defaults to the real offline @scp/cosign generator. */
export type CosignKeyGenerator = () => Promise<GeneratedKeyPair>;

/** SHA-256 (hex) of a public-key PEM — a stable, non-secret identifier for a keypair. */
export function cosignPublicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem, "utf8").digest("hex");
}

function toPair(row: typeof instanceCosignKeys.$inferSelect): InstanceCosignKeyPair {
  return {
    id: row.id,
    publicKey: row.publicKey,
    privateKey: row.privateKey,
    fingerprint: row.fingerprint ?? cosignPublicKeyFingerprint(row.publicKey)
  };
}

/**
 * Read this org's cosign keypair, generating and persisting one on first use (no migration seed —
 * key material must never live in committed SQL). This IS the internal private-key accessor E6's
 * signing path uses.
 *
 * RACE-SAFE, mirroring `ensureInstanceKey`: the cosign key is generated OUTSIDE any DB transaction
 * (never hold a tx open across the cosign subprocess), then inserted with
 * `ON CONFLICT (org_id) DO NOTHING` and re-SELECTed, so concurrent first-use callers for the SAME
 * org converge on whichever single row won — `instance_cosign_keys_org_id_key` (unique on org_id)
 * guarantees at most one keypair per org.
 */
export async function ensureInstanceCosignKey(
  db: Db,
  orgId: string,
  generate: CosignKeyGenerator = generateKeyPair
): Promise<InstanceCosignKeyPair> {
  // Fast path: already provisioned. A plain read inside the tenant tx (RLS-scoped).
  const existing = await withTenantTx(db, orgId, (tx) =>
    tx.select().from(instanceCosignKeys).where(eq(instanceCosignKeys.orgId, orgId)).limit(1)
  );
  if (existing[0]) return toPair(existing[0]);

  // Generate OUTSIDE the DB transaction — the cosign subprocess must never run while a tx (and its
  // pooled connection) is held open.
  const { privateKeyPem, publicKeyPem } = await generate();
  const fingerprint = cosignPublicKeyFingerprint(publicKeyPem);

  // Race-safe insert + re-read. If a concurrent caller inserted between our read and here, our
  // freshly-generated pair is discarded by ON CONFLICT DO NOTHING and we return the winning row.
  const row = await withTenantTx(db, orgId, async (tx) => {
    await tx
      .insert(instanceCosignKeys)
      .values({ id: uuidv7(), orgId, privateKey: privateKeyPem, publicKey: publicKeyPem, fingerprint })
      .onConflictDoNothing({ target: instanceCosignKeys.orgId });
    const rows = await tx
      .select()
      .from(instanceCosignKeys)
      .where(eq(instanceCosignKeys.orgId, orgId))
      .limit(1);
    return rows[0];
  });

  if (!row)
    throw new Error(
      `ensureInstanceCosignKey: failed to create or read the cosign signing key for org '${orgId}'`
    );
  return toPair(row);
}

/**
 * The PUBLIC-key accessor (E5's distribution seam). Ensures the keypair exists, then returns ONLY
 * the non-secret half — the return type structurally omits the private key, so nothing that goes
 * over an API can carry it.
 */
export async function getInstanceCosignPublicKey(
  db: Db,
  orgId: string,
  generate: CosignKeyGenerator = generateKeyPair
): Promise<InstanceCosignPublicKey> {
  const pair = await ensureInstanceCosignKey(db, orgId, generate);
  return { publicKey: pair.publicKey, fingerprint: pair.fingerprint };
}
