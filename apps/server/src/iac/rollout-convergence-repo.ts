/**
 * STORAGE FOR THE TWO MANIFEST COLLECTIONS THAT USED TO BE DROPPED (D12, D25(b); migration 0106).
 *
 * `@scp/iac` has emitted `rollouts` and `convergence` since the L1 doors and the `CanaryRollout` /
 * `RollingRollout` constructs shipped, and `plans-repo.ts` projected neither — so a declared canary
 * synthesised, validated, planned green, applied, and was discarded in silence. These are the reads
 * and writes that end that.
 *
 * Ownership derives from the COMPONENT, exactly as it does for `pipeline_hooks`, `source_mappings`
 * and `executor_bindings`: a row carries no owner of its own, so its owner is the owner of the
 * component it hangs off. That is why every function here is keyed by component id and why the
 * diff's pool is "rows on components this stack owns".
 */

import { and, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { componentConvergence, componentRollouts } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

export interface ComponentRolloutRow {
  componentObjectId: string;
  targetClass: string;
  rollout: unknown;
}

export interface ComponentConvergenceRow {
  componentObjectId: string;
  targetObjectId: string;
  converge: boolean;
  scope: string;
}

export async function listRolloutsForComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<ComponentRolloutRow[]> {
  if (componentObjectIds.length === 0) return [];
  return tx
    .select({
      componentObjectId: componentRollouts.componentObjectId,
      targetClass: componentRollouts.targetClass,
      rollout: componentRollouts.rollout
    })
    .from(componentRollouts)
    .where(
      and(
        eq(componentRollouts.orgId, orgId),
        inArray(componentRollouts.componentObjectId, componentObjectIds)
      )
    );
}

export async function listConvergenceForComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<ComponentConvergenceRow[]> {
  if (componentObjectIds.length === 0) return [];
  return tx
    .select({
      componentObjectId: componentConvergence.componentObjectId,
      targetObjectId: componentConvergence.targetObjectId,
      converge: componentConvergence.converge,
      scope: componentConvergence.scope
    })
    .from(componentConvergence)
    .where(
      and(
        eq(componentConvergence.orgId, orgId),
        inArray(componentConvergence.componentObjectId, componentObjectIds)
      )
    );
}

/** UPSERT on the declaration's identity — `(org, component, targetClass)`. A changed strategy is an
 *  UPDATE IN PLACE rather than delete+create, because the identity did not move; only the payload
 *  did. (Hooks differ deliberately: their diff keys on the WHOLE declaration, so a changed hook is
 *  two reviewable lines. A rollout's identity is genuinely the pair.) */
export async function upsertComponentRollout(
  tx: TenantTx,
  orgId: string,
  input: ComponentRolloutRow
): Promise<void> {
  await tx
    .insert(componentRollouts)
    .values({
      id: uuidv7(),
      orgId,
      componentObjectId: input.componentObjectId,
      targetClass: input.targetClass,
      rollout: input.rollout as object
    })
    .onConflictDoUpdate({
      target: [
        componentRollouts.orgId,
        componentRollouts.componentObjectId,
        componentRollouts.targetClass
      ],
      set: { rollout: input.rollout as object, updatedAt: new Date() }
    });
}

export async function deleteComponentRollout(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  targetClass: string
): Promise<void> {
  await tx
    .delete(componentRollouts)
    .where(
      and(
        eq(componentRollouts.orgId, orgId),
        eq(componentRollouts.componentObjectId, componentObjectId),
        eq(componentRollouts.targetClass, targetClass)
      )
    );
}

export async function upsertComponentConvergence(
  tx: TenantTx,
  orgId: string,
  input: ComponentConvergenceRow
): Promise<void> {
  await tx
    .insert(componentConvergence)
    .values({
      id: uuidv7(),
      orgId,
      componentObjectId: input.componentObjectId,
      targetObjectId: input.targetObjectId,
      converge: input.converge,
      scope: input.scope
    })
    .onConflictDoUpdate({
      target: [
        componentConvergence.orgId,
        componentConvergence.componentObjectId,
        componentConvergence.targetObjectId
      ],
      // `converge: false` is a REAL stored value, never an absent row — D8 makes the manifest say
      // which, so an opt-out must be as visible in the database as an opt-in.
      set: { converge: input.converge, scope: input.scope, updatedAt: new Date() }
    });
}

export async function deleteComponentConvergence(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  targetObjectId: string
): Promise<void> {
  await tx
    .delete(componentConvergence)
    .where(
      and(
        eq(componentConvergence.orgId, orgId),
        eq(componentConvergence.componentObjectId, componentObjectId),
        eq(componentConvergence.targetObjectId, targetObjectId)
      )
    );
}
