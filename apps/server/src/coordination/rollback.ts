import type { Change } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { getChangeRow, proposeChange, purposeOf, targetObjectIdsOf } from "./changes-repo.js";
import { insertDecision } from "./decisions-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Rollback-as-its-own-Change (DESIGN.md §9.4): "A rollback is its own Change, linked to the
 * original, referencing the prior known-good executor state... executed through the same
 * plan/wave machinery." Manual trigger only in M3 — automatic gate-failure triggers are M4.
 *
 * This function creates the rollback Change and writes the trigger Decision immediately (DESIGN
 * §9.4: "every rollback writes a Decision record naming its trigger") — BEFORE the rollback
 * change has done any work. The rollback then progresses through proposed -> ... -> promoted via
 * the exact same reconciliation loop as any other change (coordination/reconcile.ts), and once
 * ITS wave targets have been triggered with `TriggerIntent.kind: "rollback"` carrying each
 * target's captured `prior_state_ref`, the ORIGINAL change is transitioned to `rolled_back`
 * (coordination/reconcile.ts, on the rollback's own promotion) via the guarded transition
 * function like any other transition.
 */
export interface TriggerRollbackInput {
  orgId: string;
  originalChangeObjectId: string;
  actorObjectId: string;
  requestId: string;
  reason: string;
  /** DESIGN §9.4: "Triggers: automatic (gate/control failure policy...) or manual" — the
   *  rollback_trigger Decision's `inputContext.trigger` records WHICH, so the audit/explain trail
   *  can actually distinguish an operator's `scp change rollback` from
   *  `coordination/reconcile.ts`'s `autoRollbackOnFailure` policy firing, rather than every
   *  rollback reading as "manual" regardless of who/what triggered it. Explicit per call site
   *  (routes/changes.ts passes "manual", reconcile.ts passes "automatic") rather than inferred
   *  from `actorObjectId` — inferring from "is this the system actor" would silently mislabel any
   *  future system-triggered-but-still-effectively-manual path (e.g. an API automation acting as
   *  a service account). Defaults to "manual" so pre-M4 callers/tests need no changes. */
  trigger?: "manual" | "automatic";
}

export async function triggerRollback(
  tx: TenantTx,
  input: TriggerRollbackInput
): Promise<{ rollbackChange: Change }> {
  const original = await getChangeRow(tx, input.orgId, input.originalChangeObjectId);
  if (!["executing", "validating", "promoted"].includes(original.state)) {
    throw badRequest(
      `cannot roll back a change in state '${original.state}' — rollback is only meaningful once a change has executed something (executing/validating/promoted)`
    );
  }

  const originalObject = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.originalChangeObjectId);
  const targetObjectIds = targetObjectIdsOf(originalObject.properties);
  if (targetObjectIds.length === 0) {
    throw badRequest(`change '${input.originalChangeObjectId}' has no recorded targets to roll back`);
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
    // A rollback rolls the SAME pipeline as the change it undoes (M12 P4A) — inherited from the
    // original exactly as `targets` and the topology above already are. Defaulting to 'software'
    // here instead would point an infra change's rollback at the software pipeline: the wrong
    // executor, driven with the wrong ref, to undo an infra release.
    purpose: purposeOf(originalObject.properties),
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

  return { rollbackChange };
}
