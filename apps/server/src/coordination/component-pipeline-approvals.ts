import { and, eq, inArray } from "drizzle-orm";
import type { ComponentPipelineGate } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { approvalRequests, approvalVotes } from "../db/schema.js";

/** One entry of `ComponentPipelineGateSchema.approvals`. */
export type ComponentPipelineGateApproval = NonNullable<ComponentPipelineGate["approvals"]>[number];

/**
 * THE LIVE APPROVAL COUNTS for a set of changes (D2, 2026-09-16,
 * docs/proposals/pipeline-mockup-data.md §4/§9). The engine gates approval ONCE, at the whole
 * change's `validating->accepted` edge (`gates.ts:74`) — this reads the same two tables
 * `governance/approvals-repo.ts` does, but as an INDEPENDENT query: that module is under active,
 * separately-owned development, so this file reads `approval_requests`/`approval_votes` directly
 * rather than importing from it (one fewer place for two agents' edits to collide).
 *
 * Returns a map keyed by `changeObjectId`, since a stage can carry more than one `currents[]`
 * change (one per bound pipeline Type) and each may have its own approval requirement(s).
 */
export async function liveApprovalsForChanges(
  tx: TenantTx,
  orgId: string,
  changeObjectIds: readonly string[]
): Promise<Map<string, ComponentPipelineGateApproval[]>> {
  const out = new Map<string, ComponentPipelineGateApproval[]>();
  const ids = [...new Set(changeObjectIds)];
  if (ids.length === 0) return out;

  const requests = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.orgId, orgId), inArray(approvalRequests.changeObjectId, ids)));
  if (requests.length === 0) return out;

  const requestIds = requests.map((r) => r.id);
  const votes = await tx
    .select({ approvalRequestId: approvalVotes.approvalRequestId })
    .from(approvalVotes)
    .where(
      and(eq(approvalVotes.orgId, orgId), inArray(approvalVotes.approvalRequestId, requestIds))
    );
  const voteCountByRequest = new Map<string, number>();
  for (const v of votes) {
    voteCountByRequest.set(
      v.approvalRequestId,
      (voteCountByRequest.get(v.approvalRequestId) ?? 0) + 1
    );
  }

  for (const r of requests) {
    const entry: ComponentPipelineGateApproval = {
      requestId: r.id,
      changeId: r.changeObjectId,
      fromRole: r.fromRole,
      requiredCount: r.requiredCount,
      voteCount: voteCountByRequest.get(r.id) ?? 0,
      status: r.status
    };
    const list = out.get(r.changeObjectId) ?? [];
    list.push(entry);
    out.set(r.changeObjectId, list);
  }
  return out;
}
