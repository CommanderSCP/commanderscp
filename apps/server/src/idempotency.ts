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
  opts: {
    orgId: string;
    idempotencyKey: string | undefined;
    route: string;
    requestBody: unknown;
    /**
     * OPT-IN ACTOR SCOPING. `idempotency_keys` is keyed `(org_id, idempotency_key)` — ORG-scoped —
     * so a replay is answered to whoever presents the key next, whatever they hold. On most routes
     * that is merely surprising; on `POST /role-bindings` it is a read of an authority record by a
     * principal who holds nothing: guess (or observe) an administrator's key, POST any body, and the
     * stored 201 comes back with the binding id, subject, role and scope. Passing the acting
     * principal here folds it into the request hash, so a second actor presenting the same key gets
     * the 422 "already used for a different request" that a body mismatch gets — a refusal that
     * discloses nothing — instead of the first actor's result.
     *
     * A HASH RATHER THAN A COLUMN, deliberately: the primary key is `(org_id, idempotency_key)` in
     * `db/schema.ts`, so ACTUAL per-actor scoping is a migration (widening the PK) and would let two
     * actors hold the same key at once. This narrows the disclosure without one, and it fails in the
     * safe direction — a legitimate client retrying its own request has its own actor and replays
     * normally.
     *
     * OPT-IN, not applied to the six other `withIdempotency` callers: their stored results are graph
     * rows those callers already gate with their own `authorize` on the replay path's inputs, and
     * changing the hash basis for a route invalidates any key in flight across an upgrade. Named
     * here so the next census finds the choice rather than the omission.
     */
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
