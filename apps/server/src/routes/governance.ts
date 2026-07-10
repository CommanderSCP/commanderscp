import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ApprovalIdParamSchema,
  ApprovalRequestListQuerySchema,
  ApprovalRequestListResponseSchema,
  ApprovalRequestSchema,
  ApprovalVoteSchema,
  CastApprovalVoteRequestSchema,
  ControlBindingSchema,
  ControlRunListResponseSchema,
  CreateControlBindingRequestSchema,
  CreateFreezeRequestSchema,
  FreezeIdParamSchema,
  FreezeListResponseSchema,
  FreezeSchema,
  PolicyEvaluateRequestSchema,
  PolicyEvaluateResponseSchema,
  ProblemSchema,
  RegistryIdOrUrnParamSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import type { GateDeps } from "../coordination/gates.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, notFound } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { targetObjectIdsOf } from "../coordination/changes-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { evaluateGovernanceGate } from "../governance/gate-orchestrator.js";
import { upsertControlBinding, listControlRunsForChange } from "../governance/controls-repo.js";
import {
  castApprovalVote,
  getApprovalRequest,
  listApprovalRequestsForChange,
  listVotesForRequest,
  quorumStatus
} from "../governance/approvals-repo.js";
import { createFreeze, getFreeze, listFreezes } from "../governance/freezes-repo.js";

/**
 * M4 governance sub-resources that aren't plain typed-registry objects (BUILD_AND_TEST.md §8 M4):
 * control bindings + runs, approval quorum, freezes, and `scp policy evaluate`'s dry-run endpoint.
 * Registered from app.ts alongside `GOVERNANCE_TYPED_REGISTRY_RESOURCES` (routes/typed-registries.ts).
 */
