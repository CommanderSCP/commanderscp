import { and, asc, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
import { notFound } from "../errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { canonicalJson } from "../util/canonical-json.js";

/** Decision records (DESIGN.md §10.4). See docs/coordination.md §416. */
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
  /** Exact-match `kind` filter (ADR-0028 increment 4). Independent of `subjectId`: the shape this
   *  was added for is kind-WITHOUT-subject, and drizzle/0056's `decisions_org_kind_created` is the
   *  index that keeps it an index probe rather than the parallel seq scan it measured as. */
  kind?: string | undefined;
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
  if (query.kind) conditions.push(eq(decisions.kind, query.kind));
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

/** The dedupe probe as a builder, so a test can explain it. See docs/coordination.md §417. */
export function latestDecisionForSubjectKindQuery(
  tx: TenantTx,
  orgId: string,
  subjectId: string,
  kind: string
) {
  return (
    tx
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.orgId, orgId),
          eq(decisions.subjectId, subjectId),
          eq(decisions.kind, kind)
        )
      )
      // The `id` tiebreak is not decoration and it is not only about the answer: drizzle/0044's index
      // must carry it too, or the index supplies only a PREFIX of this order, every plan using it
      // needs a sort node, and the planner prefers `decisions_org_kind_created` — which supplies the
      // whole order sortlessly and then filters `subject_id` off the heap across the ORG. drizzle/0069.
      .orderBy(desc(decisions.createdAt), desc(decisions.id))
      .limit(1)
  );
}

/** The most recent decision of one kind about one subject. See docs/coordination.md §418. */
export async function latestDecisionForSubjectKind(
  tx: TenantTx,
  orgId: string,
  subjectId: string,
  kind: string
): Promise<Decision | undefined> {
  const rows = await latestDecisionForSubjectKindQuery(tx, orgId, subjectId, kind);
  return rows[0] ? toDecision(rows[0]) : undefined;
}

/** The most recent `block` decision about one subject. See docs/coordination.md §419. */
/** The block probe as a builder, for the same reason. See docs/coordination.md §420. */
export function latestBlockDecisionQuery(tx: TenantTx, orgId: string, subjectId: string) {
  return tx
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, orgId),
        eq(decisions.subjectId, subjectId),
        // Must stay a compile-time constant matching the index. See docs/coordination.md §421.
        eq(decisions.verdict, "block")
      )
    )
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(1);
}

export async function latestBlockDecisionForSubject(
  tx: TenantTx,
  orgId: string,
  subjectId: string
): Promise<Decision | undefined> {
  const rows = await latestBlockDecisionQuery(tx, orgId, subjectId);
  return rows[0] ? toDecision(rows[0]) : undefined;
}

/** Canonical, key-order-independent JSON for comparison. See docs/coordination.md §422. */
function canonicalJsonForComparison(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value ?? null)) as unknown);
}

/** True when this verdict restates the previous one. See docs/coordination.md §423. */
export function restatesDecision(previous: Decision, candidate: InsertDecisionInput): boolean {
  return (
    previous.verdict === candidate.verdict &&
    canonicalJsonForComparison(previous.inputContext) ===
      canonicalJsonForComparison(candidate.inputContext) &&
    canonicalJsonForComparison(previous.reasonTree) ===
      canonicalJsonForComparison(candidate.reasonTree)
  );
}

/** The outcome of a {@link insertDecisionIfChanged} call — always a resolvable Decision. */
export interface RecordedDecision {
  /** The Decision now standing on the record: the freshly inserted row, or the existing row this
   *  verdict merely restated. NEVER null — every caller still has a `decision_id` to hand out
   *  (charter principle 6: a blocked response always carries one). */
  decision: Decision;
  /** False when this verdict was already the LATEST one on the record and nothing was written. */
  created: boolean;
}

/** Persist-on-change: record only when the verdict differs. See docs/coordination.md §424. */
export async function insertDecisionIfChanged(
  tx: TenantTx,
  input: InsertDecisionInput
): Promise<RecordedDecision> {
  const previous = await latestDecisionForSubjectKind(tx, input.orgId, input.subjectId, input.kind);
  if (previous && restatesDecision(previous, input)) return { decision: previous, created: false };
  return { decision: await insertDecision(tx, input), created: true };
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
