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
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { checkAtOrgRootOrScopes } from "../authz/org-root-arm.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { targetObjectIdsOf } from "../coordination/changes-repo.js";
// The change doors here use the same two scoping helpers. See docs/routes.md §224.
import { assertReadableAtSomeChangeTarget, resolveChangeForScope } from "./changes.js";
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
  assertWindowOrdered,
  createFreeze,
  getFreeze,
  liftFreeze,
  listFreezes,
  updateFreezeWindow,
  type FreezeRow
} from "../governance/freezes-repo.js";
import { attachFreezeObject, syncFreezeObject } from "../governance/freeze-object.js";
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";

/** The read scope of one approval request. See docs/routes.md §225. */
async function assertApprovalRequestReadable(
  tx: TenantTx,
  auth: { orgId: string; subjectObjectId: string },
  changeObjectId: string
): Promise<void> {
  const change = await resolveChangeForScope(tx, auth.orgId, changeObjectId);
  await assertReadableAtSomeChangeTarget(tx, {
    orgId: auth.orgId,
    subjectObjectId: auth.subjectObjectId,
    change
  });
}

/** One wire projection of a freeze, shared by five routes. See docs/routes.md §226. */
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
    liftReason: f.liftReason,
    // M25.7 — READ from the row, never inferred from whether a peer exists or from who is asking.
    // A label computed from something other than the thing it names goes silently false.
    objectId: f.objectId
  };
}

/** The publish permission is demanded on every such verb. See docs/routes.md §227. */
async function assertMayEditFederatingFreeze(
  tx: TenantTx,
  auth: { orgId: string; subjectObjectId: string },
  existing: FreezeRow
): Promise<void> {
  if (existing.objectId === null) return;
  await authorize(tx, {
    orgId: auth.orgId,
    subjectObjectId: auth.subjectObjectId,
    permission: "federation:write",
    scopeObjectId: existing.scopeObjectId
  });
}

/** Taking protection away from a freeze you did not declare. See docs/routes.md §228. */
async function assertMayRetractAnothersFreeze(
  tx: TenantTx,
  auth: { orgId: string; subjectObjectId: string },
  freeze: FreezeRow
): Promise<void> {
  if (freeze.createdByActorId === auth.subjectObjectId) return;
  await authorize(tx, {
    orgId: auth.orgId,
    subjectObjectId: auth.subjectObjectId,
    permission: "freeze:override",
    scopeObjectId: freeze.scopeObjectId
  });
}

