import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateObjectTypeRequestSchema,
  CreateRelationshipTypeRequestSchema,
  CursorPageQuerySchema,
  ObjectTypeListResponseSchema,
  ObjectTypeSchema,
  ProblemSchema,
  RelationshipTypeListResponseSchema,
  RelationshipTypeSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import {
  createObjectType,
  createRelationshipType,
  listObjectTypes,
  listRelationshipTypes
} from "../graph/type-registry-repo.js";
import { withIdempotency } from "../idempotency.js";

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

/**
 * Runtime type registry (DESIGN.md §4.1): org-scoped custom object/relationship types as data
 * inserts. Anything registered here is immediately usable through the generic `/objects/{type}`
 * and `/relationships` endpoints — no deploy, no migration (BUILD_AND_TEST.md §8 M1 DoD (b)).
 */
export function registerTypeRegistryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/type-registry/object-types",
    schema: {
      body: CreateObjectTypeRequestSchema,
      response: {
        201: ObjectTypeSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createObjectType",
        summary: "Register a custom object type",
        tags: ["type-registry"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "type_registry:write",
          scopeObjectId: auth.orgId
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
            route: "POST /type-registry/object-types",
            requestBody: request.body
          },
          async () => ({ status: 201, body: await createObjectType(tx, auth.orgId, request.body) })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/type-registry/object-types",
    schema: {
      querystring: CursorPageQuerySchema,
      response: { 200: ObjectTypeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listObjectTypes",
        summary: "List object types (built-in + org-defined)",
        tags: ["type-registry"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "type_registry:read",
          scopeObjectId: auth.orgId
        });
        return listObjectTypes(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/type-registry/relationship-types",
    schema: {
      body: CreateRelationshipTypeRequestSchema,
      response: {
        201: RelationshipTypeSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createRelationshipType",
        summary: "Register a custom relationship type",
        tags: ["type-registry"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "type_registry:write",
          scopeObjectId: auth.orgId
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
            route: "POST /type-registry/relationship-types",
            requestBody: request.body
          },
          async () => ({
            status: 201,
            body: await createRelationshipType(tx, auth.orgId, request.body)
          })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/type-registry/relationship-types",
    schema: {
      querystring: CursorPageQuerySchema,
      response: { 200: RelationshipTypeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listRelationshipTypes",
        summary: "List relationship types (built-in + org-defined)",
        tags: ["type-registry"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "type_registry:read",
          scopeObjectId: auth.orgId
        });
        return listRelationshipTypes(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });
}
