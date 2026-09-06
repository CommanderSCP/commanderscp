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

// AUTHORIZATION SCOPE FOR A CHANGE. See docs/routes/changes.md §1.

/**
 * THE OBJECT A CHANGE-SCOPED DOOR SCOPES AT — resolved first, and 404 unless it really IS a change.
 *
 * Two separate things force the resolve-then-scope order and the type check, and both of them are
 * cases where an org-root Owner used to get an answer and must still get the SAME answer:
 *
 *  1. `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence, so scoping at an
 *     unresolved path param expands a nonexistent id to a one-row set matching no binding — turning
 *     a 404 into a 403 for everyone, org-root Owner included (role-model.md §8.7's ⚠️).
 *  2. NOT EVERY OBJECT IS A CHANGE, and the target-set refusal below fires on anything with no
 *     target set. `GET /changes/{idOrUrn}/control-runs` reached its repo with the raw param and
 *     filtered `control_runs.change_object_id = $1`, so a component's id (or any other uuid) came
 *     back `200 []`. Without this check the target-set refusal turns that into a **403** — an
 *     authorization failure reported to a principal who has full authority over the whole org. A
 *     404 is the honest answer to "that is not a change", and it is a BETTER answer than `200 []`;
 *     a 403 is not an answer at all.
 *
 * The 404 message is deliberately IDENTICAL to `getChange`'s and to the not-found-at-all message,
 * so "no such object" and "an object, but not a change" are indistinguishable on the wire. That
 * closes the existence oracle a pre-authorization resolve would otherwise open on the doors that
 * take a caller-supplied change id (`GET /approvals?changeId=`, `/changes/{idOrUrn}/control-runs`):
 * a principal with no binding anywhere now learns only "this uuid is not a change I will talk to
 * you about", never whether some object with that id exists.
 *
 * ------------------------------------------------------------------------------------------------
 * A SOFT-DELETED CHANGE IS STILL RESOLVED, AND THAT IS THE DIFFERENCE BETWEEN THE TWO 404s
 * ------------------------------------------------------------------------------------------------
 * This function answers ONE question — "which object is this door scoped at?" — and it must answer
 * it for a tombstoned change, because `changes-repo.ts`'s `fetchChangeWithObject` (behind
 * `getChange`, and therefore behind `GET /changes/{id}`, `/explain`, `cancel`, `accept` and
 * `rollback`) carries no `deleted_at` filter at all. Every one of those doors served a soft-deleted
 * change before 2.5a and still does. Four doors reach their change through THIS function instead —
 * `/changes/{idOrUrn}/control-runs`, `/control-runs/{id}/findings`, `GET /approvals/{id}` and its
 * `/votes` — and none of them resolved the change at all before 2.5a, so a live-rows-only lookup
 * here turned four 200s into 404s for an org-root Owner. That is a regression, not a decision.
 *
 * So the two answers are kept apart, deliberately:
 *
 *   * "THIS ID IS NOT A CHANGE" stays a 404 for everybody. It is what 2.5a introduced on purpose,
 *     replacing a misleading `200 []`, and it is the honest answer.
 *   * "THIS CHANGE WAS SOFT-DELETED" is NOT this function's business. `deletedAt` is handed back so
 *     a door that genuinely had a 404-on-tombstone before 2.5a can keep it — today exactly one
 *     does (`GET /approvals?changeId=`, whose pre-2.5a `getObjectByIdOrUrnAnyType` filtered
 *     tombstones), and it re-applies that 404 AFTER the authorization check so the order it had
 *     before (authorize, then resolve) is preserved on the wire.
 *
 * LIVE ROWS WIN. The lookup is tried live-only first and only then with tombstones included, so a
 * URN reused after a tombstone resolves to the live change exactly as it does today; the second
 * query runs only when the first found nothing, which is the path that used to 404.
 */
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

