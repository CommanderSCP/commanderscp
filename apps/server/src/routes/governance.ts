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
  ControlRunFindingsResponseSchema,
  ControlRunIdParamSchema,
  ControlRunListResponseSchema,
  CreateControlBindingRequestSchema,
  CursorPageQuerySchema,
  CreateFreezeRequestSchema,
  FreezeIdParamSchema,
  FreezeListResponseSchema,
  FreezeSchema,
  LiftFreezeRequestSchema,
  UpdateFreezeWindowRequestSchema,
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
import { appendAuditEvent } from "../audit/audit-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { targetObjectIdsOf } from "../coordination/changes-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { evaluateGovernanceGate } from "../governance/gate-orchestrator.js";
import { upsertControlBinding, listControlRunsForChange } from "../governance/controls-repo.js";
import { loadScanFindings } from "../governance/scan-findings-repo.js";
import {
  castApprovalVote,
  getApprovalRequest,
  listApprovalRequestsForChange,
  listVotesForRequest,
  quorumStatus
} from "../governance/approvals-repo.js";
import {
  createFreeze,
  getFreeze,
  liftFreeze,
  listFreezes,
  updateFreezeWindow,
  type FreezeRow
} from "../governance/freezes-repo.js";

/**
 * ONE wire projection of a freeze row, shared by all five freeze routes.
 *
 * It was written out four times before M25.1 (create/list/get, and `atomic` had to be added to
 * each), and this increment adds three more fields and two more routes — seven copies of one
 * mapping, where forgetting the new field in ONE of them makes a lifted freeze look live on
 * exactly one endpoint. That is the "census by property" shape the project instructions name:
 * the property is "a place that turns a FreezeRow into wire JSON", so there is now one.
 */
