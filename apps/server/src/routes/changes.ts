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
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize, type Permission } from "../authz/resolve.js";
import { checkAtOrgRootOrScopes, type ScopedArmQuantifier } from "../authz/org-root-arm.js";
import {
  assertCoordinationTargetsWithinAuthority,
  assertStageDependenciesWithinAuthority
} from "../coordination/campaign-scope-authz.js";
import {
  getChange,
  listChanges,
  proposeChange,
  requiresOf,
  targetObjectIdsOf
} from "../coordination/changes-repo.js";
import { findObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { requirementStatuses, listProvidedKeysAtScope } from "../coordination/coupling.js";
import { transitionChange } from "../coordination/transition.js";
import type { GateDeps } from "../coordination/gates.js";
import { triggerRollback } from "../coordination/rollback.js";
import { getLatestPlanForChange } from "../coordination/plan-service.js";
import { resolveStageDependencyStatus } from "../coordination/stage-dependency-status.js";
import { buildBoundarySegment } from "../coordination/boundary-segment.js";
import {
  getDecision,
  listDecisions,
  listDecisionsForSubject
} from "../coordination/decisions-repo.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import { conflict, forbidden, notFound, ProblemError } from "../errors.js";
import { serverOwnedSourceRefKeysIn } from "../federation/boundary-bundle-ref.js";

/** The change routes, their sub-resource and the guard. See docs/routes.md §56. */
/** M12 P4B Phase 4 — the coupled-pipeline wait status for `explain`. See docs/routes.md §57. */
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

// AUTHORIZATION SCOPE FOR A CHANGE. See docs/routes.md §58.

/** The object a change-scoped door scopes at, resolved first. See docs/routes.md §59. */
export async function resolveChangeForScope(
  tx: TenantTx,
  orgId: string,
  idOrUrn: string
): Promise<{ id: string; properties: Record<string, unknown>; deletedAt: string | null }> {
  const object =
    (await findObjectByIdOrUrnAnyType(tx, orgId, idOrUrn)) ??
    (await findObjectByIdOrUrnAnyType(tx, orgId, idOrUrn, { includeDeleted: true }));
  if (!object || object.typeId !== "change") throw notFound(`change '${idOrUrn}' not found`);
  return { id: object.id, properties: object.properties, deletedAt: object.deletedAt };
}

/** The target ids a change's authority is checked against, DEDUPED. See docs/routes.md §60. */
function readChangeTargetScopeIds(change: {
  properties: Record<string, unknown>;
}): string[] | null {
  const raw = change.properties?.targets;
  const ids = targetObjectIdsOf(change.properties);
  if (!Array.isArray(raw) || raw.length === 0 || ids.length !== raw.length) return null;
  return [...new Set(ids)];
}

/** THE ORDER BOTH CHANGE BARS RUN IN, in one place. See docs/routes.md §61. */
type ChangeAuthorityVerdict =
  | { ok: true }
  /** The persisted target set is empty, missing or malformed AND the org-root arm did not hold. */
  | { ok: false; reason: "no-target-set" }
  | {
      ok: false;
      reason: "scoped";
      targetObjectIds: string[];
      /** The one target that failed an `"every"` arm, when one is to blame. */
      refusedScopeObjectId: string | null;
    };

async function checkAtOrgRootOrChangeTargets(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
    permission: Permission;
    quantifier: ScopedArmQuantifier;
  }
): Promise<ChangeAuthorityVerdict> {
  // READ, never THROW. The refusal below is reached only after the org-root arm has already failed.
  const targetObjectIds = readChangeTargetScopeIds(input.change);
  const verdict = await checkAtOrgRootOrScopes(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    orgRootPermission: input.permission,
    scopedPermission: input.permission,
    quantifier: input.quantifier,
    scopeObjectIds: targetObjectIds ?? []
  });
  if (verdict.ok) return { ok: true };
  if (!targetObjectIds) return { ok: false, reason: "no-target-set" };
  return {
    ok: false,
    reason: "scoped",
    targetObjectIds,
    refusedScopeObjectId: verdict.refusedScopeObjectId
  };
}

