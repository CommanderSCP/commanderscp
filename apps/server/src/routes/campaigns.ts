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
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
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
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { badRequest } from "../errors.js";

/**
 * `/campaigns` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — the campaign-scoped sibling of
 * `routes/changes.ts`. Deliberately thin: every write here is a graph-object create (`campaign`,
 * pre-seeded built-in type) plus a Decision, exactly like `POST /changes`; there is no
 * transition-guarded verb surface (`:cancel`/`:accept`) because a campaign has no transition-
 * guarded state machine to drive — see `coordination/campaign-status.ts`'s module doc. The one
 * verb a campaign DOES support beyond propose/list/get/explain is `:rollback`
 * (`coordination/campaign-rollback.ts`), mirroring `POST /changes/{id}/rollback` exactly.
 */
/**
 * ================================================================================================
 * DOES THIS WRITE **WIDEN** THE CAMPAIGN'S DEADLINE — release targets it was withholding from?
 * ================================================================================================
 * OWNER RULING 2026-08-25 (decision D1, option b-i). `POST /campaigns/{id}/deadline` shipped with
 * plain `object:write` behind all three of its acts, and that made the Owner-only per-target waiver
 * one route down — `campaign:deadline-override`, drizzle/0088, Owner ALONE — bypassable by anyone
 * who could not get an Owner to sign one. CLEARING THE DEADLINE IS A STRICT SUPERSET OF WAIVING IT:
 * every target rather than named ones, permanently rather than bounded by `until`, with no per-target
 * `object:write` and no recorded waiver naming who was excused. An Operator refused a one-target
 * waiver simply cleared the whole deadline instead, at a lower price. A WIDER VERB CANNOT RUN AT THE
 * NARROWER VERB'S PERMISSION — the same inversion §4.5 already refused when it declined to check the
 * waiver at the target, applied one route over.
 *
 * WIDENING IS THE PROPERTY, NOT "CLEARING". A move to a LATER instant releases exactly the targets a
 * clear would, for as long as the new date lasts. Gating only the clear would leave the move as the
 * next bypass: "clear it" becomes "move it to 2099", and the Decision written afterwards would even
 * label it `loosening: true` while it ran at `object:write`.
 *
 * SETTING A FIRST DEADLINE AND SHORTENING AN EXISTING ONE STAY AT `object:write`, deliberately: both
 * withhold fan-out from strictly MORE targets, never fewer, so neither can launder a waiver, and
 * demanding an Owner for them would push routine campaign hygiene into the escalation the ruling
 * exists to protect.
 *
 * AN EQUAL VALUE IS NOT A WIDENING, and the comparison is on parsed INSTANTS rather than on the ISO
 * strings — `resolveCampaignDeadline` hands back the `Date` it already parsed. The two renderings
 * that actually reach here differ in their milliseconds (`...T00:00:00Z` vs `...T00:00:00.000Z`,
 * both accepted by `z.string().datetime()`, which is why the stored form and a hand-typed one can
 * disagree), and they sort the WRONG WAY as strings: `'Z' > '.'`, so a string comparison would read
 * a restatement of an unchanged deadline as a slip and demand an Owner for it. Exercised in
 * `campaign-deadline.integration.test.ts` (E5).
 *
 * A CLEAR IS ALWAYS THE ESCALATED ACT, including on a campaign with no readable deadline to clear.
 * Deliberate: the alternative makes the status code for `deadline: null` depend on what is currently
 * stored, which both leaks that state to a caller who was refused and gives an operator a rule they
 * cannot hold in their head ("clearing needs an Owner, unless it would have done nothing").
 *
 * A MALFORMED STORED DEADLINE READS AS "NOTHING TO WIDEN" for a set or a move (the caller passes
 * `null` for `beforeAt` in that case). That is honest rather than lenient: `campaign-reconcile.ts`
 * fails open on a document it cannot parse — a malformed bag locks nothing — so replacing it excuses
 * nobody. The clear over it is still escalated, by the flat rule above.
 */
