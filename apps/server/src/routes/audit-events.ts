import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AuditEventListQuerySchema, AuditEventListResponseSchema, ProblemSchema } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { listAuditEvents } from "../audit/audit-repo.js";

/**
 * `GET /audit-events` (DESIGN.md §4.3, §6) — the only way `scp audit verify` (packages/cli)
 * re-walks the hash chain: strictly through the public API, never direct DB access.
 */
export function registerAuditEventRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/audit-events",
    schema: {
      querystring: AuditEventListQuerySchema,
      response: { 200: AuditEventListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "listAuditEvents", summary: "List audit events (chain order)", tags: ["audit"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "audit:read",
          scopeObjectId: auth.orgId
        });
        return listAuditEvents(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });
}
