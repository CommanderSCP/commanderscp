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
import { authorize, hasPermission } from "../authz/resolve.js";
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
import { conflict, forbidden, ProblemError } from "../errors.js";
import { serverOwnedSourceRefKeysIn } from "../federation/boundary-bundle-ref.js";

/**
 * `/changes`, `/change-sources`'s sibling `/decisions` sub-resource, and the guarded-transition
 * verbs (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). Routing note (documented, inherited from
 * routes/plans.ts's own note): DESIGN's `{id}:verb` shorthand does not survive Fastify's router
 * (find-my-way folds `id:verb` into a single param) — every verb here is a conventional
 * `POST /changes/{id}/verb` subpath instead, consistent with `/plans/{id}/apply`.
 *
 * `evaluate`/`coordinate`/`execute`/`validate` have NO route: those edges are entirely
 * engine-automatic in M3 (coordination/reconcile.ts) — there is no policy/control gate for a
 * human to satisfy before them yet (M4). `cancel`/`accept`/`rollback` are the only
 * human-triggerable edges, plus `propose` (the entry point) — matching
 * BUILD_AND_TEST.md's `scp change propose/accept/rollback/explain` CLI surface exactly, with
 * `cancel`/`list`/`get` alongside for completeness (the guarded transition function already
 * supports `cancel` from every pre-acceptance state; leaving it unreachable via the API would be
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

// ===========================================================================================
// AUTHORIZATION SCOPE FOR A CHANGE — the change's TARGETS (role-model.md §4.2, §8.4)
// ===========================================================================================
//
// WHY NOT `auth.orgId`, WHICH IS WHAT EVERY DOOR HERE USED TO PASS. `authz/resolve.ts`'s
// `scopeExpandCte` expands a checked scope UPWARD only, so `scopeObjectId: auth.orgId` is
// satisfiable by an ORG-ROOT binding and by nothing else. A principal who administers one service
// or one component could therefore hold `object:read`/`object:write` and still be refused the read
// and the accept of the release against their own estate — the read-surface blocker that made
// every scoped role in role-model.md §3 unusable.
//
// WHY NOT THE CHANGE ITSELF, WHICH IS THE OBVIOUS RE-SCOPE AND IS INERT. A change has no scope of
// its own: `objects.domain_id` for a change is the ORG ROOT for every one of the five internal
// `proposeChange` callers (they pass no `domainId` at all), `scp change propose` has no `--domain`
// flag, and route 1 of the scope walk goes from `change.id` straight back to that same
// `domain_id`. `scopeObjectId: change.id` would READ as a narrowing to a reviewer and BE the
// org-root pin it replaced. Measured in role-model.md §8.4, which also records why re-parenting
// changes onto a nearest-common-ancestor was rejected.
//
// So: the targets, read back off the persisted `properties.targets`.
//
//   * READ doors — ANY ONE target. A principal who can see one target is already told the whole
//     target list by `properties.targets` on the object they just read, so an every-target read
//     bar buys nothing and would make reads strictly HARDER to satisfy than the writes they gate.
//   * WRITE doors — EVERY target, so that the admin of one target of a five-target change cannot
//     accept the release into the four they have no standing on.
//
// THIS IS A PURE WIDENING. An org-root binding satisfies a check at any object below it, so every
// request that succeeded against the org-root pin still succeeds, identically.
//
// These live here rather than in `coordination/campaign-scope-authz.ts` (with the propose-time
// target check) only because this increment's file set is these two route files; they are exported
// so `routes/governance.ts`'s change-scoped doors use the SAME implementation and the read bar and
// the write bar cannot drift apart. Moving them next to `assertCoordinationTargetsWithinAuthority`
// is a mechanical follow-up.

/**
 * The target ids a change's authority is checked against — REFUSING an empty or malformed set.
 *
 * `assertCoordinationTargetsWithinAuthority` opens `if (!Array.isArray(input.targets)) return;`,
 * a silent PASS. That is safe where it lives — it guards PROPOSE, whose schema pins `targets` to
 * `.min(1)`, so the array is validated request input — and it would be a total authorization
 * bypass here, where the array is read back off a PERSISTED row that nothing re-validates. A
 * federation import writes a change object's `properties` verbatim (`import-repo.ts`'s
 * `object_upsert` branch), so "the row says something other than a non-empty string[]" is
 * reachable, not hypothetical. Refused for every principal including an org-root Owner: a change
 * whose target set cannot be read is a change whose authority cannot be established.
 *
 * Returns the ids VERBATIM and does not re-resolve them to objects. `proposeChange` resolves each
 * id-or-URN once at creation and stashes the resolved object ids here, so there is nothing left to
 * resolve — and re-resolving would 404 the moment a target had since been deleted, turning "cancel
 * the release against the component we just removed", the exact request an operator makes about
 * such a change, from a 200 into a 404.
 */
