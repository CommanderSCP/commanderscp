import { createHash } from "node:crypto";
import { z } from "zod";
import { cursorPageResponseSchema } from "./common.js";

/**
 * Hash-chained append-only audit log (DESIGN.md §4.3). The canonicalization + hashing algorithm
 * lives here (not in `apps/server`) so both the server (writes the chain) and the CLI
 * (`scp audit verify`, which re-walks the chain via the public API only — DESIGN.md §4.3) share
 * one implementation. Pure functions, table-driven-testable per BUILD_AND_TEST.md §4.1.
 */

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  domainId: z.string().uuid().nullable(),
  actorId: z.string().uuid(),
  action: z.string(),
  subjectId: z.string().uuid().nullable(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  reason: z.string().nullable(),
  decisionId: z.string().uuid().nullable(),
  requestId: z.string(),
  occurredAt: z.string().datetime(),
  prevHash: z.string(),
  rowHash: z.string()
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEventListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
export type AuditEventListQuery = z.infer<typeof AuditEventListQuerySchema>;

export const AuditEventListResponseSchema = cursorPageResponseSchema(AuditEventSchema);
export type AuditEventListResponse = z.infer<typeof AuditEventListResponseSchema>;

/** Genesis `prev_hash` for the first event in an org's chain — 32 zero bytes, hex-encoded. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

/**
 * Deterministic canonical string for the *content* of an audit event (everything except
 * `row_hash` itself, which is derived from this). Field order is fixed so the same logical event
 * always canonicalizes identically.
 */
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

/** `row_hash = sha256(prev_hash || canonical(row))`, hex-encoded. */
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

/**
 * Re-walks a per-org audit chain (events must already be sorted oldest-first — chain order, i.e.
 * `occurred_at, id` ascending) and verifies every `row_hash`/`prev_hash` link, per DESIGN.md §4.3.
 * Pure function: no I/O, safe to unit-test and to run client-side against API-fetched pages
 * (`scp audit verify`).
 */
export function verifyAuditChain(events: AuditEvent[]): AuditChainVerification {
  let expectedPrevHash = AUDIT_GENESIS_HASH;
  for (const event of events) {
    if (event.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAt: { id: event.id, reason: `prev_hash mismatch: expected ${expectedPrevHash}, got ${event.prevHash}` }
      };
    }
    const recomputed = computeRowHash(event);
    if (recomputed !== event.rowHash) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAt: { id: event.id, reason: `row_hash mismatch: expected ${recomputed}, got ${event.rowHash}` }
      };
    }
    expectedPrevHash = event.rowHash;
  }
  return { valid: true, eventCount: events.length };
}
