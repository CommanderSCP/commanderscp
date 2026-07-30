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

/**
 * The MOST RECENT `block` decision about one subject, or `undefined` — the same single-row shape as
 * {@link latestDecisionForSubjectKind}, keyed on the verdict the service board actually consumes.
 *
 * WHY THIS EXISTS (the board read that was pathological on the live instance). `service-board.ts`
 * needs exactly one thing out of a change's Decision history: the latest `block`, whose id it hands
 * the operator as `attention.decisionId` (charter principle 6). It used to get that by calling
 * {@link listDecisionsForSubject} — EVERY Decision ever recorded about the change, no `kind` filter,
 * no `LIMIT` — and then `[...decisions].reverse().find(d => d.verdict === "block")` in JS. On the
 * homelab instance each of the 29 live changes carried ~425,000 rows, so ONE `GET
 * /services/{id}/board` pulled hundreds of thousands of rows, sorted them, and materialized them as
 * JS objects PER BOARD ROW. That read is pre-existing (it predates the persist-on-change fix and is
 * not caused by it), but it is the same table and the same incident, and the fix does not bound it.
 *
 * WHY KEYED ON THE VERDICT AND NOT ON A LIST OF KINDS. "The latest block" is what the board
 * consumes; it does not consume any particular `kind`. Ten distinct kinds can currently record a
 * `block` against a change subject — `gate`, `wave_target`, `transition`,
 * `pre-deploy-artifact-verify`, the three `retrans-relay-*` kinds, `promotion-export-scan-gate`,
 * `promotion-import-manifest-verify` and `policy_evaluate_dry_run` — and enumerating them here would
 * put a census in the read path that a future eleventh writer silently falsifies: the board would
 * quietly stop reporting `blocked` for the one kind nobody remembered to add, with no test to
 * notice. Filtering on the thing the board actually means keeps the answer BYTE-IDENTICAL to the old
 * JS scan (same ordering, same tiebreak, same row) and leaves nothing to keep in sync.
 *
 * WHY IT TAKES NO `verdict` PARAMETER. `block` is baked in so that this query's shape and
 * drizzle/0045's PARTIAL index (`… WHERE verdict = 'block'`) cannot drift apart. A generic
 * verdict argument would let a future caller ask for `warn` and silently get the unindexed plan —
 * the very trap 0044 exists to close, re-opened one call site over.
 *
 * WHAT IS BOUNDED, AND BY WHAT. Rows RETURNED is exactly one, always — that is the memory and
 * serialization blow-up this removes. Rows EXAMINED is O(1) too, but ONLY because of drizzle/0045:
 * without it `verdict` is a heap filter on the backward walk of `decisions_org_subject`, and a
 * change that NEVER blocked — the common case on a healthy board — pays a walk over its ENTIRE
 * history to return nothing (measured on the 12M-row reproduction: 45.8 ms / 20,526 buffers fully
 * cached for a 200k-row history, 25,162 ms / 417,398 buffers cold for a 414k-row one, i.e. WORSE
 * than the unbounded read it replaced). With the partial index the descent finds no entry for that
 * (org, subject) and returns immediately: 0.070 ms / 13 buffers, no `Filter` line.
 */
export async function latestBlockDecisionForSubject(
  tx: TenantTx,
  orgId: string,
  subjectId: string
): Promise<Decision | undefined> {
  const rows = await tx
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, orgId),
        eq(decisions.subjectId, subjectId),
        // Must stay a LITERAL matching drizzle/0045's index predicate verbatim — a bound parameter
        // here would still use the partial index (the planner proves the implication from the
        // constant at plan time), but a non-`block` value would not, and nothing would say so.
        eq(decisions.verdict, "block")
      )
    )
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(1);
  return rows[0] ? toDecision(rows[0]) : undefined;
}

