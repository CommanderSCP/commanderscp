import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { SyncJournalEntry } from "./federation.js";
import { canonicalJson, canonicalizeDeep } from "./canonical-json.js";

/** Sync-journal hash-chain + Ed25519 signing/verification. See docs/schemas.md §207. */

/** Genesis `prev_hash` for the first entry of an origin domain's journal — mirrors
 *  `audit-chain.ts`'s `AUDIT_GENESIS_HASH` exactly (32 zero bytes, hex-encoded). */
export const JOURNAL_GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON serialization. See docs/schemas.md §208. */
export const canonicalStringify = canonicalJson;

/** Deterministic canonical string for the *content* of a journal entry (everything except
 *  `rowHash`/`signature`, which are derived from / computed over this). Field order fixed at the
 *  top level, AND `payload`'s own keys are recursively sorted (see `canonicalStringify`'s doc). */
export function canonicalizeJournalEntry(
  entry: Omit<SyncJournalEntry, "rowHash" | "signature" | "createdAt">
): string {
  return JSON.stringify({
    id: entry.id,
    orgId: entry.orgId,
    originDomainId: entry.originDomainId,
    sequence: entry.sequence,
    entryKind: entry.entryKind,
    payload: canonicalizeDeep(entry.payload),
    contentHash: entry.contentHash,
    baseRevision: entry.baseRevision,
    conflict: entry.conflict,
    prevHash: entry.prevHash
  });
}

/** `row_hash = sha256(prev_hash || canonical(entry))`, hex-encoded — identical shape to
 *  `audit-chain.ts`'s `computeRowHash`. */
export function computeJournalRowHash(
  entry: Omit<SyncJournalEntry, "rowHash" | "signature" | "createdAt">
): string {
  const hash = createHash("sha256");
  hash.update(entry.prevHash);
  hash.update(canonicalizeJournalEntry(entry));
  return hash.digest("hex");
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

/** Signs a journal row's hash with the origin's private key. See docs/schemas.md §209. */
export function signJournalRowHash(privateKeyB64: string, rowHash: string): string {
  const signature = cryptoSign(
    null,
    Buffer.from(rowHash, "utf8"),
    derPrivateKeyToKeyObject(privateKeyB64)
  );
  return signature.toString("base64");
}

/** Verifies one entry's signature against a given public key (SPKI DER, base64). Never throws —
 *  any malformed key/signature input is treated as a verification failure. */
export function verifyJournalEntrySignature(
  entry: SyncJournalEntry,
  publicKeyB64: string
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(entry.rowHash, "utf8"),
      derPublicKeyToKeyObject(publicKeyB64),
      Buffer.from(entry.signature, "base64")
    );
  } catch {
    return false;
  }
}

/** WHY THE FAILURE IS CODED, not just described. See docs/schemas.md §210. */
export type JournalChainBreakCode =
  /** Contiguity only: a gap or a reorder against the expected next sequence. */
  | "sequence_gap"
  /** Contiguity only: `prevHash` does not link to the previous entry / the caller's anchor. */
  | "prev_hash_mismatch"
  /** Sparse mode: sequences did not strictly increase (a reorder or duplicate). */
  | "sequence_not_increasing"
  /** Sparse mode: the first entry sits below the caller's lower bound. */
  | "sequence_before_start"
  /** Integrity: the row's content does not hash to its recorded `rowHash`. */
  | "row_hash_mismatch"
  /** Integrity: no key is available for this entry's sequence window (fail-closed). */
  | "no_public_key"
  /** Integrity: the entry's Ed25519 signature does not verify. */
  | "signature_invalid";

/** The two codes that mean ONLY "this run is not gap-free" — everything else is an integrity
 *  failure and must never be retried in a laxer mode. */
export const JOURNAL_CONTIGUITY_BREAK_CODES: readonly JournalChainBreakCode[] = [
  "sequence_gap",
  "prev_hash_mismatch"
];

export interface JournalChainVerification {
  valid: boolean;
  entryCount: number;
  /** First entry (by chain order) that failed to verify, if any. */
  brokenAt?: { id: string; sequence: number; reason: string; code: JournalChainBreakCode };
}

