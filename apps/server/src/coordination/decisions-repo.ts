import { and, asc, eq, gt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
import { notFound } from "../errors.js";
import { decodeCursor, encodeCursor } from "../pagination.js";

/**
 * Decision records (DESIGN.md §10.4) — the explainability funnel every engine verdict writes
 * through. Deliberately dumb: this repo never decides anything, it only persists what
 * `coordination/transition.ts`/`gates.ts`/`watchdog.ts`/rollback-trigger code hand it.
 */
export interface InsertDecisionInput {
  orgId: string;
  kind: string;
  subjectId: string;
  verdict: string;
  inputContext: Record<string, unknown>;
  reasonTree: Record<string, unknown>;
}

function toDecision(row: typeof decisions.$inferSelect): Decision {
  return {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    subjectId: row.subjectId,
    verdict: row.verdict,
    inputContext: row.inputContext as Record<string, unknown>,
    reasonTree: row.reasonTree as Record<string, unknown>,
    createdAt: row.createdAt.toISOString()
  };
}

export async function insertDecision(tx: TenantTx, input: InsertDecisionInput): Promise<Decision> {
  const [row] = await tx
    .insert(decisions)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      kind: input.kind,
      subjectId: input.subjectId,
      verdict: input.verdict,
      inputContext: input.inputContext,
      reasonTree: input.reasonTree
    })
    .returning();
  if (!row) throw new Error("failed to insert decision");
  return toDecision(row);
}

export async function getDecision(tx: TenantTx, orgId: string, id: string): Promise<Decision> {
  const rows = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.orgId, orgId), eq(decisions.id, id)))
    .limit(1);
  if (rows.length === 0 || !rows[0]) throw notFound(`decision '${id}' not found`);
  return toDecision(rows[0]);
}

export interface ListDecisionsQuery {
  cursor?: string | undefined;
  limit: number;
  subjectId?: string | undefined;
}

/** Ordered oldest-first (chain-of-reasoning order) — `scp change explain` renders in this order. */
export async function listDecisions(
  tx: TenantTx,
  orgId: string,
  query: ListDecisionsQuery
): Promise<{ items: Decision[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(decisions.orgId, orgId)];
  if (query.subjectId) conditions.push(eq(decisions.subjectId, query.subjectId));
  if (cursor) conditions.push(gt(decisions.createdAt, cursor.createdAt));

  const rows = await tx
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(asc(decisions.createdAt), asc(decisions.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toDecision),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

/** All decisions ever made about one subject (a change, most commonly), oldest first. */
export async function listDecisionsForSubject(
  tx: TenantTx,
  orgId: string,
  subjectId: string
): Promise<Decision[]> {
  const rows = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.orgId, orgId), eq(decisions.subjectId, subjectId)))
    .orderBy(asc(decisions.createdAt), asc(decisions.id));
  return rows.map(toDecision);
}
