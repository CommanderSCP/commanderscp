import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ChangeExplainResponseSchema,
  ChangeIdParamSchema,
  ChangeListQuerySchema,
  ChangeListResponseSchema,
  ChangeSchema,
  ChangeTransitionRequestSchema,
  CreateChangeRequestSchema,
  DecisionIdParamSchema,
  DecisionListQuerySchema,
  DecisionListResponseSchema,
  DecisionSchema,
  ProblemSchema,
  RollbackChangeRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getChange, listChanges, proposeChange } from "../coordination/changes-repo.js";
import { transitionChange } from "../coordination/transition.js";
import type { GateDeps } from "../coordination/gates.js";
import { triggerRollback } from "../coordination/rollback.js";
import { getLatestPlanForChange } from "../coordination/plan-service.js";
import { getDecision, listDecisions, listDecisionsForSubject } from "../coordination/decisions-repo.js";
import { conflict } from "../errors.js";

/**
 * `/changes`, `/change-sources`'s sibling `/decisions` sub-resource, and the guarded-transition
 * verbs (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). Routing note (documented, inherited from
 * routes/plans.ts's own note): DESIGN's `{id}:verb` shorthand does not survive Fastify's router
 * (find-my-way folds `id:verb` into a single param) — every verb here is a conventional
 * `POST /changes/{id}/verb` subpath instead, consistent with `/plans/{id}/apply`.
 *
 * `evaluate`/`coordinate`/`execute`/`validate` have NO route: those edges are entirely
 * engine-automatic in M3 (coordination/reconcile.ts) — there is no policy/control gate for a
 * human to satisfy before them yet (M4). `cancel`/`promote`/`rollback` are the only
 * human-triggerable edges, plus `propose` (the entry point) — matching
 * BUILD_AND_TEST.md's `scp change propose/promote/rollback/explain` CLI surface exactly, with
 * `cancel`/`list`/`get` alongside for completeness (the guarded transition function already
 * supports `cancel` from every pre-promotion state; leaving it unreachable via the API would be
 * an arbitrary gap, not a deliberate one).
 */
