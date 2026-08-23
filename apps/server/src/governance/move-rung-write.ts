import type { TenantTx } from "../db/tenant-tx.js";
import type { Permission } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  disableGovernanceMoveRung,
  enableGovernanceMoveRung,
  type GovernanceMoveTier
} from "./move-enforcement.js";

/**
 * THE RUNG WRITE'S EFFECTS, IN ONE PLACE — shared by every door that may enable or disable one.
 *
 * ============================================================================================
 * WHY THIS MODULE EXISTS RATHER THAN A SECOND COPY IN THE IaC APPLY PATH
 * ============================================================================================
 * `routes/governance-move.ts` was the only writer when the lattice was built. Adding the IaC surface
 * (charter principle 3: API -> SDK -> CLI -> IaC, the follow-up named in proposal
 * `governance-reach-on-containment-move.md` §9.6 Q4) makes `iac/plans-repo.ts`'s apply a SECOND door
 * into `governance_move_rungs`, and a rung write is not a row write — two things happen around it,
 * and both are obligations rather than niceties:
 *
 *  1. A DECISION IS RECORDED, under one kind, so `GET /decisions?kind=governance.move_enforcement`
 *     answers "every rung this org ever enabled or disabled" in one index descent. A second writer
 *     that skips it makes that sentence FALSE for whichever rungs happened to arrive through IaC —
 *     the class of self-contradiction this repo keeps finding in its own accepted documents — and
 *     breaks charter principle 6 for exactly the acts an auditor would go looking for.
 *  2. AN AUDIT EVENT IS APPENDED, hash-chained in the same transaction as the write.
 *
 * Both are inseparable from the row, so they live WITH the row rather than beside each caller. The
 * route and `iac/plans-repo.ts` call these two functions; neither reimplements any of it. This is
 * `dependencies/producer-declaration.ts`'s shape, applied unchanged — that module's header carries
 * the longer form of the argument.
 *
 * ============================================================================================
 * WHAT IS *NOT* HERE, AND WHY
 * ============================================================================================
 *  - THE AUTHORIZATION. It is the same pair at both doors ({@link governanceMoveRungScopeCheck}), but
 *    the doors CONSUME it differently: the route authorizes inline, while `iac/plans-repo.ts` pushes
 *    every check into one list its route drains to completion BEFORE any mutation runs. So the pair
 *    is expressed once and applied twice, exactly like `dependencyProducerScopeCheck`.
 *  - THE MONOTONE REFUSAL on a disable (409 while an upper rung is enabled). It lives in
 *    `move-enforcement.ts`'s `disableGovernanceMoveRung`, which both doors reach through here, so a
 *    manifest that drops a rung under an enabled ancestor fails its apply with the verb's own
 *    sentence rather than with a second, differently-worded copy.
 *  - THE "IS THERE A RUNG HERE AT ALL" CHECK. The route 404s on the caller's own `idOrUrn`; the IaC
 *    path 404s as an apply-time prune miss. Same rule, two genuinely different messages, and each
 *    door has already had to establish the answer before it gets here.
 *  - THE SUBJECT-TYPE CHECK (`assertRungSubjectType`). Same reason: the route runs it on a live
 *    lookup, the IaC path re-derives it from the STORED diff.
 */

/** The Decision kind every rung write records. One kind, so `GET /decisions?kind=…` answers "every
 *  rung ever enabled or disabled in this org" — a claim that only stays true while EVERY door writes
 *  this record, which is why the doors share this module. */
export const GOVERNANCE_MOVE_DECISION_KIND = "governance.move_enforcement";

/**
 * THE AUTHORITY EVERY RUNG WRITE TAKES — `policy:write` AT-OR-ABOVE THE SUBJECT (owner ruling
 * 2026-08-18, ADR-0038 §2), expressed ONCE so the route and the IaC apply path cannot drift apart.
 *
 * Enabling a rung is a governance-authoring act and is held to the same bar as authoring a policy;
 * `policy:write` is Administrator/Owner only (drizzle/0010:174). `authorize` expands strictly UPWARD
 * from the scope object, so naming the subject IS "at-or-above the subject".
 *
 * THE SHAPE IS A PAIR, NOT A CALL, because the two doors consume authority differently — see this
 * module's header, and `dependencies/producer-declaration.ts`'s `dependencyProducerScopeCheck`,
 * which this mirrors.
 */
