import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ProblemSchema,
  RegistryIdOrUrnParamSchema,
  ServiceBoardResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrn } from "../graph/objects-repo.js";
import { buildServiceBoard } from "../coordination/service-board.js";

/**
 * Service-scoped read projections (docs/proposals/coordination-ui-views.md Phase 2). Distinct from the
 * generic typed-registry `/services` CRUD (routes/typed-registries.ts) — this file adds the release
 * board, a cross-object aggregation the templated registry routes can't express. The path carries an
 * extra `/board` segment, so it never collides with the registry's `/:idOrUrn` detail route.
 */
export function registerServiceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET /services/:idOrUrn/board — the service release board (Layer A). One server-side projection of
  // every component's latest change's per-stage status + attention (see coordination/service-board.ts).
  typed.route({
    method: "GET",
    url: "/api/v1/services/:idOrUrn/board",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: { 200: ServiceBoardResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "getServiceBoard",
        summary: "The service release board — its components, each's latest change per-stage status, and a releasing/blocked/stable summary",
        tags: ["services"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const board = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const service = await getObjectByIdOrUrn(tx, auth.orgId, "service", request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: service.id
        });
        return buildServiceBoard(tx, auth.orgId, service);
      });
      reply.status(200).send(board);
    }
  });
}
