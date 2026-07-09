/** Postgres error codes we branch on (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgErrorLike | null {
  if (err && typeof err === "object" && "code" in err) return err as PgErrorLike;
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
