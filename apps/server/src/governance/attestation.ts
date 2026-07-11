import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { instanceKeys } from "../db/schema.js";
// M6: imported from the shared `util/` module, NOT `graph/objects-repo.js` — that module now
// transitively imports THIS one (via federation/journal-repo.js's `ensureInstanceKey`), so
// importing back from it here would close an import cycle. See util/canonical-json.ts's doc.
import { canonicalJson } from "../util/canonical-json.js";

/**
 * Ed25519 approval attestation (DESIGN.md §10.2 "review decision": "every approval is
 * cryptographically attested at creation — the domain instance signs (Ed25519 domain key) a
 * canonical record binding the approver's subject id and IdP subject, the approved object's URN
 * and content hash, the decision id, and the timestamp... SCP performs all signing and validation
 * itself — no external PKI"). SECURITY-SENSITIVE (M4 PR body flag: "approval quorum integrity").
 *
 * The signature does not, by itself, add authorization (that's `authz/resolve.ts`'s
 * `hasRoleAtScope`, checked before a vote is even accepted — attestation.ts never gates anything).
 * What it buys: an approval record that is tamper-evident and independently verifiable — by
 * `scp audit verify` today, and by an importing domain validating a Promotion Bundle's approvals
 * as evidence once federation (M6) exists (DESIGN §13) — without SCP needing to trust the
 * `approval_votes` row's plain columns alone.
 */

export interface InstanceKeyPair {
  id: string;
  publicKey: string; // base64
  privateKey: string; // base64 (PKCS8 DER) — server-side only, never sent to a client
}

/** Reads this org's signing key, generating and persisting one on first use (no migration seed —
 *  key material must never live in committed SQL). M6: org-scoped (schema.ts's updated doc
 *  comment on `instanceKeys` explains why) — every caller now supplies `orgId`, which in a real
 *  deployment is this instance's one org, but lets federation's tests model two distinct domains
 *  as two orgs with genuinely different keys. Race-safe: a duplicate-insert on concurrent
 *  first-use callers for the SAME org is resolved by re-reading rather than erroring, relying on
 *  `instance_keys_org_id_key`'s unique constraint (schema.ts) to make the loop below always
 *  converge on whichever row was inserted first. */
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
  signature: string; // base64
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
