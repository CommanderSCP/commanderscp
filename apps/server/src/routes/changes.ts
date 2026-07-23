import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ChangeExplainResponseSchema,
  ChangeIdParamSchema,
  ChangeListQuerySchema,
  ChangeListResponseSchema,
  ChangeSchema,
  ChangeTransitionRequestSchema,
  type Change,
  type ChangeWaitStatus,
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
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { assertCoordinationTargetsWithinAuthority } from "../coordination/campaign-scope-authz.js";
import { getChange, listChanges, proposeChange, requiresOf } from "../coordination/changes-repo.js";
import { requirementStatuses, listProvidedKeysAtScope } from "../coordination/coupling.js";
import { transitionChange } from "../coordination/transition.js";
import type { GateDeps } from "../coordination/gates.js";
import { triggerRollback } from "../coordination/rollback.js";
import { getLatestPlanForChange } from "../coordination/plan-service.js";
import { getDecision, listDecisions, listDecisionsForSubject } from "../coordination/decisions-repo.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
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
/**
 * M12 P4B Phase 4 — the coupled-pipeline wait status for `explain`: for a change that declared
 * `requires`, each prerequisite's live satisfaction (and the object name it is `at`, for a readable
 * "Waiting on …" surface). Null when the change coupled nothing, so unchanged for every pre-P4B
 * change. Read-only: it re-evaluates the SAME predicate reconcile uses, it does not transition.
 *
 * "Did you mean?" (coupled-pipelines.md §3.7): for each UNSATISFIED requirement, also looks up
 * `listProvidedKeysAtScope` — the `provides` keys ANY change has ever declared at that `at`
 * object — so a typo'd key reads as "outstanding; keys provided here: feature-b, feature-c"
 * instead of a bare blank. Only queried for unsatisfied requirements (a satisfied one has nothing
 * to diagnose), and only ever off the read-only `explain`/`wait-status` path — never reconcile's
 * hot loop.
 */
async function buildWaitStatus(
  tx: TenantTx,
  orgId: string,
  change: Change
): Promise<ChangeWaitStatus | null> {
  const { requirements, malformed } = requiresOf(change.properties);
  if (requirements.length === 0 && malformed.length === 0) return null;
  const statuses = await requirementStatuses(tx, orgId, change.id, requirements);
  const atIds = [...new Set(statuses.map((s) => s.at))];
  const atObjects =
    atIds.length === 0
      ? []
      : await tx.query.objects.findMany({
          where: (o, { and, eq, inArray }) => and(eq(o.orgId, orgId), inArray(o.id, atIds))
        });
  const nameById = new Map(atObjects.map((o) => [o.id, o.name]));
  const requirementViews = await Promise.all(
    statuses.map(async (s) => {
      const didYouMean = s.satisfied ? [] : await listProvidedKeysAtScope(tx, orgId, s.at);
      return {
        key: s.key,
        at: s.at,
        atName: nameById.get(s.at) ?? null,
        satisfied: s.satisfied,
        satisfiedByChangeId: s.satisfiedByChangeObjectId,
        ...(didYouMean.length > 0 ? { didYouMean } : {})
      };
    })
  );
  return {
    waiting: change.state === "waiting",
    requirements: requirementViews,
    // Fail-closed diagnostics (coupled-pipelines.md §6#14): stored `requires` entries that don't
    // parse as `{key, at}` make the change UNSATISFIABLE (it parks in `waiting`), so the 2am
    // operator must be able to SEE them — surfaced verbatim, only when any exist.
    ...(malformed.length > 0 ? { malformed } : {})
  };
}

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
        // DESIGN §10.3: "a change flagged emergency by a PERMITTED actor" — `object:write` alone
        // is not enough to set `emergency: true`, since that flag is what lets
        // `governance/gate-orchestrator.ts` swap in the (possibly gate-bypassing) emergency
        // policy set instead of the normal required policies. Without this check, any subject who
        // can propose a change at all could self-grant an emergency bypass — the exact
        // "emergency-bypass authz" surface this milestone's security review targets. Only checked
        // when the flag is actually being turned on; a normal (non-emergency) propose is unaffected.
        if (body.emergency) {
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "change:emergency",
            scopeObjectId: body.domainId ?? auth.orgId
          });
        }
        // P4B Phase 2: bind the change's DECLARED targets to the actor's own authority. The
        // `object:write`-at-domain check above is NOT enough — a proposer could otherwise target an
        // object in another domain they don't control and inject a release (or, post-P4B, a
        // `requires`/`provides` coupling) against it. Mirrors campaigns exactly
        // (`campaign-scope-authz.ts`). Deliberately HERE at the route, not inside `proposeChange`:
        // the engine's own callers (webhook correlation, rollback, campaign fan-out, federation
        // import) run as trusted system/federation actors that must not face a human-authority
        // check — the route is the only untrusted propose path.
        await assertCoordinationTargetsWithinAuthority(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          targets: body.targets
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
          targets: body.targets,
          type: body.type,
          provides: body.provides,
          requires: body.requires
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
        const [plan, decisions, controlRuns, waitStatus] = await Promise.all([
          getLatestPlanForChange(tx, auth.orgId, request.params.id),
          listDecisionsForSubject(tx, auth.orgId, request.params.id),
          listControlRunsForChange(tx, auth.orgId, request.params.id),
          buildWaitStatus(tx, auth.orgId, change)
        ]);
        return {
          change,
          plan,
          decisions,
          controlRuns: controlRuns.map((r) => ({
            id: r.id,
            controlObjectId: r.controlObjectId,
            changeObjectId: r.changeObjectId,
            status: r.status,
            evidence: r.evidence,
            detail: r.detail,
            decisionId: r.decisionId,
            createdAt: r.createdAt.toISOString()
          })),
          waitStatus
        };
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
          reason: request.body.reason,
          trigger: "manual"
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
