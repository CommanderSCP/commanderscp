import { and, asc, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
import { notFound } from "../errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";

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
  if (cursor) conditions.push(keysetAfter(decisions.createdAt, decisions.id, cursor));

  const rows = await tx
    .select()
    .from(decisions)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(decisions.createdAt, decisions.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toDecision),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

/**
 * The MOST RECENT decision of one `kind` about one subject, or `undefined`. A targeted single-row
 * read for callers on the reconcile hot path that must not pull a change's whole Decision history
 * every tick just to ask "did I already record this verdict?" (see `pre-deploy-gate.ts`'s
 * idempotence check). `kind` is the caller's own constant, never user input.
 *
 * "Most recent" matches {@link listDecisionsForSubject}'s ordering exactly (`createdAt`, then `id`
 * as the tiebreak for rows sharing a timestamp), so the answer here is the same row that read model
 * — and `coordination/boundary-segment.ts`'s "latest verdict wins" — would call latest.
 */
export async function latestDecisionForSubjectKind(
  tx: TenantTx,
  orgId: string,
  subjectId: string,
  kind: string
): Promise<Decision | undefined> {
  const rows = await tx
    .select()
    .from(decisions)
    .where(
      and(eq(decisions.orgId, orgId), eq(decisions.subjectId, subjectId), eq(decisions.kind, kind))
    )
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(1);
  return rows[0] ? toDecision(rows[0]) : undefined;
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