/**
 * Canonical, key-order-independent JSON for the CONTENT comparison {@link restatesDecision} makes.
 *
 * Both halves of that comparison must normalize identically or suppression silently never fires:
 * the stored side comes back out of `jsonb` (Postgres does NOT preserve the author's key order —
 * it stores an object's keys in its own internal order), while the candidate side is a freshly
 * built JS object literal whose key order follows the source code. A plain `JSON.stringify` of the
 * two therefore differs for byte-identical content. Round-tripping through JSON first also erases
 * the remaining representational differences between "about to be inserted" and "read back":
 * `undefined`-valued keys (dropped on insert, so absent on read) and `Date` values (serialized to
 * an ISO string on insert, read back as that string).
 *
 * Array ORDER is preserved deliberately — it is meaningful in every Decision context this compares
 * (a failing-artifact list, a freeze-override list), and `jsonb` preserves it too, so a reordered
 * array is a genuinely different input set and MUST write a new row.
 */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value ?? null))));
}

/**
 * True when `candidate` says EXACTLY what `previous` already says — same verdict over the same
 * inputs with the same reasoning. Content-keyed, never identity-keyed: "we already wrote a
 * Decision for this subject" is NOT a reason to suppress (a gate that newly passes, a different
 * policy firing, or a changed input set all differ here and all write a new row).
 *
 * Exported for direct unit testing: this predicate is the entire safety property of
 * {@link insertDecisionIfChanged}, and its most plausible failure mode (a normalization slip that
 * makes every comparison unequal) would restore the unbounded write with no visible symptom.
 */
export function restatesDecision(previous: Decision, candidate: InsertDecisionInput): boolean {
  return (
    previous.verdict === candidate.verdict &&
    canonicalJson(previous.inputContext) === canonicalJson(candidate.inputContext) &&
    canonicalJson(previous.reasonTree) === canonicalJson(candidate.reasonTree)
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

/**
 * PERSIST-ON-CHANGE: record this verdict only if it differs from the latest Decision of the same
 * `kind` about the same subject. The write-side guard for every Decision writer that re-evaluates
 * on a TIMER rather than on an event.
 *
 * WHY (measured, live homelab, 2026-07-29/30): `decisions` had reached 12,327,844 rows / 15 GB,
 * growing ~1.08M rows (~1.44 GB) per day. 99.99% of it was ONE writer — `coordination/reconcile.ts`'s
 * wave gate — restating an unchanged `block` verdict once per 2 s tick for each of 25 changes parked
 * on a `requireApprovals` policy awaiting a human. In one sampled hour, 39,175 `gate`/`block` rows
 * collapsed to 25 distinct `(subject_id, input_context, reason_tree)` tuples: 99.94% of them were
 * byte-identical restatements, ~1,567x duplication. Nothing was learnable from row 2 onward.
 *
 * WHAT THIS DOES NOT DO: it does not slow, skip, or cache EVALUATION. Callers still evaluate on
 * every tick — that is how a newly-arrived approval, a lifted freeze, or a control that has since
 * passed is noticed at all — and the moment the verdict or its inputs differ, a new row lands. Only
 * the redundant WRITE is suppressed. (`governance/gate-orchestrator.ts`'s `prewarmGovernanceForChange`
 * already states this same rule for its own per-tick work: "a change sitting in `validating` for
 * hours would otherwise pollute the Decision log with one redundant 'still blocked' entry per ~1s
 * tick".)
 *
 * AUDITABILITY IS PRESERVED (charter principle 6): the FIRST statement of a verdict always
 * persists, `scp change explain` still reconstructs the whole chain from it, and a suppressed
 * restatement returns the EXISTING row so the caller's `decision_id` is stable and never null.
 * A caller that pairs the Decision with a hash-chained audit event must suppress that event on the
 * same condition (`created === false`) — appending an audit event for a tick where nothing changed
 * would make the chain assert an occurrence that did not occur.
 *
 * "LATEST, not any" (the subtlety `pre-deploy-gate.ts` documents and `boundary-segment.ts`'s
 * latest-verdict-wins read depends on): comparing against the most recent Decision only. An older
 * matching row can therefore never shadow a differing later one — block, then allow, then block
 * again writes three rows, in that order, because each differs from the one before it.
 */
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
