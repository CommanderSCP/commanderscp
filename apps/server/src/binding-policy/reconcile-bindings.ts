/**
 * THE DOMAIN-LOCAL BINDING RECONCILER (ADR-0046 section 4; team-pipeline-iac section 6, D4).
 *
 * Teams author the WHAT and it federates; each domain authors the HOW once, locally. This loop is
 * the join: it walks the placements visible in this domain, resolves the `executorBinding` policy
 * effects matching each target, and materialises `executor_bindings` rows - so a team never files a
 * per-outpost binding ticket and credentials never leave the domain that owns them.
 *
 * The DECISION is `resolve-bindings.ts` (pure, unit-tested). This file is the impure half: gather,
 * write, prune, report.
 *
 * WHAT IT WILL AND WILL NOT TOUCH
 *
 * It owns exactly the rows it created, identified by `managed_by_policy_id` being non-NULL
 * (migration 0105). A hand-authored binding - which stays legal, e.g. a one-off - carries NULL
 * there and is never updated and never pruned. ADR-0046 section 4 requires that provenance be READ
 * FROM THE ROW rather than inferred from which policy happens to match now, and the difference is
 * not academic: "prune anything no current policy explains" would delete precisely the one-offs an
 * operator cared enough to write by hand.
 *
 * FALLBACK IS NOT MATERIALISED. A test lane that resolves through the build lane produces NO row -
 * `resolveLaneBinding` does that at read time, once, for every consumer. Writing a duplicate row
 * would double every target's rows and leave two records to keep in step. What the fallback buys
 * here is the absence of a spurious GAP: a domain that never separated lanes is not reported as
 * missing a test lane it does not need.
 *
 * UNBOUND IS LOUD, AND THAT IS THE POINT (section 14 resolution 2). Gaps are returned, not logged
 * and dropped: an unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case
 * (a), the post-import hazard), so turning that silence into a reported state is a safety
 * improvement on its own, independent of anything this design adds.
 */

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
  /** Rows written or refreshed this pass. */
  written: number;
  /** Reconciler-owned rows removed because nothing declares them any more. */
  pruned: number;
  /** Every unbound or ambiguous (target, Type, lane) - the loud half of section 14 resolution 2. */
  gaps: BindingGap[];
}

/**
 * One reconcile pass for one org.
 *
 * `actorObjectId` is `SYSTEM_ACTOR_ID`: this loop derives rows from a policy an operator already
 * authored under `policy:write`, in the domain that owns the executor. That is NOT the forbidden
 * shortcut ADR-0046 section 1 names - that one is about applying a TEAM'S MANIFEST as the system
 * instead of as the team, which would void the cross-team guarantee. Nothing here writes graph
 * objects on a team's behalf; it writes the domain's own routing rows.
 */
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
    // The reconciler has no acting user. Group-scope's ACTING half therefore never fires, and its
    // OWNING half - which does not read the actor at all (ADR-0016 section 2a) - still does. That
    // asymmetry is documented in `subscription-authoring-guard.ts` and is deliberate here too: a
    // binding policy scoped to a group is matched by what that group OWNS, not by who is acting,
    // because nobody is.
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
  // Read DIRECTLY declared edges only. The nearest-rung ladder (ADR-0027/0029) that lets a component
  // inherit a service- or assembly-rung pipeline is resolved at READ time by `binding-resolution.ts`,
  // and duplicating it here would be a second implementation of one walk - the failure mode this
  // repo has hit before. A component with no direct edge contributes no Types and is reported by its
  // absence, never by a guess.
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
