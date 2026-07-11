import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  GraphQueryParamSchema,
  GraphQueryRequestSchema,
  GraphQueryResultSchema,
  ProblemSchema,
  TraverseRequestSchema,
  TraverseResultSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { runNamedQuery } from "../graph/named-queries.js";
import { traverse } from "../graph/traverse.js";
import { GraphQueryTimeoutError, withStatementTimeout } from "../graph/query-timeout.js";
import { badRequest, requestTimeout } from "../errors.js";

/**
 * Named graph queries + generic traverse (DESIGN.md §5). Read-only: authorized at the queried
 * object's scope (`graph:query` permission) — the same containment walk RBAC uses.
 */
export function registerGraphRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/graph/query/:name",
    schema: {
      params: GraphQueryParamSchema,
      querystring: GraphQueryRequestSchema,
      response: {
        200: GraphQueryResultSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        408: ProblemSchema
      }
    },
    config: {
      openapi: { operationId: "graphQuery", summary: "Run a named graph query", tags: ["graph"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { name } = request.params;
      if (name === "paths-between" && !request.query.targetId) {
        throw badRequest("paths-between requires ?targetId=");
      }
      let result;
      try {
        result = await withTenantTx(deps.db, auth.orgId, (tx) =>
          withStatementTimeout(tx, deps.config.graphQueryStatementTimeoutMs, async () => {
            await authorize(tx, {
              orgId: auth.orgId,
              subjectObjectId: auth.subjectObjectId,
              permission: "graph:query",
              scopeObjectId: request.query.objectId
            });
            return runNamedQuery(tx, auth.orgId, name, request.query);
          })
        );
      } catch (err) {
        if (err instanceof GraphQueryTimeoutError) throw requestTimeout(err.message);
        throw err;
      }
      reply.status(200).send(result);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/graph/traverse",
    schema: {
      querystring: TraverseRequestSchema,
      response: { 200: TraverseResultSchema, 401: ProblemSchema, 403: ProblemSchema, 408: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "graphTraverse",
        summary: "Bounded generic graph traversal",
        tags: ["graph"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      let result;
      try {
        result = await withTenantTx(deps.db, auth.orgId, (tx) =>
          withStatementTimeout(tx, deps.config.graphQueryStatementTimeoutMs, async () => {
            await authorize(tx, {
              orgId: auth.orgId,
              subjectObjectId: auth.subjectObjectId,
              permission: "graph:query",
              scopeObjectId: request.query.objectId
            });
            return traverse(tx, auth.orgId, request.query);
          })
        );
      } catch (err) {
        if (err instanceof GraphQueryTimeoutError) throw requestTimeout(err.message);
        throw err;
      }
      reply.status(200).send(result);
    }
  });
}
