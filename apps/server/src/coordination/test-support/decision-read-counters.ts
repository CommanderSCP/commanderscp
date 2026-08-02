import { sql } from "drizzle-orm";
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
 * Refresh `decisions`' planner statistics.
 *
 * A suite that seeds tens of thousands of rows and measures IMMEDIATELY is racing autovacuum's
 * analyze, which is asynchronous — so the planner may be costing the read from stale or default
 * estimates, and which index it picks can differ run to run on identical data. That is the one
 * mechanism that plausibly explains `service-board-decision-read-bound` failing once in CI
 * (`expected 804 to be less than or equal to 10`) and passing on a plain re-run of the SAME commit.
 *
 * NOT A PROVEN CAUSE, and worth being honest about: an attempt to reproduce the flip locally
 * failed. The partial index was chosen with a SQL literal and with a bound parameter, before and
 * after an explicit ANALYZE, and `latestBlockDecisionForSubject` touched 0 rows every time. This
 * call removes a real source of run-to-run variance; it is not a fix for a diagnosed bug, and the
 * plan assertion is what actually pins the intent.
 */
export async function refreshDecisionStats(tx: TenantTx): Promise<void> {
  await tx.execute(sql`ANALYZE decisions`);
}

/**
 * The index names an `EXPLAIN` of `query` mentions.
 *
 * WHY ASSERT ON THE PLAN AT ALL, when the suite already counts rows. The row count is the honest
 * measurement — it cannot be gamed, and it is what the bound actually means. But when it fails it
 * says only "804", which is a number with no diagnosis attached: it does not say WHICH index was
 * used instead, so the next person starts the investigation from scratch (as happened here). The
 * plan assertion converts that into a named failure — "served by `decisions_org_subject` instead of
 * `decisions_org_subject_block_created`" — and it is stable against data volume in a way a row
 * count is not.
 *
 * It does NOT replace the row count. A plan can name the right index and still be slow, and the
 * count is what would catch that.
 *
 * Takes the BUILDER, not a re-typed SQL string, so this explains the exact query production runs —
 * see `latestBlockDecisionQuery`'s doc comment for why a copy would be worse than no test.
 */
export async function indexesInPlan(
  tx: TenantTx,
  query: { getSQL: () => ReturnType<typeof sql> }
): Promise<string[]> {
  const explained = await tx.execute(sql`EXPLAIN ${query.getSQL()}`);
  const rows = (explained as unknown as { rows: Array<Record<string, string>> }).rows;
  const text = rows.map((r) => Object.values(r)[0] ?? "").join("\n");
  return [...text.matchAll(/(?:Index (?:Only )?Scan|Bitmap Index Scan)[^\n]*?using (\w+)/g)].map(
    (m) => m[1]!
  );
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
