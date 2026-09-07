import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApproveScanOverrideGrantRequestSchema,
  CreateScanOverrideGrantRequestSchema,
  DecideScanOverrideGrantRequestSchema,
  ProblemSchema,
  SCAN_OVERRIDE_GRANT_TYPE_ID,
  ScanOverrideGrantIdParamSchema,
  ScanOverrideGrantListQuerySchema,
  ScanOverrideGrantListResponseSchema,
  ScanOverrideGrantSchema,
  type ScanOverrideGrantStatus
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { createObject, getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import {
  findScanOverrideGrant,
  listScanOverrideGrantsForComponent,
  newScanOverrideGrantProperties,
  projectScanOverrideGrant
} from "../governance/scan-override-grants.js";
import {
  assertNoInstanceFloorOutranksTier,
  assertOverrideTierStanding
} from "../governance/scan-override-standing.js";

/** The override request's API surface. See docs/routes.md §401. */
export function registerScanOverrideGrantRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const base = "/api/v1/scan-override-grants";

  typed.route({
    method: "POST",
    url: base,
    schema: {
      body: CreateScanOverrideGrantRequestSchema,
      response: {
        201: ScanOverrideGrantSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createScanOverrideGrant",
        summary: "Raise a scan override request for one (component x finding) (ADR-0033 §6a)",
        tags: ["scan-override-grants"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const grant = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const component = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.componentId);
        if (component.typeId !== "component") {
          throw badRequest(
            `componentId must reference a 'component' object — '${request.body.componentId}' is a ` +
              `'${component.typeId}'. A grant's unit is (component x finding) (ADR-0033 D4).`
          );
        }
        // The tier object is RESOLVED here so a request cannot name something that does not exist —
        // an unresolvable tier would produce a request nobody could ever approve, which reads as
        // "denied by nobody" rather than as the authoring error it is.
        const tierObject = await getObjectByIdOrUrnAnyType(
          tx,
          auth.orgId,
          request.body.tierObjectId
        );
        // ...AND IT MUST BE AN ANCESTOR. See docs/routes.md §402.
        await assertOverrideTierStanding(tx, {
          orgId: auth.orgId,
          componentObjectId: component.id,
          tierObjectId: tierObject.id
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: component.id
        });
        const created = await createObject(tx, {
          orgId: auth.orgId,
          typeId: SCAN_OVERRIDE_GRANT_TYPE_ID,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          name: `${component.name}/${request.body.vulnerabilityId}`,
          properties: newScanOverrideGrantProperties({
            componentId: component.id,
            vulnerabilityId: request.body.vulnerabilityId,
            pkgName: request.body.pkgName,
            tierObjectId: tierObject.id,
            reason: request.body.reason,
            requestedByActorId: auth.subjectObjectId
          })
        });
        // A raised request grants NOTHING, and it still gets a Decision and an audit event. The act
        // of asking to tolerate a vulnerability is itself part of the record an auditor reads, and a
        // request that was raised and never approved is evidence about the org, not noise.
        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: "scan_override_grant",
          subjectId: created.id,
          verdict: "requested",
          inputContext: {
            componentId: component.id,
            vulnerabilityId: request.body.vulnerabilityId,
            ...(request.body.pkgName ? { pkgName: request.body.pkgName } : {}),
            tierObjectId: tierObject.id,
            requestedByActorId: auth.subjectObjectId
          },
          reasonTree: {
            summary: `scan override requested for '${request.body.vulnerabilityId}' on component '${component.name}'`,
            reason: request.body.reason
          }
        });
        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "scan_override.request",
          subjectId: created.id,
          beforeHash: null,
          afterHash: null,
          reason: request.body.reason,
          decisionId: decision.id,
          requestId: request.id
        });
        const row = await findScanOverrideGrant(tx, auth.orgId, created.id);
        if (!row) throw notFound(`scan override grant '${created.id}' not found after create`);
        return projectScanOverrideGrant(row);
      });
      reply.status(201).send(grant);
    }
  });

  typed.route({
    method: "GET",
    url: base,
    schema: {
      querystring: ScanOverrideGrantListQuerySchema,
      response: {
        200: ScanOverrideGrantListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listScanOverrideGrants",
        summary: "List scan override grants for a component (including expired and denied)",
        tags: ["scan-override-grants"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const componentIdOrUrn = request.query.component;
      const items = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const component = await getObjectByIdOrUrnAnyType(tx, auth.orgId, componentIdOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: component.id
        });
        const rows = await listScanOverrideGrantsForComponent(tx, auth.orgId, component.id);
        return rows.map(projectScanOverrideGrant);
      });
      reply.status(200).send({ items });
    }
  });

  // APPROVE / DENY / REVOKE — one handler shape, three verdicts.

  /** The one act. Extracted so approve, deny and revoke cannot drift on the two things that must
   *  never differ between them: the `policy:write`-at-the-tier check, and the Decision + audit event
   *  written in the same transaction. */
  const decide = async (
    request: FastifyRequest,
    input: {
      id: string;
      to: ScanOverrideGrantStatus;
      reason: string;
      expiresAt?: string | undefined;
      action: string;
    }
  ) => {
    const auth = await requireAuth(deps, request);
    return withTenantTx(deps.db, auth.orgId, async (tx) => {
      const row = await findScanOverrideGrant(tx, auth.orgId, input.id);
      if (!row) throw notFound(`scan override grant '${input.id}' not found`);
      const current = projectScanOverrideGrant(row);
      // Approver standing is the tier that set the rule. See docs/routes.md §403.
      const derivedTier = await assertOverrideTierStanding(tx, {
        orgId: auth.orgId,
        componentObjectId: current.componentId,
        tierObjectId: current.tierObjectId
      });
      // `scopeExpandCte` walks upward from this object, so a `policy:write` binding here or above
      // passes and one below never does.
      await authorize(tx, {
        orgId: auth.orgId,
        subjectObjectId: auth.subjectObjectId,
        permission: "policy:write",
        scopeObjectId: current.tierObjectId
      });
      // `scan:override` — ADDED, NEVER SUBSTITUTED. See docs/routes.md §404.
      await authorize(tx, {
        orgId: auth.orgId,
        subjectObjectId: auth.subjectObjectId,
        permission: "scan:override",
        scopeObjectId: current.tierObjectId
      });
      // APPROVE ONLY. An instance floor above this tier makes the grant unwaivable here, so signing
      // it would record an accepted risk that tolerates nothing. Deny and revoke are never refused:
      // taking a waiver back must not be harder than making one.
      if (input.to === "approved") {
        await assertNoInstanceFloorOutranksTier(tx, derivedTier);
      }
      if (input.to === "approved" && current.status !== "requested") {
        throw badRequest(
          `only a 'requested' grant can be approved — '${input.id}' is '${current.status}'`
        );
      }
      // SEPARATION OF DUTIES. See docs/routes.md §405.
      if (input.to === "approved" && current.requestedByActorId === auth.subjectObjectId) {
        throw badRequest(
          `a scan override grant cannot be approved by the subject who raised it — '${input.id}' ` +
            `was requested by this actor. An accepted risk needs a second principal holding ` +
            `'policy:write' at '${current.tierObjectId}' to sign it`
        );
      }
      if (input.to === "revoked" && current.status !== "approved") {
        throw badRequest(
          `only an 'approved' grant can be revoked — '${input.id}' is '${current.status}'`
        );
      }
      // DENY IS A DECISION ON A REQUEST, not a second way to un-approve one. Without this bar,
      // `approved -> denied` is reachable and takes a live waiver away through a verb whose whole
      // state machine — and every doc above — describes it as answering a `requested` grant, while
      // skipping the ONE precondition `revoked` carries. Un-approving has exactly one path.
      if (input.to === "denied" && current.status !== "requested") {
        throw badRequest(
          `only a 'requested' grant can be denied — '${input.id}' is '${current.status}'` +
            (current.status === "approved" ? "; revoke it instead" : "")
        );
      }
      const decidedAt = new Date().toISOString();
      const nextProperties: Record<string, unknown> = {
        ...row.properties,
        status: input.to,
        decidedByActorId: auth.subjectObjectId,
        decidedAt,
        decisionReason: input.reason,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
      };
      const updated = await updateObject(tx, {
        orgId: auth.orgId,
        typeId: SCAN_OVERRIDE_GRANT_TYPE_ID,
        actorObjectId: auth.subjectObjectId,
        requestId: request.id,
        idOrUrn: input.id,
        properties: nextProperties,
        // THE ONE CALLER THAT MAY WRITE A DECISION. See docs/routes.md §406.
        scanOverrideGrantDecision: true
      });
      const decision = await insertDecision(tx, {
        orgId: auth.orgId,
        kind: "scan_override_grant",
        subjectId: updated.id,
        verdict: input.to,
        inputContext: {
          componentId: current.componentId,
          vulnerabilityId: current.vulnerabilityId,
          ...(current.pkgName ? { pkgName: current.pkgName } : {}),
          tierObjectId: current.tierObjectId,
          decidedByActorId: auth.subjectObjectId,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
        },
        reasonTree: {
          summary: `scan override '${input.to}' for '${current.vulnerabilityId}' under authority of '${current.tierObjectId}'`,
          reason: input.reason
        }
      });
      // HIGH SEVERITY, MANDATORY REASON, SAME TRANSACTION — the `freeze.override` shape. An
      // approval that happened without its own permanent hash-chained record is the failure mode
      // this copies that shape to avoid.
      await appendAuditEvent(tx, {
        orgId: auth.orgId,
        actorId: auth.subjectObjectId,
        action: input.action,
        subjectId: updated.id,
        beforeHash: null,
        afterHash: null,
        reason: input.reason,
        decisionId: decision.id,
        requestId: request.id
      });
      const after = await findScanOverrideGrant(tx, auth.orgId, updated.id);
      if (!after) throw notFound(`scan override grant '${updated.id}' not found after update`);
      return projectScanOverrideGrant(after);
    });
  };

  typed.route({
    method: "POST",
    url: `${base}/:id/approve`,
    schema: {
      params: ScanOverrideGrantIdParamSchema,
      body: ApproveScanOverrideGrantRequestSchema,
      response: {
        200: ScanOverrideGrantSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "approveScanOverrideGrant",
        summary: "Approve a scan override request at the tier that set the rule (ADR-0033 D3/D4)",
        tags: ["scan-override-grants"]
      }
    },
    handler: async (request, reply) => {
      const expiresAt = new Date(request.body.expiresAt);
      // AN EXPIRY IN THE PAST IS REFUSED AT AUTHORING TIME. The resolver would already ignore such a
      // grant (its window is `expiresAt > now()`), so this changes no verdict — it exists so an
      // approver learns immediately rather than believing they granted something.
      if (expiresAt.getTime() <= Date.now()) {
        throw badRequest(
          "expiresAt must be in the future (ADR-0033 D4 — a standing grant with an expiry)"
        );
      }
      const grant = await decide(request, {
        id: request.params.id,
        to: "approved",
        reason: request.body.reason,
        expiresAt: expiresAt.toISOString(),
        action: "scan_override.approve"
      });
      reply.status(200).send(grant);
    }
  });

  typed.route({
    method: "POST",
    url: `${base}/:id/deny`,
    schema: {
      params: ScanOverrideGrantIdParamSchema,
      body: DecideScanOverrideGrantRequestSchema,
      response: {
        200: ScanOverrideGrantSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "denyScanOverrideGrant",
        summary: "Deny a scan override request",
        tags: ["scan-override-grants"]
      }
    },
    handler: async (request, reply) => {
      const grant = await decide(request, {
        id: request.params.id,
        to: "denied",
        reason: request.body.reason,
        action: "scan_override.deny"
      });
      reply.status(200).send(grant);
    }
  });

  typed.route({
    method: "POST",
    url: `${base}/:id/revoke`,
    schema: {
      params: ScanOverrideGrantIdParamSchema,
      body: DecideScanOverrideGrantRequestSchema,
      response: {
        200: ScanOverrideGrantSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "revokeScanOverrideGrant",
        summary: "Revoke an approved scan override before its expiry",
        tags: ["scan-override-grants"]
      }
    },
    handler: async (request, reply) => {
      const grant = await decide(request, {
        id: request.params.id,
        to: "revoked",
        reason: request.body.reason,
        action: "scan_override.revoke"
      });
      reply.status(200).send(grant);
    }
  });
}
