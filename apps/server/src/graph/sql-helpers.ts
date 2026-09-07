import { sql, type SQL } from "drizzle-orm";

/** `column IN (…)`, deliberately not `= ANY` over an array. See docs/graph.md §192. */
export function sqlIn(columnExpr: string, values: readonly string[]): SQL {
  return sql`${sql.raw(columnExpr)} IN ${values}`;
}

/**
 * Same as {@link sqlIn}, but usable unconditionally inside a `WHERE ... AND (...)` chain: `null`
 * (no filter) becomes `true`, and an empty array (a filter that can never match) becomes `false`.
 */
export function sqlInOrAlways(columnExpr: string, values: readonly string[] | null): SQL {
  if (values === null) return sql`true`;
  if (values.length === 0) return sql`false`;
  return sqlIn(columnExpr, values);
}
