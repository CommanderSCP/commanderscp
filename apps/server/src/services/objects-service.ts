import type {
  CreateServiceObjectRequest,
  ServiceObject,
  ServiceObjectListResponse
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject, listObjects } from "../graph/objects-repo.js";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import { authorize, type PermissionCheck } from "../authz/resolve.js";
import { authorizeListAndScope } from "../authz/list-scope.js";
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";
import { withIdempotency } from "../idempotency.js";
import type { GraphObject } from "@scp/schemas";

// Re-exported for backward compatibility — `objects-service.test.ts` (M0) imports these from
// here; the codec itself now lives in `../pagination.ts` since every M1 list endpoint needs it.
export { decodeCursor, encodeCursor } from "../pagination.js";

/** The wire shape is the whole graph object plus its type. See docs/services.md §1. */
function toServiceObject(row: GraphObject): ServiceObject {
  return { ...row, type: "service" };
}

/** `POST/GET /api/v1/objects/service` (M0's contract, unchanged). See docs/services.md §2. */
export async function createServiceObject(
  deps: AppDeps,
  orgId: string,
  actorObjectId: string,
  body: CreateServiceObjectRequest,
  requestId: string,
  idempotencyKey: string | undefined
): Promise<ServiceObject> {
  const created = await withTenantTx(deps.db, orgId, async (tx) => {
    // The declared parent, resolved once for both scope and write. See docs/services.md §3.
    const scopeObjectId = await resolveDeclaredContainmentParent(tx, {
      orgId,
      subjectObjectId: actorObjectId,
      permission: "object:write",
      // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
      declared: containmentDomainIdFromWire(body.domainId),
      current: undefined
    });
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
          domainId: scopeObjectId,
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
    // THE DOOR A `routes/*.ts` CENSUS CANNOT SEE (role-model.md §8.1). See docs/services.md §4.
    const check: PermissionCheck = {
      orgId,
      subjectObjectId: actorObjectId,
      permission: "object:read",
      scopeObjectId: orgId
    };
    const readable = await authorizeListAndScope(tx, check);
    return listObjects(
      tx,
      orgId,
      "service",
      {
        ...query,
        domainId: undefined,
        includeDeleted: false
      },
      readable
    );
  });
  return { items: page.items.map(toServiceObject), nextCursor: page.nextCursor };
}
