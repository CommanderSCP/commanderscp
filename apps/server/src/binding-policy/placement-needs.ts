/**
 * The reconciler's two gather steps, kept apart from the loop so each is readable on its own:
 * which (component, target) pairs exist in this domain, and which lanes each component needs.
 */

import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { pipelineHooks } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import type { ExecutorLane } from "@scp/schemas";

export interface PlacementRow {
  placementObjectId: string;
  componentObjectId: string;
  targetObjectId: string;
}

/**
 * Every live placement in the org, as (component, target) pairs.
 *
 * NOT PAGINATED, and not filtered by a readable scope. Both are deliberate and both differ from
 * `listPlacements`, which serves an HTTP list door: this runs as the engine, over the whole domain,
 * and its answer is only correct if it sees ALL of it. A page would silently under-bind, and a
 * readable-scope filter would make the domain's routing depend on some user's permissions.
 */
export async function listPlacementRows(tx: TenantTx, orgId: string): Promise<PlacementRow[]> {
  const rows = await tx
    .select({
      id: objects.id,
      componentObjectId: sql<string>`${objects.properties} ->> 'componentId'`,
      targetObjectId: sql<string>`${objects.properties} ->> 'deploymentTargetId'`
    })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), eq(objects.typeId, "placement"), isNull(objects.deletedAt))
    );

  return rows
    .filter((r) => r.componentObjectId && r.targetObjectId)
    .map((r) => ({
      placementObjectId: r.id,
      componentObjectId: r.componentObjectId,
      targetObjectId: r.targetObjectId
    }));
}

/**
 * Which lanes each component needs resolved.
 *
 * `build` ALWAYS; `test` only where the component declares a test hook. That is what keeps an
 * estate with no hooks from being reported as missing a test lane it has no use for — the gap list
 * is only worth reading if everything in it is a real gap.
 */
export async function listHookLanes(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<Map<string, ExecutorLane[]>> {
  const lanes = new Map<string, ExecutorLane[]>();
  for (const id of componentObjectIds) lanes.set(id, ["build"]);
  if (componentObjectIds.length === 0) return lanes;

  const rows = await tx
    .select({ componentObjectId: pipelineHooks.componentObjectId })
    .from(pipelineHooks)
    .where(
      and(
        eq(pipelineHooks.orgId, orgId),
        inArray(pipelineHooks.componentObjectId, componentObjectIds)
      )
    );
  for (const row of rows) lanes.set(row.componentObjectId, ["build", "test"]);
  return lanes;
}