/** Verifies chain contiguity and signature for a run. See docs/schemas.md §211. */
export function verifyJournalChain(
  entries: SyncJournalEntry[],
  opts: {
    /** The last known-good `rowHash` this chain must continue from (omit/undefined = genesis).
     *  Ignored when `contiguous === false`. */
    expectedPrevHash?: string;
    /** The sequence the first entry must equal. See docs/schemas.md §212. */
    expectedStartSequence?: number;
    /** Whether the run must be gap-free and prev_hash-linked. See docs/schemas.md §213. */
    contiguous?: boolean;
    /** I hold no anchor, said out loud rather than faked. See docs/schemas.md §214. */
    anchorToFirstEntry?: boolean;
    resolvePublicKey: (entry: SyncJournalEntry) => string | null;
  }
): JournalChainVerification {
  const contiguous = opts.contiguous ?? true;
  let expectedPrevHash = opts.expectedPrevHash ?? JOURNAL_GENESIS_HASH;
  let expectedSequence = opts.expectedStartSequence ?? null;
  let lastSequence: number | null = null;
  let adoptAnchor = contiguous && opts.anchorToFirstEntry === true;

  for (const entry of entries) {
    if (contiguous) {
      if (expectedSequence !== null && entry.sequence !== expectedSequence) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: {
            id: entry.id,
            sequence: entry.sequence,
            reason: `sequence gap or reorder: expected ${expectedSequence}, got ${entry.sequence}`,
            code: "sequence_gap"
          }
        };
      }
      if (adoptAnchor) {
        // First entry, and the caller told us it holds no anchor: adopt, don't compare. Every
        // entry after this one is linked normally (`expectedPrevHash` is reassigned below).
        adoptAnchor = false;
      } else if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: {
            id: entry.id,
            sequence: entry.sequence,
            reason: `prev_hash mismatch: expected ${expectedPrevHash}, got ${entry.prevHash}`,
            code: "prev_hash_mismatch"
          }
        };
      }
    } else {
      // Sparse (scope-filtered): strictly increasing sequence, first >= the lower bound. No
      // prev_hash linkage (deliberate gaps) — but each rowHash/signature is still checked below.
      if (lastSequence !== null && entry.sequence <= lastSequence) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: {
            id: entry.id,
            sequence: entry.sequence,
            reason: `sequence not strictly increasing: ${entry.sequence} after ${lastSequence}`,
            code: "sequence_not_increasing"
          }
        };
      }
      if (lastSequence === null && expectedSequence !== null && entry.sequence < expectedSequence) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: {
            id: entry.id,
            sequence: entry.sequence,
            reason: `sequence ${entry.sequence} precedes expected start ${expectedSequence}`,
            code: "sequence_before_start"
          }
        };
      }
    }
    const recomputed = computeJournalRowHash(entry);
    if (recomputed !== entry.rowHash) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: {
          id: entry.id,
          sequence: entry.sequence,
          reason: `row_hash mismatch: expected ${recomputed}, got ${entry.rowHash}`,
          code: "row_hash_mismatch"
        }
      };
    }
    const publicKey = opts.resolvePublicKey(entry);
    if (!publicKey) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: {
          id: entry.id,
          sequence: entry.sequence,
          reason: "no public key available to verify signature",
          code: "no_public_key"
        }
      };
    }
    if (!verifyJournalEntrySignature(entry, publicKey)) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: {
          id: entry.id,
          sequence: entry.sequence,
          reason: "signature verification failed",
          code: "signature_invalid"
        }
      };
    }
    expectedPrevHash = entry.rowHash;
    expectedSequence = entry.sequence + 1;
    lastSequence = entry.sequence;
  }
  return { valid: true, entryCount: entries.length };
}

/** `.scpbundle` checksum = `sha256(canonicalStringify(payload))`, hex-encoded — covers whatever
 *  the caller considers "the bundle's content" (entries array for a sync bundle, change +
 *  evidence for a promotion bundle). */
export function computeBundleChecksum(payload: unknown): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

export function signBundleChecksum(privateKeyB64: string, checksum: string): string {
  return cryptoSign(
    null,
    Buffer.from(checksum, "utf8"),
    derPrivateKeyToKeyObject(privateKeyB64)
  ).toString("base64");
}

/** Fail-closed: any malformed key/signature input verifies as `false`, never throws. */
export function verifyBundleSignature(
  checksum: string,
  signatureB64: string,
  publicKeyB64: string
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(checksum, "utf8"),
      derPublicKeyToKeyObject(publicKeyB64),
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}
