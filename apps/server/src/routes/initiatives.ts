import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AddInitiativeCampaignRequestSchema,
  CreateInitiativeRequestSchema,
  InitiativeIdParamSchema,
  InitiativeListQuerySchema,
  InitiativeListResponseSchema,
  InitiativeRollupResponseSchema,
  InitiativeSchema,
  ProblemSchema
} from "@scp/schemas";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import {
  addCampaignToInitiative,
  computeInitiativeRollupFor,
  getInitiative,
  listInitiatives,
  proposeInitiative
} from "../coordination/initiative-repo.js";

/**
 * `/initiatives` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5): graph objects grouping campaigns via
 * `coordinates`, with a roll-up status ALWAYS derived live by traversal
 * (`coordination/initiative-repo.ts`'s `computeInitiativeRollupFor`, backed by the same
 * `graph/named-queries.ts` `initiative-rollup` traversal `GET /graph/query/initiative-rollup`
 * exposes standalone) — never stored on the initiative itself.
 */
export function registerInitiativeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/initiatives",
    schema: {
      body: CreateInitiativeRequestSchema,
      response: {
        201: InitiativeSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "proposeInitiative",
        summary: "Propose an Initiative grouping one or more Campaigns",
        tags: ["initiatives"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;
      const initiative = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The declared parent, resolved ONCE and used for both the permission scope and the write
        // (`graph/containment-parent-authz.ts` — a wire `null` means the org root, never "detach").
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
          declared: containmentDomainIdFromWire(body.domainId),
          current: undefined
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: declaredParent ?? auth.orgId
        });
        return proposeInitiative(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: body.id,
          urn: body.urn,
          domainId: declaredParent,
          name: body.name,
          description: body.description,
          labels: body.labels,
          campaigns: body.campaigns
        });
      });
      reply.status(201).send(initiative);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/initiatives",
    schema: {
      querystring: InitiativeListQuerySchema,
      response: { 200: InitiativeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listInitiatives",
        summary: "List initiatives",
        tags: ["initiatives"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listInitiatives(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/initiatives/:id",
    schema: {
      params: InitiativeIdParamSchema,
      response: {
        200: InitiativeRollupResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getInitiative",
        summary: "Get an initiative with its member campaigns and traversal-derived roll-up status",
        tags: ["initiatives"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const initiative = await getInitiative(tx, auth.orgId, request.params.id);
        const { campaigns, rollupStatus } = await computeInitiativeRollupFor(
          tx,
          auth.orgId,
          request.params.id
        );
        return { initiative, campaigns, rollupStatus };
      });
      reply.status(200).send(result);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/initiatives/:id/campaigns",
    schema: {
      params: InitiativeIdParamSchema,
      body: AddInitiativeCampaignRequestSchema,
      response: {
        204: z.undefined(),
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "addInitiativeCampaign",
        summary: "Add a member campaign to an initiative",
        tags: ["initiatives"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await withTenantTx(deps.db, auth.orgId, (tx) =>
        addCampaignToInitiative(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          initiativeObjectId: request.params.id,
          campaignIdOrUrn: request.body.campaign
        })
      );
      reply.status(204).send(undefined);
    }
  });
}