/**
 * The target ids a change's authority is checked against, DEDUPED — or `null` when the persisted
 * set is empty or malformed, which every caller must treat as "authority cannot be established".
 *
 * `assertCoordinationTargetsWithinAuthority` opens `if (!Array.isArray(input.targets)) return;`,
 * a silent PASS. That is safe where it lives — it guards PROPOSE, whose schema pins `targets` to
 * `.min(1)`, so the array is validated request input — and it would be a total authorization
 * bypass here, where the array is read back off a PERSISTED row that nothing re-validates. A
 * federation import writes a change object's `properties` verbatim (`import-repo.ts`'s
 * `object_upsert` branch), so "the row says something other than a non-empty string[]" is
 * reachable, not hypothetical. A SCOPED principal is refused outright on such a row: authority
 * over it cannot be established, and the alternative is a total authorization bypass.
 *
 * AN ORG-ROOT PRINCIPAL IS NOT, because the org-root arm is evaluated before this value is ever
 * consulted — see {@link checkAtOrgRootOrChangeTargets}, which is where the ordering lives.
 *
 * DEDUPED, per role-model.md §8.4 ("read `targetObjectIdsOf(change.properties)`, dedupe,
 * `authorize` at each"). A change may legitimately list the same object twice, and without this a
 * write door would run the same `authorize` — and persist the same Decision + audit row — once per
 * repeat, while a read door would re-run the same refused walk. Deduping cannot change any verdict:
 * `hasPermission`/`authorize` are pure in `scopeObjectId`, so the second call at an id can only
 * repeat the first one's answer. The malformed check above runs on the RAW array, before the
 * dedupe, so `["x","x"]` is still a well-formed two-entry set and not a length mismatch.
 *
 * Returns the ids VERBATIM and does not re-resolve them to objects. `proposeChange` resolves each
 * id-or-URN once at creation and stashes the resolved object ids here, so there is nothing left to
 * resolve — and re-resolving would 404 the moment a target had since been deleted, turning "cancel
 * the release against the component we just removed", the exact request an operator makes about
 * such a change, from a 200 into a 404.
 */
function readChangeTargetScopeIds(change: {
  properties: Record<string, unknown>;
}): string[] | null {
  const raw = change.properties?.targets;
  const ids = targetObjectIdsOf(change.properties);
  if (!Array.isArray(raw) || raw.length === 0 || ids.length !== raw.length) return null;
  return [...new Set(ids)];
}

/**
 * THE ORDER BOTH CHANGE BARS RUN IN, in one place: **org-root arm first, target set second.**
 *
 * Two properties have to hold at once here, and only this ordering gives both.
 *
 *  1. **PURE WIDENING.** Every request that succeeded against the pre-2.5a `scopeObjectId:
 *     auth.orgId` pin must still succeed. The pre-2.5a check never looked at `properties.targets`
 *     at all, so nothing about that array may decide an org-root principal's request.
 *  2. **TRAP 4 — a persisted target set is not validated input.** `properties.targets` is read back
 *     off a row, and `federation/import-repo.ts`'s `object_upsert` branch writes a peer's
 *     `properties` VERBATIM (`federation/scope-filter.ts` whitelists `typeId === "change"` for that
 *     branch). So an empty, missing or malformed target set arrives on real rows. Treating it as
 *     "no targets to check, therefore nothing refuses" would be a total authorization bypass —
 *     `Array.prototype.every` over `[]` is vacuously true — so a SCOPED principal must be refused
 *     explicitly.
 *
 * Reading the target set FIRST and throwing on it, which is what this code did until now, made (2)
 * defeat (1): an org-root Owner was handed a 403 on a row a peer had mangled, on a door where the
 * pre-2.5a check would have admitted them without ever reading the row. Reading it SECOND costs
 * nothing and is not a weakening of (2), because the org-root arm is not a "targets are fine"
 * verdict — it is the whole pre-2.5a check, unchanged, at a scope no target can influence.
 *
 * THE ORG-ROOT ARM IS ONE DEPTH-0 EXPANSION, so running it first is also the cheap order:
 * `scopeExpandCte` seeded at the org root produces a single row, and it returns before any target
 * is walked. {@link checkAtOrgRootOrScopes} evaluates it first by construction and refuses an empty
 * `scopeObjectIds` explicitly in both quantifiers, so passing `[]` for an unreadable target set
 * falls back to the org-root arm ALONE rather than passing vacuously — which is precisely the shape
 * (1) and (2) need.
 *
 * The verdict distinguishes the two refusals so each caller can throw its own message: "the row has
 * no readable target set" is a statement about the ROW, "you lack X at the org root and at <these
 * targets>" is a statement about the CALLER, and collapsing them would tell an operator the wrong
 * thing to fix.
 */
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

