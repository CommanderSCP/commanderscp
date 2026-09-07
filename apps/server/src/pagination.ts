import { asc, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** Cursor-based pagination codec shared by every list endpoint. See docs/server.md §84. */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })
  ).toString("base64url");
}

/**
 * The shape a keyset id must have BEFORE it reaches `::uuid` in SQL. A cursor is client input; a
 * syntactically valid but semantically garbage one (`{id:"nope"}`) reaches Postgres and comes back
 * as 22P02 → 500. NOT applied inside `decodeCursor` itself: the shared codec's `id` is the
 * tiebreak column, which is a uuid for most lists but a TEXT id for the type registries
 * (`bulk-type-00` — see list-pagination-sweep.integration.test.ts), so the check belongs to the
 * caller whose SQL casts `::uuid` — today the dependency inventory's `(lineId, manifestPath)`
 * cursor and the bumps read's descending twin.
 */
export const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` for anything that is not a well-formed cursor. See docs/server.md §85. */
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
      const createdAt = new Date(p.createdAt);
      if (Number.isNaN(createdAt.getTime())) return null;
      return { createdAt, id: p.id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Millisecond keyset pagination, shared so both agree. See docs/server.md §86.
 * @param createdAtCol the row's `created_at` timestamptz column
 * @param idCol the tiebreak uuid column (`id`, or e.g. `object_id` where that is the PK)
 * @param cursor the decoded cursor to page strictly after
 */
export function keysetAfter(
  createdAtCol: PgColumn,
  idCol: PgColumn,
  cursor: { createdAt: Date; id: string }
): SQL {
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
