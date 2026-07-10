import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { v7 as uuidv7 } from "uuid";
import {
  ChangeSourceEventParamSchema,
  CreateSourceMappingRequestSchema,
  ProblemSchema,
  SourceMappingListResponseSchema,
  SourceMappingSchema,
  WebhookIngressResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { changeSourceEvents } from "../db/schema.js";
import { createSourceMapping, listSourceMappingsForSource } from "../coordination/source-mappings-repo.js";

/**
 * Change sources: webhook ingress (persist-then-process, DESIGN.md §8) + `source_mappings` CRUD
 * (DESIGN §9.2 correlation). BUILD_AND_TEST.md §8 M3.
 *
 * **Authentication (documented deviation):** DESIGN's webhook ingestion language ("signature
 * verified") describes how GitHub/ArgoCD/Terraform themselves authenticate a webhook call
 * (per-provider HMAC schemes) — but M3 ships no per-source-kind secret storage/configuration
 * surface to verify against (that arrives with the real executor plugins in M7, alongside actual
 * provider integrations). Rather than half-implement provider-specific signature schemes against
 * nothing, this endpoint is authenticated the SAME way every other API call is: `requireAuth`
 * (Bearer/PAT), with the org resolved from the token exactly like every other route — consistent
 * with M2's PATs existing precisely for machine-to-machine calls like this one. A source-specific
 * adapter (a small relay script today; a real provider's own webhook receiver once M7's plugins
 * ship) is expected to front actual GitHub/ArgoCD/Terraform webhooks and forward them here with a
 * configured PAT. `signature_verified` is persisted as `false` for every M3 delivery, honestly
 * reflecting that no verification happened — not silently defaulted to `true`.
 */
export function registerChangeSourceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/change-sources/:sourceKind/webhook",
    schema: {
      params: ChangeSourceEventParamSchema,
      response: {
        202: WebhookIngressResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "ingestChangeSourceWebhook",
        summary:
          "Persist a raw source-event payload (persist-then-process — coordination/webhook-processor.ts turns it into a Change on the next reconcile tick)",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const eventId = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        const id = uuidv7();
        await tx.insert(changeSourceEvents).values({
          id,
          orgId: auth.orgId,
          sourceKind: request.params.sourceKind,
          signatureVerified: false,
          headers: request.headers as Record<string, unknown>,
          payload: (request.body ?? {}) as Record<string, unknown>
        });
        return id;
      });
      reply.status(202).send({ accepted: true, eventId });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/change-sources/:sourceKind/mappings",
    schema: {
      params: ChangeSourceEventParamSchema,
      body: CreateSourceMappingRequestSchema,
      response: {
        201: SourceMappingSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createSourceMapping",
        summary: "Bind a repo/path pattern for this source kind to a component (DESIGN §9.2 correlation)",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const mapping = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        return createSourceMapping(tx, {
          orgId: auth.orgId,
          sourceKind: request.params.sourceKind,
          repoPattern: request.body.repoPattern,
          pathPattern: request.body.pathPattern,
          componentIdOrUrn: request.body.component
        });
      });
      reply.status(201).send(mapping);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/change-sources/:sourceKind/mappings",
    schema: {
      params: ChangeSourceEventParamSchema,
      response: { 200: SourceMappingListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listSourceMappings",
        summary: "List source_mappings for one source kind",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const items = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listSourceMappingsForSource(tx, auth.orgId, request.params.sourceKind);
      });
      reply.status(200).send({ items, nextCursor: null });
    }
  });
}
