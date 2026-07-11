import { DrizzleQueryError } from "drizzle-orm";

/** Postgres error codes we branch on (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

/**
 * drizzle-orm >=0.44 (bumped to 0.45.2 to clear GHSA-gpj5-g38j-94v9) wraps every error a driver
 * throws in its own `DrizzleQueryError`, with the original `pg` driver error preserved on
 * `.cause` (standard ES2022 error-cause chaining — see drizzle-orm's `errors.ts`). Every caller in
 * this codebase that branches on a raw Postgres error code (e.g. `graph/query-timeout.ts`'s
 * `57014` statement-timeout check, or this module's own `23505`/`23503` checks below) needs to see
 * THROUGH that wrapper to the original `pg` error, so this is exported for reuse rather than
 * duplicated. Walks `.cause` repeatedly (not just one level) so this keeps working even if
 * something else ever wraps a `DrizzleQueryError` again.
 */
export function unwrapDriverError(err: unknown): unknown {
  let current: unknown = err;
  while (current instanceof DrizzleQueryError && current.cause !== undefined) {
    current = current.cause;
  }
  return current;
}

function asPgError(err: unknown): PgErrorLike | null {
  const unwrapped = unwrapDriverError(err);
  if (unwrapped && typeof unwrapped === "object" && "code" in unwrapped) {
    return unwrapped as PgErrorLike;
  }
  return null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgErr = asPgError(err);
  if (!pgErr || pgErr.code !== PG_UNIQUE_VIOLATION) return false;
  return constraint ? pgErr.constraint === constraint : true;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return asPgError(err)?.code === PG_FOREIGN_KEY_VIOLATION;
}
