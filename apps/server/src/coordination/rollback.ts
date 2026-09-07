import type { Change, Decision } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { getChangeRow, proposeChange, typeOf, targetObjectIdsOf } from "./changes-repo.js";
import { insertDecision } from "./decisions-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { enforceLocalChangeAuthority } from "./transition.js";

/** Rollback-as-its-own-Change (DESIGN.md §9.4). See docs/coordination.md §843. */
export interface TriggerRollbackInput {
  orgId: string;
  originalChangeObjectId: string;
  actorObjectId: string;
  requestId: string;
  reason: string;
  /** DESIGN §9.4: "Triggers: automatic. See docs/coordination.md §844. */
  trigger?: "manual" | "automatic";
}

export type TriggerRollbackResult =
  { ok: true; rollbackChange: Change } | { ok: false; decision: Decision; blockedReason: string };

export async function triggerRollback(
  tx: TenantTx,
  input: TriggerRollbackInput
): Promise<TriggerRollbackResult> {
  const original = await getChangeRow(tx, input.orgId, input.originalChangeObjectId);
  const originalObject = await getObjectByIdOrUrnAnyType(
    tx,
    input.orgId,
    input.originalChangeObjectId
  );

  // S10 single-writer guard (tracked-security-followups): checked BEFORE the state-machine
  // validation below — "you don't own this change" is a more fundamental refusal than "wrong
  // state", and must not be masked by it. Keys on the OBJECT's `originDomainId`, never on
  // `importedFromDomain` — see `transition.ts`'s `enforceLocalChangeAuthority` doc comment.
  const authority = await enforceLocalChangeAuthority(tx, {
    orgId: input.orgId,
    changeObjectId: input.originalChangeObjectId,
    originDomainId: originalObject.originDomainId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    reason: input.reason
  });
  if (!authority.ok) {
    return { ok: false, decision: authority.decision, blockedReason: authority.blockedReason };
  }

  if (!["executing", "validating", "accepted"].includes(original.state)) {
    throw badRequest(
      `cannot roll back a change in state '${original.state}' — rollback is only meaningful once a change has executed something (executing/validating/accepted)`
    );
  }

  const targetObjectIds = targetObjectIdsOf(originalObject.properties);
  if (targetObjectIds.length === 0) {
    throw badRequest(
      `change '${input.originalChangeObjectId}' has no recorded targets to roll back`
    );
  }

  const { change: rollbackChange } = await proposeChange(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    name: `Rollback of ${originalObject.name}`,
    sourceKind: "rollback",
    sourceRef: { rollbackOf: input.originalChangeObjectId },
    targets: targetObjectIds,
    topologyIdOrUrn: original.topologyObjectId ?? undefined,
    // A rollback rolls the SAME pipeline as the change it undoes (M12 P4A / ADR-0007) — inherited
    // from the original exactly as `targets` and the topology above already are. Defaulting to the
    // server default here instead would point an `infrastructure` change's rollback at a
    // `configuration` pipeline: the wrong executor, driven with the wrong ref, to undo the release.
    type: typeOf(originalObject.properties),
    rollbackOfObjectId: input.originalChangeObjectId
  });

  const trigger = input.trigger ?? "manual";
  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "rollback_trigger",
    subjectId: input.originalChangeObjectId,
    verdict: "rollback",
    inputContext: {
      trigger,
      actorId: input.actorObjectId,
      reason: input.reason,
      rollbackChangeObjectId: rollbackChange.id,
      originalState: original.state
    },
    reasonTree: {
      summary:
        trigger === "automatic"
          ? `automatic rollback triggered by policy: ${input.reason}`
          : `manual rollback triggered by operator: ${input.reason}`,
      rollbackChange: rollbackChange.id
    }
  });

  return { ok: true, rollbackChange };
}
