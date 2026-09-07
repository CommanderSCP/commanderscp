import { createHash } from "node:crypto";
import type { AuditEvent } from "./audit.js";

/** Hash-chain canonicalization/verification (DESIGN.md §4.3). See docs/schemas.md §2. */

/** Genesis `prev_hash` for the first event in an org's chain — 32 zero bytes, hex-encoded. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** The deterministic canonical string for an event's content. See docs/schemas.md §3. */
export function canonicalizeAuditEvent(event: Omit<AuditEvent, "rowHash">): string {
  return JSON.stringify({
    id: event.id,
    orgId: event.orgId,
    domainId: event.domainId,
    actorId: event.actorId,
    action: event.action,
    subjectId: event.subjectId,
    beforeHash: event.beforeHash,
    afterHash: event.afterHash,
    reason: event.reason,
    decisionId: event.decisionId,
    requestId: event.requestId,
    occurredAt: event.occurredAt,
    prevHash: event.prevHash
  });
}

export function computeRowHash(event: Omit<AuditEvent, "rowHash">): string {
  const hash = createHash("sha256");
  hash.update(event.prevHash);
  hash.update(canonicalizeAuditEvent(event));
  return hash.digest("hex");
}

export interface AuditChainVerification {
  valid: boolean;
  eventCount: number;
  /** First event (by chain order) whose hash didn't verify, if any. */
  brokenAt?: { id: string; reason: string };
}

/** Re-walks a per-org audit chain. See docs/schemas.md §4. */
export function verifyAuditChain(events: AuditEvent[]): AuditChainVerification {
  let expectedPrevHash = AUDIT_GENESIS_HASH;
  for (const event of events) {
    if (event.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAt: {
          id: event.id,
          reason: `prev_hash mismatch: expected ${expectedPrevHash}, got ${event.prevHash}`
        }
      };
    }
    const recomputed = computeRowHash(event);
    if (recomputed !== event.rowHash) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAt: {
          id: event.id,
          reason: `row_hash mismatch: expected ${recomputed}, got ${event.rowHash}`
        }
      };
    }
    expectedPrevHash = event.rowHash;
  }
  return { valid: true, eventCount: events.length };
}