/** The trap-4 refusal, thrown only once the org-root arm has failed — a statement about the ROW. */
function unestablishableChangeTargetSet(changeId: string): never {
  throw forbidden(
    `change '${changeId}' has no readable target set (properties.targets must be a non-empty ` +
      `array of object ids), so authority over it cannot be established`
  );
}

/** Read bar: at the org root, or at any one target. See docs/routes.md §62. */
export async function assertReadableAtSomeChangeTarget(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
  }
): Promise<void> {
  const verdict = await checkAtOrgRootOrChangeTargets(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    change: input.change,
    permission: "object:read",
    quantifier: "any"
  });
  if (verdict.ok) return;
  if (verdict.reason === "no-target-set") unestablishableChangeTargetSet(input.change.id);
  throw forbidden(
    `subject '${input.subjectObjectId}' lacks 'object:read' at the org root and at any target of ` +
      `change '${input.change.id}' (${verdict.targetObjectIds.join(", ")})`
  );
}

/** Write bar: at the org root, or at every target. See docs/routes.md §63. */
export async function assertWritableAtEveryChangeTarget(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
  }
): Promise<void> {
  await assertPermittedAtEveryChangeTarget(tx, { ...input, permission: "object:write" });
}

/** ONE EVERY-TARGET WRITE BAR, PARAMETERISED BY PERMISSION. See docs/routes.md §64. */
async function assertPermittedAtEveryChangeTarget(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
    permission: Permission;
  }
): Promise<void> {
  const verdict = await checkAtOrgRootOrChangeTargets(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    change: input.change,
    permission: input.permission,
    quantifier: "every"
  });
  if (verdict.ok) return;
  if (verdict.reason === "no-target-set") unestablishableChangeTargetSet(input.change.id);
  throw forbidden(
    verdict.refusedScopeObjectId
      ? `subject '${input.subjectObjectId}' lacks '${input.permission}' at scope ` +
          `'${verdict.refusedScopeObjectId}'`
      : `subject '${input.subjectObjectId}' lacks '${input.permission}' at the org root and at ` +
          `every target of change '${input.change.id}' (${verdict.targetObjectIds.join(", ")})`
  );
}

/** Accept bar: writable everywhere, and then accept. See docs/routes.md §65. */
export async function assertAcceptableAtEveryChangeTarget(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
  }
): Promise<void> {
  await assertWritableAtEveryChangeTarget(tx, input);
  await assertPermittedAtEveryChangeTarget(tx, { ...input, permission: "change:accept" });
}

// THE VERDICT-READ RULE. See docs/routes.md §66.

/** DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE. See docs/routes.md §67. */
async function assertDecisionReadable(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    /** The Decision's own `subjectId`, or the requested `subjectId` filter — `null` for an
     *  unfiltered list, where there is no subject to offer the second arm. */
    decisionSubjectId: string | null;
  }
): Promise<void> {
  // Resolved BEFORE the check so the subject arm has something to offer. The wide arm is still
  // evaluated FIRST inside the helper, so an auditor's ANSWER never depends on this lookup — only
  // the cost does.
  const subject = input.decisionSubjectId
    ? await findObjectByIdOrUrnAnyType(tx, input.orgId, input.decisionSubjectId)
    : null;
  // A change is read at its targets; anything else is read at itself, where the direct check is
  // already meaningful (a component's chain does NOT collapse to the org root).
  const scopeObjectIds = !subject
    ? []
    : subject.typeId === "change"
      ? (readChangeTargetScopeIds({ properties: subject.properties }) ?? [])
      : [subject.id];
  const verdict = await checkAtOrgRootOrScopes(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    orgRootPermission: "audit:read",
    scopedPermission: "object:read",
    quantifier: "any",
    scopeObjectIds
  });
  if (verdict.ok) return;
  throw forbidden(
    `subject '${input.subjectObjectId}' lacks 'audit:read' at the org root` +
      (input.decisionSubjectId
        ? ` and 'object:read' at decision subject '${input.decisionSubjectId}'` +
          ` (or, where that subject is a change, at any of its targets)`
        : ` (an unfiltered Decision listing has no subject to scope to — name a 'subjectId')`)
  );
}

