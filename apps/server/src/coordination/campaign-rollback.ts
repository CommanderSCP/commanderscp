import type { Change } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, describeError } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { getChangeRow } from "./changes-repo.js";
import { triggerRollback } from "./rollback.js";
import { insertDecision } from "./decisions-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { authoritativeCampaignMembers } from "./campaign-repo.js";

/** Campaign-scoped rollback across member changes. See docs/coordination.md §214. */
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

const ROLLBACK_ELIGIBLE_STATES = new Set(["executing", "validating", "accepted"]);

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

  // AUTHORITATIVE membership — plan-compiled `campaign_wave_targets`, never raw `coordinates`
  // edges (see the module doc for why this is the security boundary).
  const members = await authoritativeCampaignMembers(tx, input.orgId, campaignObject.id);

  const result: CampaignRollbackResult = { rolledBack: [], skipped: [] };

  for (const member of members) {
    const memberChangeObjectId = member.memberChangeObjectId;
    let state: string;
    try {
      state = (await getChangeRow(tx, input.orgId, memberChangeObjectId)).state;
    } catch {
      // The member Change row is gone (shouldn't happen for a plan-compiled member) — skip rather
      // than abort the batch.
      result.skipped.push({
        originalChangeObjectId: memberChangeObjectId,
        reason: "member change not found"
      });
      continue;
    }
    if (!ROLLBACK_ELIGIBLE_STATES.has(state)) {
      result.skipped.push({
        originalChangeObjectId: memberChangeObjectId,
        reason: `not eligible from state '${state}'`
      });
      continue;
    }

    // Belt-and-suspenders per-target authority re-check. See docs/coordination.md §215.
    const authorized = await hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "object:write",
      scopeObjectId: member.targetObjectId
    });
    if (!authorized) {
      result.skipped.push({
        originalChangeObjectId: memberChangeObjectId,
        reason: `actor lacks 'object:write' over target '${member.targetObjectId}' — not reverted`
      });
      continue;
    }

    try {
      const outcome = await triggerRollback(tx, {
        orgId: input.orgId,
        originalChangeObjectId: memberChangeObjectId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        reason: input.reason,
        trigger: "manual"
      });
      if (!outcome.ok) {
        // S10 single-writer guard: this member's change is authoritatively owned by another
        // federation domain — refused exactly like a standalone `POST /changes/{id}/rollback`
        // would be, skipped in this campaign's result rather than aborting the other members.
        result.skipped.push({
          originalChangeObjectId: memberChangeObjectId,
          reason: outcome.blockedReason
        });
        continue;
      }
      result.rolledBack.push({
        originalChangeObjectId: memberChangeObjectId,
        rollbackChange: outcome.rollbackChange
      });
    } catch (err) {
      // `describeError`, not `err.message`. See docs/coordination.md §216.
      result.skipped.push({
        originalChangeObjectId: memberChangeObjectId,
        reason: describeError(err)
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
