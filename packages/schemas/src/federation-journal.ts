import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { SyncJournalEntry } from "./federation.js";

/**
 * Sync-journal hash-chain + Ed25519 signing/verification (DESIGN.md §13) — deliberately NOT part
 * of this package's default `"."` export, for the exact reason `audit-chain.ts` isn't: it depends
 * on Node's `node:crypto`, and `@scp/schemas`'s default entry is imported by `apps/web` (browser
 * build) via `@scp/sdk`. Import via the `@scp/schemas/federation-journal` subpath instead
 * (apps/server's federation module, `packages/cli`'s `scp federation` commands), keeping
 * `node:crypto` out of any module graph Rollup resolves starting from the package's main entry.
 *
 * Pure functions throughout (BUILD_AND_TEST.md §4.1/§7 — `federation/journal` is one of the
 * modules held to ≥95% branch coverage): no I/O, table-driven-testable, safe to run both
 * server-side (writing/verifying the journal) and client-side (`scp federation import` verifying
 * a bundle before ever touching the DB).
 *
 * SECURITY-SENSITIVE (M6 PR body flag): `verifyJournalChain` is the fail-closed gate a tampered or
 * truncated segment must never pass — a bad signature, a broken hash link, a sequence gap, or a
 * reordering all return `valid: false`, and callers MUST reject the entire segment/bundle on any
 * such result (never apply a "mostly valid" prefix implicitly — callers that want partial-prefix
 * application must slice the input themselves BEFORE calling this and treat that as a deliberate
 * choice, not verification's default).
 */

/** Genesis `prev_hash` for the first entry of an origin domain's journal — mirrors
 *  `audit-chain.ts`'s `AUDIT_GENESIS_HASH` exactly (32 zero bytes, hex-encoded). */
export const JOURNAL_GENESIS_HASH = "0".repeat(64);

/** Deterministic canonical string for the *content* of a journal entry (everything except
 *  `rowHash`/`signature`, which are derived from / computed over this). Field order fixed. */
export function canonicalizeJournalEntry(
  entry: Omit<SyncJournalEntry, "rowHash" | "signature" | "createdAt">
): string {
  return JSON.stringify({
    id: entry.id,
    orgId: entry.orgId,
    originDomainId: entry.originDomainId,
    sequence: entry.sequence,
    entryKind: entry.entryKind,
    payload: entry.payload,
    contentHash: entry.contentHash,
    baseRevision: entry.baseRevision,
    conflict: entry.conflict,
    prevHash: entry.prevHash
  });
}

/** `row_hash = sha256(prev_hash || canonical(entry))`, hex-encoded — identical shape to
 *  `audit-chain.ts`'s `computeRowHash`. */
export function computeJournalRowHash(entry: Omit<SyncJournalEntry, "rowHash" | "signature" | "createdAt">): string {
  const hash = createHash("sha256");
  hash.update(entry.prevHash);
  hash.update(canonicalizeJournalEntry(entry));
  return hash.digest("hex");
}

function derPublicKeyToKeyObject(publicKeyB64: string) {
  return { key: Buffer.from(publicKeyB64, "base64"), format: "der" as const, type: "spki" as const };
}
function derPrivateKeyToKeyObject(privateKeyB64: string) {
  return { key: Buffer.from(privateKeyB64, "base64"), format: "der" as const, type: "pkcs8" as const };
}

/** Signs a journal row's `rowHash` with the origin domain's Ed25519 private key (PKCS8 DER,
 *  base64). Signing the hash — rather than re-signing the full entry content — is sufficient: the
 *  hash is already a binding cryptographic commitment to `prevHash` (chain position) plus every
 *  content field, so a signature over it transitively authenticates the whole chain up to and
 *  including this entry. */
export function signJournalRowHash(privateKeyB64: string, rowHash: string): string {
  const signature = cryptoSign(null, Buffer.from(rowHash, "utf8"), derPrivateKeyToKeyObject(privateKeyB64));
  return signature.toString("base64");
}

/** Verifies one entry's signature against a given public key (SPKI DER, base64). Never throws —
 *  any malformed key/signature input is treated as a verification failure. */
