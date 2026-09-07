import { sql } from "drizzle-orm";
import pg from "pg";
import type { TenantTx } from "../../db/tenant-tx.js";

/** The measurement instrument the read-bound suites share. See docs/coordination.md §993. */

/** MAKE A SMALL TABLE CHOOSE THE PLAN A LARGE ONE WOULD. See docs/coordination.md §994. */
export async function preferIndexPlans(tx: TenantTx): Promise<void> {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
}

/** Puts the table into the state a live instance is in. See docs/coordination.md §995. */
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

/** The paired plan assertion now lives elsewhere. See docs/coordination.md §996. */
export { indexesInPlan, sortNodesInPlan } from "../../test-support/query-plan.js";

/** Index entries and rows read in this transaction. See docs/coordination.md §997. */
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
