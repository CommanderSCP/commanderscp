import { sql, type SQL } from "drizzle-orm";

/**
 * `column IN (v1, v2, ...)`. Deliberately NOT `column = ANY(${values}::type[])`: drizzle-orm's
 * `sql` template tag special-cases JS array interpolations by expanding them into a
 * parenthesized, comma-separated parameter list (`(v1, v2, ...)`) rather than binding a single
 * array-typed parameter — so `${values}::text[]` receives a bare scalar (1 element) or an
 * anonymous record tuple (2+ elements) and fails to cast. `IN` embraces that expansion instead
 * of fighting it. Caller must ensure `values` is non-empty (`IN ()` is invalid SQL).
 */
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
