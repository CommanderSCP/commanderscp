import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  GraphIntegrityReportSchema,
  GraphQueryParamSchema,
  GraphQueryRequestSchema,
  GraphQueryResultSchema,
  ProblemSchema,
  SubgraphRequestSchema,
  SubgraphResultSchema,
  TraverseRequestSchema,
  TraverseResultSchema
} from "@scp/schemas";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { readableScopeForListDoor } from "../authz/list-door-scope.js";
import { runNamedQuery } from "../graph/named-queries.js";
import { subgraph, traverse } from "../graph/traverse.js";
import { findGraphIntegrityIssues } from "../graph/integrity-repo.js";
import { GraphQueryTimeoutError, withStatementTimeout } from "../graph/query-timeout.js";
import { badRequest, requestTimeout } from "../errors.js";

/** The caller's readable object-id set for graph READS. See docs/routes.md §245. */
async function readableObjectIdSet(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string
): Promise<ReadonlySet<string> | null> {
  const filter = await readableScopeForListDoor(tx, {
    orgId,
    subjectObjectId,
    permission: "object:read",
    scopeObjectRef: undefined,
    resolveScopeObject: () => {
      throw new Error("unreachable: graph read-scoping passes no scope hint");
    }
  });
  if (filter === null) return null;
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM ${filter} AS readable_set`);
  return new Set(rows.rows.map((r) => r.id));
}

/** Max connections for the ISOLATED graph-query pool. See docs/routes.md §246. */
export const GRAPH_QUERY_POOL_MAX = Math.max(1, Number(process.env.SCP_GRAPH_QUERY_POOL_MAX ?? 4));

/**
 * Named graph queries + generic traverse (DESIGN.md §5). Read-only: authorized at the queried
 * object's scope (`graph:query` permission) — the same containment walk RBAC uses.
 */
export function registerGraphRoutes(app: FastifyInstance, deps: AppDeps): void {
  // The isolated graph-query pool (see GRAPH_QUERY_POOL_MAX); falls back to the shared request pool
  // for hand-built deps (openapi:emit / test harness) that don't wire it, exactly like sseAuthzDb.
  const graphDb = deps.graphDb ?? deps.db;
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
        result = await withTenantTx(graphDb, auth.orgId, (tx) =>
          withStatementTimeout(tx, deps.config.graphQueryStatementTimeoutMs, async () => {
            await authorize(tx, {
              orgId: auth.orgId,
              subjectObjectId: auth.subjectObjectId,
              permission: "graph:query",
              scopeObjectId: request.query.objectId
            });
            const readableIds = await readableObjectIdSet(tx, auth.orgId, auth.subjectObjectId);
            return runNamedQuery(tx, auth.orgId, name, request.query, readableIds);
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
      response: {
        200: TraverseResultSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        408: ProblemSchema
      }
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
        result = await withTenantTx(graphDb, auth.orgId, (tx) =>
          withStatementTimeout(tx, deps.config.graphQueryStatementTimeoutMs, async () => {
            await authorize(tx, {
              orgId: auth.orgId,
              subjectObjectId: auth.subjectObjectId,
              permission: "graph:query",
              scopeObjectId: request.query.objectId
            });
            const readableIds = await readableObjectIdSet(tx, auth.orgId, auth.subjectObjectId);
            return traverse(tx, auth.orgId, request.query, readableIds);
          })
        );
      } catch (err) {
        if (err instanceof GraphQueryTimeoutError) throw requestTimeout(err.message);
        throw err;
      }
      reply.status(200).send(result);
    }
  });

  // Induced-subgraph edges over a caller-supplied object-id set. See docs/routes.md §247.
  typed.route({
    method: "POST",
    url: "/api/v1/graph/subgraph",
    schema: {
      body: SubgraphRequestSchema,
      response: {
        200: SubgraphResultSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        408: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "graphSubgraph",
        summary: "Induced-subgraph edges over an object-id set",
        tags: ["graph"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      let result;
      try {
        result = await withTenantTx(graphDb, auth.orgId, (tx) =>
          withStatementTimeout(tx, deps.config.graphQueryStatementTimeoutMs, async () => {
            await authorize(tx, {
              orgId: auth.orgId,
              subjectObjectId: auth.subjectObjectId,
              permission: "graph:query",
              scopeObjectId: request.body.objectId
            });
            const readableIds = await readableObjectIdSet(tx, auth.orgId, auth.subjectObjectId);
            return subgraph(tx, auth.orgId, request.body, readableIds);
          })
        );
      } catch (err) {
        if (err instanceof GraphQueryTimeoutError) throw requestTimeout(err.message);
        throw err;
      }
      reply.status(200).send(result);
    }
  });

  // Rows that outlived the object they hang off. See docs/routes.md §248.
  typed.route({
    method: "GET",
    url: "/api/v1/graph/integrity",
    schema: {
      response: {
        200: GraphIntegrityReportSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "graphIntegrity",
        summary: "Report rows that outlived the object they hang off",
        tags: ["graph"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const report = await withTenantTx(graphDb, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "graph:query",
          scopeObjectId: auth.orgId
        });
        return findGraphIntegrityIssues(tx, auth.orgId);
      });
      reply.status(200).send(report);
    }
  });
}
