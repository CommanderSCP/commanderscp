/** THE DOMAIN-LOCAL BINDING RECONCILER. See docs/binding-policy/reconcile-bindings.md §1. */

import { isExecutorBindingPolicyEffect, ExecutorBindingEffectSchema } from "@scp/schemas";
import type { ExecutorLane, ExecutorType } from "@scp/schemas";
import { executorBindings } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { matchPoliciesForTargetsByTarget } from "../governance/policy-resolve.js";
import { listHookLanes, listPlacementRows } from "./placement-needs.js";
import {
  deleteExecutorBinding,
  upsertExecutorBinding,
  type BindingType
} from "../coordination/executor-bindings-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  resolveExecutorBindings,
  type BindingContribution,
  type BindingGap,
  type PlacementBindingNeed
} from "./resolve-bindings.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";

export interface BindingReconcileReport {
  written: number;
  /** Reconciler-owned rows removed because nothing declares them any more. */
  pruned: number;
  /** Every unbound or ambiguous (target, Type, lane) - the loud half of section 14 resolution 2. */
  gaps: BindingGap[];
}

/** One reconcile pass for one org. See docs/binding-policy/reconcile-bindings.md §2. */
export async function reconcileExecutorBindingsForOrg(
  tx: TenantTx,
  orgId: string,
  requestId: string
): Promise<BindingReconcileReport> {
  const placements = await listPlacementRows(tx, orgId);
  if (placements.length === 0) {
    // Still prune: a domain whose last placement was deleted must not keep dispatching to rows
    // nothing explains any more.
    return { written: 0, pruned: await pruneUnwanted(tx, orgId, new Set(), requestId), gaps: [] };
  }

  const componentIds = [...new Set(placements.map((p) => p.componentObjectId))];
  const lanesByComponent = await listHookLanes(tx, orgId, componentIds);
  const typesByComponent = await listReleaseTypes(tx, orgId, componentIds);

  const needs: PlacementBindingNeed[] = placements.map((p) => ({
    targetObjectId: p.targetObjectId,
    componentObjectId: p.componentObjectId,
    types: typesByComponent.get(p.componentObjectId) ?? [],
    lanes: lanesByComponent.get(p.componentObjectId) ?? ["build"]
  }));

  const contributions = await gatherContributions(tx, orgId, [
    ...new Set(needs.map((n) => n.targetObjectId))
  ]);
  const { bindings, gaps } = resolveExecutorBindings(needs, contributions);

  const wanted = new Set<string>();
  let written = 0;
  for (const binding of bindings) {
    // A fallback result is NOT materialised - see the header. It exists to suppress a false gap.
    if (binding.viaLaneFallback) continue;
    const system = await getObjectByIdOrUrnAnyType(tx, orgId, binding.executionSystemUrn).catch(
      () => undefined
    );
    if (!system) {
      // A policy naming an execution system this domain does not have is a GAP, not a crash: the
      // document may have been written for a peer domain, or the system may have been deleted.
      gaps.push({
        reason: "unbound",
        targetObjectId: binding.targetObjectId,
        componentObjectId: binding.componentObjectId,
        type: binding.type,
        lane: binding.lane
      });
      continue;
    }
    wanted.add(bindingKey(binding.targetObjectId, binding.type, binding.lane));
    await upsertExecutorBinding(tx, {
      orgId,
      targetObjectId: binding.targetObjectId,
      type: binding.type as BindingType,
      lane: binding.lane,
      pluginModule: String(system.properties.pluginModule ?? "argocd"),
      pluginInstanceId: `execution-system:${system.id}`,
      executionSystemId: system.id,
      ...(binding.externalRef !== undefined ? { externalRef: binding.externalRef } : {}),
      managedByPolicyId: binding.policyObjectId,
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId
    });
    written += 1;
  }

  const pruned = await pruneUnwanted(tx, orgId, wanted, requestId);
  gaps.sort((a, b) =>
    [a.targetObjectId, a.type, a.lane]
      .join(" ")
      .localeCompare([b.targetObjectId, b.type, b.lane].join(" "))
  );
  return { written, pruned, gaps };
}

function bindingKey(targetObjectId: string, type: string, lane: string): string {
  return [targetObjectId, type, lane].join(" ");
}