export function registerChangeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  // `host: null` — this route runs on the request-serving (`role=api`) tier, which has no
  // `PluginHost` (coordination/gates.ts's module doc, DESIGN §16's api/worker split). The only
  // lifecycle edge this file ever governance-evaluates (`validating->promoted`) only ever READS
  // already-persisted control_runs — never triggers one inline — so this is safe by construction.
  const gateDeps: GateDeps = { sandbox: deps.celSandbox!, host: null };

  typed.route({
    method: "POST",
    url: "/api/v1/changes",
    schema: {
      body: CreateChangeRequestSchema,
      response: { 201: ChangeSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "proposeChange",
        summary: "Propose a Change against one or more targets (entry point of the lifecycle)",
        tags: ["changes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;
      const { change } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: body.domainId ?? auth.orgId
        });
        return proposeChange(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: body.id,
          urn: body.urn,
          domainId: body.domainId,
          name: body.name,
          properties: body.properties,
          labels: body.labels,
          sourceKind: body.sourceKind,
          sourceRef: body.sourceRef,
          correlationKey: body.correlationKey,
          emergency: body.emergency,
          topologyIdOrUrn: body.topology,
          targets: body.targets
        });
      });
      reply.status(201).send(change);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/changes",
    schema: {
      querystring: ChangeListQuerySchema,
      response: { 200: ChangeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "listChanges", summary: "List changes", tags: ["changes"] }
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
        return listChanges(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/changes/:id",
    schema: {
      params: ChangeIdParamSchema,
      response: { 200: ChangeSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: { operationId: "getChange", summary: "Get a change by id", tags: ["changes"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const change = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return getChange(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(change);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/changes/:id/explain",
    schema: {
      params: ChangeIdParamSchema,
      response: { 200: ChangeExplainResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "explainChange",
        summary: "The change, its compiled plan (if any), and every Decision made about it",
        tags: ["changes"]
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
        const change = await getChange(tx, auth.orgId, request.params.id);
        const [plan, decisions] = await Promise.all([
          getLatestPlanForChange(tx, auth.orgId, request.params.id),
          listDecisionsForSubject(tx, auth.orgId, request.params.id)
        ]);
        return { change, plan, decisions };
      });
      reply.status(200).send(result);
    }
  });

  // Every guarded-transition verb below shares this shape: transition inside the tenant tx (its
  // writes commit either way — an "allow" state change or a "block" Decision + audit event),
  // then AFTER commit turn a block into a 409 carrying `decision_id` (transition.ts's own doc
  // comment; DESIGN §6/§10.4).

  typed.route({
    method: "POST",
    url: "/api/v1/changes/:id/cancel",
    schema: {
      params: ChangeIdParamSchema,
      body: ChangeTransitionRequestSchema,
      response: {
        200: ChangeSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: { operationId: "cancelChange", summary: "Cancel a change", tags: ["changes"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const outcome = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        const result = await transitionChange(
          tx,
          {
            orgId: auth.orgId,
            changeObjectId: request.params.id,
            toState: "cancelled",
            actorObjectId: auth.subjectObjectId,
            requestId: request.id,
            reason: request.body.reason ?? null
          },
          gateDeps
        );
        if (result.verdict === "block") return { blocked: result.blockedReason, decisionId: result.decision.id };
        return { change: await getChange(tx, auth.orgId, request.params.id) };
      });
      if ("blocked" in outcome) {
        throw conflict(outcome.blocked, { decisionId: outcome.decisionId });
      }
      reply.status(200).send(outcome.change);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/changes/:id/promote",
    schema: {
      params: ChangeIdParamSchema,
      body: ChangeTransitionRequestSchema,
      response: {
        200: ChangeSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "promoteChange",
        summary: "Promote a change out of `validating` — the human approval gate before `promoted`",
        tags: ["changes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const outcome = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        const result = await transitionChange(
          tx,
          {
            orgId: auth.orgId,
            changeObjectId: request.params.id,
            toState: "promoted",
            actorObjectId: auth.subjectObjectId,
            requestId: request.id,
            reason: request.body.reason ?? null,
            overrideFreeze: request.body.overrideFreeze ? { reason: request.body.reason ?? "" } : undefined
          },
          gateDeps
        );
        if (result.verdict === "block") return { blocked: result.blockedReason, decisionId: result.decision.id };
        return { change: await getChange(tx, auth.orgId, request.params.id) };
      });
      if ("blocked" in outcome) {
        throw conflict(outcome.blocked, { decisionId: outcome.decisionId });
      }
      reply.status(200).send(outcome.change);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/changes/:id/rollback",
    schema: {
      params: ChangeIdParamSchema,
      body: RollbackChangeRequestSchema,
      response: {
        201: ChangeSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "rollbackChange",
        summary:
          "Manually trigger a rollback of a change — creates and returns a NEW Change (linked via rollbackOfObjectId) that executes through the same plan/wave machinery",
        tags: ["changes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { rollbackChange } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        return triggerRollback(tx, {
          orgId: auth.orgId,
          originalChangeObjectId: request.params.id,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          reason: request.body.reason
        });
      });
      reply.status(201).send(rollbackChange);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Decisions (DESIGN §10.4) — `/decisions/{id}` + a list filterable by `subjectId`, exposed
  // standalone in addition to being embedded in `GET /changes/{id}/explain`.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "GET",
    url: "/api/v1/decisions",
    schema: {
      querystring: DecisionListQuerySchema,
      response: { 200: DecisionListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "listDecisions", summary: "List Decision records", tags: ["decisions"] }
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
        return listDecisions(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/decisions/:id",
    schema: {
      params: DecisionIdParamSchema,
      response: { 200: DecisionSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: { operationId: "getDecision", summary: "Get a Decision record by id", tags: ["decisions"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const decision = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return getDecision(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(decision);
    }
  });
}
