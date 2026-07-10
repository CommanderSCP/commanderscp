import { and, eq } from "drizzle-orm";
import type { Change } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { relationships } from "../db/schema.js";
import { badRequest } from "../errors.js";
import { getChangeRow } from "./changes-repo.js";
import { triggerRollback } from "./rollback.js";
import { insertDecision } from "./decisions-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/**
 * Campaign-scoped rollback (DESIGN.md §9.4/§9.5, BUILD_AND_TEST.md §8 M5) — "rolling back a
 * campaign reverts its promoted member targets through the same wave/rollback machinery, each
 * producing a Decision." Deliberately does NOT introduce a campaign-level rollback lifecycle: it
 * finds every member Change (via the `coordinates` relationships `campaign-reconcile.ts` created)
 * currently eligible for rollback (`executing`/`validating`/`promoted` — the exact same
 * eligibility `coordination/rollback.ts`'s `triggerRollback` itself enforces) and calls that SAME,
 * completely unmodified function once per member — never a new rollback code path. Available
 * regardless of the campaign's own overall (derived) status: DESIGN §9.4 rollback is "always
 * available", and the flagship scenario is rolling back a campaign that is ITSELF still `blocked`
 * on a later wave (its earlier, promoted wave(s) are exactly what this reverts).
 *
 * One member's rollback failing (e.g. a target that was never actually promoted, or a rollback
 * already in flight) never aborts the rest of the batch — mirrors every other per-item loop in
 * this milestone's reconciler (coordination/campaign-reconcile.ts) and M3's own
 * `coordination/reconcile.ts`.
 *
 * SECURITY-SENSITIVE (M5 adversarial-review surface — "campaign rollback must not revert targets
 * outside the actor's authority"): every reverted member Change was itself only ever proposed for
 * a target the ORIGINAL campaign-creating actor was authorized against
 * (`campaign-repo.ts`'s `proposeCampaign` per-target check) — there is no additional authority
 * surface to re-check here beyond what `POST /campaigns/{id}/rollback`'s route handler already
 * requires of the actor triggering the rollback itself (the same `object:write` scope check
 * `POST /changes/{id}/rollback` already applies).
 */
export interface TriggerCampaignRollbackInput {
  orgId: string;
  campaignObjectId: string;
  actorObjectId: string;
  requestId: string;
  reason: string;
}

export interface CampaignRollbackResult {
  rolledBack: { originalChangeObjectId: string; rollbackChange: Change }[];
  skipped: { originalChangeObjectId: string; reason: string }[];
}

const ROLLBACK_ELIGIBLE_STATES = new Set(["executing", "validating", "promoted"]);

export async function triggerCampaignRollback(
  tx: TenantTx,
  input: TriggerCampaignRollbackInput
): Promise<CampaignRollbackResult> {
  // Ensure the campaign object itself exists (and is actually a campaign) before doing anything —
  // `getObjectByIdOrUrnAnyType` throws 404 otherwise, matching every other campaign route's
  // not-found behavior.
  const campaignObject = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.campaignObjectId);
  if (campaignObject.typeId !== "campaign") {
    throw badRequest(`'${input.campaignObjectId}' is not a campaign`);
  }

  const memberEdges = await tx
    .select({ toId: relationships.toId })
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, input.orgId),
        eq(relationships.typeId, "coordinates"),
        eq(relationships.fromId, campaignObject.id)
      )
    );

  const result: CampaignRollbackResult = { rolledBack: [], skipped: [] };

  for (const edge of memberEdges) {
    const memberChangeObjectId = edge.toId;
    let state: string;
    try {
      state = (await getChangeRow(tx, input.orgId, memberChangeObjectId)).state;
    } catch {
      continue; // `coordinates` can point at a sub-campaign too (DESIGN §9.5) — not a Change, skip.
    }
    if (!ROLLBACK_ELIGIBLE_STATES.has(state)) {
      result.skipped.push({ originalChangeObjectId: memberChangeObjectId, reason: `not eligible from state '${state}'` });
      continue;
    }
    try {
      const { rollbackChange } = await triggerRollback(tx, {
        orgId: input.orgId,
        originalChangeObjectId: memberChangeObjectId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        reason: input.reason,
        trigger: "manual"
      });
      result.rolledBack.push({ originalChangeObjectId: memberChangeObjectId, rollbackChange });
    } catch (err) {
      result.skipped.push({
        originalChangeObjectId: memberChangeObjectId,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "rollback_trigger",
    subjectId: campaignObject.id,
    verdict: "rollback",
    inputContext: {
      trigger: "manual",
      actorId: input.actorObjectId,
      reason: input.reason,
      rolledBack: result.rolledBack.map((r) => r.originalChangeObjectId),
      skipped: result.skipped
    },
    reasonTree: {
      summary: `campaign rollback triggered by operator: ${input.reason} — ${result.rolledBack.length} member change(s) rolled back, ${result.skipped.length} skipped`
    }
  });

  return result;
}
