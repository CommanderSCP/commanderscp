import { sql } from "drizzle-orm";
import type { TenantTx } from "../../db/tenant-tx.js";

/**
 * THE MEASUREMENT INSTRUMENT the `decisions` read-bound suites share.
 *
 * Both bounds this PR ships (drizzle/0044 for the persist-on-change dedupe read, drizzle/0045 for
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
 * drizzle/0044 and drizzle/0045 plus the `LIMIT`, not a session setting. `SET LOCAL` dies with the
 * transaction.
 */
export async function preferIndexPlans(tx: TenantTx): Promise<void> {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
}

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