function freezeResponse(f: FreezeRow) {
  return {
    id: f.id,
    scopeObjectId: f.scopeObjectId,
    name: f.name,
    startsAt: f.startsAt.toISOString(),
    endsAt: f.endsAt.toISOString(),
    reason: f.reason,
    createdByActorId: f.createdByActorId,
    createdAt: f.createdAt.toISOString(),
    atomic: f.atomic,
    // M25.1 — LIFTED IS A FIELD, NOT AN ABSENCE. A lifted freeze is still listed and still
    // gettable by id, because a `gate`/`freeze_admission` Decision cites `freeze.id` forever.
    liftedAt: f.liftedAt?.toISOString() ?? null,
    liftedByActorId: f.liftedByActorId,
    liftReason: f.liftReason
  };
}

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
      response: {
        200: ControlBindingSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putControlBinding",
        summary:
          "Bind a Control to a ControlPlugin instance (DESIGN §10.2 — swapping the impl changes only this)",
        tags: ["controls"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const control = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        if (control.typeId !== "control")
          throw notFound(`'${request.params.idOrUrn}' is not a control object`);
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
          createdAt: r.createdAt.toISOString(),
          // M22.8 — WHICH CROSSING THIS RUN AUTHORIZED. Stored since M4, never projected. It became
          // load-bearing at M22.0a, which keyed the cache on gate identity and thereby made several
          // runs per change the NORM rather than an anomaly; until now an operator reading this list
          // saw N rows for one control with no way to tell which one let production through.
          //
          // Sent unconditionally. The columns are NOT NULL, so the wire fields' optionality is for
          // older generated clients only (see `ControlRunSchema`), never a licence to omit them —
          // and a `?? undefined` here would silently turn a schema-drift bug into a missing field.
          gateKind: r.gateKind as "lifecycle_edge" | "wave_boundary",
          gateRef: r.gateRef
        })),
        nextCursor: null
      });
    }
  });

  /**
   * M22.9 (ADR-0033 §7) — the per-finding decomposition of ONE scan verdict.
   *
   * WHY A SEPARATE PATH RATHER THAN `?includeFindings=true` ON THE LIST ABOVE. A change legitimately
   * carries several runs since M22.0a keyed the control cache on gate identity, and each run persists
   * up to `SCAN_FINDINGS_PERSIST_CAP` (2000) findings; folding them into the list response would
   * either be unbounded or need a per-item cap that no cursor can page past. One run per request
   * pages properly and leaves the list response BYTE-IDENTICAL, so the OpenAPI diff is a new
   * operation and nothing else — this repo has already paid once for making an existing required
   * response field optional (oasdiff ERR).
   *
   * `object:read` at ORG scope, matching the list endpoint immediately above. These rows are the
   * decomposition of evidence that endpoint already returns in aggregate (`evidence.severityCounts`,
   * `evidence.exclusions`), so a stricter permission here would guard the detail while the summary
   * stayed open — a bar that reads as protection and is not one.
   */
  typed.route({
    method: "GET",
    url: "/api/v1/control-runs/:id/findings",
    schema: {
      params: ControlRunIdParamSchema,
      querystring: CursorPageQuerySchema,
      response: {
        200: ControlRunFindingsResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listControlRunFindings",
        summary:
          "The persisted findings of one scan control run, with the finding-set marker (ADR-0033 §7)",
        tags: ["controls"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const loaded = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const page = await loadScanFindings(tx, auth.orgId, request.params.id, request.query);
        if (!page) throw notFound(`control run '${request.params.id}' not found`);
        return page;
      });
      reply.status(200).send({
        // ABSENT becomes an explicit `null`, never an omitted key: every marker state but `full`
        // REFUSES every exclusion for this scan, and a consumer that cannot see the refusal would
        // read a partial set as the whole one (`ControlRunFindingsResponseSchema`).
        findingsRecord: loaded.record ?? null,
        items: loaded.findings,
        nextCursor: loaded.nextCursor
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
      openapi: {
        operationId: "listApprovals",
        summary: "List approval requests, optionally filtered by change",
        tags: ["approvals"]
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
        if (!request.query.changeId) {
          throw badRequest(
            "changeId is required (M4: approvals are always listed scoped to a change)"
          );
        }
        const changeObject = await getObjectByIdOrUrnAnyType(
          tx,
          auth.orgId,
          request.query.changeId
        );
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
      response: {
        200: ApprovalRequestSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getApproval",
        summary: "Get an approval request by id",
        tags: ["approvals"]
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
      openapi: {
        operationId: "listApprovalVotes",
        summary: "List votes cast on an approval request",
        tags: ["approvals"]
      }
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
        summary:
          "Cast a vote on an approval request (DESIGN §10.2 — N-of-M quorum, one vote per subject, always self-attested)",
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
      openapi: {
        operationId: "createFreeze",
        summary: "Declare a freeze window over a scope (DESIGN §10.3)",
        tags: ["freezes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const freeze = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const scopeObject = await getObjectByIdOrUrnAnyType(
          tx,
          auth.orgId,
          request.body.scopeObjectId
        );
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
          createdByActorId: auth.subjectObjectId,
          // M25.2 / owner decision D5 — THE AUTHORING DOOR for `freezes.atomic`. Without this line
          // the column exists, the engine reads it, and no operator can ever set it: every freeze
          // on the estate would be per-target with no way to say otherwise, which is the
          // "component built, never installed" shape applied to the one mitigation D5's loosening
          // was approved on. Absent => `false` in `createFreeze`, so an old client is unchanged.
          atomic: request.body.atomic
        });
      });
      reply.status(201).send(freezeResponse(freeze));
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
      reply.status(200).send({ items: items.map(freezeResponse), nextCursor: null });
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
      reply.status(200).send(freezeResponse(freeze));
    }
  });

  // -----------------------------------------------------------------------------------------
  // M25.1 — LIFT AND SHORTEN. The exits `/freezes` shipped without.
  //
  // WHY THIS EXISTS. `/api/v1/freezes` was CREATE / LIST / GET, so a freeze could be declared and
  // never retracted or shortened. That was survivable while a freeze parked a WHOLE wave — the
  // operator waited for `endsAt` and the release resumed on its own. M25.2's per-target admission
  // made it unsurvivable: a far-future `endsAt` now holds a SUBSET of a wave's targets while the
  // siblings have already shipped, so a mistyped year leaves a fleet split across two versions with
  // no API exit at all. The only escapes were `scp change cancel` / `scp change rollback`, both of
  // which throw the RELEASE away rather than lifting the FREEZE.
  //
  // ===========================================================================================
  // AUTHORIZATION: `freeze:write` AT THE FREEZE'S OWN `scopeObjectId`
  // ===========================================================================================
  // SCOPE FIRST, because it is the part that is easy to get silently wrong. `hasPermission`
  // expands the checked scope UPWARD to its containment ancestors (`authz/resolve.ts`'s
  // `scopeExpandCte`), so a binding at the org root satisfies a check at a service, and a binding
  // at a service does NOT satisfy a check at the org root. Checking at the FREEZE'S OWN scope
  // therefore gives exactly the property that matters: an Administrator scoped to one service can
  // lift that service's freeze and CANNOT lift the org-root freeze that covers everyone. This
  // mirrors `checkFreeze`, which authorizes `freeze:override` per freeze at that freeze's own scope
  // — checking only `active[0]`, at one scope, was a shipped bug (CRITICAL #2). Checking at
  // `auth.orgId` here would have been the same bug wearing different clothes.
  //
  // WHY `freeze:write` AND NOT `freeze:override`. The asymmetry is real and worth naming: an
  // override is per-change (it lets ONE change past and leaves the freeze standing for everyone
  // else) and is Owner-only; a lift is per-freeze (it retracts the protection for EVERYONE covered)
  // and this route asks only for Administrator-tier `freeze:write`. So the wider-reaching verb
  // takes the narrower permission. That is deliberate, on two grounds:
  //
  //   * A SURFACE WITH AN ENTRANCE AND NO EXIT IS THE DEFECT M25.1 EXISTS TO REMOVE. `freeze:write`
  //     is what declares a freeze. Requiring `freeze:override` to lift one would mean an
  //     Administrator can create a governance object they cannot retract, and would put every
  //     mistyped `endsAt` on the estate in front of the Owner — reproducing, one level up, exactly
  //     the "no way out" this increment is closing.
  //   * REACH AND AUTHORITY ALREADY MATCH, VIA SCOPE. "Everyone covered by the freeze" is bounded
  //     by the freeze's scope, and the permission is demanded at that same scope. Lifting an
  //     org-root freeze needs `freeze:write` AT THE ORG ROOT — Administrator or Owner of the whole
  //     org. There is no scope at which this route grants power over a broader freeze than the
  //     authority being checked, which is the property `freeze:override`'s per-freeze loop
  //     establishes for overrides and the one that actually constrains blast radius here.
  //
  // An `authorize` failure throws a raw 403 rather than returning a `blocked` verdict, and that
  // differs from `checkFreeze` deliberately: `checkFreeze` runs inside a change's gate evaluation,
  // where a rejected override must become a Decision so the change carries a resolvable
  // `decision_id`. This is a direct authoring call with no change in hand and nothing to explain
  // later — a 403 with no side effects is the honest answer, and matches `POST /freezes`.
  //
  // ===========================================================================================
  // AUDIT + DECISION ON BOTH VERBS
  // ===========================================================================================
  // Each route writes ONE Decision (`kind: "freeze_window"`, `subjectId` = the freeze id) and ONE
  // high-severity audit event carrying that Decision's id — the shape `freeze.override` already
  // sets in `coordination/transition.ts`, and the same authoring-Decision precedent
  // `graph/components-repo.ts` and `coordination/campaign-repo.ts` use for non-change subjects.
  // The audit event's `reason` is the operator's own words, and the Decision's `inputContext`
  // carries the machine-readable before/after — the audit table has no payload column, so the
  // Decision is where "from what, to what, which direction" survives.
  //
  // NO `insertDecisionIfChanged` HERE, and no dedup concern: these are one-per-API-call authoring
  // records, not a predicate re-evaluated every tick. ADR-0024's write amplification came from the
  // reconcile loop restating an unchanged verdict; a human pressing a button is not that.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "DELETE",
    url: "/api/v1/freezes/:id",
    schema: {
      params: FreezeIdParamSchema,
      // A BODY ON A DELETE — the shipped precedent is `DELETE /change-sources/:sourceKind/mappings`
      // (`DeleteSourceMappingRequestSchema`). The reason is mandatory and a free-text governance
      // justification does not belong in a query string.
      body: LiftFreezeRequestSchema,
      response: {
        200: FreezeSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "liftFreeze",
        summary:
          "Lift (retract) a freeze — it stops being in force immediately, whatever endsAt says",
        tags: ["freezes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const lifted = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Loaded BEFORE the authorization check because the freeze's own scope IS the scope being
        // checked — an unknown id 404s here, before any write and before any 403 that would
        // otherwise have to be decided against the org root.
        const before = await getFreeze(tx, auth.orgId, request.params.id);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "freeze:write",
          scopeObjectId: before.scopeObjectId
        });
        const row = await liftFreeze(tx, {
          orgId: auth.orgId,
          id: request.params.id,
          reason: request.body.reason,
          actorObjectId: auth.subjectObjectId
        });
        const decision = await insertDecision(tx, {
          kind: "freeze_window",
          orgId: auth.orgId,
          subjectId: row.id,
          verdict: "allow",
          inputContext: {
            action: "lift",
            freeze: {
              id: row.id,
              scopeObjectId: row.scopeObjectId,
              name: row.name,
              startsAt: row.startsAt.toISOString(),
              endsAt: row.endsAt.toISOString(),
              atomic: row.atomic
            },
            actorId: auth.subjectObjectId,
            reason: request.body.reason
          },
          reasonTree: {
            summary: `freeze '${row.name ?? row.id}' at ${row.scopeObjectId} lifted — it no longer holds anything, and its declared endsAt of ${row.endsAt.toISOString()} is now moot`,
            loosening: true
          }
        });
        // Same shape as `freeze.override` (transition.ts): high-severity, mandatory reason,
        // pointing at the Decision that carries the structured before/after.
        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "freeze.lift",
          subjectId: row.id,
          beforeHash: null,
          afterHash: null,
          reason: request.body.reason,
          decisionId: decision.id,
          requestId: request.id
        });
        return row;
      });
      reply.status(200).send(freezeResponse(lifted));
    }
  });

  typed.route({
    method: "PATCH",
    url: "/api/v1/freezes/:id",
    schema: {
      params: FreezeIdParamSchema,
      body: UpdateFreezeWindowRequestSchema,
      response: {
        200: FreezeSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "updateFreezeWindow",
        summary: "Move a freeze's endsAt — shortening is a loosening, extending is a tightening",
        tags: ["freezes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const updated = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const existing = await getFreeze(tx, auth.orgId, request.params.id);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "freeze:write",
          scopeObjectId: existing.scopeObjectId
        });
        const { before, after, direction } = await updateFreezeWindow(tx, {
          orgId: auth.orgId,
          id: request.params.id,
          endsAt: new Date(request.body.endsAt),
          reason: request.body.reason,
          actorObjectId: auth.subjectObjectId
        });
        const decision = await insertDecision(tx, {
          kind: "freeze_window",
          orgId: auth.orgId,
          subjectId: after.id,
          verdict: "allow",
          inputContext: {
            action: direction,
            freeze: {
              id: after.id,
              scopeObjectId: after.scopeObjectId,
              name: after.name,
              startsAt: after.startsAt.toISOString(),
              atomic: after.atomic
            },
            // THE OLD AND THE NEW VALUE, both, and the direction above. `audit_events` has no
            // payload column, so this is the only place the previous `endsAt` survives — without
            // it "the freeze ends at T" is unfalsifiable after the fact and nobody can tell a
            // three-week window that was cut to a day from one that was always a day.
            endsAt: { from: before.endsAt.toISOString(), to: after.endsAt.toISOString() },
            actorId: auth.subjectObjectId,
            reason: request.body.reason
          },
          reasonTree: {
            summary: `freeze '${after.name ?? after.id}' at ${after.scopeObjectId} ${direction}: endsAt ${before.endsAt.toISOString()} -> ${after.endsAt.toISOString()}`,
            // Recorded as a FLAG rather than left for a reader to infer from two timestamps: a
            // shortening is a governance LOOSENING and an extension is a TIGHTENING, and which one
            // happened is the question this record is read with.
            loosening: direction === "shortened"
          }
        });
        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: `freeze.window.${direction}`,
          subjectId: after.id,
          beforeHash: null,
          afterHash: null,
          reason: request.body.reason,
          decisionId: decision.id,
          requestId: request.id
        });
        return after;
      });
      reply.status(200).send(freezeResponse(updated));
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
      response: {
        200: PolicyEvaluateResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "policyEvaluate",
        summary:
          "Dry-run governance evaluation for a change — verdict + reason tree, no transition attempted",
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
        const targetObjectIds = targetObjectIdsOf(
          changeObject.properties as Record<string, unknown>
        );
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
