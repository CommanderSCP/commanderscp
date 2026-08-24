import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CampaignAdoptionResponseSchema,
  CampaignExplainResponseSchema,
  CampaignIdParamSchema,
  CampaignListQuerySchema,
  CampaignListResponseSchema,
  CampaignSchema,
  CreateCampaignRequestSchema,
  ProblemSchema,
  RollbackCampaignRequestSchema,
  RollbackCampaignResponseSchema,
  SetCampaignDeadlineRequestSchema
} from "@scp/schemas";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import {
  getCampaign,
  listCampaigns,
  proposeCampaign,
  setCampaignDeadline
} from "../coordination/campaign-repo.js";
import { buildCampaignAdoptionReport } from "../coordination/campaign-adoption.js";
import { getLatestCampaignPlan } from "../coordination/campaign-plan-service.js";
import { insertDecision, listDecisionsForSubject } from "../coordination/decisions-repo.js";
import { triggerCampaignRollback } from "../coordination/campaign-rollback.js";
import {
  CAMPAIGN_DEADLINE_SET_AUDIT_ACTION,
  CAMPAIGN_DEADLINE_SET_DECISION_KIND
} from "../coordination/campaign-deadline-lock.js";
import { appendAuditEvent } from "../audit/audit-repo.js";

/**
 * `/campaigns` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — the campaign-scoped sibling of
 * `routes/changes.ts`. Deliberately thin: every write here is a graph-object create (`campaign`,
 * pre-seeded built-in type) plus a Decision, exactly like `POST /changes`; there is no
 * transition-guarded verb surface (`:cancel`/`:accept`) because a campaign has no transition-
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
        // Per-target authority is additionally (and separately) enforced INSIDE proposeCampaign —
        // see that function's module doc (M5 security-sensitive surface).
        return proposeCampaign(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: body.id,
          urn: body.urn,
          domainId: declaredParent,
          name: body.name,
          description: body.description,
          labels: body.labels,
          topologyIdOrUrn: body.topology,
          type: body.type,
          // M25.4 — passed straight through. The SHAPE refusal is not here: it is at
          // `graph/objects-repo.ts`'s choke point, which this call reaches through `createObject`,
          // because IaC apply and hand-fill reach `campaign.properties` without passing through
          // this route at all (`governance/campaign-recipe-guard.ts`).
          recipe: body.recipe,
          // M25.6a — authored here so a deadlined campaign is ONE call. Moving and clearing it
          // afterwards is `POST /campaigns/{id}/deadline`, which demands a reason and records the
          // previous value.
          deadline: body.deadline,
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
      openapi: {
        operationId: "getCampaign",
        summary: "Get a campaign by id (status is derived live)",
        tags: ["campaigns"]
      }
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
      response: {
        200: CampaignExplainResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "explainCampaign",
        summary:
          "The campaign, its compiled plan (member Changes resolved), and every Decision made about it",
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

  /**
   * M25.5 — "has each of this campaign's components migrated yet?", derived live.
   *
   * A PURELY ADDITIVE NEW PATH. No existing schema changes shape: `CampaignRecipeSchema` gains one
   * OPTIONAL property (additive on both the request and the response — making an existing REQUIRED
   * response field optional is the oasdiff break this project has already paid for once, and nothing
   * here does that), and every schema this route names is new.
   *
   * `object:read` at the org, the same scope `:explain` uses, and for the same reason: the answer is
   * assembled from the campaign, its plan and its targets' own inventory/control rows, all of which
   * are already readable at that scope. This route reads and writes nothing — the Decision that
   * accompanies an `adopted` verdict is written by the reconciler's actuator, never by a GET.
   */
  typed.route({
    method: "GET",
    url: "/api/v1/campaigns/:id/adoption",
    schema: {
      params: CampaignIdParamSchema,
      response: {
        200: CampaignAdoptionResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "campaignAdoption",
        summary:
          "Per-target adoption evidence for a campaign — whether each component has migrated, derived live from the evidence source the recipe names (absent evidence is 'unknown', never 'adopted')",
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
        return buildCampaignAdoptionReport(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(result);
    }
  });

  /**
   * M25.6a — SET, MOVE or CLEAR this campaign's deadline (owner decision D4).
   *
   * ===========================================================================================
   * THIS IS THE EXIT, AND THAT IS WHY IT SHIPS IN THE SAME INCREMENT AS THE LOCK
   * ===========================================================================================
   * §4.5's per-target waiver (`POST /campaigns/{id}/deadline-override`, behind a new Owner-only
   * `campaign:deadline-override` permission) is **M25.6b**: the permission needs an additive
   * `array_append` migration, and migration numbering is serialized across concurrent sessions
   * behind a hard contiguity gate. A lock with no exit at all would be the entrance-with-no-exit
   * failure M25.1 exists to close — a governance mechanism an operator can enter and cannot leave —
   * so this verb ships in its place. **Clearing the deadline unlocks every target at once**, on the
   * next 1 s tick, with no unlock verb and no backfill, because the lock is a read-time predicate.
   *
   * `object:write` AT THE CAMPAIGN OBJECT, not at the org root and not at the targets. Not the org
   * root, because `hasPermission` expands the checked scope upward anyway, so checking at the
   * campaign admits everyone an org-root check would AND an Administrator bound at the campaign's
   * own containment domain — the person with the context. Not the targets, because the thing being
   * configured is this campaign's policy about its own fan-out, and a target-scoped check would hand
   * the laggard their own waiver (§4.5's stated inversion, applied one verb over).
   *
   * `reason` IS MANDATORY on all three acts, INCLUDING THE CLEAR — `SetCampaignDeadlineRequestSchema`
   * enforces `min(1)`. Clearing is the LOOSENING, so if any of the three deserves a recorded
   * justification it is that one.
   *
   * ===========================================================================================
   * ONE DECISION AND ONE HIGH-SEVERITY AUDIT EVENT, AND THE DECISION CARRIES THE PREVIOUS VALUE
   * ===========================================================================================
   * `audit_events` has no payload column, so the Decision is the only place "from what, to what"
   * survives — the same division of labour `freeze.lift` / `freeze.window.*` already use (M25.1).
   * Without the previous value, "the deadline slipped four times" is unreconstructible from a chain
   * of writes that each say only where it landed, which is precisely the accountability the whole
   * mechanism exists to produce.
   *
   * NO `insertDecisionIfChanged`, and no dedup concern: this is a one-per-API-call authoring record,
   * not a predicate re-evaluated on a timer. ADR-0024's write amplification came from a reconcile
   * loop restating an unchanged verdict 86,400 times a day; a human pressing a button is not that.
   * It writes under its OWN kind (`campaign_deadline_set`) rather than the lock's, so the authoring
   * stream and the enforcement stream stay separable in `scp campaign explain`.
   *
   * THE CAMPAIGN'S `properties` ARE REWRITTEN THROUGH `updateObject`, so this is a versioned,
   * content-hashed, ordinarily-audited graph write on top of the governance record above it — no
   * side door into `objects.properties`.
   */
  typed.route({
    method: "POST",
    url: "/api/v1/campaigns/:id/deadline",
    schema: {
      params: CampaignIdParamSchema,
      body: SetCampaignDeadlineRequestSchema,
      response: {
        200: CampaignSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "setCampaignDeadline",
        summary:
          "Set, move or clear a campaign's deadline — past it, targets this campaign cannot observe as migrated stop receiving ITS changes (unrelated releases are unaffected)",
        tags: ["campaigns"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const campaign = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: request.params.id
        });
        const result = await setCampaignDeadline(tx, {
          orgId: auth.orgId,
          campaignObjectId: request.params.id,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          deadline: request.body.deadline
        });
        const action = result.after === null ? "clear" : result.before === null ? "set" : "move";
        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: CAMPAIGN_DEADLINE_SET_DECISION_KIND,
          subjectId: request.params.id,
          verdict: "allow",
          inputContext: {
            action,
            // THE PREVIOUS VALUE, beside the new one. `beforeUnreadable` distinguishes "replaced a
            // broken document" from "set the first one" rather than letting a reader guess.
            deadline: {
              from: result.before,
              to: result.after,
              fromUnreadable: result.beforeUnreadable
            },
            actorId: auth.subjectObjectId,
            reason: request.body.reason
          },
          reasonTree: {
            summary:
              result.after === null
                ? `campaign deadline CLEARED (was ${result.before?.at ?? "unreadable"}) — every target this campaign was withholding fan-out from resumes on the next tick`
                : result.before === null
                  ? `campaign deadline SET to ${result.after.at} — past it, targets this campaign cannot observe as migrated stop receiving ITS changes; unrelated releases are unaffected`
                  : `campaign deadline MOVED from ${result.before.at} to ${result.after.at}`,
            // A clear, and a move to a later instant, both LOOSEN: strictly fewer targets are
            // withheld from afterwards. Labelled from the values rather than from which branch
            // matched, so the label stays true if the branches are ever reordered.
            loosening:
              result.after === null ||
              (result.before !== null && Date.parse(result.after.at) > Date.parse(result.before.at))
          }
        });
        // The `freeze.lift` shape: high-severity, mandatory reason, pointing at the Decision that
        // carries the structured before/after.
        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: CAMPAIGN_DEADLINE_SET_AUDIT_ACTION,
          subjectId: request.params.id,
          reason: request.body.reason,
          decisionId: decision.id,
          requestId: request.id
        });
        return result.campaign;
      });
      reply.status(200).send(campaign);
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
          "Roll back every currently-eligible (executing/validating/accepted) member Change of a campaign — each becomes its own new rollback Change",
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