/**
 * READ bar: `object:read` at the ORG ROOT **or** at ANY ONE of the change's targets.
 *
 * `hasPermission` rather than `authorize` throughout (inside {@link checkAtOrgRootOrScopes}) so a
 * refusal at one arm falls through to the next; one clear 403 naming the whole target set is thrown
 * if none matched. Note that `hasPermission` can still THROW on a refusal it cannot trust
 * (ADR-0037's depth-truncation probe) — a deep containment chain above one target makes the whole
 * read loud rather than silently answering from the remaining targets, which is the direction that
 * convention already chose.
 *
 * THE ORG-ROOT ARM IS WHY THIS IS NOT JUST A LOOP OVER THE TARGETS. It used to be enough to say
 * "an org-root holder is matched by the FIRST target, because the walk reaches the org root from
 * any object" — and that sentence is false for a target whose containment parents have been
 * tombstoned, where the walk reaches nothing at all. See the block above and
 * `authz/org-root-arm.ts`. The org-root arm is also still the ONE-QUERY common case for an org-root
 * holder: it is tried first and returns before any target is walked — and, per
 * {@link checkAtOrgRootOrChangeTargets}, before the persisted target set is even inspected.
 */
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

/**
 * WRITE bar: `object:write` at the ORG ROOT **or** at EVERY one of the change's targets — the same
 * per-target loop `assertCoordinationTargetsWithinAuthority` runs at propose time, so a change
 * cannot be stopped, accepted or rolled back by a principal who could not have proposed it.
 *
 * The org-root arm is the same widening the read bar takes and for the same reason (a tombstoned
 * ancestor cuts a target's chain), and it is tried FIRST — before the persisted target set is read
 * at all ({@link checkAtOrgRootOrChangeTargets}), which is what keeps the trap-4 refusal from
 * reaching a principal the pre-2.5a check would have admitted. Running it first also keeps a `deny`
 * bound below the org root exactly as inert as the org-root pin left it, rather than newly
 * honouring it. See `authz/org-root-arm.ts`.
 *
 * THE REFUSAL STILL NAMES THE ONE TARGET THE ACTOR LACKS, not the whole set: that is what
 * `OrgRootOrScopedVerdict`'s `refusedScopeObjectId` carries back, and the message is
 * deliberately word-for-word `authorize()`'s so the wire answer is unchanged from the per-target
 * loop this replaced.
 *
 * `cancel` TAKES THIS BAR ALONE. `accept` and `rollback` compose
 * {@link assertAcceptableAtEveryChangeTarget}, which runs this one FIRST and then demands
 * `change:accept` on top of it — see there for why cancel is deliberately left out.
 */
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

/** ONE EVERY-TARGET WRITE BAR, PARAMETERISED BY PERMISSION. See docs/routes/changes.md §2. */
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

