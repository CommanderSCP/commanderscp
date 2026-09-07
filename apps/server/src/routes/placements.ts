import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreatePlacementRequestSchema,
  GraphObjectSchema,
  ObjectListResponseSchema,
  PlacementListQuerySchema,
  ProblemSchema,
  RegistryIdOrUrnParamSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { readableScopeForListDoor } from "../authz/list-door-scope.js";
import { idempotencyKeyOf, withIdempotency } from "../idempotency.js";
import { getObjectByIdOrUrn, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import { createPlacement, listPlacements, withdrawPlacement } from "../graph/placements-repo.js";

/** The placement routes, and the identity they enforce. See docs/routes.md §305. */
export function registerPlacementRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const base = "/api/v1/placements";

  typed.route({
    method: "POST",
    url: base,
    schema: {
      body: CreatePlacementRequestSchema,
      response: {
        201: GraphObjectSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createPlacement",
        summary:
          "Declare a placement — one component at one deployment target (the object and its derived edges are written atomically)",
        tags: ["placements"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // `object:write` at the target domain gates creating the placement object;
        // `createPlacement` additionally requires `relationship:write` over BOTH endpoints.
        // The declared parent, resolved ONCE and used for both the permission scope and the write
        // (`graph/containment-parent-authz.ts` — a wire `null` means the org root, never "detach").
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: undefined
        });
        const scopeObjectId = declaredParent ?? auth.orgId;
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKeyOf(request),
            route: `POST ${base}`,
            requestBody: request.body
          },
          async () => ({
            status: 201 as const,
            body: await createPlacement(tx, {
              orgId: auth.orgId,
              actorObjectId: auth.subjectObjectId,
              requestId: request.id,
              id: request.body.id,
              urn: request.body.urn,
              name: request.body.name,
              domainId: declaredParent,
              labels: request.body.labels,
              componentIdOrUrn: request.body.component,
              deploymentTargetIdOrUrn: request.body.deploymentTarget
            })
          })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: base,
    schema: {
      querystring: PlacementListQuerySchema,
      response: {
        200: ObjectListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listPlacements",
        summary: "List placements, optionally filtered by component or deployment target",
        tags: ["placements"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // THE GATE, AND THE ROW FILTER, IN ONE CALL. See docs/routes.md §306.
        const readableFilter = await readableScopeForListDoor(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectRef: request.query.scopeObjectId,
          resolveScopeObject: async (ref) =>
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, ref)).id
        });
        // Resolve the filter refs to ids so a caller may filter by URN as well as by id — the same
        // id-or-URN affordance every other route offers. An unknown ref 404s rather than silently
        // returning an empty page, which would read as "this component has no placements".
        const componentId = request.query.component
          ? (await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.query.component)).id
          : undefined;
        const deploymentTargetId = request.query.deploymentTarget
          ? (await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.query.deploymentTarget)).id
          : undefined;
        return listPlacements(tx, auth.orgId, {
          cursor: request.query.cursor,
          limit: request.query.limit,
          domainId: containmentDomainIdFromWire(request.query.domainId) ?? undefined,
          // ⚠️ `includeDeleted` and a narrowed scope do not compose: the descend walks LIVE rows
          // only (as the upward walk joins every ancestor live), so a tombstoned placement is
          // below nothing and never appears. Unchanged for an org-root caller who passes no hint —
          // their filter is `null`.
          includeDeleted: request.query.includeDeleted,
          componentId,
          deploymentTargetId,
          readableFilter
        });
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: `${base}/:idOrUrn`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getPlacement",
        summary: "Get a placement by id or URN",
        tags: ["placements"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "placement", request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: found.id
        });
        return found;
      });
      reply.status(200).send(object);
    }
  });

  typed.route({
    method: "DELETE",
    url: `${base}/:idOrUrn`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deletePlacement",
        summary: "Withdraw a placement (soft delete — frees the pair to be re-declared)",
        tags: ["placements"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "placement", request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: found.id
        });
        // `withdrawPlacement`, not the plain object delete: nothing cascades in this graph, so
        // `deleteObject` alone would leave both derived edges live out of a dead object.
        return withdrawPlacement(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn: request.params.idOrUrn
        });
      });
      reply.status(200).send(object);
    }
  });
}
