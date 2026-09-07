import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { CampaignDeadlineInput } from "@scp/schemas";
import {
  CampaignAdoptionResponseSchema,
  CampaignExplainResponseSchema,
  CampaignIdParamSchema,
  CampaignListQuerySchema,
  CampaignListResponseSchema,
  CampaignSchema,
  CreateCampaignRequestSchema,
  OverrideCampaignDeadlineRequestSchema,
  ProblemSchema,
  RollbackCampaignRequestSchema,
  RollbackCampaignResponseSchema,
  SetCampaignDeadlineRequestSchema
} from "@scp/schemas";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { checkAtOrgRootOrScopes } from "../authz/org-root-arm.js";
import { readableScopeForListDoor } from "../authz/list-door-scope.js";
import {
  getCampaign,
  listCampaignTargetObjectIds,
  listCampaigns,
  overrideCampaignDeadline,
  proposeCampaign,
  setCampaignDeadline
} from "../coordination/campaign-repo.js";
import { buildCampaignAdoptionReport } from "../coordination/campaign-adoption.js";
import { getLatestCampaignPlan } from "../coordination/campaign-plan-service.js";
import { insertDecision, listDecisionsForSubject } from "../coordination/decisions-repo.js";
import { triggerCampaignRollback } from "../coordination/campaign-rollback.js";
import {
  CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION,
  CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND,
  CAMPAIGN_DEADLINE_SET_AUDIT_ACTION,
  CAMPAIGN_DEADLINE_SET_DECISION_KIND,
  resolveCampaignDeadline
} from "../coordination/campaign-deadline-lock.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { findObjectByIdOrUrnAnyType, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { badRequest, forbidden, notFound } from "../errors.js";

/** `/campaigns` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). See docs/routes.md §12. */
/** DOES THIS WRITE **WIDEN** THE CAMPAIGN'S DEADLINE. See docs/routes.md §13. */
function widensCampaignDeadline(
  beforeAt: Date | null,
  after: CampaignDeadlineInput | null
): boolean {
  // THE CLEAR — the widest act this verb has, and the one the ruling is about.
  if (after === null) return true;
  // Nothing readable was being enforced, so nothing can be released by replacing it.
  if (beforeAt === null) return false;
  const afterAt = Date.parse(after.at);
  // Fails closed on an instant nobody can compare. See docs/routes.md §14.
  return Number.isNaN(afterAt) || afterAt > beforeAt.getTime();
}

/** THE BAR FOR THE FOUR CAMPAIGN GET-BY-ID DOORS. See docs/routes.md §15. */
async function assertCampaignAuthority(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    permission: "object:read" | "object:write";
    campaignObjectId: string;
  }
): Promise<void> {
  const verdict = await checkAtOrgRootOrScopes(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    orgRootPermission: input.permission,
    scopedPermission: input.permission,
    quantifier: "any",
    scopeObjectIds: [input.campaignObjectId]
  });
  if (verdict.ok) return;
  throw forbidden(
    `subject '${input.subjectObjectId}' lacks '${input.permission}' at the org root and at ` +
      `campaign '${input.campaignObjectId}'`
  );
}

