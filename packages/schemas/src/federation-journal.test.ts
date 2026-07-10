import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  JOURNAL_GENESIS_HASH,
  computeBundleChecksum,
  computeJournalRowHash,
  signBundleChecksum,
  signJournalRowHash,
  verifyBundleSignature,
  verifyJournalChain,
  verifyJournalEntrySignature
} from "./federation-journal.js";
import type { SyncJournalEntry } from "./federation.js";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  };
}

const ORIGIN = "0198f2a0-0000-7000-8000-000000000000";
const ORG = "0198f2a0-0000-7000-8000-000000000001";

function baseEntry(
  privateKey: string,
  overrides: Partial<Omit<SyncJournalEntry, "rowHash" | "signature">> = {}
): SyncJournalEntry {
  const draft: Omit<SyncJournalEntry, "rowHash" | "signature"> = {
    id: "0198f2a0-0000-7000-8000-000000000010",
    orgId: ORG,
    originDomainId: ORIGIN,
    sequence: 1,
    entryKind: "object_upsert",
    payload: { id: "obj-1", urn: "urn:scp:acme:service:billing" },
    contentHash: "deadbeef",
    baseRevision: null,
    conflict: null,
    prevHash: JOURNAL_GENESIS_HASH,
    createdAt: "2026-07-08T12:00:00.000Z",
    ...overrides
  };
  const rowHash = computeJournalRowHash(draft);
  const signature = signJournalRowHash(privateKey, rowHash);
  return { ...draft, rowHash, signature };
}

describe("sync journal hash chain (pure)", () => {
  it("verifies a well-formed single-domain chain", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey, { sequence: 1, prevHash: JOURNAL_GENESIS_HASH });
    const e2 = baseEntry(privateKey, {
      id: "0198f2a0-0000-7000-8000-000000000011",
      sequence: 2,
      prevHash: e1.rowHash
    });

    const result = verifyJournalChain([e1, e2], { resolvePublicKey: () => publicKey });
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(2);
  });

  it("verifies the empty chain", () => {
    expect(verifyJournalChain([], { resolvePublicKey: () => null })).toEqual({
      valid: true,
      entryCount: 0
    });
  });

  it("rejects a chain whose genesis prev_hash is wrong", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey, { prevHash: "not-genesis" });
    const result = verifyJournalChain([e1], { resolvePublicKey: () => publicKey });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.id).toBe(e1.id);
    expect(result.brokenAt?.reason).toMatch(/prev_hash mismatch/);
  });

  it("rejects a tampered row_hash (content tampering)", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey);
    const tampered = { ...e1, payload: { ...e1.payload, injected: true } };
    const result = verifyJournalChain([tampered], { resolvePublicKey: () => publicKey });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toMatch(/row_hash mismatch/);
  });

  it("rejects a tampered prev_hash link between two entries (splice/truncation)", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey, { sequence: 1 });
    const e2 = baseEntry(privateKey, {
      id: "0198f2a0-0000-7000-8000-000000000011",
      sequence: 2,
      prevHash: "wrong-link"
    });
    const result = verifyJournalChain([e1, e2], { resolvePublicKey: () => publicKey });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.id).toBe(e2.id);
  });

  it("detects a reordered/swapped entry as a broken chain", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey, { sequence: 1 });
    const e2 = baseEntry(privateKey, {
      id: "0198f2a0-0000-7000-8000-000000000011",
      sequence: 2,
      prevHash: e1.rowHash
    });
    const result = verifyJournalChain([e2, e1], { resolvePublicKey: () => publicKey });
    expect(result.valid).toBe(false);
  });

  it("detects a sequence gap (a dropped/missing entry)", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey, { sequence: 1 });
    // sequence jumps 1 -> 3, skipping 2 — the prev_hash link is even correct (attacker recomputed
    // it), but the gap itself must still be caught independently of hash-chain contiguity.
    const e3 = baseEntry(privateKey, {
      id: "0198f2a0-0000-7000-8000-000000000012",
      sequence: 3,
      prevHash: e1.rowHash
    });
    const result = verifyJournalChain([e1, e3], { resolvePublicKey: () => publicKey });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toMatch(/sequence gap/);
  });

  it("rejects when resuming from a cursor that doesn't match the segment's first sequence", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey, { sequence: 5, prevHash: "some-known-tail-hash" });
    const result = verifyJournalChain([e1], {
      expectedPrevHash: "some-known-tail-hash",
      expectedStartSequence: 10, // resuming caller expects sequence 10 next, not 5
      resolvePublicKey: () => publicKey
    });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toMatch(/sequence gap/);
  });

  it("SECURITY: rejects a structurally valid chain signed with the WRONG key (forged authorship)", () => {
    const legit = keyPair();
    const attacker = keyPair();
    const e1 = baseEntry(attacker.privateKey, { sequence: 1 });
    // Verifier resolves the LEGITIMATE origin domain's registered public key — the attacker's
    // signature (valid under their own key) must NOT verify against it.
    const result = verifyJournalChain([e1], { resolvePublicKey: () => legit.publicKey });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toMatch(/signature verification failed/);
  });

  it("SECURITY: fails closed when no public key is available to verify against", () => {
    const { privateKey } = keyPair();
    const e1 = baseEntry(privateKey);
    const result = verifyJournalChain([e1], { resolvePublicKey: () => null });
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toMatch(/no public key available/);
  });

  it("is deterministic: same content always row-hashes the same", () => {
    const { privateKey } = keyPair();
    const e = baseEntry(privateKey);
    const draft = { ...e };
    // @ts-expect-error stripping derived fields for the recompute
    delete draft.rowHash;
    // @ts-expect-error stripping derived fields for the recompute
    delete draft.signature;
    expect(computeJournalRowHash(draft)).toBe(computeJournalRowHash({ ...draft }));
  });
});