export function registerGovernanceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const gateDeps: GateDeps = { sandbox: deps.celSandbox!, host: null };

  // -----------------------------------------------------------------------------------------
  // Control bindings + runs (DESIGN §10.2)
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/controls/:idOrUrn/binding",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      body: CreateControlBindingRequestSchema,
      response: { 200: ControlBindingSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putControlBinding",
        summary: "Bind a Control to a ControlPlugin instance (DESIGN §10.2 — swapping the impl changes only this)",
        tags: ["controls"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const control = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        if (control.typeId !== "control") throw notFound(`'${request.params.idOrUrn}' is not a control object`);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "policy:write",
          scopeObjectId: control.id
        });
        return upsertControlBinding(tx, {
          orgId: auth.orgId,
          controlObjectId: control.id,
          pluginModule: request.body.pluginModule,
          pluginInstanceId: request.body.pluginInstanceId,
          config: request.body.config
        });
      });
      reply.status(200).send({
        id: binding.id,
        controlObjectId: binding.controlObjectId,
        pluginModule: binding.pluginModule,
        pluginInstanceId: binding.pluginInstanceId,
        config: binding.config
      });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/changes/:idOrUrn/control-runs",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: { 200: ControlRunListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listChangeControlRuns",
        summary: "List control run outcomes + evidence for a change (DESIGN §10.2/§10.4)",
        tags: ["controls"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const runs = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listControlRunsForChange(tx, auth.orgId, request.params.idOrUrn);
      });
      reply.status(200).send({
        items: runs.map((r) => ({
          id: r.id,
          controlObjectId: r.controlObjectId,
          changeObjectId: r.changeObjectId,
          status: r.status,
          evidence: r.evidence,
          detail: r.detail,
          decisionId: r.decisionId,
          createdAt: r.createdAt.toISOString()
        })),
        nextCursor: null
      });
    }
  });

  // -----------------------------------------------------------------------------------------
  // Approvals (DESIGN §10.2 — N-of-M quorum)
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "GET",
    url: "/api/v1/approvals",
    schema: {
      querystring: ApprovalRequestListQuerySchema,
      response: { 200: ApprovalRequestListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "listApprovals", summary: "List approval requests, optionally filtered by change", tags: ["approvals"] }
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
        if (!request.query.changeId) {
          throw badRequest("changeId is required (M4: approvals are always listed scoped to a change)");
        }
        const changeObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.query.changeId);
        const requests = await listApprovalRequestsForChange(tx, auth.orgId, changeObject.id);
        const items = await Promise.all(
          requests.map(async (r) => {
            const status = await quorumStatus(tx, auth.orgId, r);
            return {
              id: r.id,
              changeObjectId: r.changeObjectId,
              policyObjectId: r.policyObjectId,
              policyVersion: r.policyVersion,
              effectIndex: r.effectIndex,
              requiredCount: r.requiredCount,
              fromRole: r.fromRole,
              scopeObjectId: r.scopeObjectId,
              status: r.status,
              createdAt: r.createdAt.toISOString(),
              satisfiedAt: r.satisfiedAt?.toISOString() ?? null,
              voteCount: status.count
            };
          })
        );
        return { items, nextCursor: null };
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/approvals/:id",
    schema: {
      params: ApprovalIdParamSchema,
      response: { 200: ApprovalRequestSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: { operationId: "getApproval", summary: "Get an approval request by id", tags: ["approvals"] }
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
        const r = await getApprovalRequest(tx, auth.orgId, request.params.id);
        const status = await quorumStatus(tx, auth.orgId, r);
        return { r, status };
      });
      reply.status(200).send({
        id: result.r.id,
        changeObjectId: result.r.changeObjectId,
        policyObjectId: result.r.policyObjectId,
        policyVersion: result.r.policyVersion,
        effectIndex: result.r.effectIndex,
        requiredCount: result.r.requiredCount,
        fromRole: result.r.fromRole,
        scopeObjectId: result.r.scopeObjectId,
        status: result.r.status,
        createdAt: result.r.createdAt.toISOString(),
        satisfiedAt: result.r.satisfiedAt?.toISOString() ?? null,
        voteCount: result.status.count
      });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/approvals/:id/votes",
    schema: {
      params: ApprovalIdParamSchema,
      response: {
        200: z.array(ApprovalVoteSchema),
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: { operationId: "listApprovalVotes", summary: "List votes cast on an approval request", tags: ["approvals"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const votes = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        await getApprovalRequest(tx, auth.orgId, request.params.id); // 404s if unknown
        return listVotesForRequest(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(
        votes.map((v) => ({
          id: v.id,
          approvalRequestId: v.approvalRequestId,
          voterObjectId: v.voterObjectId,
          decisionId: v.decisionId,
          attestation: v.attestation,
          votedAt: v.votedAt.toISOString()
        }))
      );
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/approvals/:id/votes",
    schema: {
      params: ApprovalIdParamSchema,
      body: CastApprovalVoteRequestSchema,
      response: {
        201: ApprovalVoteSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "castApprovalVote",
        summary: "Cast a vote on an approval request (DESIGN §10.2 — N-of-M quorum, one vote per subject, always self-attested)",
        tags: ["approvals"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const vote = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Authorize `approval:write` at the approval request's OWN scope, not org root (MAJOR #5):
        // a service-scoped approval (`requireApprovals.scope: "service"` → the target's containing
        // service) must be actionable by a service-scoped Approver. The coarse `approval:write`
        // permission check and the fine-grained `hasRoleAtScope` quorum-eligibility check
        // (approvals-repo.ts) now agree on the same scope. Loading the request here also 404s an
        // unknown id before any write.
        const approvalRequest = await getApprovalRequest(tx, auth.orgId, request.params.id);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "approval:write",
          scopeObjectId: approvalRequest.scopeObjectId
        });
        return castApprovalVote(tx, {
          orgId: auth.orgId,
          approvalRequestId: request.params.id,
          voterObjectId: auth.subjectObjectId,
          voterIdpSubject: request.body.voterIdpSubject ?? null,
          requestId: request.id
        });
      });
      reply.status(201).send({
        id: vote.id,
        approvalRequestId: vote.approvalRequestId,
        voterObjectId: vote.voterObjectId,
        decisionId: vote.decisionId,
        attestation: vote.attestation,
        votedAt: vote.votedAt.toISOString()
      });
    }
  });

  // -----------------------------------------------------------------------------------------
  // Freezes (DESIGN §10.3)
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "POST",
    url: "/api/v1/freezes",
    schema: {
      body: CreateFreezeRequestSchema,
      response: { 201: FreezeSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "createFreeze", summary: "Declare a freeze window over a scope (DESIGN §10.3)", tags: ["freezes"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const freeze = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const scopeObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.scopeObjectId);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "freeze:write",
          scopeObjectId: scopeObject.id
        });
        const startsAt = new Date(request.body.startsAt);
        const endsAt = new Date(request.body.endsAt);
        if (endsAt <= startsAt) throw badRequest("freeze endsAt must be after startsAt");
        return createFreeze(tx, {
          orgId: auth.orgId,
          scopeObjectId: scopeObject.id,
          name: request.body.name,
          startsAt,
          endsAt,
          reason: request.body.reason,
          createdByActorId: auth.subjectObjectId
        });
      });
      reply.status(201).send({
        id: freeze.id,
        scopeObjectId: freeze.scopeObjectId,
        name: freeze.name,
        startsAt: freeze.startsAt.toISOString(),
        endsAt: freeze.endsAt.toISOString(),
        reason: freeze.reason,
        createdByActorId: freeze.createdByActorId,
        createdAt: freeze.createdAt.toISOString()
      });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/freezes",
    schema: {
      response: { 200: FreezeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "listFreezes", summary: "List freeze windows", tags: ["freezes"] }
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
        return listFreezes(tx, auth.orgId);
      });
      reply.status(200).send({
        items: items.map((f) => ({
          id: f.id,
          scopeObjectId: f.scopeObjectId,
          name: f.name,
          startsAt: f.startsAt.toISOString(),
          endsAt: f.endsAt.toISOString(),
          reason: f.reason,
          createdByActorId: f.createdByActorId,
          createdAt: f.createdAt.toISOString()
        })),
        nextCursor: null
      });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/freezes/:id",
    schema: {
      params: FreezeIdParamSchema,
      response: { 200: FreezeSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: { operationId: "getFreeze", summary: "Get a freeze by id", tags: ["freezes"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const freeze = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return getFreeze(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send({
        id: freeze.id,
        scopeObjectId: freeze.scopeObjectId,
        name: freeze.name,
        startsAt: freeze.startsAt.toISOString(),
        endsAt: freeze.endsAt.toISOString(),
        reason: freeze.reason,
        createdByActorId: freeze.createdByActorId,
        createdAt: freeze.createdAt.toISOString()
      });
    }
  });

  // -----------------------------------------------------------------------------------------
  // `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7) — a dry-run of the exact same gate
  // orchestrator the real lifecycle/wave gates use, against a change's CURRENT state. Never
  // attempts a transition, never runs a control (host: null — read-only), never writes a
  // Decision on its own EXCEPT one explicitly marked as a dry run, so `scp change explain` never
  // confuses a dry-run check with a real gate verdict.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "POST",
    url: "/api/v1/policy-evaluate",
    schema: {
      body: PolicyEvaluateRequestSchema,
      response: { 200: PolicyEvaluateResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "policyEvaluate",
        summary: "Dry-run governance evaluation for a change — verdict + reason tree, no transition attempted",
        tags: ["policies"]
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
        const changeObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.changeId);
        const targetObjectIds = targetObjectIdsOf(changeObject.properties as Record<string, unknown>);
        const outcome = await evaluateGovernanceGate(tx, gateDeps.sandbox, null, {
          orgId: auth.orgId,
          changeObjectId: changeObject.id,
          targetObjectIds: targetObjectIds.length > 0 ? targetObjectIds : [changeObject.id],
          actorObjectId: auth.subjectObjectId,
          emergency: false,
          gateKind: "lifecycle_edge",
          gateRef: { dryRun: true }
        });
        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: "policy_evaluate_dry_run",
          subjectId: changeObject.id,
          verdict: outcome.verdict,
          inputContext: outcome.inputContext,
          reasonTree: outcome.reasonTree
        });
        return { outcome, decisionId: decision.id };
      });
      reply.status(200).send({
        verdict: result.outcome.verdict,
        reasonTree: result.outcome.reasonTree,
        inputContext: result.outcome.inputContext
      });
    }
  });
}
