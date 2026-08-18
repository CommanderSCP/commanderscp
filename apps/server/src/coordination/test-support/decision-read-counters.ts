import { sql } from "drizzle-orm";
import pg from "pg";
import type { TenantTx } from "../../db/tenant-tx.js";

/**
 * THE MEASUREMENT INSTRUMENT the `decisions` read-bound suites share.
 *
 * Both bounds this PR ships (drizzle/0044 for the persist-on-change dedupe read, drizzle/0046 for
 * the service board's block probe) are INDEX properties: the query returns the same answer with or
 * without them, so no assertion on a return value can tell them apart. What changes is HOW MANY
 * ROWS Postgres touches to produce that answer, so that is what these suites measure — from
 * Postgres's own per-transaction counters, which are transaction-local and therefore see the read
 * under test and nothing else (no stats-collector flush delay, no interference from a parallel test
 * file: each Vitest worker owns its own cloned database).
 *
 * Lives in `test-support` because a duplicated instrument is an instrument that drifts: if one copy
 * silently stopped counting index entries the suite using it would go vacuously green while still
 * looking like a bound.
 */

/**
 * MAKE A SMALL TABLE CHOOSE THE PLAN A LARGE ONE WOULD. On a few-hundred-row table a sequential
 * scan is genuinely the cheapest plan for either the bounded or the unbounded read, so both would
 * report "all rows touched" and the counter could not tell a `LIMIT 1` index probe from a full
 * history walk. Disabling seq scans FOR THIS TRANSACTION ONLY makes the plan shape match production,
 * where the index is chosen because the table is large — which is the regime the bound exists for.
 *
 * This is a TEST INSTRUMENT, never a production knob: no `SET`/hint of any kind exists in
 * `service-board.ts` or `decisions-repo.ts`, and the reason the production reads are fast is
 * drizzle/0044 and drizzle/0046 plus the `LIMIT`, not a session setting. `SET LOCAL` dies with the
 * transaction.
 */
export async function preferIndexPlans(tx: TenantTx): Promise<void> {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
}

/**
 * PUT `decisions` INTO THE STATISTICS STATE EVERY LIVE INSTANCE IS PERMANENTLY IN, before the
 * measurement — and fail loudly if it did not happen.
 *
 * WHY THESE SUITES MUST ANALYZE AT ALL, stated as the diagnosis rather than as variance-reduction.
 * A suite that seeds a few hundred rows and measures within ~1.7 s normally measures a table with
 * NO COLUMN STATISTICS: `pg_statistic` is empty, autovacuum's analyze has not run yet, and every
 * equality falls back to `DEFAULT_EQ_SEL` (0.005). In that regime the planner estimates ~1 matching
 * row, prices the sortless rival index at its FULL length, and picks the partial/kind index — so
 * the bound holds for a reason that has nothing to do with the index being right. Once real
 * statistics land, the estimate jumps (~200 matching rows on this fixture), the rival is repriced
 * at 1/200th of its length, and the plan flips to an ORG-WIDE walk. MEASURED, same data, same
 * `enable_seqscan = off`, PostgreSQL 16 — the board's never-blocked probe:
 *
 *     no statistics   Incremental Sort -> Index Scan using decisions_org_subject_block_created
 *                     11 buffers, 0 rows touched
 *     after ANALYZE   Index Scan Backward using decisions_org_created
 *                     Filter: subject_id AND verdict   Rows Removed by Filter: 802
 *                     819 buffers  <-- `expected 804 to be less than or equal to 10`
 *
 * That is the whole "flake": CI hit the second regime on the two occasions autoanalyze happened to
 * fire inside the seed-to-measure window, and hit the first one on every re-run. Analyzing HERE,
 * unconditionally, deletes the race in the honest direction — the suites now always measure the
 * regime production is always in, so the bound fails EVERY run when the index cannot serve the read
 * rather than one run in dozens. drizzle/0069 is the fix that makes it hold there.
 *
 * WHY NOT ON THE TENANT TRANSACTION, which is where this used to run. `withTenantTx` issues
 * `SET LOCAL ROLE scp_app`, and `scp_app` does not own `decisions`. PostgreSQL does not raise for
 * that: it emits `WARNING: permission denied to analyze "decisions", skipping it` and returns
 * success. So the previous implementation was a NO-OP that looked like a fix — VERIFIED against a
 * real postgres:16, `pg_statistic` still empty and `last_analyze` still NULL afterwards. It is the
 * reason the hypothesis it was written for could never be confirmed OR refuted by running the
 * suite. `MAINTAIN` (PostgreSQL 17) would let a grant fix this without a second connection; on 16
 * the owner connection is the only route, so this opens one on `TEST_DATABASE_URL` (the superuser
 * URL, already repointed at this worker's cloned database by test-support/db-clone.ts).
 *
 * Call it BEFORE opening the measuring transaction, not inside it: the ANALYZE must be COMMITTED
 * for the read's plan to see it, and its own scan must not be charged to the counters.
 */
export async function refreshDecisionStats(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL is unset — refreshDecisionStats needs the OWNER connection (integration tests must run via vitest.integration.config.ts)."
    );
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("ANALYZE decisions");
    // THE NO-OP GUARD. `ANALYZE` returns success whether or not it analyzed anything, so the only
    // honest confirmation is the thing the planner actually reads. Without this assertion a future
    // change of connection or role silently restores the vacuous version of this helper, and both
    // read-bound suites go back to measuring a regime no instance is ever in — green, and blind.
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_statistic WHERE starelid = 'decisions'::regclass"
    );
    if (Number(rows[0]?.n ?? 0) === 0) {
      throw new Error(
        "ANALYZE decisions left pg_statistic empty — the connection is not the table owner, so the ANALYZE was skipped with a WARNING and this helper measured nothing."
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * The plan assertion these suites pair with the row count MOVED to `test-support/query-plan.ts`.
 * It was never specific to `decisions`: the census behind drizzle/0069 and drizzle/0070 found the
 * same "index built in an order the read never asks for" defect on `bundle_transfers` too, and a
 * second copy of the instrument would have been a second copy to drift. Re-exported here so the
 * two `decisions` suites keep one import for the whole toolkit.
 */
export { indexesInPlan, sortNodesInPlan } from "../../test-support/query-plan.js";

/**
 * Index entries returned + sequential-scan rows read for `decisions` IN THIS TRANSACTION.
 *
 * `pg_stat_get_xact_tuples_returned` over every index on `decisions` charges the entries the
 * executor pulled out of an index scan; the same function on the TABLE charges rows read by a
 * sequential scan. Summing both means the number cannot be gamed by a plan change — a read that
 * escapes its index into a seq scan is counted, not hidden.
 */
export async function decisionRowsTouched(tx: TenantTx): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT
      COALESCE(
        (SELECT sum(pg_stat_get_xact_tuples_returned(indexrelid))
           FROM pg_index WHERE indrelid = 'decisions'::regclass), 0)
      + pg_stat_get_xact_tuples_returned('decisions'::regclass) AS touched
  `);
  const first = (rows as unknown as { rows: Array<{ touched: string | number }> }).rows[0];
  return Number(first?.touched ?? 0);
}
