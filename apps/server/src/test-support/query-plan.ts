import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/** The index names an `EXPLAIN` of `query` mentions. See docs/test-support.md §38. */
export async function indexesInPlan(
  tx: TenantTx,
  query: { getSQL: () => ReturnType<typeof sql> }
): Promise<string[]> {
  const text = await explainText(tx, query);
  return [...text.matchAll(/(?:Index (?:Only )?Scan|Bitmap Index Scan)[^\n]*?using (\w+)/g)].map(
    (m) => m[1]!
  );
}

/** The SORT NODES in the plan of `query`. See docs/test-support.md §39. */
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
