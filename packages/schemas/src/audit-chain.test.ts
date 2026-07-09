import { describe, expect, it } from "vitest";
import { AUDIT_GENESIS_HASH, computeRowHash, verifyAuditChain } from "./audit-chain.js";
import type { AuditEvent } from "./audit.js";

function baseEvent(overrides: Partial<AuditEvent> = {}): Omit<AuditEvent, "rowHash"> {
  return {
    id: "0198f2a0-0000-7000-8000-000000000001",
    orgId: "0198f2a0-0000-7000-8000-000000000000",
    domainId: null,
    actorId: "0198f2a0-0000-7000-8000-000000000002",
    action: "object.create",
    subjectId: "0198f2a0-0000-7000-8000-000000000003",
    beforeHash: null,
    afterHash: "deadbeef",
    reason: null,
    decisionId: null,
    requestId: "req-1",
    occurredAt: "2026-07-08T12:00:00.000Z",
    prevHash: AUDIT_GENESIS_HASH,
    ...overrides
  };
}

describe("audit hash chain", () => {
  it("verifies a well-formed chain of any length", () => {
    const e1 = baseEvent();
    const rowHash1 = computeRowHash(e1);
    const e2 = baseEvent({ id: "0198f2a0-0000-7000-8000-000000000004", prevHash: rowHash1 });
    const rowHash2 = computeRowHash(e2);

    const result = verifyAuditChain([
      { ...e1, rowHash: rowHash1 },
      { ...e2, rowHash: rowHash2 }
    ]);
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(2);
  });

  it("verifies the empty chain", () => {
    expect(verifyAuditChain([])).toEqual({ valid: true, eventCount: 0 });
  });

  it("rejects a chain whose genesis prev_hash is wrong", () => {
    const e1 = baseEvent({ prevHash: "not-genesis" });
    const result = verifyAuditChain([{ ...e1, rowHash: computeRowHash(e1) }]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.id).toBe(e1.id);
  });

  it("rejects a tampered row_hash", () => {
    const e1 = baseEvent();
    const result = verifyAuditChain([{ ...e1, rowHash: "tampered" }]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toMatch(/row_hash mismatch/);
  });

  it("rejects a tampered prev_hash link between two events", () => {
    const e1 = baseEvent();
    const rowHash1 = computeRowHash(e1);
    const e2 = baseEvent({ id: "0198f2a0-0000-7000-8000-000000000004", prevHash: "wrong-link" });
    const result = verifyAuditChain([
      { ...e1, rowHash: rowHash1 },
      { ...e2, rowHash: computeRowHash(e2) }
    ]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.id).toBe(e2.id);
  });

  it("detects a swapped/reordered event as a broken chain", () => {
    const e1 = baseEvent();
    const rowHash1 = computeRowHash(e1);
    const e2 = baseEvent({ id: "0198f2a0-0000-7000-8000-000000000004", prevHash: rowHash1 });
    const rowHash2 = computeRowHash(e2);

    // Reordered: e2 first, e1 second — e2's prev_hash no longer matches genesis.
    const result = verifyAuditChain([
      { ...e2, rowHash: rowHash2 },
      { ...e1, rowHash: rowHash1 }
    ]);
    expect(result.valid).toBe(false);
  });

  it("is deterministic: same content always hashes the same", () => {
    const e = baseEvent();
    expect(computeRowHash(e)).toBe(computeRowHash({ ...e }));
  });
});
