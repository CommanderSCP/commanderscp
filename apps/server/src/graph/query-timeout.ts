import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * Defensive graph guardrail (adversarial review of PR #15): the `impact-of` recursive CTE
 * (graph/named-queries.ts's `transitiveReverseClosure`, and graph/traverse.ts's own walk) does
 * NOT node-dedupe between recursion steps — only the final `SELECT DISTINCT` does — so
 * intermediate row count grows roughly as (effective fan-in)^depth on a shared-component
 * topology. Measured (see the M8 PR body's Load/perf section): a ~11-way fan-out at depth 10 ran
 * 7+ minutes and then exhausted disk via recursive-CTE temp-file spill; even a ~3-way fan-out
 * over 10 hops tripped a 30s ad hoc timeout during that same load test.
 *
 * FIXING the CTE (making it node-dedupe between steps) is a separate, PENDING OWNER DECISION —
 * deliberately not done here (it changes the query's semantics: which of possibly-several
 * shortest paths through a shared component gets reported first). This module does only the
 * narrower, uncontroversial thing: bound the RUNTIME so a pathological topology fails cleanly
 * (an 408, not a hung worker/connection or a disk-exhaustion incident) instead of running
 * unbounded. `apps/server/src/load-test/graph-scale.ts` already uses the identical
 * `set_config('statement_timeout', ...)` pattern as its own safety net during load testing (see
 * its module doc) — this is the same mechanism, wired into the actual API routes with a much
 * tighter, production-appropriate default.
 */

/** Thrown when the wrapped query is cancelled by the statement_timeout this module set — never a
 *  generic/opaque failure, so callers (routes/graph.ts) can map it to a clean 408 instead of a
 *  raw 500. */
export class GraphQueryTimeoutError extends Error {}

/** Postgres error code for a statement cancelled by `statement_timeout` (also used for other
 *  `pg_cancel_backend`-style cancellations, but this module never issues those, so seeing this
 *  code here always means the timeout fired). */
const PG_QUERY_CANCELED = "57014";

function isStatementTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_QUERY_CANCELED
  );
}

/**
 * Runs `fn` with Postgres's own `statement_timeout` bounding every statement `fn` issues on `tx`,
 * `SET LOCAL` so the bound never leaks past this transaction onto a pooled connection reused by
 * an unrelated request. `SET` itself doesn't accept a bind parameter (unlike a regular `SELECT`),
 * so this uses `set_config(...)`, same pattern db/tenant-tx.ts uses for `app.current_org_id`.
 *
 * A statement cancelled by that timeout (Postgres error 57014) is translated to
 * `GraphQueryTimeoutError` — never a raw driver error reaching the caller unrecognized.
 */
export async function withStatementTimeout<T>(
  tx: TenantTx,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
  try {
    return await fn();
  } catch (err) {
    if (isStatementTimeoutError(err)) {
      throw new GraphQueryTimeoutError(
        `graph query exceeded the ${timeoutMs}ms bound (statement_timeout) — narrow maxDepth/relTypes or the object's fan-out and retry`
      );
    }
    throw err;
  }
}
