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
// The change doors in THIS file are scoped by the same two helpers `routes/changes.ts` scopes its
// own with, imported rather than restated so the read bar and the write bar cannot drift apart
// across the two files (see their docblock for why a change's scope is its TARGETS).
// `resolveChangeForScope` comes with them: a door that scopes at a change's targets must first
// establish that the id it was handed IS a change, or the target-set refusal turns "that is not a
// change" into a 403 for a principal with full authority.
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

/**
 * The read scope of one approval request: `object:read` at ANY ONE target of the change it belongs
 * to (role-model.md §8.4 — a change's own `domain_id` is the org root, so the targets are the only
 * real scope). Shared by `GET /approvals/{id}` and its `/votes` sub-resource so the request and its
 * contents can never end up behind different bars.
 *
 * The change is resolved with the THROWING `resolveChangeForScope` on purpose:
 * `approval_requests.change_object_id` names a change that must exist for the request to mean
 * anything, so an unresolvable one is an honest 404 about a dangling row rather than a 403 that
 * would read as missing standing.
 *
 * A SOFT-DELETED change is not "unresolvable" here, and neither door re-applies a tombstone 404.
 * Before 2.5a these two resolved no change at all — they authorized at the org root and read the
 * request — so an approval request whose change has since been tombstoned was served, and still is
 * (`resolveChangeForScope`'s docblock has the full account). The 404 this function does produce is
 * for a `change_object_id` that names nothing or names a non-change, which means the row is corrupt.
 */
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
    liftReason: f.liftReason,
    // M25.7 — READ from the row, never inferred from whether a peer exists or from who is asking.
    // A label computed from something other than the thing it names goes silently false.
    objectId: f.objectId
  };
}

/**
 * ============================================================================================
 * M25.7 — `federation:write` IS DEMANDED ON EVERY VERB THAT PUBLISHES, NOT ONLY ON CREATE
 * ============================================================================================
 * The create route gates `federate: true` on `federation:write` because declaring a freeze that
 * binds ANOTHER security domain is a categorically different act from describing your own estate
 * (ADR-0043 §3). Both write verbs re-publish — `syncFreezeObject` re-snapshots the object after a
 * lift and after a window edit, and that snapshot rides the next bundle — so gating only the
 * create leaves the same reach reachable with strictly less authority:
 *
 *   a `freeze:write`-only actor could take a federating freeze whose window ends tonight and
 *   `PATCH` its `endsAt` a year out, extending a release-stopping block across a boundary they
 *   hold no federation authority over. The lift direction is the mirror image: retracting a
 *   commander's protection at every downstream instance.
 *
 * Keyed on `objectId !== null` — i.e. on whether `syncFreezeObject` will ACTUALLY publish, read
 * from the row rather than inferred from anything else. A non-federating freeze (the default, and
 * the whole pre-M25.7 estate) never reaches the check, so every existing caller is unchanged.
 *
 * Checked at the freeze's OWN scope, matching the `freeze:write` check it sits beside and the
 * create route's, so the permission's reach and the freeze's reach stay the same bounded thing.
 *
 * ADDED, NEVER SUBSTITUTED: `freeze:write` is already authorized by the time this runs.
 *
 * It is deliberately NOT the replica guard. `freezes-repo.ts`'s `lockFreezeRow` refuses a write to
 * a freeze another DOMAIN owns (409); this refuses a write by an actor without federation
 * authority to a freeze THIS domain owns (403). Neither subsumes the other, and only one of them
 * fires for a commander operator editing a commander freeze.
 */
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

