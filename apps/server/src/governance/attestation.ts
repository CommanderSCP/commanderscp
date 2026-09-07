import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { instanceKeys } from "../db/schema.js";
// M6: imported from the shared `util/` module, NOT `graph/objects-repo.js` — that module now
// transitively imports THIS one (via federation/journal-repo.js's `ensureInstanceKey`), so
// importing back from it here would close an import cycle. See util/canonical-json.ts's doc.
import { canonicalJson } from "../util/canonical-json.js";

/** Ed25519 approval attestation. See docs/governance.md §17. */

export interface InstanceKeyPair {
  id: string;
  publicKey: string;
  privateKey: string; // base64 (PKCS8 DER) — server-side only, never sent to a client
}

/** Reads the org's signing key, generating one on first use. See docs/governance.md §18. */
export async function ensureInstanceKey(tx: TenantTx, orgId: string): Promise<InstanceKeyPair> {
  const existing = await tx
    .select()
    .from(instanceKeys)
    .where(eq(instanceKeys.orgId, orgId))
    .limit(1);
  if (existing[0]) {
    return {
      id: existing[0].id,
      publicKey: existing[0].publicKey,
      privateKey: existing[0].privateKey
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  let row: typeof instanceKeys.$inferSelect | undefined;
  try {
    [row] = await tx
      .insert(instanceKeys)
      .values({ id: uuidv7(), orgId, publicKey: publicKeyB64, privateKey: privateKeyB64 })
      .returning();
  } catch {
    // Lost a race with a concurrent first-use caller for the SAME org — fall through to re-read.
  }
  if (row) return { id: row.id, publicKey: row.publicKey, privateKey: row.privateKey };

  const afterRace = await tx
    .select()
    .from(instanceKeys)
    .where(eq(instanceKeys.orgId, orgId))
    .limit(1);
  if (!afterRace[0])
    throw new Error(
      `ensureInstanceKey: failed to create or read the signing key for org '${orgId}'`
    );
  return {
    id: afterRace[0].id,
    publicKey: afterRace[0].publicKey,
    privateKey: afterRace[0].privateKey
  };
}

/** The canonical record an attestation signs over — DESIGN §10.2's exact field list. */
export interface AttestationRecord {
  approverSubjectId: string;
  approverIdpSubject: string | null;
  approvedObjectUrn: string;
  approvedObjectContentHash: string;
  decisionId: string | null;
  timestamp: string; // ISO 8601
}

export interface SignedAttestation {
  record: AttestationRecord;
  signature: string;
  publicKey: string; // base64 — carried alongside so verification never needs a live DB lookup
}

function derPublicKeyToKeyObject(publicKeyB64: string) {
  return {
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der" as const,
    type: "spki" as const
  };
}
function derPrivateKeyToKeyObject(privateKeyB64: string) {
  return {
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der" as const,
    type: "pkcs8" as const
  };
}

export function signAttestation(
  key: InstanceKeyPair,
  record: AttestationRecord
): SignedAttestation {
  const message = Buffer.from(canonicalJson(record), "utf8");
  const signature = cryptoSign(null, message, derPrivateKeyToKeyObject(key.privateKey));
  return { record, signature: signature.toString("base64"), publicKey: key.publicKey };
}

/** Independently verifiable given only the attestation itself (`scp audit verify` / a future
 *  federation importer) — no DB access, no trust in the caller's own copy of the instance key. */
export function verifyAttestation(attestation: SignedAttestation): boolean {
  try {
    const message = Buffer.from(canonicalJson(attestation.record), "utf8");
    return cryptoVerify(
      null,
      message,
      derPublicKeyToKeyObject(attestation.publicKey),
      Buffer.from(attestation.signature, "base64")
    );
  } catch {
    return false;
  }
}
