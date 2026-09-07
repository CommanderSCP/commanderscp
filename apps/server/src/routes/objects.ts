import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateServiceObjectRequestSchema,
  CursorPageQuerySchema,
  OrgParamSchema,
  ProblemSchema,
  ServiceObjectListResponseSchema,
  ServiceObjectSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { assertOrgMatch, requireAuth } from "../auth/require-auth.js";
import { createServiceObject, listServiceObjects } from "../services/objects-service.js";

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

/** The service routes, plus the org path-override form. See docs/routes.md §277. */
export function registerObjectRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/objects/service",
    schema: {
      body: CreateServiceObjectRequestSchema,
      response: {
        201: ServiceObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema,
        422: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createServiceObject",
        summary: "Register a service object",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const created = await createServiceObject(
        deps,
        auth.orgId,
        auth.subjectObjectId,
        request.body,
        request.id,
        idempotencyKey(request)
      );
      reply.status(201).send(created);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/objects/service",
    schema: {
      querystring: CursorPageQuerySchema,
      response: { 200: ServiceObjectListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listServiceObjects",
        summary: "List service objects",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await listServiceObjects(deps, auth.orgId, auth.subjectObjectId, request.query);
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/orgs/:org/objects/service",
    schema: {
      params: OrgParamSchema,
      body: CreateServiceObjectRequestSchema,
      response: {
        201: ServiceObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema,
        422: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createServiceObjectForOrg",
        summary: "Register a service object (explicit org path override)",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      assertOrgMatch(auth, request.params.org);
      const created = await createServiceObject(
        deps,
        auth.orgId,
        auth.subjectObjectId,
        request.body,
        request.id,
        idempotencyKey(request)
      );
      reply.status(201).send(created);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/orgs/:org/objects/service",
    schema: {
      params: OrgParamSchema,
      querystring: CursorPageQuerySchema,
      response: { 200: ServiceObjectListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listServiceObjectsForOrg",
        summary: "List service objects (explicit org path override)",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      assertOrgMatch(auth, request.params.org);
      const page = await listServiceObjects(deps, auth.orgId, auth.subjectObjectId, request.query);
      reply.status(200).send(page);
    }
  });
}
