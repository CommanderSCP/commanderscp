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
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { runNamedQuery } from "../graph/named-queries.js";
import { subgraph, traverse } from "../graph/traverse.js";
import { findGraphIntegrityIssues } from "../graph/integrity-repo.js";
import { GraphQueryTimeoutError, withStatementTimeout } from "../graph/query-timeout.js";
import { badRequest, requestTimeout } from "../errors.js";

/**
 * Max connections for the ISOLATED graph-query pool (main.ts wires `deps.graphDb` to a pool sized by
 * this). The traverse/named-query/subgraph/integrity handlers run RECURSIVE CTEs (depth ≤ 10, edge
 * fan-out) whose cost is driven by GRAPH SHAPE and the caller's parameters, not by request volume —
 * an authenticated caller can fire several expensive traversals and, on the shared request pool (pg
 * default max 10, `connectionTimeoutMillis: 5000`), turn every OTHER tenant's ordinary request into
 * a checkout TIMEOUT. Same isolation rationale as the SSE pools (main.ts). A small cap means a
 * starved graph pool degrades only graph reads, never request serving or coordination. Imported by
 * main.ts so the number and this paragraph cannot drift apart. */
export const GRAPH_QUERY_POOL_MAX = Math.max(
  1,
  Number(process.env.SCP_GRAPH_QUERY_POOL_MAX ?? 4)
);

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

  // Induced-subgraph edges over a caller-supplied object-id set. POST (not GET) because the id
  // list can be large (up to 2000 uuids) — too long for a querystring. Read-only despite the verb;
  // authorized identically to the named queries (`graph:query` scoped to `objectId`, the root the
  // caller is exploring). Lets the UI render the REAL edges among a named query's result set
  // instead of a synthesized hub-and-spoke star (routes/graph-explorer.tsx).
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
            return subgraph(tx, auth.orgId, request.body);
          })
        );
      } catch (err) {
        if (err instanceof GraphQueryTimeoutError) throw requestTimeout(err.message);
        throw err;
      }
      reply.status(200).send(result);
    }
  });

  // Rows that outlived the object they hang off (`graph/integrity-repo.ts` has the full rationale).
  //
  // READ-ONLY, and there is deliberately NO companion repair endpoint. Repair is performed by the
  // ordinary DELETE doors, each of which already writes its audit event and journal entry in the
  // same transaction as the delete. A bulk-repair endpoint would be a SECOND way to destroy rows,
  // and the cheap version of it would skip both — which is precisely the failure principle 6 exists
  // to prevent, and which raw SQL cleanup of this same backlog would also have caused.
  //
  // Authorized as `graph:query` scoped to the ORG, not to an object: the report spans the whole
  // tenant, so there is no single root to scope it to. `graph:query` rather than `audit:read`
  // because this is graph structure — the same class of data the named queries already return —
  // and a caller who may traverse the graph may see which of its rows are stranded.
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
