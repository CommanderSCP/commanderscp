import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreatePatRequestSchema,
  CreatePatResponseSchema,
  PatIdParamSchema,
  PatListResponseSchema,
  PatSchema,
  ProblemSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { createPat, listPats, revokePat, type PatMetadata } from "../auth/pat.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { notFound } from "../errors.js";

function serializePat(pat: PatMetadata) {
  return {
    id: pat.id,
    name: pat.name,
    createdAt: pat.createdAt.toISOString(),
    expiresAt: pat.expiresAt?.toISOString() ?? null,
    revokedAt: pat.revokedAt?.toISOString() ?? null,
    lastUsedAt: pat.lastUsedAt?.toISOString() ?? null
  };
}

/** Personal Access Tokens. See docs/routes.md §300. */
export function registerPatRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/auth/pats",
    schema: {
      body: CreatePatRequestSchema,
      response: { 201: CreatePatResponseSchema, 401: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "createPat",
        summary: "Create a Personal Access Token (the token is shown once, at creation)",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt) : null;

      const created = await createPat(deps.db, {
        orgId: auth.orgId,
        userId: auth.userId,
        name: request.body.name,
        expiresAt
      });

      await withTenantTx(deps.db, auth.orgId, (tx) =>
        appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "pat.create",
          subjectId: created.id,
          requestId: request.id
        })
      );

      reply.status(201).send({
        id: created.id,
        name: created.name,
        token: created.token,
        createdAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt?.toISOString() ?? null
      });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/auth/pats",
    schema: {
      response: { 200: PatListResponseSchema, 401: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listPats",
        summary: "List the calling user's own Personal Access Tokens (metadata only)",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const items = await listPats(deps.db, { orgId: auth.orgId, userId: auth.userId });
      reply.status(200).send({ items: items.map(serializePat) });
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/auth/pats/:id",
    schema: {
      params: PatIdParamSchema,
      response: { 200: PatSchema, 401: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "revokePat",
        summary: "Revoke a Personal Access Token owned by the calling user",
        tags: ["auth"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const revoked = await revokePat(deps.db, {
        orgId: auth.orgId,
        userId: auth.userId,
        id: request.params.id
      });
      // Don't leak whether the id existed / belonged to another user / was already revoked.
      if (!revoked) throw notFound("personal access token not found");

      await withTenantTx(deps.db, auth.orgId, (tx) =>
        appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "pat.revoke",
          subjectId: revoked.id,
          requestId: request.id
        })
      );

      reply.status(200).send(serializePat(revoked));
    }
  });
}
