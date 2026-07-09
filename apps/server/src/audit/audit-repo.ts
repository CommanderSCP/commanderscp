import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { AUDIT_GENESIS_HASH, computeRowHash, type AuditEvent } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { auditEvents } from "../db/schema.js";

export interface AppendAuditEventInput {
  orgId: string;
  domainId?: string | null;
  actorId: string;
  action: string;
  subjectId?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  reason?: string | null;
  decisionId?: string | null;
  requestId: string;
}

/**
 * Appends one link to the org's hash chain, in the caller's transaction — DESIGN.md §4.3:
 * "written in the same transaction as the audited action". `pg_advisory_xact_lock` serializes
 * chain appends per org (held until COMMIT/ROLLBACK), so concurrent writers can never observe a
 * stale tail and fork the chain, and `seq` (see schema.ts) makes "the tail" unambiguous even
 * when two events share a millisecond timestamp.
 */
export async function appendAuditEvent(tx: TenantTx, input: AppendAuditEventInput): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.orgId}))`);

  const tail = await tx
    .select({ rowHash: auditEvents.rowHash })
    .from(auditEvents)
    .where(eq(auditEvents.orgId, input.orgId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const prevHash = tail[0]?.rowHash ?? AUDIT_GENESIS_HASH;

  const id = uuidv7();
  const occurredAt = new Date();
  const domainId = input.domainId ?? null;
  const subjectId = input.subjectId ?? null;
  const beforeHash = input.beforeHash ?? null;
  const afterHash = input.afterHash ?? null;
  const reason = input.reason ?? null;
  const decisionId = input.decisionId ?? null;

  const eventForHash: Omit<AuditEvent, "rowHash"> = {
    id,
    orgId: input.orgId,
    domainId,
    actorId: input.actorId,
    action: input.action,
    subjectId,
    beforeHash,
    afterHash,
    reason,
    decisionId,
    requestId: input.requestId,
    occurredAt: occurredAt.toISOString(),
    prevHash
  };
  const rowHash = computeRowHash(eventForHash);

  await tx.insert(auditEvents).values({
    id,
    orgId: input.orgId,
    domainId,
    actorId: input.actorId,
    action: input.action,
    subjectId,
    beforeHash,
    afterHash,
    reason,
    decisionId,
    requestId: input.requestId,
    occurredAt,
    prevHash,
    rowHash
  });
}

function toAuditEvent(row: typeof auditEvents.$inferSelect): AuditEvent {
  return {
    id: row.id,
    orgId: row.orgId,
    domainId: row.domainId,
    actorId: row.actorId,
    action: row.action,
    subjectId: row.subjectId,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
    reason: row.reason,
    decisionId: row.decisionId,
    requestId: row.requestId,
    occurredAt: row.occurredAt.toISOString(),
    prevHash: row.prevHash,
    rowHash: row.rowHash
  };
}

/**
 * Cursor pagination in chain order (`seq`) — the order `scp audit verify` needs to re-walk the
 * chain (DESIGN.md §4.3). The cursor opaquely encodes `seq` (not `created_at`/`id` like every
 * other list endpoint) since that's the one column guaranteed to be a total, gapless order here.
 */
export async function listAuditEvents(
  tx: TenantTx,
  orgId: string,
  query: { cursor?: string | undefined; limit: number }
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  const afterSeq = query.cursor ? decodeSeqCursor(query.cursor) : null;

  const conditions = [eq(auditEvents.orgId, orgId)];
  if (afterSeq !== null) conditions.push(gt(auditEvents.seq, afterSeq));

  const rows = await tx
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(asc(auditEvents.seq))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeSeqCursor(last.seq) : null;

  return { items: page.map(toAuditEvent), nextCursor };
}

function encodeSeqCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq })).toString("base64url");
}

function decodeSeqCursor(cursor: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { seq?: unknown }).seq === "number") {
      return (parsed as { seq: number }).seq;
    }
    return null;
  } catch {
    return null;
  }
}
