import type {
  CreateServiceObjectRequest,
  ServiceObject,
  ServiceObjectListResponse
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, listObjects, resolveDomainId } from "../graph/objects-repo.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import { authorize } from "../authz/resolve.js";
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";
import { withIdempotency } from "../idempotency.js";
import type { GraphObject } from "@scp/schemas";

// Re-exported for backward compatibility — `objects-service.test.ts` (M0) imports these from
// here; the codec itself now lives in `../pagination.ts` since every M1 list endpoint needs it.
export { decodeCursor, encodeCursor } from "../pagination.js";

/**
 * ADR-0023: the M0 wire shape is the WHOLE graph object plus M0's `type` discriminator — see
 * `ServiceObjectSchema`'s doc comment for why a subset was a live contract violation (the SDK's
 * `client.object("service")` calls the generic `createObject`/`listObjects`, which this static
 * route shadows, and those declare a full `GraphObject`).
 */
function toServiceObject(row: GraphObject): ServiceObject {
  return { ...row, type: "service" };
}

/**
 * `POST/GET /api/v1/objects/service` (M0's contract, unchanged) — reimplemented on the M1 graph
 * substrate (BUILD_AND_TEST.md §8 M1 item 10: "upgrading their implementation to the new
 * substrate is expected"). A plain `service`-typed graph object under the hood, so anything
 * created here is equally visible through the generic `/objects/{type}` endpoint family.
 *
 * RBAC-enforced (object:write) and Idempotency-Key-aware exactly like the generic create —
 * Fastify's router prefers this literal static route over the parametric `/objects/:type` for
 * the exact path `/objects/service`, so this is the ONLY handler that ever runs for that path;
 * it must carry full parity (authorization, idempotency, domainId/properties/labels/custom
 * id-urn support), not a stripped subset, or those capabilities would silently be unavailable
 * for the 'service' type specifically.
 */
export async function createServiceObject(
  deps: AppDeps,
  orgId: string,
  actorObjectId: string,
  body: CreateServiceObjectRequest,
  requestId: string,
  idempotencyKey: string | undefined
): Promise<ServiceObject> {
  const created = await withTenantTx(deps.db, orgId, async (tx) => {
    // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
    const scopeObjectId = await resolveDomainId(
      tx,
      orgId,
      containmentDomainIdFromWire(body.domainId) ?? undefined
    );
    await authorize(tx, {
      orgId,
      subjectObjectId: actorObjectId,
      permission: "object:write",
      scopeObjectId: scopeObjectId ?? orgId
    });
    // ADR-0031 — doors 7 and 8. BOTH `POST /objects/service` and its `orgs/{org}` path-override
    // form funnel through this one function, so the check lands once for both.
    await assertMayDeclareDomainLocal(tx, {
      orgId,
      subjectObjectId: actorObjectId,
      scopeObjectId: scopeObjectId ?? orgId,
      requested: body.domainLocal
    });
    const result = await withIdempotency(
      tx,
      { orgId, idempotencyKey, route: "POST /objects/service", requestBody: body },
      async () => ({
        status: 201,
        body: await createObject(tx, {
          orgId,
          typeId: "service",
          actorObjectId,
          requestId,
          id: body.id,
          urn: body.urn,
          name: body.name,
          domainId: containmentDomainIdFromWire(body.domainId),
          properties: body.properties,
          labels: body.labels,
          domainLocal: body.domainLocal
        })
      })
    );
    return result.body;
  });
  return toServiceObject(created);
}

export async function listServiceObjects(
  deps: AppDeps,
  orgId: string,
  actorObjectId: string,
  query: { cursor?: string | undefined; limit: number }
): Promise<ServiceObjectListResponse> {
  const page = await withTenantTx(deps.db, orgId, async (tx) => {
    await authorize(tx, {
      orgId,
      subjectObjectId: actorObjectId,
      permission: "object:read",
      scopeObjectId: orgId
    });
    return listObjects(tx, orgId, "service", {
      ...query,
      domainId: undefined,
      includeDeleted: false
    });
  });
  return { items: page.items.map(toServiceObject), nextCursor: page.nextCursor };
}
