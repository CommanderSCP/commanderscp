import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CampaignExplainResponseSchema,
  CampaignIdParamSchema,
  CampaignListQuerySchema,
  CampaignListResponseSchema,
  CampaignSchema,
  CreateCampaignRequestSchema,
  ProblemSchema,
  RollbackCampaignRequestSchema,
  RollbackCampaignResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getCampaign, listCampaigns, proposeCampaign } from "../coordination/campaign-repo.js";
import { getLatestCampaignPlan } from "../coordination/campaign-plan-service.js";
import { listDecisionsForSubject } from "../coordination/decisions-repo.js";
import { triggerCampaignRollback } from "../coordination/campaign-rollback.js";

/**
 * `/campaigns` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — the campaign-scoped sibling of
 * `routes/changes.ts`. Deliberately thin: every write here is a graph-object create (`campaign`,
 * pre-seeded built-in type) plus a Decision, exactly like `POST /changes`; there is no
 * transition-guarded verb surface (`:cancel`/`:promote`) because a campaign has no transition-
 * guarded state machine to drive — see `coordination/campaign-status.ts`'s module doc. The one
 * verb a campaign DOES support beyond propose/list/get/explain is `:rollback`
 * (`coordination/campaign-rollback.ts`), mirroring `POST /changes/{id}/rollback` exactly.
 */
export function registerCampaignRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/campaigns",
    schema: {
      body: CreateCampaignRequestSchema,
      response: { 201: CampaignSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "proposeCampaign",
        summary: "Propose a Campaign coordinating one member Change per target, wave by wave",
        tags: ["campaigns"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;
      const { campaign } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: body.domainId ?? auth.orgId
        });
        // Per-target authority is additionally (and separately) enforced INSIDE proposeCampaign —
        // see that function's module doc (M5 security-sensitive surface).
        return proposeCampaign(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: body.id,
          urn: body.urn,
          domainId: body.domainId,
          name: body.name,
          description: body.description,
          labels: body.labels,
          topologyIdOrUrn: body.topology,
          purpose: body.purpose,
          targets: body.targets
        });
      });
      reply.status(201).send(campaign);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/campaigns",
    schema: {
      querystring: CampaignListQuerySchema,
      response: { 200: CampaignListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "listCampaigns", summary: "List campaigns", tags: ["campaigns"] }
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
        return listCampaigns(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/campaigns/:id",
    schema: {
      params: CampaignIdParamSchema,
      response: { 200: CampaignSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: { operationId: "getCampaign", summary: "Get a campaign by id (status is derived live)", tags: ["campaigns"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const campaign = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return getCampaign(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(campaign);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/campaigns/:id/explain",
    schema: {
      params: CampaignIdParamSchema,
      response: { 200: CampaignExplainResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "explainCampaign",
        summary: "The campaign, its compiled plan (member Changes resolved), and every Decision made about it",
        tags: ["campaigns"]
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
        const campaign = await getCampaign(tx, auth.orgId, request.params.id);
        const [plan, decisions] = await Promise.all([
          getLatestCampaignPlan(tx, auth.orgId, request.params.id),
          listDecisionsForSubject(tx, auth.orgId, request.params.id)
        ]);
        return { campaign, plan, decisions };
      });
      reply.status(200).send(result);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/campaigns/:id/rollback",
    schema: {
      params: CampaignIdParamSchema,
      body: RollbackCampaignRequestSchema,
      response: {
        200: RollbackCampaignResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "rollbackCampaign",
        summary:
          "Roll back every currently-eligible (executing/validating/promoted) member Change of a campaign — each becomes its own new rollback Change",
        tags: ["campaigns"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        return triggerCampaignRollback(tx, {
          orgId: auth.orgId,
          campaignObjectId: request.params.id,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          reason: request.body.reason
        });
      });
      reply.status(200).send(result);
    }
  });
}
