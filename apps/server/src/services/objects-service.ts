import type { ServiceObject, ServiceObjectListResponse } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, listObjects } from "../graph/objects-repo.js";
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
 * created here is equally visible through the generic `/objects/service` endpoint family.
 */
export async function createServiceObject(
  deps: AppDeps,
  orgId: string,
  actorObjectId: string,
  name: string
): Promise<ServiceObject> {
  const created = await withTenantTx(deps.db, orgId, (tx) =>
    createObject(tx, { orgId, typeId: "service", actorObjectId, name, requestId: "m0-service-route" })
  );
  return toServiceObject(created);
}

export async function listServiceObjects(
  deps: AppDeps,
  orgId: string,
  query: { cursor?: string | undefined; limit: number }
): Promise<ServiceObjectListResponse> {
  const page = await withTenantTx(deps.db, orgId, (tx) =>
    listObjects(tx, orgId, "service", { ...query, domainId: undefined, includeDeleted: false })
  );
  return { items: page.items.map(toServiceObject), nextCursor: page.nextCursor };
}