/**
 * ACCEPT bar: {@link assertWritableAtEveryChangeTarget} **and then** `change:accept`, each at the
 * ORG ROOT **or** at EVERY one of the change's targets (role-model.md §1.3f/§4.3/§8.4;
 * drizzle/0099).
 *
 * ADDED, NEVER SUBSTITUTED. `object:write` at every target is still demanded and is still checked
 * FIRST, so this door only ever refuses MORE principals than it did before — a subject who could
 * not accept yesterday cannot accept today by holding `change:accept` alone. Running the generic
 * bar first also keeps the refusal an operator sees for the ordinary "you have no standing on
 * target B" case byte-identical to the one 2.5a shipped; the `change:accept` refusal is reached
 * only by a principal who genuinely does administer every target.
 *
 * SAME LOOP, SAME QUANTIFIER, SAME ORG-ROOT-ARM ORDERING. Both bars go through
 * {@link checkAtOrgRootOrChangeTargets}, so the pure-widening property (the org-root arm is
 * evaluated before the persisted target set is even read) and the trap-4 refusal (an empty,
 * missing or malformed `properties.targets` refuses a SCOPED principal explicitly rather than
 * passing vacuously) hold for the new bar exactly as they do for the old one. Writing a second
 * hand-rolled loop here is how those two properties would have silently diverged.
 *
 * EVERY TARGET, not any: a ComponentAdmin over one target of a five-target change must not be able
 * to accept the release into the four they have no standing on.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY `cancel` DOES NOT COMPOSE THIS — the boundary, stated where it is easiest to erase
 * ------------------------------------------------------------------------------------------------
 * Cancelling STOPS a release; accepting and rolling back AUTHORIZE one (a rollback proposes a NEW
 * change carrying the original's target set and drives it through the same wave machinery). Folding
 * cancel in would make a cancel-only incident-responder role — hold `object:write`, stop a bad
 * release, authorize nothing — inexpressible, and that is the role an org most obviously wants to
 * seat on-call. `routes/changes.ts`'s cancel handler therefore calls
 * {@link assertWritableAtEveryChangeTarget} directly and must keep doing so.
 *
 * ------------------------------------------------------------------------------------------------
 * THIS IS THE ONE INTENTIONALLY BREAKING GRANT IN THE ROLE DESIGN
 * ------------------------------------------------------------------------------------------------
 * drizzle/0099 grants `change:accept` to Owner, Administrator, OrgAdmin, ServiceAdmin and
 * ComponentAdmin, and DELIBERATELY NOT to Operator or Approver. Both of those hold `object:write`
 * and can accept and roll back releases on every deployment today, and on upgrade they stop being
 * able to. That is the intent — accepting a release into production is not the same authority as
 * editing the graph, and it was only ever the same permission because the cumulative ladder had no
 * way to say otherwise (role-model.md §0). It has to be ANNOUNCED, not discovered in a 403.
 */
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

// THE VERDICT-READ RULE. See docs/routes/changes.md §3.

/** DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE. See docs/routes/changes.md §4. */
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
        //
        // ONE BAR for the `decisions` this response embeds: the change's own read bar IS the
        // verdict-read rule's second arm ("a principal who may read the thing a verdict is about
        // may read the verdict about it"), so everything served here is also served by
        // `GET /decisions/{id}` — see THE VERDICT-READ RULE at the top of this file. That was not
        // true before: `/decisions/{id}`'s subject arm checked `object:read` at the change ITSELF,
        // which for a change means the org root, so this door served rows that one refused.
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
        // wave's freeze half already counted before adding the stage-dependency half.
        //
        // `hold.freezes.length > 0`, NOT the mere PRESENCE of `hold`. Those were the same test
        // until increment 8 gave `hold` a second half (`continuousTests`): a target held only by a
        // continuous probe now carries a `hold` with an EMPTY `freezes`, and reading presence would
        // silently start treating it as freeze-held and drop it from the stage-dependency count —
        // an undercount produced by a field that has nothing to do with either half being added.
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
        // `object:write` at EVERY target, and DELIBERATELY NOT `change:accept` — this is the one
        // door of the three that does not compose `assertAcceptableAtEveryChangeTarget`. CANCEL IS
        // NOT ACCEPT: it STOPS a release rather than authorizing one. Folding it into
        // `change:accept` (role-model.md §5 step 3, shipped in drizzle/0099) would make a
        // cancel-only role — the shape an incident responder wants — inexpressible, so an Operator
        // who can no longer accept can still stop a bad release.
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
        // `object:write` AND `change:accept`, each at EVERY target — one target's admin must not
        // be able to accept the release into the other four, and accepting a release is no longer
        // the same authority as editing the graph (role-model.md §5 step 3, drizzle/0099).
        // BREAKING, DELIBERATELY: Operator and Approver hold `object:write` and are NOT granted
        // `change:accept`, so a principal on either rung stops being able to accept on upgrade.
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
        // `object:write` AND `change:accept` at EVERY target of the ORIGINAL change — a rollback
        // proposes a NEW change carrying that same target set (`coordination/rollback.ts` reads it
        // with the very same `targetObjectIdsOf`) and drives it through the same wave machinery, so
        // it AUTHORIZES a release rather than stopping one. Anything less would also let one
        // target's admin drive a release into the rest. Same breaking grant as `accept` above.
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
