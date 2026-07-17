import { asc, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Cursor-based pagination codec shared by every list endpoint (DESIGN.md §6: stable ordering by
 * `(created_at, id)`). Originally lived in `services/objects-service.ts` (M0); factored out here
 * once the generic graph endpoints, type registry, relationships, and audit log all needed the
 * identical codec.
 */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof (parsed as Record<string, unknown>).createdAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      const p = parsed as { createdAt: string; id: string };
      return { createdAt: new Date(p.createdAt), id: p.id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Millisecond-precision keyset pagination, shared so the WHERE comparison and the ORDER BY are
 * defined ONCE and can never drift apart (a mismatch between them is its own subtle bug).
 *
 * WHY MILLISECONDS: `created_at` is stored at Postgres MICROSECOND precision, but a pagination
 * cursor round-trips through a JS `Date` (MILLISECOND precision, via `encodeCursor` → `toISOString`).
 * Comparing the RAW column re-includes the boundary row — its sub-millisecond tail is strictly
 * greater than the truncated cursor — so a result set larger than one page whose rows share a
 * `created_at` millisecond (a bulk import committed in ONE transaction, every row stamped with the
 * same `now()`) never advances `nextCursor` and the SDK/CLI `listAll*` iterator loops forever.
 * Truncating the column to `date_trunc('milliseconds', created_at)` makes the sort key exactly
 * what the cursor can carry, so `(created_at_ms, id)` is a stable, terminating keyset.
 *
 * The `id` column is ALWAYS part of the key (both here and in `keysetOrderBy`): without it,
 * same-millisecond rows are not merely re-visited but silently DROPPED across a page boundary.
 *
 * @param createdAtCol the row's `created_at` timestamptz column
 * @param idCol the tiebreak uuid column (`id`, or e.g. `object_id` where that is the PK)
 * @param cursor the decoded cursor to page strictly after
 */
export function keysetAfter(createdAtCol: PgColumn, idCol: PgColumn, cursor: { createdAt: Date; id: string }): SQL {
  // Cast the cursor's id to the tiebreak column's OWN sql type (`uuid` for most rows, `text` for
  // the string-keyed type registry) so the row-comparison operands match. The type name comes from
  // the schema via `getSQLType()`, never from user input; the id value stays a bound parameter.
  const idType = sql.raw(idCol.getSQLType());
  return sql`(date_trunc('milliseconds', ${createdAtCol}), ${idCol}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::${idType})`;
}

/**
 * ORDER BY expressions matching `keysetAfter` — MUST truncate `created_at` identically, or the
 * ordering and the keyset comparison disagree and pagination misbehaves. Spread into `.orderBy(...)`.
 */
export function keysetOrderBy(createdAtCol: PgColumn, idCol: PgColumn): SQL[] {
  return [sql`date_trunc('milliseconds', ${createdAtCol})`, asc(idCol)];
}