export function verifyJournalEntrySignature(entry: SyncJournalEntry, publicKeyB64: string): boolean {
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

export interface JournalChainVerification {
  valid: boolean;
  entryCount: number;
  /** First entry (by chain order) that failed to verify, if any. */
  brokenAt?: { id: string; sequence: number; reason: string };
}

/**
 * Verifies hash-chain contiguity AND Ed25519 signature for a contiguous run of entries from ONE
 * origin domain, already sorted ascending by `sequence`. `resolvePublicKey` returns the public key
 * in force for a given entry (callers resolve this from their peer-key registry, honoring
 * rotation history — a segment signed before a rotation must still verify against the OLD key
 * that was current at signing time); returning `null` is treated as "no key available" and fails
 * closed.
 *
 * Checks, in order, for every entry: (1) `sequence` is exactly one more than the previous entry's
 * (or equals the caller-supplied starting sequence for the first entry) — catches gaps AND
 * reordering; (2) `prevHash` matches the running expected hash — catches truncation/splicing;
 * (3) `rowHash` recomputes correctly — catches content tampering; (4) the signature verifies
 * against the resolved public key — catches a forged row that happens to hash-chain correctly
 * (impossible without the private key, but checked independently regardless). ANY failure returns
 * `valid: false` immediately — the caller must reject the WHOLE input, never apply a valid prefix
 * implicitly.
 */
export function verifyJournalChain(
  entries: SyncJournalEntry[],
  opts: {
    /** The last known-good `rowHash` this chain must continue from (omit/undefined = genesis). */
    expectedPrevHash?: string;
    /** The sequence the first entry must equal (omit = accept whatever the first entry claims,
     *  provided everything after it is contiguous — callers resuming from a cursor should pass
     *  `cursor + 1` here so a caller can't be fed a segment that silently skips entries). */
    expectedStartSequence?: number;
    resolvePublicKey: (entry: SyncJournalEntry) => string | null;
  }
): JournalChainVerification {
  let expectedPrevHash = opts.expectedPrevHash ?? JOURNAL_GENESIS_HASH;
  let expectedSequence = opts.expectedStartSequence ?? null;

  for (const entry of entries) {
    if (expectedSequence !== null && entry.sequence !== expectedSequence) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: {
          id: entry.id,
          sequence: entry.sequence,
          reason: `sequence gap or reorder: expected ${expectedSequence}, got ${entry.sequence}`
        }
      };
    }
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: {
          id: entry.id,
          sequence: entry.sequence,
          reason: `prev_hash mismatch: expected ${expectedPrevHash}, got ${entry.prevHash}`
        }
      };
    }
    const recomputed = computeJournalRowHash(entry);
    if (recomputed !== entry.rowHash) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: {
          id: entry.id,
          sequence: entry.sequence,
          reason: `row_hash mismatch: expected ${recomputed}, got ${entry.rowHash}`
        }
      };
    }
    const publicKey = opts.resolvePublicKey(entry);
    if (!publicKey) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: { id: entry.id, sequence: entry.sequence, reason: "no public key available to verify signature" }
      };
    }
    if (!verifyJournalEntrySignature(entry, publicKey)) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAt: { id: entry.id, sequence: entry.sequence, reason: "signature verification failed" }
      };
    }
    expectedPrevHash = entry.rowHash;
    expectedSequence = entry.sequence + 1;
  }
  return { valid: true, entryCount: entries.length };
}

/** Deterministic JSON serialization (recursively sorted object keys) — the `.scpbundle` envelope's
 *  checksum/signature cover this, not `JSON.stringify`'s insertion-order-dependent output.
 *  Duplicated (rather than imported) from `apps/server/src/graph/objects-repo.ts`'s identical
 *  helper because this package must stay server-independent (BUILD_AND_TEST.md §3 module
 *  boundaries — `@scp/schemas` has no dependency on `apps/server`). */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** `.scpbundle` checksum = `sha256(canonicalStringify(payload))`, hex-encoded — covers whatever
 *  the caller considers "the bundle's content" (entries array for a sync bundle, change +
 *  evidence for a promotion bundle). */
export function computeBundleChecksum(payload: unknown): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

export function signBundleChecksum(privateKeyB64: string, checksum: string): string {
  return cryptoSign(null, Buffer.from(checksum, "utf8"), derPrivateKeyToKeyObject(privateKeyB64)).toString(
    "base64"
  );
}

/** Fail-closed: any malformed key/signature input verifies as `false`, never throws. */
export function verifyBundleSignature(checksum: string, signatureB64: string, publicKeyB64: string): boolean {
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
