import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  EffectivePermissionsQuerySchema,
  EffectivePermissionsResponseSchema,
  ProblemSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { contributingBindingsAt, effectivePermissions } from "../authz/resolve.js";

import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { notFound } from "../errors.js";

/** The effective-permissions route, and what roles buy. See docs/routes.md §7. */
export function registerAuthzRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/authz/effective",
    schema: {
      querystring: EffectivePermissionsQuerySchema,
      response: {
        200: EffectivePermissionsResponseSchema,
        401: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getEffectivePermissions",
        summary: "The calling principal's own effective permissions at one object",
        description:
          "Resolves the caller's permissions at the given scope object, with deny-override " +
          "applied, plus the bindings that produced them. Answers only about the caller.",
        tags: ["authz"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { scopeObjectId } = request.query;

      const body = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Resolve first so an unknown id is a 404 rather than a 200 carrying an empty set — the
        // two mean very different things to a UI, and conflating them would make a typo look like
        // a permission problem.
        const scope = await getObjectByIdOrUrnAnyType(tx, auth.orgId, scopeObjectId);
        if (!scope) throw notFound(`object '${scopeObjectId}' not found`);

        const permissions = await effectivePermissions(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId: scope.id
        });

        // The explanation half. Read in the SAME transaction as the permissions above, so the
        // bindings shown are the bindings that produced the set rather than a later snapshot of a
        // concurrently-edited table.
        const contributingBindings = await contributingBindingsAt(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId: scope.id
        });

        return { scopeObjectId: scope.id, permissions, contributingBindings };
      });

      reply.status(200).send(body);
    }
  });
}