/** The object a campaign door scopes at, resolved first. See docs/routes.md §16. */
async function resolveCampaignForScope(
  tx: TenantTx,
  orgId: string,
  idOrUrn: string
): Promise<{ id: string }> {
  const object = await findObjectByIdOrUrnAnyType(tx, orgId, idOrUrn);
  if (!object || object.typeId !== "campaign") throw notFound(`campaign '${idOrUrn}' not found`);
  return { id: object.id };
}

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
      response: {
        200: CampaignListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        // NEW with `?scopeObjectId=`: a hint naming no object in this org is a 404, so that
        // authorizing at it can never turn "no such object" into "forbidden" (§8.7's trap).
        404: ProblemSchema
      }
    },
    config: {
      openapi: { operationId: "listCampaigns", summary: "List campaigns", tags: ["campaigns"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // THE GATE, AND THE ROW FILTER, IN ONE CALL. See docs/routes.md §17.
        const readableFilter = await readableScopeForListDoor(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectRef: request.query.scopeObjectId,
          resolveScopeObject: async (ref) =>
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, ref)).id
        });
        return listCampaigns(tx, auth.orgId, {
          cursor: request.query.cursor,
          limit: request.query.limit,
          status: request.query.status,
          readableFilter
        });
      });
      reply.status(200).send(page);
    }
  });

  /** The four get-by-id doors take the root or the campaign. See docs/routes.md §18. */
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
        // RESOLVE, THEN SCOPE — see the block above. `getCampaign` 404s on an id that is not a live
        // campaign in this org; it was already the next statement, so this is a reorder, not a
        // second query. Scoping at `found.id` rather than at `request.params.id` is deliberate for
        // the same reason: the id that is checked is the one that was proven to exist.
        const found = await getCampaign(tx, auth.orgId, request.params.id);
        await assertCampaignAuthority(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          campaignObjectId: found.id
        });
        return found;
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
        // RESOLVE, THEN SCOPE, at the campaign — see `GET /campaigns/{id}`'s block above. The
        // `getCampaign` call was already the first statement after the check; only the order and
        // the scope changed.
        const campaign = await getCampaign(tx, auth.orgId, request.params.id);
        await assertCampaignAuthority(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          campaignObjectId: campaign.id
        });
        // `withFreezeHolds: true` — this response's `plan.waves[].targets[].hold` /
        // `heldTargetCount` is the campaign-side wave-target hold projection (M25.UI), the same
        // wire consumer `changes.ts`'s explain handler already opts into on the change side.
        const [plan, decisions] = await Promise.all([
          getLatestCampaignPlan(tx, auth.orgId, request.params.id, { withFreezeHolds: true }),
          listDecisionsForSubject(tx, auth.orgId, request.params.id)
        ]);
        return { campaign, plan, decisions };
      });
      reply.status(200).send(result);
    }
  });

  /** Has each component migrated yet, derived live. See docs/routes.md §19. */
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
        // RESOLVE, THEN SCOPE. See docs/routes.md §20.
        const campaignObject = await resolveCampaignForScope(tx, auth.orgId, request.params.id);
        await assertCampaignAuthority(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          campaignObjectId: campaignObject.id
        });
        return buildCampaignAdoptionReport(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(result);
    }
  });

  /** M25.6a — SET, MOVE or CLEAR this campaign's deadline. See docs/routes.md §21. */
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

        // THE SECOND BAR ON THE WIDENING ACTS. See docs/routes.md §22.
        const stored = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.id);
        const storedDeadline = resolveCampaignDeadline(stored.properties);
        const widening = widensCampaignDeadline(
          storedDeadline.outcome === "deadline" ? storedDeadline.at : null,
          request.body.deadline
        );
        if (widening) {
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "campaign:deadline-override",
            scopeObjectId: request.params.id
          });
        }

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
            // A clear, and a move to a later instant, both LOOSEN. See docs/routes.md §23.
            loosening: widensCampaignDeadline(
              result.before === null ? null : new Date(result.before.at),
              result.after
            )
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

  /** M25.6b — WAIVE THIS CAMPAIGN'S DEADLINE FOR NAMED TARGETS. See docs/routes.md §24. */
  typed.route({
    method: "POST",
    url: "/api/v1/campaigns/:id/deadline-override",
    schema: {
      params: CampaignIdParamSchema,
      body: OverrideCampaignDeadlineRequestSchema,
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
        operationId: "overrideCampaignDeadline",
        summary:
          "Waive a campaign's deadline for named targets — excuses one laggard without clearing the deadline for everyone",
        tags: ["campaigns"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const campaign = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // CHECK 1 — AT THE CAMPAIGN. See this route's doc: a target-scoped check here would hand the
        // laggard their own waiver.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "campaign:deadline-override",
          scopeObjectId: request.params.id
        });

        const declaredTargets = await listCampaignTargetObjectIds(
          tx,
          auth.orgId,
          request.params.id
        );
        const targetObjectIds: string[] = [];
        for (const idOrUrn of request.body.targets ?? declaredTargets) {
          // Resolved through the same helper `proposeCampaign` uses, so a URN works here exactly as
          // it does when the campaign was authored (404 if it names nothing).
          const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, idOrUrn);
          // A waiver over a non-target is dead data. See docs/routes.md §25.
          if (!declaredTargets.includes(target.id)) {
            throw badRequest(
              `'${idOrUrn}' is not a target of campaign '${request.params.id}' — waiving its ` +
                `deadline for that object would record a waiver that can never apply`
            );
          }
          // CHECK 2 — `object:write` AT EACH NAMED TARGET. The narrower bar: authority over the
          // campaign does not by itself license minting a governance record about a component the
          // actor has no standing on.
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "object:write",
            scopeObjectId: target.id
          });
          targetObjectIds.push(target.id);
        }
        if (targetObjectIds.length === 0) {
          throw badRequest(
            `campaign '${request.params.id}' declares no targets — there is nothing to waive`
          );
        }

        const result = await overrideCampaignDeadline(tx, {
          orgId: auth.orgId,
          campaignObjectId: request.params.id,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          targetObjectIds,
          reason: request.body.reason,
          until: request.body.until,
          now: new Date()
        });

        const decision = await insertDecision(tx, {
          orgId: auth.orgId,
          kind: CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND,
          subjectId: request.params.id,
          verdict: "allow",
          inputContext: {
            // SORTED by `overrideCampaignDeadline`. NOTHING ELSE GOES IN HERE: `at` and `actorId`
            // are clock- and identity-shaped (ADR-0024's rule, applied uniformly across M25.6),
            // `reason` is operator prose whose home is the audit event's own column, and `until` is
            // a stored BOUNDARY rather than a reading of the clock.
            targets: result.targetObjectIds,
            until: request.body.until ?? null
          },
          reasonTree: {
            summary:
              `${result.targetObjectIds.length} target(s) WAIVED from this campaign's deadline of ` +
              `${result.campaign.deadline?.at ?? "unknown"}` +
              (request.body.until === undefined
                ? " — no expiry: in force until the deadline is cleared or the target adopts"
                : ` — effective until ${request.body.until}, after which the deadline applies again with no job to run`),
            // A waiver is unambiguously a LOOSENING: strictly fewer targets are withheld from
            // afterwards. Labelled from what the act IS rather than from which branch matched.
            loosening: true
          }
        });

        // ONE PER TARGET — the `freeze.override` shape (`coordination/transition.ts`), and the
        // `subjectId` is THE TARGET, not the campaign, which is what makes "was this component ever
        // excused?" a subject-keyed query. The Decision above is the campaign-subject half.
        for (const targetObjectId of result.targetObjectIds) {
          await appendAuditEvent(tx, {
            orgId: auth.orgId,
            actorId: auth.subjectObjectId,
            action: CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION,
            subjectId: targetObjectId,
            reason: request.body.reason,
            decisionId: decision.id,
            requestId: request.id
          });
        }

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
        // RESOLVE, THEN SCOPE, at the campaign. See docs/routes.md §26.
        const campaignObject = await resolveCampaignForScope(tx, auth.orgId, request.params.id);
        await assertCampaignAuthority(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          campaignObjectId: campaignObject.id
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
