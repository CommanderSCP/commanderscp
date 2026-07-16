import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * Coupled-pipeline prerequisites (M12 P4B — docs/proposals/coupled-pipelines.md). A change declares
 * `properties.requires: {key, at}[]`; it may not execute until, for EACH requirement, some OTHER
 * change is in `validating` or `promoted` and `provides` that `key` at that `at` object.
 *
 * The predicate is EXISTENTIAL over a CONDITION, not a pointer to a specific prerequisite row: a
 * failed/cancelled prerequisite is simply not in {validating, promoted}, so the waiter keeps
 * waiting; the operator fixes it and re-pushes, a NEW change reaches `validating` with the same
 * key, and the waiter releases — nothing to re-point. That is what makes "wait forever" (the owner's
 * choice) coherent rather than stubborn.
 *
 * State choice `validating|promoted`, NOT `promoted` alone (owner ruling: "run successfully, not a
 * human gate"): a forward change never auto-promotes (`reconcile.ts` completeExecution returns for
 * non-rollback changes — promotion is a human `scp change promote`), so a `promoted` predicate would
 * deadlock every automated coupled release. `validating` is the state the engine writes once every
 * wave succeeded — the executor ran, the bucket exists.
 */
export interface Requirement {
  key: string;
  /** Object id (resolved at propose time) the key must be provided at. */
  at: string;
}

/** A requirement plus WHETHER it is currently satisfied, and by which change if so. */
export interface RequirementStatus extends Requirement {
  satisfied: boolean;
  /** The object id of the change that satisfies this requirement (in validating|promoted), or null. */
  satisfiedByChangeObjectId: string | null;
}

/**
 * The satisfaction status of EVERY requirement — the single query implementation behind both the
 * reconcile predicate and the `explain` wait-status surface (Phase 4). One jsonb-containment probe
 * per requirement, served by the `obj_props` GIN index (`drizzle/0001:170`, `jsonb_path_ops`):
 * `properties @> {"provides":[key],"targets":[at]}` is true iff the provider's `provides` array
 * contains `key` AND its `targets` array contains `at`. No new index, no new column — `provides`/
 * `targets` already live in `objects.properties`.
 */
export async function requirementStatuses(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<RequirementStatus[]> {
  const statuses: RequirementStatus[] = [];
  for (const req of requires) {
    const probe = JSON.stringify({ provides: [req.key], targets: [req.at] });
    const result = await tx.execute<{ change_object_id: string }>(sql`
      SELECT c.object_id AS change_object_id
      FROM changes c
      JOIN objects o ON o.id = c.object_id AND o.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid
        AND c.state IN ('validating', 'promoted')
        AND o.id <> ${selfChangeObjectId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
      LIMIT 1
    `);
    const satisfiedBy = result.rows[0]?.change_object_id ?? null;
    statuses.push({ ...req, satisfied: satisfiedBy !== null, satisfiedByChangeObjectId: satisfiedBy });
  }
  return statuses;
}

/**
 * The subset of `requires` NOT yet satisfied. Empty ⇒ the change is free to execute. Also drives the
 * `waiting` Decision's reason, so an operator can see exactly which prerequisites are outstanding.
 */
export async function unsatisfiedRequirements(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<Requirement[]> {
  const statuses = await requirementStatuses(tx, orgId, selfChangeObjectId, requires);
  return statuses.filter((s) => !s.satisfied).map((s) => ({ key: s.key, at: s.at }));
}

/** True iff every requirement is satisfied (or there are none). */
export async function requirementsSatisfied(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<boolean> {
  if (requires.length === 0) return true;
  return (await unsatisfiedRequirements(tx, orgId, selfChangeObjectId, requires)).length === 0;
}

/** Renders a requirement list for a Decision reason, e.g. `feature-a@<uuid>, bucket@<uuid>`. */
export function describeRequirements(requires: Requirement[]): string {
  return requires.map((r) => `${r.key}@${r.at}`).join(", ");
}
