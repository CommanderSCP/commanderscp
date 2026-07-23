import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { ScanMethodSchema, type ScanMethod } from "@scp/schemas";

/**
 * M13.3a — SCANNER-ASSIGNMENT RESOLUTION (ADR-0020 §2, proposal §13.3).
 *
 * The commander's promotion scan step (Build B — not here) resolves, for an artifact's executor
 * Type, WHICH managed scan method(s) to run. This module is that resolution, and ONLY that: given a
 * Type, return the assigned `ScanMethod[]`. It reads the instance-scoped `scanner_assignments` table
 * through the ORDINARY tenant transaction under the table's tenant-read RLS policy — no privileged
 * connection is needed to RESOLVE an assignment, mirroring `readInstanceScanFloors`
 * (scan-requirements.ts) exactly (the assignments are instance-global config, no `org_id`, so there
 * is no org context to thread).
 *
 * EMPTY / UNKNOWN TYPE -> `[]`, WITH A CLEAR MEANING. A Type with no row, an all-`[]` row, or a Type
 * outside the closed `ExecutorType` set all resolve to `[]`. `[]` means "no managed scanner for this
 * Type" — the promotion scan step produces NO managed evidence, so E6 refuses that Type's
 * cross-boundary promotion unless valid org-pipeline evidence already covers the digest. This is
 * FAIL-CLOSED by design (proposal §13.3), never a silent pass: an unassigned Type cannot promote on
 * managed evidence, because there is none.
 *
 * The stored `methods` jsonb is validated on the way OUT (not trusted blindly): any element that is
 * not a valid `ScanMethod` is dropped, so a hand-edited or version-skewed row can never hand the
 * scan step a method it cannot run. A malformed row degrades to fewer methods (or none) — never to a
 * throw and never to an invented method.
 */

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

/**
 * The managed scan methods assigned to `executorType`, or `[]` (no managed scanner — see the module
 * doc). `executorType` is typed `string` (not `ExecutorType`) on purpose: the caller resolves it
 * from an artifact/binding at runtime, and an unknown value must resolve cleanly to `[]` rather than
 * being a type error — the fail-closed meaning is identical whether the Type is unknown or merely
 * unassigned.
 */
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
