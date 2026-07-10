import type { Change } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { getChangeRow } from "./changes-repo.js";
import { triggerRollback } from "./rollback.js";
import { insertDecision } from "./decisions-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { authoritativeCampaignMembers } from "./campaign-repo.js";

/**
 * Campaign-scoped rollback (DESIGN.md §9.4/§9.5, BUILD_AND_TEST.md §8 M5) — "rolling back a
 * campaign reverts its promoted member targets through the same wave/rollback machinery, each
 * producing a Decision." Deliberately does NOT introduce a campaign-level rollback lifecycle: it
 * finds every member Change currently eligible for rollback (`executing`/`validating`/`promoted` —
 * the exact same eligibility `coordination/rollback.ts`'s `triggerRollback` itself enforces) and
 * calls that SAME, completely unmodified function once per member — never a new rollback code path.
 * Available regardless of the campaign's own overall (derived) status: DESIGN §9.4 rollback is
 * "always available", and the flagship scenario is rolling back a campaign that is ITSELF still
 * `blocked` on a later wave (its earlier, promoted wave(s) are exactly what this reverts).
 *
 * SECURITY (M5 CRITICAL, adversarial review — the headline campaign coordinates-authz invariant):
 * membership is sourced from the AUTHORITATIVE plan-compiled `campaign_wave_targets`
 * (`campaign-repo.ts`'s `authoritativeCampaignMembers`), NOT from raw `coordinates` graph edges.
 * The original implementation enumerated `coordinates` edges where `fromId = campaign.id` — but a
 * `coordinates` edge, before it was made system-managed, could be injected by any actor holding
 * org-scoped `relationship:write` via the generic `POST /relationships` endpoint (or an IaC
 * manifest), sweeping an arbitrary Change into a victim campaign's rollback and bypassing
 * `proposeCampaign`'s per-target authority check entirely. Two independent defenses now hold:
 *  1. `coordinates` is system-managed (`graph/system-managed-relationships.ts`) — the injection
 *     VECTOR is closed on both the generic endpoint and the IaC apply path.
 *  2. Even so, this function trusts ONLY the plan tables, so a stray/legacy/future-bug `coordinates`
 *     edge can never inject a rollback target.
 * PLUS belt-and-suspenders: the ACTING actor's `object:write` authority over each reverted target's
 * own scope is re-verified here (like a standalone `POST /changes/{id}/rollback`, which authorizes
 * `object:write` before reverting) — a member whose target the rolling-back actor lacks authority
 * over is skipped with a reason, never reverted.
 *
 * One member's rollback failing (never promoted, rollback already in flight, or now unauthorized)
 * never aborts the rest of the batch — mirrors every other per-item loop in this milestone's
 * reconciler and M3's own `coordination/reconcile.ts`.
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
      result.skipped.push({ originalChangeObjectId: memberChangeObjectId, reason: "member change not found" });
      continue;
    }
    if (!ROLLBACK_ELIGIBLE_STATES.has(state)) {
      result.skipped.push({ originalChangeObjectId: memberChangeObjectId, reason: `not eligible from state '${state}'` });
      continue;
    }

    // Belt-and-suspenders per-target authority re-check: the ACTOR initiating the campaign
    // rollback must hold `object:write` over THIS target's own scope, exactly as a standalone
    // `POST /changes/{id}/rollback` requires `object:write` before reverting. A campaign the actor
    // could legitimately create only ever coordinates targets they were authorized against
    // (`proposeCampaign`), so this normally always passes — but it hard-stops any path (a
    // pre-existing/migrated campaign, a future authority revocation) where the rolling-back actor
    // no longer holds authority over a member's target.
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
