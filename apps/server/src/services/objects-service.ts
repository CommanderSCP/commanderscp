import type { CreateServiceObjectRequest, ServiceObject, ServiceObjectListResponse } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, listObjects, resolveDomainId } from "../graph/objects-repo.js";
import { authorize } from "../authz/resolve.js";
import type { GraphObject } from "@scp/schemas";

// Re-exported for backward compatibility — `objects-service.test.ts` (M0) imports these from
// here; the codec itself now lives in `../pagination.ts` since every M1 list endpoint needs it.
export { decodeCursor, encodeCursor } from "../pagination.js";

function toServiceObject(row: GraphObject): ServiceObject {
  return {
    id: row.id,
    orgId: row.orgId,
    type: "service",
    name: row.name,
    createdAt: row.createdAt
  };
}

/**
 * `POST/GET /api/v1/objects/service` (M0's contract, unchanged) — reimplemented on the M1 graph
 * substrate (BUILD_AND_TEST.md §8 M1 item 10: "upgrading their implementation to the new
 * substrate is expected"). A plain `service`-typed graph object under the hood, so anything
 * created here is equally visible through the generic `/objects/{type}` endpoint family.
 *
 * RBAC-enforced (object:write) exactly like the generic create — Fastify's router prefers this
 * literal static route over the parametric `/objects/:type` for the exact path
 * `/objects/service`, so this is the ONLY handler that ever runs for that path; it must carry
 * full parity (authorization, domainId/properties/labels/custom id-urn support), not a stripped
 * subset, or those capabilities would silently be unavailable for the 'service' type specifically.
 */
export async function createServiceObject(
  deps: AppDeps,
  orgId: string,
  actorObjectId: string,
  body: CreateServiceObjectRequest,
  requestId: string
): Promise<ServiceObject> {
  const created = await withTenantTx(deps.db, orgId, async (tx) => {
    const scopeObjectId = await resolveDomainId(tx, orgId, body.domainId ?? undefined);
    await authorize(tx, {
      orgId,
      subjectObjectId: actorObjectId,
      permission: "object:write",
      scopeObjectId: scopeObjectId ?? orgId
    });
    return createObject(tx, {
      orgId,
      typeId: "service",
      actorObjectId,
      requestId,
      id: body.id,
      urn: body.urn,
      name: body.name,
      domainId: body.domainId,
      properties: body.properties,
      labels: body.labels
    });
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
    return listObjects(tx, orgId, "service", { ...query, domainId: undefined, includeDeleted: false });
  });
  return { items: page.items.map(toServiceObject), nextCursor: page.nextCursor };
}
