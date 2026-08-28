import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateOperatorCredentialRequestSchema,
  CreatedOperatorCredentialSchema,
  OperatorCredentialIdParamSchema,
  OperatorCredentialListResponseSchema,
  ProblemSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import {
  createOperatorCredential,
  listOperatorCredentials,
  requireInstanceOperator,
  revokeOperatorCredential
} from "../auth/operator-auth.js";
import { notFound } from "../errors.js";

/**
 * ================================================================================================
 * `/api/v1/instance/operator-credentials` — role-model.md §5 step 9 / §3B
 * ================================================================================================
 *
 * The management surface for the credential that replaces `SCP_OPERATOR_TOKEN`.
 *
 * GATED BY AN OPERATOR CREDENTIAL, NOT BY RBAC — and it must be, because these rows open every
 * instance-tier write door on the deployment. Any RBAC gating would put a tenant permission in
 * front of authority that binds the tenant's neighbours, which is the exact inversion the whole
 * instance tier exists to prevent (role-model.md §1.5: there is no authority tier above an org, so
 * this cannot be modelled as one).
 *
 * WHICH MAKES IT SELF-REFERENTIAL, DELIBERATELY: minting a credential requires already holding one.
 * The bootstrap `SCP_OPERATOR_TOKEN` is what resolves the regress — set it once, mint a real
 * credential, unset it. `GET` reports `callerMechanism` so an operator can SEE whether the
 * deployment is still on that bootstrap path, because otherwise the migration away from the env
 * token is invisible: minting credentials while leaving the env var set looks identical to having
 * finished.
 *
 * `requireAuth` RUNS TOO, on every operation. The operator credential is the AUTHORITY; the
 * authenticated principal is the ATTRIBUTION. Both matter and neither substitutes for the other —
 * that split is what the shared env token could not express, since one secret made every operator
 * indistinguishable from every other.
 */
export function registerOperatorCredentialRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/instance/operator-credentials",
    schema: {
      body: CreateOperatorCredentialRequestSchema,
      response: {
        201: CreatedOperatorCredentialSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createOperatorCredential",
        summary: "Mint a named instance-operator credential (returns the secret exactly once)",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, "instance operator credentials");

      const created = await createOperatorCredential(deps.config, {
        name: request.body.name,
        // ATTRIBUTION, from the authenticated principal rather than from the credential — so the
        // row records WHO minted it even when the mint was authorised by the shared bootstrap
        // token, which is precisely the case where the authority itself names nobody.
        createdByUserId: auth.subjectObjectId,
        expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null
      });

      reply.status(201).send({
        id: created.id,
        name: created.name,
        token: created.token,
        createdAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null
      });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/instance/operator-credentials",
    schema: {
      response: {
        200: OperatorCredentialListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listOperatorCredentials",
        summary: "List instance-operator credentials (never their secrets)",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      const caller = await requireInstanceOperator(deps, request, "instance operator credentials");

      const rows = await listOperatorCredentials(deps.db);
      reply.status(200).send({
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          createdByUserId: r.createdByUserId,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
          lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null
        })),
        callerMechanism: caller.mechanism
      });
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/operator-credentials/:id",
    schema: {
      params: OperatorCredentialIdParamSchema,
      response: {
        204: z.undefined(),
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "revokeOperatorCredential",
        summary: "Revoke an instance-operator credential",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, "instance operator credentials");

      // REVOKING YOUR OWN CREDENTIAL IS ALLOWED, and there is no last-credential floor here — the
      // deliberate opposite of the administrative floor on role bindings (role-binding-door.ts §7).
      // The difference is recoverability: an org that revokes its last Owner binding has NO way
      // back through the API, whereas a deployment that revokes its last operator credential is
      // recovered by setting SCP_OPERATOR_TOKEN and restarting — an action the operator of a
      // self-hosted instance can always take, because they own the process. A floor here would
      // block the legitimate "revoke everything, we suspect compromise" without protecting against
      // anything unrecoverable.
      const revoked = await revokeOperatorCredential(deps.config, request.params.id);
      if (!revoked) throw notFound(`operator credential '${request.params.id}' not found`);

      reply.status(204).send(undefined);
    }
  });
}