function changeTargetScopeIds(change: {
  id: string;
  properties: Record<string, unknown>;
}): string[] {
  const raw = change.properties?.targets;
  const ids = targetObjectIdsOf(change.properties);
  if (!Array.isArray(raw) || raw.length === 0 || ids.length !== raw.length) {
    throw forbidden(
      `change '${change.id}' has no readable target set (properties.targets must be a non-empty ` +
        `array of object ids), so authority over it cannot be established`
    );
  }
  return ids;
}

/**
 * READ bar: `object:read` at ANY ONE of the change's targets.
 *
 * `hasPermission` rather than `authorize` so a refusal at the first target falls through to the
 * next; one clear 403 naming the whole set is thrown if none matched. Note that `hasPermission`
 * can still THROW on a refusal it cannot trust (ADR-0037's depth-truncation probe) — a deep
 * containment chain above one target makes the whole read loud rather than silently answering
 * from the remaining targets, which is the direction that convention already chose.
 *
 * An org-root holder is matched by the FIRST target (the walk reaches the org root from any
 * object), so the common case still costs exactly one query.
 */
export async function assertReadableAtSomeChangeTarget(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
  }
): Promise<void> {
  const targetObjectIds = changeTargetScopeIds(input.change);
  for (const scopeObjectId of targetObjectIds) {
    const allowed = await hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.subjectObjectId,
      permission: "object:read",
      scopeObjectId
    });
    if (allowed) return;
  }
  throw forbidden(
    `subject '${input.subjectObjectId}' lacks 'object:read' at any target of change ` +
      `'${input.change.id}' (${targetObjectIds.join(", ")})`
  );
}

/**
 * WRITE bar: `object:write` at EVERY one of the change's targets — the same per-target loop
 * `assertCoordinationTargetsWithinAuthority` runs at propose time, so a change cannot be stopped,
 * accepted or rolled back by a principal who could not have proposed it.
 *
 * `accept` and `rollback` keep `object:write` FOR NOW. The purpose-built `change:accept`
 * permission is a LATER increment (role-model.md §5 step 3) and needs a migration to seed it onto
 * the roles that should hold it; this increment fixes the SCOPE only. Do not read the presence of
 * a per-target check here as evidence that the permission split has shipped.
 */
export async function assertWritableAtEveryChangeTarget(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    change: { id: string; properties: Record<string, unknown> };
  }
): Promise<void> {
  for (const scopeObjectId of changeTargetScopeIds(input.change)) {
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.subjectObjectId,
      permission: "object:write",
      scopeObjectId
    });
  }
}

