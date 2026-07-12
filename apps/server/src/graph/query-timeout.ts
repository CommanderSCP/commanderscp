import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { unwrapDriverError } from "../db/pg-errors.js";

/**
 * Defensive graph guardrail (adversarial review of PR #15): the five reachability named queries
 * (graph/named-queries.ts's `transitiveReverseClosure`, backing `impact-of`/`dependents-of`/
 * `consumers-of`/`blast-radius`/`domains-impacted`) used to NOT node-dedupe between recursion
 * steps — only the final `SELECT DISTINCT` did — so intermediate row count grew roughly as
 * (effective fan-in)^depth on a shared-component topology. Measured (see the M8 PR body's
 * Load/perf section): a ~11-way fan-out at depth 10 ran 7+ minutes and then exhausted disk via
 * recursive-CTE temp-file spill; even a ~3-way fan-out over 10 hops tripped a 30s ad hoc timeout
 * during that same load test.
 *
 * M9.1 FIXED the CTE itself (node-level dedup between recursion steps — see
 * `transitiveReverseClosure`'s doc comment for the approach and the correctness argument for why
 * the returned node set is unchanged). `graph/traverse.ts`'s own generic walk is a separate
 * capability with the same shape of cost and was NOT touched by that fix — it still relies solely
 * on this timeout guardrail. This module's job stays exactly what it was: bound the RUNTIME so
 * ANY pathological topology (including ones this fix doesn't cover, or a future regression) fails
 * cleanly (a 408, not a hung worker/connection or a disk-exhaustion incident) instead of running
 * unbounded — belt-and-braces, not a substitute for the CTE fix. `apps/server/src/load-test/
 * graph-scale.ts` already uses the identical `set_config('statement_timeout', ...)` pattern as its
 * own safety net during load testing (see its module doc) — this is the same mechanism, wired
 * into the actual API routes with a much tighter, production-appropriate default.
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
  // drizzle-orm >=0.44 wraps every driver error in `DrizzleQueryError` — unwrap to the original
  // `pg` error first (db/pg-errors.ts's `unwrapDriverError` doc comment) or this never matches.
  const unwrapped = unwrapDriverError(err);
  return (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "code" in unwrapped &&
    (unwrapped as { code?: unknown }).code === PG_QUERY_CANCELED
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
