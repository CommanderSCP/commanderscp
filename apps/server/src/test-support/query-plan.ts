import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * The index names an `EXPLAIN` of `query` mentions.
 *
 * WHY ASSERT ON A PLAN AT ALL. An index that exists but is not USED changes no return value and no
 * row count that a small fixture can see, so nothing else in a test suite can tell the two apart —
 * and that is not a hypothetical failure mode here. It has happened three times:
 * `decisions_org_subject_block_created` and `decisions_org_subject_kind_created` were both built
 * one column short of the order their reads request and were quietly passed over by the planner
 * (drizzle/0069, and a CI failure reading `expected 804 to be less than or equal to 10`), and
 * `bundle_transfers_org_peer_confirmed` was built in an order NO caller asks for, leaving the read
 * it exists for seq-scanning a never-pruned ledger on every board render (drizzle/0070).
 *
 * A row count, where a suite can afford one, is the honest measurement and this does not replace
 * it: a plan can name the right index and still be slow. But when a count fails it reports a bare
 * number with no diagnosis — it does not say WHICH index served the read instead, so the
 * investigation restarts from nothing. This turns that into a named failure ("served by
 * `decisions_org_created`"), and it is stable against data volume in a way a count is not.
 *
 * TAKES THE BUILDER, NOT A RE-TYPED SQL STRING, so it explains the exact query production runs. A
 * hand-copied approximation is strictly worse than no test: it keeps passing while the real query
 * drifts off the index, which is the drift every one of the three instances above actually was.
 *
 * Lives in the shared `test-support` rather than beside any one suite because the property it
 * detects is not specific to a table — it belongs to every read whose cost is a property of its
 * plan. The first copy lived in `coordination/test-support/decision-read-counters.ts` and the
 * census that found the third instance is what moved it here.
 */
export async function indexesInPlan(
  tx: TenantTx,
  query: { getSQL: () => ReturnType<typeof sql> }
): Promise<string[]> {
  const text = await explainText(tx, query);
  return [...text.matchAll(/(?:Index (?:Only )?Scan|Bitmap Index Scan)[^\n]*?using (\w+)/g)].map(
    (m) => m[1]!
  );
}

/**
 * The SORT NODES in the plan of `query` — the half of the assertion {@link indexesInPlan} cannot
 * make, and without which it is VACUOUS for exactly the defect it was written to catch.
 *
 * NAMING THE INDEX IS NOT THE SAME AS BEING SERVED BY IT. An index whose declared order does not
 * match the query's is still perfectly usable for ACCESS — the planner reads the matching rows
 * through it and then sorts them — so it appears in the plan by name while supplying none of the
 * ordering the `LIMIT` needs. `indexesInPlan` alone reports that as a pass. VERIFIED, 2026-08-17,
 * on the `bundle_transfers` read drizzle/0070 fixes: reverting the index to drizzle/0041's order
 * left the plan as
 *
 *     Limit -> Sort (Sort Key: confirmed_at DESC NULLS LAST)
 *                -> Index Scan using bundle_transfers_org_peer_confirmed
 *
 * and the index-name assertion PASSED against a plan that sorts. The property these reads actually
 * need is that the index supplies the ORDER, so `LIMIT 1` can stop at the first row instead of the
 * whole matching set being materialised and sorted — i.e. NO SORT NODE. That is what this returns,
 * and asserting it is `[]` is what makes the pair honest.
 *
 * Matches `Sort` and `Incremental Sort` alike. `Incremental Sort` is the WEAKER, more misleading
 * form — it means the index supplied a PREFIX of the order — and it is what a prefix-keyed index
 * like the pre-0069 `decisions_org_subject_block_created` produces, so it must not be waved through.
 */
export async function sortNodesInPlan(
  tx: TenantTx,
  query: { getSQL: () => ReturnType<typeof sql> }
): Promise<string[]> {
  const text = await explainText(tx, query);
  return [...text.matchAll(/(?:^|->\s+)((?:Incremental )?Sort)\s+\(cost=/gm)].map((m) => m[1]!);
}

async function explainText(
  tx: TenantTx,
  query: { getSQL: () => ReturnType<typeof sql> }
): Promise<string> {
  const explained = await tx.execute(sql`EXPLAIN ${query.getSQL()}`);
  const rows = (explained as unknown as { rows: Array<Record<string, string>> }).rows;
  return rows.map((r) => Object.values(r)[0] ?? "").join("\n");
}