/**
 * ============================================================================================
 * M25.9 / OWNER RULING D1 (2026-08-25) — TAKING PROTECTION AWAY FROM A FREEZE YOU DID NOT DECLARE
 * ============================================================================================
 * `freeze:override` on top of `freeze:write`, and ONLY when the acting subject is not the freeze's
 * `created_by_actor_id`. The full reasoning, the three artifacts that disagreed and which of
 * `campaigns-rework.md` §1.7's three exits the owner took, is in the lift route's docblock below;
 * this is the one place the rule is spelled.
 *
 * ONE FUNCTION, TWO CALLERS, DELIBERATELY. `DELETE` (lift) and a SHORTENING `PATCH` are the same
 * act — both end a protection early for everyone the freeze covers — and `freezes-repo.ts`'s
 * `lockFreezeRow` header records what the asymmetric version of a freeze refusal costs: "a lift
 * that is refused while a window edit is not lets an outpost push a commander's `ends_at` to a past
 * instant and achieve the retraction it was refused, through a verb nobody thought to guard." The
 * same sentence is true one authority-model over. A third loosening verb must call this too.
 *
 * COMPARED ON `created_by_actor_id`, READ FROM THE ROW. Never inferred from who holds what, and
 * never from `lifted_by_actor_id` (which is null until the very write being authorized). For any
 * freeze these routes can write, the column is set once by `createFreeze` and never updated: the
 * only other writer is `governance/freeze-object.ts`'s rebuild, whose update arm is fenced to
 * `object_id = <the peer object>` — a REPLICA row, which `freezes-repo.ts`'s `lockFreezeRow`
 * already refuses both write verbs on with a 409 before authorship could matter. So the value
 * cannot drift out from under an authorization decision made on it, which is what makes the
 * comparison safe against the lift route's unlocked read.
 *
 * ADDED, NEVER SUBSTITUTED: `freeze:write` at the freeze's own scope is authorized by the time this
 * runs, on both verbs, for every caller. This is a second bar, and it is demanded at THE FREEZE'S
 * OWN SCOPE — the same scope as the `freeze:write` check it sits beside, and the scope DESIGN §10.3
 * already demands `freeze:override` at for a per-change override ("at that freeze's own scope"), so
 * one permission means one thing on both of its doors. `hasPermission` expands upward only, so an
 * Owner bound at service S can retract an S-scoped freeze a colleague declared and CANNOT reach the
 * org-root freeze that covers everyone — the same bound `freeze:write` gets here, for the same
 * reason. Demanding the override at `auth.orgId` instead would not be a hole (it is strictly
 * narrower: only an org-root Owner would ever clear it), but it would make this bar's reach
 * disagree with the reach of the permission it is stacked on, and would leave a service Owner
 * unable to retract a colleague's freeze inside their own service.
 *
 * AND THAT PARAGRAPH IS PINNED, NOT MERELY ARGUED — `coordination/freeze-admission.integration.
 * test.ts`, the `M25.9 ladder` case "the override is demanded at THE FREEZE'S OWN SCOPE": a
 * SERVICE-bound Owner lifts a service-scoped freeze an org-root Administrator declared, with a
 * service-bound ADMINISTRATOR refused on the same freeze as its control. Rewrite `scopeObjectId`
 * below to `auth.orgId` and that one case goes red. It exists because review found this claim
 * unmeasured: every OTHER actor in that block is bound at the ORG ROOT, where the two spellings
 * name the same scope, so all of them passed under either. A claim about a second parameter needs a
 * case in which that parameter is the only thing that moved.
 */
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
        // `object:read` at ANY ONE of the change's targets, not at the org root — a change's own
        // `domain_id` is the org root, so nothing narrower than the targets is a real scope here.
        //
        // `resolveChangeForScope` does two things this door needs, both of them about keeping
        // 404 and 403 apart. It resolves before the scope check, because scoping at an unresolved
        // path param turns 404 into 403; and it 404s an id that resolves to something OTHER than a
        // change. Without the type check this door 403s an org-root Owner who passes, say, a
        // component id — the target-set refusal fires on an object that has no targets — where it
        // used to answer `200 []` (`listControlRunsForChange` is a plain
        // `change_object_id = $1` filter, so a non-change id simply matched no rows). Reporting an
        // authorization failure to the one principal with authority over everything is the
        // opposite of the widening this increment is; a 404 is the honest answer and a better one
        // than `200 []`.
        //
        // Resolving is also a fix in its own right: the raw `idOrUrn` used to be handed straight to
        // a uuid-typed column, so this door has never accepted the URN half of its own parameter.
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
   * `object:read` at the RUN'S CHANGE'S TARGETS, matching the list endpoint immediately above.
   * These rows are the decomposition of evidence that endpoint already returns in aggregate
   * (`evidence.severityCounts`, `evidence.exclusions`), so a bar that differed from it in EITHER
   * direction would be wrong: stricter would guard the detail while the summary stayed open, and
   * looser — which is what leaving this at the org root while the list moved to the targets would
   * have produced — would let a principal read every finding of a scan they cannot see the verdict
   * of. The two are kept identical on purpose.
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
        if (!request.query.changeId) {
          throw badRequest(
            "changeId is required (M4: approvals are always listed scoped to a change)"
          );
        }
        // This "list" is always pinned to ONE change (the 400 above is what makes that true), so it
        // is scoped exactly like a get-by-id: `object:read` at ANY ONE of that change's targets.
        // The change is resolved before the check, which is both the 404-not-403 ordering and the
        // only way to reach the targets. (Consequence of moving the required-`changeId` 400 ahead
        // of the authorize: a caller who is BOTH unauthorized AND omits `changeId` now learns the
        // parameter is required before being refused. That leaks nothing about the estate.)
        //
        // WHAT THE PRE-AUTHORIZATION RESOLVE DOES AND DOES NOT DISCLOSE. `changeId` is
        // caller-supplied, so a principal with no binding anywhere can probe it — and the resolve
        // necessarily runs first, because the targets are where the scope comes from. What it can
        // learn is bounded by `resolveChangeForScope` answering an IDENTICAL 404 for "no such
        // object" and for "an object, but not a change": the only bit distinguishable from outside
        // is "this uuid names a change in my own org that I have no standing on" (403). Callers
        // are already authenticated into that org, uuids are unguessable, and every change-scoped
        // door in this family necessarily says the same thing — so this is the design's floor, not
        // a leak specific to `/approvals`. Naming an arbitrary component id no longer distinguishes
        // it from a typo.
        const change = await resolveChangeForScope(tx, auth.orgId, request.query.changeId);
        await assertReadableAtSomeChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change
        });
        // THE ONE DOOR IN THIS FAMILY THAT GENUINELY 404'd A SOFT-DELETED CHANGE BEFORE 2.5a, and
        // it keeps doing so. Its pre-2.5a resolve was `getObjectByIdOrUrnAnyType`, which filters
        // tombstones; `resolveChangeForScope` deliberately does not (four OTHER doors resolved no
        // change at all before 2.5a, and filtering there turned their 200s into 404s — see its
        // docblock). So the tombstone 404 belongs to this door, not to the resolver, and it is
        // re-applied HERE — AFTER the read check, because the pre-2.5a order was authorize-then-
        // resolve, so an unauthorized caller was refused before learning anything about the row.
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
        // =====================================================================================
        // M25.7 / OWNER DECISION D6 — THE FEDERATING FORM IS A SECOND, HIGHER GATE
        // =====================================================================================
        // `freeze:write` above is the permission for freezing YOUR OWN estate, and it is still
        // required — this is ADDED, never substituted. `federation:write` is demanded on top
        // because `federate: true` declares a freeze that BINDS ANOTHER SECURITY DOMAIN: the object
        // rides `object_upsert` to every peer at a scope that carries it, and
        // `governance/freeze-object.ts`'s projection rebuild makes it BLOCK there. That is
        // categorically different from describing your own estate, and it is the exact line
        // ADR-0022 drew for commander-authored outpost config, in the same direction.
        //
        // Checked at the SCOPE OBJECT, not at the org root, so the permission's reach and the
        // freeze's reach are the same bounded thing — the property `freeze:write` already has here
        // and that the lift route's docblock spells out at length.
        //
        // ASYMMETRIC ON PURPOSE, exactly like `assertMayDeclareDomainLocal`: only `true` is gated.
        // An ordinary `POST /freezes` is unchanged for every existing caller.
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
        // M25.3: was an inline `endsAt <= startsAt` comparison — a THIRD copy of the invariant
        // `assertWindowOrdered` was extracted in M25.1 to own (its docblock says so: "a second
        // copy of this comparison is exactly the drift `activeFreezesInWindow`'s header is
        // about"). `createFreeze` calls it defensively a line later anyway, so the only thing the
        // inline copy contributed was a second message that could drift from the real one.
        assertWindowOrdered(startsAt, endsAt);
        const created = await createFreeze(tx, {
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
  // ===========================================================================================
  // AND `freeze:override` ON TOP, FOR A FREEZE YOU DID NOT DECLARE — M25.9, OWNER RULING D1
  // ===========================================================================================
  // SETTLED 2026-08-25 by owner ruling (decision D1, option a-ii). This block previously read
  // "OPEN, PENDING AN OWNER RULING"; it is now closed, and the exit taken is (b) of the three
  // `docs/proposals/campaigns-rework.md` §1.7 offered:
  //
  //   `freeze:override` is required to LIFT or SHORTEN a freeze YOU DID NOT DECLARE, compared on
  //   `freezes.created_by_actor_id` against the acting subject. Retracting or shortening YOUR OWN
  //   freeze stays `freeze:write` alone.
  //
  // WHAT WAS WRONG WITH `freeze:write` ALONE. An override is per-CHANGE: it lets ONE change past
  // and leaves the freeze standing for everyone else, and `drizzle/0010` grants it to Owner only. A
  // lift is per-FREEZE: it retracts the protection for EVERYONE the freeze covers. Demanding only
  // Administrator-tier `freeze:write` for the lift made the strictly wider-reaching verb take the
  // strictly narrower permission — an Administrator at service S could retract an Owner's S-scoped
  // freeze for everyone with a permission they already held, where the Owner-only override would
  // have admitted exactly one change. Three artifacts disagreed about that: `drizzle/0010`'s
  // comment calls `freeze:override` and `change:emergency` "the two highest-blast-radius bypass
  // permissions (DESIGN §10.3), deliberately NOT granted to Administrator by default", DESIGN §10.3
  // says getting past a freeze "requires an explicit `freeze:override` permission", and this file
  // argued the opposite from first principles. The ruling makes 0010's comment and DESIGN §10.3
  // AGREE with this file rather than the reverse: `freeze:override` is once again what it costs to
  // take protection away from a freeze someone else declared, whether by bypassing it for one
  // change or by retracting it for all of them.
  //
  // AND THE DOCS WERE ACTUALLY EDITED, which is the only thing that makes the sentence above true.
  // The point of the ruling was to stop three artifacts contradicting each other, so naming
  // agreement without producing it would have been the same defect one layer down. What changed,
  // and it is checkable: DESIGN §10.3's **retraction** bullet ("A freeze can be retracted") stated
  // the rule flatly as `freeze:write` at the freeze's own scope with no mention of the override —
  // it now carries the override clause, the actor comparison, and the shorten/extend split.
  // BUILD_AND_TEST.md §8's **M25.1 definition of done** carried the identical superseded wording
  // and now carries the same clause, marked as a deliberate post-ship correction of a DoD rather
  // than a quiet rewrite. §10.3's **Override** bullet already agreed and is untouched — it is the
  // retraction bullet, describing the exact two verbs gated here, that did not. `drizzle/0010`'s
  // comment needs no edit: it says only that the override is not granted to Administrator by
  // default, which is precisely what this bar now relies on.
  //
  // BOTH PROPERTIES SURVIVE, WHICH IS WHY THE ACTOR IS IN THE RULE AT ALL:
  //
  //   * A SURFACE WITH AN ENTRANCE AND NO EXIT IS THE DEFECT M25.1 EXISTS TO REMOVE. `freeze:write`
  //     is what declares a freeze. Requiring `freeze:override` to lift EVERY freeze would mean an
  //     Administrator can create a governance object they cannot retract, and would put every
  //     mistyped `endsAt` on the estate in front of the Owner — reproducing, one level up, exactly
  //     the "no way out" M25.1 closed. Your own mistake stays yours to undo, at the same permission
  //     that made it.
  //   * NO ADMINISTRATOR SILENTLY UNDOING AN OWNER. Someone else's freeze is someone else's
  //     protection. Scope alone did not give this: `freeze:write` at S covers every freeze at S, no
  //     matter who declared it, so an Administrator and an Owner bound at the same service were
  //     indistinguishable to this route. The actor comparison is the part scope cannot express.
  //
  // WHICH ACTS THE SECOND BAR COVERS, and this is the half that is easy to get wrong:
  //
  //   * LIFT (this route) — retracts the protection outright. Covered.
  //   * PATCH that SHORTENS `endsAt` — ends the protection early for everyone covered. It is the
  //     same act with a different record (`updateFreezeWindow`'s docblock: same effect on
  //     admission, and deliberately not re-labelled a lift), so gating the lift alone would leave
  //     the retraction one PATCH away — §1.7 exit (b)'s own caveat, "must cover PATCH-shortening
  //     too, or it is bypassed in one call". Covered, in the PATCH route below.
  //   * PATCH that EXTENDS `endsAt` — ADDS protection. Nothing is taken from anyone the freeze
  //     covers, so it stays `freeze:write`, and extending someone else's freeze is deliberately NOT
  //     an override-tier act. (A federating freeze is the one case where extending IS the sharper
  //     direction, because it grows a block inside another security domain — that is
  //     `assertMayEditFederatingFreeze`'s bar, a different permission for a different reason, and
  //     both apply.)
  //   * PATCH that moves `endsAt` NOWHERE (`direction === "unchanged"`) — nothing was weakened, so
  //     nothing extra is demanded. Re-saving a form must not require the Owner.
  //
  // The three-way split is why the PATCH route authorizes on `direction` rather than on the verb.
  //
  // NOT ESCALATABLE FROM BELOW — but the REASON changed on 2026-08-27, and the old one has expired.
  //
  // This comment used to read "`role_binding:write` has no write API, so an Administrator cannot
  // mint themselves the Owner role and clear the new bar." That was true, and it was load-bearing
  // safety resting on an UNBUILT FEATURE — the kind of argument that expires silently the day
  // somebody ships the obvious missing CRUD. `routes/role-bindings.ts` (role-model.md §5 step 5)
  // ships it: there is now a `POST /api/v1/role-bindings`, and `role_binding:write` is seeded onto
  // Administrator, Owner and OrgAdmin.
  //
  // THE PROPERTY SURVIVES, ON A DIFFERENT FOOTING. That door applies the NO-ESCALATION SUBSET RULE
  // (`authz/role-binding-door.ts` §2): a binding may be written only if every permission the granted
  // role carries is one the acting subject already holds AT THAT SCOPE, computed by running
  // `hasPermission` per member of the target role's array. `Owner` holds `freeze:override`,
  // `change:emergency` and `campaign:deadline-override`; Administrator deliberately holds none of
  // the three (drizzle/0010's comment says so in as many words, and this bar rests on it). So an
  // Administrator granting themselves Owner fails the subset rule on exactly the permission this
  // route demands, and the refusal names it.
  //
  // AND THE SUBSET RULE HAS TO BOUND *BOTH* DOORS, because there were two. The paragraph above was
  // correct about `POST /role-bindings` and incomplete about everything else: a role binding held by
  // a GROUP resolves for every member (`authz/resolve.ts`'s `subject_expand` walks `member_of`), so
  // until 2026-08-27 an Administrator could bind Owner to a group and then join it — and so could an
  // ORG-ROOT OPERATOR, four rungs lower, since creating that edge needed only the `relationship:write`
  // every org-root principal holds at every object. `authz/role-binding-door.ts` §2a closes it by
  // applying the SAME subset rule at `graph/relationships-repo.ts`'s `createRelationship`, so the
  // rule now bounds the membership door as well as the binding door, on every caller of that
  // function — IaC apply included.
  //
  // WHAT IS CHECKED, STATED WITHOUT A CLOSURE CLAIM. The previous version of this paragraph ended
  // "the only thing that would break it now is somebody granting Administrator `freeze:override`" —
  // and the reversed ordering of the same two requests disproved it within the day, which is the
  // second time a comment here has closed on an exhaustiveness claim its author could not verify.
  // So: three doors apply the subset rule — `POST /role-bindings` (§2), a `member_of` create (§2a),
  // and a grant whose subject is a group/team (§2b, added for that reversed ordering). Pinned by
  // `routes/rbac-role-binding-door.integration.test.ts` and, for the choke-point placement,
  // `iac/iac-member-of-role-escalation.integration.test.ts`.
  //
  // PATHS KNOWN TO BE OPEN, named here rather than implied, with the full list and the reasoning in
  // `authz/role-binding-door.ts` §8:
  //
  //   * §2a applies the subset rule and NOT bar §1, so an actor who already holds everything a
  //     group's bindings carry may add a THIRD party to that group without `role_binding:write`.
  //     That is an unauthorised DELEGATION of authority the actor already has; it cannot elevate the
  //     actor, and it cannot give anyone `freeze:override` the delegator does not already hold.
  //   * A grant to a group is BLIND — §2b refuses on the membership's shape and cannot refuse on the
  //     members' standing, because no authority bar on that door reads the subject's identity. An
  //     Owner binding Owner to a team empowers whoever is in it, including a principal who put
  //     themselves there. That is the Owner's own grant reaching further than the Owner looked; it
  //     is not reachable by a principal who does not already hold `freeze:override`, so it does not
  //     clear THIS bar, but it is not closed either.
  //   * `member_of` edges arriving on the FEDERATION IMPORT path are exempt from §2a by design.
  //
  // Granting Administrator `freeze:override` would also break the property, and remains the loudest
  // way to do it — a migration rather than an absence.
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
        // M25.7 — THE LIFT MUST REACH DOWNSTREAM TOO. A no-op for a non-federating freeze. Without
        // it a commander could declare a freeze that blocks at an outpost and never retract it
        // there: M25.1's "a surface with an entrance and no exit" defect rebuilt one boundary over,
        // and strictly worse, because `lockFreezeRow`'s replica guard deliberately denies the
        // outpost a local exit. The re-snapshot rides the next bundle like any other object edit.
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
        // =====================================================================================
        // M25.9 / OWNER RULING D1 — A SHORTENING IS A RETRACTION, AND THE SAME BAR APPLIES
        // =====================================================================================
        // Only `direction === "shortened"` takes protection away from the people this freeze
        // covers; extending ADDS protection and `"unchanged"` moves nothing, and both of those stay
        // `freeze:write`. See the lift route's docblock for the three-way split.
        //
        // AFTER `updateFreezeWindow`, NOT BEFORE, AND THAT PLACEMENT IS THE WHOLE CORRECTNESS OF
        // THIS CHECK. `direction` is the authorization INPUT here, and it is only knowable against
        // the row that is actually in force — which is what `lockFreezeRow`'s `FOR UPDATE` inside
        // `updateFreezeWindow` establishes, and nothing else in this handler does. The unlocked
        // `getFreeze` above returns the pre-transaction committed value under READ COMMITTED, so a
        // check written against `existing.endsAt` is decidable on a window that is no longer live:
        // with the freeze at +30d, a concurrent extension in flight and this request asking for
        // +1d, the stale read says "+1d is later than the +0.5d I read, so this is an extension"
        // and admits it — and the UPDATE, which does take the lock, then cuts a 30-day protection
        // to a day for an actor holding no override. That is the exact staleness
        // `freezes-repo.ts`'s `lockFreezeRow` header describes corrupting the audit record, one
        // consequence worse: there it makes a governance record lie, here it decides a permission.
        //
        // A 403 THROWN HERE STILL HAS NO SIDE EFFECTS. `withTenantTx` is one `db.transaction`, so
        // throwing aborts it and the UPDATE above is rolled back with the row lock — nothing is
        // committed, no Decision, no audit event, no `syncFreezeObject` publish. The route's
        // "an `authorize` failure throws a raw 403 with no side effects" note below still holds
        // exactly as written. Splitting the difference — a cheap stale pre-check plus this one —
        // was rejected on the repo's most-repeated defect: two copies of one refusal, free to
        // disagree, where the copy that runs first is the one nobody re-reads.
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
        const changeObject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.changeId);
        const targetObjectIds = targetObjectIdsOf(
          changeObject.properties as Record<string, unknown>
        );
        // The evaluation scope, computed ONCE and used for both the permission check and the gate
        // below — so this door authorizes at exactly the objects it is about to evaluate against,
        // and the two cannot say different things.
        //
        // NOT `assertReadableAtSomeChangeTarget`, which refuses an empty/malformed target set: this
        // route deliberately accepts ANY object id, falling back to evaluating against the named
        // object itself, and that fallback is the scope in that case.
        //
        // THE ORG-ROOT ARM IS HERE FOR THE SAME REASON IT IS ON EVERY OTHER DOOR 2.5A RE-SCOPED,
        // AND THIS SITE WAS EXCUSED ON A CLAIM THAT TURNED OUT TO BE FALSE. It read "an object's
        // own scope walk reaches the org root, so the fallback is no weaker than the org-root pin
        // it replaces". It does not always: `scopeExpandCte` joins every ANCESTOR
        // `deleted_at IS NULL`, so a scope whose containment parents are tombstoned expands to the
        // seed alone and matches NO binding, org-root Owner included. `targetObjectIds` here are
        // read straight off `changeObject.properties` and never re-resolved — the same verbatim
        // read `routes/changes.ts` documents — so a target deleted along with its service and its
        // domain is exactly the reachable case. `authz/org-root-arm.ts` carries the full argument
        // and is the single definition of the arm.
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