describe("Ed25519 entry signature verification (isolated from chain walking)", () => {
  it("verifies a correctly signed entry", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey);
    expect(verifyJournalEntrySignature(e1, publicKey)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const { publicKey, privateKey } = keyPair();
    const e1 = baseEntry(privateKey);
    expect(verifyJournalEntrySignature({ ...e1, signature: "not-base64-!!" }, publicKey)).toBe(false);
  });

  it("rejects a malformed public key rather than throwing", () => {
    const { privateKey } = keyPair();
    const e1 = baseEntry(privateKey);
    expect(() => verifyJournalEntrySignature(e1, "garbage-not-a-key")).not.toThrow();
    expect(verifyJournalEntrySignature(e1, "garbage-not-a-key")).toBe(false);
  });
});

describe(".scpbundle checksum + signature (bundle-level, shared by sync + promotion bundles)", () => {
  it("round-trips: sign then verify succeeds", () => {
    const { publicKey, privateKey } = keyPair();
    const checksum = computeBundleChecksum({ entries: [1, 2, 3] });
    const signature = signBundleChecksum(privateKey, checksum);
    expect(verifyBundleSignature(checksum, signature, publicKey)).toBe(true);
  });

  it("is deterministic regardless of object key order (canonical stringify)", () => {
    const a = computeBundleChecksum({ a: 1, b: 2 });
    const b = computeBundleChecksum({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("SECURITY: rejects a bundle whose payload was tampered after signing", () => {
    const { publicKey, privateKey } = keyPair();
    const checksum = computeBundleChecksum({ entries: [1, 2, 3] });
    const signature = signBundleChecksum(privateKey, checksum);
    const tamperedChecksum = computeBundleChecksum({ entries: [1, 2, 3, 4] });
    expect(verifyBundleSignature(tamperedChecksum, signature, publicKey)).toBe(false);
  });

  it("SECURITY: rejects a signature from the wrong key", () => {
    const legit = keyPair();
    const attacker = keyPair();
    const checksum = computeBundleChecksum({ entries: [1] });
    const forgedSignature = signBundleChecksum(attacker.privateKey, checksum);
    expect(verifyBundleSignature(checksum, forgedSignature, legit.publicKey)).toBe(false);
  });
});
