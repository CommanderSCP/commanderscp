import type { TenantTx } from "../db/tenant-tx.js";
import type { Permission } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  disableGovernanceMoveRung,
  enableGovernanceMoveRung,
  type GovernanceMoveTier
} from "./move-enforcement.js";

/** THE RUNG WRITE'S EFFECTS, IN ONE PLACE. See docs/governance.md §259. */

/** The Decision kind every rung write records. One kind, so `GET /decisions?kind=…` answers "every
 *  rung ever enabled or disabled in this org" — a claim that only stays true while EVERY door writes
 *  this record, which is why the doors share this module. */
export const GOVERNANCE_MOVE_DECISION_KIND = "governance.move_enforcement";

/** THE AUTHORITY EVERY RUNG WRITE TAKES. See docs/governance.md §260. */
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

/** Enable: write the row, record it, append the event. See docs/governance.md §261. */
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

/** Disable: delete the row, record it, append the event. See docs/governance.md §262. */
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