export function governanceMoveRungScopeCheck(subjectObjectId: string): {
  permission: Permission;
  scopeObjectId: string;
} {
  return { permission: "policy:write", scopeObjectId: subjectObjectId };
}

export interface GovernanceMoveRungWriteInput {
  orgId: string;
  /** The acting principal. NEVER caller-supplied (principle 6): the route takes it from the bearer
   *  subject, IaC apply from the applying principal. */
  actorObjectId: string;
  requestId: string;
  /** The subject container, already resolved and type-checked by the door. `name` is carried so the
   *  Decision reads as a sentence about a container rather than about a uuid. */
  subject: { id: string; name: string };
  tier: GovernanceMoveTier;
  /** Operator-supplied note, when the door has one (the API verb's body). IaC has nowhere to put
   *  one — the manifest is the note. */
  note?: string;
}

/**
 * ENABLE: write the row, record the Decision, append the audit event. The whole act, so no door can
 * perform a fraction of it.
 *
 * Idempotent by construction — `enableGovernanceMoveRung` is an upsert, because re-stating an
 * enabled rung is what `scp apply` and an idempotent PUT do routinely. The Decision and the audit
 * event are written UNCONDITIONALLY on each call: somebody really did perform the act, and the
 * growth is bounded by human action rather than by a loop (`insertDecisionIfChanged` is the guard
 * for TIMER-driven writers, which this is not).
 */
export async function enableGovernanceMoveRungWithEffects(
  tx: TenantTx,
  input: GovernanceMoveRungWriteInput
): Promise<{ decisionId: string }> {
  const { orgId, actorObjectId, requestId, subject, tier, note } = input;
  const decision = await insertDecision(tx, {
    orgId,
    kind: GOVERNANCE_MOVE_DECISION_KIND,
    subjectId: subject.id,
    verdict: "enabled",
    inputContext: {
      tier,
      subjectObjectId: subject.id,
      enabledByObjectId: actorObjectId,
      ...(note === undefined ? {} : { note })
    },
    reasonTree: {
      summary:
        `governance:move enforcement enabled at ${tier} '${subject.name}' — every containment ` +
        `move of an object under it now requires 'governance:move' at-or-above the object AND ` +
        `at-or-above the destination`
    }
  });
  await enableGovernanceMoveRung(tx, {
    orgId,
    subjectObjectId: subject.id,
    tier,
    enabledByObjectId: actorObjectId,
    decisionId: decision.id
  });
  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "governance.move_enforcement.enable",
    subjectId: subject.id,
    reason: note ?? `enabled at ${tier}`,
    decisionId: decision.id,
    requestId
  });
  return { decisionId: decision.id };
}

/**
 * DISABLE: delete the row, record the Decision, append the audit event.
 *
 * THE DELETE RUNS FIRST, and the order is load-bearing: `disableGovernanceMoveRung` throws 409 while
 * an upper rung is enabled, so a refused disable must not leave a Decision claiming enforcement was
 * turned off. (The throw would roll the transaction back anyway; writing it first would still be a
 * record of something that did not happen, in a file the next reader would copy.)
 */
export async function disableGovernanceMoveRungWithEffects(
  tx: TenantTx,
  input: GovernanceMoveRungWriteInput
): Promise<{ decisionId: string }> {
  const { orgId, actorObjectId, requestId, subject, tier } = input;
  await disableGovernanceMoveRung(tx, { orgId, subjectObjectId: subject.id });
  const decision = await insertDecision(tx, {
    orgId,
    kind: GOVERNANCE_MOVE_DECISION_KIND,
    subjectId: subject.id,
    verdict: "disabled",
    inputContext: {
      tier,
      subjectObjectId: subject.id,
      disabledByObjectId: actorObjectId
    },
    reasonTree: {
      summary: `governance:move enforcement disabled at ${tier} '${subject.name}'`
    }
  });
  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "governance.move_enforcement.disable",
    subjectId: subject.id,
    reason: `disabled at ${tier}`,
    decisionId: decision.id,
    requestId
  });
  return { decisionId: decision.id };
}
