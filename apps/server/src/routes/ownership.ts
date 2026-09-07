import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AddOwnerRequestSchema,
  AddRelationshipTargetRequestSchema,
  CursorPageQuerySchema,
  ProblemSchema,
  RegistryIdOrUrnParamSchema,
  RegistryOwnerParamSchema,
  RegistryTargetParamSchema,
  RelationshipListResponseSchema,
  RelationshipSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { withIdempotency } from "../idempotency.js";
import { notFound } from "../errors.js";
import { getObjectByIdOrUrn, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  createRelationship,
  deleteRelationship,
  listRelationships
} from "../graph/relationships-repo.js";

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

/** Looks up the (at most one, per the `relationships_org_type_from_to_key` unique constraint) live edge. */
async function findLiveRelationship(
  tx: TenantTx,
  orgId: string,
  params: { fromId: string; toId: string; typeId: string }
) {
  const page = await listRelationships(tx, orgId, { ...params, limit: 1 });
  const found = page.items[0];
  if (!found) {
    throw notFound(
      `no live '${params.typeId}' relationship from '${params.fromId}' to '${params.toId}'`
    );
  }
  return found;
}

interface OwnerSubResourceConfig {
  basePath: string;
  typeId: string;
  resourceName: string;
}

/** The typed resources valid as an ownership endpoint. See docs/routes.md §294. */
const OWNS_TO_RESOURCES: OwnerSubResourceConfig[] = [
  { basePath: "domains", typeId: "domain", resourceName: "Domain" },
  { basePath: "services", typeId: "service", resourceName: "Service" },
  // Migration 0055 added `assembly` to `owns.to_types` — an assembly is exactly the thing a team
  // owns, and ownership was one of the reasons for having the level at all. Registered here so the
  // `/owners` sub-resource exists; without it the type is ownable on the wire but has no door.
  { basePath: "assemblies", typeId: "assembly", resourceName: "Assembly" },
  { basePath: "components", typeId: "component", resourceName: "Component" },
  { basePath: "deployment-targets", typeId: "deployment-target", resourceName: "DeploymentTarget" }
];

/** The two resources valid on both sides of those edges. See docs/routes.md §295. */
const EDGE_RESOURCES: Pick<OwnerSubResourceConfig, "basePath" | "typeId" | "resourceName">[] = [
  { basePath: "services", typeId: "service", resourceName: "Service" },
  { basePath: "components", typeId: "component", resourceName: "Component" }
];

