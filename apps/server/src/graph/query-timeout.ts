import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { unwrapDriverError } from "../db/pg-errors.js";

/** Defensive graph guardrail (adversarial review of PR #15). See docs/graph.md §159. */

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

/** Bounds every statement with `SET LOCAL statement_timeout`. See docs/graph.md §160. */
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
