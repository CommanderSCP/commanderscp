import { createHash } from "node:crypto";
import type { TenantTx } from "./db/tenant-tx.js";
import { idempotencyKeys } from "./db/schema.js";
import { unprocessable } from "./errors.js";
import { isUniqueViolation } from "./db/pg-errors.js";

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

function hashRequest(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

/**
 * `Idempotency-Key` replay (DESIGN.md §6): "every POST accepts an `Idempotency-Key` header (the
 * server stores key→result for replay)". Runs inside the caller's tenant transaction so the
 * stored key and the mutation it guards commit or roll back atomically — the property fast-check
 * exercises (replayed POSTs must converge, never double-apply).
 *
 * A key reused for a *different* request body/route is rejected (422) rather than silently
 * returning the old result — reusing a key for a different logical request is a client bug.
 */
export async function withIdempotency<T>(
  tx: TenantTx,
  opts: { orgId: string; idempotencyKey: string | undefined; route: string; requestBody: unknown },
  fn: () => Promise<IdempotentResult<T>>
): Promise<IdempotentResult<T> & { replayed: boolean }> {
  if (!opts.idempotencyKey) {
    const result = await fn();
    return { ...result, replayed: false };
  }

  const requestHash = hashRequest(opts.requestBody);
  const existing = await tx.query.idempotencyKeys.findFirst({
    where: (t, { eq: eqOp, and: andOp }) =>
      andOp(eqOp(t.orgId, opts.orgId), eqOp(t.idempotencyKey, opts.idempotencyKey as string))
  });
  if (existing) {
    return replayOrReject(existing, opts.route, requestHash);
  }

  const result = await fn();
  try {
    await tx.insert(idempotencyKeys).values({
      orgId: opts.orgId,
      idempotencyKey: opts.idempotencyKey,
      route: opts.route,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body as object
    });
  } catch (err) {
    if (isUniqueViolation(err, "idempotency_keys_pk")) {
      // Lost a race with a concurrent request using the same key — return its result instead of
      // ours (both are computed from the same request, so this is safe under the property-test
      // convergence guarantee, but re-reading avoids diverging on any non-deterministic field).
      const race = await tx.query.idempotencyKeys.findFirst({
        where: (t, { eq: eqOp, and: andOp }) =>
          andOp(eqOp(t.orgId, opts.orgId), eqOp(t.idempotencyKey, opts.idempotencyKey as string))
      });
      if (race) return replayOrReject(race, opts.route, requestHash);
    }
    throw err;
  }

  return { ...result, replayed: false };
}

function replayOrReject<T>(
  existing: typeof idempotencyKeys.$inferSelect,
  route: string,
  requestHash: string
): IdempotentResult<T> & { replayed: boolean } {
  if (existing.route !== route || existing.requestHash !== requestHash) {
    throw unprocessable(
      `Idempotency-Key was already used for a different request (route/body mismatch)`
    );
  }
  return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
}
