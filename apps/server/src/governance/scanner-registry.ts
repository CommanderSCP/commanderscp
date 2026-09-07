import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { ScanMethodSchema, type ScanMethod } from "@scp/schemas";

/** M13.3a — SCANNER-ASSIGNMENT RESOLUTION. See docs/governance.md §414. */

interface AssignmentRow extends Record<string, unknown> {
  methods: unknown;
}

/** Coerce a stored `methods` jsonb value to a de-duplicated `ScanMethod[]`, dropping anything that
 *  is not a valid method. Total and non-throwing — a resolution path must never 500 on bad data. */
function parseMethods(raw: unknown): ScanMethod[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ScanMethod>();
  for (const entry of raw) {
    const parsed = ScanMethodSchema.safeParse(entry);
    if (parsed.success) seen.add(parsed.data);
  }
  return [...seen];
}

/** The managed scan methods assigned to `executorType`, or `[]`. See docs/governance.md §415. */
export async function resolveScannersForType(
  tx: TenantTx,
  executorType: string
): Promise<ScanMethod[]> {
  const result = await tx.execute<AssignmentRow>(sql`
    SELECT methods
    FROM scanner_assignments
    WHERE executor_type = ${executorType}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return [];
  return parseMethods(row.methods);
}
