import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  HealthBatchRequestSchema,
  HealthBatchResultSchema,
  HealthRecordSchema,
  ObjectIdOrUrnParamSchema,
  ProblemSchema,
  PushHealthRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrn } from "../graph/objects-repo.js";
import {
  getObjectHealth,
  getObjectHealthBatch,
  upsertObjectHealth
} from "../graph/object-health-repo.js";

/**
 * Object-health push + read (observe-enrichment signal 4; ADR-0008 decision 4).
 *
 * INVARIANT (coordinate-not-execute, charter principle 1): SCP never probes/polls/computes health.
 * The ONLY write path is the owner PUSH (`PUT …/health`); there is no active health-checking verb
 * anywhere. The stored value is an object-referencing PROJECTION row (DESIGN §4.1), not a new
 * top-level concept table (charter principle 2 — graph-native). The read paths surface the latest
 * pushed value; objects with no push are absent (rendered grey/unknown, never fabricated).
 */
export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // PUSH-IN: idempotent upsert of the latest-health record for an object. Owner writes
  // `source:'owner'`; a future opt-in health-source binding writes the SAME row via `source`.
  typed.route({
    method: "PUT",
    url: "/api/v1/objects/:type/:idOrUrn/health",
    schema: {
      params: ObjectIdOrUrnParamSchema,
      body: PushHealthRequestSchema,
      response: {
        200: HealthRecordSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "pushObjectHealth",
        summary: "Push the latest health of a graph object (idempotent upsert)",
        tags: ["health"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, idOrUrn } = request.params;
      const record = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: found.id
        });
        return upsertObjectHealth(tx, {
          orgId: auth.orgId,
          objectId: found.id,
          status: request.body.status,
          detail: request.body.detail,
          observedAt: request.body.observedAt,
          source: request.body.source
        });
      });
      reply.status(200).send(record);
    }
  });

  // READ (single): surface the latest health on the object read. 200 with the record, or 200 with
  // an `unknown`/null record when nothing has ever been pushed (never fabricated as healthy).
  typed.route({
    method: "GET",
    url: "/api/v1/objects/:type/:idOrUrn/health",
    schema: {
      params: ObjectIdOrUrnParamSchema,
      response: {
        200: HealthRecordSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getObjectHealth",
        summary: "Get the latest pushed health of a graph object",
        tags: ["health"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, idOrUrn } = request.params;
      const record = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: found.id
        });
        const health = await getObjectHealth(tx, auth.orgId, found.id);
        return (
          health ?? {
            objectId: found.id,
            status: "unknown" as const,
            detail: null,
            observedAt: new Date(0).toISOString(),
            source: null
          }
        );
      });
      reply.status(200).send(record);
    }
  });

  // READ (batch): the graph node-payload JOIN. `POST /graph/subgraph` returns EDGES ONLY, so the UI
  // fetches health in a parallel follow-up call over the node id set (mirroring the subgraph
  // batch-by-ids pattern) and joins it onto the nodes by id. Authorized identically to subgraph:
  // `graph:query` scoped to `objectId`, the exploration root.
  typed.route({
    method: "POST",
    url: "/api/v1/graph/health",
    schema: {
      body: HealthBatchRequestSchema,
      response: {
        200: HealthBatchResultSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "graphHealth",
        summary: "Batch latest-health over an object-id set (graph node join)",
        tags: ["health"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "graph:query",
          scopeObjectId: request.body.objectId
        });
        const records = await getObjectHealthBatch(tx, auth.orgId, request.body.ids);
        return { records };
      });
      reply.status(200).send(result);
    }
  });
}
