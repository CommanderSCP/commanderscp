import { DrizzleQueryError } from "drizzle-orm";

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

/** drizzle wraps every driver error, so unwrap before matching. See docs/db.md §8. */
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