export function registerChangeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  // `host: null` — this route runs on the request-serving (`role=api`) tier, which has no
  // `PluginHost` (coordination/gates.ts's module doc, DESIGN §16's api/worker split). The only
  // lifecycle edge this file ever governance-evaluates (`validating->accepted`) only ever READS
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
      // The server-owned `sourceRef` keys. See docs/routes.md §68.
      const planted = serverOwnedSourceRefKeysIn(body.sourceRef);
      if (planted.length > 0) {
        throw new ProblemError(400, "sourceRef carries a server-owned key", {
          detail:
            `sourceRef.${planted.join(", sourceRef.")} ${planted.length === 1 ? "is" : "are"} ` +
            `written only by the server (promotion export/import stamps) and cannot be supplied on ` +
            `a proposed change`
        });
      }
      const { change } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
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
        // An emergency change needs a permitted actor. See docs/routes.md §69.
        if (body.emergency) {
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "change:emergency",
            scopeObjectId: declaredParent ?? auth.orgId
          });
        }
        // Bind the change's declared targets to the actor's own. See docs/routes.md §70.
        await assertCoordinationTargetsWithinAuthority(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          targets: body.targets
        });
        // ADR-0028: `targets` is not the only declared field that reaches out of the actor's own
        // scope. A `stageDependencies` entry is materialised as a `depends_on` edge from each target
        // to the named component, so it must clear the SAME both-endpoint bar `POST /relationships`
        // demands — see the helper for the blast radius of an unauthorized one.
        await assertStageDependenciesWithinAuthority(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          targets: body.targets,
          stageDependencies: body.stageDependencies
        });
        return proposeChange(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: body.id,
          urn: body.urn,
          domainId: declaredParent,
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
          requires: body.requires,
          stageDependencies: body.stageDependencies
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
        // LOADED BEFORE IT IS SCOPED, and that order is load-bearing: `scopeExpandCte` seeds its
        // CTE with the raw uuid and never checks existence, so scoping at an unresolved path param
        // expands a nonexistent id to a one-row set matching no binding — turning a 404 into a 403
        // even for an org-root Owner, and paying for two truncation-probe queries on the way.
        const found = await getChange(tx, auth.orgId, request.params.id);
        await assertReadableAtSomeChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change: found
        });
        return found;
      });
      reply.status(200).send(change);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/changes/:id/explain",
    schema: {
      params: ChangeIdParamSchema,
      response: {
        200: ChangeExplainResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
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
        // Resolved first, then scoped. See docs/routes.md §71.
        const change = await getChange(tx, auth.orgId, request.params.id);
        await assertReadableAtSomeChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change
        });
        // The plan is awaited BEFORE the batch below rather than inside it, so the stage-dependency
        // status can be handed the plan this handler already loads instead of re-issuing its three
        // queries (ADR-0028 increment 4). Costs nothing: these all run on ONE tenant transaction,
        // i.e. one connection, so the `Promise.all` was never actually concurrent.
        const plan = await getLatestPlanForChange(tx, auth.orgId, request.params.id);
        const [decisions, controlRuns, waitStatus, stageDependencyStatus, boundarySegment] =
          await Promise.all([
            listDecisionsForSubject(tx, auth.orgId, request.params.id),
            listControlRunsForChange(tx, auth.orgId, request.params.id),
            buildWaitStatus(tx, auth.orgId, change),
            // Which stage dependency withholds, re-evaluated live. See docs/routes.md §72.
            resolveStageDependencyStatus(
              tx,
              auth.orgId,
              { objectId: change.id, properties: change.properties },
              plan
            ),
            // M16.1 — the boundary segment (transferred + validated phases). Read-only; null for a
            // change that never crossed a domain boundary.
            buildBoundarySegment(tx, auth.orgId, change)
          ]);
        // `ChangeWaveSchema.heldTargetCount`'s SECOND HALF. See docs/routes.md §73.
        if (plan && stageDependencyStatus) {
          const activeWave = plan.waves.find(
            (w) => w.waveIndex === stageDependencyStatus.waveIndex
          );
          if (activeWave) {
            const freezeHeldTargetIds = new Set(
              activeWave.targets
                .filter((t) => t.hold !== undefined && t.hold.freezes.length > 0)
                .map((t) => t.targetObjectId)
            );
            const stageHeldCount = stageDependencyStatus.targets.filter(
              (t) => t.held && !freezeHeldTargetIds.has(t.targetObjectId)
            ).length;
            activeWave.heldTargetCount = (activeWave.heldTargetCount ?? 0) + stageHeldCount;
          }
        }
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
            createdAt: r.createdAt.toISOString(),
            // The second projection of a control run, same increment. See docs/routes.md §74.
            gateKind: r.gateKind as "lifecycle_edge" | "wave_boundary",
            gateRef: r.gateRef
          })),
          waitStatus,
          stageDependencyStatus,
          boundarySegment
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
        // Write at every target, and deliberately not accept. See docs/routes.md §75.
        await assertWritableAtEveryChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change: await getChange(tx, auth.orgId, request.params.id)
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
        if (result.verdict === "block")
          return { blocked: result.blockedReason, decisionId: result.decision.id };
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
    url: "/api/v1/changes/:id/accept",
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
        operationId: "acceptChange",
        summary: "Accept a change out of `validating` — the human approval gate before `accepted`",
        tags: ["changes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const outcome = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // `object:write` AND `change:accept`, each at EVERY target. See docs/routes.md §76.
        await assertAcceptableAtEveryChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change: await getChange(tx, auth.orgId, request.params.id)
        });
        const result = await transitionChange(
          tx,
          {
            orgId: auth.orgId,
            changeObjectId: request.params.id,
            toState: "accepted",
            actorObjectId: auth.subjectObjectId,
            requestId: request.id,
            reason: request.body.reason ?? null,
            overrideFreeze: request.body.overrideFreeze
              ? { reason: request.body.reason ?? "" }
              : undefined
          },
          gateDeps
        );
        if (result.verdict === "block")
          return { blocked: result.blockedReason, decisionId: result.decision.id };
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
        404: ProblemSchema,
        409: ProblemSchema
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
      const outcome = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Write and accept at every target of the original. See docs/routes.md §77.
        await assertAcceptableAtEveryChangeTarget(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          change: await getChange(tx, auth.orgId, request.params.id)
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
      if (!outcome.ok) {
        throw conflict(outcome.blockedReason, { decisionId: outcome.decision.id });
      }
      reply.status(201).send(outcome.rollbackChange);
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
      openapi: {
        operationId: "listDecisions",
        summary: "List Decision records",
        tags: ["decisions"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The subject arm is offered only when a subject is pinned. See docs/routes.md §78.
        await assertDecisionReadable(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          decisionSubjectId: request.query.subjectId ?? null
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
      openapi: {
        operationId: "getDecision",
        summary: "Get a Decision record by id",
        tags: ["decisions"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const decision = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Loaded before it is scoped: the subject arm needs the row's own `subjectId`, and
        // resolving first is also what keeps an unknown decision id a 404 rather than a 403.
        const found = await getDecision(tx, auth.orgId, request.params.id);
        await assertDecisionReadable(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          decisionSubjectId: found.subjectId
        });
        return found;
      });
      reply.status(200).send(decision);
    }
  });
}