/** The ergonomic owners wrapper over the generic edges. See docs/routes.md §296. */
function registerOwnerSubResource(
  app: FastifyInstance,
  deps: AppDeps,
  config: OwnerSubResourceConfig
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { basePath, typeId, resourceName } = config;
  const base = `/api/v1/${basePath}`;
  const label = basePath.replace(/-/g, " ");

  typed.route({
    method: "POST",
    url: `${base}/:idOrUrn/owners`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      body: AddOwnerRequestSchema,
      response: {
        201: RelationshipSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `add${resourceName}Owner`,
        summary: `Add an owner to a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        const owner = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.ownerIdOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: owner.id
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: target.id
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
            route: `POST ${base}/${target.id}/owners`,
            requestBody: request.body
          },
          async () => ({
            status: 201,
            body: await createRelationship(tx, {
              orgId: auth.orgId,
              actorObjectId: auth.subjectObjectId,
              requestId: request.id,
              typeId: "owns",
              fromId: owner.id,
              toId: target.id
            })
          })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: `${base}/:idOrUrn/owners`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: CursorPageQuerySchema,
      response: {
        200: RelationshipListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `list${resourceName}Owners`,
        summary: `List direct owners of a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:read",
          scopeObjectId: target.id
        });
        // Direct edges only (toId = this object) — NOT the `owners-of` named query, which also
        // walks containment ancestry and returns a broader, transitive set (module doc; that
        // query remains separately available at GET /graph/query/owners-of).
        return listRelationships(tx, auth.orgId, {
          toId: target.id,
          typeId: "owns",
          limit: request.query.limit,
          cursor: request.query.cursor
        });
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "DELETE",
    url: `${base}/:idOrUrn/owners/:ownerIdOrUrn`,
    schema: {
      params: RegistryOwnerParamSchema,
      response: {
        200: RelationshipSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `remove${resourceName}Owner`,
        summary: `Remove an owner from a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn, ownerIdOrUrn } = request.params;
      const relationship = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        const owner = await getObjectByIdOrUrnAnyType(tx, auth.orgId, ownerIdOrUrn);
        const found = await findLiveRelationship(tx, auth.orgId, {
          fromId: owner.id,
          toId: target.id,
          typeId: "owns"
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: owner.id
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: target.id
        });
        await deleteRelationship(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: found.id
        });
        return { ...found, deletedAt: new Date().toISOString() };
      });
      reply.status(200).send(relationship);
    }
  });
}

interface RelationshipEdgeSubResourceConfig {
  basePath: string;
  typeId: string;
  resourceName: string;
  relTypeId: "consumes" | "depends_on";
  urlSegment: "consumes" | "depends-on";
  verbName: "Consumes" | "DependsOn";
}

/** The ergonomic consumes and depends-on wrapper. See docs/routes.md §297. */
function registerRelationshipEdgeSubResource(
  app: FastifyInstance,
  deps: AppDeps,
  config: RelationshipEdgeSubResourceConfig
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { basePath, typeId, resourceName, relTypeId, urlSegment, verbName } = config;
  const base = `/api/v1/${basePath}`;
  const label = basePath.replace(/-/g, " ");

  typed.route({
    method: "POST",
    url: `${base}/:idOrUrn/${urlSegment}`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      body: AddRelationshipTargetRequestSchema,
      response: {
        201: RelationshipSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `add${resourceName}${verbName}`,
        summary: `Add a '${relTypeId}' edge from a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const source = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.targetIdOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: source.id
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: target.id
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
            route: `POST ${base}/${source.id}/${urlSegment}`,
            requestBody: request.body
          },
          async () => ({
            status: 201,
            body: await createRelationship(tx, {
              orgId: auth.orgId,
              actorObjectId: auth.subjectObjectId,
              requestId: request.id,
              typeId: relTypeId,
              fromId: source.id,
              toId: target.id
            })
          })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: `${base}/:idOrUrn/${urlSegment}`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: CursorPageQuerySchema,
      response: {
        200: RelationshipListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `list${resourceName}${verbName}`,
        summary: `List direct outgoing '${relTypeId}' edges from a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const source = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:read",
          scopeObjectId: source.id
        });
        return listRelationships(tx, auth.orgId, {
          fromId: source.id,
          typeId: relTypeId,
          limit: request.query.limit,
          cursor: request.query.cursor
        });
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "DELETE",
    url: `${base}/:idOrUrn/${urlSegment}/:targetIdOrUrn`,
    schema: {
      params: RegistryTargetParamSchema,
      response: {
        200: RelationshipSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `remove${resourceName}${verbName}`,
        summary: `Remove a '${relTypeId}' edge from a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn, targetIdOrUrn } = request.params;
      const relationship = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const source = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, targetIdOrUrn);
        const found = await findLiveRelationship(tx, auth.orgId, {
          fromId: source.id,
          toId: target.id,
          typeId: relTypeId
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: source.id
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: target.id
        });
        await deleteRelationship(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: found.id
        });
        return { ...found, deletedAt: new Date().toISOString() };
      });
      reply.status(200).send(relationship);
    }
  });
}

/** The ownership ergonomics, layered over the generic verbs. See docs/routes.md §298. */
export function registerOwnershipRoutes(app: FastifyInstance, deps: AppDeps): void {
  for (const resource of OWNS_TO_RESOURCES) {
    registerOwnerSubResource(app, deps, resource);
  }
  for (const resource of EDGE_RESOURCES) {
    registerRelationshipEdgeSubResource(app, deps, {
      ...resource,
      relTypeId: "consumes",
      urlSegment: "consumes",
      verbName: "Consumes"
    });
    registerRelationshipEdgeSubResource(app, deps, {
      ...resource,
      relTypeId: "depends_on",
      urlSegment: "depends-on",
      verbName: "DependsOn"
    });
  }
}
