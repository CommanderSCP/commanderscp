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

/**
 * M22.6 (ADR-0033 §6a; owner decisions D3, D4) — THE OVERRIDE REQUEST'S API SURFACE.
 *
 * ===========================================================================================
 * THE SHAPE THIS COPIES, AND THE ONE IT REFUSES TO
 * ===========================================================================================
 * `freeze.override` (DESIGN §10.3, `coordination/transition.ts`) is the model: a MANDATORY non-empty
 * reason, and a HIGH-SEVERITY hash-chained audit event written in the SAME transaction as the act,
 * linked to a Decision. Every route below does both.
 *
 * The APPROVALS path is explicitly NOT the model, and ADR-0033 names this as a gap that must not be
 * inherited: casting an approval vote writes a row and NO audit event. A surface whose entire purpose
 * is to tolerate a known vulnerability cannot ship with that hole — an approved override is exactly
 * the act an auditor comes looking for, and "it is in the votes table" is not a hash-chained record.
 *
 * ===========================================================================================
 * TWO PERMISSIONS, DELIBERATELY DIFFERENT (D3)
 * ===========================================================================================
 *   RAISE    — `object:write` at the COMPONENT. The component owner already holds this; raising a
 *              request grants nothing (the grant is inert until approved), so gating it harder would
 *              only mean the people who know about the finding cannot report it.
 *   APPROVE  — `policy:write` at the OBJECT NAMING THE TIER THAT SET THE RULE. `authz/resolve.ts`'s
 *              `scopeExpandCte` walks UPWARD from the named object, so a binding at that tier or
 *              above satisfies the check and a binding BELOW it never does.
 *   DENY /
 *   REVOKE   — the same `policy:write` at the same object. The authority to grant and the authority
 *              to take back must be the same one, or a waiver becomes harder to remove than to make.
 *
 * THE PERMISSION CHECK IS NOT THE WHOLE OF D3, AND THE FIRST VERSION OF THIS FILE ASSUMED IT WAS.
 * `scopeExpandCte` expanding upward cuts both ways: naming a LOWER object strictly WIDENS the set of
 * principals whose bindings satisfy the approve check. `tierObjectId` came from the REQUESTER and was
 * compared to nothing, so the party seeking a waiver picked the authority that would grant it — name
 * your own service, approve at your own service, and a platform-set `maxCritical: 0` is waived. The
 * tier is now DERIVED at three points, none of which trusts the claim:
 *   - RAISE   — `assertOverrideTierStanding`: the named object must be on the component's own
 *               containment chain.
 *   - APPROVE — the same check re-derived (a grant can reach the row through IaC or federation
 *               without ever having passed the raise route), plus a refusal while an INSTANCE floor
 *               outranks the derived tier, plus SEPARATION OF DUTIES: the subject who raised the
 *               request may not be the one who approves it (approve only — deny and revoke stay
 *               open, because withdrawing a waiver must never be harder than granting one).
 *   - THE GATE — `applyOverrideAuthorityBar`, the decisive one: the grant's tier is re-derived from
 *               the target's chain and compared against the most senior tier that contributed to the
 *               effective ceiling (`EffectiveScanThreshold.contributors`).
 *
 * WHAT DOES *NOT* DECIDE WHO MAY RAISE: `owners-of`. It walks `domain_id` ONLY and never joins
 * `contains`, so it does not see a component's service or assembly — using it here would silently
 * exclude every component whose owner is attached one rung up, which is the common shape.
 *
 * ===========================================================================================
 * WHY THESE ROUTES EXIST AT ALL RATHER THAN `POST /objects/scan_override_grant`
 * ===========================================================================================
 * `scan_override_grant` is in `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, so the generic object endpoint
 * refuses it outright and the IaC plan/apply path demands `policy:write`.
 *
 * THAT MAPPING WAS NEVER THE DEFENCE, and this docblock used to claim it was ("without that, a
 * holder of plain `object:write` could write `{status: "approved", …}` directly"). `policy:write` at
 * a containment domain is an ordinary scoped policy-author binding, and the IaC plan/apply path
 * demands exactly that at the target domain — so the manifest went through, minting an approved grant
 * with no tier check, no Decision, no audit event and no future-expiry validation. The real defence
 * is `governance/scan-override-grant-authoring-guard.ts`, installed at the `graph/objects-repo.ts`
 * choke point every local write door funnels through: the five DECISION properties are writable only
 * by `decide` below, which sets the internal flag that lets them past. Raising a `requested` grant
 * stays open through every door, because it authorizes nothing.
 */
export function registerScanOverrideGrantRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const base = "/api/v1/scan-override-grants";

  // -----------------------------------------------------------------------------------------
  // RAISE
  // -----------------------------------------------------------------------------------------
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
        // ...AND IT MUST BE AN ANCESTOR. Resolving proves the row exists and nothing else. Because
        // `scopeExpandCte` expands UPWARD, a requester naming any object they happen to hold
        // `policy:write` at would be choosing the authority that approves their own waiver — D3's
        // escalation guard, self-selected. The named object must be on THIS component's containment
        // chain, and the gate re-derives its tier from that same chain (D3).
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

  // -----------------------------------------------------------------------------------------
  // READ
  // -----------------------------------------------------------------------------------------
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

  // -----------------------------------------------------------------------------------------
  // APPROVE / DENY / REVOKE — one handler shape, three verdicts.
  // -----------------------------------------------------------------------------------------

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
      // D3 — APPROVER STANDING IS THE TIER THAT SET THE RULE, and the tier is DERIVED here rather
      // than taken from the stored `tierObjectId` on trust. The chain check is re-run at decide time
      // (not merely inherited from create) because a grant can reach this row through a door that
      // never ran it: an IaC manifest or a federated peer can write a `requested` grant naming any
      // object at all, and a `contains` edge can be removed after the request was raised.
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
      // SEPARATION OF DUTIES — the raiser may not be the approver (owner decision, 2026-08-18).
      //
      // APPROVE ONLY, deliberately, and for the same reason the instance-floor check above is
      // approve-only: taking a waiver back must never be harder than making one. Denying or revoking
      // your own request is ordinary withdrawal and stays free.
      //
      // WHAT THIS IS AND IS NOT. It is defence in depth for the D3 authority bar, not a replacement
      // for it: the escalation the bar exists to stop survives this check intact the moment any
      // SECOND principal holds the same scoped `policy:write`. It closes only the one-actor shape —
      // raise at a tier you hold, then immediately sign your own waiver — which is also the cheapest
      // shape to reach and the only one that leaves a single name on both halves of the record.
      //
      // IT CANNOT BIND A FEDERATED GRANT, and that is correct rather than a gap. A grant arriving
      // over the journal was decided at its AUTHORING instance, where this check ran; re-deciding it
      // here is not a thing this door does. `requestedByActorId` from a peer also names a subject in
      // that domain's `objects`, so comparing it to a local subject id would be meaningless.
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
        // THE ONE CALLER THAT MAY WRITE A DECISION. `graph/objects-repo.ts` refuses `status`,
        // `expiresAt`, `decidedByActorId`, `decidedAt` and `decisionReason` at every other local
        // door; this is the path that earns them, having just run the derived-tier authority check
        // above and about to write the Decision and the hash-chained audit event below, in this same
        // transaction. The flag is a TypeScript-only field on the repo input — no request body
        // reaches it, and `grep -rna scanOverrideGrantDecision` finds exactly this one setter.
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
