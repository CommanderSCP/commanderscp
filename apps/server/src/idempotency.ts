import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { TenantTx } from "./db/tenant-tx.js";
import { idempotencyKeys } from "./db/schema.js";
import { unprocessable } from "./errors.js";
import { isUniqueViolation } from "./db/pg-errors.js";

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

/**
 * Reads the `Idempotency-Key` header, normalising a repeated header (which Fastify surfaces as an
 * array) to "absent" the way every route in the tree already does.
 *
 * EXPORTED HERE 2026-08-27 rather than hand-typed a SEVENTH time. `routes/role-bindings.ts` was
 * about to be the seventh; `objects-generic.ts`, `type-registry.ts`, `relationships.ts` and
 * `placements.ts` have since been converted to this shared helper too (dedup sweep). Four route
 * modules still carry a private `idempotencyKey(request)` with this body — `objects.ts`,
 * `typed-registries.ts`, `ownership.ts`, `components.ts` — named so the next census finds them
 * listed rather than having to rediscover them.
 */
export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

function hashRequest(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

/** `Idempotency-Key` replay (DESIGN.md §6). See docs/server.md §63. */
export async function withIdempotency<T>(
  tx: TenantTx,
  opts: {
    orgId: string;
    idempotencyKey: string | undefined;
    route: string;
    requestBody: unknown;
    /** OPT-IN ACTOR SCOPING. See docs/server.md §64. */
    actorObjectId?: string;
  },
  fn: () => Promise<IdempotentResult<T>>
): Promise<IdempotentResult<T> & { replayed: boolean }> {
  if (!opts.idempotencyKey) {
    const result = await fn();
    return { ...result, replayed: false };
  }

  const requestHash = hashRequest(
    opts.actorObjectId === undefined
      ? opts.requestBody
      : { actor: opts.actorObjectId, body: opts.requestBody }
  );
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