/**
 * Remove reconciler-owned rows nothing declares any more.
 *
 * `isNotNull(managedByPolicyId)` is the whole guard: a hand-authored binding is invisible to this
 * query and therefore survives every pass, which is what ADR-0046 section 4 promises. Deleting
 * through `deleteExecutorBinding` rather than a bulk statement is deliberate - it writes the
 * `executor.binding.delete` audit event, and a row disappearing from an operator's estate with no
 * audit trail is precisely the silence this design is trying to remove.
 */
async function pruneUnwanted(
  tx: TenantTx,
  orgId: string,
  wanted: ReadonlySet<string>,
  requestId: string
): Promise<number> {
  const owned = await tx
    .select({
      targetObjectId: executorBindings.targetObjectId,
      type: executorBindings.type,
      lane: executorBindings.lane
    })
    .from(executorBindings)
    .where(and(eq(executorBindings.orgId, orgId), isNotNull(executorBindings.managedByPolicyId)));

  let pruned = 0;
  for (const row of owned) {
    if (wanted.has(bindingKey(row.targetObjectId, row.type, row.lane))) continue;
    await deleteExecutorBinding(
      tx,
      orgId,
      row.targetObjectId,
      row.type as BindingType,
      SYSTEM_ACTOR_ID,
      requestId,
      row.lane as ExecutorLane
    );
    pruned += 1;
  }
  return pruned;
}

/**
 * Every `executorBinding` effect matching each target's own containment chain.
 *
 * ONE call for every target in the org, not one per target: `matchPoliciesForTargetsByTarget`
 * (`governance/policy-resolve.ts`) runs the org-wide policy scan and the group-ownership
 * resolution ONCE for the whole list and still returns per-target attribution, instead of this
 * loop re-running both for every placement target on every ~1s reconcile tick.
 */
async function gatherContributions(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[]
): Promise<Map<string, BindingContribution[]>> {
  const matchedByTarget = await matchPoliciesForTargetsByTarget(tx, {
    orgId,
    targetObjectIds,
    // The reconciler has no acting user. See docs/binding-policy/reconcile-bindings.md §3.
    actorObjectId: SYSTEM_ACTOR_ID
  });
  const byTarget = new Map<string, BindingContribution[]>();
  for (const [targetObjectId, matched] of matchedByTarget) {
    const contributions: BindingContribution[] = [];
    for (const policy of matched) {
      for (const effect of policy.effects as unknown[]) {
        if (!isExecutorBindingPolicyEffect(effect)) continue;
        const parsed = ExecutorBindingEffectSchema.safeParse(effect.executorBinding);
        // A document that passed the registered JSON Schema but not the tighter Zod shape (an
        // unknown Type, say) is SKIPPED rather than thrown on: one malformed policy must not stop
        // the whole domain reconciling. It surfaces as the gap its target would have had anyway.
        if (!parsed.success) continue;
        contributions.push({
          policyObjectId: policy.policyObjectId,
          policyVersion: policy.policyVersion,
          policyName: policy.name,
          depth: policy.matchedAt.depth,
          effect: parsed.data
        });
      }
    }
    byTarget.set(targetObjectId, contributions);
  }
  return byTarget;
}

/** The Types each component actually releases via, read from its `releases_via` edges. */
async function listReleaseTypes(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<Map<string, ExecutorType[]>> {
  const byComponent = new Map<string, ExecutorType[]>();
  if (componentObjectIds.length === 0) return byComponent;
  // Read DIRECTLY declared edges only. See docs/binding-policy/reconcile-bindings.md §4.
  const rows = await tx.execute<{ from_id: string; type: string | null }>(sql`
      SELECT from_id, properties ->> 'type' AS type
      FROM relationships
      WHERE org_id = ${orgId}
        AND type_id = 'releases_via'
        AND deleted_at IS NULL
        AND from_id IN (${sql.join(
          componentObjectIds.map((id) => sql`${id}`),
          sql`, `
        )})
    `);
  for (const row of (rows.rows ?? []) as { from_id: string; type: string | null }[]) {
    const list = byComponent.get(row.from_id) ?? [];
    if (row.type) list.push(row.type as ExecutorType);
    byComponent.set(row.from_id, [...new Set(list)]);
  }
  return byComponent;
}
