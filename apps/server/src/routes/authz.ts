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

/**
 * ================================================================================================
 * `GET /api/v1/authz/effective` — role-model.md §5 step 6
 * ================================================================================================
 *
 * WHAT THE PURPOSE ROLES BROKE, AND WHY A READ SURFACE IS THE FIX. The cumulative ladder was
 * guessable: Viewer < Operator < Approver < Administrator < Owner, so a client that knew a
 * principal's rank could infer the whole permission set. drizzle/0099's five purpose roles are
 * deliberately NOT ordered — SecurityOfficer holds `scan:override` and no `object:write`; OrgAdmin
 * holds `policy:write` and NOT `scan:override`; neither is "above" the other — so there is nothing
 * left to infer from. Without this operation a UI's only way to learn whether to render a control
 * is to POST and read the 403, which is not a usable interface.
 *
 * ------------------------------------------------------------------------------------------------
 * IT ANSWERS ONLY ABOUT THE CALLER, AND THAT IS THE WHOLE AUTHORIZATION ARGUMENT
 * ------------------------------------------------------------------------------------------------
 * There is NO `subjectId` parameter. An earlier shape of the neighbouring grant-preview operation
 * took a caller-chosen authorization anchor and had to be rewritten twice, because a parameter the
 * caller chooses is a parameter the caller sets to whatever admits them
 * (`packages/schemas/src/rbac.ts`'s `GrantPreviewQuerySchema` carries that history). The way this
 * operation avoids re-introducing that class is to have no such parameter at all: it reports facts
 * about the authenticated caller, so there is no other principal whose data could leak.
 *
 * "Who else has authority here" is a real and separate question. It is NOT this operation, and
 * answering it needs its own disclosure rules — the same care `readableSubsetOf` applies on the
 * preview — rather than a boolean bolted onto this one.
 *
 * ------------------------------------------------------------------------------------------------
 * NO PERMISSION BAR, AND THE TRADE IS STATED RATHER THAN ASSUMED
 * ------------------------------------------------------------------------------------------------
 * This route demands authentication and nothing else. Demanding `object:read` at the scope was
 * considered and is self-defeating: the caller who most needs the answer is exactly the one who
 * does not know what they hold, and a 403 for "you may not ask what you may do" is
 * indistinguishable from "you may do nothing" — while being a different fact.
 *
 * WHAT THAT DISCLOSES, HONESTLY: an authenticated member of the org learns whether a given object
 * id exists in their org (404 versus 200). It discloses nothing ABOUT the object — no type, no
 * name, no contents — and nothing about any other principal. The `withTenantTx` RLS boundary keeps
 * the lookup inside the caller's own org, so a cross-org id is a 404 like any other absent one.
 * Accepted as strictly smaller than the alternative's cost.
 */
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
