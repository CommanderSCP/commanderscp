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

/** The instance operator-credential routes. See docs/routes.md §280. */
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

      // Revoking your own credential is allowed, with no floor. See docs/routes.md §281.
      const revoked = await revokeOperatorCredential(deps.config, request.params.id);
      if (!revoked) throw notFound(`operator credential '${request.params.id}' not found`);

      reply.status(204).send(undefined);
    }
  });
}