/**
 * DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE (role-model.md §8.6).
 *
 * A Decision is the ACCOUNTABILITY RECORD for a verdict about its subject, so re-scoping the door
 * to `decision.subjectId` the way the change doors above re-scope to their targets would hand the
 * record to the party being held accountable — a component's own operator reading (and, once the
 * list is filterable, enumerating) every refusal ever recorded against them, with no
 * deployment-wide reader required. So the org-root arm is KEPT and the subject arm is ADDED:
 *
 *   `audit:read` at the ORG ROOT   — the auditor's read, deployment-wide, unchanged in reach
 *   OR `object:read` at the SUBJECT — so a scoped principal can see the verdicts about the objects
 *                                     they administer, which is the whole point of increment 2.5a
 *
 * The org-root arm demands `audit:read` where this door used to demand `object:read`. That narrows
 * nobody who exists: all five built-in roles are seeded with `audit:read`
 * (`drizzle/0002_rls_rbac_seed.sql`), there is no custom-role API to author one without it, and
 * where a subject IS named the second arm admits any org-root `object:read` holder anyway (the
 * scope walk reaches the org root from any object). It also puts this door on the permission
 * role-model.md §5 step 3 wants it on, before five purpose roles start being bound in the field.
 *
 * `hasPermission`, not `authorize`, on BOTH arms — an arm that threw could not be fallen through —
 * and one clear 403 naming both if neither holds.
 *
 * The subject is looked up with the NON-throwing `findObjectByIdOrUrnAnyType`: a decision outlives
 * its subject (that is what an audit record is for), and a subject that no longer resolves must
 * leave the org-root auditor's read working rather than 404 the accountability record away.
 */
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
  const auditWide = await hasPermission(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    permission: "audit:read",
    scopeObjectId: input.orgId
  });
  if (auditWide) return;
  if (input.decisionSubjectId) {
    const subject = await findObjectByIdOrUrnAnyType(tx, input.orgId, input.decisionSubjectId);
    if (
      subject &&
      (await hasPermission(tx, {
        orgId: input.orgId,
        subjectObjectId: input.subjectObjectId,
        permission: "object:read",
        scopeObjectId: subject.id
      }))
    ) {
      return;
    }
  }
  throw forbidden(
    `subject '${input.subjectObjectId}' lacks 'audit:read' at the org root` +
      (input.decisionSubjectId
        ? ` and 'object:read' at decision subject '${input.decisionSubjectId}'`
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
      // The server-owned `sourceRef` keys (`boundaryBundleChecksums`, `promotionExports`) are
      // stamped by the exporter/importer and RENDERED as facts ("manifest signed for <peer>") —
      // a caller who plants one would make the pipeline claim a signing that never happened.
      // Refused loudly rather than stripped silently: `sourceRef` is otherwise kept verbatim, so
      // a caller must learn its payload was not stored as sent. Checked before any tx is opened.
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
            scopeObjectId: declaredParent ?? auth.orgId
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
        // Resolved first, then scoped — see `GET /changes/{id}` above for why that order matters.
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
            // ADR-0028 increment 4 — which stage dependency is withholding a trigger, RE-EVALUATED
            // NOW. Deliberately not read off the `stage_dependency` Decision in `decisions` above:
            // that row is a historical record with no clearing counterpart, so it still says `hold`
            // long after the hold released (and on an outpost the latest row of that kind is the
            // import-time `allow`). Null for a change that coupled nothing.
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
        // `ChangeWaveSchema.heldTargetCount`'s SECOND HALF: `plan` already carries the freeze-held
        // count (`getLatestPlanForChange` computes that half unconditionally). This handler is the
        // one caller that ALSO computes `stageDependencyStatus`, so it is the one place that can
        // add the stage-dependency-held count without a second evaluation of that predicate. Only
        // `stageDependencyStatus.waveIndex` can carry any (that status only ever evaluates the
        // active wave), so every other wave's count is freeze-only, unaffected.
        //
        // NOT DISJOINT BY DEFAULT — the two halves are computed by two independent predicates
        // (`resolveWaveTargetFreezeHolds` and `evaluateStageDependencies`) over the SAME candidate
        // set (the active wave's `pending`/`triggering` targets), unlike `reconcile.ts`'s admission
        // loop, where only one `continue` can fire per target per tick, making the two hold sets
        // disjoint BY CONSTRUCTION (reconcile.ts's invariant 4 on the freeze-hold `continue`). A
        // target that is simultaneously frozen and dependency-held would otherwise be counted in
        // BOTH halves — a one-target wave reporting `heldTargetCount: 2`. Exclude any target this
        // wave's freeze half already counted (`activeWave.targets[i].hold` is set for exactly
        // those) before adding the stage-dependency half.
        if (plan && stageDependencyStatus) {
          const activeWave = plan.waves.find(
            (w) => w.waveIndex === stageDependencyStatus.waveIndex
          );
          if (activeWave) {
            const freezeHeldTargetIds = new Set(
              activeWave.targets.filter((t) => t.hold).map((t) => t.targetObjectId)
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
            // M22.8 — the SECOND projection of `ControlRunSchema`, filled in the same increment as
            // the first. `/control-runs` and `/explain` both render this shape, and shipping the
            // crossing on one but not the other would make "which run authorized production" a
            // question whose answer depends on which endpoint you happened to open — the exact
            // half-installed shape a filterless census of `ControlRunSchema`'s consumers exists to
            // catch. Those two handlers are the complete census.
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
        // `object:write` at EVERY target. CANCEL IS NOT ACCEPT: it STOPS a release rather than
        // authorizing one, so it deliberately stays on the generic write verb. Folding it into the
        // future `change:accept` (role-model.md §5 step 3) would make a cancel-only role — the
        // shape an incident responder wants — inexpressible.
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
        // `object:write` at EVERY target — one target's admin must not be able to accept the
        // release into the other four. STILL `object:write`, NOT `change:accept`: that permission
        // does not exist yet (role-model.md §5 step 3 seeds it in a migration). This increment
        // fixes the SCOPE only.
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
        // `object:write` at EVERY target of the ORIGINAL change — a rollback proposes a NEW change
        // carrying that same target set (`coordination/rollback.ts` reads it with the very same
        // `targetObjectIdsOf`), so anything less would let one target's admin drive a release into
        // the rest. Also still `object:write`, for the reason `accept` above records.
        await assertWritableAtEveryChangeTarget(tx, {
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
        // The subject arm is offered only when the caller PINNED a subject — an unfiltered listing
        // spans every subject in the org, so nothing narrower than the org-root audit read can
        // stand behind it. Row-level filtering of an unpinned listing is the LIST half of this
        // blocker (role-model.md §8.2/§8.7, increment 2.5b) and is deliberately not attempted here:
        // every list repo derives `nextCursor` from the last UNFILTERED row, so post-filtering a
        // page silently shrinks it after the LIMIT.
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