function widensCampaignDeadline(
  beforeAt: Date | null,
  after: CampaignDeadlineInput | null
): boolean {
  // THE CLEAR — the widest act this verb has, and the one the ruling is about.
  if (after === null) return true;
  // Nothing readable was being enforced, so nothing can be released by replacing it.
  if (beforeAt === null) return false;
  const afterAt = Date.parse(after.at);
  // FAILS CLOSED ON AN INSTANT NOBODY CAN COMPARE, and that is the opposite of the read-time
  // predicate's deliberate fail-open one module over — this is a permission check, and an
  // uncomparable value here would silently answer "not a widening" and hand back the bypass.
  // Unreachable today: `CampaignDeadlineInputSchema` is `z.string().datetime()`, which this repo's
  // zod validates the CALENDAR with (measured in `resolveCampaignDeadline`'s doc). It is written
  // down because that schema is under standing pressure to loosen toward a bare string (§4.1's
  // federation-wedge argument).
  return Number.isNaN(afterAt) || afterAt > beforeAt.getTime();
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

  /**
   * ==============================================================================================
   * THE FOUR CAMPAIGN GET-BY-ID DOORS ARE SCOPED AT THE CAMPAIGN (role-model.md §8.7, step 2.5a)
   * ==============================================================================================
   * `GET /campaigns/{id}`, `:explain`, `:adoption` and `POST :rollback` each ran at
   * `scopeObjectId: auth.orgId`. `authz/resolve.ts`'s `scope_expand` walks UPWARD only, so a check
   * pinned at the org root is satisfiable by an ORG-ROOT BINDING AND BY NOTHING ELSE — an actor
   * bound at the service a campaign lives in held `object:read` and was still 403'd reading it.
   *
   * A PURE WIDENING, not a re-aiming. The same upward walk means an org-root binding still
   * satisfies a check at any object below it, so every request that succeeded before succeeds
   * identically; what changes is that a binding BELOW the org root now reaches the campaigns inside
   * its own subtree, and only those.
   *
   * A CAMPAIGN'S OWN ID IS A REAL SCOPE, WHERE A CHANGE'S IS NOT — the distinction that makes these
   * four the cheap fixes and the `change` doors a separate problem. §8.4 measured that no
   * `proposeChange` caller in the tree passes a `domainId` and `scp change propose` has no
   * `--domain` flag, so a change's containment parent is the org root in practice and re-scoping to
   * it is INERT. `POST /campaigns` is the opposite: `domainId` is on the wire
   * (`CreateCampaignRequestSchema`), it is resolved through `resolveDeclaredContainmentParent` and
   * authorized at, so a campaign authored under a service genuinely lives under it and route 1 of
   * the containment walk finds that service.
   *
   * THE OBJECT IS RESOLVED BEFORE IT IS SCOPED, ON ALL FOUR, AND THAT ORDER IS LOAD-BEARING.
   * `scopeExpandCte` seeds its recursive CTE with the raw uuid and never checks that the object
   * exists, so an id naming nothing expands to a one-row set matching no binding: authorizing at an
   * unresolved path param turns every 404 on these routes into a 403 — for everybody, org-root
   * Owner included — and adds two `assertDenyNotTruncated` probe queries to each. The reorder costs
   * nothing on the two doors that already loaded the campaign on the very next line, and one cheap
   * row read on the two that did not.
   *
   * PINNED BY `routes/campaign-scope-doors.integration.test.ts`, mutation-proven in both
   * directions (the widening, and the 404-not-403 order).
   */
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: found.id
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: campaign.id
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

  /**
   * M25.5 — "has each of this campaign's components migrated yet?", derived live.
   *
   * A PURELY ADDITIVE NEW PATH. No existing schema changes shape: `CampaignRecipeSchema` gains one
   * OPTIONAL property (additive on both the request and the response — making an existing REQUIRED
   * response field optional is the oasdiff break this project has already paid for once, and nothing
   * here does that), and every schema this route names is new.
   *
   * `object:read` AT THE CAMPAIGN, the same scope `:explain` uses, and for the same reason: the
   * answer is assembled from the campaign, its plan and its targets' own inventory/control rows,
   * all of which are already readable at that scope. This route reads and writes nothing — the
   * Decision that accompanies an `adopted` verdict is written by the reconciler's actuator, never
   * by a GET. (It said "at the org" until step 2.5a re-scoped all four get-by-id doors; the
   * sentence's argument was always about being the SAME scope as `:explain`, which it still is.)
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
        // RESOLVE, THEN SCOPE — see `GET /campaigns/{id}`'s block above. Unlike the two doors
        // there, this one costs a genuine extra row read: `buildCampaignAdoptionReport` resolves
        // the campaign itself (through `getCampaign`, which is also where "that uuid is not a
        // campaign" 404s), and that resolution happens far too late to scope an authorization
        // check on. A single indexed lookup is the price of not turning this route's 404 into a
        // 403; `getObjectByIdOrUrnAnyType` is the cheap half of it — it filters tombstones and
        // resolves nothing else.
        const campaignObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.id);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: campaignObject.id
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
   * **Clearing the deadline unlocks every target at once**, on the next 1 s tick, with no unlock
   * verb and no backfill, because the lock is a read-time predicate. It shipped in the same
   * increment as the lock so the lock was never an entrance with no exit — the failure M25.1 exists
   * to close.
   *
   * M25.6b has since added the FINER exit beside it: `POST /campaigns/{id}/deadline-override`
   * excuses NAMED targets, behind the Owner-only `campaign:deadline-override` at the campaign plus
   * `object:write` at each target. This verb is the blunt one — all targets at once — and the two
   * are deliberately different radii.
   *
   * THEY ARE NO LONGER DIFFERENT PRICES IN THE WRONG DIRECTION (owner ruling 2026-08-25, D1 b-i).
   * As shipped, this verb ran at `object:write` for all three acts while the NARROWER waiver needed
   * an Owner — so an Operator refused a one-target waiver could clear the whole deadline instead and
   * excuse everybody, permanently, with no `until` and no per-target check. The WIDENING acts
   * (clearing, and moving the deadline later) therefore now demand `campaign:deadline-override` TOO,
   * on top of `object:write`; setting a first deadline and shortening an existing one are tightenings
   * and stay where they were. `widensCampaignDeadline` at the top of this file carries the full
   * argument, including why the property is "widening" and not "clearing".
   *
   * THAT IS WHY THIS VERB TAKES `CampaignDeadlineInputSchema` AND NOT `CampaignDeadlineSchema`: the
   * stored document carries `overrides[]`, and accepting them here would let an `object:write`
   * holder mint the waivers the Owner-only permission exists to gate. The waivers already in force
   * are PRESERVED across a set or a move (`setCampaignDeadline`) — dropping them would be a silent
   * tightening nobody expressed — and a clear takes them with it, because there is then nothing left
   * to be excused from.
   *
   * BOTH CHECKS ARE AT THE CAMPAIGN OBJECT, not at the org root and not at the targets. Not the org
   * root, because `hasPermission` expands the checked scope upward anyway, so checking at the
   * campaign admits everyone an org-root check would AND an Administrator bound at the campaign's
   * own containment domain — the person with the context. Not the targets, because the thing being
   * configured is this campaign's policy about its own fan-out, and a target-scoped check would hand
   * the laggard their own waiver (§4.5's stated inversion, applied one verb over) — which is doubly
   * true of the widening check, since a target-scoped `campaign:deadline-override` would let an Owner
   * of one laggard clear the deadline for the entire campaign.
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

        // ==========================================================================================
        // THE SECOND BAR ON THE WIDENING ACTS — ADDED, NEVER SUBSTITUTED (owner ruling 2026-08-25)
        // ==========================================================================================
        // `object:write` above still governs all three acts of this verb; a WIDENING one
        // additionally demands the Owner-only `campaign:deadline-override` at the campaign. The
        // reasoning — why clearing is a strict superset of the per-target waiver below, and why a
        // move to a later instant is the same act by another name — is on `widensCampaignDeadline`.
        // This is the established idiom (ADR-0043, drizzle/0088): a second, narrower bar beside the
        // existing one, never a replacement for it, so nothing an `object:write` holder could do
        // before becomes unavailable except the acts the ruling names.
        //
        // THE PREVIOUS VALUE HAS TO BE READ BEFORE THE PERMISSION IS DECIDED — "later than what?"
        // has no answer otherwise. Read HERE rather than taken from `setCampaignDeadline`'s return,
        // because that would decide the authority for a write only after performing it. Same
        // transaction, and the same scope the check above already admitted the caller at, so this
        // discloses nothing to anybody `object:write` did not already let read the campaign.
        //
        // THIS READ IS NOT LOCKED, AND THE CONSEQUENCE IS BOUNDED RATHER THAN ABSENT — stated,
        // because `setCampaignDeadline` locks the SAME row `FOR UPDATE` a moment later and a reader
        // is entitled to ask why this one does not. Under READ COMMITTED a concurrent writer can
        // SHORTEN the deadline between this read and that lock, and this request's shortening then
        // lands as a move LATER than the value it actually replaced. What that can produce is
        // bounded by the value THIS caller already observed: the gate refuses anything later than
        // `storedDeadline`, so the worst a race yields is a deadline no later than one that stood
        // moments earlier — a lost update, undoing someone else's shortening, never a deadline
        // nobody had authority to set. And it is not silent: `setCampaignDeadline` computes
        // `before` under the lock, so the Decision records the true `from`, `loosening: true`, the
        // actor and their mandatory reason. Taking the lock here instead would need a locked read
        // exported from `coordination/campaign-repo.ts`; that is a repo-layer change, and the
        // exposure above did not earn one.
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
            // A clear, and a move to a later instant, both LOOSEN: strictly fewer targets are
            // withheld from afterwards. Labelled from the values rather than from which branch
            // matched, so the label stays true if the branches are ever reordered.
            //
            // THE SAME PREDICATE THE PERMISSION GATE USED, called rather than restated. They were
            // two copies of one rule until the 2026-08-25 ruling gave the rule teeth, and copies
            // drift: the day they disagreed, this record would label an act `loosening` that the
            // gate had admitted as a tightening — the Decision and the authority check telling two
            // different stories about the same write, in the one record built to explain it.
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

  /**
   * M25.6b — WAIVE THIS CAMPAIGN'S DEADLINE FOR NAMED TARGETS (§4.5).
   *
   * ===========================================================================================
   * THE AUTHORIZATION IS THE SUBSTANCE OF THIS ROUTE. TWO CHECKS, AT TWO DIFFERENT OBJECTS
   * ===========================================================================================
   *
   * 1. `campaign:deadline-override` **AT THE CAMPAIGN OBJECT** — and this is the load-bearing
   *    decision of the whole milestone, so it is written down where the check is rather than only
   *    in a document.
   *
   *    THE THING BEING WAIVED IS *THIS CAMPAIGN'S* DEADLINE. Authority over it is therefore
   *    authority over the campaign. Checking at the TARGET instead would hand the laggard their own
   *    waiver: the component's own operator — who holds `object:write` on it by definition, which is
   *    how they ship — could excuse that component from the very migration the campaign exists to
   *    force. The mechanism would then coerce exactly the teams that did not think to opt out, which
   *    is worse than not having it. `hasPermission` expands the checked scope UPWARD, so this admits
   *    an Owner at the org root AND an Owner bound at the campaign's own containment domain, and
   *    nobody bound only under a target.
   *
   *    IT IS A NEW PERMISSION (drizzle/0088, Owner-only) AND NOT `freeze:override`, which was
   *    available and is the wrong shape: sharing it would let a freeze-override holder waive
   *    migration deadlines and a deadline-waiver holder bypass release freezes — two unrelated blast
   *    radii on one grant, neither afterwards narrowable without taking the other with it.
   *
   * 2. `object:write` **AT EACH NAMED TARGET** — the second, NARROWER bar. A waiver is a permanent,
   *    hash-chained governance record naming a specific component; minting one over a component the
   *    actor has no standing on at all should not follow from authority over the campaign. Checked
   *    per target rather than once at the campaign's domain for `proposeCampaign`'s stated reason:
   *    a campaign's targets can span domains a coarse single check would miss.
   *
   * Both must pass. Neither substitutes for the other, and the order matters only in what an actor
   * learns: campaign authority is checked first, so someone with none of it learns nothing about
   * which objects the campaign targets.
   *
   * ===========================================================================================
   * OMITTING `targets` MEANS EVERY TARGET — AND IT IS NOT A SYNONYM FOR CLEARING THE DEADLINE
   * ===========================================================================================
   * The deadline stands; each waiver is recorded per target with its own audit event; `until` still
   * expires them individually; and this needs the Owner-only permission at the campaign PLUS
   * `object:write` at every single target. The broad form therefore demands broad standing, which is
   * the property that makes offering it safe.
   *
   * THE CLEAR VERB ONE ROUTE UP NOW DEMANDS THE SAME OWNER-ONLY PERMISSION (owner ruling 2026-08-25,
   * D1 b-i). It did not when this route shipped, and that was the bypass: clearing excuses every
   * target permanently with no `until` and no per-target check, so the cheaper door was also the
   * wider one. It still costs less than the broad waiver here — no `object:write` at each target,
   * because it configures the campaign's own policy rather than minting a record about components —
   * but it is no longer reachable by someone an Owner declined to give a one-target waiver.
   *
   * ===========================================================================================
   * ONE TRANSACTION: THE GRAPH WRITE, ONE DECISION, ONE AUDIT EVENT **PER TARGET**
   * ===========================================================================================
   * The `overrides[]` entry lands through `updateObject` — versioned, content-hashed and audited on
   * the ordinary graph path — so there is no side door into `objects.properties`. On top of it:
   *
   *  * ONE `campaign_deadline_override` Decision (`verdict: "allow"`). Its OWN kind, distinct from
   *    the tick-driven `campaign_deadline` block rows: `insertDecisionIfChanged` compares against
   *    the latest row of a `(subject_id, kind)` pair, so a human `allow` sharing that kind would
   *    interleave with the loop's rows and suppression would never fire — ADR-0024's measured
   *    1.44 GB/day rebuilt from parts.
   *  * `inputContext` is EXACTLY `{ targets (sorted), until }`. `until` is a stored BOUNDARY, the
   *    only clock-shaped value allowed anywhere in this feature's Decisions. `at` and `actorId` are
   *    clock- and identity-shaped and are DELIBERATELY absent — they live on the audit event, which
   *    is the record built for exactly that, and in the stored waiver itself. The sort is
   *    `describeLockedTargets`'s reason: `restatesDecision` canonicalizes object KEYS but preserves
   *    array ORDER.
   *  * ONE HIGH-SEVERITY AUDIT EVENT PER TARGET, mandatory reason, `decisionId` linked — the
   *    `freeze.override` shape, where CRITICAL #2's rule is that a per-scope act writes a per-scope
   *    event. One event listing N targets would turn "was component X ever excused from campaign Y?"
   *    into a substring search over a blob instead of a subject-keyed query.
   *
   * No `insertDecisionIfChanged` and no dedup concern: this is one row per human API call, not a
   * predicate restated on a timer.
   *
   * EFFECT IS IMMEDIATE ON THE NEXT TICK, and there is NO un-waive verb — that is the payoff of a
   * read-time predicate, the same one that makes a moved deadline release its targets with no
   * unlock verb. An `until` in the past is stored, audited and simply not effective.
   */
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
          // A WAIVER OVER A NON-TARGET IS DEAD DATA in a permanent record, and an operator who
          // believes they excused a component that was never in the campaign is worse off than one
          // who got an error. Refused BEFORE the per-target authorization: the actor already holds
          // the Owner-only permission at this campaign, so "that object is not one of its targets"
          // tells them nothing they could not read off `GET /campaigns/{id}`.
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
        // RESOLVE, THEN SCOPE, at the campaign — see `GET /campaigns/{id}`'s block above. The extra
        // row read is here for the same reason as on `:adoption`: `triggerCampaignRollback`
        // resolves the campaign itself (and is where "not a campaign" 400s), which is after the
        // authorization decision has to be made.
        //
        // A CAMPAIGN-SCOPED WRITER CANNOT REVERT INTO TARGETS THEY HAVE NO STANDING ON, and that is
        // NOT what this check provides. The per-member bar lives inside `triggerCampaignRollback`,
        // which re-checks `object:write` at EVERY member's own target and skips the ones it does
        // not hold — the "every target for writes" rule §8.4 states, already built here before this
        // re-scope and unchanged by it. Widening this door from the org root to the campaign is
        // therefore not a widening of blast radius: it changes who may ASK, not what the ask
        // reaches.
        const campaignObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.id);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: campaignObject.id
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