/** The governance sub-resources that are not typed registries. See docs/routes.md §229. */
export function registerGovernanceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const gateDeps: GateDeps = { sandbox: deps.celSandbox!, host: null };

  // Control bindings + runs (DESIGN §10.2)

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
      response: {
        200: ControlRunListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
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
        // Read at any one of the change's targets, not the root. See docs/routes.md §230.
        const change = await resolveChangeForScope(tx, auth.orgId, request.params.idOrUrn);
        await assertReadableAtSomeChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change
        });
        return listControlRunsForChange(tx, auth.orgId, change.id);
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
          // M22.8 — WHICH CROSSING THIS RUN AUTHORIZED. See docs/routes.md §231.
          gateKind: r.gateKind as "lifecycle_edge" | "wave_boundary",
          gateRef: r.gateRef
        })),
        nextCursor: null
      });
    }
  });

  /** The per-finding decomposition of one scan verdict. See docs/routes.md §232. */
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
        // The run is resolved to its CHANGE before anything is scoped — both so an unknown run id
        // stays a 404 (`loadScanFindings` used to be the thing that produced it, after the
        // authorize) and because the change is where the scope comes from.
        const run = await tx.query.controlRuns.findFirst({
          columns: { changeObjectId: true },
          where: (r, { and, eq }) => and(eq(r.orgId, auth.orgId), eq(r.id, request.params.id))
        });
        if (!run) throw notFound(`control run '${request.params.id}' not found`);
        const change = await resolveChangeForScope(tx, auth.orgId, run.changeObjectId);
        await assertReadableAtSomeChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change
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

  // Approvals (DESIGN §10.2 — N-of-M quorum)

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
        if (!request.query.changeId) {
          throw badRequest(
            "changeId is required (M4: approvals are always listed scoped to a change)"
          );
        }
        // This "list" is always pinned to ONE change. See docs/routes.md §233.
        const change = await resolveChangeForScope(tx, auth.orgId, request.query.changeId);
        await assertReadableAtSomeChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change
        });
        // The one door here that genuinely refused a deleted change. See docs/routes.md §234.
        if (change.deletedAt) throw notFound(`change '${request.query.changeId}' not found`);
        const requests = await listApprovalRequestsForChange(tx, auth.orgId, change.id);
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
        // An approval request belongs to exactly one change, so it inherits that change's read
        // scope. NOT `approvalRequest.scopeObjectId`, which is the POLICY's scope (where the
        // `requireApprovals` effect was authored) and is unrelated to who may read the request.
        const r = await getApprovalRequest(tx, auth.orgId, request.params.id);
        await assertApprovalRequestReadable(tx, auth, r.changeObjectId);
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
        const r = await getApprovalRequest(tx, auth.orgId, request.params.id);
        // Same scope as the request itself — the votes are that request's contents, so a bar that
        // differed here would guard one and publish the other.
        await assertApprovalRequestReadable(tx, auth, r.changeObjectId);
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
        // Authorize at the approval request's own scope, not root. See docs/routes.md §235.
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

  // Freezes (DESIGN §10.3)

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
        // The federating form is a second, higher gate. See docs/routes.md §236.
        if (request.body.federate === true) {
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "federation:write",
            scopeObjectId: scopeObject.id
          });
        }
        // ADR-0031's own door, for the outpost-declared case. It refuses anything but `true`, so
        // this is a no-op on every ordinary create.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId: scopeObject.id,
          requested: request.body.domainLocal
        });
        // A locality declaration with nothing to withhold is a field that lies. Without an object
        // there is no journal entry to filter, so `domainLocal: true` alone would be accepted,
        // recorded nowhere, and read back as absent — refuse it instead of silently dropping it.
        if (request.body.domainLocal === true && request.body.federate !== true) {
          throw badRequest(
            "domainLocal is a property of a freeze's GRAPH OBJECT and requires federate: true — " +
              "a freeze without federate has no object and already never leaves this domain"
          );
        }
        const startsAt = new Date(request.body.startsAt);
        const endsAt = new Date(request.body.endsAt);
        // M25.3: was an inline `endsAt <= startsAt` comparison. See docs/routes.md §237.
        assertWindowOrdered(startsAt, endsAt);
        const created = await createFreeze(tx, {
          orgId: auth.orgId,
          scopeObjectId: scopeObject.id,
          name: request.body.name,
          startsAt,
          endsAt,
          reason: request.body.reason,
          createdByActorId: auth.subjectObjectId,
          // The authoring door for the whole-wave freeze flag. See docs/routes.md §238.
          atomic: request.body.atomic
        });
        // M25.7 — ROW FIRST, THEN OBJECT, both in this transaction. The object's
        // `properties.freezeId` IS the row's primary key: that identity is what makes the rebuild
        // at the far end idempotent on a replay, and what keeps a `freeze_admission` Decision
        // written at an outpost resolvable against `GET /v1/freezes/{id}` here.
        if (request.body.federate !== true) return created;
        return attachFreezeObject(tx, {
          orgId: auth.orgId,
          freeze: created,
          actorObjectId: auth.subjectObjectId,
          requestId: String(request.id),
          domainLocal: request.body.domainLocal
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

  // M25.1 — LIFT AND SHORTEN. See docs/routes.md §239.

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
        // M25.7 — a lift of a FEDERATING freeze retracts a block in another security domain
        // (`syncFreezeObject` below re-snapshots the object). See the helper's docblock.
        await assertMayEditFederatingFreeze(tx, auth, before);
        // M25.9 / owner ruling D1 — retracting a protection SOMEONE ELSE declared costs the
        // Owner-only `freeze:override`. Safe against the unlocked `before`: `created_by_actor_id`
        // is written once at create and never updated, so unlike `endsAt` it cannot move between
        // this read and the locked write below. See the helper's docblock.
        await assertMayRetractAnothersFreeze(tx, auth, before);
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
        // M25.7 — THE LIFT MUST REACH DOWNSTREAM TOO. See docs/routes.md §240.
        await syncFreezeObject(tx, {
          orgId: auth.orgId,
          freeze: row,
          actorObjectId: auth.subjectObjectId,
          requestId: String(request.id)
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
        // M25.7 — the sharper half of the pair: EXTENDING a federating freeze's window pushes a
        // release-stopping block further into another security domain. See the helper's docblock.
        await assertMayEditFederatingFreeze(tx, auth, existing);
        const { before, after, direction } = await updateFreezeWindow(tx, {
          orgId: auth.orgId,
          id: request.params.id,
          endsAt: new Date(request.body.endsAt),
          reason: request.body.reason,
          actorObjectId: auth.subjectObjectId
        });
        // A shortening is a retraction, and the same bar applies. See docs/routes.md §241.
        if (direction === "shortened") await assertMayRetractAnothersFreeze(tx, auth, before);
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
        // M25.7 — the second write verb, the same re-snapshot. A shortening that stopped at this
        // instance would leave a peer enforcing a window its declaring domain has already ended,
        // which is the same one-way door the lift route's note is about, only quieter.
        await syncFreezeObject(tx, {
          orgId: auth.orgId,
          freeze: after,
          actorObjectId: auth.subjectObjectId,
          requestId: String(request.id)
        });
        return after;
      });
      reply.status(200).send(freezeResponse(updated));
    }
  });

  // `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7). See docs/routes.md §242.

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
        const changeObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.changeId);
        const targetObjectIds = targetObjectIdsOf(
          changeObject.properties as Record<string, unknown>
        );
        // The evaluation scope, computed once and used for both. See docs/routes.md §243.
        const evaluationScope = targetObjectIds.length > 0 ? targetObjectIds : [changeObject.id];
        const verdict = await checkAtOrgRootOrScopes(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          orgRootPermission: "object:read",
          scopedPermission: "object:read",
          quantifier: "any",
          scopeObjectIds: evaluationScope
        });
        if (!verdict.ok) {
          throw forbidden(
            `subject '${auth.subjectObjectId}' lacks 'object:read' at the org root and at any ` +
              `object this dry run would evaluate (${evaluationScope.join(", ")})`
          );
        }
        const outcome = await evaluateGovernanceGate(tx, gateDeps.sandbox, null, {
          orgId: auth.orgId,
          changeObjectId: changeObject.id,
          targetObjectIds: evaluationScope,
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
